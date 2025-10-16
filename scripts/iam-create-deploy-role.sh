#!/usr/bin/env bash
set -euo pipefail

# Creates a deployment IAM role and attaches the two managed policies
# defined in iam/*.json. The role trusts a provided principal ARN
# (an IAM user or role) to assume it.
#
# Usage:
#   scripts/iam-create-deploy-role.sh \
#     --name tuva-tv --region us-east-1 --account 123456789012 \
#     --role-name TuvaTvDeployRole \
#     --trust-principal arn:aws:iam::123456789012:user/you
#
# After creation, you can assume the role and run provisioning/deploy scripts.

NAME_PREFIX="tuva-tv"
REGION=""
ACCOUNT_ID=""
ROLE_NAME=""
TRUST_PRINCIPAL=""
AWS_PROFILE_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --account) ACCOUNT_ID="$2"; shift 2 ;;
    --role-name) ROLE_NAME="$2"; shift 2 ;;
    --trust-principal) TRUST_PRINCIPAL="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REGION" ]]; then
  REGION="$(aws configure get region || true)"
fi
if [[ -z "$REGION" || -z "$ACCOUNT_ID" || -z "$ROLE_NAME" || -z "$TRUST_PRINCIPAL" ]]; then
  echo "--region, --account, --role-name, --trust-principal are required" >&2
  exit 1
fi

TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "${TRUST_PRINCIPAL}" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
)

set +e
aws "${AWS_PROFILE_ARG[@]}" iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST" \
  --description "Deploy role for ${NAME_PREFIX} provisioning and SAM deploy" >/dev/null 2>&1
set -e

# Attach the two managed policies (creating them if needed)
"$(dirname "$0")"/iam-attach-policies.sh \
  --name "$NAME_PREFIX" --region "$REGION" --account "$ACCOUNT_ID" \
  --attach-role "$ROLE_NAME" ${AWS_PROFILE_ARG:+--profile ${AWS_PROFILE_ARG[1]}}

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "Created/updated deploy role: ${ROLE_ARN}"
