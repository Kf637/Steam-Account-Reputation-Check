require('dotenv').config();
const Sentry = require('@sentry/node');
// Determine if Sentry is enabled from env (default true)
const SENTRY_ENABLED = (() => {
  const v = process.env.SENTRY_ENABLED;
  if (v == null) return true;
  return /^(1|true|yes|on)$/i.test(String(v));
})();
// Initialize Sentry as early as possible (honoring enabled toggle)
Sentry.init({
  enabled: SENTRY_ENABLED,
  dsn: process.env.SENTRY_DSN || '',
  sendDefaultPii: true,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '1.0'),
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
});
// Report unhandled errors at the process level
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
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const SENTRY_BROWSER_LOADER_URL = process.env.SENTRY_BROWSER_LOADER_URL || 'https://js-de.sentry-cdn.com/4028085a88c3c6255b6c6d0dfcab93f4.min.js';
const ROOT = path.resolve(__dirname);
const DEBUG_HTTP = !!process.env.DEBUG_HTTP;
const API_TIMEOUT_MS = 15000; // hardcoded 15s timeout for external API calls
// Resolve the real path of the root directory to guard against symlink traversal
let ROOT_REAL;
try {
  ROOT_REAL = fs.realpathSync(ROOT);
} catch {
  ROOT_REAL = ROOT;
}

// Simple in-memory rate limiter state. This is sufficient for local use.
// Structure: Map<key, {count:number, start:number}>
const rateState = new Map();

function checkRateLimit(ip, key, limit, windowMs) {
  const now = Date.now();
  const mapKey = `${ip}|${key}`;
  const entry = rateState.get(mapKey);
  if (!entry || now - entry.start > windowMs) {
    rateState.set(mapKey, { count: 1, start: now });
    return { ok: true };
  }
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
    return { ok: false, retryAfter };
  }
  entry.count++;
  return { ok: true };
}

// Determine client IP, preferring Cloudflare headers when present (for CF tunnels/proxies)
function getClientIp(req) {
  try {
    const cfIp = req.headers && (req.headers['cf-connecting-ip'] || req.headers['true-client-ip']);
    if (cfIp && typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  } catch (_) {}
  return req.socket && req.socket.remoteAddress || 'local';
}

function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(body);
}

