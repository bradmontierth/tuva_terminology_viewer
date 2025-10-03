#!/usr/bin/env bash
set -euo pipefail

# Apply CORS configuration for public, cross-origin range-friendly access.
#
# Usage:
#   ./scripts/apply-s3-cors.sh [bucket-name] [--profile NAME] [--region REGION]

BUCKET="${1:-tuva-terminology-viewer}"
shift || true

AWS_PROFILE_ARG=()
AWS_REGION_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2")
      shift 2
      ;;
    --region)
      AWS_REGION_ARG=("--region" "$2")
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${SCRIPT_DIR}/s3-cors.json"

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

echo "Applying CORS from ${CONFIG_PATH} to s3://${BUCKET}"
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3api put-bucket-cors \
  --bucket "${BUCKET}" \
  --cors-configuration "file://${CONFIG_PATH}"

echo "Done."

