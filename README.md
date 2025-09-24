# Tuva Terminology Viewer

This application is for viewing the terminology data publicly available from The Tuva Project.

# Testing Locally

1. In Terminal `cd csv_viewer_app` to go to that folder.
2. Run `npm start` to start the server.
3. Click on the provided link to open the page.

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

## Generating search indexes

Large terminology datasets can be searched without loading every CSV row in the browser by precomputing compressed index files. The static app looks for files named `<base>.index.json.gz` (or `.json`) under the parallel `terminology_indices/<version>/...` path; when no index exists (for example, smaller datasets under the preview size) the UI falls back to the partial preview rows you see today.

Use the offline Node.js script to build these assets:

```bash
cd csv_viewer_app
node scripts/build-index.js --input <folder-with-csvs> --output <terminology-indices-root>
```

- `--input` should mirror the S3 layout (e.g. `versioned_terminology/<version>/...`).
- `--output` should point at the mirrored index root (e.g. `terminology_indices/<version>`); the script keeps the relative directory structure.
- `--min-rows <count>` overrides the minimum row threshold for building an index (defaults to the viewer's partial preview limit of 50,000 rows).
- Use `--dataset <name>.csv` when you only need to regenerate a single dataset.

Datasets with total rows at or below the threshold are skipped automatically because the viewer can load and search them directly from the preview rows.

Each run groups multi-part files such as `admit_source.csv_0.csv.gz`, `admit_source.csv_1.csv.gz`, etc., records row metadata, and writes an inverted token index that the frontend loads on demand.

After publishing the generated `.index.json.gz` files under `terminology_indices/<version>/...`, the GitHub Pages build will automatically pick them up and route search queries through the new index-backed flow.

### Automating the sync/build/upload loop

When you are ready to refresh the live indexes for the most recent releases, the helper script at `scripts/update_terminology_indices.sh` can download the changing S3 folders (`latest` and the newest numeric version), rebuild any necessary indexes, and push the refreshed `.index.json.gz` files back to S3:

```bash
./scripts/update_terminology_indices.sh --active-version 0.15.2
```

The script defaults to the `tuva-public-resources` bucket and to the `versioned_terminology`/`terminology_indices` prefixes. Pass `--versions` if you need to process additional folders, `--min-rows` to override the index-size cutoff, `--max-old-space-size` to increase Node’s heap (useful for the largest datasets), or `--dry-run` to see what would happen without making changes. You will need AWS CLI credentials configured locally before running it.

### Testing indexes locally

1. Serve the downloaded datasets from a static server (for example, `npx http-server data -p 9000 --cors`).
2. Launch the app with the data base override so browser requests hit your local server:
   ```bash
   REACT_APP_DATA_BASE_URL=http://localhost:9000 \
   npm start
   ```
3. Keep `REACT_APP_USE_S3_PROXY=true` if you still want the listings to come through the proxy; object fetches will now come from your local cache, allowing you to verify the generated index files before pushing them to S3.
