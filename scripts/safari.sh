#!/usr/bin/env bash
# Wrap dist/safari in the macOS app Safari requires, then build it.
#
# Safari only loads web extensions that ship inside a signed macOS app.
# Apple's converter generates that app as an Xcode project; this script runs
# it, fixes the bundle ids the converter gets wrong, and builds the app.
#
# Output: safari/build/Build/Products/Debug/IronDivi Wallet.app  (gitignored)
#
# Signing is controlled by SAFARI_SIGN (default: adhoc):
#   adhoc    - "sign to run locally". Safari loads it only with
#              Develop > Allow Unsigned Extensions enabled. No Apple account needed.
#   <team>   - a 10-character Apple team id; uses automatic signing with that
#              team (needs the team's account added in Xcode > Settings > Accounts).
#
# Requires Xcode (xcrun safari-web-extension-converter). macOS only.
set -euo pipefail

cd "$(dirname "$0")/.."
BUNDLE_ID="domains.divi.irondivi"
APP_NAME="IronDivi Wallet"
OUT="safari"
SIGN="${SAFARI_SIGN:-adhoc}"

[ -f dist/safari/manifest.json ] || { echo "dist/safari missing: run 'npm run build:safari' first" >&2; exit 1; }
command -v xcrun >/dev/null || { echo "xcrun not found: install Xcode" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
xcrun safari-web-extension-converter dist/safari \
  --project-location "$OUT" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --copy-resources --no-open --no-prompt

PBX="$OUT/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
# The converter names the host app after APP_NAME ("domains.divi.IronDivi-Wallet")
# while the extension gets BUNDLE_ID.Extension; Xcode then refuses to embed the
# extension because its id is not prefixed by the app's. Make both consistent.
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = \"domains.divi.IronDivi-Wallet\";/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_ID;/" "$PBX"

SIGN_ARGS=()
if [ "$SIGN" = adhoc ]; then
  SIGN_ARGS=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- PROVISIONING_PROFILE_SPECIFIER= DEVELOPMENT_TEAM=)
else
  SIGN_ARGS=(CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$SIGN" -allowProvisioningUpdates)
fi

xcodebuild -project "$OUT/$APP_NAME/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" -configuration Debug \
  -derivedDataPath "$OUT/build" "${SIGN_ARGS[@]}" build 2>&1 \
  | grep -E "error:|warning: The following keys|BUILD " || true

APP="$OUT/build/Build/Products/Debug/$APP_NAME.app"
[ -d "$APP" ] || { echo "build failed: $APP not produced" >&2; exit 1; }
echo
echo "Built $APP"
echo "Register with Safari:  open \"$APP\"   (then Safari > Settings > Extensions)"
if [ "$SIGN" = adhoc ]; then
  echo "Ad-hoc signed: enable Safari > Develop > Allow Unsigned Extensions first."
fi
