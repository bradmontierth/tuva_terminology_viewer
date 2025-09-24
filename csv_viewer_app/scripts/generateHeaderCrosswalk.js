#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Papa = require('papaparse');

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, '..');
const defaultCacheDir = path.join(scriptDir, '.cache');

const repoUrl = process.env.TUVA_REPO_URL || 'https://github.com/tuva-health/tuva.git';
const repoDir = process.env.TUVA_REPO_DIR
  ? path.resolve(process.env.TUVA_REPO_DIR)
  : path.join(defaultCacheDir, 'tuva');
const outputPath = process.env.TUVA_CROSSWALK_OUTPUT
  ? path.resolve(process.env.TUVA_CROSSWALK_OUTPUT)
  : path.join(projectRoot, 'public', 'data', 'header-crosswalk.json');
const fallbackOutputPath = path.join(projectRoot, 'src', 'generated', 'headerCrosswalk.json');

const skipFetch = process.env.TUVA_CROSSWALK_SKIP_FETCH === '1';
const verbose = process.env.TUVA_CROSSWALK_VERBOSE === '1';

const log = (message) => {
  if (verbose) {
    console.log(`[crosswalk] ${message}`);
  }
};

const warn = (message) => {
  console.warn(`[crosswalk] ${message}`);
};

if (process.env.TUVA_CROSSWALK_DISABLE === '1') {
  console.log('[crosswalk] Skipping crosswalk generation (disabled via environment flag).');
  process.exit(0);
}

const runGit = (args, options = {}) => {
  const {
    cwd = repoDir,
    stdio = 'pipe',
    allowError = false,
  } = options;

  const spawnOptions = {
    cwd,
    stdio,
    shell: false,
  };

  if (stdio === 'pipe' || (Array.isArray(stdio) && stdio.includes('pipe'))) {
    spawnOptions.encoding = 'utf8';
  }

  const result = spawnSync('git', args, spawnOptions);

  if (result.error) {
    if (allowError) {
      return result;
    }
    throw result.error;
  }

  if (result.status !== 0) {
    if (allowError) {
      return result;
    }
    const stderr = typeof result.stderr === 'string'
      ? result.stderr
      : (result.stderr ? result.stderr.toString() : '');
    throw new Error(stderr || `git ${args.join(' ')} failed with code ${result.status}`);
  }

  return result;
};

const ensureRepo = () => {
  if (!fs.existsSync(repoDir)) {
    if (skipFetch) {
      throw new Error(`Repository path ${repoDir} not found and fetch step disabled.`);
    }
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    console.log(`[crosswalk] Cloning ${repoUrl} into ${repoDir}`);
    const cloneResult = runGit(['clone', repoUrl, repoDir], {
      cwd: path.dirname(repoDir),
      stdio: 'inherit',
    });
    if (cloneResult.status !== 0) {
      throw new Error('Failed to clone Tuva repository.');
    }
  }

  if (!skipFetch) {
    try {
      const fetchResult = runGit(['fetch', '--tags', '--prune'], {
        stdio: verbose ? 'inherit' : 'pipe',
        allowError: true,
      });
      if (fetchResult.status !== 0) {
        const stderr = typeof fetchResult.stderr === 'string'
          ? fetchResult.stderr
          : (fetchResult.stderr ? fetchResult.stderr.toString() : '');
        warn(`Unable to fetch latest tags: ${stderr.trim() || `git exited ${fetchResult.status}`}`);
      }
    } catch (error) {
      warn(`Unable to fetch latest tags: ${error.message}`);
    }
  }
};

const listTags = () => {
  const result = runGit(['tag', '--list']);
  const raw = typeof result.stdout === 'string' ? result.stdout : (result.stdout ? result.stdout.toString() : '');
  return raw
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
};

const normalize = (value) => (value || '').trim().toLowerCase();

const parseHook = (hook) => {
  if (typeof hook !== 'string' || !hook.includes('load_seed')) {
    return null;
  }

  const pathMatch = hook.match(/versioned_[^/'"\s]+\/[A-Za-z0-9._-]+/);
  if (!pathMatch) {
    return null;
  }

  const [folder, version] = pathMatch[0].split('/');
  if (!folder || !version) {
    return null;
  }

  const csvMatches = [...hook.matchAll(/['"]([^'"\n]+\.csv)['"]/gi)];
  if (!csvMatches.length) {
    return null;
  }

  const fileName = csvMatches[csvMatches.length - 1][1];
  return { folder, version, fileName };
};

const collectSeedEntries = (node, pathParts = []) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return [];
  }

  const entries = [];

  const hookValue = node['+post-hook'] ?? node['post-hook'];
  if (hookValue) {
    const hooks = Array.isArray(hookValue) ? hookValue : [hookValue];
    hooks.forEach((hook) => {
      const details = parseHook(hook);
      if (details) {
        entries.push({
          hook,
          pathParts,
          ...details,
        });
      }
    });
  }

  Object.entries(node).forEach(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    if (key === '+post-hook' || key === 'post-hook') {
      return;
    }
    if (key.startsWith('+') || key.startsWith('-')) {
      return;
    }
    entries.push(...collectSeedEntries(value, [...pathParts, key]));
  });

  return entries;
};

