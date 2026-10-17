// Portable web server: serves the built app and runs the same function handlers Netlify runs, on the same URL paths.
//   node server/main.cjs        (PORT, default 8080)
// Functions named *-background answer 202 at once and keep running, like Netlify background functions.
// GET /config.js returns the browser's runtime settings (EMNS_PUBLIC_SUPABASE_URL, EMNS_PUBLIC_SUPABASE_KEY).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FUNCTIONS_PREFIX } = require('../src/server/runtime.cjs');

const FUNCTIONS_DIR = path.resolve(__dirname, '../netlify/functions');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2' };
const BINARY_FUNCTION_BODIES = false;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer({ distDir = path.resolve(__dirname, '../dist'), loadHandler = (name) => require(path.join(FUNCTIONS_DIR, `${name}.js`)).handler, env = process.env, log = console } = {}) {
  const index = () => fs.readFileSync(path.join(distDir, 'index.html'));

  async function runFunction(req, res, name, rest, url) {
    if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404); return res.end('Not found'); }
    let handler;
    try { handler = loadHandler(name); } catch { res.writeHead(404); return res.end('Not found'); }
    let body = '';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readBody(req); } catch (e) { res.writeHead(e.code === 413 ? 413 : 400); return res.end('Bad request'); }
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
    if (!headers['x-forwarded-for'] && req.socket.remoteAddress) headers['x-forwarded-for'] = req.socket.remoteAddress;
    const event = {
      httpMethod: req.method, headers, body, isBase64Encoded: BINARY_FUNCTION_BODIES,
      path: `${FUNCTIONS_PREFIX}/${name}${rest}`, rawUrl: req.url,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    };
    const run = () => Promise.resolve(handler(event, {}));
    if (name.endsWith('-background')) {
      // authorize first (the handler checks its own secret); only an authorized call is detached
      const result = await Promise.race([run(), new Promise((r) => setTimeout(() => r(null), 50))]);
      if (result && result.statusCode === 401) { res.writeHead(401); return res.end('Unauthorized'); }
      res.writeHead(202); res.end();
      return;
    }
    let result;
    try { result = await run(); } catch (e) { log.error(`function ${name} threw`, e); res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Internal error' })); }
    const out = result || { statusCode: 204 };
    res.writeHead(out.statusCode || 200, out.headers || {});
    res.end(out.body || '');
  }

  function serveStatic(req, res, pathname) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(distDir, rel);
    if (!file.startsWith(distDir + path.sep) && file !== distDir) { res.writeHead(403); return res.end(); }
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = null;
    if (target) {
      const type = MIME[path.extname(target)] || 'application/octet-stream';
      const immutable = /\/assets\//.test(target) ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': immutable });
      return fs.createReadStream(target).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); // single-page app: unknown paths show the app
    res.end(index());
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (url.pathname === '/config.js') {
        const cfg = { supabaseUrl: env.EMNS_PUBLIC_SUPABASE_URL || '', supabaseKey: env.EMNS_PUBLIC_SUPABASE_KEY || '' };
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
        return res.end(`window.__EMNS_CONFIG__ = ${JSON.stringify(cfg)};`);
      }
      if (url.pathname.startsWith(FUNCTIONS_PREFIX + '/')) {
        const [, name, ...more] = url.pathname.slice(FUNCTIONS_PREFIX.length).split('/');
        return await runFunction(req, res, name, more.length ? '/' + more.join('/') : '', url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
      return serveStatic(req, res, url.pathname);
    } catch (e) { log.error('request failed', e); if (!res.headersSent) res.writeHead(500); res.end('Internal error'); }
  });
}

module.exports = { createServer };
if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => console.log(`eMNS listening on ${port}`));
}
