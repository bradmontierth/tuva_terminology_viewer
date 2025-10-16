#!/usr/bin/env bash
set -euo pipefail

# Wrapper around SAM build/deploy for the Search API.
#
# Usage:
#   search_api/deploy.sh --bucket tuva-terminology-viewer [--stack TuvaSearchApi] \
#     [--profile NAME] [--region REGION] [--prefix api_sqlite] [--allow-origins https://your.site] \
#     --efs-ap-arn arn:aws:elasticfilesystem:...:access-point/fsap-123 \
#     --subnet-ids subnet-aaa,subnet-bbb --sg-ids sg-xxx \
#     [--provisioned 1] [--efs-mount-path /mnt/efs] [--efs-sqlite-dir /mnt/efs] [--use-container]

STACK_NAME="TuvaSearchApi"
SQLITE_BUCKET=""
AWS_PROFILE_ARG=()
AWS_REGION_ARG=()
S3_PREFIX="api_sqlite"
ALLOW_ORIGIN="*"
EFS_AP_ARN=""
SUBNET_IDS=""
SG_IDS=""
PROVISIONED=1
EFS_MOUNT_PATH="/mnt/efs"
EFS_SQLITE_DIR="/mnt/efs"
SAM_BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK_NAME="$2"; shift 2 ;;
    --bucket) SQLITE_BUCKET="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --region) AWS_REGION_ARG=("--region" "$2"); shift 2 ;;
    --prefix) S3_PREFIX="$2"; shift 2 ;;
    --allow-origins) ALLOW_ORIGIN="$2"; shift 2 ;;
    --efs-ap-arn) EFS_AP_ARN="$2"; shift 2 ;;
    --subnet-ids) SUBNET_IDS="$2"; shift 2 ;;
    --sg-ids) SG_IDS="$2"; shift 2 ;;
    --provisioned) PROVISIONED="$2"; shift 2 ;;
    --efs-mount-path) EFS_MOUNT_PATH="$2"; shift 2 ;;
    --efs-sqlite-dir) EFS_SQLITE_DIR="$2"; shift 2 ;;
    --use-container|--container-build) SAM_BUILD_ARGS+=("--use-container"); shift 1 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SQLITE_BUCKET" ]]; then
  echo "--bucket is required (S3 bucket holding <dataset>.sqlite)" >&2
  exit 1
fi
if [[ -z "$EFS_AP_ARN" ]]; then
  echo "--efs-ap-arn is required (EFS Access Point ARN)" >&2
  exit 1
fi
if [[ -z "$SUBNET_IDS" || -z "$SG_IDS" ]]; then
  echo "--subnet-ids and --sg-ids are required for Lambda VPC" >&2
  exit 1
fi

command -v sam >/dev/null 2>&1 || { echo "AWS SAM CLI is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pushd "$SCRIPT_DIR" >/dev/null

echo "Building SAM package..."
# Salt the build with config so config-only changes (like CORS) publish a new version
echo "ALLOW_ORIGIN=${ALLOW_ORIGIN} S3_PREFIX=${S3_PREFIX} TS=$(date +%s)" > .build_salt.txt
sam build "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" "${SAM_BUILD_ARGS[@]}"

echo "Deploying stack ${STACK_NAME} ..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3 \
  --parameter-overrides \
    SqliteBucket="$SQLITE_BUCKET" \
    S3Prefix="$S3_PREFIX" \
    CorsAllowOrigin="$ALLOW_ORIGIN" \
    EfsAccessPointArn="$EFS_AP_ARN" \
    VpcSubnetIds="$SUBNET_IDS" \
    VpcSecurityGroupIds="$SG_IDS" \
    ProvisionedConcurrency="$PROVISIONED" \
    EfsMountPath="$EFS_MOUNT_PATH" \
    EfsSqliteDir="$EFS_SQLITE_DIR" \
  "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}"

API_URL=$(aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

# Align API Gateway HTTP API CORS with ALLOW_ORIGIN to avoid header drift
API_ID=$(aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" cloudformation list-stack-resources --stack-name "$STACK_NAME" \
  --query "StackResourceSummaries[?LogicalResourceId=='ServerlessHttpApi'].PhysicalResourceId" --output text 2>/dev/null || true)
if [[ -n "$API_ID" && "$API_ID" != "None" ]]; then
  # Build JSON array for AllowOrigins from comma-separated ALLOW_ORIGIN
  IFS=',' read -ra _ORIG_ARR <<< "$ALLOW_ORIGIN"
  ORIG_JSON="["
  for o in "${_ORIG_ARR[@]}"; do
    o_trimmed="${o//\"/\"}" # escape quotes
    o_trimmed="${o_trimmed//[$'\n\r\t']/}"
    if [[ -n "$o_trimmed" ]]; then
      if [[ "$ORIG_JSON" != "[" ]]; then ORIG_JSON+=" , "; fi
      ORIG_JSON+="\"$o_trimmed\""
    fi
  done
  ORIG_JSON+="]"
  echo "Updating HTTP API ($API_ID) CORS AllowOrigins to: $ALLOW_ORIGIN"
  aws "${AWS_PROFILE_ARG[@]}" "${AWS_REGION_ARG[@]}" apigatewayv2 update-api \
    --api-id "$API_ID" \
    --cors-configuration "AllowOrigins=$ORIG_JSON,AllowMethods=[\"GET\",\"OPTIONS\"],AllowHeaders=[\"*\"]" >/dev/null 2>&1 || true
fi

popd >/dev/null
echo "Deployed. API URL: ${API_URL}"
