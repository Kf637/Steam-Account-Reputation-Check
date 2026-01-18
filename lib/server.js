require("dotenv").config();
const Sentry = require("@sentry/node");
const SENTRY_ENABLED = (() => {
  const v = process.env.SENTRY_ENABLED;
  if (v == null) return true;
  return /^(1|true|yes|on)$/i.test(String(v));
})();
Sentry.init({
  enabled: SENTRY_ENABLED,
  dsn: process.env.SENTRY_DSN || '',
  sendDefaultPii: true,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '1.0'),
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
});
// Global safety nets for unhandled errors
try {
  const util = require('util');
  process.on('unhandledRejection', (reason) => {
    try {
      const err = reason instanceof Error ? reason : new Error(`UnhandledRejection: ${util.inspect(reason)}`);
      Sentry.captureException(err);
    } finally {
      Sentry.flush(1500).catch(() => {});
    }
  });
  process.on('uncaughtException', (err) => {
    try {
      Sentry.captureException(err);
    } finally {
      Sentry.flush(1500).catch(() => {});
    }
  });
} catch {}
const express = require("express");
const path = require("path");
const fs = require('fs');
const app = express();
const SENTRY_BROWSER_LOADER_URL = process.env.SENTRY_BROWSER_LOADER_URL || 'https://js-de.sentry-cdn.com/4028085a88c3c6255b6c6d0dfcab93f4.min.js';
function parseEnvBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value));
}
const TURNSTILE_ENABLED = parseEnvBool(process.env.TURNSTILE_ENABLED, false);
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_COOKIE_NAME = process.env.TURNSTILE_COOKIE_NAME || 'cf_turnstile_token';
const TURNSTILE_COOKIE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const TURNSTILE_ACTIVE = TURNSTILE_ENABLED && TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY;
const PORT = process.env.PORT || 3100;
const INDEX_HTML_PATH = path.resolve(__dirname, "..", "index.html");

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Simple in-memory rate limiter for GET requests to fallback route
const rateState = new Map(); // Map<ip, { count: number, start: number }>
function getClientIp(req) {
  try {
    const cf = req.headers["cf-connecting-ip"] || req.headers["true-client-ip"];
    if (cf && typeof cf === "string") return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff && typeof xff === "string") {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
  } catch (_) {}
  return (req.socket && req.socket.remoteAddress) || "local";
}
function checkRateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const entry = rateState.get(ip);
  if (!entry || now - entry.start > windowMs) {
    rateState.set(ip, { count: 1, start: now });
    return { ok: true };
  }
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
    return { ok: false, retryAfter };
  }
  entry.count++;
  return { ok: true };
}

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function isSecureRequest(req) {
  try {
    const xfProto = req.headers && req.headers['x-forwarded-proto'];
    if (xfProto && String(xfProto).toLowerCase() === 'https') return true;
    return !!(req.socket && req.socket.encrypted);
  } catch (_) {
    return false;
  }
}

function buildTurnstileCookie(token, req) {
  const parts = [];
  parts.push(`${TURNSTILE_COOKIE_NAME}=${encodeURIComponent(token)}`);
  parts.push(`Max-Age=${TURNSTILE_COOKIE_TTL_SECONDS}`);
  parts.push('Path=/');
  parts.push('SameSite=Lax');
  parts.push('HttpOnly');
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function buildClearTurnstileCookie(req) {
  const parts = [];
  parts.push(`${TURNSTILE_COOKIE_NAME}=`);
  parts.push('Max-Age=0');
  parts.push('Path=/');
  parts.push('SameSite=Lax');
  parts.push('HttpOnly');
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

async function verifyTurnstileToken(token, req) {
  if (!TURNSTILE_ACTIVE) return { ok: true, bypass: true };
  if (!token) return { ok: false, errorCodes: ['missing-token'] };
  const params = new URLSearchParams();
  params.set('secret', TURNSTILE_SECRET_KEY);
  params.set('response', token);
  const ip = getClientIp(req);
  if (ip) params.set('remoteip', ip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal
    });
    const json = await resp.json().catch(() => null);
    if (json && json.success) return { ok: true };
    return { ok: false, errorCodes: (json && json['error-codes']) || ['invalid-response'] };
  } catch (e) {
    return { ok: false, errorCodes: ['verify-failed'] };
  } finally {
    clearTimeout(timer);
  }
}

