"use strict";

// Minimal Steam Web API client for the popup.
(async function () {
  const STEAM_KEY_STORAGE = "steamApiKey";
  const STEAM_API_KEY_DEFAULT = "";

  // The API key is intentionally not exposed to the client. Only the server-side
  // proxy at /api/steam-account uses the key. This client helper remains as a no-op.
  async function ensureSteamApiKey() {
    return "";
  }

  async function fetchSteamAccountInfo(steamId64) {
    try {
      const resp = await fetch(
        `/api/steam-account?steamid=${encodeURIComponent(steamId64)}`
      );
      if (resp.status === 429) {
        // propagate rate limit info
        let retry = null;
        try {
          const j = await resp.json();
          retry = j && j.retry_after;
        } catch (e) {}
        if (!retry) retry = parseInt(resp.headers.get("Retry-After")) || null;
        return { error: "rate_limited", retry_after: retry };
      }
      if (!resp.ok) return null;
      const json = await resp.json();
      // Expect { player, ban, extras }
      if (!json) return null;
      return json;
    } catch (e) {
      console.error("Steam API proxy error", e);
      return null;
    }
  }

  window.SteamApi = { ensureSteamApiKey, fetchSteamAccountInfo };
})();
