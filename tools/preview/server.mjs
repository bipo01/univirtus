// Servidor do preview da interface (sem instalar a extensão):
//   node tools/preview/server.mjs [porta]
//   http://127.0.0.1:8765/app/preview.html            → logado, com dados fictícios
//   http://127.0.0.1:8765/app/preview.html?logged=0   → tela de login
// /__media/* gera arquivos fictícios (com HEAD e Range) e simula ~6 MB/s por conexão.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../extension');
const port = Number(process.argv[2] || 8765);
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function mediaSize(name) {
  if (/\/L[^/]*$/.test(name) && !/D0-/.test(name)) return null; // Libras só existe na disciplina 0
  let hsh = 0;
  for (const c of name) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  if (/aud\./.test(name)) return 1_500_000 + (hsh % 2_000_000);
  if (/-A\d+\.mp4$/.test(name)) return 40_000_000 + (hsh % 20_000_000);
  if (/Repositorio/.test(name)) return 200_000 + (hsh % 900_000);
  return 4_000_000 + (hsh % 12_000_000);
}

function serveMedia(req, res, name) {
  const size = mediaSize(name);
  if (size == null) {
    res.writeHead(404);
    return res.end();
  }
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  let pos = start;
  const chunk = Buffer.alloc(64 * 1024, 7);
  const timer = setInterval(() => {
    for (let k = 0; k < 6 && pos <= end; k++) {
      const n = Math.min(chunk.length, end - pos + 1);
      res.write(n === chunk.length ? chunk : chunk.subarray(0, n));
      pos += n;
    }
    if (pos > end) {
      clearInterval(timer);
      res.end();
    }
  }, 60);
  req.on('close', () => clearInterval(timer));
}

// No preview não existe a regra declarativeNetRequest da extensão: este proxy faz o papel dela
// (Origin do YouTube) e libera CORS para a página local.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
async function proxyYouTube(req, res, target) {
  try {
    const host = new URL(target).hostname;
    if (!/(^|\.)(youtube\.com|googlevideo\.com)$/.test(host)) throw new Error('host');
    const body = req.method === 'POST' ? await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }) : undefined;
    const headers = { 'User-Agent': UA };
    for (const h of ['content-type', 'x-youtube-client-name', 'x-youtube-client-version', 'x-goog-visitor-id']) if (req.headers[h]) headers[h] = req.headers[h];
    if (host.endsWith('youtube.com')) headers.Origin = 'https://www.youtube.com';
    const r = await fetch(target, { method: req.method, headers, body });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502);
    res.end(String(e.message));
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/__media/')) return serveMedia(req, res, p.slice(9));
    if (p === '/__yt') return proxyYouTube(req, res, url.searchParams.get('u'));
    if (p === '/__export' && req.method === 'POST') {
      const out = path.join(os.tmpdir(), `ava-preview-${path.basename(url.searchParams.get('name') || 'out.bin')}`);
      const ws = fs.createWriteStream(out);
      req.pipe(ws);
      ws.on('finish', () => res.end(out));
      return undefined;
    }
    if (p === '/app/preview.html') {
      const html = fs.readFileSync(path.join(root, 'app/app.html'), 'utf8').replace('<script type="module"', '<script src="/__mock/chrome-mock.js"></script>\n    <script type="module"');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const file = p.startsWith('/__mock/') ? path.join(here, p.slice(8)) : path.join(root, p);
    if (!file.startsWith(root) && !file.startsWith(here)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`preview: http://127.0.0.1:${port}/app/preview.html`));
