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
├── site/                # browser.divi.domains page; site/deploy/ publishes it (see DEPLOY.md)
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

To upgrade, put the new files in the **same folder**, replacing the old ones, then
press **Reload** (↻) on the extension's card in `chrome://extensions`. Chrome keeps
running the old background script until you press it. Your wallet is kept, because
it lives with the extension, not in the folder. Do not remove the extension or load
the new version from a different folder: either one gives you an empty wallet, and
only your recovery phrase brings your accounts back.

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
**Settings → Network**. Every account works on both networks: one recovery
phrase gives a `D` address on mainnet and a `y` address on testnet, because the
HD derivation path differs. An account made by 0.0.1 only has addresses on the
network it was made on; the first time you open it on the other network, the
wallet asks for its password once to add them. A site's request is signed on
the network it was made on: if you switch network while a request waits, the
wallet refuses it and the site has to ask again.

Switching network asks for the wallet password (the one you unlock it with, not
the recovery phrase), so a stray click cannot move you onto real DIVI. The two
networks look different at a glance, in the same colours as
services.divi.domains: mainnet is Divi red, testnet is purple. The approval
window for a site names the network the site asked on in the same colours.

## Transaction history and confirmations

A payment shows in the history as soon as it reaches the node's mempool: a
faucet payout, a send from the popup, or any incoming payment to your address.
It reads **Pending · 0/6 confirmations** until it is mined, then counts up, and
is final at **6/6**. Until then its amount shows on a separate *+X pending* line
under the balance. Every row links to the transaction on the block explorer for
the network it is on. The explorer itself only shows a transaction once it is in
a block (about a minute), so a pending row's link says *(once in a block)*; before
that the explorer opens its home page. While anything is below 6 confirmations the popup checks
again every 10 seconds.

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

dApps connect through the injected provider, `window.irondivi` (`isIronDivi: true`).
The content script runs on every page, but it adds the provider, and passes
messages on to the wallet, only on a page that is

- `https:`, or `http:` on `localhost` or `127.0.0.1`, **and**
- on a host in **Settings → Allowed Sites**. The default list names each
  production dApp exactly: `games.divi.domains` alone. `services.divi.domains`
  serves the RPC the wallet trusts for balances, so it is not also a dApp.
  A development build (`npm run build:dev`, or `npm run watch`) also allows
  `localhost` and `127.0.0.1`; a release build does not. A list saved by
  0.0.3 or earlier that is still that version's default (`*.divi.domains`,
  localhost and 127.0.0.1) is replaced by the new default. In a pattern you
  add, `*` matches within one name label and `**` matches across labels.

The background applies the same rule to every message from a page. A page can
use only the provider methods below; every other wallet message (settings,
accounts, approvals and the rest) is accepted only from the extension's own
pages.

| Method | `request()` name | Connected site needed | Opens the popup |
|---|---|---|---|
| `connect()` | `irondivi_connect` | no | yes, until the site is connected; a connected site gets its address back with no popup |
| `isConnected()` | | no | no |
| `disconnect()` | `irondivi_disconnect` | no | no |
| `getNetwork()` | `irondivi_getNetwork` | no | no; returns `'mainnet'` or `'testnet'`, whichever the wallet is set to |
| `getAccounts()` | `irondivi_accounts` | yes | no; `getAccounts()` returns the address strings, `irondivi_accounts` the address objects |
| `getBalance(address?)` | `irondivi_getBalance` | yes | no; the balance of `address`, or of the whole account if none is given |
| `signMessage(message, address?)` | `irondivi_signMessage` | yes | yes, always |
| `signGameTx(body)` | `irondivi_signGameTx` | yes, and only `https://games.divi.domains` | yes, always; returns `{ signature, address, txid }` |
| `sendTransaction({ to, amount, fee?, fromAddresses? })` | `irondivi_sendTransaction` | yes | yes, always |

`sendTransaction`'s `amount` is in DIVI. Pass it as a decimal string
(`'1234.5'`, at most 8 decimals) and it is used to the satoshi; a number is
accepted only below 90,000,000 and with at most 8 decimals, and anything else is
refused rather than rounded. A site's `fee` is ignored: the wallet works it out.

`signMessage` signs with the key of `address` (the account's first address if
none is given). `getBalance` and `signMessage` refuse an address the wallet does
not own.

`signGameTx` signs a Divi Games chain transaction: the exact `JSON.stringify`
text of `{v, chain, from, nonce, action[, memo]}` as the games' `txBody()` makes
it. Only the Divi Games site may ask, the chain must be on the wallet's network
and `from` must be one of the account's addresses. The popup shows what the
transaction does (recipient, amount and token, with GOLD and TDIVI decimals
fixed in the wallet), not the raw text. `signMessage` refuses a transaction
body, so a site cannot get one signed as an opaque message, and takes a
`Divi Games session: …` grant only from the Divi Games site.

For `signMessage` and `sendTransaction` the approval popup shows the site, and
the message and signing address, or the full destination, amount and fee. The
user approves with the wallet password. Reject, closing the popup, or no answer
within 5 minutes rejects the request; nothing is signed or broadcast before
approval. A send must also pass the transaction limits in Settings (by default
at most 10% of the balance per send). A send below 0.0000546 DIVI (dust, which
nodes do not relay) is refused, from a site or from the popup.

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

Output in `packages/`: `irondivi-wallet-{chrome,edge,opera,safari}-v{version}.zip`,
`irondivi-wallet-firefox-v{version}.xpi`, `SHA256SUMS-v{version}` and `releases.json`.
The Safari zip needs `npm run build:safari:app` first. Publishing is in DEPLOY.md.

## License

TBD
