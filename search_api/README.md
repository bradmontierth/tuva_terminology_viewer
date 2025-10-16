Tuva Terminology Viewer – Search API (Serverless)

Overview
- A minimal AWS Lambda (Python) API that queries the SQLite FTS bundles server‑side and returns compact JSON.
- Cuts client data transfer from tens of MB to a few KB and improves typical search latency 5–20×.
- Works with the existing datasets you build; for the API, prefer single‑shard SQLite per dataset.

Endpoints
- GET /search?dataset=ID&query=TEXT&limit=50&offset=0&filters=JSON
- GET /count?dataset=ID&query=TEXT&filters=JSON
- GET /distinct?dataset=ID&column=NAME&limit=25&query=TEXT&filters=JSON

Response (search)
{
  "datasetId": "ID",
  "total": 12345,
  "items": [{"rowid": 1, "col1": "...", ...}, ...],
  "elapsedMs": 142,
  "bytesFetched": 0
}

S3 Layout
- Store one `.sqlite` DB per dataset under a common prefix (no HTTP-sharding needed server‑side):
  s3://<BUCKET>/<PREFIX>/<dataset>.sqlite

Build a DB for API
- From `csv_viewer_app/` (or your build host):
  - npm run build:sqlite -- --input <csv.gz> --dataset <id> --shard-count 1
  - Upload `public/data/sqlite/<id>/<id>.sqlite` to your bucket/prefix (the UI also uses the generated manifest/preview)

Environment Variables (Lambda)
- S3_BUCKET: your bucket (e.g., tuva-terminology-viewer)
- S3_PREFIX: key prefix for sqlite files (e.g., api_sqlite)
- ALLOWED_DATASETS (optional): CSV allowlist, e.g. "ndc,providers,rxnorm"
- CORS_ALLOW_ORIGIN (optional): e.g., "*" or your site origin

Local testing (no AWS)
- Build single-shard DBs locally (see above). You can point `LOCAL_SQLITE_DIR` either to a dataset subfolder
  (`csv_viewer_app/public/data/sqlite/ndc`) or to the parent folder containing many datasets
  (`csv_viewer_app/public/data/sqlite`).
- Run the local API server:
  - pip install -r requirements.txt -r requirements-dev.txt
  - LOCAL_SQLITE_DIR=csv_viewer_app/public/data/sqlite HOST=127.0.0.1 PORT=8000 python3 search_api/local_server.py
  - Call it, e.g., http://127.0.0.1:8000/search?dataset=ndc&query=acetamin&limit=50
- Point the UI to it:
  - REACT_APP_SEARCH_BACKEND=api REACT_APP_SEARCH_API_BASE_URL=http://127.0.0.1:8000 npm start

Deploy (AWS SAM minimal)
1) Install SAM CLI, then from repo root:
   - sam build --guided --template-file search_api/template.yaml
   - sam deploy --guided
2) After deploy, note the API endpoint URL.

Production (Make targets)
- From repo root you can deploy/update the API and sync EFS with pre-wired params:
  - `make deploy-api PROFILE=<aws-profile> STACK=TuvaSearchApi BUCKET=<assets-bucket> PREFIX=terminology-viewer/api_sqlite ORIGIN=https://<your-domain>`
  - `make deploy-efs-sync PROFILE=<aws-profile> BUCKET=<assets-bucket> PREFIX=terminology-viewer/api_sqlite ORIGIN=https://<your-domain>`

Front-end wiring
- In `csv_viewer_app` build, set:
  - REACT_APP_SEARCH_BACKEND=api
  - REACT_APP_SEARCH_API_BASE_URL=https://<api-id>.execute-api.<region>.amazonaws.com/Prod
- The UI will continue to fetch preview/manifest as before, but route search/count/distinct to the API.

Notes
- Lambda caches the SQLite file in /tmp across warm invocations for speed.
- pysqlite3-binary bundles SQLite with FTS5 enabled; no native build steps.
- For larger/hot datasets, you can keep one DB per dataset or split by category as needed.
