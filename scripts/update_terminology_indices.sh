#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: update_terminology_indices.sh [options]

Synchronises S3 data folders, builds search indexes for the Tuva terminology viewer,
and uploads the compressed index files back to S3.

Options:
  --bucket <name>              S3 bucket hosting the data (default: tuva-public-resources)
  --data-prefix <prefix>       Terminology data prefix (default: versioned_terminology)
  --index-prefix <prefix>      Terminology index prefix (default: terminology_indices)
  --provider-prefix <prefix>   Provider data prefix (default: versioned_provider_data)
  --provider-index <prefix>    Provider index prefix (default: provider_indices)
  --value-sets-prefix <prefix> Value sets data prefix (default: versioned_value_sets)
  --value-sets-index <prefix>  Value sets index prefix (default: value_set_indices)
  --reference-prefix <prefix>  Reference data prefix (default: reference-data)
  --reference-index <prefix>   Reference data index prefix (default: reference_data_indices)
  --targets <list>             Comma separated dataset ids to process (terminology,provider,value-sets,reference)
  --versions <v...>            Explicit versions to process for versioned datasets (default: latest plus detected newest)
  --active-version <v>         Extra version to include alongside latest (terminology only shortcut)
  --min-rows <n>               Override row threshold passed to build-index.js
  --max-old-space-size <n>     MB of heap for Node when building indexes (default: 6144, 0 disables override)
  --local-root <path>          Local cache root (default: <repo>/data)
  --dry-run                    Show actions without executing them
  -h, --help                   Show this help text

Examples:
  ./scripts/update_terminology_indices.sh --active-version 0.15.2
  ./scripts/update_terminology_indices.sh --targets terminology,value-sets --versions latest 0.15.2
USAGE
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_SCRIPT="${REPO_ROOT}/csv_viewer_app/scripts/build-index.js"
DEFAULT_LOCAL_ROOT="${REPO_ROOT}/data"

S3_BUCKET="tuva-public-resources"
TERMINOLOGY_PREFIX="versioned_terminology"
TERMINOLOGY_INDEX_PREFIX="terminology_indices"
PROVIDER_PREFIX="versioned_provider_data"
PROVIDER_INDEX_PREFIX="provider_indices"
VALUE_SETS_PREFIX="versioned_value_sets"
VALUE_SETS_INDEX_PREFIX="value_set_indices"
REFERENCE_PREFIX="reference-data"
REFERENCE_INDEX_PREFIX="reference_data_indices"
ACTIVE_VERSION=""
declare -a VERSIONS=()
LOCAL_ROOT="${DEFAULT_LOCAL_ROOT}"
DRY_RUN=false
MIN_ROWS_ARG=""
NODE_MAX_OLD_SPACE="6144"
declare -a DATASET_FILTER=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      S3_BUCKET="$2"
      shift 2
      ;;
    --data-prefix)
      TERMINOLOGY_PREFIX="$2"
      shift 2
      ;;
    --index-prefix)
      TERMINOLOGY_INDEX_PREFIX="$2"
      shift 2
      ;;
    --provider-prefix)
      PROVIDER_PREFIX="$2"
      shift 2
      ;;
    --provider-index)
      PROVIDER_INDEX_PREFIX="$2"
      shift 2
      ;;
    --value-sets-prefix)
      VALUE_SETS_PREFIX="$2"
      shift 2
      ;;
    --value-sets-index)
      VALUE_SETS_INDEX_PREFIX="$2"
      shift 2
      ;;
    --reference-prefix)
      REFERENCE_PREFIX="$2"
      shift 2
      ;;
    --reference-index)
      REFERENCE_INDEX_PREFIX="$2"
      shift 2
      ;;
    --targets)
      IFS=',' read -r -a DATASET_FILTER <<< "$2"
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

