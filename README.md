# IronDivi Wallet Browser Extension

Secure cryptocurrency wallet browser extension for IronDivi blockchain.

## Project Structure

```
irondivi-browser-extension/
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
├── scripts/remote-check.sh # Runs tsc/vitest/build on hp2 (replaces CI)
├── manifest.json        # Chrome/Edge manifest (MV3)
├── manifest.firefox.json # Firefox-specific overrides
├── manifest.safari.json # Safari-specific overrides
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
npm run build:safari        # web extension files only
npm run build:safari:app    # + the macOS app Safari needs (Xcode, macOS only)

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

#### Safari (macOS)
Safari only loads web extensions packaged inside a signed macOS app, so the
Safari build is a two-step: `dist/safari/` holds the extension, and
`scripts/safari.sh` wraps it with Apple's converter and builds the app.
1. `npm run build:safari:app` (needs Xcode; ad-hoc signed by default)
2. `open "safari/build/Build/Products/Debug/IronDivi Wallet.app"` once so
   macOS registers the extension
3. In Safari: Develop > Allow Unsigned Extensions (ad-hoc builds only), then
   Settings > Extensions > enable IronDivi Wallet

`SAFARI_SIGN=<team id> npm run build:safari:app` signs with an Apple team
instead (the team's account must be added in Xcode > Settings > Accounts).
Distribution outside the Mac App Store needs Developer ID + notarization;
that is not wired up yet.

## Networks: mainnet and testnet in one build

A single build serves both Divi networks. The wallet starts on **testnet**; switch
at any time from the network badge in the popup header or from
**Settings → Network**. Each network keeps its own accounts, because the HD
derivation path differs.

| | Mainnet | Testnet |
|---|---|---|
| Address prefix | `D` (0x1e) | `x`/`y` (0x8b) |
| P2SH version | 0x0d | 0x13 |
| BIP44 coin type | `m/44'/301'/0'/0/i` | `m/44'/1'/0'/0/i` |
| RPC | `https://services.divi.domains/api/rpc/` | `https://services.divi.domains/api/testnet/rpc/` |
| Explorer | `https://services.divi.domains/explorer/` | `https://services.divi.domains/testnet/explorer/` |

All of these live in one place, `NETWORKS` in `src/shared/constants.ts`. They
match [IronDivi](https://github.com/DiviDomains/IronDivi) in its default `divi`
chain mode. Any IronDivi (or legacy divid) node with the address index enabled
can serve as the RPC backend: the wallet calls `getaddressbalance`,
`getaddressutxos`, `getaddresstxids`, `getrawtransaction`,
`sendrawtransaction`, `validateaddress`, `getblockcount` and `getnetworkinfo`.

## dApp connections

dApps connect through the injected provider, `window.irondivi` (`isIronDivi: true`),
which this extension's content script adds to every http(s) page. It exposes
`connect`, `getAccounts`, `signMessage` and the other `irondivi_*` methods, and every
request is approved in the extension popup.

The extension does **not** use WalletConnect or Reown, and must not. Divi's
connection mechanism is its own: the injected provider first, then the
`DIVI_SIGN_*` postMessage bridge in the Divi web wallet. See
[ADR 0001](docs/decisions/0001-no-walletconnect.md). A unit test
(`src/no-walletconnect.test.ts`) fails the build if WalletConnect comes back.

## Development

### Project Features

- **Multi-browser support**: Chrome, Firefox, Edge, Safari (macOS)
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
- `window.irondivi` API for dApps
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

Output ZIP files: `packages/irondivi-browser-extension-{browser}-{version}.zip`

## License

TBD
