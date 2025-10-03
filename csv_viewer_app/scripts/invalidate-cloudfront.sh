#!/usr/bin/env bash
set -euo pipefail

# Create a CloudFront invalidation for the given distribution.
#
# Usage:
#   ./scripts/invalidate-cloudfront.sh <distribution-id> [--profile NAME]

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <distribution-id> [--profile NAME]" >&2
  exit 1
fi

DIST_ID="$1"; shift
AWS_PROFILE_ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

echo "Creating invalidation /* for distribution $DIST_ID"
aws "${AWS_PROFILE_ARG[@]}" cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*"

echo "Done."

