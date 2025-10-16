import json
import os
import re
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import boto3

# Use the bundled SQLite with FTS5 from pysqlite3-binary
try:
    from pysqlite3 import dbapi2 as sqlite3  # type: ignore
except Exception:  # pragma: no cover
    import sqlite3  # fallback


S3_BUCKET = os.environ.get("S3_BUCKET", "")
S3_PREFIX = os.environ.get("S3_PREFIX", "api_sqlite").strip("/")
LOCAL_SQLITE_DIR = os.environ.get("LOCAL_SQLITE_DIR", "")
EFS_SQLITE_DIR = os.environ.get("EFS_SQLITE_DIR", "")
ALLOWED_DATASETS = {
    d.strip().lower() for d in os.environ.get("ALLOWED_DATASETS", "").split(",") if d.strip()
}
CORS_ALLOW_ORIGIN = os.environ.get("CORS_ALLOW_ORIGIN", "*")

_s3 = boto3.client("s3")
_db_lock = threading.Lock()
_db_cache: Dict[str, sqlite3.Connection] = {}
_schema_cache: Dict[str, List[str]] = {}

TOKEN_NORMALIZE_REGEX = re.compile(r"[^a-z0-9\-._\s]+")


def _normalize_string(value: Any) -> str:
    if value is None:
        return ""
    s = str(value).lower()
    s = TOKEN_NORMALIZE_REGEX.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _is_exact_numeric_query(tokens: List[str]) -> bool:
    return len(tokens) == 1 and re.fullmatch(r"\d{10}", tokens[0]) is not None


def _fts_match_for_query(raw_query: str) -> Optional[str]:
    normalized = _normalize_string(raw_query)
    if not normalized:
        return None
    tokens = [t for t in normalized.split(" ") if t]
    if not tokens:
        return None
    if _is_exact_numeric_query(tokens):
        return tokens[0]
    return " ".join(f"{t}*" for t in tokens)


def _ensure_db_path(dataset: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_.\-]", "_", dataset)
    local_dir = "/tmp/tuva_sqlite"
    os.makedirs(local_dir, exist_ok=True)
    local_path = os.path.join(local_dir, f"{safe}.sqlite")
    # Prefer EFS mount if available (read-only datasets)
    if EFS_SQLITE_DIR:
        efs_candidate = os.path.join(EFS_SQLITE_DIR, f"{safe}.sqlite")
        if os.path.exists(efs_candidate) and os.path.getsize(efs_candidate) > 0:
            return efs_candidate
    # Dev mode: use local sqlite directory if provided
    if LOCAL_SQLITE_DIR:
        # support both: <dir>/<dataset>.sqlite and <dir>/<dataset>/<dataset>.sqlite
        candidate1 = os.path.join(LOCAL_SQLITE_DIR, f"{safe}.sqlite")
        candidate2 = os.path.join(LOCAL_SQLITE_DIR, safe, f"{safe}.sqlite")
        for candidate in (candidate1, candidate2):
            if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
                return candidate
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        return local_path
    if not S3_BUCKET:
        # In local/dev mode, prefer a clearer message if LOCAL_SQLITE_DIR was provided
        if LOCAL_SQLITE_DIR:
            raise RuntimeError(f"Dataset '{safe}' not found in LOCAL_SQLITE_DIR: {LOCAL_SQLITE_DIR}")
        raise RuntimeError("S3_BUCKET env not set")
    key = f"{S3_PREFIX}/{safe}.sqlite" if S3_PREFIX else f"{safe}.sqlite"
    # Download
    with open(local_path, "wb") as f:
        _s3.download_fileobj(S3_BUCKET, key, f)
    return local_path


def _open_db(dataset: str) -> sqlite3.Connection:
    key = dataset.lower()
    with _db_lock:
        if key in _db_cache:
            return _db_cache[key]
        path = _ensure_db_path(key)
        # Open read-only and immutable for best performance over EFS
        try:
            uri = f"file:{os.path.abspath(path)}?mode=ro&immutable=1"
            conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        except Exception:
            # Fallback to normal open if URI fails for some reason
            conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Pragmas for read performance
        try:
            conn.execute("PRAGMA query_only=ON;")
            conn.execute("PRAGMA journal_mode=OFF;")
            conn.execute("PRAGMA synchronous=OFF;")
            conn.execute("PRAGMA temp_store=MEMORY;")
            conn.execute("PRAGMA mmap_size=268435456;")  # 256 MiB
            conn.execute("PRAGMA cache_size=-20000;")  # ~20k pages in memory
        except Exception:
            pass
        _db_cache[key] = conn
        return conn


