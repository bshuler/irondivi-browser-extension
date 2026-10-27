#!/bin/bash
# Check that SHA256SUMS-v<version> is signed by the release key in
# site/release-signing/allowed_signers and that every package matches it
# (security review EXT-1). deploy.sh runs this before anything leaves this machine;
# anyone can run it on a download, with the allowed_signers file from the site.
# Usage: scripts/verify-release.sh <packages dir> <version>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${1:?usage: verify-release.sh <packages dir> <version>}"
VERSION="${2:?usage: verify-release.sh <packages dir> <version>}"
SIGNERS="${RELEASE_SIGNING_SIGNERS:-$REPO/site/release-signing/allowed_signers}"
SUMS="SHA256SUMS-v$VERSION"

[[ -f "$SIGNERS" ]] || { echo "no allowed_signers at $SIGNERS" >&2; exit 1; }
[[ -f "$PKG/$SUMS.sig" ]] || { echo "$SUMS is not signed: run scripts/sign-release.sh" >&2; exit 1; }
ssh-keygen -Y verify -f "$SIGNERS" -I releases@browser.irondivi.com -n file -s "$PKG/$SUMS.sig" < "$PKG/$SUMS" >/dev/null \
  || { echo "$SUMS.sig is not a good signature by the release key" >&2; exit 1; }
(cd "$PKG" && shasum -a 256 -c "$SUMS" >/dev/null) || { echo "packages do not match $SUMS" >&2; exit 1; }
echo "$SUMS: signed by the release key, and every package matches"
