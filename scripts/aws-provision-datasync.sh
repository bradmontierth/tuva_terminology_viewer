#!/usr/bin/env bash
set -euo pipefail

# Provisions AWS DataSync to copy SQLite files from S3 to EFS via Access Point.
# Creates an IAM role for DataSync to read S3, a DataSync S3 location, a DataSync
# EFS location (using the provided AP), a DataSync task, and starts execution.
#
# Usage:
#   scripts/aws-provision-datasync.sh \
#     --name tuva-tv --region us-east-1 \
#     --bucket my-bucket --prefix api_sqlite \
#     --efs-ap-arn arn:aws:elasticfilesystem:...:access-point/fsap-xxx \
#     --vpc-id vpc-xxxx --subnet-id subnet-aaa \
#     [--datasync-sg-id sg-xxx]
#
# Writes outputs to scripts/outputs/datasync.json

NAME_PREFIX="tuva-tv"
REGION=""
BUCKET=""
PREFIX=""
EFS_AP_ARN=""
VPC_ID=""
SUBNET_ID=""
DATASYNC_SG_ID=""
AWS_PROFILE_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME_PREFIX="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --efs-ap-arn) EFS_AP_ARN="$2"; shift 2 ;;
    --vpc-id) VPC_ID="$2"; shift 2 ;;
    --subnet-id) SUBNET_ID="$2"; shift 2 ;;
    --datasync-sg-id) DATASYNC_SG_ID="$2"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=("--profile" "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "AWS CLI is required" >&2; exit 1; }

if [[ -z "${REGION}" ]]; then
  REGION="$(aws configure get region || true)"
fi
if [[ -z "$REGION" || -z "$BUCKET" || -z "$EFS_AP_ARN" || -z "$VPC_ID" || -z "$SUBNET_ID" ]]; then
  echo "--region, --bucket, --efs-ap-arn, --vpc-id, --subnet-id are required" >&2
  exit 1
fi

ACCOUNT_ID=$(aws "${AWS_PROFILE_ARG[@]}" sts get-caller-identity --query Account --output text)

# Security group for DataSync ENIs if not provided
ensure_sg() {
  local name=$1; local desc=$2
  local sg_id
  sg_id=$(aws "${AWS_PROFILE_ARG[@]}" ec2 describe-security-groups --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC_ID" Name=group-name,Values="$name" \
    --query 'SecurityGroups[0].GroupId' --output text || true)
  if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
    sg_id=$(aws "${AWS_PROFILE_ARG[@]}" ec2 create-security-group --region "$REGION" --vpc-id "$VPC_ID" \
      --group-name "$name" --description "$desc" --query GroupId --output text)
    aws "${AWS_PROFILE_ARG[@]}" ec2 create-tags --region "$REGION" --resources "$sg_id" \
      --tags Key=Name,Value="$name" Key=Project,Value="$NAME_PREFIX"
  fi
  echo "$sg_id"
}

if [[ -z "$DATASYNC_SG_ID" ]]; then
  DATASYNC_SG_ID=$(ensure_sg "${NAME_PREFIX}-datasync-sg" "DataSync ENIs")
fi

# Authorize EFS SG for DataSync
# Find EFS SG by looking at mount targets of the AP's file system
FS_ID=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-access-points --region "$REGION" \
  --access-point-id "${EFS_AP_ARN##*/}" --query 'AccessPoints[0].FileSystemId' --output text)
EFS_MOUNT_SGS=$(aws "${AWS_PROFILE_ARG[@]}" efs describe-mount-targets --region "$REGION" --file-system-id "$FS_ID" \
  --query 'MountTargets[].MountTargetId' --output text | tr '\t' '\n' | while read -r mt; do
    aws "${AWS_PROFILE_ARG[@]}" efs describe-mount-target-security-groups --region "$REGION" --mount-target-id "$mt" \
      --query 'SecurityGroups[]' --output text
  done | sort -u | tr '\n' ' ')

for SG in $EFS_MOUNT_SGS; do
  set +e
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$SG" --protocol tcp --port 2049 --source-group "$DATASYNC_SG_ID" >/dev/null 2>&1 || true
  set -e
done

# Create IAM role for DataSync to read S3
ROLE_NAME="${NAME_PREFIX}-datasync-s3-role"
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "datasync.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)
set +e
aws "${AWS_PROFILE_ARG[@]}" iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" >/dev/null 2>&1 || true
set -e

S3_PREFIX_TRIMMED=${PREFIX#/}
S3_PREFIX_TRIMMED=${S3_PREFIX_TRIMMED%/}

POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:ListBucket","s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/${S3_PREFIX_TRIMMED}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt","kms:DescribeKey"],
      "Resource": "*",
      "Condition": {"StringEquals": {"kms:ViaService": "s3.${REGION}.amazonaws.com"}}
    }
  ]
}
EOF
)
aws "${AWS_PROFILE_ARG[@]}" iam put-role-policy --role-name "$ROLE_NAME" --policy-name "${NAME_PREFIX}-datasync-s3-access" \
  --policy-document "$POLICY_DOC" >/dev/null

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

