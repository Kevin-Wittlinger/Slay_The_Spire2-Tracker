const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = path.join(__dirname, '..', 'db', 'schema.sql');

// Opens (and creates, if needed) the SQLite file and applies db/schema.sql.
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return db;
}

module.exports = { openDb };
