#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: update_terminology_indices.sh [options]

Synchronises the latest terminology CSVs from S3, builds search indexes, and uploads
the compressed index files back to S3.

Options:
  --bucket <name>           S3 bucket hosting the data (default: tuva-public-resources)
  --data-prefix <prefix>    Prefix for raw CSV folders (default: versioned_terminology)
  --index-prefix <prefix>   Prefix for index folders (default: terminology_indices)
  --versions <v...>         Explicit list of versions to refresh (default: latest plus detected newest version)
  --active-version <v>      Additional version to refresh alongside latest
  --min-rows <n>            Override row threshold passed to build-index.js
  --max-old-space-size <n>  MB of heap for Node when building indexes (default: 6144)
  --local-root <path>       Local data root (default: <repo>/data)
  --dry-run                 Show actions without executing them
  -h, --help                Show this help text

Examples:
  ./scripts/update_terminology_indices.sh --active-version 0.15.2
  ./scripts/update_terminology_indices.sh --versions latest 0.15.2 --min-rows 60000
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_SCRIPT="${REPO_ROOT}/csv_viewer_app/scripts/build-index.js"
DEFAULT_LOCAL_ROOT="${REPO_ROOT}/data"

S3_BUCKET="tuva-public-resources"
DATA_PREFIX="versioned_terminology"
INDEX_PREFIX="terminology_indices"
ACTIVE_VERSION=""
declare -a VERSIONS=()
LOCAL_ROOT="${DEFAULT_LOCAL_ROOT}"
DRY_RUN=false

MIN_ROWS_ARG=""
NODE_MAX_OLD_SPACE="6144"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      S3_BUCKET="$2"
      shift 2
      ;;
    --data-prefix)
      DATA_PREFIX="$2"
      shift 2
      ;;
    --index-prefix)
      INDEX_PREFIX="$2"
      shift 2
      ;;
    --versions)
      shift
      while [[ $# -gt 0 && $1 != --* ]]; do
        VERSIONS+=("$1")
        shift
      done
      ;;
    --active-version)
      ACTIVE_VERSION="$2"
      shift 2
      ;;
    --min-rows)
      MIN_ROWS_ARG="$2"
      shift 2
      ;;
    --max-old-space-size)
      NODE_MAX_OLD_SPACE="$2"
      shift 2
      ;;
    --local-root)
      LOCAL_ROOT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required for this script." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for this script." >&2
  exit 1
fi

if [[ ! -f "$INDEX_SCRIPT" ]]; then
  echo "Index builder not found at $INDEX_SCRIPT" >&2
  exit 1
fi

DEFAULT_MIN_ROWS=$(node -p '(() => { try { return require("./csv_viewer_app/src/config/limits.json").partialPreviewRowLimit || 50000; } catch (err) { return 50000; } })()' 2>/dev/null || echo 50000)

if [[ -z "$MIN_ROWS_ARG" ]]; then
  MIN_ROWS="$DEFAULT_MIN_ROWS"
else
  MIN_ROWS="$MIN_ROWS_ARG"
fi

if ! [[ "$MIN_ROWS" =~ ^[0-9]+$ ]]; then
  echo "--min-rows must be a non-negative integer" >&2
  exit 1
fi

if [[ -n "$NODE_MAX_OLD_SPACE" && "$NODE_MAX_OLD_SPACE" != "0" && ! "$NODE_MAX_OLD_SPACE" =~ ^[0-9]+$ ]]; then
  echo "--max-old-space-size must be a non-negative integer (use 0 to disable override)" >&2
  exit 1
fi

if [[ ${#VERSIONS[@]} -eq 0 ]]; then
  VERSIONS+=("latest")
fi

if [[ -n "$ACTIVE_VERSION" ]]; then
  VERSIONS+=("$ACTIVE_VERSION")
fi

detect_active_version() {
  local detected
  detected=$(aws s3 ls "s3://${S3_BUCKET}/${DATA_PREFIX}/" 2>/dev/null \
    | awk '/PRE / {print $2}' \
    | sed 's#/##' \
    | grep -E '^[0-9]+(\.[0-9]+)*$' \
    | sort -V \
    | tail -n1)

  echo "$detected"
}

if [[ -z "$ACTIVE_VERSION" ]]; then
  maybe_version=$(detect_active_version || true)
  if [[ -n "$maybe_version" ]]; then
    VERSIONS+=("$maybe_version")
  fi
fi

declare -A seen_versions=()
declare -a unique_versions=()
for version in "${VERSIONS[@]}"; do
  if [[ -z "$version" ]]; then
    continue
  fi
  if [[ -z "${seen_versions[$version]:-}" ]]; then
    seen_versions[$version]=1
    unique_versions+=("$version")
  fi
done

VERSIONS=("${unique_versions[@]}")

if [[ ${#VERSIONS[@]} -eq 0 ]]; then
  echo "No versions selected for processing." >&2
  exit 1
fi

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

LOCAL_DATA_DIR="${LOCAL_ROOT}/${DATA_PREFIX}"
LOCAL_INDEX_DIR="${LOCAL_ROOT}/${INDEX_PREFIX}"

mkdir -p "$LOCAL_DATA_DIR"
mkdir -p "$LOCAL_INDEX_DIR"

echo "Processing versions: ${VERSIONS[*]}"
echo "Row threshold: $MIN_ROWS"
if [[ -n "$NODE_MAX_OLD_SPACE" && "$NODE_MAX_OLD_SPACE" != "0" ]]; then
  echo "Node max old space override: ${NODE_MAX_OLD_SPACE} MB"
else
  echo "Node max old space override: disabled (Node default)"
fi

for version in "${VERSIONS[@]}"; do
  echo "\n==> Refreshing version '${version}'"

  data_source="s3://${S3_BUCKET}/${DATA_PREFIX}/${version}/"
  data_target="${LOCAL_DATA_DIR}/${version}/"
  index_target="${LOCAL_INDEX_DIR}/${version}/"
  index_destination="s3://${S3_BUCKET}/${INDEX_PREFIX}/${version}/"

  run mkdir -p "$data_target"
  run mkdir -p "$index_target"

  run aws s3 sync "$data_source" "$data_target" \
    --exclude "*.index.json" \
    --exclude "*.index.json.gz"

  NODE_CMD=(node)
  if [[ -n "$NODE_MAX_OLD_SPACE" && "$NODE_MAX_OLD_SPACE" != "0" ]]; then
    NODE_CMD+=("--max-old-space-size=${NODE_MAX_OLD_SPACE}")
  fi

  run "${NODE_CMD[@]}" "$INDEX_SCRIPT" \
    --input "$data_target" \
    --output "$index_target" \
    --min-rows "$MIN_ROWS"

  run aws s3 sync "$index_target" "$index_destination"
done

echo "\nAll requested versions have been processed."