S3_LOC_ARN=$(aws "${AWS_PROFILE_ARG[@]}" datasync create-location-s3 --region "$REGION" \
  --s3-bucket-arn "arn:aws:s3:::${BUCKET}" \
  --s3-config BucketAccessRoleArn="$ROLE_ARN" \
  --subdirectory "/${S3_PREFIX_TRIMMED}" \
  --query LocationArn --output text)

# Build ARNs for subnet and SG required by DataSync
SUBNET_ARN="arn:aws:ec2:${REGION}:${ACCOUNT_ID}:subnet/${SUBNET_ID}"
DATASYNC_SG_ARN="arn:aws:ec2:${REGION}:${ACCOUNT_ID}:security-group/${DATASYNC_SG_ID}"

# Build EFS FS ARN
FS_ARN="arn:aws:elasticfilesystem:${REGION}:${ACCOUNT_ID}:file-system/${FS_ID}"

EFS_LOC_ARN=$(aws "${AWS_PROFILE_ARG[@]}" datasync create-location-efs --region "$REGION" \
  --efs-filesystem-arn "$FS_ARN" \
  --access-point-arn "$EFS_AP_ARN" \
  --in-transit-encryption TLS1_2 \
  --ec2-config SubnetArn="$SUBNET_ARN",SecurityGroupArns="$DATASYNC_SG_ARN" \
  --subdirectory "/" \
  --query LocationArn --output text)

TASK_NAME="${NAME_PREFIX}-s3-to-efs-sqlite"
TASK_ARN=$(aws "${AWS_PROFILE_ARG[@]}" datasync create-task --region "$REGION" \
  --source-location-arn "$S3_LOC_ARN" \
  --destination-location-arn "$EFS_LOC_ARN" \
  --name "$TASK_NAME" \
  --options PreserveDeletedFiles=REMOVE,PosixPermissions=PRESERVE,VerifyMode=POINT_IN_TIME_CONSISTENT \
  --query TaskArn --output text)

EXEC_ARN=$(aws "${AWS_PROFILE_ARG[@]}" datasync start-task-execution --region "$REGION" --task-arn "$TASK_ARN" \
  --query TaskExecutionArn --output text)

echo "Started DataSync execution: $EXEC_ARN"

echo "Waiting for DataSync task to complete (this may take a while) ..."
while true; do
  STATUS=$(aws "${AWS_PROFILE_ARG[@]}" datasync describe-task-execution --region "$REGION" --task-execution-arn "$EXEC_ARN" \
    --query Status --output text)
  echo "Status: $STATUS"
  if [[ "$STATUS" == "SUCCESS" ]]; then
    break
  elif [[ "$STATUS" == "ERROR" || "$STATUS" == "FAILED" ]]; then
    echo "DataSync execution failed" >&2
    exit 1
  fi
  sleep 15
done

mkdir -p scripts/outputs
cat > scripts/outputs/datasync.json <<JSON
{
  "Region": "${REGION}",
  "AccountId": "${ACCOUNT_ID}",
  "Bucket": "${BUCKET}",
  "Prefix": "${S3_PREFIX_TRIMMED}",
  "EfsAccessPointArn": "${EFS_AP_ARN}",
  "DataSyncS3LocationArn": "${S3_LOC_ARN}",
  "DataSyncEfsLocationArn": "${EFS_LOC_ARN}",
  "DataSyncTaskArn": "${TASK_ARN}",
  "LastExecutionArn": "${EXEC_ARN}"
}
JSON

echo "Done. DataSync resources written to scripts/outputs/datasync.json"
# Ensure DataSync service-linked role exists (needed to create ENIs in your VPC)
set +e
aws "${AWS_PROFILE_ARG[@]}" iam get-role --role-name AWSServiceRoleForDataSync >/dev/null 2>&1
if [[ $? -ne 0 ]]; then
  aws "${AWS_PROFILE_ARG[@]}" iam create-service-linked-role --aws-service-name datasync.amazonaws.com >/dev/null
fi
set -e
