#!/usr/bin/env bash
set -euo pipefail

# Simple helper to build the CSV viewer and deploy to an S3 bucket.
#
# Usage:
#   ./scripts/deploy-to-s3.sh [bucket-name] \
#     [--prefix terminology-viewer] [--no-build] [--profile NAME] [--region REGION] \
#     [--website] [--cf-dist-id ID] [--include-sqlite]
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
DEST_PREFIX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      DEST_PREFIX="$2"
      shift 2
      ;;
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

echo "Syncing build/ (excluding HTML and data prefixes) to s3://${BUCKET}${DEST_PREFIX:+/$DEST_PREFIX}/ (SQLite: $([[ $INCLUDE_SQLITE -eq 1 ]] && echo include || echo exclude))"
# Destination base (optionally under a prefix)
DEST_BASE="s3://${BUCKET}"
if [[ -n "$DEST_PREFIX" ]]; then
  DEST_BASE="s3://${BUCKET}/${DEST_PREFIX%/}"
fi

# Never touch dataset or API prefixes when deploying the app.
# This avoids deleting large data trees that are not part of the app build.
SYNC_EXCLUDES=(
  --exclude "*.html"
  --exclude "versioned_terminology/*"
  --exclude "versioned_value_sets/*"
  --exclude "versioned_provider_data/*"
  --exclude "reference-data/*"
  --exclude "terminology_viewer_sqlite/*"
  --exclude "api_sqlite/*"
)
# Optionally exclude local SQLite bundles in the app build unless explicitly requested.
if [[ $INCLUDE_SQLITE -ne 1 ]]; then
  SYNC_EXCLUDES+=(--exclude "data/sqlite/*")
fi
SYNC_DELETE_ARGS=(--delete)
if [[ -n "$DEST_PREFIX" ]]; then
  # Be safe when deploying under a shared prefix (preserve sibling trees like api_sqlite)
  SYNC_DELETE_ARGS=()
fi
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
  "${APP_DIR}/build/" "${DEST_BASE}/" \
  "${SYNC_DELETE_ARGS[@]}" --size-only "${SYNC_EXCLUDES[@]}"

# Upload HTML from local build explicitly to avoid size-only false negatives
echo "Uploading HTML (with cache headers) from local build to ${DEST_BASE}/"
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
  "${APP_DIR}/build/" "${DEST_BASE}/" \
  --recursive --exclude "*" --include "*.html" \
  --metadata-directive REPLACE \
  --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
  --content-type "text/html"

# Verify that all assets referenced by asset-manifest.json exist in S3
if command -v jq >/dev/null 2>&1; then
  MANIFEST_PATH="${APP_DIR}/build/asset-manifest.json"
  if [[ -f "$MANIFEST_PATH" ]]; then
    echo "Verifying uploaded assets listed in asset-manifest.json exist in S3..."
    # Collect unique list of files: entrypoints + files values
    mapfile -t MANIFEST_FILES < <(jq -r '[.entrypoints[]] + (.files | to_entries | map(.value)) | unique[]' "$MANIFEST_PATH")
    MISSING=()
    for rel in "${MANIFEST_FILES[@]}"; do
      # strip leading ./ if present
      key="${rel#./}"
      # prepend prefix if provided
      if [[ -n "$DEST_PREFIX" ]]; then
        key="${DEST_PREFIX%/}/$key"
      fi
      if ! aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
        MISSING+=("$key")
      fi
    done
    if [[ ${#MISSING[@]} -gt 0 ]]; then
      echo "ERROR: The following manifest assets are missing in s3://$BUCKET/:" >&2
      for k in "${MISSING[@]}"; do echo " - $k" >&2; done
      echo "Deployment incomplete. Please rerun or investigate upload permissions." >&2
      exit 1
    fi
  fi
fi

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
