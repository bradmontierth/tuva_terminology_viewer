#!/usr/bin/env bash
set -euo pipefail

# Provisions EFS (file system, mount targets, access point) and security groups
# for Lambda + EFS. Uses default VPC if --vpc-id is not provided.
#
# Usage:
#   scripts/aws-provision-efs.sh \
#     --name tuva-tv --region us-east-1 \
#     [--vpc-id vpc-xxxx] [--subnet-ids subnet-a,subnet-b] \
#     [--one-zone 0|1] [--az-name us-east-1a]
#
# Outputs key IDs/ARNs to stdout and writes JSON to scripts/outputs/efs.json

NAME_PREFIX="tuva-tv"
REGION=""
VPC_ID=""
SUBNET_IDS_CSV=""
ONE_ZONE=0
AZ_NAME=""
EXISTING_FS_ID=""
AWS_PROFILE_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --vpc-id) VPC_ID="$2"; shift 2 ;;
    --subnet-ids) SUBNET_IDS_CSV="$2"; shift 2 ;;
    --one-zone) ONE_ZONE="$2"; shift 2 ;;
    --az-name) AZ_NAME="$2"; shift 2 ;;
    --file-system-id) EXISTING_FS_ID="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "AWS CLI is required" >&2; exit 1; }

if [[ -z "${REGION}" ]]; then
  REGION="$(aws configure get region || true)"
fi
if [[ -z "${REGION}" ]]; then
  echo "--region is required or set a default via 'aws configure'" >&2
  exit 1
fi

ACCOUNT_ID=$(aws "${AWS_PROFILE_ARG[@]}" sts get-caller-identity --query Account --output text)

