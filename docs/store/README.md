# Store listings

The text, answers and files each extension store asks for, kept here so a
submission is copy and paste. The privacy policy is
<https://browser.divi.domains/privacy/> (`site/privacy/index.html`).

Screenshots: `STORE_SHOTS=1 npx playwright test tests/store-screenshots.spec.ts`
against a release build (`npm run build:all`). It writes five 1280x800 PNGs to
`packages/store/screenshots/`. They use the public BIP39 test vector on a
mocked testnet node and never show a recovery phrase.

## Shared text

**Name:** IronDivi Wallet

**Short description** (Chrome allows 132 characters; this is 110):

> A Divi wallet for your browser. Your keys stay on your device, and every site and payment needs your approval.

**Description:**

> IronDivi Wallet keeps Divi coins in your browser and lets the Divi Games
> sites and other sites you allow ask you for payments.
>
> - Your recovery phrase and keys are encrypted with your password
>   (PBKDF2-SHA256, 600,000 rounds, then AES-GCM) and never leave your device.
> - A site sees nothing until you allow it. It learns your address only when
>   you approve its connect request, and every payment or signature it asks for
>   opens a window showing the site, recipient, amount, fee and memo.
> - Every send asks for your password. Spending limits are on by default, and
>   the wallet locks when you are idle or your screen locks.
> - A colour bar shows which network you are on. This release runs on Divi
>   testnet.
> - IronDivi Connect pairs the wallet with a page on another device through an
>   end-to-end encrypted relay, and every request it carries is marked as
>   coming from a site the browser did not verify.
>
> The wallet collects nothing about you: no accounts, analytics or tracking.
> It is open source: https://github.com/bshuler/irondivi-browser-extension

**Category:** Chrome: Tools (Productivity > Tools). AMO: Other. Edge: Productivity.

**Support / homepage:** https://browser.divi.domains

**Issues:** https://github.com/bshuler/irondivi-browser-extension/issues

## Chrome Web Store (and Edge Add-ons, same answers)

Upload `packages/irondivi-wallet-chrome-v<version>.zip` (Edge:
`irondivi-wallet-edge-v<version>.zip`).

**Single purpose:**

> A cryptocurrency wallet for the Divi network: it holds the user's keys,
> shows the balance, sends coins, and lets sites the user allows request
> payments and signatures that the user approves.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Keeps the encrypted wallet, settings, spending limits, the list of allowed and blocked sites, and records of the wallet's own sends, on the device. |
| `alarms` | Locks the wallet after the idle time the user chose, and keeps an IronDivi Connect pairing polling its relay, while the service worker sleeps. |
| `idle` | Locks the wallet when the computer is idle or the screen locks. |
| `scripting` | Adds the `window.irondivi` provider only to sites the user allowed, by registering the content script for those sites at run time. |
| `https://*/*` (host) | The user can allow any https site to ask the wallet for payments; the wallet registers its content script on that site only after the user allows it, and nowhere else. The same permission lets the wallet reach the IronDivi Connect relay named in a pairing code the user pasted. |
| `https://games.divi.domains/*` | The Divi Games site, allowed by default. |
| `https://services.divi.domains/*`, `https://vps1.divi.domains/*` | The Divi network node (RPC) and the faucets the wallet reads balances from and sends transactions through. |
| `http://localhost/*`, `http://127.0.0.1/*` (optional) | Asked for only when a developer allows a local test site. |

**Remote code:** No. All code is in the package; nothing is fetched and run.

**Data usage disclosures:** tick none of the data types. The wallet does not
collect or transmit personal data. Certify: not sold to third parties, not
used for unrelated purposes, not used for creditworthiness or lending.

**Privacy policy URL:** https://browser.divi.domains/privacy/

## Firefox Add-ons (AMO)

Upload `packages/irondivi-wallet-firefox-v<version>.zip`. The add-on ID is
`irondivi-wallet@divi.domains` and the manifest declares
`data_collection_permissions: { required: ["none"] }`.

**Summary** (250 characters at most):

> A Divi wallet for your browser. Your keys are encrypted and stay on your device; a site sees nothing until you allow it, and every payment or signature it asks for opens a window you approve. Collects nothing about you.

**Source code:** the scripts are bundled and minified with esbuild, so AMO
needs the source. Upload `packages/store/irondivi-wallet-source-v<version>.zip`,
made from the release commit with:

```bash
git archive --format=zip -o packages/store/irondivi-wallet-source-v$(node -p "require('./package.json').version").zip HEAD
```

**Notes to reviewer:**

> Build: Node 26.6.0 (see .nvmrc and package.json "engines"), npm 11.
> `npm ci && npm run build:firefox` writes the add-on to dist/firefox; the
> uploaded zip is that folder, zipped by `node scripts/package.js`
> (the build is reproducible: two builds of one commit give identical bytes,
> and dist/firefox/build-info.json names the commit).
>
> To test: open the popup, choose Import, and use the public BIP39 test
> vector "abandon abandon abandon abandon abandon abandon abandon abandon
> abandon abandon abandon about" with any password. The wallet runs on Divi
> testnet; https://games.divi.domains is allowed by default and will ask to
> connect.
>
> host permission https://*/*: the provider content script is registered
> with scripting.registerContentScripts only for sites the user allowed in
> the wallet, and fetches go only to services.divi.domains, vps1.divi.domains
> and the IronDivi Connect relay named in a pairing code the user pasted.

## Safari (Mac App Store)

`scripts/safari.sh` builds the app with Xcode. Signing, notarization and the
App Store listing need Bert's Apple Developer account; reuse the text above,
the privacy policy URL, and "Data Not Collected" for App Privacy.
