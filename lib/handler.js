const crypto = require("crypto");
const { createImporter } = require("./importer");
const { rowsToObjects } = require("./db");
const { TABS, runQuery } = require("../db/queries");

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
  return true;
}

function hasImportAccess(req) {
  const expected = process.env.IMPORT_TOKEN || "";
  if (!expected) return !process.env.VERCEL;
  const authorization = req.headers.authorization || "";
  const supplied = Buffer.from(
    authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
  );
  const token = Buffer.from(expected);
  return (
    supplied.length === token.length && crypto.timingSafeEqual(supplied, token)
  );
}

async function readJson(req, limit) {
  if (req.body !== undefined) {
    const body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > limit)
      throw new Error("Request body is too large.");
    return typeof req.body === "string" ? JSON.parse(body) : req.body;
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Request body is too large."));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function intOrNull(value) {
  return value === null || value === undefined || value === ""
    ? null
    : parseInt(value, 10);
}

function createHandler(db) {
  const importer = createImporter(db);
  if (process.env.VERCEL && !process.env.IMPORT_TOKEN) {
    throw new Error("Set IMPORT_TOKEN in the Vercel project settings.");
  }

  return async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    let pathname = url.pathname;
    if (pathname === "/api/index" && url.searchParams.has("route")) {
      pathname = `/api/${url.searchParams.get("route").replace(/^\/+/, "")}`;
      url.searchParams.delete("route");
    }
    if (!pathname.startsWith("/api/")) return false;

    try {
      if (pathname === "/api/status") {
        const result = await db.execute("SELECT COUNT(*) AS runs FROM runs");
        return send(res, 200, { runs: Number(result.rows[0].runs) });
      }

      if (pathname === "/api/tabs") {
        return send(
          res,
          200,
          Object.entries(TABS)
            .filter(([, tab]) => !tab.hidden)
            .map(([id, tab]) => ({ id, title: tab.title })),
        );
      }

      if (pathname === "/api/filters") {
        const [characters, ascensions] = await Promise.all([
          db.execute("SELECT DISTINCT character FROM runs ORDER BY 1"),
          db.execute("SELECT DISTINCT ascension FROM runs ORDER BY 1"),
        ]);
        return send(res, 200, {
          characters: characters.rows.map((row) => row.character),
          ascensions: ascensions.rows.map((row) => row.ascension),
        });
      }

      if (pathname.startsWith("/api/stats/")) {
        const id = pathname.slice("/api/stats/".length);
        const rows = await runQuery(db, id, {
          character: url.searchParams.get("character") || null,
          ascension: intOrNull(url.searchParams.get("ascension")),
          min: Math.max(1, intOrNull(url.searchParams.get("min")) || 1),
        });
        return rows
          ? send(res, 200, rows)
          : send(res, 404, { error: "Unknown stat" });
      }

      if (pathname === "/api/import" && req.method === "POST") {
        if (!hasImportAccess(req))
          return send(res, 401, { error: "A valid import key is required." });
        const payload = await readJson(req, 4 * 1024 * 1024);
        const results = {
          imported: 0,
          duplicate: 0,
          multiplayer: 0,
          invalid: 0,
        };
        for (const run of Array.isArray(payload) ? payload : [payload]) {
          results[(await importer.importRun(run)).status]++;
        }
        return send(res, 200, results);
      }

      if (pathname === "/api/sql" && req.method === "POST") {
        if (!hasImportAccess(req))
          return send(res, 401, { error: "A valid import key is required." });
        const { sql: rawSql } = await readJson(req, 100 * 1024);
        const sql = String(rawSql || "").trim();
        if (!/^SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) {
          return send(res, 400, {
            error: "Only a single SELECT query is allowed.",
          });
        }
        return send(
          res,
          200,
          rowsToObjects(await db.execute(sql)).slice(0, 1000),
        );
      }

      if (pathname === "/api/export" && req.method === "GET") {
        if (!hasImportAccess(req))
          return send(res, 401, { error: "A valid import key is required." });
        const tables = [
          "runs",
          "run_cards",
          "run_relics",
          "card_choices",
          "fights",
          "events",
        ];
        const entries = await Promise.all(
          tables.map(async (table) => [
            table,
            rowsToObjects(await db.execute(`SELECT * FROM ${table}`)),
          ]),
        );
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="sts2-tracker-export.json"',
        );
        return send(res, 200, Object.fromEntries(entries));
      }

      return send(res, 404, { error: "Not found" });
    } catch (error) {
      return send(res, error.message.includes("too large") ? 413 : 400, {
        error: error.message,
      });
    }
  };
}

module.exports = { createHandler };
