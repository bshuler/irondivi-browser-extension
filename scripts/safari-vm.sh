#!/usr/bin/env bash
# A throwaway macOS VM for testing the Safari build without anyone's screen.
#
# Safari only runs on macOS, so a Docker container can't host it. This runs
# a headless macOS guest with Tart (https://tart.run), reachable over ssh for
# commands and over VNC for screenshots, clicks and keys. Nothing it does
# opens a window or takes focus on the host.
#
#   scripts/safari-vm.sh up                 create (first time) and boot the VM
#   scripts/safari-vm.sh install [APP]      copy the built app in and register it
#   scripts/safari-vm.sh sh 'CMD'           run a command in the guest
#   scripts/safari-vm.sh shot OUT.png       screenshot the guest's screen
#   scripts/safari-vm.sh click X Y          click at guest pixel X,Y (--double, --right)
#   scripts/safari-vm.sh scroll X Y up|down [TICKS]
#   scripts/safari-vm.sh type TEXT          type text
#   scripts/safari-vm.sh key KEY...         press keys: enter, esc, tab, ... (no modifiers reach the guest)
#   scripts/safari-vm.sh down               shut the VM down (keeps its disk)
#   scripts/safari-vm.sh reset              delete the VM; the next `up` starts clean
#
# Needs tart on PATH. The guest is Cirrus Labs' vanilla macOS image, whose
# only account is the image's published default (admin/admin); `up` swaps it
# for an ssh key kept in $STATE on first boot.
#
# Safari forgets "Allow unsigned extensions" every time it quits, so after an
# install or a Safari relaunch, in the guest (all by `click`; the password
# prompt takes the image's `admin`): Safari › Settings › Developer › Allow
# unsigned extensions; `sh 'pkill -x "IronDivi Wallet"; open -g
# ~/Applications/"IronDivi Wallet.app"'` so Safari rescans (answer Gatekeeper
# with Open Anyway); tick IronDivi under Settings › Extensions; and on the
# first click of the toolbar icon, Always Allow on the site under test.
# The wallet's own banner then asks for the Divi services (Allow, then
# Always Allow). Settings › Websites › IronDivi Wallet takes that grant back
# for a re-test, but a running background keeps it until Safari quits.
set -euo pipefail

cd "$(dirname "$0")/.."
NAME="${SAFARI_VM_NAME:-irondivi-safari}"
BASE="${SAFARI_VM_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-vanilla:26.6.2}"
STATE="${XDG_CACHE_HOME:-$HOME/.cache}/irondivi-safari-vm"
KEY="$STATE/id_ed25519"
VNC_URL="$STATE/vnc-url"          # carries the VNC password: never printed
APP_DEFAULT="safari/build/Build/Products/Debug/IronDivi Wallet.app"
HERE="$(pwd)/scripts/safari-vm"

mkdir -p "$STATE" && chmod 700 "$STATE"
command -v tart >/dev/null || { echo "tart not found: see https://tart.run/quick-start/" >&2; exit 1; }

running() { tart list --format json | python3 -I -c 'import sys,json;n=sys.argv[1];sys.exit(0 if any(v["Name"]==n and v["State"]=="running" for v in json.load(sys.stdin)) else 1)' "$NAME"; }
exists()  { tart list --format json | python3 -I -c 'import sys,json;n=sys.argv[1];sys.exit(0 if any(v["Name"]==n for v in json.load(sys.stdin)) else 1)' "$NAME"; }
ip()      { tart ip "$NAME" --wait 120; }

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)
gsh() { ssh "${SSH_OPTS[@]}" -i "$KEY" -o BatchMode=yes "admin@$(ip)" "$@"; }

python_env() {
  local venv="$STATE/venv"
  if [ ! -x "$venv/bin/python" ] || ! cmp -s "$HERE/requirements.txt" "$venv/requirements.txt"; then
    uv venv -q --python 3.12 "$venv"
    VIRTUAL_ENV="$venv" uv pip install -q -r "$HERE/requirements.txt"
    cp "$HERE/requirements.txt" "$venv/requirements.txt"
  fi
  echo "$venv/bin/python"
}

