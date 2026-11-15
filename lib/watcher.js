// Scans a folder (recursively) for *.run files and imports new ones.
// It polls every few seconds, remembers each file's modified time in the
// imported_files table, and skips anything already handled, so restarts are cheap
// and a run that finishes while the server is up appears within seconds.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class Watcher extends EventEmitter {
  constructor(db, importer, { intervalMs = 3000, settleMs = 1500 } = {}) {
    super();
    this.importer = importer;
    this.intervalMs = intervalMs;
    this.settleMs = settleMs;   // ignore files modified this recently (game may still be writing)
    this.timer = null;
    this.dir = null;
    this.state = { dir: null, lastScan: null, error: null, lastAdded: 0 };
    this.getFile = db.prepare('SELECT mtime FROM imported_files WHERE path = ?');
    this.putFile = db.prepare(`INSERT INTO imported_files (path, mtime, status) VALUES (?,?,?)
      ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, status = excluded.status`);
  }

  setDir(dir) {
    this.stop();
    this.dir = dir || null;
    this.state = { dir: this.dir, lastScan: null, error: null, lastAdded: 0 };
    if (!this.dir) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  listRuns(dir, depth = 0, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.run')) out.push(full);
      else if (e.isDirectory() && depth < 6 && !e.name.startsWith('.') && e.name !== 'node_modules') {
        this.listRuns(full, depth + 1, out);
      }
    }
    return out;
  }

  scan() {
    if (!this.dir) return 0;
    let added = 0;
    try {
      for (const file of this.listRuns(this.dir)) {
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        const known = this.getFile.get(file);
        if (known && known.mtime === st.mtimeMs) continue;
        const age = Date.now() - st.mtimeMs;
        if (age < this.settleMs) continue;                       // still being written, try next poll
        let json;
        try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch {
          if (age > 15000) this.putFile.run(file, st.mtimeMs, 'invalid');
          continue;
        }
        const { status } = this.importer.importRun(json);
        this.putFile.run(file, st.mtimeMs, status);
        if (status === 'imported') added++;
      }
      this.state.error = null;
    } catch (e) {
      this.state.error = e.code === 'ENOENT' ? `Folder not found: ${this.dir}` : e.message;
    }
    this.state.lastScan = Date.now();
    this.state.lastAdded = added;
    this.emit('scan', this.state);
    if (added) this.emit('change', added);
    return added;
  }
}

module.exports = { Watcher };
