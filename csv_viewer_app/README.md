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

## Available Scripts

In the project directory, you can run:

- `npm start` – Runs the app in development mode.
- `npm test` – Launches the test runner in interactive watch mode.
- `npm run build` – Builds the app for production to the `build` folder.
- `npm run eject` – Ejects the Create React App configuration.

See the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started)
for more details about the default scripts.
