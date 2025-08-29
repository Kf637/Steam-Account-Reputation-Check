"use strict";

(function () {
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function computeScore(player = {}, ban = {}, extras = {}, opts = {}) {
    const suspiciousEmpty = !!opts.suspiciousEmpty;

    const vis = Number(player.communityvisibilitystate || 0); // 3 = Public
    const isPrivate = vis !== 3;

    const created = Number(player.timecreated || 0);
    const ageDays = created
      ? Math.max(0, Math.floor((Date.now() / 1000 - created) / 86400))
      : null;
    const ageLevel =
      ageDays === null
        ? null
        : ageDays < 7
        ? "err"
        : ageDays < 90
        ? "warn"
        : "ok";

    // If account age is unknown (no timecreated) and profile is private,
    // force the score to 50 and return immediately so it stays fixed.
    if (ageDays === null && isPrivate) {
      const score = 50;
      const scoreLevel = score >= 70 ? "ok" : score >= 40 ? "warn" : "err";
      return { score, scoreLevel, isPrivate, ageDays, ageLevel };
    }

    const vac = Number(ban.NumberOfVACBans || 0);
    const game = Number(ban.NumberOfGameBans || 0);
    const comm = Boolean(ban.CommunityBanned);
    const econ = String(ban.EconomyBan || "none");
    const banDays =
      typeof ban.DaysSinceLastBan === "number" ? ban.DaysSinceLastBan : null;

    let score = 100;

    // Bans penalties (reduced if last ban is older than 180 days)
    const vacWeight = banDays !== null && banDays > 180 ? 15 : 25;
    const gameWeight = banDays !== null && banDays > 180 ? 10 : 15;
    if (vac > 0) score -= vacWeight * vac;
    if (game > 0) score -= gameWeight * game;
    if (comm) score -= 20;
    if (econ.toLowerCase() !== "none") score -= 15;

    // Age
    if (ageDays !== null) {
      if (ageDays < 2) score -= 100;
      else if (ageDays < 3) score -= 90;
      else if (ageDays < 14) score -= 75;
      else if (ageDays < 40) score -= 55;
      else if (ageDays < 90) score -= 40;
      else if (ageDays < 110) score -= 25;
      else if (ageDays < 130) score -= 10;
      else score += 5;
    }

    // Privacy
    if (isPrivate) score -= 35; // Remove 35 as the profile cannot be evaluated

    // Friends/games/level/badges contributions
    const f = typeof extras.friends === "number" ? extras.friends : 0;
    const g = typeof extras.games === "number" ? extras.games : 0;
    const lvl = typeof extras.level === "number" ? extras.level : 0;
    const badgesCnt =
      typeof extras.badgesCount === "number" ? extras.badgesCount : 0;

    score += clamp(f, 0, 100) * 0.15; // up to +15
    score += clamp(g, 0, 100) * 0.15; // up to +15
    score += clamp(lvl, 0, 50) * 0.2; // up to +10
    score += clamp(badgesCnt, 0, 50) * 0.1; // up to +5

    if (suspiciousEmpty) score -= 30;

    // Avatar influence (silent)
    if (typeof player.avatarhash === "string" && player.avatarhash.length > 0) {
      score += /^0+$/i.test(player.avatarhash) ? -5 : 5;
    }

    // Dynamic cap when bans present (reduced if last ban is older than 180 days)
    if (vac > 0 || game > 0 || comm || econ.toLowerCase() !== "none") {
      let cap = 100;
      const vacCapWeight = banDays !== null && banDays > 180 ? 15 : 20;
      const gameCapWeight = banDays !== null && banDays > 180 ? 10 : 15;
      cap -= vac * vacCapWeight;
      cap -= game * gameCapWeight;
      if (comm) cap -= 20;
      if (econ.toLowerCase() !== "none") cap -= 15;
      score = Math.min(score, cap);
    }

    score = clamp(Math.round(score), 0, 100);
    const scoreLevel = score >= 70 ? "ok" : score >= 40 ? "warn" : "err";
    return { score, scoreLevel, isPrivate, ageDays, ageLevel };
  }

  window.Scoring = { computeScore };
})();
