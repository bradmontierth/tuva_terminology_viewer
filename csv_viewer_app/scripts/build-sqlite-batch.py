#!/usr/bin/env python3
"""Batch builder for SQLite search bundles.

Scans one or more source directories for Tuva CSV exports, estimates row
counts, and invokes ``scripts/build-sqlite.js`` for datasets that exceed the
preview threshold (defaults to 1,000 rows).
"""

from __future__ import annotations

import argparse
import gzip
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable, Iterator, List, Sequence, Tuple

PREVIEW_THRESHOLD = 1000
SUPPORTED_SUFFIXES = (".csv", ".csv.gz")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch build SQLite search bundles")
    parser.add_argument(
        "sources",
        nargs="+",
        help="Directories or files to scan (e.g. ../data/versioned_terminology/latest)",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=PREVIEW_THRESHOLD,
        help="Minimum row count before a dataset is built (default: %(default)s)",
    )
    parser.add_argument(
        "--dataset",
        action="append",
        dest="datasets",
        help="Restrict processing to specific dataset ids (can be repeated)",
    )
    parser.add_argument(
        "--output",
        help="Override output directory passed to build-sqlite.js",
    )
    parser.add_argument(
        "--label-prefix",
        help="Prefix labels recorded in datasets.json (optional)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the actions without running build-sqlite.js",
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep temporary files created for multi-part datasets",
    )
    parser.add_argument(
        "--shard-count",
        type=int,
        help="Force shard count for all builds (e.g., 1 for API use)",
    )
    parser.add_argument(
        "--max-shard-bytes",
        type=int,
        help="Override max shard size in bytes",
    )
    parser.add_argument(
        "--skip-preview",
        action="store_true",
        help="Do not emit preview.json for each dataset",
    )
    parser.add_argument(
        "--crosswalk",
        help="Header crosswalk JSON override passed to build-sqlite.js",
    )
    return parser.parse_args(argv)


def iter_source_files(path: Path) -> Iterator[Path]:
    if path.is_file():
        if path.name.endswith(SUPPORTED_SUFFIXES):
            yield path
        return
    if not path.is_dir():
        return
    for file_path in sorted(path.rglob("*")):
        if not file_path.is_file():
            continue
        name = file_path.name
        if name.endswith(SUPPORTED_SUFFIXES) and ".index" not in name:
            yield file_path


def dataset_key_for(path: Path) -> Tuple[str, Path]:
    """Return a stable dataset id from a source file path.

    Handles these patterns:
      - provider.csv_0_2_1.csv.gz   -> provider
      - provider_compressed.csv.gz  -> provider
      - other_provider_taxonomy.csv.gz -> other_provider_taxonomy
    """
    name = path.name
    without_gz = name[:-3] if name.endswith(".gz") else name

    # Prefer matching chunked naming: <base>.csv_<parts>.csv
    # Example: provider.csv_0_2_1.csv
    m = None
    import re as _re
    m = _re.match(r"^(?P<base>.+?)\.csv(?:_[0-9]+(?:_[0-9]+)*)?\.csv$", without_gz)
    if m:
        base = m.group("base")
    elif without_gz.endswith(".csv"):
        base = without_gz[:-4]
    else:
        base = without_gz

    # Normalise trailing _compressed
    if base.endswith("_compressed"):
        base = base[: -len("_compressed")]

    dataset_id = base
    return dataset_id, path


def group_datasets(files: Iterable[Path]) -> dict[str, List[Path]]:
    grouped: dict[str, List[Path]] = {}
    for file_path in files:
        dataset_id, original_path = dataset_key_for(file_path)
        grouped.setdefault(dataset_id, []).append(original_path)
    for paths in grouped.values():
        paths.sort()
    return grouped


def open_dataset(path: Path) -> Iterator[str]:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                yield line
    else:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                yield line


def count_rows(path: Path, threshold: int) -> int:
    """Return the number of data rows (excluding header) up to threshold+1."""
    lines = open_dataset(path)
    try:
        next(lines)  # header
    except StopIteration:
        return 0
    count = 0
    for _ in lines:
        count += 1
        if count > threshold:
            break
    return count


def combine_chunks(dataset_id: str, files: Sequence[Path]) -> Path:
    temp = tempfile.NamedTemporaryFile(prefix=f"{dataset_id}_", suffix=".csv", delete=False)
    temp_path = Path(temp.name)
    temp.close()
    with temp_path.open("w", encoding="utf-8") as sink:
        first_file = True
        for file_path in files:
            for idx, line in enumerate(open_dataset(file_path)):
                if first_file or idx > 0:
                    sink.write(line)
            first_file = False
    return temp_path


def build_sqlite(dataset_id: str, input_path: Path, args: argparse.Namespace) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    script_path = repo_root / "scripts" / "build-sqlite.js"
    command = ["node", str(script_path), "--input", str(input_path), "--dataset", dataset_id]
    if args.output:
        command.extend(["--output", args.output])
    if args.label_prefix:
        command.extend(["--label", f"{args.label_prefix}{dataset_id}"])
    if args.shard_count:
        command.extend(["--shard-count", str(int(args.shard_count))])
    if args.max_shard_bytes:
        command.extend(["--max-shard-bytes", str(int(args.max_shard_bytes))])
    if args.skip_preview:
        command.append("--skip-preview")
    if args.crosswalk:
        command.extend(["--crosswalk", args.crosswalk])
    if args.dry_run:
        print("DRY RUN:", shlex.join(command))
        return
    print(shlex.join(command))
    subprocess.run(command, cwd=repo_root, check=True)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    threshold = max(0, args.threshold)
    dataset_filter = {name.lower() for name in (args.datasets or [])}

    source_paths = [Path(src).resolve() for src in args.sources]
    files = []
    for source in source_paths:
        files.extend(iter_source_files(source))

    grouped = group_datasets(files)
    if not grouped:
        print("No datasets found.")
        return 0

    for dataset_id, paths in sorted(grouped.items()):
        # If both a master compressed copy and chunked files exist for this dataset,
        # prefer the master compressed file as the build input.
        def is_master_compressed(p: Path) -> bool:
            n = p.name.lower()
            return n.endswith("_compressed.csv.gz") or n.endswith("_compressed.csv")

        master_candidates = [p for p in paths if is_master_compressed(p)]
        if master_candidates:
            # Use the first master copy; ignore chunks
            paths = [sorted(master_candidates)[0]]
        if dataset_filter and dataset_id.lower() not in dataset_filter:
            continue

        estimated_rows = 0
        for file_path in paths:
            estimated_rows += count_rows(file_path, threshold)
            if estimated_rows > threshold:
                break

        if estimated_rows <= threshold:
            print(f"Skipping {dataset_id}: {estimated_rows} rows (<= {threshold}).")
            continue

        input_path = paths[0]
        temp_path: Path | None = None
        try:
            if len(paths) > 1:
                print(f"Combining {len(paths)} chunks for {dataset_id}...")
                temp_path = combine_chunks(dataset_id, paths)
                input_path = temp_path

            build_sqlite(dataset_id, input_path, args)
        finally:
            if temp_path and not args.keep_temp and not args.dry_run:
                try:
                    temp_path.unlink()
                except OSError:
                    pass

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