// Reusable rate-limit middleware for the expensive fallback file send
function fallbackRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip, 100, 60_000); // 100 requests per 60s per IP
  if (!rl.ok) {
    res.set("Retry-After", String(rl.retryAfter));
    return res
      .status(429)
      .json({ error: "rate_limited", retry_after: rl.retryAfter });
  }
  next();
}

// Endpoint to get Steam API key (do NOT expose in production!)
app.get("/api/steam-key", (req, res) => {
  const key = process.env.STEAM_API_KEY || "";
  res.json({ key });
});

// Before serving static files, explicitly 404 and report missing asset files so the browser doesn't get HTML instead of JS
app.use((req, res, next) => {
  try {
    const assetMatch = req.path && req.path.match(/\.(?:js|css|map|png|jpg|jpeg|svg)$/i);
    if (!assetMatch) return next();
    const rel = req.path.replace(/^\/+/, '');
    const filePath = path.resolve(__dirname, rel);
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        Sentry.captureMessage('Static asset not found', {
          level: 'warning',
          extra: {
            requestPath: req.originalUrl || req.url,
            resolvedPath: filePath,
            referrer: req.get('referer'),
            userAgent: req.get('user-agent')
          }
        });
        return res.status(404).type('text/plain').send('Not Found');
      }
      next();
    });
  } catch (_) {
    next();
  }
});

// Serve static files from workspace root (including libs)
app.use(express.static(path.resolve(__dirname)));

// Serve client config
app.get('/config.js', (req, res) => {
  try {
    const cfg = {
      sentryEnabled: SENTRY_ENABLED,
      sentryDsn: process.env.SENTRY_DSN || '',
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
      sentryTracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '1.0'),
      sentryBrowserLoaderUrl: SENTRY_BROWSER_LOADER_URL,
      turnstileEnabled: TURNSTILE_ACTIVE,
      turnstileSiteKey: TURNSTILE_SITE_KEY
    };
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(`window.APP_CONFIG=${JSON.stringify(cfg)};`);
  } catch (e) {
    if (SENTRY_ENABLED) Sentry.captureException(e);
    res.status(500).type('text/plain').send('config error');
  }
});

// Turnstile status based on cookie
app.get('/api/turnstile-status', async (req, res) => {
  if (!TURNSTILE_ACTIVE) return res.json({ enabled: false, ok: true });
  const cookies = parseCookies(req);
  const token = cookies[TURNSTILE_COOKIE_NAME] || '';
  if (!token) return res.json({ enabled: true, ok: false, reason: 'missing' });
  const result = await verifyTurnstileToken(token, req);
  if (result.ok) {
    res.set('Set-Cookie', buildTurnstileCookie(token, req));
    return res.json({ enabled: true, ok: true });
  }
  res.set('Set-Cookie', buildClearTurnstileCookie(req));
  return res.status(403).json({ enabled: true, ok: false, reason: 'invalid', errorCodes: result.errorCodes || [] });
});

// Turnstile verify token
app.post('/api/turnstile-verify', async (req, res) => {
  if (!TURNSTILE_ACTIVE) return res.json({ enabled: false, ok: true });
  const token = (req.body && (req.body.token || req.body.response)) ? String(req.body.token || req.body.response) : '';
  const result = await verifyTurnstileToken(token, req);
  if (result.ok) {
    res.set('Set-Cookie', buildTurnstileCookie(token, req));
    return res.json({ ok: true });
  }
  res.set('Set-Cookie', buildClearTurnstileCookie(req));
  return res.status(403).json({ ok: false, errorCodes: result.errorCodes || [] });
});

// Fallback for all other routes to index.html (for direct navigation)
// Apply basic per-IP rate limit to avoid file system abuse via this route
app.get("*", fallbackRateLimit, (req, res) => {
  res.sendFile(INDEX_HTML_PATH);
});

// Also rate-limit HEAD requests to the fallback route
app.head("*", fallbackRateLimit, (req, res) => {
  res.sendFile(INDEX_HTML_PATH);
});

// Sentry error handler should be the last middleware
app.use((err, req, res, next) => {
  Sentry.captureException(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
