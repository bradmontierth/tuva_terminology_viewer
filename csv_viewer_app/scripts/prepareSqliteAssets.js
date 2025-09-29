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

  let wasmSource;
  const wasmDest = path.join(DEST_DIR, 'sql-wasm.wasm');
  let workerSource;
  let workerMapSource;
  let httpvfsBundleSource;
  try {
    const httpvfsRoot = path.dirname(require.resolve('sql.js-httpvfs/dist/sqlite.worker.js', { paths: [REPO_ROOT] }));
    workerSource = path.join(httpvfsRoot, 'sqlite.worker.js');
    workerMapSource = path.join(httpvfsRoot, 'sqlite.worker.js.map');
    httpvfsBundleSource = path.join(httpvfsRoot, 'index.js');
    wasmSource = path.join(httpvfsRoot, 'sql-wasm.wasm');
  } catch (error) {
    console.error('Unable to resolve sql.js-httpvfs worker bundle.');
    process.exitCode = 1;
    return;
  }
  const workerDest = path.join(DEST_DIR, 'sqlite.worker.js');
  const workerMapDest = path.join(DEST_DIR, 'sqlite.worker.js.map');
  const httpvfsBundleDest = path.join(DEST_DIR, 'sqljs-httpvfs.js');

  await ensureDir(DEST_DIR);
  await fsp.copyFile(wasmSource, wasmDest);
  await fsp.copyFile(workerSource, workerDest);
  if (fs.existsSync(workerMapSource)) {
    await fsp.copyFile(workerMapSource, workerMapDest);
  }
  if (httpvfsBundleSource) {
    await fsp.copyFile(httpvfsBundleSource, httpvfsBundleDest);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
