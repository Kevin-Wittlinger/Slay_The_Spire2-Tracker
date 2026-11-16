const crypto = require("crypto");
const { promisify } = require("util");
const { createImporter } = require("./importer");
const { rowsToObjects } = require("./db");
const { TABS, runQuery } = require("../db/queries");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "sts2_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
  return true;
}

function readCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  const entry = cookies
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

function setSessionCookie(req, res, token, maxAge) {
  const secure =
    process.env.VERCEL || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}

async function getProfile(db, req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const result = await db.execute({
    sql: `SELECT p.profile_id, p.username
      FROM profile_sessions s JOIN profiles p ON p.profile_id = s.profile_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    args: [crypto.createHash("sha256").update(token).digest("hex"), Date.now()],
  });
  if (!result.rows.length) return null;
  return {
    id: Number(result.rows[0].profile_id),
    username: result.rows[0].username,
  };
}

async function issueSession(db, req, res, profile) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + SESSION_TTL;
  await db.execute({
    sql: "INSERT INTO profile_sessions (token_hash, profile_id, expires_at) VALUES (?,?,?)",
    args: [tokenHash, profile.id, expiresAt],
  });
  await db.execute({
    sql: "DELETE FROM profile_sessions WHERE expires_at <= ?",
    args: [Date.now()],
  });
  setSessionCookie(req, res, token, SESSION_TTL / 1000);
  return send(res, 200, {
    profile: { id: profile.id, username: profile.username },
  });
}

function hasAdminAccess(req) {
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

  return async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    let pathname = url.pathname;
    if (pathname === "/api/index" && url.searchParams.has("route")) {
      pathname = `/api/${url.searchParams.get("route").replace(/^\/+/, "")}`;
      url.searchParams.delete("route");
    }
    if (!pathname.startsWith("/api/")) return false;

    try {
      if (pathname === "/api/register" && req.method === "POST") {
        const body = await readJson(req, 16 * 1024);
        const username = String(body?.username || "").trim();
        const password = String(body?.password || "");
        if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
          return send(res, 400, {
            error:
              "Username must be 3-24 letters, numbers, underscores, or hyphens.",
          });
        }
        if (password.length < 10 || password.length > 128) {
          return send(res, 400, {
            error: "Password must be between 10 and 128 characters.",
          });
        }
        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
        try {
          const result = await db.execute({
            sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES (?,?,?,?)",
            args: [username, salt, passwordHash, Date.now()],
          });
          return issueSession(db, req, res, {
            id: Number(result.lastInsertRowid),
            username,
          });
        } catch (error) {
          if (error.message.includes("UNIQUE constraint failed")) {
            return send(res, 409, { error: "That username is already taken." });
          }
          throw error;
        }
      }

      if (pathname === "/api/login" && req.method === "POST") {
        const body = await readJson(req, 16 * 1024);
        const username = String(body?.username || "").trim();
        const password = String(body?.password || "");
        const result = await db.execute({
          sql: "SELECT profile_id, username, password_salt, password_hash FROM profiles WHERE username = ?",
          args: [username],
        });
        if (!result.rows.length)
          return send(res, 401, { error: "Invalid username or password." });
        const row = result.rows[0];
        const supplied = await scrypt(password, row.password_salt, 64);
        const expected = Buffer.from(row.password_hash, "hex");
        if (
          supplied.length !== expected.length ||
          !crypto.timingSafeEqual(supplied, expected)
        ) {
          return send(res, 401, { error: "Invalid username or password." });
        }
        return issueSession(db, req, res, {
          id: Number(row.profile_id),
          username: row.username,
        });
      }

      if (pathname === "/api/me") {
        const profile = await getProfile(db, req);
        return send(res, 200, { profile });
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) {
          await db.execute({
            sql: "DELETE FROM profile_sessions WHERE token_hash = ?",
            args: [crypto.createHash("sha256").update(token).digest("hex")],
          });
        }
        setSessionCookie(req, res, "", 0);
        return send(res, 200, { profile: null });
      }

      const profile = await getProfile(db, req);
      if (pathname === "/api/status") {
        const profileScope = url.searchParams.get("scope") === "profile";
        if (profileScope && !profile)
          return send(res, 401, { error: "Sign in to view your profile." });
        const result = profileScope
          ? await db.execute({
              sql: "SELECT COUNT(*) AS runs FROM profile_runs WHERE profile_id = ?",
              args: [profile.id],
            })
          : await db.execute("SELECT COUNT(*) AS runs FROM runs");
        return send(res, 200, { runs: Number(result.rows[0].runs), profile });
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
        const profileScope = url.searchParams.get("scope") === "profile";
        if (profileScope && !profile)
          return send(res, 401, { error: "Sign in to view your profile." });
        const args = profileScope ? [profile.id] : [];
        const scope = profileScope
          ? "WHERE EXISTS (SELECT 1 FROM profile_runs pr WHERE pr.run_id = runs.run_id AND pr.profile_id = ?)"
          : "";
        const [characters, ascensions] = await Promise.all([
          db.execute({
            sql: `SELECT DISTINCT character FROM runs ${scope} ORDER BY 1`,
            args,
          }),
          db.execute({
            sql: `SELECT DISTINCT ascension FROM runs ${scope} ORDER BY 1`,
            args,
          }),
        ]);
        return send(res, 200, {
          characters: characters.rows.map((row) => row.character),
          ascensions: ascensions.rows.map((row) => row.ascension),
        });
      }

      if (pathname.startsWith("/api/stats/")) {
        const profileScope = url.searchParams.get("scope") === "profile";
        if (profileScope && !profile)
          return send(res, 401, { error: "Sign in to view your profile." });
        const id = pathname.slice("/api/stats/".length);
        const rows = await runQuery(db, id, {
          character: url.searchParams.get("character") || null,
          ascension: intOrNull(url.searchParams.get("ascension")),
          min: Math.max(1, intOrNull(url.searchParams.get("min")) || 1),
          profileId: profileScope ? profile.id : null,
        });
        return rows
          ? send(res, 200, rows)
          : send(res, 404, { error: "Unknown stat" });
      }

      if (pathname === "/api/import" && req.method === "POST") {
        if (!profile)
          return send(res, 401, {
            error: "Create a profile or sign in before importing runs.",
          });
        const payload = await readJson(req, 4 * 1024 * 1024);
        const results = {
          imported: 0,
          duplicate: 0,
          multiplayer: 0,
          invalid: 0,
        };
        for (const run of Array.isArray(payload) ? payload : [payload]) {
          results[(await importer.importRun(run, profile.id)).status]++;
        }
        return send(res, 200, results);
      }

      if (pathname === "/api/sql" && req.method === "POST") {
        if (!hasAdminAccess(req))
          return send(res, 401, { error: "Admin key required." });
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
        if (!hasAdminAccess(req))
          return send(res, 401, { error: "Admin key required." });
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
