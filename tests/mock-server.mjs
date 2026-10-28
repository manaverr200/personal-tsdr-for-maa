// Offline browser verification only. All API responses are synthetic. Never proxies USPTO.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
const project = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(project, 'public');
const fixture = await fs.readFile(new URL('./fixtures/documents.xml', import.meta.url), 'utf8');
const requests = [];
let report = 'Browser checks have not run yet.';
const port = Number(process.argv[2] || 8788);
function pdf() {
  const stream = title => 'BT /F1 24 Tf 55 735 Td (' + title + ') Tj /F1 13 Tf 0 -40 Td (Synthetic local fixture - no USPTO request) Tj ET';
  const a = stream('OFFLINE STATUS SAMPLE'), b = stream('SECOND PAGE - SCROLL CHECK');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + a.length + ' >>\nstream\n' + a + '\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '<< /Length ' + b.length + ' >>\nstream\n' + b + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 8\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + 'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
}
function png() {
  function chunk(name, data) {
    const type = Buffer.from(name), bytes = Buffer.concat([type, data]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), check = Buffer.alloc(4); length.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, check]);
  }
  const width = 320, height = 180, header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 3 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const light = x > 40 && x < 280 && y > 45 && y < 135;
    rows[offset] = light ? 243 : 40; rows[offset + 1] = light ? 245 : 92; rows[offset + 2] = light ? 238 : 73;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const statusPdf = pdf(), image = png();
const jpeg = await fs.readFile(new URL('./fixtures/image.jpg', import.meta.url));
const clockScript = '<script>window.__offlineAdvance=0;const nativeNow=Date.now;Date.now=()=>nativeNow()+window.__offlineAdvance;</script>';
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8788');
  const send = (body, type = 'text/plain; charset=utf-8', status = 200, extra = {}) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); response.end(body);
  };
  try {
    if (url.pathname === '/__test__/metrics') {
      if (request.method === 'POST') requests.length = 0;
      return send(JSON.stringify(requests), 'application/json');
    }
    if (url.pathname === '/__test__/results') {
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 12000) return send('Too large', 'text/plain', 413); }
        report = body;
      }
      return send(report);
    }
    if (url.pathname === '/__test__/') return send('<!doctype html><meta charset="utf-8"><title>Offline browser checks</title><h1>Offline browser checks</h1><p>All files and API responses are synthetic. No USPTO traffic.</p><pre id="checks">Running…</pre><iframe id="app" title="Local app under test" style="width:100%;height:1000px;border:1px solid #ccc"></iframe><script type="module" src="/__test__/browser-checks.mjs"></script>', 'text/html');
    if (url.pathname === '/__test__/browser-checks.mjs') return send(await fs.readFile(new URL('./browser-checks.mjs', import.meta.url)), 'text/javascript');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/lookup') return send('Signed in.');
      const action = url.searchParams.get('action'), id = url.searchParams.get('id') || '';
      requests.push({ action, format: url.searchParams.get('format'), id });
      if (action === 'documents') {
        const limited = '<Document><DocumentId>RATE123</DocumentId><Description>Rate limit test document</Description><MailRoomDate>20260101</MailRoomDate></Document>';
        return send(fixture.replace('</DocumentList>', limited + '</DocumentList>').replaceAll('99638920', url.searchParams.get('sn')), 'application/xml');
      }
      if (id === 'RATE123') return send('USPTO rate limit reached. Please wait.', 'text/plain', 429, { 'Retry-After': '90' });
      if (id.startsWith('ORIG') && url.searchParams.get('format') === 'page') return send(Buffer.from([73,73,42,0,8,0,0,0]), 'image/tiff');
      if (action === 'preview' && url.searchParams.get('format') === 'asset') return send(jpeg, 'image/jpg');
      if (action === 'preview' && url.searchParams.get('format') === 'page') return send(image, 'image/png');
      return send(statusPdf, 'application/pdf', 200, { 'Server-Timing': 'app;dur=1, uspto;dur=10' });
    }
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep)) return send('Not found.', 'text/plain', 404);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript' };
    if (!types[path.extname(file)]) return send('Not found.', 'text/plain', 404);
    let body = await fs.readFile(file);
    if (path.extname(file) === '.html') body = body.toString().replace('</head>', clockScript + '</head>');
    send(body, types[path.extname(file)]);
  } catch { send('Not found.', 'text/plain', 404); }
});
server.listen(port, '127.0.0.1', () => console.log('Offline fixture server: http://127.0.0.1:' + port + '/__test__/ (no real API calls)'));
