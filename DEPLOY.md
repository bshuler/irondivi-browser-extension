# IronDivi Wallet Extension Deployment

## Release to browser.divi.domains

The extension is published at https://browser.divi.domains: the page in `site/`, and every
version's packages under `/downloads/`. Packages are built on this Mac, because the Safari app
needs Xcode.

```bash
npm run build:all            # dist/{chrome,firefox,edge,safari}
npm run build:safari:app     # universal (arm64 + x86_64) Safari app, ad-hoc signed
npm run package              # packages/: zips, .xpi, SHA256SUMS-v<version>, releases.json
site/deploy/deploy.sh        # page, this version's packages, nginx vhost, TLS
```

`site/deploy/deploy.sh --dry-run` shows what would be uploaded and changes nothing.

`scripts/package.js` writes `packages/releases.json` with the same SHA-256 values as
`SHA256SUMS-v<version>`. The page reads it to offer each browser its download and print its
checksum, so the page never needs editing for a release. The Chrome, Edge and Opera zips are one
build under three names, so they share a checksum.

The deploy script refuses to run if the packages don't match their checksum file or
`releases.json` is for another version. On vps1 it backs up the current site to
`/var/www/.backups/browser.divi.domains-<stamp>`, replaces the page, adds the new packages next to
the old ones (older versions stay downloadable), checks them against the checksum file again, and
installs the vhost from `site/deploy/nginx/browser.divi.domains.conf` only when it changed. If
nginx rejects the vhost, the previous one is put back.

## Safari

Safari does not load a zipped extension. The Safari download is a zip of
`safari/build/Build/Products/Debug/IronDivi Wallet.app` (see README, "Safari (macOS)").
The app is ad-hoc signed, so users enable "Allow unsigned extensions" in Safari's Developer
settings, which Safari resets each time it quits. Signing it properly needs either the Mac App
Store or a Developer ID signed and notarized app; neither is set up yet.

## Server Paths

| Item | Path |
|------|------|
| Site | `/var/www/browser.divi.domains/` |
| Downloads | `/var/www/browser.divi.domains/downloads/` |
| Vhost | `/etc/nginx/sites-enabled/browser.divi.domains` (source copy in `/etc/nginx/browser.divi.domains.conf.src`) |
| Logs | `/var/log/nginx/browser.divi.domains.{access,error}.log` |
| Public URL | `https://browser.divi.domains/` |

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
2. `manifest.json` (the Firefox and Safari manifests are built from it)

The page in `site/` reads the version and file names from `releases.json`, so it needs no edit.

## Verify Deployment

```bash
cd "$(mktemp -d)" && v=0.0.5 && b=https://browser.divi.domains/downloads
curl -sSfO "$b/SHA256SUMS-v$v"
for f in chrome-v$v.zip edge-v$v.zip opera-v$v.zip firefox-v$v.xpi safari-v$v.zip; do curl -sSfO "$b/irondivi-wallet-$f"; done
shasum -a 256 -c "SHA256SUMS-v$v"
```