# Normalise dataset filters to a set for quick lookup
if [[ ${#DATASET_FILTER[@]} -gt 0 ]]; then
  declare -A DATASET_ALLOW=()
  for id in "${DATASET_FILTER[@]}"; do
    DATASET_ALLOW["${id}"]=1
  done
else
  declare -A DATASET_ALLOW=()
fi

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

NODE_CMD=(node)
if [[ -n "$NODE_MAX_OLD_SPACE" && "$NODE_MAX_OLD_SPACE" != "0" ]]; then
  NODE_CMD+=("--max-old-space-size=${NODE_MAX_OLD_SPACE}")
fi

normalize_version_list() {
  declare -A seen=()
  declare -a unique=()
  for version in "$@"; do
    if [[ -z "$version" ]]; then
      continue
    fi
    if [[ -z "${seen[$version]:-}" ]]; then
      seen[$version]=1
      unique+=("$version")
    fi
  done
  printf '%s\n' "${unique[@]}"
}

detect_active_version_for_prefix() {
  local prefix="$1"
  aws s3 ls "s3://${S3_BUCKET}/${prefix}/" 2>/dev/null \
    | awk '/PRE / {print $2}' \
    | sed 's#/##' \
    | grep -E '^[0-9]+(\.[0-9]+)*$' \
    | sort -V \
    | tail -n1
}

source_exists() {
  local s3_path="$1"
  aws s3 ls "$s3_path" >/dev/null 2>&1
}

process_versioned_dataset() {
  local dataset_id="$1"
  local data_prefix="$2"
  local index_prefix="$3"
  shift 3
  local versions=()

  if [[ "$dataset_id" == "terminology" && ${#VERSIONS[@]} -gt 0 ]]; then
    versions=("${VERSIONS[@]}")
  else
    versions+=("latest")
  fi

  if [[ "$dataset_id" == "terminology" && -n "$ACTIVE_VERSION" ]]; then
    versions+=("$ACTIVE_VERSION")
  fi

  local detected
  detected=$(detect_active_version_for_prefix "$data_prefix" || true)
  if [[ -n "$detected" ]]; then
    versions+=("$detected")
  fi

  mapfile -t versions < <(normalize_version_list "${versions[@]}")

  if [[ ${#versions[@]} -eq 0 ]]; then
    echo "Skipping ${dataset_id}: no versions found." >&2
    return
  fi

  for version in "${versions[@]}"; do
    echo "\n==> [${dataset_id}] Refreshing version '${version}'"
    local source="s3://${S3_BUCKET}/${data_prefix}/${version}/"
    if [[ "$version" == "latest" ]]; then
      source="s3://${S3_BUCKET}/${data_prefix}/latest/"
    fi

    if ! source_exists "$source"; then
      echo "   • Source ${source} not found, skipping." >&2
      continue
    fi

    local data_target="${LOCAL_ROOT}/${data_prefix}/${version}/"
    local index_target="${LOCAL_ROOT}/${index_prefix}/${version}/"
    local index_destination="s3://${S3_BUCKET}/${index_prefix}/${version}/"

    run mkdir -p "$data_target"
    run mkdir -p "$index_target"

    run aws s3 sync "$source" "$data_target" \
      --exclude "*.index.json" \
      --exclude "*.index.json.gz"

    run "${NODE_CMD[@]}" "$INDEX_SCRIPT" \
      --input "$data_target" \
      --output "$index_target" \
      --min-rows "$MIN_ROWS"

    run aws s3 sync "$index_target" "$index_destination"
  done
}

process_unversioned_dataset() {
  local dataset_id="$1"
  local data_prefix="$2"
  local index_prefix="$3"

  echo "\n==> [${dataset_id}] Refreshing unversioned dataset"

  local source="s3://${S3_BUCKET}/${data_prefix}/"
  if ! source_exists "$source"; then
    echo "   • Source ${source} not found, skipping." >&2
    return
  fi

  local data_target="${LOCAL_ROOT}/${data_prefix}/"
  local index_target="${LOCAL_ROOT}/${index_prefix}/"
  local index_destination="s3://${S3_BUCKET}/${index_prefix}/"

  run mkdir -p "$data_target"
  run mkdir -p "$index_target"

  run aws s3 sync "$source" "$data_target" \
    --exclude "*.index.json" \
    --exclude "*.index.json.gz"

  run "${NODE_CMD[@]}" "$INDEX_SCRIPT" \
    --input "$data_target" \
    --output "$index_target" \
    --min-rows "$MIN_ROWS"

  run aws s3 sync "$index_target" "$index_destination"
}

DATASET_CONFIGS=(
  "terminology:${TERMINOLOGY_PREFIX}:${TERMINOLOGY_INDEX_PREFIX}:versioned"
  "provider:${PROVIDER_PREFIX}:${PROVIDER_INDEX_PREFIX}:versioned"
  "value-sets:${VALUE_SETS_PREFIX}:${VALUE_SETS_INDEX_PREFIX}:versioned"
  "reference:${REFERENCE_PREFIX}:${REFERENCE_INDEX_PREFIX}:unversioned"
)

echo "Row threshold: $MIN_ROWS"
if [[ -n "$NODE_MAX_OLD_SPACE" && "$NODE_MAX_OLD_SPACE" != "0" ]]; then
  echo "Node max old space override: ${NODE_MAX_OLD_SPACE} MB"
else
  echo "Node max old space override: disabled (Node default)"
fi

for config in "${DATASET_CONFIGS[@]}"; do
  IFS=':' read -r dataset_id data_prefix index_prefix dataset_type <<< "$config"

  if [[ ${#DATASET_FILTER[@]} -gt 0 && -z "${DATASET_ALLOW[$dataset_id]:-}" ]]; then
    continue
  fi

  if [[ "$dataset_type" == "versioned" ]]; then
    process_versioned_dataset "$dataset_id" "$data_prefix" "$index_prefix"
  else
    process_unversioned_dataset "$dataset_id" "$data_prefix" "$index_prefix"
  fi
 done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "\nDry-run completed."
else
  echo "\nAll requested datasets have been processed."
fi
