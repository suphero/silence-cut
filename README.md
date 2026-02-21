# Silence Cut

A Chrome extension that automatically detects and skips or speeds up silent sections in YouTube videos.

## Features

- **Silence Detection** — Detects silent parts based on a configurable dB threshold and skips or speeds through them
- **Music Detection** — Optionally detects music-only sections with adjustable sensitivity
- **Two Modes** — Skip silences entirely, or speed them up (2x–16x)
- **Live Stream Support** — Works with YouTube live streams, detecting live edge
- **In-Player UI** — Settings panel embedded directly in the YouTube player controls
- **Real-Time Meter** — Volume level visualization with threshold indicator
- **Stats Tracking** — Tracks skip count and time saved per session
- **Localization** — English and Turkish

## Project Structure

```
silence-cut/
├── manifest.json              # Extension manifest (MV3)
├── src/                       # TypeScript source
│   ├── background/
│   │   └── service-worker.ts  # Badge management, settings sync
│   ├── content/
│   │   ├── content.ts         # Content script bridge (ISOLATED world)
│   │   ├── audio-analyzer.ts  # Audio analysis engine (MAIN world)
│   │   └── player-ui.ts       # YouTube player UI panel
│   └── types.ts               # Shared type definitions
├── dist/                      # Compiled JS output (git-ignored)
├── content/
│   ├── panel.html             # Settings panel HTML
│   └── panel.css              # Settings panel styles
├── icons/                     # Extension icons (16, 32, 48, 128)
├── _locales/
│   ├── en/messages.json
│   └── tr/messages.json
└── .github/
    └── workflows/
        └── publish.yml        # Auto-publish to Chrome Web Store
```

## Development

### Prerequisites

```bash
npm install
```

### Build

```bash
npm run build       # One-time build
npm run watch       # Watch mode for development
npm run typecheck   # Type-check without emitting
```

### Load Locally

1. Clone the repository
2. Run `npm install && npm run build`
3. Open `chrome://extensions/`
4. Enable **Developer mode**
5. Click **Load unpacked** and select the project directory

### Build Zip

```bash
make zip
```

Creates `silence-cut-<version>.zip` with the extension files.

## Deployment

Pushing a version tag triggers the GitHub Actions pipeline, which builds the extension and publishes it to the Chrome Web Store.

### Setup (one-time)

Add these secrets to the repository (**Settings > Secrets and variables > Actions**):

| Secret | Description |
|--------|-------------|
| `CHROME_EXTENSION_ID` | Extension ID from the Chrome Web Store URL |
| `CHROME_CLIENT_ID` | Google Cloud OAuth client ID |
| `CHROME_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token for Chrome Web Store API |

### Publishing a New Version

1. Update the version in `manifest.json`
2. Commit the changes
3. Create and push a version tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The pipeline will automatically:

- Build the extension zip
- Upload it to the Chrome Web Store
- Create a GitHub Release with auto-generated release notes

## License

All rights reserved.
