# Tuva Terminology Viewer

This application is for viewing the terminology data publicly available from The Tuva Project.

# Testing Locally

1. In Terminal `cd csv_viewer_app` to go to that folder.
2. Run `npm install` the first time to pull the app and worker dependencies.
3. Build one or more SQLite bundles for the datasets you want to browse. The script understands raw `.csv` files and gzipped exports that follow the Tuva naming convention:
   ```bash
   node scripts/build-sqlite.js \
     --input ../data/versioned_terminology/latest/admit_source.csv_0_0_0.csv.gz \
     --dataset admit_source
   ```
   This emits `public/data/sqlite/admit_source/` (manifest, preview, SQLite shard) and keeps `public/data/sqlite/datasets.json` in sync so the UI can discover the dataset.
   For larger batches you can run `python scripts/build-sqlite-batch.py ../data/versioned_terminology/latest` to process every dataset above the preview threshold automatically; the helper skips `_compressed` duplicates so only canonical exports are ingested.
   To reuse published bundles or push updates to S3 in one go, run:
   ```bash
   python scripts/sync-sqlite-assets.py \
     ../data/versioned_terminology/latest ../data/versioned_value_sets/latest
   ```
   This syncs the existing S3 bundles into `public/data/sqlite/`, rebuilds any datasets above the threshold, and uploads the refreshed artefacts back to the same prefix.
4. Start the dev server with `npm start`. The `prestart` hook runs `npm run prepare:sqlite-assets`, which stages the `sql.js` WebAssembly and worker assets into `public/sqljs/` the first time.
5. Open the provided link to explore the locally generated datasets.

Repeat step 3 for every dataset you want available in the viewer. Re-running the script replaces the existing bundle.

## Building SQLite search bundles

The viewer now streams search results from on-disk SQLite databases that contain both the raw rows (`t_raw`) and a Unicode FTS5 index (`t_fts`). Use `scripts/build-sqlite.js` to prepare these assets offline:

```
node scripts/build-sqlite.js --input <path/to/dataset.csv[.gz]> --dataset <id>
```

Key behaviours:
- Headers are resolved from `public/data/header-crosswalk.json` when available, so seeds without an explicit header row still map to friendly column names. Pass `--crosswalk` to override the path.
- Limits such as the number of value columns indexed are driven by `src/config/limits.json`. Use `--limits` to point at a different file, or adjust the overrides there (for example to cap wide provider datasets).
- Outputs land under `public/data/sqlite/<datasetId>/` and include the SQLite database (sharded when the uncompressed size exceeds the default 120 MB budget), an optional preview snapshot, and routing headers when multiple shards are created. `datasets.json` is updated automatically so the React app lists every dataset you build.
- Gzipped exports (`*.csv.gz` or chunked `*.csv_*_*.csv.gz`) are decompressed on the fly; there is no need to expand them manually before running the script.

Useful options:
- `--output` chooses a different destination directory (defaults to `public/data/sqlite`).
- `--label` overrides the display label recorded in `datasets.json` and the manifest.
- `--shard-count`, `--max-shard-bytes`, and `--shard-key` control sharding behaviour when you need to stay under GitHub Pages artefact limits.
- `--preview-limit` or `--skip-preview` adjust the preview JSON payload used by the UI before the first search completes.

After copying new bundles into `public/data/sqlite/`, refresh the browser and (optionally) click **Clear Downloaded Data** in the viewer to flush any cached SQLite pages or wasm artefacts from prior runs.

### S3 workflow

- `python scripts/build-sqlite-batch.py <source>` scans an entire folder (for example `../data/versioned_terminology/latest`) and invokes the builder for every dataset whose row-count exceeds the preview threshold. Files ending in `_compressed` are skipped automatically because they duplicate the canonical exports.
- `python scripts/sync-sqlite-assets.py <sources...>` hydrates the local cache from S3 (`s3://tuva-public-resources/terminology_viewer_sqlite` by default), runs the batch builder, and pushes the updated SQLite artefacts back to the same prefix. Add `--download-only` to pull the published bundles without rebuilding, or `--skip-download/--skip-upload` to control each sync direction.
# Deploying to Github Pages
WARNING: This will deploy the build to the active public URL. Do not use this for testing! Ensure that everything works!
1. run `npm build`
2. run `npm run deploy`

## Requirements for deployment

1. Install the `gh-pages` package. `npm install --save-dev gh-pages`
2. Enable GitHub Pages in Repository Settings  
   - Go to your repository on GitHub (e.g., https://github.com/username/repo-name).
   - Click on Settings.
   - Ensure your repo is public, otherwise you cannot share this via pages.
   - Scroll to the Pages section.
   - Under Source, select the gh-pages branch and set the folder to / (root).
   - Click Save.
