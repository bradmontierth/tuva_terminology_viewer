#!/usr/bin/env bash
set -euo pipefail

# One-off cross-bucket sync for the viewer.
# - Fully sync non-versioned prefixes
# - For versioned prefixes, fully sync 'latest' and the last N versions
# - For older versions, only copy objects smaller than a size threshold
#
# Usage:
#   ./scripts/s3-sync-from-public.sh [target-bucket]
#     [--src BUCKET]
#     [--profile NAME]
#     [--region REGION]
#     [--large-threshold-mb N]   # default 20
#     [--large-limit N]          # default 2 (latest N versions fully)
#     [--no-large-latest]        # do not sync 'latest' alias fully
#     [--jobs N]                 # parallel small-file copies (default 16)
#     [--no-size-only]           # don't use --size-only on sync (stricter but slower)

TARGET_BUCKET="${1:-tuva-terminology-viewer}"
shift || true

SRC_BUCKET="tuva-public-resources"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
LARGE_THRESHOLD_MB=20
LARGE_LIMIT=2
INCLUDE_LATEST_FOR_LARGE=1
SMALL_COPY_JOBS=16
USE_SIZE_ONLY=1
INCLUDE_REMOTE_SQLITE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src)
      SRC_BUCKET="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --large-threshold-mb)
      LARGE_THRESHOLD_MB="$2"; shift 2 ;;
    --large-limit)
      LARGE_LIMIT="$2"; shift 2 ;;
    --no-large-latest)
      INCLUDE_LATEST_FOR_LARGE=0; shift 1 ;;
    --jobs)
      SMALL_COPY_JOBS="$2"; shift 2 ;;
    --no-size-only)
      USE_SIZE_ONLY=0; shift 1 ;;
    --include-remote-sqlite)
      INCLUDE_REMOTE_SQLITE=1; shift 1 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

to_bytes() { # MB -> bytes
  local mb="$1"
  echo $(( mb * 1024 * 1024 ))
}

sync_full_prefix() {
  local prefix="$1"
  echo "Syncing s3://${SRC_BUCKET}/${prefix} -> s3://${TARGET_BUCKET}/${prefix}"
  local extra=( )
  if [[ "$prefix" == "reference-data" ]]; then
    # Skip heavy shapefiles not needed by the viewer
    extra+=(--exclude "2022 Census Shapefiles/*")
  fi
  local sizeonly=( )
  if (( USE_SIZE_ONLY )); then sizeonly+=(--size-only); fi
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
    "s3://${SRC_BUCKET}/${prefix}" \
    "s3://${TARGET_BUCKET}/${prefix}" \
    --delete "${extra[@]}" "${sizeonly[@]}"
}

list_versions() {
  local prefix="$1"
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 ls "s3://${SRC_BUCKET}/${prefix}/" \
    | awk '/PRE/ {print $2}' | sed 's:/$::'
}

sync_version_fully() {
  local prefix="$1" ver="$2"
  echo "Syncing s3://${SRC_BUCKET}/${prefix}/${ver} -> s3://${TARGET_BUCKET}/${prefix}/${ver}"
  local sizeonly=( )
  if (( USE_SIZE_ONLY )); then sizeonly+=(--size-only); fi
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
    "s3://${SRC_BUCKET}/${prefix}/${ver}" \
    "s3://${TARGET_BUCKET}/${prefix}/${ver}" \
    --delete "${sizeonly[@]}"
}

copy_small_only_for_version() {
  local prefix="$1" ver="$2" threshold_bytes="$3"
  local src_uri="s3://${SRC_BUCKET}/${prefix}/${ver}/"
  echo "Copying small objects (< ${threshold_bytes} bytes) for ${src_uri} with ${SMALL_COPY_JOBS} parallel jobs"

  # Build list of keys under this version smaller than threshold
  local tmp_keys
  tmp_keys=$(mktemp)
  trap 'rm -f "${tmp_keys}"' RETURN

  # Prefer s3api with server-side filtering; falls back to s3 ls if needed
  if aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3api list-objects-v2 \
      --bucket "${SRC_BUCKET}" \
      --prefix "${prefix}/${ver}/" \
      --query "Contents[?Size < \`${threshold_bytes}\`].[Key]" \
      --output text > "${tmp_keys}" 2>/dev/null; then
    :
  else
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 ls "${src_uri}" --recursive \
      | awk -v threshold="${threshold_bytes}" '{
          size=$3; if (size+0 < threshold) {
            key=$4; for (i=5; i<=NF; i++) key=key" "$i; print key;
          }
        }' > "${tmp_keys}"
  fi

  if [[ ! -s "${tmp_keys}" ]]; then
    echo "No small objects to copy for ${src_uri}"
    return 0
  fi

  # Parallel copy with a simple concurrency limiter
  local active=0
  while IFS= read -r key; do
    (
      aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
        "s3://${SRC_BUCKET}/${key}" \
        "s3://${TARGET_BUCKET}/${key}" \
        --only-show-errors
    ) &
    active=$((active+1))
    if (( active >= SMALL_COPY_JOBS )); then
      # Wait for any job to finish
      wait -n
      active=$((active-1))
    fi
  done < "${tmp_keys}"

  # Wait for all remaining jobs
  wait
}

FULL_PREFIXES=(
  versioned_terminology
  versioned_value_sets
)

NON_VERSIONED_PREFIXES=(
  reference-data
)

# 1) Sync non-versioned prefixes fully
for p in "${NON_VERSIONED_PREFIXES[@]}"; do
  sync_full_prefix "$p"
done

# Optionally sync published SQLite bundles (legacy layout)
if [[ $INCLUDE_REMOTE_SQLITE -eq 1 ]]; then
  sync_full_prefix "terminology_viewer_sqlite"
fi

# 2) Fully sync versioned_terminology and versioned_value_sets
for p in "${FULL_PREFIXES[@]}"; do
  sync_full_prefix "$p"
done

# 3) Sync provider data with large-file limiting
threshold_bytes=$(to_bytes "$LARGE_THRESHOLD_MB")
p="versioned_provider_data"
echo "Processing provider prefix: ${p} (large threshold: ${LARGE_THRESHOLD_MB}MB, limit: ${LARGE_LIMIT})"

mapfile -t vdirs < <(list_versions "$p")
has_latest=0
versions=()
for d in "${vdirs[@]}"; do
  if [[ "$d" == "latest" ]]; then
    has_latest=1
  else
    versions+=("$d")
  fi
done

# Sort versions and pick last N
mapfile -t sorted < <(printf '%s\n' "${versions[@]}" | sort -V)
if [[ ${#sorted[@]} -gt $LARGE_LIMIT ]]; then
  start=$(( ${#sorted[@]} - LARGE_LIMIT ))
else
  start=0
fi
mapfile -t selected < <(printf '%s\n' "${sorted[@]:$start}")

# Always sync latest alias fully if requested
if [[ $INCLUDE_LATEST_FOR_LARGE -eq 1 && $has_latest -eq 1 ]]; then
  sync_version_fully "$p" latest
fi

# Fully sync the last N versions
for v in "${selected[@]}"; do
  sync_version_fully "$p" "$v"
done

# For the older versions, copy only small objects
mapfile -t older < <(printf '%s\n' "${sorted[@]:0:$start}")
for v in "${older[@]}"; do
  copy_small_only_for_version "$p" "$v" "$threshold_bytes"
done

echo "Sync complete."
