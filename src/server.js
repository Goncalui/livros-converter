import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT, workspaceFor, PROJECT_ROOT } from './util/paths.js';
import { log } from './util/log.js';

function listSlugs() {
  if (!fs.existsSync(WORKSPACE_ROOT)) return [];
  return fs.readdirSync(WORKSPACE_ROOT).filter(s =>
    fs.existsSync(path.join(WORKSPACE_ROOT, s, '.state.json')));
}

function readState(slug) {
  const ws = workspaceFor(slug);
  if (!fs.existsSync(ws.state)) return null;
  try { return JSON.parse(fs.readFileSync(ws.state, 'utf8')); }
  catch { return null; }
}

function listOutputs(slug) {
  const ws = workspaceFor(slug);
  if (!fs.existsSync(ws.output)) return [];
  return fs.readdirSync(ws.output)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ name: f, size: fs.statSync(path.join(ws.output, f)).size }));
}

function readOutput(slug, file) {
  const ws = workspaceFor(slug);
  const safe = path.basename(file);
  const p = path.join(ws.output, safe);
  if (!p.startsWith(ws.output)) return null;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function readLog(slug, lines = 200) {
  const ws = workspaceFor(slug);
  if (!fs.existsSync(ws.log)) return '';
  const txt = fs.readFileSync(ws.log, 'utf8').split('\n');
  return txt.slice(-lines).join('\n');
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function startServer(port = 5173) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'web', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (p === '/app.js') {
      const js = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'web', 'app.js'), 'utf8');
      return send(res, 200, js, 'text/javascript; charset=utf-8');
    }
    if (p === '/api/books') return send(res, 200, listSlugs());
    if (p === '/api/state') {
      const slug = url.searchParams.get('slug');
      if (!slug) return send(res, 400, { error: 'slug obrigatório' });
      const st = readState(slug);
      if (!st) return send(res, 404, { error: 'não encontrado' });
      return send(res, 200, { state: st, outputs: listOutputs(slug) });
    }
    if (p === '/api/output') {
      const slug = url.searchParams.get('slug');
      const file = url.searchParams.get('file');
      const md = readOutput(slug, file);
      if (md == null) return send(res, 404, { error: 'arquivo não encontrado' });
      return send(res, 200, md, 'text/plain; charset=utf-8');
    }
    if (p === '/api/compare-list') {
      const slug = url.searchParams.get('slug');
      const ws = workspaceFor(slug);
      if (!fs.existsSync(ws.raw)) return send(res, 200, []);
      const files = fs.readdirSync(ws.raw)
        .filter(f => /^page-\d+\.compare\.json$/.test(f))
        .sort();
      const list = files.map(f => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(ws.raw, f), 'utf8'));
          return { page: j.page, winner: j.winner, engines: j.engines, file: f };
        } catch { return null; }
      }).filter(Boolean);
      return send(res, 200, list);
    }
    if (p === '/api/compare-page') {
      const slug = url.searchParams.get('slug');
      const page = url.searchParams.get('page');
      const ws = workspaceFor(slug);
      const n = String(parseInt(page, 10)).padStart(3, '0');
      const result = { page: parseInt(page, 10), engines: {} };
      const cmpPath = path.join(ws.raw, `page-${n}.compare.json`);
      if (fs.existsSync(cmpPath)) {
        try { Object.assign(result, JSON.parse(fs.readFileSync(cmpPath, 'utf8'))); } catch {}
      }
      for (const eng of ['paddle', 'glm', 'tesseract']) {
        const tp = path.join(ws.raw, `page-${n}.${eng}.txt`);
        if (fs.existsSync(tp)) {
          result.engines[eng] = result.engines[eng] || {};
          result.engines[eng].text = fs.readFileSync(tp, 'utf8');
        }
      }
      const imgCandidates = ['png', 'jpg', 'jpeg', 'webp']
        .map(ext => `page-${n}.${ext}`)
        .find(name => fs.existsSync(path.join(ws.raw, name)));
      if (imgCandidates) result.image = `/api/raw-image?slug=${encodeURIComponent(slug)}&file=${imgCandidates}`;
      return send(res, 200, result);
    }
    if (p === '/api/raw-image') {
      const slug = url.searchParams.get('slug');
      const file = path.basename(url.searchParams.get('file') || '');
      const ws = workspaceFor(slug);
      const fp = path.join(ws.raw, file);
      if (!fp.startsWith(ws.raw) || !fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
      const ext = file.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(fp));
    }
    if (p === '/api/log') {
      const slug = url.searchParams.get('slug');
      return send(res, 200, readLog(slug), 'text/plain; charset=utf-8');
    }
    if (p === '/api/stream') {
      const slug = url.searchParams.get('slug');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let last = '';
      const tick = () => {
        const st = readState(slug);
        const outs = listOutputs(slug);
        const data = JSON.stringify({ state: st, outputs: outs });
        if (data !== last) {
          res.write(`data: ${data}\n\n`);
          last = data;
        }
      };
      tick();
      const id = setInterval(tick, 1500);
      req.on('close', () => clearInterval(id));
      return;
    }
    send(res, 404, { error: 'rota desconhecida', path: p });
  });

  server.listen(port, () => {
    log.ok(`UI: http://localhost:${port}`);
  });
  return server;
}