if [[ -z "${VPC_ID}" ]]; then
  VPC_ID=$(aws "${AWS_PROFILE_ARG[@]}" ec2 describe-vpcs --region "$REGION" \
    --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  if [[ "${VPC_ID}" == "None" || -z "${VPC_ID}" ]]; then
    echo "No default VPC found. Provide --vpc-id explicitly." >&2
    exit 1
  fi
fi

echo "Using VPC: ${VPC_ID} in ${REGION} (account ${ACCOUNT_ID})"

# Choose two subnets if not provided
if [[ -z "${SUBNET_IDS_CSV}" ]]; then
  mapfile -t SUBNETS < <(aws "${AWS_PROFILE_ARG[@]}" ec2 describe-subnets --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" \
    --query 'Subnets[].[SubnetId, AvailabilityZone]' --output text | sort -k2 | awk '{print $1" "$2}')
  declare -A PICKED_BY_AZ=()
  CHOSEN=()
  for line in "${SUBNETS[@]}"; do
    sid=$(echo "$line" | awk '{print $1}')
    az=$(echo "$line" | awk '{print $2}')
    if [[ -z "${PICKED_BY_AZ[$az]:-}" ]]; then
      PICKED_BY_AZ[$az]=1
      CHOSEN+=("$sid")
    fi
    [[ ${#CHOSEN[@]} -ge 2 ]] && break || true
  done
  if [[ ${#CHOSEN[@]} -lt 1 ]]; then
    echo "No subnets found in VPC $VPC_ID" >&2
    exit 1
  fi
  SUBNET_IDS_CSV=$(IFS=, ; echo "${CHOSEN[*]}")
fi

IFS=',' read -r -a SUBNET_IDS <<< "$SUBNET_IDS_CSV"
echo "Using subnets: ${SUBNET_IDS_CSV}"

# Create Security Groups (idempotent if exists)
function ensure_sg() {
  local name=$1
  local desc=$2
  local sg_id
  sg_id=$(aws "${AWS_PROFILE_ARG[@]}" ec2 describe-security-groups --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" Name=group-name,Values="$name" \
    --query 'SecurityGroups[0].GroupId' --output text || true)
  if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
    sg_id=$(aws "${AWS_PROFILE_ARG[@]}" ec2 create-security-group --region "$REGION" \
      --group-name "$name" --description "$desc" --vpc-id "$VPC_ID" \
      --query GroupId --output text)
    aws "${AWS_PROFILE_ARG[@]}" ec2 create-tags --region "$REGION" --resources "$sg_id" \
      --tags Key=Name,Value="$name" Key=Project,Value="$NAME_PREFIX"
  fi
  echo "$sg_id"
}

echo "Creating/reusing security groups ..."
LAMBDA_SG_NAME="${NAME_PREFIX}-lambda-sg"
EFS_SG_NAME="${NAME_PREFIX}-efs-sg"
LAMBDA_SG_ID=$(ensure_sg "$LAMBDA_SG_NAME" "Lambda to EFS access")
EFS_SG_ID=$(ensure_sg "$EFS_SG_NAME" "EFS mount target SG")

# EFS SG inbound 2049 from Lambda SG
set +e
aws "${AWS_PROFILE_ARG[@]}" ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$EFS_SG_ID" --protocol tcp --port 2049 \
  --source-group "$LAMBDA_SG_ID" >/dev/null 2>&1 || true
set -e

echo "EFS SG inbound rule ensured: 2049 from $LAMBDA_SG_ID"

if [[ -n "$EXISTING_FS_ID" ]]; then
  FS_ID="$EXISTING_FS_ID"
  echo "Reusing existing EFS file system: $FS_ID"
  STATE=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-file-systems --region "$REGION" --file-system-id "$FS_ID" --query 'FileSystems[0].LifeCycleState' --output text)
  if [[ "$STATE" != "available" ]]; then
    echo "Waiting for EFS $FS_ID to be available ..."
    while true; do
      STATE=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-file-systems --region "$REGION" \
        --file-system-id "$FS_ID" --query 'FileSystems[0].LifeCycleState' --output text)
      [[ "$STATE" == "available" ]] && break
      sleep 5
    done
  fi
  FS_ARN=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-file-systems --region "$REGION" \
    --file-system-id "$FS_ID" --query 'FileSystems[0].FileSystemArn' --output text)
else
  echo "Creating EFS file system ..."
  CREATE_ARGS=(--region "$REGION" --performance-mode generalPurpose --throughput-mode bursting --encrypted)
  if [[ "$ONE_ZONE" == "1" ]]; then
    if [[ -z "$AZ_NAME" ]]; then
      echo "--az-name is required when --one-zone=1" >&2
      exit 1
    fi
    CREATE_ARGS+=(--availability-zone-name "$AZ_NAME")
  fi
  FS_ID=$(aws "${AWS_PROFILE_ARG[@]}" efs create-file-system "${CREATE_ARGS[@]}" --tags Key=Name,Value="${NAME_PREFIX}-efs" \
    --query FileSystemId --output text)

  echo "Waiting for EFS $FS_ID to be available ..."
  while true; do
    STATE=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-file-systems --region "$REGION" \
      --file-system-id "$FS_ID" --query 'FileSystems[0].LifeCycleState' --output text)
    [[ "$STATE" == "available" ]] && break
    sleep 5
  done

  FS_ARN=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-file-systems --region "$REGION" \
    --file-system-id "$FS_ID" --query 'FileSystems[0].FileSystemArn' --output text)
fi

echo "Creating EFS mount targets ..."
for SUBNET_ID in "${SUBNET_IDS[@]}"; do
  # Create mount target per subnet
  if ! aws "${AWS_PROFILE_ARG[@]}" efs create-mount-target --region "$REGION" \
      --file-system-id "$FS_ID" --subnet-id "$SUBNET_ID" \
      --security-groups "$EFS_SG_ID"; then
    echo "Note: create-mount-target failed for $SUBNET_ID (may already exist or be pending)." >&2
  fi
done

echo "Waiting for mount targets to be available ..."
TARGET_EXPECTED=${#SUBNET_IDS[@]}
ATTEMPTS=0
MAX_ATTEMPTS=180
while true; do
  COUNT=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-mount-targets --region "$REGION" \
    --file-system-id "$FS_ID" --query 'length(MountTargets)' --output text)
  AVAIL=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-mount-targets --region "$REGION" \
    --file-system-id "$FS_ID" --query 'length(MountTargets[?LifeCycleState==`available`])' --output text)
  if [[ "$COUNT" =~ ^[0-9]+$ && "$AVAIL" =~ ^[0-9]+$ ]]; then
    if [[ "$COUNT" -ge "$TARGET_EXPECTED" && "$AVAIL" -ge "$TARGET_EXPECTED" ]]; then
      break
    fi
  fi
  ATTEMPTS=$((ATTEMPTS+1))
  if [[ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]]; then
    STATES=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-mount-targets --region "$REGION" \
      --file-system-id "$FS_ID" --query 'MountTargets[].LifeCycleState' --output text | tr '\n' ' ')
    echo "Timed out waiting for EFS mount targets (available $AVAIL/$TARGET_EXPECTED, total $COUNT; states: $STATES)" >&2
    exit 1
  fi
  sleep 5
done

echo "Creating EFS Access Point at /sqlite ..."
set +e
AP_ARN=$(aws "${AWS_PROFILE_ARG[@]}" efs create-access-point --region "$REGION" \
  --file-system-id "$FS_ID" \
  --posix-user "Uid=1000,Gid=1000" \
  --root-directory "Path=/sqlite,CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=0775}" \
  --tags Key=Name,Value="${NAME_PREFIX}-ap-sqlite" \
  --query AccessPointArn --output text 2>/dev/null)
set -e
if [[ -z "$AP_ARN" || "$AP_ARN" == "None" ]]; then
  # If creation failed (e.g., already exists), try to find an existing AP at /sqlite
  AP_ARN=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-access-points --region "$REGION" \
    --file-system-id "$FS_ID" \
    --query "AccessPoints[?RootDirectory.Path=='/sqlite'].AccessPointArn | [0]" --output text)
  if [[ -z "$AP_ARN" || "$AP_ARN" == "None" ]]; then
    echo "Failed to create or find EFS Access Point at /sqlite" >&2
    exit 1
  fi
fi

mkdir -p scripts/outputs
cat > scripts/outputs/efs.json <<JSON
{
  "Region": "${REGION}",
  "AccountId": "${ACCOUNT_ID}",
  "VpcId": "${VPC_ID}",
  "SubnetIds": ["${SUBNET_IDS[@]}"],
  "LambdaSecurityGroupId": "${LAMBDA_SG_ID}",
  "EfsSecurityGroupId": "${EFS_SG_ID}",
  "FileSystemId": "${FS_ID}",
  "FileSystemArn": "${FS_ARN}",
  "AccessPointArn": "${AP_ARN}",
  "MountPath": "/mnt/efs",
  "SqliteDir": "/mnt/efs"
}
JSON

echo "Done. Outputs written to scripts/outputs/efs.json"
echo "EFS_FILE_SYSTEM_ID=${FS_ID}"
echo "EFS_FILE_SYSTEM_ARN=${FS_ARN}"
echo "EFS_ACCESS_POINT_ARN=${AP_ARN}"
echo "LAMBDA_SG_ID=${LAMBDA_SG_ID}"
echo "EFS_SG_ID=${EFS_SG_ID}"
echo "SUBNET_IDS=${SUBNET_IDS_CSV}"
