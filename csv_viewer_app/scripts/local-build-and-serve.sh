#!/usr/bin/env bash
set -euo pipefail

# Sync CSV inputs from S3 to local data/, build crosswalks and SQLite bundles,
# then start the dev server on localhost.
#
# Usage:
#   ./scripts/local-build-and-serve.sh \
#     [--src-bucket tuva-public-resources] \
#     [--versions latest,0.15.3] \
#     [--profile NAME] [--region REGION] \
#     [--identity-base-url https://tuva-public-resources.s3.amazonaws.com] \
#     [--skip-input-sync] [--skip-crosswalk] [--skip-identity] [--skip-sqlite] \
#     [--use-api] [--api-port 8000] [--api-host 127.0.0.1]

SRC_BUCKET="tuva-public-resources"
VERSIONS="latest"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
IDENTITY_BASE_URL=""
DO_SYNC_INPUTS=1
DO_CROSSWALK=1
DO_IDENTITY=1
DO_SQLITE=1
DO_USE_API=0
API_HOST="127.0.0.1"
API_PORT=8000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-bucket)
      SRC_BUCKET="$2"; shift 2 ;;
    --versions)
      VERSIONS="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --identity-base-url)
      IDENTITY_BASE_URL="$2"; shift 2 ;;
    --skip-input-sync)
      DO_SYNC_INPUTS=0; shift 1 ;;
    --skip-crosswalk)
      DO_CROSSWALK=0; shift 1 ;;
    --skip-identity)
      DO_IDENTITY=0; shift 1 ;;
    --skip-sqlite)
      DO_SQLITE=0; shift 1 ;;
    --use-api)
      DO_USE_API=1; shift 1 ;;
    --api-port)
      API_PORT="$2"; shift 2 ;;
    --api-host)
      API_HOST="$2"; shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR%/scripts}"
REPO_ROOT="${APP_DIR}"

if [[ $DO_SYNC_INPUTS -eq 1 ]]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required for input sync" >&2; exit 1; }
  # Resolve published latest from header-crosswalk when available; generate if missing
  PUBLISHED_LATEST=""
  if [[ -f "${APP_DIR}/public/data/header-crosswalk.json" ]]; then
    PUBLISHED_LATEST=$(node -e 'try{const f=require(process.argv[1]);console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}' "${APP_DIR}/public/data/header-crosswalk.json")
  elif [[ ${DO_CROSSWALK} -eq 1 ]]; then
    echo "Generating header crosswalk to resolve published latest..."
    (cd "$APP_DIR" && npm run generate:crosswalk)
    if [[ -f "${APP_DIR}/public/data/header-crosswalk.json" ]]; then
      PUBLISHED_LATEST=$(node -e 'try{const f=require(process.argv[1]);console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}' "${APP_DIR}/public/data/header-crosswalk.json")
    fi
  fi
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    [[ -z "$VER_TRIMMED" ]] && continue
    if [[ "$VER_TRIMMED" == "latest" && -n "$PUBLISHED_LATEST" ]]; then
      VER_TRIMMED="$PUBLISHED_LATEST"
    fi
    echo "Syncing inputs for version: $VER_TRIMMED"
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
      "s3://${SRC_BUCKET}/versioned_terminology/${VER_TRIMMED}/" \
      "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}/" \
      --size-only || true
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
      "s3://${SRC_BUCKET}/versioned_value_sets/${VER_TRIMMED}/" \
      "${REPO_ROOT}/../data/versioned_value_sets/${VER_TRIMMED}/" \
      --size-only || true
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
      "s3://${SRC_BUCKET}/versioned_provider_data/${VER_TRIMMED}/" \
      "${REPO_ROOT}/../data/versioned_provider_data/${VER_TRIMMED}/" \
      --size-only || true
  done
fi

pushd "$APP_DIR" >/dev/null

if [[ $DO_CROSSWALK -eq 1 ]]; then
  echo "Generating header crosswalk..."
  npm run generate:crosswalk
fi

if [[ $DO_IDENTITY -eq 1 ]]; then
  BASE_URL="$IDENTITY_BASE_URL"
  if [[ -z "$BASE_URL" ]]; then
    BASE_URL="https://${SRC_BUCKET}.s3.amazonaws.com"
  fi
  echo "Generating identity crosswalk (base: $BASE_URL) ..."
  TUVA_DATA_BASE_URL="$BASE_URL" node scripts/generateFileIdentityCrosswalk.js
fi

if [[ $DO_SQLITE -eq 1 ]]; then
  # Resolve 'latest' to the latest published tag from header-crosswalk, if available
  PUBLISHED_LATEST=""
  if [[ -f "public/data/header-crosswalk.json" ]]; then
    PUBLISHED_LATEST=$(node -e 'try{const f=require("./public/data/header-crosswalk.json");console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}')
  fi
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    [[ -z "$VER_TRIMMED" ]] && continue
    if [[ "$VER_TRIMMED" == "latest" && -n "$PUBLISHED_LATEST" ]]; then
      VER_TRIMMED="$PUBLISHED_LATEST"
    fi
    echo "Building SQLite bundles for version: $VER_TRIMMED"
    npm run build:sqlite:batch -- \
      "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}" \
      "${REPO_ROOT}/../data/versioned_value_sets/${VER_TRIMMED}" \
      "${REPO_ROOT}/../data/versioned_provider_data/${VER_TRIMMED}" || true
  done
fi

API_URL="http://${API_HOST}:${API_PORT}"

cleanup() {
  if [[ -f /tmp/tuva_local_api.pid ]]; then
    PID="$(cat /tmp/tuva_local_api.pid || true)"
    if [[ -n "$PID" ]]; then kill "$PID" >/dev/null 2>&1 || true; fi
    rm -f /tmp/tuva_local_api.pid
  fi
}
trap cleanup EXIT INT TERM

if [[ $DO_USE_API -eq 1 ]]; then
  echo "Starting local API on ${API_URL} serving ${APP_DIR}/public/data/sqlite ..."
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  # Launch API
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR}/../.." >/dev/null 2>&1 || true
  )
  (
    cd "${APP_DIR%/csv_viewer_app}/search_api" >/dev/null 2>&1 || true
    LOCAL_SQLITE_DIR="${APP_DIR}/public/data/sqlite" CORS_ALLOW_ORIGIN="http://localhost:3000" HOST="$API_HOST" PORT="$API_PORT" \
      python3 local_server.py &
    echo $! > /tmp/tuva_local_api.pid
  )
fi

echo "Starting dev server (fetch crosswalks, SW disabled; API mode: ${DO_USE_API})..."
if [[ $DO_USE_API -eq 1 ]]; then
  REACT_APP_SEARCH_BACKEND=api \
  REACT_APP_DEV_API_PROXY="$API_URL" \
  REACT_APP_FETCH_CROSSWALKS=true \
  REACT_APP_DISABLE_SQLITE_SW=1 \
  npm start
else
  REACT_APP_FETCH_CROSSWALKS=true \
  REACT_APP_DISABLE_SQLITE_SW=1 \
  npm start
fi

popd >/dev/null