def _allowed_dataset(dataset: str) -> bool:
    if not dataset:
        return False
    if not ALLOWED_DATASETS:
        return True
    return dataset.lower() in ALLOWED_DATASETS


def _get_narrow_columns(conn: sqlite3.Connection) -> List[str]:
    key = str(id(conn))
    if key in _schema_cache:
        return _schema_cache[key]
    cols: List[str] = []
    for row in conn.execute("PRAGMA table_info(t_raw)"):
        name = row[1]
        if name and name.lower() != "rowid":
            cols.append(name)
    _schema_cache[key] = cols
    return cols


def _build_filters_where(filters: List[dict], valid_cols: List[str]) -> Tuple[str, List[Any]]:
    if not filters:
        return "", []
    valid = set(c.lower() for c in valid_cols)
    parts: List[str] = []
    params: List[Any] = []
    for f in filters:
        col = str(f.get("column", "")).strip()
        if not col or col.lower() not in valid:
            continue
        op = str(f.get("operator", "contains")).lower()
        values = f.get("values") if isinstance(f.get("values"), list) else None
        text = f.get("text") if isinstance(f.get("text"), str) else ""
        if values:
            uniq = list(dict.fromkeys(str(v) for v in values))
            if not uniq:
                continue
            placeholders = ",".join(["?"] * len(uniq))
            parts.append(f'"{col}" IN ({placeholders})')
            params.extend(uniq)
            continue
        if not text:
            continue
        if op == "equals":
            parts.append(f'"{col}" = ?')
            params.append(text)
        elif op in ("startswith", "starts"):
            parts.append(f'"{col}" LIKE ?')
            params.append(text + "%")
        elif op in ("endswith", "ends"):
            parts.append(f'"{col}" LIKE ?')
            params.append("%" + text)
        else:  # contains
            parts.append(f'"{col}" LIKE ?')
            params.append("%" + text + "%")
    return (" AND ".join(parts), params) if parts else ("", [])


def _parse_filters(raw: Optional[str]) -> List[dict]:
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except Exception:
        return []


def _search(conn: sqlite3.Connection, dataset: str, query: str, limit: int, offset: int, filters: List[dict]) -> Dict[str, Any]:
    t0 = time.time()
    cols = _get_narrow_columns(conn)
    match = _fts_match_for_query(query)

    where_sql, where_params = _build_filters_where(filters, cols)

    rows: List[sqlite3.Row] = []
    total = 0

    # If there is neither a query nor filters, return empty (UI shows preview).
    if not match and not where_sql:
        return {
            "datasetId": dataset,
            "total": 0,
            "items": [],
            "elapsedMs": int((time.time() - t0) * 1000),
            "bytesFetched": 0,
        }

    params: List[Any] = []
    # Base selects for counting vs paging
    base_select_count = 'SELECT rowid FROM t_fts WHERE t_fts MATCH ?'
    base_select_page = f'{base_select_count} LIMIT ? OFFSET ?'
    base_params_count: List[Any] = [match]
    base_params_page: List[Any] = [match, limit, offset]

    if match:
        # Count first (unbounded)
        if where_sql:
            count_sql = f'''SELECT COUNT(*) AS c
                            FROM t_raw r
                            WHERE r.rowid IN ({base_select_count}) AND {where_sql}'''
            total = conn.execute(count_sql, base_params_count + where_params).fetchone()[0]
        else:
            total = conn.execute(f"SELECT COUNT(*) AS c FROM ({base_select_count})", base_params_count).fetchone()[0]

        # Page rowids, then fetch rows preserving order
        rowids = [r[0] for r in conn.execute(base_select_page, base_params_page).fetchall()]
        if rowids:
            placeholders = ",".join(["?"] * len(rowids))
            order_case = " ".join([f"WHEN ? THEN {i}" for i, _ in enumerate(rowids)])
            order_params = rowids[:]
            select_cols = ", ".join([f'"{c}"' for c in cols])
            sql = f"""
                SELECT rowid, {select_cols}
                FROM t_raw
                WHERE rowid IN ({placeholders})
                ORDER BY CASE rowid {order_case} END
            """
            rows = conn.execute(sql, rowids + order_params).fetchall()
    else:
        # Filter-only query (no MATCH)
        count_sql = f"SELECT COUNT(*) AS c FROM t_raw r WHERE {where_sql}"
        total = conn.execute(count_sql, where_params).fetchone()[0]
        select_cols = ", ".join([f'"{c}"' for c in cols])
        sql = f"SELECT rowid, {select_cols} FROM t_raw r WHERE {where_sql} LIMIT ? OFFSET ?"
        rows = conn.execute(sql, where_params + [limit, offset]).fetchall()

    items = []
    for r in rows:
        item = {"rowid": r["rowid"]}
        for c in cols:
            item[c] = r[c]
        items.append(item)

    t1 = time.time()
    return {
        "datasetId": dataset,
        "total": int(total),
        "items": items,
        "elapsedMs": int((t1 - t0) * 1000),
        "bytesFetched": 0,
    }


