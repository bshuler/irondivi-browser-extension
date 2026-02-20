# PrivateDivi Wallet Browser Extension

Secure cryptocurrency wallet browser extension for PrivateDivi blockchain.

## Project Structure

```
pdivi-extension/
├── src/
│   ├── background/       # Background service worker
│   ├── popup/           # Extension popup UI
│   ├── content/         # Content scripts (inject into pages)
│   ├── injected/        # Provider injected into page context
│   ├── lib/             # Shared libraries
│   └── shared/          # Shared types and utilities
├── assets/
│   └── icons/           # Extension icons
├── scripts/             # Build and packaging scripts
├── install-site/        # Installation landing page
├── .github/workflows/   # CI/CD workflows
├── manifest.json        # Chrome/Edge manifest (MV3)
├── manifest.firefox.json # Firefox-specific overrides
├── esbuild.config.js    # Build configuration
├── tsconfig.json        # TypeScript configuration
└── package.json         # Project dependencies

```

## Getting Started

### Install Dependencies

```bash
npm install
```

### Build Extension

```bash
# Build for Chrome (default)
npm run build

# Build for all browsers
npm run build:all

# Build for specific browser
npm run build:firefox
npm run build:edge

# Watch mode for development
npm run watch
```

### Load Extension in Browser

#### Chrome/Edge
1. Navigate to `chrome://extensions/` (or `edge://extensions/`)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `dist/chrome/` directory

#### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `dist/firefox/manifest.json`

## Development

### Project Features

- **Multi-browser support**: Chrome, Firefox, Edge
- **TypeScript**: Type-safe development
- **ESBuild**: Fast bundling
- **Manifest V3**: Modern Chrome extension API
- **Content Security**: Isolated execution contexts

### Build Output

Each browser build is output to `dist/{browser}/`:
- `background.js` - Background service worker
- `popup.js` - Popup UI bundle
- `content-script.js` - Content script bundle
- `provider.js` - Injected provider (IIFE)
- `manifest.json` - Browser-specific manifest
- `popup.html` & `styles.css` - UI files
- `icons/` - Extension icons

## Architecture

### Background Service Worker
- Manages wallet state
- Handles RPC communication with blockchain
- Processes transaction signing requests
- Manages alarms and periodic tasks

### Popup UI
- User interface for wallet management
- Account overview and transaction history
- Settings and preferences
- Network selection

### Content Script
- Bridges page context and extension
- Injects provider into web pages
- Relays messages between page and background

### Injected Provider
- `window.pdivi` API for dApps
- EIP-1193 compatible interface
- Request/response message handling

## Testing

```bash
npm test
```

## Packaging

```bash
# Package all browser builds
npm run package:release
```

Output ZIP files: `packages/pdivi-extension-{browser}-{version}.zip`

## License

TBD
