#!/bin/bash

clear
# Exit immediately if a command exits with a non-zero status
set -e

ENV_MODE="dev"
if [ "$1" == "--prod" ]; then
    ENV_MODE="prod"
    echo "Starting in PRODUCTION mode..."
else
    echo "Starting in DEVELOPMENT mode..."
fi

# ── Port assignment ─────────────────────────────────────────────────────────
# dev:  server=8000  ui=5173
# prod: server=8001  ui=1997
# Running both simultaneously is safe — they never share a port.
if [ "$ENV_MODE" == "prod" ]; then
    SERVER_PORT=8001
    UI_PORT=1997
else
    SERVER_PORT=8000
    UI_PORT=5173
fi

# Make sure child processes (the background server) die when this script is closed
trap 'kill 0' SIGINT SIGTERM EXIT

echo "========================================="
echo "   STARTING JOBVIS ($ENV_MODE) — server :$SERVER_PORT / ui :$UI_PORT"
echo "========================================="
echo ""

echo "[0/2] Starting Postgres Database via Docker..."
docker compose up -d
echo "Waiting a few seconds for DB to be configured..."
sleep 3
echo ""

# Start the Python Server in the background
echo "[1/2] Starting FastAPI Server on port $SERVER_PORT..."
cd apps/server

# Kill only the process on OUR specific port — don't touch the other env's server
lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true

APP_ENV=$ENV_MODE ./venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port $SERVER_PORT --timeout-graceful-shutdown 3 &

cd ../..

echo "[2/2] Starting React Vite UI on port $UI_PORT..."
cd apps/ui
# Pass server URL to Vite so the UI always talks to its own environment's backend
VITE_API_BASE="http://localhost:$SERVER_PORT" \
VITE_WS_BASE="ws://localhost:$SERVER_PORT" \
npm run dev -- --port $UI_PORT