# Each new VNC connection can crash the VM (an assertion in Apple's VNC
# server), so one daemon holds a single connection and every command goes
# through its socket.
SOCK="$STATE/vnc.sock"
PIDFILE="$STATE/vnc.pid"
stop_vnc() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE" "$SOCK"; true; }
start_vnc() {
  local py; py="$(python_env)"
  nohup python3 -I -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$py" -I "$HERE/vnc.py" "$VNC_URL" serve "$SOCK" >> "$STATE/vnc.log" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 30); do [ -S "$SOCK" ] && return 0; sleep 0.5; done
  echo "VNC daemon never came up; see $STATE/vnc.log" >&2; return 1
}
vnc() {
  local py rc=0; py="$(python_env)"
  { [ -S "$SOCK" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; } || { stop_vnc; start_vnc; }
  timeout 30 "$py" -I "$HERE/vnc.py" --socket "$SOCK" "$@" || rc=$?
  if [ "$rc" -eq 124 ]; then
    stop_vnc
    echo "VNC timed out: check 'tart list'; the VM may have stopped" >&2
  fi
  return "$rc"
}

authorize_key() {
  # The image's default login, typed by ssh's askpass hook so the password
  # never appears on a command line; replaced by a key straight away.
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$NAME" -f "$KEY"
  gsh true 2>/dev/null && return 0
  local askpass="$STATE/askpass"
  printf '#!/bin/sh\necho admin\n' > "$askpass" && chmod 700 "$askpass"
  SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force \
    ssh "${SSH_OPTS[@]}" -o PubkeyAuthentication=no "admin@$(ip)" \
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < "$KEY.pub"
}

case "${1:-}" in
  up)
    if ! exists; then
      tart clone "$BASE" "$NAME"
      tart set "$NAME" --display 1440x900 --memory 8192 --cpu 4
    fi
    if ! running; then
      stop_vnc
      : > "$STATE/run.log" && chmod 600 "$STATE/run.log"
      # In its own session, so the VM outlives the shell (or agent) that
      # started it; the exit code in run.log says why it stopped (133 is a
      # crash: see ~/Library/Logs/DiagnosticReports/tart-*.ips)
      nohup python3 -I -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
        sh -c 'tart run "$1" --no-graphics --vnc-experimental --no-audio --no-clipboard; echo "tart exited rc=$? at $(date +%T)"' sh "$NAME" \
        >> "$STATE/run.log" 2>&1 < /dev/null &
    fi
    for _ in $(seq 120); do
      grep -o 'vnc://[^ ]*' "$STATE/run.log" 2>/dev/null | head -1 > "$VNC_URL.tmp" || true
      [ -s "$VNC_URL.tmp" ] && break
      sleep 1
    done
    [ -s "$VNC_URL.tmp" ] || { echo "VNC server never came up; see $STATE/run.log" >&2; exit 1; }
    chmod 600 "$VNC_URL.tmp" && mv "$VNC_URL.tmp" "$VNC_URL"
    for _ in $(seq 60); do
      nc -z -G 2 "$(ip)" 22 2>/dev/null && break
      sleep 2
    done
    authorize_key
    echo "up: $NAME at $(ip) ($(gsh sw_vers -productVersion))"
    ;;
  install)
    app="${2:-$APP_DEFAULT}"
    [ -d "$app" ] || { echo "no app at $app: run 'npm run build:safari:app' first" >&2; exit 1; }
    # `open` before the desktop is up registers nothing
    gsh 'for i in $(seq 60); do pgrep -x Dock >/dev/null && break; sleep 2; done'
    gsh 'pkill -x "IronDivi Wallet" 2>/dev/null; rm -rf ~/Applications/"IronDivi Wallet.app"; mkdir -p ~/Applications'
    # scp, unlike a download, sets no quarantine flag, so Gatekeeper lets a
    # development-signed build launch in the guest
    scp -q -r "${SSH_OPTS[@]}" -i "$KEY" "$app" "admin@$(ip):Applications/"
    gsh 'open ~/Applications/"IronDivi Wallet.app" && sleep 3 && pluginkit -m -i domains.divi.irondivi.Extension -v'
    ;;
  sh)    shift; gsh "$@" ;;
  shot)  vnc shot "${2:?output path}" ;;
  click) shift; vnc click "$@" ;;
  scroll) shift; vnc scroll "$@" ;;
  type)  shift; vnc type "$@" ;;
  key)   shift; vnc key "$@" ;;
  down)  stop_vnc; running && tart stop "$NAME" || true ;;
  reset) stop_vnc; running && tart stop "$NAME" || true; exists && tart delete "$NAME" || true; rm -f "$VNC_URL" ;;
  *)     awk 'NR>1 && /^set /{exit} NR>1' "$0" >&2; exit 2 ;;
esac