def _count(conn: sqlite3.Connection, dataset: str, query: str, filters: List[dict]) -> Dict[str, Any]:
    t0 = time.time()
    cols = _get_narrow_columns(conn)
    match = _fts_match_for_query(query)
    where_sql, where_params = _build_filters_where(filters, cols)

    # Align with UI: if no query and no filters, return 0
    if not match and not where_sql:
        return {
            "datasetId": dataset,
            "total": 0,
            "elapsedMs": int((time.time() - t0) * 1000),
            "bytesFetched": 0,
        }

    if match:
        if where_sql:
            sql = f'''SELECT COUNT(*) AS c
                      FROM t_raw r
                      WHERE r.rowid IN (SELECT rowid FROM t_fts WHERE t_fts MATCH ?) AND {where_sql}'''
            params = [match] + where_params
        else:
            sql = "SELECT COUNT(*) AS c FROM t_fts WHERE t_fts MATCH ?"
            params = [match]
    else:
        sql = f"SELECT COUNT(*) AS c FROM t_raw r WHERE {where_sql}"
        params = where_params

    c = conn.execute(sql, params).fetchone()[0]
    return {
        "datasetId": dataset,
        "total": int(c),
        "elapsedMs": int((time.time() - t0) * 1000),
        "bytesFetched": 0,
    }


def _distinct(conn: sqlite3.Connection, dataset: str, column: str, limit: int, query: str, filters: List[dict]) -> Dict[str, Any]:
    t0 = time.time()
    cols = _get_narrow_columns(conn)
    colset = set(c.lower() for c in cols)
    if column.lower() not in colset:
        raise ValueError("Invalid column")

    match = _fts_match_for_query(query)
    where_sql, where_params = _build_filters_where(filters, cols)
    qualified_col = f'"{column}"'

    if match:
        sql = f'''SELECT {qualified_col} AS value, COUNT(*) AS c
                  FROM t_raw r
                  WHERE r.rowid IN (SELECT rowid FROM t_fts WHERE t_fts MATCH ?)
                    {'AND ' + where_sql if where_sql else ''}
                  GROUP BY {qualified_col}
                  ORDER BY c DESC
                  LIMIT ?'''
        params = [match] + where_params + [limit]
    elif where_sql:
        sql = f'''SELECT {qualified_col} AS value, COUNT(*) AS c
                  FROM t_raw r
                  WHERE {where_sql}
                  GROUP BY {qualified_col}
                  ORDER BY c DESC
                  LIMIT ?'''
        params = where_params + [limit]
    else:
        sql = f'''SELECT {qualified_col} AS value, COUNT(*) AS c
                  FROM t_raw r
                  GROUP BY {qualified_col}
                  ORDER BY c DESC
                  LIMIT ?'''
        params = [limit]

    rows = conn.execute(sql, params).fetchall()
    items = [{"value": r["value"], "count": int(r["c"])} for r in rows]

    return {
        "datasetId": dataset,
        "column": column,
        "items": items,
        "elapsedMs": int((time.time() - t0) * 1000),
    }


