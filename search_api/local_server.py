#!/usr/bin/env python3
import os
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Optional

from handler import _open_db, _search, _count, _distinct, _allowed_dataset

app = FastAPI(title="Tuva Search API (local)")
allow_origin = os.environ.get("CORS_ALLOW_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_origin == "*" else [allow_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/search")
def search(dataset: str, query: str = "", limit: int = 50, offset: int = 0, filters: Optional[str] = None):
    if not _allowed_dataset(dataset):
        raise HTTPException(status_code=400, detail="Invalid or disallowed dataset")
    try:
        conn = _open_db(dataset)
    except Exception as e:
        # Surface a clear error when a dataset DB is not available locally
        raise HTTPException(status_code=404, detail=f"Dataset not available locally: {dataset}. {e}")
    try:
        payload = _search(conn, dataset, query or "", max(1, min(limit, 500)), max(0, offset), __import__('json').loads(filters) if filters else [])
        return JSONResponse(payload)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Convenience: support accidental calls to the root path with search params during dev
@app.get("/")
def root_search(dataset: Optional[str] = None,
                query: str = "",
                limit: int = 50,
                offset: int = 0,
                column: Optional[str] = None,
                filters: Optional[str] = None):
    if not dataset:
        # Help message
        return JSONResponse({
            "ok": True,
            "message": "Use /search, /count, or /distinct. Example: /search?dataset=ndc&query=acetamin&limit=50",
            "endpoints": ["/search", "/count", "/distinct"],
        })
    # If a column is provided, treat as /distinct for dev convenience
    if column:
        return distinct(dataset=dataset, column=column, limit=limit, query=query, filters=filters)
    # Otherwise treat as a /search request
    return search(dataset=dataset, query=query, limit=limit, offset=offset, filters=filters)


@app.get("/count")
def count(dataset: str, query: str = "", filters: Optional[str] = None):
    if not _allowed_dataset(dataset):
        raise HTTPException(status_code=400, detail="Invalid or disallowed dataset")
    try:
        conn = _open_db(dataset)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Dataset not available locally: {dataset}. {e}")
    try:
        payload = _count(conn, dataset, query or "", __import__('json').loads(filters) if filters else [])
        return JSONResponse(payload)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/distinct")
def distinct(dataset: str, column: str, limit: int = 25, query: str = "", filters: Optional[str] = None):
    if not _allowed_dataset(dataset):
        raise HTTPException(status_code=400, detail="Invalid or disallowed dataset")
    try:
        conn = _open_db(dataset)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Dataset not available locally: {dataset}. {e}")
    try:
        payload = _distinct(conn, dataset, column, max(1, min(limit, 200)), query or "", __import__('json').loads(filters) if filters else [])
        return JSONResponse(payload)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Example: LOCAL_SQLITE_DIR=../csv_viewer_app/public/data/sqlite/ndc uvicorn ...
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
