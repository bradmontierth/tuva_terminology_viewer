#!/usr/bin/env node

/*
 * Copies the sql.js WebAssembly artefacts into public/sqljs so the runtime can
 * resolve them via locateFile when initialising the HTTP VFS layer.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEST_DIR = path.join(REPO_ROOT, 'public', 'sqljs');

async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
}

async function main() {
  let sqlJsRoot;
  try {
    const pkgJsonPath = require.resolve('sql.js/package.json', { paths: [REPO_ROOT] });
    sqlJsRoot = path.dirname(pkgJsonPath);
  } catch (error) {
    console.error('Unable to resolve sql.js. Please install dependencies first.');
    process.exitCode = 1;
    return;
  }

  // Prefer sql.js-provided wasm; httpvfs bundle may also ship a wasm, but it's equivalent.
  const wasmSource = path.join(sqlJsRoot, 'dist', 'sql-wasm.wasm');
  const wasmDest = path.join(DEST_DIR, 'sql-wasm.wasm');
  let workerSource;
  let workerMapSource;
  let httpvfsBundleSource;
  let haveHttpvfs = false;
  try {
    const httpvfsRoot = path.dirname(require.resolve('sql.js-httpvfs/dist/sqlite.worker.js', { paths: [REPO_ROOT] }));
    workerSource = path.join(httpvfsRoot, 'sqlite.worker.js');
    workerMapSource = path.join(httpvfsRoot, 'sqlite.worker.js.map');
    httpvfsBundleSource = path.join(httpvfsRoot, 'index.js');
    haveHttpvfs = true;
  } catch (error) {
    // Fall back to pre-bundled assets in public/sqljs; do not fail hard.
    console.warn('sql.js-httpvfs not installed; using existing public/sqljs assets if present.');
  }
  const workerDest = path.join(DEST_DIR, 'sqlite.worker.js');
  const workerMapDest = path.join(DEST_DIR, 'sqlite.worker.js.map');
  const httpvfsBundleDest = path.join(DEST_DIR, 'sqljs-httpvfs.js');

  await ensureDir(DEST_DIR);
  // Always ensure wasm is present
  await fsp.copyFile(wasmSource, wasmDest);

  if (haveHttpvfs) {
    await fsp.copyFile(workerSource, workerDest);
    if (workerMapSource && fs.existsSync(workerMapSource)) {
      await fsp.copyFile(workerMapSource, workerMapDest);
    }
    if (httpvfsBundleSource) {
      await fsp.copyFile(httpvfsBundleSource, httpvfsBundleDest);
    }
  } else {
    // Verify fallback files exist; otherwise warn (but do not hard fail)
    const hasWorker = fs.existsSync(workerDest);
    const hasBundle = fs.existsSync(httpvfsBundleDest);
    if (!hasWorker || !hasBundle) {
      console.warn('Missing httpvfs assets in public/sqljs. Some features may not work until installed.');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
