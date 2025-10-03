#!/usr/bin/env bash
set -euo pipefail

# Publish previously built viewer assets (crosswalks + SQLite bundles)
# to a destination bucket and optionally invalidate CloudFront.
#
# Usage:
#   ./scripts/publish-assets.sh --dest-bucket tuva-terminology-viewer [--profile NAME] [--region REGION] [--cf-dist-id ID]

DEST_BUCKET=""
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
CF_DIST_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest-bucket)
      DEST_BUCKET="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --cf-dist-id)
      CF_DIST_ID="$2"; shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEST_BUCKET" ]]; then
  echo "--dest-bucket is required" >&2
  exit 1
fi

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR%/scripts}"

pushd "$APP_DIR" >/dev/null

# Crosswalks
if [[ -f "public/data/header-crosswalk.json" ]]; then
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
    "public/data/header-crosswalk.json" \
    "s3://${DEST_BUCKET}/data/header-crosswalk.json" \
    --metadata-directive REPLACE \
    --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
    --content-type "application/json"
fi
if [[ -f "public/data/file-identity-crosswalk.json" ]]; then
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
    "public/data/file-identity-crosswalk.json" \
    "s3://${DEST_BUCKET}/data/file-identity-crosswalk.json" \
    --metadata-directive REPLACE \
    --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
    --content-type "application/json"
fi

# SQLite bundles
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
  "public/data/sqlite/" \
  "s3://${DEST_BUCKET}/data/sqlite/" \
  --delete --size-only

# Optional CF invalidation
if [[ -n "$CF_DIST_ID" ]]; then
  aws "${AWS_PROFILE_ARG[@]}" cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/data/header-crosswalk.json" "/data/sqlite/datasets.json" "/data/sqlite/*"
fi

popd >/dev/null
echo "Publish complete."

