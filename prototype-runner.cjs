const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const encoded = ['00','01','02','03','04','05']
  .map((n) => fs.readFileSync(path.join(__dirname, `site.part${n}`), 'utf8').trim())
  .join('');
const html = zlib.gunzipSync(Buffer.from(encoded, 'base64'));
const port = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, app: 'vantage-unified-demo', build: 'full' }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`VANTAGE Unified full demo listening on ${port}`);
});
