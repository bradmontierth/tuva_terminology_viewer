#!/usr/bin/env bash
set -euo pipefail

# Invoke the EfsSyncFunction Lambda to copy .sqlite files from S3 to EFS.
#
# Usage:
#   scripts/run-efs-sync.sh --stack TuvaSearchApi [--profile term] [--overwrite 0|1] [--datasets ndc,loinc]

STACK="TuvaSearchApi"
AWS_PROFILE_ARG=()
OUT_FILE=""
OVERWRITE=0
DATASETS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    --overwrite) OVERWRITE="$2"; shift 2 ;;
    --datasets) DATASETS="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

FUNC_NAME=$(aws "${AWS_PROFILE_ARG[@]}" cloudformation describe-stack-resources --stack-name "$STACK" \
  --query 'StackResources[?LogicalResourceId==`EfsSyncFunction`].PhysicalResourceId' --output text)

if [[ -z "$FUNC_NAME" || "$FUNC_NAME" == "None" ]]; then
  echo "EfsSyncFunction not found in stack $STACK" >&2
  exit 1
fi

# Build JSON payload safely
if [[ -n "$DATASETS" ]]; then
  PAYLOAD=$(jq -n --argjson overwrite "$OVERWRITE" --arg datasets "$DATASETS" '
    { overwrite: ($overwrite==1) }
    + { datasets: ($datasets | split(",") | map(gsub("\\s+"; "")) ) }
  ')
else
  PAYLOAD=$(jq -n --argjson overwrite "$OVERWRITE" '{ overwrite: ($overwrite==1) }')
fi

TMP_OUT=$(mktemp)
META_JSON=$(aws "${AWS_PROFILE_ARG[@]}" lambda invoke --function-name "$FUNC_NAME" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" "$TMP_OUT")

STATUS=$(echo "$META_JSON" | jq -r '.StatusCode // empty')
ERROR=$(echo "$META_JSON" | jq -r '.FunctionError // empty')

PARSED=$(jq -r '.statusCode as $sc | .body | (try fromjson catch .) | {status:$sc, body:.}' "$TMP_OUT")
echo "Lambda invoke metadata: status=${STATUS:-} error=${ERROR:-none}"
echo "Response summary:"
echo "$PARSED" | jq -r '.'
if [[ -n "$OUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  echo "$PARSED" | jq -r '.body' > "$OUT_FILE"
fi
rm -f "$TMP_OUT"
