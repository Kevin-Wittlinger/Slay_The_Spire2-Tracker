// Database health check: how big each table is, and whether any leftover or overlapping data is lying
// around. Read-only unless --fix is given.
//
//   npm run db:health            report only (changes nothing)
//   npm run db:health -- --fix   also delete the leftovers listed as "fixable"
//
// Which database: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (from .env or the shell) for the live site,
// otherwise DB_PATH or data/spire-ledger.db. Running it costs a few full table reads on Turso (about
// the size of the tables below), which is tiny next to normal site traffic.
//
// It never deletes runs or profiles. "Fixable" covers only data nothing can see or use any more:
// rows of deleted runs, links to missing runs or profiles, expired sign-ins, old rate-limit counters.

const path = require("path");
const { pathToFileURL } = require("url");
require("../lib/env").loadEnv();
const { createClient } = require("@libsql/client");

const FIX = process.argv.includes("--fix");
const DAY = 24 * 60 * 60 * 1000;

const RUN_CHILD_TABLES = ["run_cards", "run_relics", "card_choices", "run_acts", "run_players", "fights", "events"];
const TABLES = [
  "runs", ...RUN_CHILD_TABLES, "profiles", "profile_runs", "profile_badges", "profile_sessions",
  "steam_names", "rate_limits", "maintenance", "schema_migrations",
];

function connect() {
  if (process.env.TURSO_DATABASE_URL) {
    console.log(`Database: ${new URL(process.env.TURSO_DATABASE_URL).host} (Turso)`);
    return createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  const file = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "data", "spire-ledger.db"));
  console.log(`Database: ${file} (local)`);
  return createClient({ url: pathToFileURL(file).href });
}

async function main() {
  const db = connect();
  const existing = new Set(
    (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name),
  );
  const has = (table) => existing.has(table);
  const count = async (sql, args = []) => Number((await db.execute({ sql, args })).rows[0].n);

  console.log("\nRows per table");
  for (const table of TABLES) {
    if (has(table)) console.log(`  ${table.padEnd(18)} ${(await count(`SELECT COUNT(*) n FROM ${table}`)).toLocaleString()}`);
  }

  // Each check: what it is, how many, whether --fix may delete it, and the delete.
  const checks = [];
  const add = (label, n, fix, note) => checks.push({ label, n, fix, note });
  const now = Date.now();

  for (const table of RUN_CHILD_TABLES.filter(has)) {
    const where = `run_id NOT IN (SELECT run_id FROM runs)`;
    add(`${table} rows whose run no longer exists`, await count(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`),
      { sql: `DELETE FROM ${table} WHERE ${where}` });
  }
  if (has("profile_runs")) {
    const where = `run_id NOT IN (SELECT run_id FROM runs) OR profile_id NOT IN (SELECT profile_id FROM profiles)`;
    add("profile_runs links to a missing run or profile", await count(`SELECT COUNT(*) n FROM profile_runs WHERE ${where}`),
      { sql: `DELETE FROM profile_runs WHERE ${where}` });
  }
  if (has("profile_badges")) {
    const where = `profile_id NOT IN (SELECT profile_id FROM profiles)`;
    add("badges of deleted profiles", await count(`SELECT COUNT(*) n FROM profile_badges WHERE ${where}`),
      { sql: `DELETE FROM profile_badges WHERE ${where}` });
  }
  if (has("profile_sessions")) {
    add("expired sign-ins", await count("SELECT COUNT(*) n FROM profile_sessions WHERE expires_at <= ?", [now]),
      { sql: "DELETE FROM profile_sessions WHERE expires_at <= ?", args: [now] });
  }
  if (has("rate_limits")) {
    add("rate-limit counters older than a day", await count("SELECT COUNT(*) n FROM rate_limits WHERE window_start < ?", [now - DAY]),
      { sql: "DELETE FROM rate_limits WHERE window_start < ?", args: [now - DAY] });
  }

  // Report only: these are real data, so deciding what to do with them is up to you.
  add("runs with no profile (imported before profiles existed; they count in Everyone)",
    await count("SELECT COUNT(*) n FROM runs WHERE run_id NOT IN (SELECT run_id FROM profile_runs)"), null,
    "Kept: they are real runs. Delete them by hand only if you don't want them in the combined stats.");
  add("the same run stored twice (same seed, start time and player)",
    await count(`SELECT COUNT(*) n FROM (SELECT 1 FROM runs GROUP BY seed, start_time, COALESCE(player_id, '')
                 HAVING COUNT(*) > 1)`), null,
    "Should always be 0; the run id is built from these, so the database refuses a second copy.");
  if (has("run_players")) {
    add("multiplayer runs uploaded by more than one teammate",
      await count(`SELECT COUNT(*) n FROM (SELECT 1 FROM runs WHERE player_count > 1
                   GROUP BY seed, start_time HAVING COUNT(*) > 1)`), null,
      "Expected, not a problem: each teammate's upload is their own side of the run (their deck and relics).");
  }

  console.log("\nChecks");
  for (const c of checks) {
    const tag = c.fix ? (c.n ? "fixable" : "ok") : "info";
    console.log(`  [${tag.padEnd(7)}] ${c.label}: ${c.n.toLocaleString()}`);
    if (c.note && c.n) console.log(`              ${c.note}`);
  }

  const fixable = checks.filter((c) => c.fix && c.n);
  if (!fixable.length) {
    console.log("\nNothing to clean up.");
  } else if (!FIX) {
    console.log(`\n${fixable.length} kind(s) of leftover data can be removed. Run again with --fix to delete them.`);
  } else {
    await db.batch(fixable.map((c) => ({ sql: c.fix.sql, args: c.fix.args || [] })), "write");
    console.log(`\nDeleted: ${fixable.map((c) => `${c.n.toLocaleString()} ${c.label}`).join("; ")}.`);
  }
  db.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
