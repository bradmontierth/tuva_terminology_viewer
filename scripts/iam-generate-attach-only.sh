#!/usr/bin/env bash
set -euo pipefail

# Renders iam/tuva-attach-only.json substituting account, role name, and name prefix.
#
# Usage:
#   scripts/iam-generate-attach-only.sh \
#     --account 123456789012 --role brad-test-cloudfront --name tuva-tv

ACCOUNT_ID=""
ROLE_NAME=""
NAME_PREFIX="tuva-tv"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account) ACCOUNT_ID="$2"; shift 2 ;;
    --role) ROLE_NAME="$2"; shift 2 ;;
    --name) NAME_PREFIX="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ACCOUNT_ID" || -z "$ROLE_NAME" ]]; then
  echo "--account and --role are required" >&2
  exit 1
fi

sed \
  -e "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" \
  -e "s/__ROLE_NAME__/${ROLE_NAME}/g" \
  -e "s/__NAME_PREFIX__/${NAME_PREFIX}/g" \
  iam/tuva-attach-only.json

