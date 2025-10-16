#!/usr/bin/env node
/*
 * Outputs a comma-separated list of dataset ids whose inputs changed
 * between the latest published version and the previous published version,
 * using the file identity crosswalk (ETag/size signatures).
 *
 * Reads:
 *   - csv_viewer_app/public/data/header-crosswalk.json
 *   - csv_viewer_app/public/data/file-identity-crosswalk.json
 */

const fs = require('fs');
const path = require('path');

function readJson(p) {
  const txt = fs.readFileSync(p, 'utf8');
  return JSON.parse(txt);
}

function versionComparePrepare(v = '') {
  return String(v || '').replace(/_/g, '.');
}

function compareVersions(a = '', b = '') {
  const A = versionComparePrepare(a).split(/[^0-9A-Za-z]+/).filter(Boolean);
  const B = versionComparePrepare(b).split(/[^0-9A-Za-z]+/).filter(Boolean);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const as = A[i] || '0';
    const bs = B[i] || '0';
    const an = Number(as);
    const bn = Number(bs);
    const aNum = Number.isFinite(an);
    const bNum = Number.isFinite(bn);
    if (aNum && bNum) {
      if (an !== bn) return an > bn ? 1 : -1;
    } else if (as !== bs) {
      return as > bs ? 1 : -1;
    }
  }
  return 0;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const headerPath = path.join(repoRoot, 'csv_viewer_app', 'public', 'data', 'header-crosswalk.json');
  const identityPath = path.join(repoRoot, 'csv_viewer_app', 'public', 'data', 'file-identity-crosswalk.json');
  if (!fs.existsSync(headerPath)) {
    console.error('header-crosswalk.json not found.');
    process.exit(2);
  }
  if (!fs.existsSync(identityPath)) {
    console.error('file-identity-crosswalk.json not found.');
    process.exit(3);
  }
  const header = readJson(headerPath);
  const identity = readJson(identityPath);
  const latest = (header && header._meta && header._meta.latestVersion) || '';
  if (!latest) {
    console.error('latestVersion not found in header-crosswalk.');
    process.exit(4);
  }
  // Compute previous version from identity union, excluding 'latest'
  const folders = ['versioned_terminology', 'versioned_value_sets', 'versioned_provider_data'];
  const vers = new Set();
  folders.forEach((f) => {
    const v = identity[f] && identity[f].versions;
    if (Array.isArray(v)) v.forEach((x) => { if (String(x).toLowerCase() !== 'latest') vers.add(String(x)); });
  });
  const ordered = Array.from(vers).sort((a, b) => compareVersions(b, a));
  let prev = null;
  for (const v of ordered) {
    if (v !== latest) { prev = v; break; }
  }
  if (!prev && ordered.length > 0) prev = ordered[0];
  if (!prev) {
    // First release → everything is considered changed
    const all = new Set();
    folders.forEach((f) => {
      const groups = (identity[f] && identity[f].groups) || {};
      Object.keys(groups).forEach((file) => {
        const base = file.toLowerCase().replace(/\.csv$/i, '').replace(/_compressed$/i, '');
        all.add(base);
      });
    });
    console.log(Array.from(all).sort().join(','));
    return;
  }
  const changed = new Set();
  folders.forEach((f) => {
    const groups = (identity[f] && identity[f].groups) || {};
    for (const [file, info] of Object.entries(groups)) {
      const history = (info && Array.isArray(info.history)) ? info.history : [];
      const byVersion = {};
      history.forEach((h) => { if (h && h.version) byVersion[String(h.version)] = h.signature || null; });
      const sigLatest = byVersion[latest];
      const sigPrev = byVersion[prev];
      if (!sigLatest || !sigPrev || sigLatest !== sigPrev) {
        const base = file.toLowerCase().replace(/\.csv$/i, '').replace(/_compressed$/i, '');
        changed.add(base);
      }
    }
  });
  console.log(Array.from(changed).sort().join(','));
}

main();

