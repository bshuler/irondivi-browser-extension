#!/bin/bash
# Have Mozilla sign packages/irondivi-wallet-firefox-v<version>.xpi, so Firefox
# installs it for good instead of as a temporary add-on.
#
# It uploads dist/firefox to addons.mozilla.org on the unlisted channel (signed,
# not listed in the store; the download stays on browser.irondivi.com) with the
# commit's source, since the code is bundled. Mozilla's signed file is the same
# files plus META-INF/; the script checks that, puts it in place of the unsigned
# .xpi, rewrites SHA256SUMS and releases.json, and runs scripts/sign-release.sh.
#
# AMO's API key and secret come from 1Password through `secret get`, into this
# process's environment only (web-ext reads WEB_EXT_API_KEY and WEB_EXT_API_SECRET).
# Mozilla signs each version once: a second run for the same version fails there.
# Usage: scripts/sign-firefox.sh   (after npm run package)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
VERSION=$(node -p "require('./package.json').version")
PKG="${RELEASE_PACKAGES:-$REPO/packages}"
XPI="$PKG/irondivi-wallet-firefox-v$VERSION.xpi"
OP_ITEM="${AMO_OP_ITEM:-op://global_secret_store/amo_api}"

[[ -f "$XPI" ]] || { echo "no $XPI: run npm run package" >&2; exit 1; }
commit=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "uncommitted changes: package from a clean commit" >&2; exit 1; }
node -e 'const i = require("./dist/firefox/build-info.json"); if (i.dev !== false || i.commit !== process.argv[1]) process.exit(1)' "$commit" \
  || { echo "dist/firefox is not a release build of $commit: run npm run package" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git archive --format=zip -o "$WORK/source.zip" "$commit"

WEB_EXT_API_KEY=$(secret get --name amo_api_issuer --op-ref "$OP_ITEM/issuer")
WEB_EXT_API_SECRET=$(secret get --name amo_api_secret --op-ref "$OP_ITEM/secret")
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

npx --no-install web-ext sign --channel unlisted --source-dir dist/firefox \
  --artifacts-dir "$WORK/signed" --upload-source-code "$WORK/source.zip" --approval-timeout 900000
unset WEB_EXT_API_KEY WEB_EXT_API_SECRET

signed=$(find "$WORK/signed" -name '*.xpi' | head -1)
[[ -n "$signed" ]] || { echo "Mozilla returned no signed file" >&2; exit 1; }
python3 -I "$REPO/scripts/xpi-same.py" "$XPI" "$signed"
cp "$signed" "$XPI"
node --input-type=module -e '
const [dir, version] = process.argv.slice(1);
const { writeChecksums, writeReleases, sourceCommit } = await import("./scripts/package.js");
writeReleases(writeChecksums(dir, version), dir, version, sourceCommit());
' "$PKG" "$VERSION"
"$REPO/scripts/sign-release.sh"
