#!/usr/bin/env bash
set -euo pipefail

# Check which IAM permissions are missing to deploy and run the
# Tuva Terminology Viewer Search API (Lambda + HTTP API using SQLite on S3).
#
# This script uses IAM policy simulation against the current IAM principal
# (or a provided one) and prints any actions that are NOT allowed.
# If a section prints no rows, you already have the required permissions.
#
# Usage:
#   scripts/check-iam-search-api.sh \
#     --bucket <DATA_BUCKET> \
#     [--prefix api_sqlite_dev] \
#     [--artifact-bucket <SAM_ARTIFACTS_BUCKET>] \
#     [--profile <aws-profile>] [--region <aws-region>] \
#     [--policy-source-arn arn:aws:iam::<acct>:role/<RoleName>] \
#     [--no-optional]   # skip API Gateway + CloudFront checks
#
# Notes:
# - You need iam:SimulatePrincipalPolicy on your principal to run simulations.
# - If STS cannot be resolved (e.g., federated sessions), pass --policy-source-arn.
# - For SAM packaging with --resolve-s3, pass --artifact-bucket if your org
#   restricts S3; otherwise that check is skipped.

usage() {
  cat <<EOF
Check missing IAM permissions for Search API deploy and data publish.

Required flags:
  --bucket <name>        S3 bucket holding <dataset>.sqlite and the web app

Optional flags:
  --prefix <path>        Object prefix for API SQLite files (default: api_sqlite_dev)
  --artifact-bucket <b>  SAM artifacts bucket to check (optional)
  --profile <name>       AWS CLI profile to use
  --region <name>        AWS region to use
  --policy-source-arn A  IAM principal ARN to simulate (role or user)
  --no-optional          Skip API Gateway + CloudFront checks
  -h, --help             Show this help

Examples:
  scripts/check-iam-search-api.sh --bucket my-bucket --prefix api_sqlite_dev --profile term
  scripts/check-iam-search-api.sh --bucket my-bucket --artifact-bucket sam-artifacts-123 \
    --policy-source-arn arn:aws:iam::123456789012:role/DevRole
EOF
}

BUCKET=""
PREFIX="api_sqlite_dev"
ARTIFACT_BUCKET=""
PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_REGION:-}"
POLICY_SOURCE_ARN="${POLICY_SOURCE_ARN:-}"
INCLUDE_OPTIONAL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --artifact-bucket) ARTIFACT_BUCKET="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --policy-source-arn) POLICY_SOURCE_ARN="$2"; shift 2 ;;
    --no-optional) INCLUDE_OPTIONAL=0; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "--bucket is required" >&2
  usage
  exit 2
fi

AWSARGS=(--no-cli-pager)
[[ -n "$PROFILE" ]] && AWSARGS+=(--profile "$PROFILE")
[[ -n "$REGION" ]] && AWSARGS+=(--region "$REGION")

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }

get_sts_field() {
  local field="$1"
  aws "${AWSARGS[@]}" sts get-caller-identity --query "$field" --output text 2>/dev/null || true
}

