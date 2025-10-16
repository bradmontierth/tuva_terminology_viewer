# Tuva Terminology Viewer

Public SPA + serverless search API for exploring Tuva terminology.

What we run in production
- Frontend SPA on S3 + CloudFront (at your domain). Built from `csv_viewer_app/` and uses the API backend.
- Search API on AWS (Lambda + API Gateway HTTP API + EFS for `.sqlite`). Deployed with SAM from `search_api/`.

Quick start (prod)
- First-time API + EFS deploy and sync (reads VPC/EFS params from `scripts/outputs/efs.json`):
  - `make deploy-efs-sync PROFILE=<aws> BUCKET=<assets-bucket> PREFIX=terminology-viewer/api_sqlite ORIGIN=https://<your-domain>`
- Frontend deploy (uses API Url from the stack unless you pass `API_URL`):
  - `make deploy-frontend PROFILE=<aws> SPA_BUCKET=<spa-bucket> SPA_PREFIX=terminology-viewer [CF_DIST_ID=<dist>] [STACK=TuvaSearchApi] [API_URL=https://...execute-api...]`
- Weekly ops (rebuild changed datasets, publish to S3, sync EFS):
  - `make build-publish-sync PROFILE=<aws> [VERSION=latest] [THRESHOLD=1000] [SHARDS=1] [STACK=TuvaSearchApi]`

Maintenance cheatsheet
- Update API CORS or code: `make deploy-api PROFILE=<aws> STACK=TuvaSearchApi ORIGIN=https://<your-domain> BUCKET=<assets-bucket> PREFIX=terminology-viewer/api_sqlite`
- Sync EFS after adding new `.sqlite` objects: `make sync-efs PROFILE=<aws> [STACK=TuvaSearchApi] [DATASETS=ndc,loinc]`
- Local dev (dataset + local API + CRA): `make dev DATASET=ndc INPUT=/path/ndc.csv.gz PORT=8000`

Docs
- Deployment details: docs/DEPLOYMENT.md
- Environment variables (frontend + API): docs/ENVIRONMENT.md
