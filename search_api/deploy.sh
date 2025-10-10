#!/usr/bin/env bash
set -euo pipefail

# Wrapper around SAM build/deploy for the Search API.
#
# Usage:
#   search_api/deploy.sh --bucket tuva-terminology-viewer [--stack TuvaSearchApi] \
#     [--profile NAME] [--region REGION] [--prefix api_sqlite] [--allow-origins https://your.site]

STACK_NAME="TuvaSearchApi"
SQLITE_BUCKET=""
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
S3_PREFIX="api_sqlite"
ALLOW_ORIGIN="*"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --bucket) SQLITE_BUCKET="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region) AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --prefix) S3_PREFIX="$2"; shift 2 ;;
    --allow-origins) ALLOW_ORIGIN="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SQLITE_BUCKET" ]]; then
  echo "--bucket is required (S3 bucket holding <dataset>.sqlite)" >&2
  exit 1
fi

command -v sam >/dev/null 2>&1 || { echo "AWS SAM CLI is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pushd "$SCRIPT_DIR" >/dev/null

echo "Building SAM package..."
sam build "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "Deploying stack ${STACK_NAME} ..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --parameter-overrides SqliteBucket="$SQLITE_BUCKET" \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

echo "Updating environment variables (S3_PREFIX=${S3_PREFIX}, CORS_ALLOW_ORIGIN=${ALLOW_ORIGIN}) ..."
FUNC_NAME=$(aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" cloudformation describe-stack-resources --stack-name "$STACK_NAME" \
  --query 'StackResources[?LogicalResourceId==`SearchFunction`].PhysicalResourceId' --output text)

aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" lambda update-function-configuration \
  --function-name "$FUNC_NAME" \
  --environment "Variables={S3_BUCKET=${SQLITE_BUCKET},S3_PREFIX=${S3_PREFIX},CORS_ALLOW_ORIGIN=${ALLOW_ORIGIN}}" >/dev/null

API_URL=$(aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

popd >/dev/null
echo "Deployed. API URL: ${API_URL}"

