const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClient } = require("@libsql/client");

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
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function rowsToObjects(result) {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column) => [column, row[column]])),
  );
}

module.exports = { openDb, rowsToObjects };
