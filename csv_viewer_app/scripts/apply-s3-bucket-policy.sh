#!/usr/bin/env bash
set -euo pipefail

# Apply a public bucket policy that allows ListBucket (scoped to relevant prefixes)
# and GetObject for all objects. This is intended for fully public, open-source
# hosting where both the SPA and data are world-readable.
#
# Usage:
#   ./scripts/apply-s3-bucket-policy.sh [bucket-name] [--profile NAME] [--region REGION]

BUCKET="${1:-tuva-terminology-viewer}"
shift || true

AWS_PROFILE_ARG=()
AWS_REGION_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region)
      AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

TMP_JSON=$(mktemp)
trap 'rm -f "$TMP_JSON"' EXIT

cat > "$TMP_JSON" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowListBucketForViewerPrefixes",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::$BUCKET",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "versioned_terminology/*",
            "versioned_provider_data/*",
            "versioned_value_sets/*",
            "reference-data/*",
            "terminology_viewer_sqlite/*",
            "index.html",
            "static/*",
            "asset-manifest.json",
            "favicon.ico"
          ]
        }
      }
    },
    {
      "Sid": "AllowGetObjectPublic",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*"
    }
  ]
}
JSON

echo "Applying public bucket policy to s3://$BUCKET"
aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" s3api put-bucket-policy \
  --bucket "$BUCKET" \
  --policy "file://$TMP_JSON"

echo "Done."

