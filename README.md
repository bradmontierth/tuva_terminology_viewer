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

## Serverless Search API (optional)

For faster searches with minimal data transfer, you can switch the app to use a small serverless API that queries the SQLite FTS on the server.

- Local test:
  - Build a single-shard DB for a dataset, e.g., `cd csv_viewer_app && npm run build:sqlite -- --input <csv.gz> --dataset ndc --shard-count 1 --skip-preview`
  - Run the API locally: `LOCAL_SQLITE_DIR=csv_viewer_app/public/data/sqlite/ndc HOST=127.0.0.1 PORT=8000 python3 search_api/local_server.py`
  - Start the app using the API: `cd csv_viewer_app && REACT_APP_SEARCH_BACKEND=api REACT_APP_SEARCH_API_BASE_URL=http://127.0.0.1:8000 npm start`
  - Shortcut: `make dev DATASET=ndc INPUT=<path/to/ndc.csv.gz> PORT=8000`
    - Builds the SQLite (if INPUT provided), starts the local API, and runs CRA with proxy.
  - Build and serve ALL datasets from local data/:
    - `scripts/dev-local-all.sh --versions latest [--threshold 1000] [--skip-crosswalk] [--skip-identity] [--identity-base-url https://tuva-public-resources.s3.amazonaws.com]`
    - Expects CSVs under `data/versioned_terminology/<version>`, `data/versioned_value_sets/<version>`, `data/versioned_provider_data/<version>`.
    - Builds single‑shard `.sqlite` for datasets above the threshold (1,000 rows), starts local API for all, and runs CRA dev server using the API.

- Deploy:
  - Publish viewer assets to S3/CloudFront using scripts under `csv_viewer_app/scripts/`.
  - Publish API `.sqlite` files to your bucket prefix: `csv_viewer_app/scripts/publish-api-sqlite.sh --dest-bucket <bucket> --prefix api_sqlite --datasets ndc`
  - Deploy the API to AWS using SAM: `search_api/deploy.sh --bucket <bucket> [--stack TuvaSearchApi]`
  - Set `REACT_APP_SEARCH_BACKEND=api` and `REACT_APP_SEARCH_API_BASE_URL=<API URL>` for production builds.

- One-shot deploy helper:
  - `scripts/deploy-complete.sh --bucket <bucket> --versions latest --cf-dist-id <DIST_ID> --api-stack TuvaSearchApi --api-prefix api_sqlite --allow-origins https://<your-domain>`
    Or omit `--cf-dist-id` if you don’t use CloudFront yet.
