// Zero-dependency static file server for the FamilyOS desktop (web) app.
// Run: node serve.js  -> http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.WEB_PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (errRead, data) => {
    if (errRead) {
      // SPA fallback — hash routing lives client-side, so unknown paths serve index.html
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FamilyOS desktop web app running at http://localhost:${PORT}`);
  console.log(`(Make sure the backend is also running: cd ../backend && node server.js)`);
});
