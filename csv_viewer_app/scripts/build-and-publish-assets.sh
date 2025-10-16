#!/usr/bin/env bash
set -euo pipefail

# Build all viewer assets locally (header crosswalk, identity crosswalk, SQLite bundles)
# and publish to a single destination bucket. Optionally sync latest CSV inputs
# from a source bucket to local data/ before building.
#
# Usage:
#   ./scripts/build-and-publish-assets.sh \
#     --dest-bucket tuva-terminology-viewer \
#     [--src-bucket tuva-public-resources] \
#     [--versions latest,0.15.3] \
#     [--profile NAME] [--region REGION] \
#     [--identity-base-url https://tuva-public-resources.s3.amazonaws.com] \
#     [--prefix terminology-viewer] \
#     [--skip-input-sync] [--skip-crosswalk] [--skip-identity] [--skip-sqlite] \
#     [--single-shard]
#     [--cf-dist-id DIST_ID]
#
# Notes:
# - By default, pulls CSVs for the listed versions from the source bucket to
#   local data/ before building. Use --skip-input-sync to build from whatever
#   is already present locally.
# - By default, versions=latest. Provide a comma-separated list to process
#   multiple versions.
# - Identity crosswalk will use --identity-base-url if provided; otherwise it
#   defaults to the src bucket's HTTPS endpoint.

DEST_BUCKET=""
SRC_BUCKET="tuva-public-resources"
VERSIONS="latest"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
CF_DIST_ID=""
IDENTITY_BASE_URL=""
PREFIX=""
DO_SYNC_INPUTS=1
DO_CROSSWALK=1
DO_IDENTITY=1
DO_SQLITE=1
FORCE_SINGLE_SHARD=1
SKIP_SHARDS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest-bucket)
      DEST_BUCKET="$2"; shift 2 ;;
    --src-bucket)
      SRC_BUCKET="$2"; shift 2 ;;
    --versions)
      VERSIONS="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --cf-dist-id)
      CF_DIST_ID="$2"; shift 2 ;;
    --identity-base-url)
      IDENTITY_BASE_URL="$2"; shift 2 ;;
    --prefix)
      PREFIX="$2"; shift 2 ;;
    --skip-shards)
      SKIP_SHARDS=1; shift 1 ;;
    --skip-input-sync)
      DO_SYNC_INPUTS=0; shift 1 ;;
    --skip-crosswalk)
      DO_CROSSWALK=0; shift 1 ;;
    --skip-identity)
      DO_IDENTITY=0; shift 1 ;;
    --skip-sqlite)
      DO_SQLITE=0; shift 1 ;;
    --single-shard)
      FORCE_SINGLE_SHARD=1; shift 1 ;;
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
REPO_ROOT="${APP_DIR}"

# 1) Optionally sync CSV inputs from source bucket to local data/
if [[ $DO_SYNC_INPUTS -eq 1 ]]; then
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  # Resolve 'latest' to latest published tag when crosswalk exists or can be generated
  PUBLISHED_LATEST=""
  if [[ -f "public/data/header-crosswalk.json" ]]; then
    PUBLISHED_LATEST=$(node -e 'try{const f=require("./public/data/header-crosswalk.json");console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}')
  else
    echo "Generating header crosswalk to resolve published latest..."
    npm run generate:crosswalk || true
    if [[ -f "public/data/header-crosswalk.json" ]]; then
      PUBLISHED_LATEST=$(node -e 'try{const f=require("./public/data/header-crosswalk.json");console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}')
    fi
  fi
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    if [[ -z "$VER_TRIMMED" ]]; then continue; fi
    if [[ "$VER_TRIMMED" == "latest" && -n "$PUBLISHED_LATEST" ]]; then
      VER_TRIMMED="$PUBLISHED_LATEST"
    fi
    echo "Syncing inputs for version: $VER_TRIMMED"
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
      "s3://${SRC_BUCKET}/versioned_terminology/${VER_TRIMMED}/" \
      "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}/" \
      --size-only
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

# 2) Generate header crosswalk (from Tuva repo tags)
if [[ $DO_CROSSWALK -eq 1 ]]; then
  echo "Generating header crosswalk..."
  npm run generate:crosswalk
fi

