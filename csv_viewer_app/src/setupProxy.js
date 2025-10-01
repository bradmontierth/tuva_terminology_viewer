const fs = require('fs');
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const BUCKET_NAME = 'tuva-public-resources';

const xmlEscape = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const safeResolveChild = (root, relativePath) => {
  const normalisedRoot = path.resolve(root);
  const trimmed = relativePath ? relativePath.replace(/^\/+/, '') : '';
  const target = path.resolve(normalisedRoot, trimmed || '.');
  if (!target.startsWith(normalisedRoot)) {
    throw new Error(`Resolved path ${target} escapes root ${normalisedRoot}`);
  }
  return target;
};

const collectFilesRecursively = (directory, keyPrefix, contents) => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  entries.forEach((entry) => {
    if (!entry || !entry.name || entry.name.startsWith('.')) {
      return;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursively(entryPath, `${keyPrefix}${entry.name}/`, contents);
      return;
    }
    const stats = fs.statSync(entryPath);
    contents.push({
      key: `${keyPrefix}${entry.name}`,
      size: stats.size,
      lastModified: stats.mtime.toISOString(),
    });
  });
};

const buildListBucketXml = ({ prefix, contents, commonPrefixes, delimiter }) => {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `  <Name>${xmlEscape(BUCKET_NAME)}</Name>`,
    `  <Prefix>${xmlEscape(prefix)}</Prefix>`,
  ];

  if (delimiter) {
    lines.push(`  <Delimiter>${xmlEscape(delimiter)}</Delimiter>`);
  }

  lines.push(
    `  <KeyCount>${contents.length}</KeyCount>`,
    '  <MaxKeys>1000</MaxKeys>',
    '  <IsTruncated>false</IsTruncated>'
  );

  commonPrefixes.forEach((value) => {
    lines.push('  <CommonPrefixes>');
    lines.push(`    <Prefix>${xmlEscape(value)}</Prefix>`);
    lines.push('  </CommonPrefixes>');
  });

  contents.forEach((item) => {
    lines.push('  <Contents>');
    lines.push(`    <Key>${xmlEscape(item.key)}</Key>`);
    lines.push(`    <LastModified>${xmlEscape(item.lastModified)}</LastModified>`);
    lines.push('    <ETag>&quot;local&quot;</ETag>');
    lines.push(`    <Size>${item.size}</Size>`);
    lines.push('    <StorageClass>STANDARD</StorageClass>');
    lines.push('  </Contents>');
  });

  lines.push('</ListBucketResult>');
  return `${lines.join('\n')}\n`;
};

const createS3StyleListing = (rootDir, relativePrefix, requestPrefix, delimiter) => {
  const contents = [];
  const commonPrefixes = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    return { prefix: requestPrefix, contents, commonPrefixes, delimiter };
  }

  let targetDir;
  try {
    targetDir = safeResolveChild(rootDir, relativePrefix);
  } catch (error) {
    return { prefix: requestPrefix, contents, commonPrefixes, delimiter };
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { prefix: requestPrefix, contents, commonPrefixes, delimiter };
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (!entry || !entry.name || entry.name.startsWith('.')) {
      return;
    }
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (delimiter === '/') {
        commonPrefixes.push(`${requestPrefix}${entry.name}/`);
      } else {
        collectFilesRecursively(entryPath, `${requestPrefix}${entry.name}/`, contents);
      }
      return;
    }
    const stats = fs.statSync(entryPath);
    contents.push({
      key: `${requestPrefix}${entry.name}`,
      size: stats.size,
      lastModified: stats.mtime.toISOString(),
    });
  });

  contents.sort((a, b) => a.key.localeCompare(b.key));
  commonPrefixes.sort((a, b) => a.localeCompare(b));

  return { prefix: requestPrefix, contents, commonPrefixes, delimiter };
};

const resolvePublicBasePath = () => {
  const raw = (process.env.PUBLIC_URL || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, 'http://localhost');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return pathname === '/' ? '' : pathname;
  } catch (error) {
    const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
    const trimmed = withLeading.replace(/\/+$/, '');
    return trimmed === '/' ? '' : trimmed;
  }
};

const normaliseSegment = (value) => value.replace(/^\/+|\/+$/g, '');

const buildMountPath = (basePath, segment) => {
  const base = normaliseSegment(basePath || '');
  const child = normaliseSegment(segment || '');
  if (!base && !child) {
    return '/';
  }
  if (!base) {
    return `/${child}`;
  }
  if (!child) {
    return `/${base}`;
  }
  return `/${base}/${child}`;
};

const uniqueMountBases = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    const key = normaliseSegment(value || '');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

