#!/bin/bash
# Simple local development server

PORT=${1:-8000}

echo "Starting local server on http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

cd "$(dirname "$0")"

# Try python3 first, fall back to python
if command -v python3 &> /dev/null; then
    python3 -m http.server $PORT
elif command -v python &> /dev/null; then
    python -m SimpleHTTPServer $PORT
else
    echo "Error: Python not found. Please install Python to run the development server."
    exit 1
fi
