#!/usr/bin/env bash
set -euo pipefail

# Publish single-shard API SQLite files to an S3 prefix used by the Lambda API.
#
# Usage:
#   ./scripts/publish-api-sqlite.sh --dest-bucket tuva-terminology-viewer \
#     [--prefix api_sqlite] [--datasets ndc,providers] [--profile NAME] [--region REGION]
#

DEST_BUCKET=""
PREFIX="api_sqlite"
DATASETS=""
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest-bucket)
      DEST_BUCKET="$2"; shift 2 ;;
    --prefix)
      PREFIX="$2"; shift 2 ;;
    --datasets)
      DATASETS="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEST_BUCKET" ]]; then
  echo "--dest-bucket is required" >&2
  exit 1
fi

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR%/scripts}"

publish_one() {
  local dataset="$1"
  local src="${APP_DIR}/public/data/sqlite/${dataset}/${dataset}.sqlite"
  if [[ ! -f "$src" ]]; then
    echo "Skipping ${dataset}: ${src} not found (ensure --shard-count 1 build)" >&2
    return 0
  fi
  local dst="s3://${DEST_BUCKET}/${PREFIX}/${dataset}.sqlite"
  echo "Uploading ${src} -> ${dst}"
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp "$src" "$dst" \
    --metadata-directive REPLACE \
    --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
    --content-type "application/vnd.sqlite3"
}

if [[ -n "$DATASETS" ]]; then
  IFS=',' read -r -a ds <<< "$DATASETS"
  for d in "${ds[@]}"; do
    d_trimmed="${d//[[:space:]]/}"
    [[ -z "$d_trimmed" ]] && continue
    publish_one "$d_trimmed"
  done
else
  # Auto-detect datasets with single-shard sqlite present
  while IFS= read -r -d '' dir; do
    name="$(basename "$dir")"
    if [[ -f "${dir}/${name}.sqlite" ]]; then
      publish_one "$name"
    fi
  done < <(find "${APP_DIR}/public/data/sqlite" -mindepth 1 -maxdepth 1 -type d -print0)
fi

echo "Done."

