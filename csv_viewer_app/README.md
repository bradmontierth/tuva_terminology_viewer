# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Header Crosswalk

This viewer now hydrates CSV headers from the Tuva dbt project so that the data exported to S3 can be rendered with friendly column names.

- `npm run generate:crosswalk` builds `public/data/header-crosswalk.json` by inspecting every tagged release in the [`tuva`](https://github.com/tuva-health/tuva) repository. The script keeps a shallow clone under `scripts/.cache/tuva` (ignored in git).
- The crosswalk step runs automatically before `npm start`, `npm run build`, and `npm test`. To skip a refresh you can set `TUVA_CROSSWALK_SKIP_FETCH=1` (reuse the existing clone) or `TUVA_CROSSWALK_DISABLE=1` (skip the step entirely).
- Set `TUVA_REPO_URL`, `TUVA_REPO_DIR`, or `TUVA_CROSSWALK_OUTPUT` to override the default source repository, cache location, or output file.
- When working without network access, generate the crosswalk once manually (or copy an existing JSON file) and reuse it locally via `TUVA_CROSSWALK_SKIP_FETCH=1`.

## SQLite search bundles

- `npm run build:sqlite -- --input <path/to/dataset.csv[.gz]> --dataset <id>` prepares the SQLite/FTS artefacts used by the worker. The command supports gzipped Tuva exports out of the box and writes the output under `public/data/sqlite/<datasetId>/` while refreshing `public/data/sqlite/datasets.json`.
- `python scripts/build-sqlite-batch.py <source>` scans an entire folder (for example `../data/versioned_terminology/latest`) and invokes the builder for every dataset whose row-count exceeds the preview threshold. Files ending in `_compressed` are skipped automatically because they duplicate the canonical exports.
- `python scripts/sync-sqlite-assets.py <sources...>` syncs the published bundle set down from S3 (`s3://tuva-public-resources/terminology_viewer_sqlite` by default), runs the batch builder, and pushes refreshed artefacts back to the same prefix. Add `--download-only` to hydrate the local cache without rebuilding, or `--skip-download` / `--skip-upload` to control each sync direction.
- Column headers come from `public/data/header-crosswalk.json` when available; pass `--crosswalk` if you need to point at a different file.
- Sharding is automatic once the estimated shard size exceeds ~120 MB. Override with `--max-shard-bytes`, `--shard-count`, or `--shard-key` if you need deterministic splits.
- Preview payloads can be disabled with `--skip-preview` or resized with `--preview-limit`.
- `npm run prepare:sqlite-assets` stages the `sql.js` wasm and worker bundles into `public/sqljs/`; this runs automatically before `npm start`, `npm test`, and `npm run build`.

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)
