# Deployment

This repo contains two deployable pieces:

- Frontend SPA (csv_viewer_app/) served by S3 + CloudFront.
- Search API (search_api/) on AWS Lambda behind API Gateway HTTP API, with SQLite files on EFS (synced from S3).

Prerequisites
- AWS CLI and SAM CLI installed and configured.
- An S3 bucket for the SPA (e.g., tuva-public-resources) and optionally a CloudFront distribution.
- An S3 bucket/prefix for API `.sqlite` objects (e.g., `tuva-public-resources/terminology-viewer/api_sqlite`).
- An EFS filesystem + Access Point in your VPC for the API to mount.

First‑time API deploy + EFS sync
1) Ensure `scripts/outputs/efs.json` contains your VPC and EFS settings.
2) Deploy the API and copy `.sqlite` from S3 to EFS:

```
make deploy-efs-sync \
  PROFILE=<aws-profile> \
  BUCKET=<assets-bucket> \
  PREFIX=terminology-viewer/api_sqlite \
  ORIGIN=https://<your-domain> \
  [STACK=TuvaSearchApi]
```

Notes
- `ORIGIN` updates Lambda CORS and the HTTP API CORS to match.
- The deploy script salts the build so config‑only changes (like CORS) publish a new version and move the `live` alias.

Frontend deploy
1) Make sure CloudFront’s OriginPath matches your `SPA_PREFIX` (e.g., `/terminology-viewer`).
2) Build once with the API base baked in and deploy:

```
make deploy-frontend \
  PROFILE=<aws-profile> \
  SPA_BUCKET=<spa-bucket> \
  SPA_PREFIX=terminology-viewer \
  [STACK=TuvaSearchApi] \
  [API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com] \
  [CF_DIST_ID=<distribution-id>]
```

Safety checks
- The deploy script fails if any file referenced by `asset-manifest.json` is missing in S3.
- We remove the web app manifest and unregister service workers in production to avoid PWA install prompts.

Weekly/routine
- Build and publish changed datasets, then sync EFS:

```
make build-publish-sync \
  PROFILE=<aws-profile> \
  [VERSION=latest] [THRESHOLD=1000] [SHARDS=1] \
  [BUCKET=tuva-public-resources] [PREFIX=terminology-viewer/api_sqlite] \
  [STACK=TuvaSearchApi]
```

- Update API CORS or code:

```
make deploy-api \
  PROFILE=<aws-profile> REGION=us-east-1 STACK=TuvaSearchApi \
  BUCKET=tuva-public-resources PREFIX=terminology-viewer/api_sqlite \
  ORIGIN=https://<your-domain>[,http://localhost:3000]
```

- EFS sync only for specific datasets:

```
make sync-efs PROFILE=<aws-profile> STACK=TuvaSearchApi DATASETS=ndc,loinc
```

Troubleshooting
- 404 main.*.js or blank page: CloudFront OriginPath doesn’t match `SPA_PREFIX` or S3 upload missing a hashed asset (the deploy script now verifies).
- API returns HTML with 200 OK: CloudFront not routing `/search`, `/count`, `/distinct` to API (if using same‑origin calls) or `REACT_APP_SEARCH_API_BASE_URL` not baked in (the Make target handles this).
- CORS mismatch: HTTP API CORS and/or Lambda env not aligned with your site — re‑run `make deploy-api ORIGIN=...`.
- Install app icon: removed by stripping the web app manifest and unregistering SW in production builds.

