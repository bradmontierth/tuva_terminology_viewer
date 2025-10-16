#!/usr/bin/env bash
set -euo pipefail

# Orchestrate building viewer assets + app, publishing to S3/CloudFront,
# publishing API SQLite files, and deploying the Search API Lambda.
#
# Usage:
#   scripts/deploy-complete.sh --bucket tuva-terminology-viewer \
#     [--versions latest] [--profile NAME] [--region REGION] \
#     [--cf-dist-id DIST_ID] [--api-stack TuvaSearchApi] \
#     [--assets-prefix terminology-viewer] [--api-prefix terminology-viewer/api_sqlite] \
#     [--allow-origins https://your.site]

BUCKET=""
VERSIONS="latest"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
CF_DIST_ID=""
API_STACK="TuvaSearchApi"
ASSETS_PREFIX="terminology-viewer"
API_PREFIX="terminology-viewer/api_sqlite"
ALLOW_ORIGINS="*"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --versions) VERSIONS="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region) AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --cf-dist-id) CF_DIST_ID="$2"; shift 2 ;;
    --api-stack) API_STACK="$2"; shift 2 ;;
    --assets-prefix) ASSETS_PREFIX="$2"; shift 2 ;;
    --api-prefix) API_PREFIX="$2"; shift 2 ;;
    --allow-origins) ALLOW_ORIGINS="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "--bucket is required (S3 bucket that hosts the app and data)" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT_DIR}/csv_viewer_app"

pushd "$APP_DIR" >/dev/null

echo "Building and publishing viewer assets to s3://${BUCKET}/${ASSETS_PREFIX} (versions: ${VERSIONS}) ..."
./scripts/build-and-publish-assets.sh --dest-bucket "$BUCKET" --versions "$VERSIONS" --prefix "$ASSETS_PREFIX" --skip-shards \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "Publishing API SQLite files to s3://${BUCKET}/${API_PREFIX}/ ..."
./scripts/publish-api-sqlite.sh --dest-bucket "$BUCKET" --prefix "$API_PREFIX" \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "Building and deploying SPA to s3://${BUCKET} ..."
./scripts/deploy-to-s3.sh "$BUCKET" --prefix "$ASSETS_PREFIX" --cf-dist-id "$CF_DIST_ID" --include-sqlite \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

popd >/dev/null

echo "Deploying Search API (stack: ${API_STACK}) ..."
"${ROOT_DIR}/search_api/deploy.sh" --bucket "$BUCKET" --stack "$API_STACK" \
  --prefix "$API_PREFIX" --allow-origins "${ALLOW_ORIGINS}" \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "All done. Remember to set REACT_APP_SEARCH_BACKEND=api and REACT_APP_SEARCH_API_BASE_URL=<API URL> for your production build if using the API backend."