# 3) Generate identity crosswalk (S3 listings)
if [[ $DO_IDENTITY -eq 1 ]]; then
  BASE_URL="$IDENTITY_BASE_URL"
  if [[ -z "$BASE_URL" ]]; then
    BASE_URL="https://${SRC_BUCKET}.s3.amazonaws.com"
  fi
  echo "Generating identity crosswalk (base: $BASE_URL) ..."
  TUVA_DATA_BASE_URL="$BASE_URL" node scripts/generateFileIdentityCrosswalk.js
fi

# 4) Build SQLite bundles for all requested versions
if [[ $DO_SQLITE -eq 1 ]]; then
  # Resolve 'latest' to the latest published tag from header-crosswalk, if available
  PUBLISHED_LATEST=""
  if [[ -f "public/data/header-crosswalk.json" ]]; then
    PUBLISHED_LATEST=$(node -e 'try{const f=require("./public/data/header-crosswalk.json");console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("");}')
  fi
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  # If identity file exists, pass it through to embed sourceIdentity in manifests
  IDENTITY_JSON=""
  if [[ -f "public/data/file-identity-crosswalk.json" ]]; then
    IDENTITY_JSON="public/data/file-identity-crosswalk.json"
  fi
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    if [[ -z "$VER_TRIMMED" ]]; then continue; fi
    if [[ "$VER_TRIMMED" == "latest" && -n "$PUBLISHED_LATEST" ]]; then
      VER_TRIMMED="$PUBLISHED_LATEST"
    fi
    echo "Building SQLite bundles for version: $VER_TRIMMED"$([[ $FORCE_SINGLE_SHARD -eq 1 ]] && echo " (single-shard)")
    if [[ -n "$IDENTITY_JSON" ]]; then
      npm run build:sqlite:batch -- \
        $([[ $FORCE_SINGLE_SHARD -eq 1 ]] && echo "--shard-count 1") \
        --identity-json "$IDENTITY_JSON" \
        "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}" \
        "${REPO_ROOT}/../data/versioned_value_sets/${VER_TRIMMED}" \
        "${REPO_ROOT}/../data/versioned_provider_data/${VER_TRIMMED}" || true
    else
      npm run build:sqlite:batch -- \
        $([[ $FORCE_SINGLE_SHARD -eq 1 ]] && echo "--shard-count 1") \
        "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}" \
        "${REPO_ROOT}/../data/versioned_value_sets/${VER_TRIMMED}" \
        "${REPO_ROOT}/../data/versioned_provider_data/${VER_TRIMMED}" || true
    fi
  done
fi

# 5) Publish crosswalks and SQLite bundles to destination bucket
DEST_BASE="s3://${DEST_BUCKET}"
if [[ -n "$PREFIX" ]]; then
  DEST_BASE="s3://${DEST_BUCKET}/${PREFIX%/}"
fi
echo "Publishing assets to ${DEST_BASE} ..."
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
  "public/data/header-crosswalk.json" \
  "${DEST_BASE}/data/header-crosswalk.json" \
  --metadata-directive REPLACE \
  --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
  --content-type "application/json"

if [[ -f "public/data/file-identity-crosswalk.json" ]]; then
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 cp \
    "public/data/file-identity-crosswalk.json" \
    "${DEST_BASE}/data/file-identity-crosswalk.json" \
    --metadata-directive REPLACE \
    --cache-control "max-age=0, s-maxage=0, no-cache, no-store, must-revalidate" \
    --content-type "application/json"
fi

SQLITE_SYNC_EXCLUDES=()
if [[ $SKIP_SHARDS -eq 1 ]]; then
  SQLITE_SYNC_EXCLUDES=(--exclude "*.sqlite" --exclude "*.routing.json")
fi
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
  "public/data/sqlite/" \
  "${DEST_BASE}/data/sqlite/" \
  --delete --size-only "${SQLITE_SYNC_EXCLUDES[@]}"

# 6) Optional CloudFront invalidation
if [[ -n "$CF_DIST_ID" ]]; then
  echo "Creating CloudFront invalidation for distribution $CF_DIST_ID"
  PREF=""
  if [[ -n "$PREFIX" ]]; then PREF="/${PREFIX%/}"; fi
  aws "${AWS_PROFILE_ARG[@]}" cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "${PREF}/data/header-crosswalk.json" "${PREF}/data/sqlite/datasets.json" "${PREF}/data/sqlite/*"
fi

popd >/dev/null
echo "Done."
