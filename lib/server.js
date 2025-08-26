require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3100;
const INDEX_HTML_PATH = path.resolve(__dirname, "..", "index.html");

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

// Serve static files from workspace root (including trust.html and libs)
app.use(express.static(path.resolve(__dirname)));

// Fallback for all other routes to index.html (for direct navigation)
// Apply basic per-IP rate limit to avoid file system abuse via this route
app.get("*", fallbackRateLimit, (req, res) => {
  res.sendFile(INDEX_HTML_PATH);
});

// Also rate-limit HEAD requests to the fallback route
app.head("*", fallbackRateLimit, (req, res) => {
  res.sendFile(INDEX_HTML_PATH);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
