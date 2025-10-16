#!/usr/bin/env bash
set -euo pipefail

# Creates two managed policies from iam/*.json and attaches them to an IAM user or role.
# Replaces placeholders in JSON using provided flags.
#
# Usage examples:
#   scripts/iam-attach-policies.sh --name tuva-tv --region us-east-1 \
#     --account $(aws sts get-caller-identity --query Account --output text) \
#     --attach-user my-deploy-user
#
#   scripts/iam-attach-policies.sh --name tuva-tv --region us-east-1 \
#     --account 123456789012 --attach-role MyDeployRole

NAME_PREFIX="tuva-tv"
REGION=""
ACCOUNT_ID=""
ATTACH_USER=""
ATTACH_ROLE=""
AWS_PROFILE_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --account) ACCOUNT_ID="$2"; shift 2 ;;
    --attach-user) ATTACH_USER="$2"; shift 2 ;;
    --attach-role) ATTACH_ROLE="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REGION" ]]; then
  REGION="$(aws configure get region || true)"
fi
if [[ -z "$REGION" || -z "$ACCOUNT_ID" ]]; then
  echo "--region and --account are required" >&2
  exit 1
fi
if [[ -z "$ATTACH_USER" && -z "$ATTACH_ROLE" ]]; then
  echo "Specify --attach-user or --attach-role" >&2
  exit 1
fi

render_policy() {
  local src=$1; local out=$2
  sed \
    -e "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" \
    -e "s/__REGION__/${REGION}/g" \
    -e "s/__NAME_PREFIX__/${NAME_PREFIX}/g" \
    "$src" > "$out"
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

render_policy iam/tuva-setup-efs-datasync.json "$TMP_DIR/setup.json"
render_policy iam/tuva-sam-deploy.json "$TMP_DIR/sam.json"

SETUP_POLICY_NAME="${NAME_PREFIX}-setup-efs-datasync"
SAM_POLICY_NAME="${NAME_PREFIX}-sam-deploy"

set +e
SETUP_POLICY_ARN=$(aws "${AWS_PROFILE_ARG[@]}" iam create-policy --policy-name "$SETUP_POLICY_NAME" \
  --policy-document file://"$TMP_DIR/setup.json" \
  --query Policy.Arn --output text 2>/dev/null)
if [[ -z "$SETUP_POLICY_ARN" ]]; then
  SETUP_POLICY_ARN=$(aws "${AWS_PROFILE_ARG[@]}" iam list-policies --scope Local --query \
    "Policies[?PolicyName=='$SETUP_POLICY_NAME'].Arn | [0]" --output text)
fi

SAM_POLICY_ARN=$(aws "${AWS_PROFILE_ARG[@]}" iam create-policy --policy-name "$SAM_POLICY_NAME" \
  --policy-document file://"$TMP_DIR/sam.json" \
  --query Policy.Arn --output text 2>/dev/null)
if [[ -z "$SAM_POLICY_ARN" ]]; then
  SAM_POLICY_ARN=$(aws "${AWS_PROFILE_ARG[@]}" iam list-policies --scope Local --query \
    "Policies[?PolicyName=='$SAM_POLICY_NAME'].Arn | [0]" --output text)
fi
set -e

if [[ -n "$ATTACH_USER" ]]; then
  aws "${AWS_PROFILE_ARG[@]}" iam attach-user-policy --user-name "$ATTACH_USER" --policy-arn "$SETUP_POLICY_ARN"
  aws "${AWS_PROFILE_ARG[@]}" iam attach-user-policy --user-name "$ATTACH_USER" --policy-arn "$SAM_POLICY_ARN"
  echo "Attached to user $ATTACH_USER: $SETUP_POLICY_ARN and $SAM_POLICY_ARN"
else
  aws "${AWS_PROFILE_ARG[@]}" iam attach-role-policy --role-name "$ATTACH_ROLE" --policy-arn "$SETUP_POLICY_ARN"
  aws "${AWS_PROFILE_ARG[@]}" iam attach-role-policy --role-name "$ATTACH_ROLE" --policy-arn "$SAM_POLICY_ARN"
  echo "Attached to role $ATTACH_ROLE: $SETUP_POLICY_ARN and $SAM_POLICY_ARN"
fi
