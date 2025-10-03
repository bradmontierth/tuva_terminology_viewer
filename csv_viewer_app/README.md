# Tuva Terminology Viewer

The CSV viewer is responsible for presenting Tuva's public terminology exports.
In addition to the standard Create React App scripts, the project includes
helpers for generating the header crosswalk JSON and the SQLite bundles that
power the streaming search experience in production.

## Header Crosswalk

This viewer hydrates CSV headers from the Tuva dbt project so that exported
datasets render with friendly column names.

- `npm run generate:crosswalk` builds `public/data/header-crosswalk.json` by
  inspecting every tagged release in the [`tuva`](https://github.com/tuva-health/tuva)
  repository. The script keeps a shallow clone under `scripts/.cache/tuva`
  (ignored in git).
- The crosswalk step runs automatically before `npm start`, `npm run build`,
  and `npm test`. To skip a refresh you can set `TUVA_CROSSWALK_SKIP_FETCH=1`
  (reuse the existing clone) or `TUVA_CROSSWALK_DISABLE=1` (skip the step
  entirely).
- Set `TUVA_REPO_URL`, `TUVA_REPO_DIR`, or `TUVA_CROSSWALK_OUTPUT` to override
  the default source repository, cache location, or output file.
- When working without network access, generate the crosswalk once manually (or
  copy an existing JSON file) and reuse it locally via
  `TUVA_CROSSWALK_SKIP_FETCH=1`.

## File identity crosswalk

The app precomputes a file identity crosswalk (used to detect when files are
unchanged across versions) as part of the `prestart`, `prebuild`, and `pretest`
scripts.

- To disable identity calculation on run, set `TUVA_IDENTITY_DISABLE=1`.
- To skip only the remote listing/fetch while reusing cached data, set
  `TUVA_IDENTITY_SKIP_FETCH=1`.
- Advanced: override inputs/outputs with `TUVA_DATA_BASE_URL`, `TUVA_FOLDERS`,
  and `TUVA_IDENTITY_OUTPUT`.

## SQLite search bundles

- `npm run build:sqlite -- --input <path/to/dataset.csv[.gz]> --dataset <id>`
  prepares the SQLite/FTS artefacts used by the worker. The command supports
  gzipped Tuva exports out of the box and writes the output under
  `public/data/sqlite/<datasetId>/` while refreshing
  `public/data/sqlite/datasets.json`.
- `npm run build:sqlite:batch -- <source>` scans an entire folder (for example
  `../data/versioned_terminology/latest`) and invokes the builder for every
  dataset whose row-count exceeds the preview threshold. Files ending in
  `_compressed` are skipped automatically because they duplicate the canonical
  exports.
- `npm run sync:sqlite-assets -- <sources...>` syncs the published bundle set
  down from S3 (`s3://tuva-public-resources/terminology_viewer_sqlite` by
  default), runs the batch builder, and pushes refreshed artefacts back to the
  same prefix. Add `--download-only` to hydrate the local cache without
  rebuilding, or `--skip-download` / `--skip-upload` to control each sync
  direction.
- Column headers come from `public/data/header-crosswalk.json` when available;
  pass `--crosswalk` if you need to point at a different file.
- Sharding is automatic once the estimated shard size exceeds ~120 MB. Override
  with `--max-shard-bytes`, `--shard-count`, or `--shard-key` if you need
  deterministic splits.
- Preview payloads can be disabled with `--skip-preview` or resized with
  `--preview-limit`.
- `npm run prepare:sqlite-assets` stages the `sql.js` wasm and worker bundles
  into `public/sqljs/`; this runs automatically before `npm start`, `npm test`,
  and `npm run build`.

### Dev environment variables

- `REACT_APP_SQLITE_SOURCE` controls where the search worker fetches SQLite
  shards while running `npm start`:
  - `remote` – use the S3-hosted bundles referenced by the manifests
  - `local` – use `public/data/sqlite/<datasetId>/manifest.json` and local shards
  - unset/other – auto: prefer local when the app is served on a localhost host

  Example (force remote on localhost):

  `REACT_APP_USE_S3_PROXY=true REACT_APP_SQLITE_SOURCE=remote npm start`

- `REACT_APP_USE_S3_PROXY` toggles the dev proxy used for S3 object listings on
  localhost. Set to `true` to route `GET /s3-proxy/?list-type=2...` to the S3
  bucket (recommended). If set to `false`, listings are attempted against the
  dev server origin and will typically fail for remote buckets.

- `REACT_APP_DATA_BASE_URL` can override the S3 base (e.g., a different bucket
  or CDN origin). Default is `https://tuva-public-resources.s3.amazonaws.com`.

- `REACT_APP_FETCH_CROSSWALKS` controls whether the app fetches crosswalk JSON
  files (`/data/header-crosswalk.json` and `/data/file-identity-crosswalk.json`) at
  runtime. By default, production builds fetch and development uses the bundled
  fallbacks to avoid noisy console errors when files aren’t present.
  - Set to `true` to always fetch
  - Set to `false` to never fetch (always use bundled)

- `REACT_APP_IDENTITY_LIVE` controls whether the app performs live identity
  comparisons against S3 when the precomputed identity crosswalk does not have
  an exact run for the current file/version. Defaults to disabled when
  `REACT_APP_FETCH_CROSSWALKS=true`, and enabled otherwise. Set to `false` to
  always avoid S3 comparisons and rely only on the precomputed crosswalk.

- `REACT_APP_OFFLINE_MODE` avoids all S3 listings and identity lookups. Versions
  and file lists are built from the precomputed identity crosswalk JSON.

### Crosswalk panel

The viewer includes a simple in-app crosswalk panel (toggle via “View Crosswalk”
under the file title) showing the resolved header labels for the active file and
its identity run (versions with identical content). The panel uses the
pre-generated JSONs from `public/data/` when available, falling back to the
bundled copies under `src/generated/`.

## Available Scripts

In the project directory, you can run:

- `npm start` – Runs the app in development mode.
- `npm test` – Launches the test runner in interactive watch mode.
- `npm run build` – Builds the app for production to the `build` folder.
- `npm run eject` – Ejects the Create React App configuration.

See the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started)
for more details about the default scripts.

