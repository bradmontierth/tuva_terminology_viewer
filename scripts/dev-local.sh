#!/usr/bin/env bash
set -euo pipefail

# Dev helper: build a single-shard SQLite for a dataset (optional), start the
# local API server, and run the CRA dev server pointed at the API.
#
# Usage:
#   scripts/dev-local.sh --dataset ndc [--input path/to/ndc.csv.gz] [--port 8000]
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/csv_viewer_app"
API_DIR="${ROOT_DIR}/search_api"

DATASET=""
INPUT_PATH=""
PORT=8000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset) DATASET="$2"; shift 2 ;;
    --input) INPUT_PATH="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DATASET" ]]; then
  echo "--dataset is required (e.g., ndc)" >&2
  exit 1
fi

# Optional build step
if [[ -n "$INPUT_PATH" ]]; then
  echo "Building single-shard SQLite for ${DATASET} from ${INPUT_PATH}..."
  pushd "$APP_DIR" >/dev/null
  npm run build:sqlite -- --input "$INPUT_PATH" --dataset "$DATASET" --shard-count 1
  popd >/dev/null
else
  # Verify presence
  SQLITE_FILE="${APP_DIR}/public/data/sqlite/${DATASET}/${DATASET}.sqlite"
  if [[ ! -f "$SQLITE_FILE" ]]; then
    echo "${SQLITE_FILE} not found. Provide --input <csv[.gz]> to build it." >&2
    exit 1
  fi
fi

# Check python deps
if ! python3 -c "import uvicorn,fastapi" >/dev/null 2>&1; then
  echo "Installing local API dev dependencies..."
  pip3 install -r "${API_DIR}/requirements.txt" -r "${API_DIR}/requirements-dev.txt"
fi

LOCAL_DIR="${APP_DIR}/public/data/sqlite/${DATASET}"
API_URL="http://127.0.0.1:${PORT}"

echo "Starting local API on ${API_URL} (dataset=${DATASET}) ..."
(
  cd "$API_DIR"
  LOCAL_SQLITE_DIR="$LOCAL_DIR" CORS_ALLOW_ORIGIN="http://localhost:3000" ALLOWED_DATASETS="$DATASET" \
    python3 local_server.py &
  echo $! > /tmp/tuva_local_api.pid
) 

sleep 1
if ! kill -0 "$(cat /tmp/tuva_local_api.pid 2>/dev/null)" 2>/dev/null; then
  echo "Failed to start local API server." >&2
  exit 1
fi

cleanup() {
  echo "Shutting down..."
  if [[ -f /tmp/tuva_local_api.pid ]]; then
    PID="$(cat /tmp/tuva_local_api.pid || true)"
    if [[ -n "$PID" ]]; then kill "$PID" >/dev/null 2>&1 || true; fi
    rm -f /tmp/tuva_local_api.pid
  fi
}
trap cleanup EXIT INT TERM

echo "Starting CRA dev server (proxying /search,/count,/distinct to ${API_URL}) ..."
pushd "$APP_DIR" >/dev/null
REACT_APP_SEARCH_BACKEND=api \
REACT_APP_DEV_API_PROXY="$API_URL" \
REACT_APP_SQLITE_SOURCE=local \
REACT_APP_FETCH_CROSSWALKS=false \
npm start
popd >/dev/null

