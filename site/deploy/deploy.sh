#!/bin/bash
# Deploy browser.divi.domains to vps1: the static page, this version's packages, then the nginx
# vhost (and TLS). Build the packages first: npm run build:all && scripts/safari.sh && node scripts/package.js
# Usage: site/deploy/deploy.sh [--dry-run]
# Backup of the previous site goes to /var/www/.backups/browser.divi.domains-<stamp> on the host.
# Older packages in /downloads/ are kept. Nothing else on vps1 is touched.
set -euo pipefail

HOST=vps1
SITE=browser.divi.domains
ROOT=/var/www/$SITE
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY="--dry-run" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('$REPO/package.json').version")
PKG="$REPO/packages"
[[ -f "$PKG/SHA256SUMS-v$VERSION" ]] || { echo "no packages for v$VERSION: run node scripts/package.js" >&2; exit 1; }
REL=$(node -p "require('$PKG/releases.json').version")
[[ "$REL" == "$VERSION" ]] || { echo "packages/releases.json is v$REL, package.json is v$VERSION" >&2; exit 1; }
(cd "$PKG" && shasum -a 256 -c "SHA256SUMS-v$VERSION" >/dev/null) || { echo "packages do not match SHA256SUMS-v$VERSION" >&2; exit 1; }

LOCAL=$(mktemp -d)
trap 'rm -rf "$LOCAL"' EXIT
MANIFEST=.site-sha256
rsync -a --exclude deploy --exclude '.DS_Store' "$REPO/site/" "$LOCAL/"
mkdir -p "$LOCAL/downloads"
cp "$PKG"/irondivi-wallet-*-v"$VERSION".* "$PKG/SHA256SUMS-v$VERSION" "$PKG/releases.json" "$LOCAL/downloads/"
# A hash of every file of the site, checked on the host before and after the copy into the web root
(cd "$LOCAL" && find . -type f ! -name "$MANIFEST" -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 > "$MANIFEST")

[[ -n "$DRY" ]] && { echo "dry run: the site is staged in $LOCAL; nothing changed on $HOST"; exit 0; }
# The stage on the host is a fresh private directory of the deploying user, never a fixed /tmp name
# another local user could create first (security review EXT-13)
STAGE=$(ssh "$HOST" 'mktemp -d')
[[ "$STAGE" == /tmp/tmp.* ]] || { echo "unexpected stage directory on $HOST: $STAGE" >&2; exit 1; }
trap 'rm -rf "$LOCAL"; ssh "$HOST" "rm -rf \"$STAGE\""' EXIT
rsync -rlc --delete "$LOCAL/" "$HOST:$STAGE/site/"
scp -q "$REPO/site/deploy/nginx/$SITE.conf" "$HOST:$STAGE/$SITE.conf"

ssh "$HOST" "SITE=$SITE ROOT=$ROOT STAGE=$STAGE VERSION=$VERSION MANIFEST=$MANIFEST bash -s" <<'REMOTE'
set -euo pipefail
stamp=$(date +%Y%m%d-%H%M%S)
# Refuse a stage that is not a real directory owned by us and closed to everyone else
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || { echo "$STAGE is not a directory" >&2; exit 1; }
[ "$(stat -c '%u %a' "$STAGE")" = "$(id -u) 700" ] || { echo "$STAGE is not ours alone" >&2; exit 1; }
if find "$STAGE" -type l | grep -q .; then echo "$STAGE holds a symlink" >&2; exit 1; fi
conf_src="$STAGE/$SITE.conf"
STAGE="$STAGE/site"
(cd "$STAGE" && sha256sum -c --quiet "$MANIFEST")
sudo mkdir -p /var/www/.backups "$ROOT"
[ -n "$(ls -A "$ROOT")" ] && sudo cp -a "$ROOT" "/var/www/.backups/$SITE-$stamp"
# The page is replaced; downloads only gain files, so older versions stay downloadable
sudo rsync -rlc --delete --exclude /downloads/ --exclude "/$MANIFEST" "$STAGE/" "$ROOT/"
sudo mkdir -p "$ROOT/downloads"
sudo rsync -rlc "$STAGE/downloads/" "$ROOT/downloads/"
(cd "$ROOT/downloads" && sha256sum -c --quiet "SHA256SUMS-v$VERSION")
# Every file of the site that is now served is the one built here
(cd "$ROOT" && sha256sum -c --quiet "$STAGE/$MANIFEST")
sudo chown -R www-data:www-data "$ROOT"
sudo find "$ROOT" -type d -exec chmod 755 {} + ; sudo find "$ROOT" -type f -exec chmod 644 {} +

conf=/etc/nginx/sites-enabled/$SITE
if ! sudo cmp -s "$conf_src" "/etc/nginx/$SITE.conf.src" 2>/dev/null; then
  [ -f "$conf" ] && sudo cp -a "$conf" "/var/www/.backups/$SITE.conf-$stamp"
  sudo cp "$conf_src" "$conf"
  # A vhost nginx rejects would stop every other site reloading, so put the old one back
  if ! sudo nginx -t; then
    if [ -f "/var/www/.backups/$SITE.conf-$stamp" ]; then sudo cp -a "/var/www/.backups/$SITE.conf-$stamp" "$conf"; else sudo rm -f "$conf"; fi
    echo "nginx rejected $SITE.conf; the previous vhost is back" >&2; exit 1
  fi
  sudo cp "$conf_src" "/etc/nginx/$SITE.conf.src"
  sudo systemctl reload nginx
  # First run: obtain the certificate (needs DNS pointing here). Later runs: re-apply it to the
  # freshly copied vhost. /etc/letsencrypt/live is root-only, so the test needs sudo too.
  if sudo test -d "/etc/letsencrypt/live/$SITE"; then
    sudo certbot install --nginx --cert-name "$SITE" -d "$SITE" --redirect --non-interactive
  else
    sudo certbot --nginx --cert-name "$SITE" -d "$SITE" --redirect --non-interactive
  fi
fi
sudo nginx -t
sudo systemctl reload nginx
echo "deployed $SITE v$VERSION ($stamp)"
REMOTE
