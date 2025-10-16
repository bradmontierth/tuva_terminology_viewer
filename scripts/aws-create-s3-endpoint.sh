#!/usr/bin/env bash
set -euo pipefail

# Creates a Gateway VPC Endpoint for S3 in a VPC and attaches it to route tables.
# Required if your Lambda runs in a VPC without NAT and needs S3 access.
#
# Usage:
#   scripts/aws-create-s3-endpoint.sh --vpc-id vpc-xxxx --region us-east-1 \
#     [--route-table-ids rtb-aaa,rtb-bbb] [--profile term]

VPC_ID=""
REGION=""
ROUTE_TABLE_IDS_CSV=""
AWS_PROFILE_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vpc-id) VPC_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --route-table-ids) ROUTE_TABLE_IDS_CSV="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$VPC_ID" || -z "$REGION" ]]; then
  echo "--vpc-id and --region are required" >&2
  exit 1
fi

SERVICE="com.amazonaws.${REGION}.s3"

if [[ -z "$ROUTE_TABLE_IDS_CSV" ]]; then
  # Attach to all route tables in the VPC
  ROUTE_TABLE_IDS_CSV=$(aws "${AWS_PROFILE_ARG[@]}" ec2 describe-route-tables --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" \
    --query 'RouteTables[].RouteTableId' --output text | tr '\t' ',' | sed 's/,$//')
fi

if [[ -z "$ROUTE_TABLE_IDS_CSV" ]]; then
  echo "No route tables found for VPC $VPC_ID" >&2
  exit 1
fi

echo "Creating S3 Gateway Endpoint in $VPC_ID for $SERVICE on route tables: $ROUTE_TABLE_IDS_CSV"
EP_ID=$(aws "${AWS_PROFILE_ARG[@]}" ec2 create-vpc-endpoint --region "$REGION" \
  --vpc-id "$VPC_ID" --service-name "$SERVICE" --vpc-endpoint-type Gateway \
  --route-table-ids $ROUTE_TABLE_IDS_CSV \
  --query VpcEndpoint.VpcEndpointId --output text)

echo "Created endpoint: $EP_ID"

