import json
import os
import re
from typing import Dict, Any, List

import boto3

s3 = boto3.client("s3")

S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
S3_PREFIX = os.environ.get("S3_PREFIX", "").strip("/")
EFS_SQLITE_DIR = os.environ.get("EFS_SQLITE_DIR", "/mnt/efs")


def _safe_basename(key: str) -> str:
    base = os.path.basename(key)
    # Only allow [a-zA-Z0-9_.-]
    return re.sub(r"[^a-zA-Z0-9_.\-]", "_", base)


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _should_copy(dest_path: str, size: int, overwrite: bool) -> bool:
    try:
        st = os.stat(dest_path)
        if overwrite:
            return True
        return st.st_size != size
    except FileNotFoundError:
        return True


def _download_to_file(bucket: str, key: str, dest_path: str) -> None:
    tmp_path = dest_path + ".partial"
    _ensure_dir(os.path.dirname(dest_path))
    with open(tmp_path, "wb") as f:
        s3.download_fileobj(bucket, key, f)
    os.replace(tmp_path, dest_path)


def handler(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    if not S3_BUCKET:
        return {"statusCode": 400, "body": json.dumps({"error": "S3_BUCKET not set"})}
    if not S3_PREFIX:
        return {"statusCode": 400, "body": json.dumps({"error": "S3_PREFIX not set"})}

    overwrite = bool(event.get("overwrite", False)) if isinstance(event, dict) else False
    only_datasets: List[str] = []
    if isinstance(event, dict) and isinstance(event.get("datasets"), list):
        only_datasets = [str(d).strip().lower() for d in event.get("datasets") if str(d).strip()]

    copied = 0
    skipped = 0
    errors: List[str] = []

    paginator = s3.get_paginator("list_objects_v2")
    prefix = S3_PREFIX + "/" if S3_PREFIX else ""

    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
        contents = page.get("Contents", [])
        for obj in contents:
            key = obj.get("Key", "")
            size = int(obj.get("Size", 0))
            if not key or size <= 0:
                continue
            if not key.endswith(".sqlite"):
                continue
            base = _safe_basename(key)
            dataset = base[:-7].lower() if base.endswith(".sqlite") else base.lower()
            if only_datasets and dataset not in only_datasets:
                continue
            dest = os.path.join(EFS_SQLITE_DIR, base)
            try:
                if _should_copy(dest, size, overwrite):
                    _download_to_file(S3_BUCKET, key, dest)
                    copied += 1
                else:
                    skipped += 1
            except Exception as e:
                errors.append(f"{key}: {e}")

    body = {"ok": True, "copied": copied, "skipped": skipped, "errors": errors}
    status = 200 if not errors else 207
    return {"statusCode": status, "body": json.dumps(body)}