resolve_principal() {
  # Prefer user-provided ARN
  if [[ -n "$POLICY_SOURCE_ARN" ]]; then
    echo "$POLICY_SOURCE_ARN"
    return 0
  fi

  local sts_arn acct
  sts_arn="$(get_sts_field Arn)"
  acct="$(get_sts_field Account)"

  # If STS returns a clean IAM ARN, use it directly
  if [[ -n "$sts_arn" && "$sts_arn" == arn:aws:iam::* ]]; then
    echo "$sts_arn"
    return 0
  fi

  # Map assumed-role → IAM role ARN
  if [[ -n "$sts_arn" && "$sts_arn" == arn:aws:sts::*:assumed-role/*/* ]]; then
    local role
    role="$(sed -E 's|^arn:aws:sts::[0-9]+:assumed-role/([^/]+)/.*$|\1|' <<< "$sts_arn")"
    echo "arn:aws:iam::${acct}:role/${role}"
    return 0
  fi

  # SSO profile fallback (derive role from profile config)
  if [[ -n "$PROFILE" ]]; then
    local sso_acct sso_role conf_role
    sso_acct="$(aws "${AWSARGS[@]}" configure get sso_account_id 2>/dev/null || true)"
    sso_role="$(aws "${AWSARGS[@]}" configure get sso_role_name 2>/dev/null || true)"
    conf_role="$(aws "${AWSARGS[@]}" configure get role_arn 2>/dev/null || true)"
    if [[ -n "$conf_role" ]]; then
      echo "$conf_role"
      return 0
    fi
    if [[ -n "$sso_acct" && -n "$sso_role" ]]; then
      echo "arn:aws:iam::${sso_acct}:role/${sso_role}"
      return 0
    fi
  fi

  # Unable to infer; ask caller to pass explicitly
  echo ""  # empty result signals failure
}

PRINCIPAL_ARN="$(resolve_principal)"
if [[ -z "$PRINCIPAL_ARN" || "$PRINCIPAL_ARN" != arn:aws:iam::* ]]; then
  echo "Unable to resolve IAM principal."
  echo "Set --policy-source-arn arn:aws:iam::<acct>:role/<RoleName> (or export POLICY_SOURCE_ARN) and rerun."
  echo "Tip (SSO): aws sso login --profile <p>; then pass --profile <p> or --policy-source-arn=arn:aws:iam::<acct>:role/<RoleName>"
  exit 2
fi

ACCOUNT_ID="$(get_sts_field Account)"
if [[ -z "$ACCOUNT_ID" ]]; then
  # Try to derive from ARN
  ACCOUNT_ID="$(cut -d: -f5 <<< "$PRINCIPAL_ARN")"
fi

echo "Simulating for principal: $PRINCIPAL_ARN"
echo "Target data bucket: s3://${BUCKET}/${PREFIX}"$([[ -n "$ARTIFACT_BUCKET" ]] && echo "; artifacts: s3://${ARTIFACT_BUCKET}")
echo

sim() {
  local header="$1"; shift
  echo "=== ${header} ==="
  set +e
  aws "${AWSARGS[@]}" iam simulate-principal-policy \
    --policy-source-arn "$PRINCIPAL_ARN" "$@" \
    --query "EvaluationResults[?EvalDecision!='allowed'].{Action:EvalActionName,Decision:EvalDecision,Missing:MissingContextValues}" \
    --output table
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "(simulation failed; ensure you have iam:SimulatePrincipalPolicy and the principal ARN is correct)" >&2
  fi
  echo
}

# Core CloudFormation + Lambda actions the deploy wrapper uses directly
sim "CloudFormation + Lambda (direct calls)" \
  --action-names \
    cloudformation:CreateStack cloudformation:UpdateStack cloudformation:DeleteStack \
    cloudformation:DescribeStacks cloudformation:DescribeStackResources cloudformation:GetTemplateSummary \
    cloudformation:CreateChangeSet cloudformation:DescribeChangeSet cloudformation:ExecuteChangeSet cloudformation:DeleteChangeSet \
    lambda:GetFunction lambda:GetFunctionConfiguration lambda:UpdateFunctionConfiguration lambda:AddPermission

# IAM operations needed for CFN to create/modify the Lambda execution role
sim "IAM role management for Lambda (via CFN)" \
  --action-names iam:CreateRole iam:DeleteRole iam:GetRole iam:AttachRolePolicy iam:DetachRolePolicy iam:PutRolePolicy iam:PassRole \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:role/*" \
  --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=cloudformation.amazonaws.com,ContextKeyType=string

# PassRole specifically to Lambda service (some orgs require explicit contexts)
sim "IAM PassRole to Lambda service" \
  --action-names iam:PassRole \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:role/*" \
  --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string

# S3 data access (bucket/prefix where <dataset>.sqlite live)
sim "S3 data bucket (bucket-level)" \
  --action-names s3:ListBucket \
  --resource-arns "arn:aws:s3:::${BUCKET}"

sim "S3 data prefix (object-level)" \
  --action-names s3:GetObject s3:PutObject s3:DeleteObject \
  --resource-arns "arn:aws:s3:::${BUCKET}/${PREFIX}/*"

# S3 artifacts bucket used by SAM packaging (optional)
if [[ -n "$ARTIFACT_BUCKET" ]]; then
  sim "S3 SAM artifacts bucket (object-level)" \
    --action-names s3:PutObject s3:GetObject s3:DeleteObject \
    --resource-arns "arn:aws:s3:::${ARTIFACT_BUCKET}/*"
  sim "S3 SAM artifacts bucket (bucket-level)" \
    --action-names s3:ListBucket \
    --resource-arns "arn:aws:s3:::${ARTIFACT_BUCKET}"
else
  sim "(info) S3 SAM artifacts bucket" \
    --action-names s3:CreateBucket || true
fi

if [[ $INCLUDE_OPTIONAL -eq 1 ]]; then
  sim "API Gateway (optional; CFN creates HTTP APIs)" \
    --action-names apigateway:GET apigateway:POST apigateway:PATCH apigateway:DELETE

  sim "CloudFront (optional; only if you invalidate)" \
    --action-names cloudfront:CreateInvalidation
fi

echo "Done. Any rows printed in the tables above are missing/denied."

