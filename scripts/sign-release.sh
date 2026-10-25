#!/bin/bash
# Sign packages/SHA256SUMS-v<version> with the release key (security review EXT-1).
# The private key lives only in 1Password; ssh-keygen asks the 1Password SSH agent
# to sign, so the key never touches this disk. Writes SHA256SUMS-v<version>.sig and
# checks it with scripts/verify-release.sh before it returns.
# Usage: scripts/sign-release.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=$(node -p "require('$REPO/package.json').version")
PKG="${RELEASE_PACKAGES:-$REPO/packages}"
PUB="${RELEASE_SIGNING_PUB:-$REPO/site/release-signing/irondivi-release.pub}"
SUMS="$PKG/SHA256SUMS-v$VERSION"
export SSH_AUTH_SOCK="${RELEASE_SIGNING_AGENT:-$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock}"

[[ -f "$SUMS" ]] || { echo "no $SUMS: run node scripts/package.js" >&2; exit 1; }
[[ -f "$PUB" ]] || { echo "no release public key at $PUB" >&2; exit 1; }
rm -f "$SUMS.sig"
ssh-keygen -q -Y sign -f "$PUB" -n file "$SUMS"
"$REPO/scripts/verify-release.sh" "$PKG" "$VERSION"
