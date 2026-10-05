# IronDivi Wallet Extension Deployment

## Quick Deploy to vps1

```bash
# 1. Build all browsers
npm run build:all

# 2. Create release packages
cd dist/chrome && zip -r ../../releases/irondivi-wallet-chrome-v0.0.1.zip .
cd ../firefox && zip -r ../../releases/irondivi-wallet-firefox-v0.0.1.xpi .
cd ../edge && zip -r ../../releases/irondivi-wallet-edge-v0.0.1.zip .
cd ../..

# 3. Upload to vps1
scp releases/irondivi-wallet-chrome-v0.0.1.zip \
    releases/irondivi-wallet-edge-v0.0.1.zip \
    releases/irondivi-wallet-firefox-v0.0.1.xpi \
    ubuntu@vps1.divi.domains:/var/www/vps1.divi.domains/downloads/
```

## One-liner

```bash
npm run build:all && \
cd dist/chrome && zip -r ../../releases/irondivi-wallet-chrome-v0.0.1.zip . && \
cd ../firefox && zip -r ../../releases/irondivi-wallet-firefox-v0.0.1.xpi . && \
cd ../edge && zip -r ../../releases/irondivi-wallet-edge-v0.0.1.zip . && \
cd ../.. && \
scp releases/irondivi-wallet-chrome-v0.0.1.zip releases/irondivi-wallet-edge-v0.0.1.zip releases/irondivi-wallet-firefox-v0.0.1.xpi ubuntu@vps1.divi.domains:/var/www/vps1.divi.domains/downloads/
```

## Server Paths

| Item | Path |
|------|------|
| Downloads | `/var/www/vps1.divi.domains/downloads/` |
| Extension page | `/var/www/vps1.divi.domains/extension.html` |
| Public URL | `https://vps1.divi.domains/extension.html` |

## Version Bump

When releasing a new version, update:
1. `package.json` - version field
2. `src/background/manifest.json` (all browser variants)
3. Release filenames in this deploy script

## Verify Deployment

```bash
ssh ubuntu@vps1.divi.domains "ls -la /var/www/vps1.divi.domains/downloads/"
```
