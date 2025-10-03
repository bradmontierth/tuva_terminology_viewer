#!/usr/bin/env bash
set -euo pipefail

# Simple helper to build the CSV viewer and deploy to an S3 bucket.
#
# Usage:
#   ./scripts/deploy-to-s3.sh [bucket-name] [--no-build] [--profile NAME] [--region REGION] [--website] [--cf-dist-id ID] [--include-sqlite]
#
# Defaults:
#   bucket-name = tuva-terminology-viewer
#   profile     = default AWS CLI profile
#   region      = AWS CLI default region
#
# Notes:
# - Expects AWS CLI v2 installed and configured.
# - Uses CRA .env.production (committed) to point at the new bucket and force remote SQLite catalog.
# - If you pass --website, the script enables static website hosting (index+error = index.html).

BUCKET="${1:-tuva-terminology-viewer}"
shift || true

DO_BUILD=1
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
ENABLE_WEBSITE=0
CF_DIST_ID=""
INCLUDE_SQLITE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      DO_BUILD=0
      shift
      ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2")
      shift 2
      ;;
    --region)
      AWS_REGION_ARG=("--region" "$2")
      shift 2
      ;;
    --website)
      ENABLE_WEBSITE=1
      shift
      ;;
    --cf-dist-id)
      CF_DIST_ID="$2"
      shift 2
      ;;
    --include-sqlite)
      INCLUDE_SQLITE=1
      shift
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR%/scripts}"

pushd "$APP_DIR" >/dev/null

if [[ $DO_BUILD -eq 1 ]]; then
  echo "Building app (CRA) with .env.production..."
  # Avoid reinstall here; assume deps installed. Uncomment if you want a clean build:
  # npm ci
  npm run build
fi

echo "Syncing build/ (excluding HTML and data prefixes) to s3://${BUCKET}/ (SQLite: $([[ $INCLUDE_SQLITE -eq 1 ]] && echo include || echo exclude))"
# Never touch dataset prefixes in the root bucket when deploying the app.
# This avoids deleting large data trees that are not part of the app build.
SYNC_EXCLUDES=(
  --exclude "*.html"
  --exclude "versioned_terminology/*"
  --exclude "versioned_value_sets/*"
  --exclude "versioned_provider_data/*"
  --exclude "reference-data/*"
  --exclude "terminology_viewer_sqlite/*"
)
# Optionally exclude local SQLite bundles in the app build unless explicitly requested.
if [[ $INCLUDE_SQLITE -ne 1 ]]; then
  SYNC_EXCLUDES+=(--exclude "data/sqlite/*")
fi
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
  "${APP_DIR}/build/" "s3://${BUCKET}/" \
  --delete --size-only "${SYNC_EXCLUDES[@]}"

# Upload HTML from local build explicitly to avoid size-only false negatives
echo "Uploading HTML (with cache headers) from local build to s3://${BUCKET}/"
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
  "${APP_DIR}/build/" "s3://${BUCKET}/" \
  --recursive --exclude "*" --include "*.html" \
  --metadata-directive REPLACE \
  --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
  --content-type "text/html"

# Note: HTML already uploaded with metadata above

if [[ $ENABLE_WEBSITE -eq 1 ]]; then
  echo "Enabling static website hosting on bucket ${BUCKET}"
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 website "s3://${BUCKET}" \
    --index-document index.html \
    --error-document index.html
fi

if [[ -n "$CF_DIST_ID" ]]; then
  echo "Creating CloudFront invalidation for distribution $CF_DIST_ID"
  aws "${AWS_PROFILE_ARG[@]}" cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/*"
fi

popd >/dev/null
echo "Deploy complete."