const readSeedHeaders = (tag, seedRelativePath) => {
  const gitPath = `seeds/${seedRelativePath}.csv`;
  try {
    const showResult = runGit(['show', `${tag}:${gitPath}`]);
    const csvContent = typeof showResult.stdout === 'string'
      ? showResult.stdout
      : (showResult.stdout ? showResult.stdout.toString() : '');
    const result = Papa.parse(csvContent, {
      header: false,
      skipEmptyLines: true,
      preview: 1,
    });

    if (result.data && result.data.length > 0 && Array.isArray(result.data[0])) {
      return result.data[0].map((value) => (value === '' ? null : value));
    }
  } catch (error) {
    warn(`Failed to read ${gitPath} at ${tag}: ${error.message}`);
  }

  return null;
};

const buildCrosswalk = (tags) => {
  const crosswalk = {};
  const meta = {
    generatedAt: new Date().toISOString(),
    repoUrl,
    repoDir,
    tagsProcessed: [],
    tagsWithErrors: [],
  };

  tags.forEach((tag) => {
    let yamlText;
    try {
      const showResult = runGit(['show', `${tag}:dbt_project.yml`]);
      yamlText = typeof showResult.stdout === 'string'
        ? showResult.stdout
        : (showResult.stdout ? showResult.stdout.toString() : '');
    } catch (error) {
      warn(`Skipping ${tag}: unable to load dbt_project.yml (${error.message})`);
      meta.tagsWithErrors.push(tag);
      return;
    }

    let projectConfig;
    try {
      projectConfig = yaml.load(yamlText) || {};
    } catch (error) {
      warn(`Skipping ${tag}: invalid YAML (${error.message})`);
      meta.tagsWithErrors.push(tag);
      return;
    }

    const seedRoot = projectConfig.seeds || {};
    const entries = collectSeedEntries(seedRoot);
    if (!entries.length) {
      log(`No load_seed hooks found in ${tag}`);
      return;
    }

    const versionErrors = [];

    entries.forEach((entry) => {
      const { folder, version, fileName, pathParts } = entry;
      if (!folder || !version || !fileName) {
        return;
      }

      const seedPathParts = pathParts.slice(1);
      const seedRelativePath = seedPathParts.join('/');
      if (!seedRelativePath) {
        return;
      }

      const headers = readSeedHeaders(tag, seedRelativePath);
      if (!headers || !headers.length) {
        versionErrors.push(`${folder}/${version}:${fileName}`);
        return;
      }

      const folderKey = normalize(folder);
      const versionKey = version.trim();
      const fileKey = fileName.trim().toLowerCase();

      if (!crosswalk[folderKey]) {
        crosswalk[folderKey] = {};
      }

      if (!crosswalk[folderKey][versionKey]) {
        crosswalk[folderKey][versionKey] = {};
      }

      if (!crosswalk[folderKey][versionKey][fileKey]) {
        crosswalk[folderKey][versionKey][fileKey] = {
          headers,
          seed: `seeds/${seedRelativePath}.csv`,
          tag,
        };
      }
    });

    meta.tagsProcessed.push(tag);
    if (versionErrors.length) {
      meta.tagsWithErrors.push({ tag, entries: versionErrors });
    }
  });

  return { crosswalk, meta };
};

const writeOutput = (data) => {
  const payload = {
    _meta: data.meta,
    ...data.crosswalk,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[crosswalk] Wrote ${outputPath}`);

  try {
    fs.mkdirSync(path.dirname(fallbackOutputPath), { recursive: true });
    fs.writeFileSync(fallbackOutputPath, `${JSON.stringify(payload)}\n`);
    console.log(`[crosswalk] Wrote ${fallbackOutputPath}`);
  } catch (error) {
    warn(`Unable to write fallback crosswalk file: ${error.message}`);
  }
};

const main = () => {
  ensureRepo();
  const tags = listTags();
  if (!tags.length) {
    throw new Error('No tags found in Tuva repository clone.');
  }

  log(`Processing ${tags.length} tags`);
  const result = buildCrosswalk(tags);
  writeOutput(result);
};

main();
