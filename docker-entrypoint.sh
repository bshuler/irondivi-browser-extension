#!/bin/bash
set -e

# Clean up any existing Xvfb processes
pkill Xvfb 2>/dev/null || true
rm -f /tmp/.X99-lock 2>/dev/null || true

echo "Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
sleep 2

echo "Verifying display is ready..."
xdpyinfo -display :99 > /dev/null 2>&1 || { echo "Display not ready"; exit 1; }

echo "Running tests..."
exec "$@"
