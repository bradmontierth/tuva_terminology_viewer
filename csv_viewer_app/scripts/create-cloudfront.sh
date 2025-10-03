#!/usr/bin/env bash
set -euo pipefail

# Create a CloudFront distribution for serving the SPA (HTTPS),
# with SPA routing (403/404 -> /index.html) and redirect-to-https.
#
# Usage:
#   ./scripts/create-cloudfront.sh [bucket-name] [--profile NAME]
#
# Prints the DistributionId and DomainName on success.

BUCKET="${1:-tuva-terminology-viewer}"
shift || true

AWS_PROFILE_ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

# Resolve bucket region and origin domain
REGION=$(aws "${AWS_PROFILE_ARG[@]}" s3api get-bucket-location --bucket "$BUCKET" --query 'LocationConstraint' --output text)
if [[ "$REGION" == "None" || "$REGION" == "null" ]]; then REGION="us-east-1"; fi
ORIGIN_DOMAIN="$BUCKET.s3.$REGION.amazonaws.com"

CALLER_REF="spa-$(date +%s)"

CF_CFG=$(mktemp)
trap 'rm -f "$CF_CFG"' EXIT

cat > "$CF_CFG" <<JSON
{
  "CallerReference": "$CALLER_REF",
  "Comment": "SPA for $BUCKET",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "spa-origin",
        "DomainName": "$ORIGIN_DOMAIN",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "spa-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": true,
    "ForwardedValues": {
      "QueryString": false,
      "Cookies": { "Forward": "none" }
    },
    "MinTTL": 0,
    "DefaultTTL": 86400,
    "MaxTTL": 31536000
  },
  "CustomErrorResponses": {
    "Quantity": 2,
    "Items": [
      { "ErrorCode": 403, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 0 },
      { "ErrorCode": 404, "ResponsePagePath": "/index.html", "ResponseCode": "200", "ErrorCachingMinTTL": 0 }
    ]
  },
  "PriceClass": "PriceClass_100",
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } }
}
JSON

echo "Creating CloudFront distribution for origin: $ORIGIN_DOMAIN"
aws "${AWS_PROFILE_ARG[@]}" cloudfront create-distribution \
  --distribution-config file://"$CF_CFG" \
  --query 'Distribution.{Id:Id,DomainName:DomainName}' \
  --output text
