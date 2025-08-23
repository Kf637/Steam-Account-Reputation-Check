"use strict";

(function(){
  // Utility: ISO country code (e.g., "DE") to flag emoji
  const countryCodeToFlag = (cc) => {
    if (!cc || typeof cc !== 'string') return '';
    const code = cc.trim().toUpperCase();
    if (code.length !== 2) return '';
    const A = 0x1F1E6; // Regional Indicator Symbol Letter A
    const base = 'A'.charCodeAt(0);
    const chars = [...code].map(ch => String.fromCodePoint(A + (ch.charCodeAt(0) - base)));
    return chars.join('');
  };

  // Detect if the platform/font actually renders flag emojis (regional indicators)
  const isFlagEmojiSupported = (cc) => {
    try {
      const emoji = countryCodeToFlag(cc);
      if (!emoji) return false;
      const test = document.createElement('span');
      test.style.position = 'absolute';
      test.style.visibility = 'hidden';
      test.style.fontFamily = '"Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Symbol", sans-serif';
      test.style.fontSize = '16px';
      test.style.whiteSpace = 'nowrap';
      test.textContent = emoji;
      document.body.appendChild(test);
      const wEmoji = test.offsetWidth;
      test.textContent = cc;
      const wText = test.offsetWidth;
      document.body.removeChild(test);
      // If emoji rendering is supported, width should differ noticeably from two letters
      return wEmoji > wText + 2;
    } catch { return false; }
  };

  // Cache the detection result per page load to avoid layout thrash
  let _supportsEmojiFlags;
  const supportsEmojiFlags = (ccForProbe = 'US') => {
    if (typeof _supportsEmojiFlags === 'boolean') return _supportsEmojiFlags;
    _supportsEmojiFlags = isFlagEmojiSupported(ccForProbe);
    return _supportsEmojiFlags;
  };

  // Return an HTML snippet rendering a country indicator that works on desktop too.
  // - If emoji flags are supported, render the emoji with an emoji-safe font stack.
  // - Otherwise, render a small SVG flag image from flagcdn.com (CORS-enabled) so it shows on PCs.
  const getFlagHtml = (cc, size = 16) => {
    if (!cc || typeof cc !== 'string') return '';
    const code = cc.trim().toUpperCase();
    if (code.length !== 2) return '';

    if (supportsEmojiFlags(code)) {
      const emoji = countryCodeToFlag(code);
      const px = Math.max(12, Number(size) || 16);
      return `<span class="flag-emoji" style="font-size:${px}px;">${emoji}</span>`;
    }

    // Image fallback via flagcdn (serves SVG with proper CORS headers)
    const px = Math.max(12, Number(size) || 16);
    const lower = code.toLowerCase();
    const h = Math.round(px * 0.75); // 4:3 ratio common for flags
    return `<img class="flag-img" alt="${code} flag" src="https://flagcdn.com/${lower}.svg" width="${px}" height="${h}" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous" />`;
  };

  window.Flags = { countryCodeToFlag, isFlagEmojiSupported, getFlagHtml };
})();
