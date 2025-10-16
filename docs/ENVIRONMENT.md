# Environment Variables

Frontend (csv_viewer_app)
- PUBLIC_URL: Base path for assets when hosting under a subpath.
- REACT_APP_SEARCH_BACKEND: `api` (default) or `worker`.
- REACT_APP_SEARCH_API_BASE_URL: Base URL for API when `SEARCH_BACKEND=api`. If unset, same‑origin (`/search`, etc.).
- REACT_APP_DATA_BASE_URL: Base URL for data listings and files (defaults to public S3).
- REACT_APP_DISABLE_SQLITE_SW: `1` disables registering the sqlite service worker.
- REACT_APP_FORCE_SW_UNREGISTER_ALL: `1` unregisters any existing service workers on load (prevents PWA install prompt).
- REACT_APP_SQLITE_SOURCE: dev only — `local`, `remote`, or auto (unset).
- REACT_APP_DEV_API_PROXY: dev only — proxy target for `/search`, `/count`, `/distinct` when running `npm start`.
- REACT_APP_FETCH_CROSSWALKS: `true|false` — control fetching header/file crosswalks at runtime.
- REACT_APP_IDENTITY_LIVE: `true|false` — enable live identity checks when crosswalk is partial.
- REACT_APP_OFFLINE_MODE: `true|false` — avoid S3 listings and identity lookups.

API (search_api)
- S3_BUCKET: Bucket containing `<dataset>.sqlite`.
- S3_PREFIX: Key prefix for sqlite files (e.g., `terminology-viewer/api_sqlite`).
- EFS_SQLITE_DIR: Mount path where EFS is attached inside Lambda (default `/mnt/efs`).
- LOCAL_SQLITE_DIR: Dev only — read sqlite from local path.
- ALLOWED_DATASETS: Optional CSV allowlist (e.g., `ndc,providers`). Empty = allow all.
- CORS_ALLOW_ORIGIN: `*` or CSV of origins to allow (e.g., `https://terminology.thetuvaproject.com,http://localhost:3000`).
- Provisioned concurrency and alias are managed by SAM (AutoPublishAlias=`live`).

Make variables (selected)
- PROFILE / REGION: AWS CLI profile and region.
- STACK: CloudFormation stack name for the API (default `TuvaSearchApi`).
- SPA_BUCKET / SPA_PREFIX: Destination for the SPA deploy. OriginPath in CloudFront should match `SPA_PREFIX`.
- BUCKET / PREFIX: Source bucket/prefix for API sqlite.
- CF_DIST_ID: CloudFront distribution to invalidate after SPA deploy.
- VERSION / THRESHOLD / SHARDS: Controls what datasets are rebuilt and how.