## S3 Deployment

- The production build reads `.env.production` to set `REACT_APP_DATA_BASE_URL` to `https://tuva-terminology-viewer.s3.amazonaws.com` and force the SQLite catalog to load from S3 (`REACT_APP_SQLITE_SOURCE=remote`).
- To deploy the built app to your public S3 bucket:
  - `csv_viewer_app/scripts/deploy-to-s3.sh tuva-terminology-viewer` – builds and syncs `build/` to the bucket.
  - Optional: `--website` enables S3 website hosting (HTTP only). Prefer CloudFront for HTTPS.
- To copy the data prefixes from the existing public bucket to the new one for this POC:
  - `csv_viewer_app/scripts/s3-sync-from-public.sh tuva-terminology-viewer --src tuva-public-resources`
    - Fully syncs: `versioned_terminology/`, `versioned_value_sets/`, `reference-data/` (skips `reference-data/2022 Census Shapefiles/`).
    - Optional: include the published SQLite bundles (legacy layout) with `--include-remote-sqlite` to sync `terminology_viewer_sqlite/`.
    - Provider data is handled specially to avoid huge transfers:
      - Fully syncs `versioned_provider_data/latest` and the last 2 concrete versions; older versions copy only objects smaller than 20MB (override with `--large-threshold-mb`).
      - Adjust how many provider versions to fully sync with `--large-limit N`, skip `latest` with `--no-large-latest`, and tune parallelism with `--jobs N` (default 16).
    - Uses `--size-only` on sync by default (skips files with identical sizes). Disable with `--no-size-only` for stricter comparisons.
- To apply a permissive CORS policy (needed for cross-origin S3 listings and Range requests used by SQLite search):
  - `csv_viewer_app/scripts/apply-s3-cors.sh tuva-terminology-viewer`
  - CORS config lives at `csv_viewer_app/scripts/s3-cors.json`.

## CloudFront (HTTPS SPA hosting)

- Make the bucket public (list + read):
  - `csv_viewer_app/scripts/apply-s3-bucket-policy.sh tuva-terminology-viewer`
- Create a CloudFront distribution for the SPA (HTTPS, SPA routing fallback):
  - `csv_viewer_app/scripts/create-cloudfront.sh tuva-terminology-viewer`
  - This prints `DistributionId` and `DomainName` (e.g., `dXXXX.cloudfront.net`).
- Deploy new app builds and invalidate CloudFront:
  - `csv_viewer_app/scripts/deploy-to-s3.sh tuva-terminology-viewer --cf-dist-id <DistributionId>`
  - or: `csv_viewer_app/scripts/invalidate-cloudfront.sh <DistributionId>` after deploy.
- Data access: the app fetches data directly from the S3 REST endpoint
  (`https://tuva-terminology-viewer.s3.amazonaws.com`) via `.env.production`. CORS allows this.
  If you prefer to serve data through CloudFront too, set `REACT_APP_DATA_BASE_URL` to the CloudFront
  domain and ensure query strings are forwarded for S3 listings.
- New helper scripts
  - `./scripts/local-build-and-serve.sh` – Sync CSV inputs from S3 to `data/`,
    generate the header and identity crosswalks, build SQLite bundles for one
    or more versions, and start the dev server on localhost.
    - Example: `./scripts/local-build-and-serve.sh --src-bucket tuva-public-resources --versions 0.15.3`
  - `./scripts/publish-assets.sh` – Publish previously built crosswalks and
    SQLite bundles to an S3 bucket and optionally invalidate CloudFront.
    - Example: `./scripts/publish-assets.sh --dest-bucket tuva-terminology-viewer --cf-dist-id <DIST_ID>`
  - `./scripts/build-and-publish-assets.sh` – One-shot build-and-publish that
    combines input sync, crosswalk generation, SQLite build, and publish.
    - Example: `./scripts/build-and-publish-assets.sh --dest-bucket tuva-terminology-viewer --versions 0.15.3 --cf-dist-id <DIST_ID>`
