#!/usr/bin/env bash
# Rebuild a published release from the commit its releases.json names and
# check that every browser package matches the published sha256 (EXT-14).
#
#   scripts/reproduce.sh [releases.json URL or file]
#
# Default: https://browser.irondivi.com/downloads/releases.json. Use the Node
# version in .nvmrc: zlib is part of Node, and another version can compress
# the same files to other bytes. The Safari app is not compared: its code
# signature is not reproducible. A Mozilla-signed .xpi is downloaded from beside
# releases.json and compared file by file (scripts/xpi-same.py): Mozilla adds
# its signature and repacks the zip.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:-https://browser.irondivi.com/downloads/releases.json}"
want_node="v$(cat .nvmrc)"
[[ "$(node --version)" == "$want_node" ]] || echo "warning: node is $(node --version), releases are built with $want_node" >&2

WORK=$(mktemp -d)
cleanup() { git worktree remove --force "$WORK/src" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [[ -f "$SRC" ]]; then cp "$SRC" "$WORK/releases.json"; else curl -fsS "$SRC" -o "$WORK/releases.json"; fi
commit=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!/^[0-9a-f]{40}$/.test(r.commit || "")) process.exit(1); console.log(r.commit)' "$WORK/releases.json") \
  || { echo "releases.json names no commit" >&2; exit 1; }

git cat-file -e "$commit^{commit}" 2>/dev/null || git fetch -q origin "$commit"
git worktree add -q --detach "$WORK/src" "$commit"
echo "Rebuilding $commit"
(cd "$WORK/src" && npm ci --silent --no-audit --no-fund && npm run -s package >/dev/null)

node -e '
const { createHash } = require("crypto");
const { readFileSync } = require("fs");
const [releases, dir] = process.argv.slice(1);
const r = JSON.parse(readFileSync(releases, "utf8"));
let bad = 0;
for (const [browser, f] of Object.entries(r.files)) {
  if (browser === "safari") { console.log(`skip  ${f.file} (code signature is not reproducible)`); continue; }
  if (f.signed) { console.log(`later ${f.file} (signed by Mozilla: compared file by file)`); continue; }
  const got = createHash("sha256").update(readFileSync(`${dir}/${f.file}`)).digest("hex");
  const ok = got === f.sha256;
  if (!ok) bad++;
  console.log(`${ok ? "same" : "DIFF"}  ${f.file}`);
}
process.exit(bad ? 1 : 0);
' "$WORK/releases.json" "$WORK/src/packages"

# The signed .xpi: fetch the published one, check it against its sha256, and
# check it holds exactly the files this rebuild packaged
signed=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const f of Object.values(r.files)) if (f.signed) console.log(f.file + " " + f.sha256)' "$WORK/releases.json")
while read -r file sha; do
  [[ -n "$file" ]] || continue
  if [[ -f "$SRC" ]]; then cp "$(dirname "$SRC")/$file" "$WORK/$file"; else curl -fsS "${SRC%/*}/$file" -o "$WORK/$file"; fi
  [[ "$(shasum -a 256 "$WORK/$file" | cut -d' ' -f1)" == "$sha" ]] || { echo "DIFF  $file (published file doesn't match releases.json)"; exit 1; }
  python3 -I scripts/xpi-same.py "$WORK/src/packages/$file" "$WORK/$file" >/dev/null || { echo "DIFF  $file"; exit 1; }
  echo "same  $file (Mozilla's signature aside)"
done <<< "$signed"
