// ============================================================
// DASHBOARD SERVER — serves dashboard.html + data/ behind
// HTTP Basic Auth. Uses ONLY Node built-ins — no Express,
// no extra npm install needed.
// ============================================================

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT   = Number(process.env.DASHBOARD_PORT) || 8080;
const USER   = process.env.DASHBOARD_USER || 'aiden';
const PASS   = process.env.DASHBOARD_PASS || 'changeme';
const ROOT   = process.cwd();          // /root/stock-bot

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  // ── Health check (no auth) ────────────────────────────
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── Basic Auth ────────────────────────────────────────
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Stock Bot Dashboard"',
      'Content-Type': 'text/plain',
    });
    res.end('Authentication required');
    return;
  }
  const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (u !== USER || p !== PASS) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Stock Bot Dashboard"',
      'Content-Type': 'text/plain',
    });
    res.end('Invalid credentials');
    return;
  }

  // ── Route / → dashboard.html ──────────────────────────
  let urlPath = req.url?.split('?')[0] || '/';
  if (urlPath === '/' || urlPath === '/dashboard') urlPath = '/dashboard.html';

  // ── Serve file ────────────────────────────────────────
  const filePath = path.join(ROOT, urlPath);

  // Safety: prevent directory traversal outside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, rawData) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    // Inject FMP key so it's pre-filled on every device automatically.
    // The key never appears in the repo — it comes from .env at serve time.
    if (urlPath === '/dashboard.html') {
      const fmpKey = (process.env.FMP_API_KEY || '').replace(/"/g, '\\"');
      const html = rawData.toString('utf8').replace('__FMP_INJECT__', fmpKey);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': mime });
    res.end(rawData);
  });
});

server.listen(PORT, () => {
  console.log(`[Dashboard] Listening on port ${PORT}`);
  console.log(`[Dashboard] http://YOUR_VPS_IP:${PORT}`);
  console.log(`[Dashboard] User: ${USER}`);
});