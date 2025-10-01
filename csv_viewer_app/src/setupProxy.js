/*
 * Development server tweaks for large SQLite files served over HTTP range.
 *
 * We add headers for `.sqlite` responses to ensure byte-range semantics and
 * avoid accidental content encodings that would break range offsets.
 */

const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function configure(app) {
  // Proxy S3 listings and static assets when requested via /s3-proxy
  // This supports version listing in local dev when REACT_APP_USE_S3_PROXY=true
  const targetBase = (process.env.REACT_APP_DATA_BASE_URL || 'https://tuva-public-resources.s3.amazonaws.com')
    .replace(/\/$/, '');

  app.use(
    '/s3-proxy',
    createProxyMiddleware({
      target: targetBase,
      changeOrigin: true,
      // Strip the /s3-proxy prefix; keep the rest (including query params)
      pathRewrite: (path) => path.replace(/^\/s3-proxy(\/)?/, '/'),
      onProxyReq(proxyReq, req) {
        // Ensure upstream does not compress SQLite responses (breaks Range)
        if (/\.sqlite(\?.*)?$/i.test(req.url)) {
          proxyReq.setHeader('Accept-Encoding', 'identity');
        }
      },
      onProxyRes(proxyRes, req) {
        if (/\.sqlite(\?.*)?$/i.test(req.url)) {
          proxyRes.headers['accept-ranges'] = 'bytes';
          delete proxyRes.headers['content-encoding'];
          if (!proxyRes.headers['cache-control']) {
            proxyRes.headers['cache-control'] = 'public, no-transform, max-age=0';
          }
        }
      },
      // TLS is fine for S3
      secure: true,
      logLevel: 'warn',
    })
  );

  // For locally served .sqlite files, set headers to preserve range semantics.
  app.use((req, res, next) => {
    if (/\/data\/sqlite\/.*\.sqlite(\?.*)?$/i.test(req.url)) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('Cache-Control', 'public, no-transform, max-age=0');
    }
    next();
  });
};
