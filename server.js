// Spire Ledger server: SQLite + folder watcher + JSON API + static site.
//   npm start                       (uses config.json or RUNS_DIR)
//   node server.js "C:\path\to\runs"
// Env: PORT (default 3000), DB_PATH (default ./data/spire-ledger.db), RUNS_DIR

const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb } = require('./lib/db');
const { createImporter } = require('./lib/importer');
const { Watcher } = require('./lib/watcher');
const { TABS, runQuery } = require('./db/queries');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'spire-ledger.db');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC = path.join(__dirname, 'public');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

const db = openDb(DB_PATH);
const importer = createImporter(db);
const watcher = new Watcher(db, importer);

// ---- live updates to open browser tabs (server-sent events) ----
const clients = new Set();
function broadcast(event, data = {}) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
watcher.on('change', added => broadcast('update', { added }));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- helpers ----
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const intOrNull = v => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));

function statusInfo() {
  const files = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM imported_files GROUP BY status')
    .all().map(r => [r.status, r.n]));
  return {
    runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
    files,                                    // imported / duplicate / multiplayer / invalid
    watching: watcher.state,
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // ---------- API ----------
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/status') return send(res, 200, statusInfo());

    if (p === '/api/tabs') {
      return send(res, 200, Object.entries(TABS).filter(([, t]) => !t.hidden).map(([id, t]) => ({ id, title: t.title })));
    }
    if (p === '/api/filters') {
      return send(res, 200, {
        characters: db.prepare('SELECT DISTINCT character FROM runs ORDER BY 1').all().map(r => r.character),
        ascensions: db.prepare('SELECT DISTINCT ascension FROM runs ORDER BY 1').all().map(r => r.ascension),
      });
    }
    if (p.startsWith('/api/stats/')) {
      const id = p.slice('/api/stats/'.length);
      const q = url.searchParams;
      const rows = runQuery(db, id, {
        character: q.get('character') || null,
        ascension: intOrNull(q.get('ascension')),
        min: Math.max(1, intOrNull(q.get('min')) || 1),
      });
      return rows ? send(res, 200, rows) : send(res, 404, { error: 'Unknown stat' });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const { runsDir } = JSON.parse(await readBody(req, 1e5));
      if (!runsDir || !fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) {
        return send(res, 400, { error: 'That folder does not exist on the machine running the server.' });
      }
      writeConfig({ ...readConfig(), runsDir });
      watcher.setDir(runsDir);
      broadcast('update', { added: 0 });
      return send(res, 200, statusInfo());
    }

    // Manual import (drag and drop in the browser)
    if (p === '/api/import' && req.method === 'POST') {
      const items = JSON.parse(await readBody(req));
      const results = { imported: 0, duplicate: 0, multiplayer: 0, invalid: 0 };
      for (const j of Array.isArray(items) ? items : [items]) results[importer.importRun(j).status]++;
      if (results.imported) broadcast('update', { added: results.imported });
      return send(res, 200, results);
    }

    // Read-only SQL console. Uses a separate read-only connection, so writes are impossible.
    if (p === '/api/sql' && req.method === 'POST') {
      const { sql } = JSON.parse(await readBody(req, 1e5));
      const ro = new Database(DB_PATH, { readonly: true });
      try {
        const stmt = ro.prepare(String(sql || ''));
        if (!stmt.reader) return send(res, 400, { error: 'Only SELECT queries are allowed.' });
        return send(res, 200, stmt.all().slice(0, 1000));
      } catch (e) {
        return send(res, 400, { error: e.message });
      } finally { ro.close(); }
    }

    // Download a copy of the database file (backup, or open in DB Browser for SQLite)
    if (p === '/api/export') {
      res.writeHead(200, { 'Content-Type': 'application/x-sqlite3', 'Content-Disposition': 'attachment; filename="spire-ledger.sqlite"' });
      return res.end(db.serialize());
    }

    // ---------- static files ----------
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const runsDir = process.argv[2] || process.env.RUNS_DIR || readConfig().runsDir;
if (runsDir) {
  writeConfig({ ...readConfig(), runsDir });
  watcher.setDir(runsDir);
}

// Bound to localhost only: this server can read folders on your machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Spire Ledger running at http://localhost:${PORT}`);
  console.log(runsDir ? `Watching: ${runsDir}` : 'No run folder set yet. Set one on the website.');
});