function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (DEBUG_HTTP) console.warn(`[http] sendFile MISS: ${filePath} -> ${err ? err.message : 'not a file'}`);
      try {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.js' || ext === '.css' || ext === '.map') {
          const ip = getClientIp(req);
          Sentry.captureMessage('Static asset not found', {
            level: 'warning',
            extra: {
              requestPath: req.url,
              resolvedPath: filePath,
              referrer: req.headers && req.headers.referer,
              userAgent: req.headers && req.headers['user-agent'],
              ip
            }
          });
        }
      } catch (_) {}
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const map = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    const ct = map[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '').split('?')[0] || '/';
  try {
    await Sentry.startSpan({ name: `${req.method} ${pathname}`, op: 'http.server' }, async () => {
      // Attach basic request context
      Sentry.setContext('request', {
        method: req.method,
        url: req.url,
        headers: {
          'user-agent': req.headers['user-agent'],
          'cf-connecting-ip': req.headers['cf-connecting-ip'],
          'x-forwarded-for': req.headers['x-forwarded-for'],
        },
        ip: getClientIp(req),
      });
      try {
        const url = pathname;
  // Serve client configuration for feature flags and Sentry
  if (url === '/config.js') {
    try {
      const cfg = {
        sentryEnabled: SENTRY_ENABLED,
        sentryDsn: process.env.SENTRY_DSN || '',
        sentryEnvironment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
        sentryTracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '1.0'),
        sentryBrowserLoaderUrl: SENTRY_BROWSER_LOADER_URL
      };
      const body = `window.APP_CONFIG=${JSON.stringify(cfg)};`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      if (SENTRY_ENABLED) Sentry.captureException(e);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('config error');
    }
    return;
  }
  // Note: intentionally do NOT expose STEAM_API_KEY via an endpoint.
  // The key remains server-side only and is used by the /api/steam-account proxy.
    // Resolve vanity (server-side to avoid CORS)
    if (url.startsWith('/api/resolve-vanity')) {
  const ip = getClientIp(req);
      // enforce: 10 requests per 60 seconds per IP
      const rl = checkRateLimit(ip, 'resolve-vanity', 10, 60_000);
      if (!rl.ok) {
        try {
          const u = new URL(req.url, `http://localhost:${PORT}`);
          const vanity = u.searchParams.get('vanity');
          console.log(`[rate-limit] ip=${ip} route=resolve-vanity vanity=${JSON.stringify(vanity)} retry_after=${rl.retryAfter}s`);
          Sentry.captureMessage('Rate limited: resolve-vanity', {
            level: 'info',
            extra: { ip, vanity, retry_after: rl.retryAfter }
          });
        } catch {}
        res.writeHead(429, { 'Content-Type':'application/json', 'Retry-After': String(rl.retryAfter) });
        res.end(JSON.stringify({ error:'rate_limited', retry_after: rl.retryAfter }));
        return;
      }
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const vanity = u.searchParams.get('vanity');
      if (!vanity) { sendJSON(res, { error: 'missing vanity' }, 400); return; }
      try {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        let xmlResp;
        try {
          xmlResp = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!xmlResp.ok) {
          console.log(`[lookup] ip=${ip} route=resolve-vanity vanity=${JSON.stringify(vanity)} result=not_found dur_ms=${Date.now()-started}`);
          sendJSON(res, { error: 'not found' }, 404); return;
        }
        const txt = await xmlResp.text();
        const m = txt.match(/<steamID64>(\d{17})<\/steamID64>/);
        if (m) {
          console.log(`[lookup] ip=${ip} route=resolve-vanity vanity=${JSON.stringify(vanity)} -> steamid=${m[1]} dur_ms=${Date.now()-started}`);
          sendJSON(res, { steamid: m[1] });
        } else {
          console.log(`[lookup] ip=${ip} route=resolve-vanity vanity=${JSON.stringify(vanity)} result=no_steamid dur_ms=${Date.now()-started}`);
          sendJSON(res, { error: 'no steamid' }, 404);
        }
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
          const vanitySafe = (()=>{ try { const u = new URL(req.url, `http://localhost:${PORT}`); return u.searchParams.get('vanity'); } catch { return null; } })();
          console.log(`[timeout] ip=${ip} route=resolve-vanity vanity=${JSON.stringify(vanitySafe)} dur_ms=${API_TIMEOUT_MS}`);
          Sentry.captureMessage('Timeout: resolve-vanity', { level: 'warning', extra: { ip, vanity: vanitySafe, dur_ms: API_TIMEOUT_MS } });
          sendJSON(res, { error: 'timeout' }, 504);
          return;
        }
        console.error('vanity resolve error', e);
        Sentry.captureException(e);
        sendJSON(res, { error: 'server error' }, 500);
      }
      return;
    }
      // Proxy Steam API requests to avoid CORS in the browser
      if (url.startsWith('/api/steam-account')) {
  const ip = getClientIp(req);
        // heavy endpoint: enforce 10 requests per 60 seconds per IP
        const rl = checkRateLimit(ip, 'steam-account', 10, 60_000);
        if (!rl.ok) {
          try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const sid = u.searchParams.get('steamid');
            console.log(`[rate-limit] ip=${ip} route=steam-account steamid=${sid} retry_after=${rl.retryAfter}s`);
            Sentry.captureMessage('Rate limited: steam-account', { level: 'info', extra: { ip, steamid: sid, retry_after: rl.retryAfter } });
          } catch {}
          res.writeHead(429, { 'Content-Type':'application/json', 'Retry-After': String(rl.retryAfter) });
          res.end(JSON.stringify({ error:'rate_limited', retry_after: rl.retryAfter }));
          return;
        }
        const u = new URL(req.url, `http://localhost:${PORT}`);
        const steamid = u.searchParams.get('steamid');
        const key = process.env.STEAM_API_KEY || '';
        if (!steamid || !key) {
          sendJSON(res, { error: 'missing steamid or key' }, 400);
          return;
        }
        try {
          // Create a shared timeout controller so the whole request times out consistently
          const started = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
          const endpoints = {
            summaries: `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamid)}`,
            bans: `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamid)}`,
            badges: `https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`,
            friends: `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}&relationship=all`,
            owned: `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}&include_appinfo=0&include_played_free_games=1`,
            groups: `https://api.steampowered.com/ISteamUser/GetUserGroupList/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`,
            recent: `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`
          };
          const promises = Object.values(endpoints).map(url =>
            fetch(url, { signal: controller.signal })
              .then(r => r.ok ? r.json().catch(() => null) : null)
              .catch(() => null)
          );
          const results = await Promise.all(promises).finally(() => clearTimeout(timer));
          if (controller.signal.aborted) {
            console.log(`[timeout] ip=${ip} route=steam-account steamid=${steamid} dur_ms=${API_TIMEOUT_MS}`);
            Sentry.captureMessage('Timeout: steam-account', { level: 'warning', extra: { ip, steamid, dur_ms: API_TIMEOUT_MS } });
            sendJSON(res, { error: 'timeout' }, 504);
            return;
          }
          const [sumJson, banJson, badgesJson, friendsJson, ownedJson, groupsJson, recentJson] = results;

          const player = (sumJson && sumJson.response && sumJson.response.players || [])[0] || null;
          const ban = (banJson && banJson.players || [])[0] || null;
          const extras = {
            level: (badgesJson && badgesJson.response && badgesJson.response.player_level) || null,
            badgesCount: (badgesJson && badgesJson.response && Array.isArray(badgesJson.response.badges) && badgesJson.response.badges.length) || null,
            friends: (friendsJson && friendsJson.friendslist && Array.isArray(friendsJson.friendslist.friends) && friendsJson.friendslist.friends.length) || null,
            games: (ownedJson && ownedJson.response && typeof ownedJson.response.game_count === 'number' && ownedJson.response.game_count) || null,
            groups: (groupsJson && groupsJson.response && Array.isArray(groupsJson.response.groups) && groupsJson.response.groups.length) || null,
            recentGamesCount: (recentJson && recentJson.response && typeof recentJson.response.total_count === 'number' && recentJson.response.total_count) || 0,
            recentMinutes: (recentJson && recentJson.response && Array.isArray(recentJson.response.games)
              ? recentJson.response.games.reduce((sum, g) => sum + (g.playtime_2weeks || 0), 0) : 0)
          };
          console.log(`[lookup] ip=${ip} route=steam-account steamid=${steamid} player=${player? 'ok':'null'} ban=${ban? 'ok':'null'} dur_ms=${Date.now()-started}`);
          sendJSON(res, { player, ban, extras });
          return;
        } catch (e) {
          console.error('Proxy error', e);
          try { console.log(`[error] ip=${ip} route=steam-account steamid=${steamid} message=${JSON.stringify(e && e.message || String(e))}`); } catch {}
          Sentry.captureException(e);
          sendJSON(res, { error: 'proxy error' }, 500);
          return;
        }
      }

    // Serve root -> index.html with per-IP page load rate limit
    if (url === '/' || url === '/index.html') {
  const ip = getClientIp(req);
      const rl = checkRateLimit(ip, 'page-load', 100, 60_000);
      if (!rl.ok) { res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(rl.retryAfter) }); res.end('Too Many Requests'); return; }
      sendFile(req, res, path.join(ROOT, 'index.html'));
      return;
    }

  // Only allow serving files inside the workspace root
  // Normalize and resolve to avoid traversal and symlink escape.
  const relUrlDecoded = decodeURIComponent(url).replace(/^\/+/, '');
  const relUrlSafe = relUrlDecoded.replace(/\0/g, ''); // strip null bytes if any
  const joined = path.join(ROOT, relUrlSafe || '');
  let safePath;
  try {
    safePath = fs.realpathSync(joined);
  } catch {
    // If the file doesn't exist yet, fall back to the normalized joined path for checks below
    safePath = path.normalize(joined);
  }
  const relFromRoot = path.relative(ROOT_REAL, safePath);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    if (DEBUG_HTTP) console.warn(`[http] Forbidden path: ${url} -> ${safePath}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

    if (DEBUG_HTTP) console.log(`[http] ${req.method} ${url} -> ${safePath}`);

    // If the resolved path is a directory (or url ended with '/'), serve index.html as a fallback.
    // This handles tunnels or proxies that may send slightly different paths for the root.
    try {
      const st = fs.statSync(safePath);
      if (st.isDirectory()) {
        sendFile(req, res, path.join(ROOT, 'index.html'));
        return;
      }
    } catch (e) {
      // ignore - we'll attempt to serve the file below which will 404 if missing
    }

    // Disallow serving dotfiles or sensitive filenames such as .env
    const base = path.basename(safePath).toLowerCase();
    if (base.startsWith('.') || base === '.env') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

  sendFile(req, res, safePath);
      } catch (e) {
        console.error('Server error', e);
        Sentry.captureException(e);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server error');
      }
    });
  } catch (e) {
    console.error('Server error (outer)', e);
    Sentry.captureException(e);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
