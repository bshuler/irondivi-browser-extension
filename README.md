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
├── site/                # browser.irondivi.com page; site/deploy/ publishes it (see DEPLOY.md)
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
4. Click the toolbar icon and choose **Always Allow** for the site you're on;
   then in the wallet click **Allow** on the "reach the Divi network" banner,
   and **Always Allow** again.
   Safari grants an extension's websites one at a time, so until then the
   wallet can't reach the Divi network (services.divi.domains,
   vps1.divi.domains) for balance, history or sends.

`SAFARI_SIGN=<team id> npm run build:safari:app` signs with an Apple team
instead (the team's account must be added in Xcode > Settings > Accounts).
Safari turns Allow Unsigned Extensions off every time it quits, and then
reports an ad-hoc build as "no longer valid". For a Mac you use every day,
sign with the team instead: on Bert's Mac that is
`SAFARI_SIGN=VGX52CQGPT npm run build:safari:app`, which needs no Develop
setting. Re-signing resets Safari's on/off switch and website access for the
extension, so enable it again afterwards.
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
The wallet's scripts run on every `https:` page (and, in a development build
from `npm run build:dev` or `npm run watch`, on `http://localhost` and
`http://127.0.0.1`), so any site can find `window.irondivi` and ask. What a site
may do depends on its **access status**, which the content script, the
background and the popup all work out the same way (`src/shared/site-access.ts`):

| Status | Meaning | What the site can do |
|---|---|---|
| `"blocked"` | On the denylist ([`site-access/blocked-sites.json`](site-access/blocked-sites.json)) or blocked by the user in **Settings → Site Access**. Overrides everything else. | Every call fails with `4301`. It can never open a window. |
| `"default"` | On the default list ([`site-access/default-sites.json`](site-access/default-sites.json)) | Everything in the method table below |
| `"allowed"` | The user chose **Allow** when the site asked, on this network | Everything in the method table below |
| `"not_allowed"` | Not on the default list and not allowed (or the user chose **Not now**) | Only `getAccessStatus()` and `requestAccess()`; every other call fails with `4300` and opens no window |
| `"denied"` | The user chose **Never** | As `"not_allowed"`, but `requestAccess()` resolves `"denied"` and opens no window |

The default list is exact `https` origins, the same on Mainnet and Testnet, with
no wildcards: `https://divi.cx`, `https://stakewatch.divi.cx`,
`https://games.divi.domains`, `https://browser.irondivi.com`,
`https://services.divi.domains`, `https://intel.divi.domains`,
`https://irondivi.com`, `https://www.irondivi.com`, `https://app.irondivi.com`,
`https://dividinos.com` and `https://www.dividinos.com`. A subdomain is not
covered by its parent. Sites are added only by a pull request to this
repository; see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-site-to-the-default-list).
A harmful site can be reported with the **Report a site** issue template.

A site that is not on the list asks the user once:

```js
const wallet = window.irondivi;
if (!wallet) { /* IronDivi is not installed */ }

let status = await wallet.getAccessStatus();   // never opens a window
if (status === 'not_allowed') {
  status = await wallet.requestAccess({ reason: 'To pay for orders in DIVI' });
}
if (status === 'default' || status === 'allowed') {
  const { address } = await wallet.connect();  // the usual connect window
}
// 'denied' or 'blocked': do not ask again; offer another way to pay
```

`requestAccess` opens one window that shows the site's exact origin, says it is
not on the default list, and quotes the `reason` as the site's own, unverified
words, cut to 200 characters. The user chooses **Allow**, **Not now** or
**Never**; closing the window, letting it time out (5 minutes) or locking the
wallet counts as **Not now**. A site has at most one request open at a time.
After **Not now** a call to `requestAccess` resolves `"not_allowed"` with no
window for 24 hours; after **Never** it resolves `"denied"` with no window until
the user changes it. Choices are kept per origin and per network, and the user
can forget, block or unblock a site in **Settings → Site Access**. Allowing a
site only lets it ask: connecting, signing and paying each still open their own
approval window.

Errors carry a numeric `code`: `4001` the user rejected, `4100` the site is not
connected, `4200` an unsupported method or option, `4300` the site must ask
with `requestAccess()` first, `4301` the site is blocked, `4900` the wallet is
locked, `4901` the site asked for the other network, `-32602` invalid
parameters.

A page can use only the provider methods below; every other wallet message
(settings, accounts, approvals and the rest) is accepted only from the
extension's own pages.

| Method | `request()` name | Connected site needed | Opens the popup |
|---|---|---|---|
| `getAccessStatus()` | `irondivi_getAccessStatus` | no, and any status | no; see above |
| `requestAccess({ reason? })` | `irondivi_requestAccess` | no, and any status | only for a `"not_allowed"` site, as above |
| `connect()` | `irondivi_connect` | no | yes, until the site is connected; a connected site gets its address back with no popup |
| `isConnected()` | | no | no |
| `disconnect()` | `irondivi_disconnect` | no | no |
| `getNetwork()` | `irondivi_getNetwork` | no | no; returns `'mainnet'` or `'testnet'`, whichever the wallet is set to |
| `getAccounts()` | `irondivi_accounts` | yes | no; `getAccounts()` returns the address strings, `irondivi_accounts` the address objects |
| `getBalance(address?)` | `irondivi_getBalance` | yes | no; the balance of `address`, or of the whole account if none is given |
| `signMessage(message, address?)` | `irondivi_signMessage` | yes | yes, always |
| `signGameTx(body)` | `irondivi_signGameTx` | yes, and only `https://games.divi.domains` | yes, always; returns `{ signature, address, txid }` |
| `sendTransaction({ to, amount, fee?, fromAddresses?, memo? })` | `irondivi_sendTransaction` | yes | yes, always |

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

The provider and the content script talk over a private `MessageChannel` port
that changes hands at `document_start`, before any page script runs; nothing is
posted to the window, so another script on the page cannot read a request or
answer it first. Still, `window.irondivi` lives in the page, and a script that
runs on the page shares its trust: **a dApp must confirm a txid, signature or
address against the chain** (or check the signature itself) before it gives
credit for it, never take the provider's word alone.

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

### Release signing

`SHA256SUMS-v{version}` is signed with the release key, an Ed25519 SSH key kept
in 1Password that never leaves it (`scripts/sign-release.sh` signs through the
1Password SSH agent). The site will not deploy a release the key did not sign.

Release key fingerprint: `SHA256:dyjX+6dCi19wwNdKJwS8yiqlIoKjAXGTxPyhYifA6gQ`
(public key in `site/release-signing/irondivi-release.pub`, also at
https://browser.irondivi.com/release-signing/irondivi-release.pub).

To check a download, put `SHA256SUMS-v{version}`, its `.sig` and the packages in
one folder and run:

```bash
scripts/verify-release.sh <folder> <version>
```

or by hand, with `allowed_signers` from this repository (not from the download
site, so one compromised host cannot change both):

```bash
ssh-keygen -Y verify -f site/release-signing/allowed_signers -I releases@browser.irondivi.com -n file -s SHA256SUMS-v0.0.6.sig < SHA256SUMS-v0.0.6
```

## License

TBD
