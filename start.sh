#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Make sure child processes (the background server) die when this script is closed
trap 'kill 0' SIGINT SIGTERM EXIT

echo "========================================="
echo "   STARTING JOBVIS APPLICATION   "
echo "========================================="
echo ""

echo "[0/2] Starting Postgres Database via Docker..."
docker compose up -d
echo "Waiting a few seconds for DB to be ready..."
sleep 3
echo ""

# Start the Python Server in the background
echo "[1/2] Starting FastAPI Server in the background..."
cd apps/server
source venv/bin/activate

# Silently forcefully kill any stranded python processes hoarding port 8000 from a previous run
lsof -ti:8000 | xargs kill -9 2>/dev/null || true

# Run server and stream its output. Running in background using '&'
uvicorn main:app --reload --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 3 &

# Go back to the original directory
cd ../..

# Start the React Frontend
echo "[2/2] Starting React Vite UI..."
cd apps/ui
# This will run in the foreground so you can see Vite's output and stop everything with Ctrl+C
npm run dev
