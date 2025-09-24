const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  const proxy = createProxyMiddleware({
    target: 'http://localhost:9000',
    changeOrigin: true,
    pathRewrite: {
      '^/s3-proxy': '',
    },
    logLevel: 'warn',
  });

  app.use('/s3-proxy', (req, res, next) => {
    // Force the dev proxy to behave like a simple forwarder regardless of public URL
    req.url = req.originalUrl.replace(/^\/s3-proxy/, '') || '/';
    req.headers.host = new URL(proxy.options.target).hostname;
    proxy(req, res, next);
  });
};
