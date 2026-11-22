// Numbered changes to the database layout, applied once each and recorded in schema_migrations.
//
// db/schema.sql creates any missing tables and indexes, and a brand-new database gets every column from
// it. Migrations change tables that already exist in older databases (add a column, drop one, reshape
// data). To make one:
//   1. Add the change to db/schema.sql too, so new databases have it from the start.
//   2. Append { version: <next number>, name, up } below. Never edit or reorder one that has shipped.
//   3. Make `up` safe to run on a database that already has the change: a new database (from
//      schema.sql) runs every migration once, and on Vercel two cold starts may run one at the same time.

const { ensureMultiplayerColumns } = require("./multiplayer");
const { ensureRelicSourceColumn } = require("./relics");
const { recordPastBadges } = require("./achievements");

const MIGRATIONS = [
  { version: 1, name: "multiplayer columns", up: ensureMultiplayerColumns },
  { version: 2, name: "relic origin column", up: ensureRelicSourceColumn },
  // Keeps badges earned under the old "every character anyone played" rule (profile_badges).
  { version: 3, name: "keep badges earned before game-data", up: recordPastBadges },
  // Abandoned runs now count as losses. New imports store them with win = 0; this makes older rows
  // agree (the abandoned flag is kept, so they still show as abandoned).
  {
    version: 4,
    name: "abandoned runs are losses",
    up: (db) => db.execute("UPDATE runs SET win = 0 WHERE abandoned = 1 AND win <> 0"),
  },
];

async function migrate(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (await db.execute("SELECT version FROM schema_migrations")).rows.map((row) => Number(row.version)),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  // In order, one at a time: a later migration may rely on an earlier one.
  for (const migration of pending) {
    await migration.up(db);
    await db.execute({
      sql: "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)",
      args: [migration.version, migration.name, Date.now()],
    });
  }
  return pending.map((m) => m.version);
}

module.exports = { MIGRATIONS, migrate };
