# Silence Cut - Project Structure

Chrome extension for YouTube that detects and skips/speeds up silent and music sections.

## Key Files

- `content/player-ui.js` - UI panel injected into YouTube player (settings, status, volume meter, debug)
- `content/audio-analyzer.js` - MAIN world script for Web Audio API analysis (volume, ZCR, spectral features, music detection)
- `content/content.js` - Content script bridge between popup/service worker and analyzer
- `_locales/en/messages.json` / `_locales/tr/messages.json` - i18n strings

## Architecture

- `audio-analyzer.js` runs in MAIN world, communicates via `window.postMessage`
- `content.js` runs in content script context, bridges chrome APIs
- `player-ui.js` runs in content script, builds YouTube-style panel UI
- Pages: main → mode, silence (→ threshold, duration), music (→ sensitivity, duration)
- Collapsible sections: volume meter on silence page, debug info on music page
