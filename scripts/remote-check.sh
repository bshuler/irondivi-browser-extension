#!/usr/bin/env bash
# Run the project's checks (npm ci, tsc, vitest, build:all) on a Linux build host.
#
# Replaces the GitHub Actions workflow removed 2026-10-10: Actions on this account
# no longer start, and hp1/hp2 (32 cores, plain ssh) do the job without a bill.
#
# Usage: scripts/remote-check.sh [--host hp1|hp2]      (default hp2; hp1 runs orchd)
#        REMOTE_CHECK_HOST=hp1 scripts/remote-check.sh
#
# Syncs the tracked + untracked-unignored files (git ls-files), so node_modules,
# dist/ and safari/ never cross the wire. Linux results only: build:safari:app
# still needs a Mac with Xcode.
set -euo pipefail

host="${REMOTE_CHECK_HOST:-hp2}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
name="$(basename "$PWD")"
remote_dir="remote-check/$name"   # relative to $HOME on the host

echo "== sync -> $host:$remote_dir"
ssh "$host" "mkdir -p $remote_dir"
git ls-files --cached --others --exclude-standard -z \
  | rsync -rlpc0 --files-from=- ./ "$host:$remote_dir/"

echo "== check on $host"
ssh "$host" bash -s "$remote_dir" <<'REMOTE'
set -euo pipefail
cd "$1"
export CI=1
echo "node $(node -v), npm $(npm -v), $(nproc) cores"
npm ci --no-audit --no-fund --loglevel=error
npx tsc --noEmit
npx vitest run
npm run build:all
echo "== REMOTE CHECK PASSED on $(hostname)"
REMOTE
