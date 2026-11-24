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
  // The run page: how a run ended (HP, gold, potions, game mode) and card enchantments. The rooms
  // themselves are the new run_rooms table (schema.sql). Older runs get these on their next import.
  {
    version: 5,
    name: "run page columns",
    up: async (db) => {
      await addColumns(db, "runs", {
        game_mode: "TEXT",
        final_hp: "INTEGER",
        max_hp: "INTEGER",
        gold: "INTEGER",
        potion_slots: "INTEGER",
        potions: "TEXT",
      });
      await addColumns(db, "run_cards", { enchantment: "TEXT" });
    },
  },
  // The act of every card offer, so Card pick rate can filter by area as cheaply as the fight tabs
  // (finding it through the fight on the same floor made that tab slow). Older rows take it from the
  // fight on their floor, or from the run page's rooms (shop offers); new imports store it directly.
  {
    version: 6,
    name: "card offer act",
    up: async (db) => {
      if (!(await hasTable(db, "card_choices"))) return;
      await addColumns(db, "card_choices", { act: "INTEGER" });
      const sources = [];
      for (const table of ["fights", "run_rooms"])
        if (await hasTable(db, table))
          sources.push(`(SELECT t.act FROM ${table} t WHERE t.run_id = card_choices.run_id AND t.floor = card_choices.floor)`);
      if (!sources.length) return;
      await db.execute(`UPDATE card_choices SET act = COALESCE(${sources.join(", ")}, NULL) WHERE act IS NULL`);
    },
  },
];

// Adds each column the table doesn't have yet. A table that doesn't exist is left alone (schema.sql
// creates it with every column).
async function addColumns(db, table, columns) {
  const have = new Set((await db.execute(`PRAGMA table_info(${table})`)).rows.map((row) => row.name));
  if (!have.size) return;
  for (const [name, type] of Object.entries(columns)) {
    if (have.has(name)) continue;
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    } catch (error) {
      // Another cold start added it at the same moment.
      if (!/duplicate column/i.test(error.message)) throw error;
    }
  }
}

async function hasTable(db, table) {
  const found = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  return found.rows.length > 0;
}

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