def _parse_allowed_origins(cfg: str) -> List[str]:
    vals = [o.strip() for o in (cfg or "").split(",")]
    return [v for v in vals if v]


def _cors_origin_for_event(event: Dict[str, Any]) -> Tuple[str, bool]:
    # Returns (origin_value, vary)
    cfg = CORS_ALLOW_ORIGIN or ""
    if cfg == "*":
        return "*", False
    allowed = set(_parse_allowed_origins(cfg))
    # Extract request Origin header (case-insensitive)
    headers = event.get("headers") or {}
    req_origin = None
    if isinstance(headers, dict):
        # API Gateway may lower-case header keys
        for k in ("origin", "Origin"):  # quick check first
            if k in headers and isinstance(headers[k], str):
                req_origin = headers[k]
                break
        if req_origin is None:
            # fallback: find any key case-insensitively
            for k, v in headers.items():
                if str(k).lower() == "origin" and isinstance(v, str):
                    req_origin = v
                    break
    if req_origin and req_origin in allowed:
        return req_origin, True
    # No match: return first configured to be safe; browsers will block if mismatched
    first = next(iter(allowed), "*")
    return (first, True if first != "*" else False)


def _bad_request(msg: str, code: int = 400, event: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return _response({"error": msg}, status=code, event=event)


def _response(body: Dict[str, Any], status: int = 200, event: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    origin = CORS_ALLOW_ORIGIN
    vary = False
    if event is not None:
        try:
            origin, vary = _cors_origin_for_event(event)
        except Exception:
            origin = CORS_ALLOW_ORIGIN
            vary = False
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    if vary:
        headers["Vary"] = "Origin"
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body),
    }


def _get_path(event: Dict[str, Any]) -> str:
    # HTTP API v2
    http = event.get("requestContext", {}).get("http", {})
    if http and "path" in http:
        return str(http.get("path"))
    # REST API
    return str(event.get("path", "/"))


def _get_qs(event: Dict[str, Any]) -> Dict[str, str]:
    raw = event.get("queryStringParameters") or {}
    return {k: v for k, v in raw.items() if isinstance(v, str)}


def handler(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    if event.get("httpMethod") == "OPTIONS":
        return _response({"ok": True}, event=event)

    path = _get_path(event).rstrip("/")
    qs = _get_qs(event)

    dataset = (qs.get("dataset") or "").strip()
    if not _allowed_dataset(dataset):
        return _bad_request("Invalid or disallowed dataset", event=event)

    try:
        conn = _open_db(dataset)
    except Exception as e:
        return _bad_request(f"Failed to open dataset: {e}", event=event)

    try:
        if path.endswith("/search"):
            q = qs.get("query") or ""
            limit = max(1, min(int(qs.get("limit") or 50), 500))
            offset = max(0, int(qs.get("offset") or 0))
            filters = _parse_filters(qs.get("filters"))
            payload = _search(conn, dataset, q, limit, offset, filters)
            return _response(payload, event=event)
        elif path.endswith("/count"):
            q = qs.get("query") or ""
            filters = _parse_filters(qs.get("filters"))
            payload = _count(conn, dataset, q, filters)
            return _response(payload, event=event)
        elif path.endswith("/distinct"):
            column = qs.get("column") or ""
            if not column:
                return _bad_request("Missing column", event=event)
            q = qs.get("query") or ""
            limit = max(1, min(int(qs.get("limit") or 25), 200))
            filters = _parse_filters(qs.get("filters"))
            payload = _distinct(conn, dataset, column, limit, q, filters)
            return _response(payload, event=event)
        else:
            return _bad_request("Unknown path", 404, event=event)
    except ValueError as ve:
        return _bad_request(str(ve), event=event)
    except Exception as e:
        return _response({"error": str(e)}, status=500, event=event)


# Local quick test (optional)
if __name__ == "__main__":  # pragma: no cover
    # Simulate an API Gateway event
    ev = {
        "requestContext": {"http": {"path": "/search"}},
        "queryStringParameters": {"dataset": "ndc", "query": "acetamin", "limit": "25"},
    }
    print(handler(ev, None))
