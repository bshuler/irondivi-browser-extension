# IronDivi Wallet Extension Deployment

## Quick Deploy to vps1

```bash
# 1. Build all browsers
npm run build:all

# 2. Create release packages
cd dist/chrome && zip -r ../../releases/irondivi-wallet-chrome-v0.0.2.zip .
cd ../firefox && zip -r ../../releases/irondivi-wallet-firefox-v0.0.2.xpi .
cd ../edge && zip -r ../../releases/irondivi-wallet-edge-v0.0.2.zip .
cd ../..
# Safari is not a zip: see "Safari" below.

# 3. Upload to vps1
scp releases/irondivi-wallet-chrome-v0.0.2.zip \
    releases/irondivi-wallet-edge-v0.0.2.zip \
    releases/irondivi-wallet-firefox-v0.0.2.xpi \
    ubuntu@vps1.divi.domains:/var/www/vps1.divi.domains/downloads/
```

## One-liner

```bash
npm run build:all && \
cd dist/chrome && zip -r ../../releases/irondivi-wallet-chrome-v0.0.2.zip . && \
cd ../firefox && zip -r ../../releases/irondivi-wallet-firefox-v0.0.2.xpi . && \
cd ../edge && zip -r ../../releases/irondivi-wallet-edge-v0.0.2.zip . && \
cd ../.. && \
scp releases/irondivi-wallet-chrome-v0.0.2.zip releases/irondivi-wallet-edge-v0.0.2.zip releases/irondivi-wallet-firefox-v0.0.2.xpi ubuntu@vps1.divi.domains:/var/www/vps1.divi.domains/downloads/
```

## Safari

Safari does not load a zipped extension. `npm run build:safari:app` produces
`safari/build/Build/Products/Debug/IronDivi Wallet.app` (see README,
"Safari (macOS)"). Shipping it to other Macs needs either the Mac App Store or
a Developer ID signed + notarized app; neither is set up yet, so Safari is
currently local-install only (ad-hoc signed, Allow Unsigned Extensions).

## Server Paths

| Item | Path |
|------|------|
| Downloads | `/var/www/vps1.divi.domains/downloads/` |
| Extension page | `/var/www/vps1.divi.domains/extension.html` |
| Public URL | `https://vps1.divi.domains/extension.html` |

## Pre-release Checks

GitHub Actions is not used (removed 2026-10-10). Before packaging, run the checks on hp2:

```bash
npm run check:remote          # syncs the tree to hp2, runs npm ci, tsc, vitest, build:all
```

Linux covers the Chrome, Firefox, Edge and Safari web bundles; `npm run build:safari:app`
still needs this Mac (Xcode).

## Version Bump

When releasing a new version, update:
1. `package.json` - version field
2. `src/background/manifest.json` (all browser variants)
3. Release filenames in this deploy script

## Verify Deployment

```bash
ssh ubuntu@vps1.divi.domains "ls -la /var/www/vps1.divi.domains/downloads/"
```
