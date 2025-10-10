#!/usr/bin/env bash
set -euo pipefail

# Probe which permissions you actually have by attempting safe, low-impact
# AWS operations. This avoids iam:SimulatePrincipalPolicy (often blocked).
#
# It verifies:
# - S3 bucket-level list and object Put/Get/Delete in your API prefix
# - CloudFormation template validation
# - CloudFormation change set creation (no execution) then cleanup
#
# It prints a summary of missing/denied actions. No resources are created
# except a temporary S3 object and a transient CFN change set + empty stack
# placeholder which are immediately deleted.
#
# Usage:
#   scripts/probe-iam-search-api.sh \
#     --bucket <DATA_BUCKET> \
#     [--prefix api_sqlite_dev] \
#     [--stack TuvaSearchApi-IamProbe] \
#     [--profile <aws-profile>] [--region <aws-region>]

usage() {
  cat <<EOF
Probe deploy-time permissions for the Search API without IAM simulation.

Required:
  --bucket <name>        S3 bucket where <dataset>.sqlite lives

Optional:
  --prefix <path>        Object prefix for API SQLite (default: api_sqlite_dev)
  --stack <name>         CFN stack name for the probe (default: TuvaSearchApi-IamProbe)
  --profile <name>       AWS CLI profile
  --region <name>        AWS region
  -h, --help             Show help

Example:
  scripts/probe-iam-search-api.sh --bucket my-bucket --prefix api_sqlite_dev --profile term
EOF
}

BUCKET=""
PREFIX="api_sqlite_dev"
STACK="TuvaSearchApi-IamProbe"
PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_REGION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
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

MISSING=()
NOTE() { printf "[note] %s\n" "$*"; }
MISS() { printf "[missing] %s\n" "$*"; MISSING+=("$*"); }

# 1) S3 bucket-level list
echo "=== S3: bucket-level list on s3://${BUCKET} ==="
if aws "${AWSARGS[@]}" s3api list-objects-v2 --bucket "$BUCKET" --max-keys 1 >/dev/null 2>&1; then
  echo "OK: s3:ListBucket"
else
  echo "DENIED: s3:ListBucket"
  MISS "s3:ListBucket on arn:aws:s3:::${BUCKET}"
fi

# 2) S3 object Put/Get/Delete in prefix
TMPFILE="$(mktemp)"; trap 'rm -f "$TMPFILE"' EXIT
echo "probe" > "$TMPFILE"
KEY="${PREFIX%/}/iam-perms-probe-$(date +%s)-$RANDOM.txt"

echo "=== S3: PutObject s3://${BUCKET}/${KEY} ==="
PUT_OK=0
if aws "${AWSARGS[@]}" s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$TMPFILE" >/dev/null 2>&1; then
  PUT_OK=1
  echo "OK: s3:PutObject"
else
  echo "DENIED: s3:PutObject"
  MISS "s3:PutObject on arn:aws:s3:::${BUCKET}/${PREFIX}/*"
fi

if [[ $PUT_OK -eq 1 ]]; then
  echo "=== S3: GetObject s3://${BUCKET}/${KEY} ==="
  if aws "${AWSARGS[@]}" s3api get-object --bucket "$BUCKET" --key "$KEY" /dev/null >/dev/null 2>&1; then
    echo "OK: s3:GetObject"
  else
    echo "DENIED: s3:GetObject"
    MISS "s3:GetObject on arn:aws:s3:::${BUCKET}/${PREFIX}/*"
  fi
fi

echo "=== S3: DeleteObject s3://${BUCKET}/${KEY} ==="
if aws "${AWSARGS[@]}" s3api delete-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
  echo "OK: s3:DeleteObject"
else
  echo "DENIED: s3:DeleteObject"
  MISS "s3:DeleteObject on arn:aws:s3:::${BUCKET}/${PREFIX}/*"
fi

# 3) CloudFormation: validate template
echo "=== CloudFormation: ValidateTemplate search_api/template.yaml ==="
if aws "${AWSARGS[@]}" cloudformation validate-template \
  --template-body file://search_api/template.yaml >/dev/null 2>&1; then
  echo "OK: cloudformation:ValidateTemplate"
else
  echo "DENIED: cloudformation:ValidateTemplate"
  MISS "cloudformation:ValidateTemplate"
fi

# 4) CloudFormation: create a no-exec change set (no resource creation)
CHANGESET="IamProbe-$(date +%s)"
STACK_CREATED=0
echo "=== CloudFormation: CreateChangeSet (no execution) stack=${STACK}, changeset=${CHANGESET} ==="
if aws "${AWSARGS[@]}" cloudformation create-change-set \
  --change-set-type CREATE \
  --stack-name "$STACK" \
  --change-set-name "$CHANGESET" \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=SqliteBucket,ParameterValue="$BUCKET" \
  --template-body file://search_api/template.yaml >/dev/null 2>&1; then
  echo "OK: cloudformation:CreateChangeSet"
  STACK_CREATED=1
else
  echo "DENIED: cloudformation:CreateChangeSet (or other CFN restriction)"
  MISS "cloudformation:CreateChangeSet"
fi

# Cleanup CFN artifacts if we created them
if [[ $STACK_CREATED -eq 1 ]]; then
  echo "=== CloudFormation: DeleteChangeSet and delete empty stack ==="
  aws "${AWSARGS[@]}" cloudformation delete-change-set \
    --stack-name "$STACK" --change-set-name "$CHANGESET" >/dev/null 2>&1 || true
  # New-stack change sets create a REVIEW_IN_PROGRESS stack container; remove it
  aws "${AWSARGS[@]}" cloudformation delete-stack --stack-name "$STACK" >/dev/null 2>&1 || true
  echo "OK: cleanup attempted"
fi

echo
echo "Summary (request only what's listed below)"
if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "All probed permissions are present (S3 + CFN validate/change-set)."
  echo "Remaining likely requirements (not probed without resource creation):"
  echo "- iam:CreateRole, iam:PutRolePolicy, iam:AttachRolePolicy, iam:PassRole"
  echo "- lambda:GetFunctionConfiguration, lambda:UpdateFunctionConfiguration"
  echo "- apigateway:GET/POST/PATCH/DELETE (CFN-managed)"
else
  printf 'Missing/denied actions:\n'
  for a in "${MISSING[@]}"; do
    echo "- $a"
  done
  echo
  echo "After your admin grants these, rerun the probe."
  echo "Note: Some orgs block CreateChangeSet to prevent unvetted deployments; if so, request CFN basic deploy rights." 
fi

