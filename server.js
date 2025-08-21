require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const ROOT = path.resolve(__dirname);
const DEBUG_HTTP = !!process.env.DEBUG_HTTP;

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

function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (DEBUG_HTTP) console.warn(`[http] sendFile MISS: ${filePath} -> ${err ? err.message : 'not a file'}`);
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
  try {
    const url = req.url.split('?')[0] || '/';
  // Note: intentionally do NOT expose STEAM_API_KEY via an endpoint.
  // The key remains server-side only and is used by the /api/steam-account proxy.
    // Resolve vanity (server-side to avoid CORS)
    if (url.startsWith('/api/resolve-vanity')) {
      const ip = req.socket.remoteAddress || 'local';
      // enforce: 5 requests per 60 seconds per IP
      const rl = checkRateLimit(ip, 'resolve-vanity', 5, 60_000);
      if (!rl.ok) {
        res.writeHead(429, { 'Content-Type':'application/json', 'Retry-After': String(rl.retryAfter) });
        res.end(JSON.stringify({ error:'rate_limited', retry_after: rl.retryAfter }));
        return;
      }
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const vanity = u.searchParams.get('vanity');
      if (!vanity) { sendJSON(res, { error: 'missing vanity' }, 400); return; }
      try {
        const xmlResp = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`);
        if (!xmlResp.ok) { sendJSON(res, { error: 'not found' }, 404); return; }
        const txt = await xmlResp.text();
        const m = txt.match(/<steamID64>(\d{17})<\/steamID64>/);
        if (m) sendJSON(res, { steamid: m[1] }); else sendJSON(res, { error: 'no steamid' }, 404);
      } catch (e) {
        console.error('vanity resolve error', e);
        sendJSON(res, { error: 'server error' }, 500);
      }
      return;
    }
      // Proxy Steam API requests to avoid CORS in the browser
      if (url.startsWith('/api/steam-account')) {
        const ip = req.socket.remoteAddress || 'local';
        // heavy endpoint: enforce 5 requests per 60 seconds per IP
        const rl = checkRateLimit(ip, 'steam-account', 5, 60_000);
        if (!rl.ok) {
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
          const endpoints = {
            summaries: `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamid)}`,
            bans: `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamid)}`,
            badges: `https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`,
            friends: `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}&relationship=all`,
            owned: `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}&include_appinfo=0&include_played_free_games=1`,
            groups: `https://api.steampowered.com/ISteamUser/GetUserGroupList/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`,
            recent: `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamid)}`
          };

          const promises = Object.values(endpoints).map(url => fetch(url).then(r=>r.ok? r.json().catch(()=>null): null).catch(()=>null));
          const [sumJson, banJson, badgesJson, friendsJson, ownedJson, groupsJson, recentJson] = await Promise.all(promises);

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

          sendJSON(res, { player, ban, extras });
          return;
        } catch (e) {
          console.error('Proxy error', e);
          sendJSON(res, { error: 'proxy error' }, 500);
          return;
        }
      }

    // Serve root -> index.html with per-IP page load rate limit
    if (url === '/' || url === '/index.html') {
      const ip = req.socket.remoteAddress || 'local';
      const rl = checkRateLimit(ip, 'page-load', 5, 60_000);
      if (!rl.ok) { res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(rl.retryAfter) }); res.end('Too Many Requests'); return; }
      sendFile(res, path.join(ROOT, 'index.html'));
      return;
    }

  // Only allow serving files inside the workspace root
  // Strip leading slashes so path.join(ROOT, rel) can't be bypassed by an absolute path
  const relUrl = decodeURIComponent(url).replace(/^\/+/,'');
  const safePath = path.normalize(path.join(ROOT, relUrl || '')).replace(/\\/g, '/');
  const normalizedRoot = ROOT.replace(/\\/g, '/');
  // allow the root itself or any path under it
    if (!(safePath === normalizedRoot || safePath.startsWith(normalizedRoot + '/'))) {
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
        sendFile(res, path.join(ROOT, 'index.html'));
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

    sendFile(res, safePath);
  } catch (e) {
    console.error('Server error', e);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
