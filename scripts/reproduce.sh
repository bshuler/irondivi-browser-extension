#!/usr/bin/env bash
# Rebuild a published release from the commit its releases.json names and
# check that every browser package matches the published sha256 (EXT-14).
#
#   scripts/reproduce.sh [releases.json URL or file]
#
# Default: https://browser.divi.domains/downloads/releases.json. Use the Node
# version in .nvmrc: zlib is part of Node, and another version can compress
# the same files to other bytes. The Safari app is not compared: its code
# signature is not reproducible.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:-https://browser.divi.domains/downloads/releases.json}"
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
  const got = createHash("sha256").update(readFileSync(`${dir}/${f.file}`)).digest("hex");
  const ok = got === f.sha256;
  if (!ok) bad++;
  console.log(`${ok ? "same" : "DIFF"}  ${f.file}`);
}
process.exit(bad ? 1 : 0);
' "$WORK/releases.json" "$WORK/src/packages"