module.exports = function (app) {
  const publicBasePath = resolvePublicBasePath();
  const mountBases = uniqueMountBases(['', publicBasePath]);

  // When this file lives under src/, __dirname points to <app>/src.
  // Default local data root is two levels up to reach repo-level ./data
  const localDataRoot = process.env.LOCAL_DATA_DIR
    ? path.resolve(process.env.LOCAL_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');

  if (fs.existsSync(localDataRoot)) {
    try {
      const entries = fs.readdirSync(localDataRoot, { withFileTypes: true });
      entries
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => {
          const absolutePath = path.join(localDataRoot, entry.name);
          mountBases.forEach((base) => {
            const mountPath = buildMountPath(base, entry.name);
            app.use(
              mountPath,
              express.static(absolutePath, {
                index: false,
                fallthrough: true,
              })
            );
          });
        });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[setupProxy] Failed to mount LOCAL_DATA_DIR contents:', error.message);
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn('[setupProxy] LOCAL_DATA_DIR not found:', localDataRoot);
  }

  const localSqliteRoot = process.env.LOCAL_SQLITE_DIR
    ? path.resolve(process.env.LOCAL_SQLITE_DIR)
    : path.join(__dirname, '..', 'public', 'data', 'sqlite');

  mountBases.forEach((base) => {
    if (!fs.existsSync(localSqliteRoot)) {
      return;
    }

    const sqliteRoute = buildMountPath(base, 'data/sqlite');

    const getRoute = sqliteRoute === '/' ? '/*' : `${sqliteRoute}/*`;
    app.get(getRoute, (req, res, next) => {
      const relativePath = req.params[0] || '';
      let targetPath;
      try {
        targetPath = safeResolveChild(localSqliteRoot, relativePath);
      } catch (error) {
        res.status(403).send('Forbidden');
        return;
      }

      res.sendFile(targetPath, (sendError) => {
        if (sendError) {
          if (sendError.code === 'ENOENT') {
            next();
            return;
          }
          next(sendError);
        }
      });
    });

    app.use(
      sqliteRoute,
      express.static(localSqliteRoot, {
        index: false,
        fallthrough: true,
      })
    );
  });

  if (!fs.existsSync(localSqliteRoot)) {
    // eslint-disable-next-line no-console
    console.warn('[setupProxy] LOCAL_SQLITE_DIR not found:', localSqliteRoot);
  }

  const listRoots = [
    { prefix: 'terminology_viewer_sqlite/', root: localSqliteRoot },
    { prefix: '', root: localDataRoot, default: true },
  ].filter((entry) => entry.root && fs.existsSync(entry.root));

  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.originalUrl, 'http://localhost');
    } catch (error) {
      next();
      return;
    }

    const listType = parsedUrl.searchParams.get('list-type');
    if (listType !== '2') {
      next();
      return;
    }

    const prefixParamRaw = parsedUrl.searchParams.get('prefix') || '';
    const delimiterParam = parsedUrl.searchParams.get('delimiter') || '';
    const normalisedPrefix = prefixParamRaw.replace(/^\/+/, '');

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log('[setupProxy] list request', req.originalUrl);
    }

    if (!normalisedPrefix && !listRoots.length) {
      next();
      return;
    }

    let targetRoot = listRoots.find((entry) => normalisedPrefix.startsWith(entry.prefix))
      || listRoots.find((entry) => entry.default)
      || listRoots[listRoots.length - 1];

    if (!targetRoot || !targetRoot.root || !fs.existsSync(targetRoot.root)) {
      next();
      return;
    }

    const relativePrefix = normalisedPrefix.slice(targetRoot.prefix.length);

    try {
      const listing = createS3StyleListing(
        targetRoot.root,
        relativePrefix,
        normalisedPrefix,
        delimiterParam
      );
      res.type('application/xml');
      res.send(buildListBucketXml(listing));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[setupProxy] Failed to serve local listing:', error.message);
      res.type('application/xml');
      res.send(buildListBucketXml({
        prefix: normalisedPrefix,
        contents: [],
        commonPrefixes: [],
        delimiter: delimiterParam,
      }));
    }
  });

  const proxy = createProxyMiddleware({
    target: 'https://tuva-public-resources.s3.amazonaws.com',
    changeOrigin: true,
    logLevel: 'warn',
  });

  const registerProxyRoute = (route) => {
    if (!route || route === '/') {
      return;
    }

    const escapedRoute = route.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const routePattern = new RegExp(`^${escapedRoute}`);

    app.use(route, (req, res, next) => {
      const stripped = req.originalUrl.replace(routePattern, '') || '/';
      req.url = stripped;
      req.headers.host = new URL(proxy.options.target).hostname;
      proxy(req, res, next);
    });
  };

  registerProxyRoute('/s3-proxy');
  if (publicBasePath) {
    registerProxyRoute(buildMountPath(publicBasePath, 's3-proxy'));
  }
};

