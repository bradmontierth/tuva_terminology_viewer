#!/usr/bin/env bash
set -euo pipefail

# Build SQLite bundles for all datasets under local data/ folders and run the
# local API serving all datasets, plus the CRA dev server using the API.
#
# Usage:
#   scripts/dev-local-all.sh [--versions latest] [--port 8000] \
#     [--threshold 1000] [--skip-crosswalk] [--skip-identity] \
#     [--identity-base-url https://tuva-public-resources.s3.amazonaws.com]
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/csv_viewer_app"
API_DIR="${ROOT_DIR}/search_api"

VERSIONS="latest"
THRESHOLD=1000
DO_CROSSWALK=1
DO_IDENTITY=0
IDENTITY_BASE_URL=""
PORT=8000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --versions) VERSIONS="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --skip-crosswalk) DO_CROSSWALK=0; shift 1 ;;
    --skip-identity) DO_IDENTITY=0; shift 1 ;;
    --identity-base-url) IDENTITY_BASE_URL="$2"; DO_IDENTITY=1; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

pushd "$APP_DIR" >/dev/null

if [[ $DO_CROSSWALK -eq 1 ]]; then
  echo "Generating header crosswalk..."
  npm run generate:crosswalk || true
else
  echo "Skipping header crosswalk generation (--skip-crosswalk)"
fi

if [[ $DO_IDENTITY -eq 1 ]]; then
  BASE_URL="$IDENTITY_BASE_URL"
  if [[ -z "$BASE_URL" ]]; then
    BASE_URL="https://tuva-public-resources.s3.amazonaws.com"
  fi
  echo "Generating identity crosswalk (base: $BASE_URL) ..."
  (cd "$APP_DIR" && TUVA_DATA_BASE_URL="$BASE_URL" node scripts/generateFileIdentityCrosswalk.js) || true
else
  echo "Skipping identity crosswalk generation (--skip-identity or default)"
fi

IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
# Resolve 'latest' to the latest published tag from header-crosswalk, if available
PUBLISHED_LATEST=""
if [[ -f "${APP_DIR}/public/data/header-crosswalk.json" ]]; then
  PUBLISHED_LATEST=$(node -e 'try{const f=require(process.argv[1]);console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}' "${APP_DIR}/public/data/header-crosswalk.json")
fi
for VER in "${VER_LIST[@]}"; do
  VER_TRIMMED="${VER//[[:space:]]/}"
  [[ -z "$VER_TRIMMED" ]] && continue
  if [[ "$VER_TRIMMED" == "latest" && -n "$PUBLISHED_LATEST" ]]; then
    VER_TRIMMED="$PUBLISHED_LATEST"
  fi
  echo "Building API-friendly SQLite bundles (single-shard) for version: $VER_TRIMMED"
  npm run build:sqlite:batch -- \
    --threshold "$THRESHOLD" \
    --shard-count 1 \
    "${ROOT_DIR}/data/versioned_terminology/${VER_TRIMMED}" \
    "${ROOT_DIR}/data/versioned_value_sets/${VER_TRIMMED}" \
    "${ROOT_DIR}/data/versioned_provider_data/${VER_TRIMMED}" || true
done

popd >/dev/null

# Ensure dev API deps are installed
if ! python3 -c "import uvicorn,fastapi" >/dev/null 2>&1; then
  echo "Installing local API dev dependencies..."
  pip3 install -r "${API_DIR}/requirements.txt" -r "${API_DIR}/requirements-dev.txt"
fi

API_URL="http://127.0.0.1:${PORT}"

echo "Starting local API on ${API_URL} (serving all datasets from public/data/sqlite/) ..."
(
  cd "$API_DIR"
  LOCAL_SQLITE_DIR="${APP_DIR}/public/data/sqlite" CORS_ALLOW_ORIGIN="http://localhost:3000" \
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

echo "Starting CRA dev server (proxying to ${API_URL}) ..."
pushd "$APP_DIR" >/dev/null
REACT_APP_SEARCH_BACKEND=api \
REACT_APP_DEV_API_PROXY="$API_URL" \
REACT_APP_SQLITE_SOURCE=local \
REACT_APP_FETCH_CROSSWALKS=false \
npm start
popd >/dev/null
