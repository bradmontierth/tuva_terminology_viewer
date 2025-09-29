#!/usr/bin/env python3
"""End-to-end helper for SQLite asset builds and S3 sync.

This script can optionally download the current bundle set from S3, run the
local batch builder against one or more Tuva export directories, and then sync
any updated artefacts back to the same prefix.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path
from typing import List, Sequence

DEFAULT_OUTPUT = Path("public/data/sqlite")
DEFAULT_THRESHOLD = 1000
DEFAULT_S3_PREFIX = "s3://tuva-public-resources/terminology_viewer_sqlite"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build SQLite bundles and sync with S3")
    parser.add_argument(
        "sources",
        nargs="*",
        help="Dataset directories to process (e.g. ../data/versioned_terminology/latest)",
    )
    parser.add_argument(
        "--s3-uri",
        default=DEFAULT_S3_PREFIX,
        help=f"S3 URI where SQLite bundles are stored (default: {DEFAULT_S3_PREFIX})",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Local output directory (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        help="Row-count threshold passed to build-sqlite-batch (default: %(default)s)",
    )
    parser.add_argument(
        "--dataset",
        action="append",
        dest="datasets",
        help="Restrict processing to specific dataset ids (repeatable)",
    )
    parser.add_argument(
        "--download-only",
        action="store_true",
        help="Only sync from S3 to local output, skip build/upload",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip the initial S3 download step",
    )
    parser.add_argument(
        "--skip-upload",
        action="store_true",
        help="Skip the final S3 upload step",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print commands instead of executing them",
    )
    parser.add_argument(
        "--aws-profile",
        help="AWS profile name to use for s3 sync commands",
    )
    parser.add_argument(
        "--extra-batch-args",
        nargs=argparse.REMAINDER,
        help="Additional arguments passed verbatim to build-sqlite-batch.py (after '--')",
    )
    return parser.parse_args(argv)


def run_command(command: List[str], *, cwd: Path | None = None, dry_run: bool = False) -> None:
    text = shlex.join(command)
    if dry_run:
        print(f"DRY RUN: {text}")
        return
    print(text)
    subprocess.run(command, cwd=cwd, check=True)


def ensure_command(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"Required command '{name}' not found on PATH")


def sync_from_s3(s3_uri: str, output: Path, *, profile: str | None, dry_run: bool) -> None:
    command = ["aws", "s3", "sync", s3_uri, str(output)]
    if profile:
        command.extend(["--profile", profile])
    run_command(command, dry_run=dry_run)


def sync_to_s3(output: Path, s3_uri: str, *, profile: str | None, dry_run: bool) -> None:
    command = ["aws", "s3", "sync", str(output), s3_uri]
    if profile:
        command.extend(["--profile", profile])
    run_command(command, dry_run=dry_run)


def run_batch_builder(
    sources: Sequence[str],
    output: Path,
    args: argparse.Namespace,
    repo_root: Path,
) -> None:
    if not sources:
        print("No sources supplied; skipping build step.")
        return
    builder = repo_root / "scripts" / "build-sqlite-batch.py"
    command = [
        sys.executable,
        str(builder),
        "--threshold",
        str(max(0, args.threshold)),
        "--output",
        str(output),
    ]
    if args.datasets:
        for dataset in args.datasets:
            command.extend(["--dataset", dataset])
    command.extend(sources)
    if args.extra_batch_args:
        command.extend(args.extra_batch_args)
    run_command(command, cwd=repo_root, dry_run=args.dry_run)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    output = Path(args.output).resolve()
    repo_root = Path(__file__).resolve().parents[1]

    output.mkdir(parents=True, exist_ok=True)

    try:
        ensure_command("aws")
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    if not args.skip_download:
        sync_from_s3(args.s3_uri, output, profile=args.aws_profile, dry_run=args.dry_run)
        if args.download_only:
            return 0

    run_batch_builder(args.sources, output, args, repo_root)

    if not args.skip_upload:
        sync_to_s3(output, args.s3_uri, profile=args.aws_profile, dry_run=args.dry_run)

    return 0


if __name__ == "__main__":
    import shutil

    sys.exit(main(sys.argv[1:]))
