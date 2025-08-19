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

  window.Flags = { countryCodeToFlag, isFlagEmojiSupported };
})();
