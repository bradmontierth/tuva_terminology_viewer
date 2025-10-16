#!/usr/bin/env bash
# Re-exec with bash if invoked under sh/dash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

# Release helper: build viewer assets for the published latest, build single-shard
# API SQLite, deploy the Search API, then build and deploy the SPA configured
# to call that API. Intended for production releases.
#
# Usage:
#   scripts/release-prod.sh --bucket <BUCKET> \
#     [--versions latest] [--datasets ndc,providers] \
#     [--cf-dist-id <ID>] [--api-stack TuvaSearchApi] \
#     [--api-prefix api_sqlite] [--allow-origins https://your.domain] \
#     [--profile <aws-profile>] [--region <aws-region>]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/csv_viewer_app"

BUCKET=""
VERSIONS="latest"
DATASETS=""  # empty means auto-detect from built outputs
CF_DIST_ID=""
API_STACK="TuvaSearchApi"
ASSETS_PREFIX="terminology-viewer"
API_PREFIX="terminology-viewer/api_sqlite"
ALLOW_ORIGINS="*"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --versions) VERSIONS="$2"; shift 2 ;;
    --datasets) DATASETS="$2"; shift 2 ;;
    --cf-dist-id) CF_DIST_ID="$2"; shift 2 ;;
    --api-stack) API_STACK="$2"; shift 2 ;;
    --assets-prefix) ASSETS_PREFIX="$2"; shift 2 ;;
    --api-prefix) API_PREFIX="$2"; shift 2 ;;
    --allow-origins) ALLOW_ORIGINS="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region) AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "--bucket is required" >&2
  exit 1
fi

echo "[0/5] Refresh header crosswalk (resolve latest from Git tags)"
pushd "$APP_DIR" >/dev/null
npm run generate:crosswalk || true

echo "[1/5] Build + publish viewer data assets (versions: ${VERSIONS})"
# Force single-shard builds to reuse for API upload and avoid duplicate compute
bash "${APP_DIR}/scripts/build-and-publish-assets.sh" --dest-bucket "$BUCKET" --versions "$VERSIONS" --single-shard --prefix "$ASSETS_PREFIX" --skip-shards \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "[2/4] Publish API SQLite to s3://${BUCKET}/${API_PREFIX}/"
if [[ -n "$DATASETS" ]]; then
  bash "${APP_DIR}/scripts/publish-api-sqlite.sh" --dest-bucket "$BUCKET" --prefix "$API_PREFIX" --datasets "$DATASETS" \
    "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"
else
  bash "${APP_DIR}/scripts/publish-api-sqlite.sh" --dest-bucket "$BUCKET" --prefix "$API_PREFIX" \
    "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"
fi

popd >/dev/null

echo "[3/4] Deploy/Update Search API stack (${API_STACK})"
"${ROOT_DIR}/search_api/deploy.sh" --bucket "$BUCKET" --stack "$API_STACK" \
  --prefix "$API_PREFIX" --allow-origins "$ALLOW_ORIGINS" \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

API_URL=$(aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" cloudformation describe-stacks \
  --stack-name "$API_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
if [[ -z "$API_URL" || "$API_URL" == "None" ]]; then
  echo "Failed to resolve API URL; aborting before SPA build" >&2
  exit 1
fi
echo "Resolved API URL: ${API_URL}"

echo "[4/4] Build + deploy SPA configured for API (${BUCKET})"
pushd "$APP_DIR" >/dev/null
REACT_APP_SEARCH_BACKEND=api \
REACT_APP_SEARCH_API_BASE_URL="$API_URL" \
bash "${APP_DIR}/scripts/deploy-to-s3.sh" "$BUCKET" --prefix "$ASSETS_PREFIX" ${CF_DIST_ID:+--cf-dist-id "$CF_DIST_ID"} --include-sqlite \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"
popd >/dev/null

echo "Done. API: ${API_URL}  Site bucket: s3://${BUCKET}"
