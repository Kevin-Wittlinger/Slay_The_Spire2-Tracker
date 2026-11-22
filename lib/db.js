const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClient } = require("@libsql/client");
const { backfillAreas } = require("./areas");
const { backfillRelicSources } = require("./relics");
const { migrate } = require("./migrations");

const SCHEMA = path.join(__dirname, "..", "db", "schema.sql");

async function openDb(file) {
  const remoteUrl = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (process.env.VERCEL && (!remoteUrl || !authToken)) {
    throw new Error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel.");
  }

  const database =
    file ||
    process.env.DB_PATH ||
    path.join(__dirname, "..", "data", "spire-ledger.db");
  const isUrl = /^(file:|libsql:|https:)/.test(database);
  const url =
    remoteUrl ||
    (database === ":memory:" || isUrl
      ? database
      : pathToFileURL(path.resolve(database)).href);
  if (!remoteUrl && database !== ":memory:" && !isUrl) {
    fs.mkdirSync(path.dirname(path.resolve(database)), { recursive: true });
  }

  const db = createClient({ url, authToken });
  try {
    await db.executeMultiple(fs.readFileSync(SCHEMA, "utf8"));
    // Layout changes for older databases (lib/migrations.js), each applied once.
    await migrate(db);
    // Old runs get relic origins and areas worked out. Their "anything to do?" checks read every run, and
    // runs whose area can't be worked out are looked at again each time, which on Turso is billed per
    // row read. So they run at most once a day, not on every Vercel cold start. A failure never stops the site.
    if (await claimDailyTask(db, "backfills")) {
      await Promise.all([
        backfillRelicSources(db).catch((error) =>
          console.error("Relic source backfill skipped:", error.message),
        ),
        backfillAreas(db).catch((error) =>
          console.error("Area backfill skipped:", error.message),
        ),
      ]);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const DAY = 24 * 60 * 60 * 1000;

// True (and stamps the task) when it hasn't run in the last day. One cold start claims it; the
// others that start at the same moment see the fresh stamp and skip it.
async function claimDailyTask(db, task, every = DAY) {
  const now = Date.now();
  const claimed = await db.execute({
    sql: `INSERT INTO maintenance (task, last_run) VALUES (?, ?)
          ON CONFLICT(task) DO UPDATE SET last_run = excluded.last_run
          WHERE maintenance.last_run <= ?`,
    args: [task, now, now - every],
  });
  return Number(claimed.rowsAffected) > 0;
}

function rowsToObjects(result) {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column) => [column, row[column]])),
  );
}

module.exports = { openDb, rowsToObjects, claimDailyTask };
