# Silence Cut - Project Structure

Chrome extension for YouTube that detects and skips/speeds up silent and music sections.

## Tech Stack

- **TypeScript** with strict mode
- **esbuild** for bundling (IIFE format, outputs to original locations)
- **chrome-types** for Chrome extension API types

## Key Files

### Source (src/)
- `src/types.ts` - Shared type definitions (Settings, Messages, Status, etc.)
- `src/content/audio-analyzer.ts` - MAIN world script for Web Audio API analysis (volume, ZCR, spectral features, music detection)
- `src/content/content.ts` - Content script bridge between popup/service worker and analyzer
- `src/content/player-ui.ts` - UI panel injected into YouTube player (settings, status, volume meter, debug)
- `src/background/service-worker.ts` - Service worker for badge, settings persistence, toolbar icon toggle

### Build Output (gitignored)
- `content/audio-analyzer.js`, `content/content.js`, `content/player-ui.js`, `background/service-worker.js`

### Static Assets
- `content/panel.html`, `content/panel.css` - Panel template and styles
- `_locales/en/messages.json`, `_locales/tr/messages.json` - i18n strings

## Architecture

- `audio-analyzer.ts` runs in MAIN world, communicates via `window.postMessage`
- `content.ts` runs in content script context, bridges chrome APIs
- `player-ui.ts` runs in content script, builds YouTube-style panel UI
- Pages: main → mode, silence (→ threshold, duration), music (→ sensitivity, duration)
- Collapsible sections: volume meter on silence page, debug info on music page

## Build Commands

- `npm run build` - Build TypeScript to JS
- `npm run watch` - Watch mode
- `npm run typecheck` - Type check only
- `make zip` - Build + create extension zip