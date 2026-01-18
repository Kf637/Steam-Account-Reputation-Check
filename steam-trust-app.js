    class SteamTrustApp {
    constructor() {
        this.init();
    }

    init() {
            // detect features once at init
            this.canDownloadCard = this.checkDownloadSupport();
            this.turnstileEnabled = false;
            this.turnstileVerified = false;
            this.turnstileSiteKey = '';
            this.turnstileRenderId = null;
            this.turnstilePendingPromise = null;
            this.turnstilePendingResolve = null;
            this.setupEventListeners();
            this.setupSteamApiProxy();
            this.initTurnstileGate();
    }

        checkDownloadSupport() {
            try {
                const ua = navigator.userAgent || '';
                const ver = (v) => parseFloat(v.replace(/_/g, '.')) || 0;

                // IE detection
                const msie = ua.match(/MSIE\s(\d+\.\d+)/i);
                const trident = ua.match(/Trident\/.*rv:(\d+\.\d+)/i);
                if (msie) return ver(msie[1]) >= 9;
                if (trident) return ver(trident[1]) >= 9;

                // Edge (Chromium-based Edge has 'Edg/' token)
                const edgeChromium = ua.match(/Edg\/(\d+\.\d+)/);
                if (edgeChromium) return true; // modern Edge supports download

                // Firefox
                const ff = ua.match(/Firefox\/(\d+\.\d+)/i);
                if (ff) return ver(ff[1]) >= 3.5;

                // Chrome
                const ch = ua.match(/Chrome\/(\d+\.\d+)/i);
                if (ch) return true; // Chrome supports it

                // Opera (Presto/older Opera may show 'Opera' or 'OPR')
                const opr = ua.match(/OPR\/(\d+\.\d+)/i) || ua.match(/Opera\/(\d+\.\d+)/i);
                if (opr) return true;

                // Safari
                const safari = ua.match(/Version\/(\d+\.\d+)/i) && ua.match(/Safari\//i);
                if (safari) return ver(safari[1]) >= 6;

                return false;
            } catch (e) {
                return false;
            }
        }

        async loadAppConfig() {
            if (window.APP_CONFIG) return window.APP_CONFIG;
            try {
                const resp = await fetch('/config.js', { cache: 'no-store' });
                if (resp.ok) {
                    const js = await resp.text();
                    if (js) {
                        try { eval(js); } catch (_) {}
                    }
                }
            } catch (e) {}
            return window.APP_CONFIG || {};
        }

        async initTurnstileGate() {
            try {
                const cfg = await this.loadAppConfig();
                this.turnstileEnabled = !!(cfg && cfg.turnstileEnabled && cfg.turnstileSiteKey);
                this.turnstileSiteKey = (cfg && cfg.turnstileSiteKey) || '';
                if (!this.turnstileEnabled) return;
                const status = await this.checkTurnstileStatus();
                if (status && status.ok) {
                    this.turnstileVerified = true;
                    return;
                }
                this.showTurnstilePopup();
            } catch (e) {
                this.showTurnstilePopup();
            }
        }

        async checkTurnstileStatus() {
            try {
                const resp = await fetch('/api/turnstile-status', { cache: 'no-store' });
                if (!resp.ok) return { ok: false };
                return await resp.json();
            } catch (e) {
                return { ok: false };
            }
        }

        async ensureTurnstileScript() {
            if (window.turnstile) return;
            await new Promise((resolve, reject) => {
                const existing = document.querySelector('script[data-turnstile]');
                if (existing) {
                    existing.addEventListener('load', resolve);
                    existing.addEventListener('error', reject);
                    return;
                }
                const s = document.createElement('script');
                s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                s.async = true;
                s.defer = true;
                s.setAttribute('data-turnstile', 'true');
                s.onload = resolve;
                s.onerror = reject;
                document.head.appendChild(s);
            });
        }

        showTurnstileError(message) {
            const el = document.getElementById('turnstileError');
            if (el) el.textContent = message || '';
        }

        async renderTurnstileWidget() {
            try {
                await this.ensureTurnstileScript();
                if (!window.turnstile) return;
                const container = document.getElementById('turnstileWidget');
                if (!container) return;
                this.showTurnstileError('');
                if (this.turnstileRenderId != null) {
                    try { window.turnstile.reset(this.turnstileRenderId); } catch (e) {}
                    return;
                }
                container.innerHTML = '';
                this.turnstileRenderId = window.turnstile.render(container, {
                    sitekey: this.turnstileSiteKey,
                    callback: (token) => this.verifyTurnstileToken(token),
                    'expired-callback': () => {
                        this.turnstileVerified = false;
                        this.showTurnstileError('Verification expired. Please try again.');
                    },
                    'error-callback': () => {
                        this.turnstileVerified = false;
                        this.showTurnstileError('Verification failed. Please try again.');
                    }
                });
            } catch (e) {
                this.showTurnstileError('Unable to load verification. Please refresh and try again.');
            }
        }

        showTurnstilePopup() {
            if (!this.turnstileEnabled) return Promise.resolve(true);
            if (this.turnstilePendingPromise) return this.turnstilePendingPromise;
            const overlay = document.getElementById('turnstileOverlay');
            if (overlay) {
                overlay.classList.add('show');
                overlay.setAttribute('aria-hidden', 'false');
            }
            this.renderTurnstileWidget();
            this.turnstilePendingPromise = new Promise((resolve) => {
                this.turnstilePendingResolve = resolve;
            });
            return this.turnstilePendingPromise;
        }

        hideTurnstilePopup() {
            const overlay = document.getElementById('turnstileOverlay');
            if (overlay) {
                overlay.classList.remove('show');
                overlay.setAttribute('aria-hidden', 'true');
            }
        }

        async verifyTurnstileToken(token) {
            try {
                const resp = await fetch('/api/turnstile-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });
                if (!resp.ok) {
                    this.showTurnstileError('Verification failed. Please try again.');
                    try { if (window.turnstile && this.turnstileRenderId != null) window.turnstile.reset(this.turnstileRenderId); } catch (e) {}
                    return;
                }
                const json = await resp.json().catch(() => null);
                if (json && json.ok) {
                    this.turnstileVerified = true;
                    this.hideTurnstilePopup();
                    if (this.turnstilePendingResolve) this.turnstilePendingResolve(true);
                    this.turnstilePendingPromise = null;
                    this.turnstilePendingResolve = null;
                    return;
                }
                this.showTurnstileError('Verification failed. Please try again.');
                try { if (window.turnstile && this.turnstileRenderId != null) window.turnstile.reset(this.turnstileRenderId); } catch (e) {}
            } catch (e) {
                this.showTurnstileError('Verification failed. Please try again.');
                try { if (window.turnstile && this.turnstileRenderId != null) window.turnstile.reset(this.turnstileRenderId); } catch (e) {}
            }
        }

        async requireTurnstileVerification() {
            if (!this.turnstileEnabled) return true;
            if (this.turnstileVerified) return true;
            const status = await this.checkTurnstileStatus();
            if (status && status.ok) {
                this.turnstileVerified = true;
                return true;
            }
            await this.showTurnstilePopup();
            return true;
        }

    setupEventListeners() {
        const form = document.getElementById("trustForm");
        const trustInput = document.getElementById("trustInput");

        form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.handleTrustCheck();
        });

        trustInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            this.handleTrustCheck();
        }
        });

        document.addEventListener("click", (e) => {
        if (e.target.id === "copyIdBtn" || e.target.closest("#copyIdBtn")) {
            this.copySteamId();
        }
        if (e.target.id === "copyReportBtn" || e.target.closest("#copyReportBtn")) {
            this.copyReport();
        }
                if (e.target.id === "downloadCardBtn" || e.target.closest("#downloadCardBtn")) {
                    this.downloadCardReport();
                }
        });
    }

    setupSteamApiProxy() {
        if (window.SteamApi) {
        window.SteamApi.ensureSteamApiKey = async function () {
            return "";
        };

        window.SteamApi.fetchSteamAccountInfo = async function (steamId64) {
            try {
            const resp = await fetch(
                `/api/steam-account?steamid=${encodeURIComponent(steamId64)}`
            );
            // Handle server rate limiting explicitly so the UI can show a clear message
            if (resp.status === 429) {
                let retry = null;
                try {
                    const j = await resp.json();
                    retry = j && j.retry_after;
                } catch (e) {}
                if (!retry) retry = parseInt(resp.headers.get('Retry-After')) || null;
                return { error: 'rate_limited', retry_after: retry };
            }
            if (!resp.ok) return null;
            const json = await resp.json();
            return json;
            } catch (e) {
            console.error("Steam API proxy fetch error", e);
            return null;
            }
        };
        }
    }

    async extractSteamId(input) {
        input = (input || "").trim();

        input = input.replace(/^<|>$/g, "");

        input = input.replace(/\s*@steam$/i, "");

        // If a SteamID64 appears anywhere (must start with 765611 and be 17 digits), use it directly
        {
            const m = input.match(/(765611\d{11})/);
            if (m) return m[1];
        }

        if (/^\d{17}$/.test(input)) {
        return input;
        }

        try {
        const maybeUrl = input.match(/^https?:\/\//i)
            ? input
            : `https://${input}`;
        const u = new URL(maybeUrl);
        const host = u.hostname.toLowerCase();
        const isSteamCommunityHost = (h) => h === 'steamcommunity.com' || h.endsWith('.steamcommunity.com');

        if (isSteamCommunityHost(host)) {
            const parts = u.pathname.split("/").filter(Boolean);
            const seg0 = (parts[0] || '').toLowerCase();

            if (seg0 === "profiles" && parts[1]) {
            const p = parts[1];
            if (/^\d{17}$/.test(p)) return p;
            }

            if (seg0 === "id" && parts[1]) {
            const vanity = parts[1];
            const r = await this.resolveVanityName(vanity);
            if (r && typeof r === 'object' && r.error === 'rate_limited') return r;
            return r;
            }
        }

        if (u.protocol && u.protocol.startsWith("steam")) {
            const m = input.match(/(\d{17})/);
            if (m) return m[1];
        }
        } catch (e) {}

        const shortUrlMatch = input.match(/^(?:\/)?(?:id|profiles)\/([^\/?#]+)/i);
        if (shortUrlMatch) {
    const part = shortUrlMatch[1];
    if (/^\d{17}$/.test(part)) return part;
    const r1 = await this.resolveVanityName(part);
    if (r1 && typeof r1 === 'object' && r1.error === 'rate_limited') return r1;
    return r1;
        }

    if (/^[a-z0-9_\-]{3,32}$/i.test(input)) {
    const r2 = await this.resolveVanityName(input);
    if (r2 && typeof r2 === 'object' && r2.error === 'rate_limited') return r2;
    return r2;
    }

        return null;
    }

    async resolveVanityName(vanity) {
        try {
        const resp = await fetch(
            `/api/resolve-vanity?vanity=${encodeURIComponent(vanity)}`
        );
        if (resp.status === 429) {
            let retry = null;
            try {
                const j = await resp.json();
                retry = j && j.retry_after;
            } catch (e) {}
            if (!retry) retry = parseInt(resp.headers.get('Retry-After')) || null;
            return { error: 'rate_limited', retry_after: retry };
        }
        if (!resp.ok) return null;
        const json = await resp.json();
        return json && json.steamid ? json.steamid : null;
        } catch (e) {
        console.error("Vanity resolution error:", e);
        return null;
        }
    }

    createChip(text, type) {
        const typeClass =
        {
            ok: "chip-success",
            warn: "chip-warning",
            err: "chip-danger",
            info: "chip-info",
        }[type] || "chip-info";

        return `<span class="info-chip ${typeClass}">${text}</span>`;
    }

    createTrustCard(data, scoreObj) {
        const { player, ban, extras } = data;
        const { score, scoreLevel, isPrivate, ageDays, ageLevel } = scoreObj;

    const flag = window.Flags
    ? (window.Flags.getFlagHtml ? window.Flags.getFlagHtml(player.loccountrycode, 24) : window.Flags.countryCodeToFlag(player.loccountrycode))
    : "";
        const avatar =
        player.avatarfull ||
        player.avatar ||
        "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
        const profileUrl =
        player.profileurl ||
        `https://steamcommunity.com/profiles/${player.steamid}`;

        const trustLevel =
        scoreLevel === "err"
            ? "risky"
            : scoreLevel === "warn"
            ? "warning"
            : "trusted";
        const trustText =
        trustLevel === "risky"
            ? "Risky Account"
    : trustLevel === "warning"
    ? "Manual Review Needed"
            : "Good Account";

        let banDays = ban.DaysSinceLastBan || null;

        // Build a plain-text report summary for easy copying
    const reportLines = [];
    const displayName = player.personaname || 'Unknown';
    const tradingRaw = (ban && ban.EconomyBan) ? String(ban.EconomyBan) : '';
    const trading = tradingRaw && tradingRaw.toLowerCase() !== 'none' ? tradingRaw : 'None';
    const community = ban && ban.CommunityBanned ? 'Yes' : 'No';
    const vac = (ban && typeof ban.NumberOfVACBans === 'number') ? ban.NumberOfVACBans : (ban && ban.NumberOfVACBans) ? ban.NumberOfVACBans : 0;
    const gameBans = (ban && typeof ban.NumberOfGameBans === 'number') ? ban.NumberOfGameBans : (ban && ban.NumberOfGameBans) ? ban.NumberOfGameBans : 0;
    const recentGames = (extras && typeof extras.recentGamesCount === 'number') ? extras.recentGamesCount : (extras && extras.recentGamesCount) ? extras.recentGamesCount : 0;
    const recentHours = Math.round(((extras && extras.recentMinutes) || 0) / 60);
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const localDate = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    reportLines.push(`Steam Account Reputation Report For ${displayName} — ${player.steamid}`);
    reportLines.push('');
    reportLines.push(`Profile: ${isPrivate ? 'Private' : 'Public'}`);
    if (ageDays !== null) {
        reportLines.push(`Age: ${ageDays} days`);
    }
    reportLines.push(`Bans: VAC ${vac}, Game ${gameBans}, Community ${community}, Trading ${trading}`);
    reportLines.push(`Last ban: ${banDays !== null ? `${banDays} days ago` : 'N/A'}`);
    reportLines.push(`Level: ${extras && extras.level != null ? extras.level : '?'}, Badges: ${extras && extras.badgesCount != null ? extras.badgesCount : '?'}, Games: ${extras && extras.games != null ? extras.games : '?'}, Groups: ${extras && extras.groups != null ? extras.groups : '?'}`);
    reportLines.push(`Recent games: ${recentGames}, Recent playtime: ${recentHours}h`);
    reportLines.push(`Score: ${score}/100 — ${trustText}`);
    reportLines.push('');
    reportLines.push(`Account URL: https://steamcommunity.com/profiles/${player.steamid}/`);
    reportLines.push(`Report generated at ${localDate}`);
    const reportText = reportLines.join('\n');
        const encodedReport = encodeURIComponent(reportText);
    // Normalize trading value for UI display and error determination
    const rawTradingUI = ban && ban.EconomyBan ? String(ban.EconomyBan) : '';
    const displayTradingUI = rawTradingUI ? (rawTradingUI.toLowerCase() === 'none' ? 'None' : rawTradingUI) : 'None';
    const tradingIsErr = rawTradingUI && rawTradingUI.toLowerCase() !== 'none';

        return `
        <div class="trust-card text-white" style="background: #222;" data-report="${encodedReport}">
            <div class="row align-items-center">
            <div class="col-md-8">
                <div class="d-flex align-items-center">
                  <img src="${avatar}" alt="Steam Avatar" class="avatar-img me-3" crossorigin="anonymous">
                <div>
                    <h5 class="mb-1 d-flex align-items-center text-white">
                    ${flag ? `<span class="me-2">${flag}</span>` : ''}
                    ${player.personaname || "Unknown"}
                    </h5>
                    <a href="${profileUrl}" target="_blank" class="text-decoration-none small text-white-50">
                    <i class="fab fa-steam me-1"></i>
                    ${player.steamid}
                    </a>
                </div>
                </div>
            </div>
            <div class="col-md-4 trust-badge-container text-md-end">
                <div class="mb-2">
                <small class="text-muted d-block text-white-50">${trustText}</small>
                <span class="trust-badge ${trustLevel}">${score}/100</span>
                </div>
            </div>
            </div>

            <hr class="my-3" style="border-color: #444;">

            <!-- Profile Section -->
            <div class="mb-3">
            <div class="section-title text-white">
                <i class="fas fa-user me-1"></i>
                Profile Information
            </div>
            <div>
                ${this.createChip(
                `Visibility: ${isPrivate ? "Private" : "Public"}`,
                isPrivate ? "warn" : "ok"
                )}
                ${
                ageDays !== null
                    ? this.createChip(`Account Age: ${ageDays} days`, ageLevel)
                    : ""
                }
            </div>
            </div>

            <!-- Bans Section -->
            <div class="mb-3">
            <div class="section-title text-white">
                <i class="fas fa-ban me-1"></i>
                Ban History
            </div>
            <div>
                ${this.createChip(
                `VAC Bans: ${ban.NumberOfVACBans || 0}`,
                ban.NumberOfVACBans > 0 ? "err" : "ok"
                )}
                ${this.createChip(
                `Game Bans: ${ban.NumberOfGameBans || 0}`,
                ban.NumberOfGameBans > 0 ? "err" : "ok"
                )}
                ${this.createChip(
                `Community Ban: ${ban.CommunityBanned ? "Yes" : "No"}`,
                ban.CommunityBanned ? "err" : "ok"
                )}
                ${this.createChip(
                `Trading Ban: ${displayTradingUI}`,
                tradingIsErr ? "err" : "ok"
                )}
            </div>
            ${
                banDays !== null
                ? `
                <div class="mt-2">
                ${this.createChip(
                    `Last Ban: ${banDays} days ago`,
                    banDays < 30 ? "err" : banDays < 365 ? "warn" : "ok"
                )}
                </div>
            `
                : ""
            }
            </div>

            <!-- Activity Section -->
            <div class="mb-0">
            <div class="section-title text-white">
                <i class="fas fa-gamepad me-1"></i>
                Activity & Stats
            </div>
            <div>
                ${this.createChip(`Level: ${extras.level || "?"}`, "info")}
                ${this.createChip(`Badges: ${extras.badgesCount || "?"}`, "info")}
                ${this.createChip(`Games: ${extras.games || "?"}`, "info")}
                ${this.createChip(`Groups: ${extras.groups || "?"}`, "info")}
                ${this.createChip(
                `Recent Games: ${extras.recentGamesCount || "0"}`,
                "info"
                )}
                ${this.createChip(
                `Recent Playtime: ${Math.round(
                    (extras.recentMinutes || 0) / 60
                )}h`,
                extras.recentMinutes > 0 ? "ok" : "warn"
                )}
            </div>
            </div>

                    <div class="mt-3 d-flex justify-content-end">
                        <div class="btn-group" role="group">
                            <button id="copyReportBtn" class="btn btn-outline-secondary btn-sm">
                                <i class="fas fa-copy"></i>
                                <span class="ms-1">Copy Report</span>
                            </button>
                            ${this.canDownloadCard ? `
                            <button id="downloadCardBtn" class="btn btn-outline-primary btn-sm">
                                <i class="fas fa-download"></i>
                                <span class="ms-1">Download Card Report</span>
                            </button>
                            ` : ''}
                        </div>
                    </div>
        </div>
        `;
    }

    copyReport() {
        const trustResults = document.getElementById('trustResults');
        const card = trustResults ? trustResults.querySelector('.trust-card') : null;
        if (!card) return;

        const encoded = card.getAttribute('data-report') || '';
        const reportText = encoded ? decodeURIComponent(encoded) : '';
        if (!reportText) return;

        const copyBtn = document.getElementById('copyReportBtn');
        if (!copyBtn) return;

        const originalContent = copyBtn.innerHTML;

        function showCopied() {
            copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            copyBtn.classList.remove('btn-outline-secondary');
            copyBtn.classList.add('btn-success');
            setTimeout(() => {
                copyBtn.innerHTML = originalContent;
                copyBtn.classList.remove('btn-success');
                copyBtn.classList.add('btn-outline-secondary');
            }, 2000);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(reportText).then(showCopied).catch(e => {
                console.error('Failed to copy report:', e);
            });
        } else {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = reportText;
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                showCopied();
            } catch (e) {
                console.error('Fallback copy failed:', e);
            }
            document.body.removeChild(textarea);
        }
    }


    async downloadCardReport() {
        const trustResults = document.getElementById('trustResults');
        const card = trustResults ? trustResults.querySelector('.trust-card') : null;
        if (!card) return;

        // Ensure html2canvas is loaded (load from CDN if necessary)
        if (typeof window.html2canvas !== 'function' && typeof window.html2canvas !== 'object') {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = resolve;
                s.onerror = reject;
                document.head.appendChild(s);
            }).catch((e) => {
                console.error('Failed to load html2canvas:', e);
                return;
            });
        }

        try {
            // Normalize and inline flags so canvas rendering includes them
            await this.prepareFlagsForCanvas(card);
            const canvas = await window.html2canvas(card, { backgroundColor: null, scale: 2, useCORS: true, allowTaint: false });
            const dataUrl = canvas.toDataURL('image/png');

            // Trigger download
            const a = document.createElement('a');
            a.href = dataUrl;
            // Build a clean filename: prefer persona name and append steamid for uniqueness
            const steamIdEl = card.querySelector('a');
            const steamIdText = steamIdEl ? (steamIdEl.textContent || '').trim().replace(/\s+/g, '') : '';
            const rawName = (card.querySelector('h5') && card.querySelector('h5').textContent.trim()) || steamIdText || 'steam-report';
            // Remove non-alphanumeric characters, collapse spaces to single underscore
            let cleanName = rawName.replace(/[^a-z0-9\s-]/gi, '').trim().replace(/\s+/g, '_');
            if (!cleanName) cleanName = steamIdText || 'steam-report';
            const filename = steamIdText ? `${cleanName}-${steamIdText}.png` : `${cleanName}.png`;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (e) {
            console.error('Failed to render/download card image:', e);
        }
    }

    // Prepare flag nodes so html2canvas will render them reliably
    async prepareFlagsForCanvas(root) {
        try {
            // 1) Convert emoji flags to image-based flags (SVG data URL)
            const emojis = Array.from(root.querySelectorAll('span.flag-emoji[data-cc]'));
            await Promise.all(emojis.map(async (span) => {
                const cc = (span.getAttribute('data-cc') || '').toUpperCase();
                if (!cc || cc.length !== 2) return;
                const compStyles = window.getComputedStyle(span);
                const fontSize = parseInt(compStyles.fontSize || '16', 10) || 16;
                const w = Math.max(12, fontSize);
                const h = Math.round(w * 0.75);
                try {
                    const resp = await fetch(`https://flagcdn.com/${cc.toLowerCase()}.svg`, { mode: 'cors', credentials: 'omit' });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const svg = await resp.text();
                    const dataUrl = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
                    const img = document.createElement('img');
                    img.className = 'flag-img';
                    img.setAttribute('data-cc', cc);
                    img.width = w; img.height = h;
                    img.alt = `${cc} flag`;
                    img.src = dataUrl;
                    span.replaceWith(img);
                } catch (e) {
                    // Fallback inline text SVG
                    const img = document.createElement('img');
                    img.className = 'flag-img';
                    img.setAttribute('data-cc', cc);
                    img.width = w; img.height = h;
                    img.alt = `${cc} flag`;
                    img.src = this.buildTextFlagDataUrl(cc, w, h);
                    span.replaceWith(img);
                }
            }));

            // 2) Inline any remaining external SVGs and rasterize them to PNG data URLs
            const imgs = Array.from(root.querySelectorAll('img.flag-img'));
            if (!imgs.length) return;
            await Promise.all(imgs.map(async (img) => {
                try {
                    const src = img.getAttribute('src') || '';
                    const w = parseInt(img.getAttribute('width') || img.width || '24', 10) || 24;
                    const h = parseInt(img.getAttribute('height') || img.height || Math.round(w*0.75), 10) || Math.round(w*0.75);
                    let svgDataUrl = '';
                    if (!src) return;
                    if (src.startsWith('data:image/svg')) {
                        svgDataUrl = src;
                    } else if (src.endsWith('.svg')) {
                        const r = await fetch(src, { mode: 'cors', credentials: 'omit' });
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        const svg = await r.text();
                        svgDataUrl = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
                    } else if (src.startsWith('data:')) {
                        // already a data URL (maybe PNG) — keep
                        return;
                    } else {
                        // Unknown external format — replace with text-based SVG
                        svgDataUrl = this.buildTextFlagDataUrl((img.getAttribute('data-cc')||'??').toUpperCase(), w, h);
                    }

                    // Rasterize SVG to PNG to be 100% safe with canvas
                    const pngDataUrl = await this.svgToPngDataUrl(svgDataUrl, w, h);
                    img.setAttribute('src', pngDataUrl);
                    img.setAttribute('width', String(w));
                    img.setAttribute('height', String(h));
                    img.removeAttribute('crossorigin');
                    img.removeAttribute('referrerpolicy');
                } catch (e) {
                    // Fallback: simple text badge SVG so the canvas has something consistent
                    const code = ((img.getAttribute('data-cc') || img.getAttribute('alt') || '').toUpperCase()).replace(/[^A-Z]/g, '').slice(0,2) || '??';
                    const w = parseInt(img.getAttribute('width') || img.width || '24', 10) || 24;
                    const h = parseInt(img.getAttribute('height') || img.height || Math.round(w*0.75), 10) || Math.round(w*0.75);
                    img.setAttribute('src', this.buildTextFlagDataUrl(code, w, h));
                    img.removeAttribute('crossorigin');
                    img.removeAttribute('referrerpolicy');
                }
            }));
        } catch (e) {
            // Non-fatal
        }
    }

    // Convert an SVG data URL to a PNG data URL at target size
    async svgToPngDataUrl(svgDataUrl, width, height) {
        return await new Promise((resolve, reject) => {
            try {
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.floor(width));
                        canvas.height = Math.max(1, Math.floor(height));
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/png'));
                    } catch (e) {
                        reject(e);
                    }
                };
                img.onerror = reject;
                img.src = svgDataUrl;
            } catch (e) {
                reject(e);
            }
        });
    }

    // Generate a minimal inline SVG data URL with the country code as text (fallback only)
    buildTextFlagDataUrl(code, width, height) {
        const bg = '#2b2f36';
        const border = 'rgba(255,255,255,0.15)';
        const txt = String(code || '').toUpperCase();
        const w = Math.max(16, Number(width) || 24);
        const h = Math.max(12, Number(height) || Math.round(w*0.75));
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0.5" y="0.5" width="${w-1}" height="${h-1}" rx="3" ry="3" fill="${bg}" stroke="${border}" />
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(h*0.55)}" font-weight="700" fill="#e6eef8">${txt}</text>
</svg>`;
        return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
    }

    showLoading() {
        const trustResults = document.getElementById("trustResults");
        trustResults.innerHTML = `
        <div class="text-center py-4">
            <div class="spinner-border spinner-border-custom" role="status">
            <span class="visually-hidden">Loading...</span>
            </div>
            <div class="mt-3 text-muted">
            <i class="fas fa-search me-1"></i>
            Checking Steam account...
            </div>
        </div>
        `;
    }

    showError(message) {
        const trustResults = document.getElementById("trustResults");
        trustResults.innerHTML = `
        <div class="alert alert-danger" role="alert">
            <i class="fas fa-exclamation-triangle me-2"></i>
            ${message}
        </div>
        `;
    }

    showSteamId(steamId) {
        const trustSteamId = document.getElementById("trustSteamId");
        const steamIdCode = document.getElementById("steamIdCode");

        steamIdCode.textContent = steamId;
        trustSteamId.style.display = "block";
    }

    copySteamId() {
        const steamIdCode = document.getElementById("steamIdCode");
        if (!steamIdCode) return;

        const textToCopy = steamIdCode.textContent || '';
        if (!textToCopy) return;

        const copyBtn = document.getElementById("copyIdBtn");
        if (!copyBtn) return;

        const originalContent = copyBtn.innerHTML;

        function showCopied() {
            copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            copyBtn.classList.remove("btn-outline-secondary");
            copyBtn.classList.add("btn-success");
            setTimeout(() => {
                copyBtn.innerHTML = originalContent;
                copyBtn.classList.remove("btn-success");
                copyBtn.classList.add("btn-outline-secondary");
            }, 2000);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).then(showCopied).catch(e => {
                console.error("Failed to copy to clipboard:", e);
            });
        } else {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = textToCopy;
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                showCopied();
            } catch (e) {
                console.error("Fallback copy failed:", e);
            }
            document.body.removeChild(textarea);
        }
    }


    async handleTrustCheck() {
        const input = document.getElementById("trustInput").value.trim();
        const trustResults = document.getElementById("trustResults");
        const trustSteamId = document.getElementById("trustSteamId");

        trustResults.innerHTML = "";
        trustSteamId.style.display = "none";

        await this.requireTurnstileVerification();

        if (!input) {
        this.showError("Please enter a SteamID64 or profile URL.");
        return;
        }

    let steamId = await this.extractSteamId(input);
    if (steamId && typeof steamId === 'object' && steamId.error === 'rate_limited') {
    const retryMessage = steamId.retry_after ? `Retry after ${steamId.retry_after}s` : 'Please try again later';
    this.showError(`Rate limited — ${retryMessage}`);
    return;
    }
    if (!steamId || typeof steamId !== 'string') {
    this.showError("Could not resolve Steam ID. Please check your input.");
    return;
    }

        this.showSteamId(steamId);

        this.showLoading();

        if (!window.SteamApi) {
        this.showError("Steam API library not loaded. Please refresh the page.");
        return;
        }

        const data = await window.SteamApi.fetchSteamAccountInfo(steamId);

        if (!data) {
        this.showError(
            "Failed to fetch account information. Please check the Steam API configuration."
        );
        return;
        }

        if (data.error === "rate_limited") {
        const retryMessage = data.retry_after
            ? `Retry after ${data.retry_after}s`
            : "Please try again later";
        this.showError(`Rate limited — ${retryMessage}`);
        return;
        }

        if (!data.player) {
        this.showError("Failed to fetch player information from Steam.");
        return;
        }

        if (!window.Scoring) {
        this.showError("Scoring library not loaded. Please refresh the page.");
        return;
        }

        const scoreObj = window.Scoring.computeScore(
        data.player,
        data.ban,
        data.extras
        );

        trustResults.innerHTML = this.createTrustCard(data, scoreObj);
    }
    }

    document.addEventListener("DOMContentLoaded", () => {
    new SteamTrustApp();
    });
