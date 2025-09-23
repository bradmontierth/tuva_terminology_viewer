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

Large terminology datasets can be searched without loading every CSV row in the browser by precomputing compressed index files. The static app automatically looks for files named `<base>.index.json.gz` (or `.json`) in the same S3 folder as the CSV parts. If an index is missing the UI falls back to the preview rows you see today.

Use the offline Node.js script to build these assets:

```bash
cd csv_viewer_app
node scripts/build-index.js --input <folder-with-csvs> --output <folder-for-indexes>
```

- `--input` should mirror the S3 layout (e.g. `versioned_terminology/<version>/...`).
- `--output` receives `.index.json.gz` files using the same relative paths.
- Use `--dataset <name>.csv` when you only need to regenerate a single dataset.

Each run groups multi-part files such as `admit_source.csv_0.csv.gz`, `admit_source.csv_1.csv.gz`, etc., records row metadata, and writes an inverted token index that the frontend loads on demand.

After publishing the generated `.index.json.gz` files alongside their CSV counterparts, the GitHub Pages build will automatically pick them up and route search queries through the new index-backed flow.
