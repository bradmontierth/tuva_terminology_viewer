#!/usr/bin/env bash
set -euo pipefail

# Sync CSV inputs from S3 to local data/, build crosswalks and SQLite bundles,
# then start the dev server on localhost.
#
# Usage:
#   ./scripts/local-build-and-serve.sh \
#     [--src-bucket tuva-public-resources] \
#     [--versions latest,0.15.3] \
#     [--profile NAME] [--region REGION] \
#     [--identity-base-url https://tuva-public-resources.s3.amazonaws.com] \
#     [--skip-input-sync] [--skip-crosswalk] [--skip-identity] [--skip-sqlite]

SRC_BUCKET="tuva-public-resources"
VERSIONS="latest"
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
IDENTITY_BASE_URL=""
DO_SYNC_INPUTS=1
DO_CROSSWALK=1
DO_IDENTITY=1
DO_SQLITE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-bucket)
      SRC_BUCKET="$2"; shift 2 ;;
    --versions)
      VERSIONS="$2"; shift 2 ;;
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --identity-base-url)
      IDENTITY_BASE_URL="$2"; shift 2 ;;
    --skip-input-sync)
      DO_SYNC_INPUTS=0; shift 1 ;;
    --skip-crosswalk)
      DO_CROSSWALK=0; shift 1 ;;
    --skip-identity)
      DO_IDENTITY=0; shift 1 ;;
    --skip-sqlite)
      DO_SQLITE=0; shift 1 ;;
    *)
      echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR%/scripts}"
REPO_ROOT="${APP_DIR}"

if [[ $DO_SYNC_INPUTS -eq 1 ]]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required for input sync" >&2; exit 1; }
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    [[ -z "$VER_TRIMMED" ]] && continue
    echo "Syncing inputs for version: $VER_TRIMMED"
    aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3 sync \
      "s3://${SRC_BUCKET}/versioned_terminology/${VER_TRIMMED}/" \
      "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}/" \
      --size-only || true
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

if [[ $DO_CROSSWALK -eq 1 ]]; then
  echo "Generating header crosswalk..."
  npm run generate:crosswalk
fi

if [[ $DO_IDENTITY -eq 1 ]]; then
  BASE_URL="$IDENTITY_BASE_URL"
  if [[ -z "$BASE_URL" ]]; then
    BASE_URL="https://${SRC_BUCKET}.s3.amazonaws.com"
  fi
  echo "Generating identity crosswalk (base: $BASE_URL) ..."
  TUVA_DATA_BASE_URL="$BASE_URL" node scripts/generateFileIdentityCrosswalk.js
fi

if [[ $DO_SQLITE -eq 1 ]]; then
  IFS=',' read -r -a VER_LIST <<< "$VERSIONS"
  for VER in "${VER_LIST[@]}"; do
    VER_TRIMMED="${VER//[[:space:]]/}"
    [[ -z "$VER_TRIMMED" ]] && continue
    echo "Building SQLite bundles for version: $VER_TRIMMED"
    npm run build:sqlite:batch -- \
      "${REPO_ROOT}/../data/versioned_terminology/${VER_TRIMMED}" \
      "${REPO_ROOT}/../data/versioned_value_sets/${VER_TRIMMED}" \
      "${REPO_ROOT}/../data/versioned_provider_data/${VER_TRIMMED}" || true
  done
fi

echo "Starting dev server (fetch crosswalks, SW disabled for smoother testing)..."
REACT_APP_FETCH_CROSSWALKS=true \
REACT_APP_DISABLE_SQLITE_SW=1 \
npm start

popd >/dev/null

