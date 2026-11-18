const crypto = require("crypto");
const { promisify } = require("util");
const { createImporter } = require("./importer");
const { rowsToObjects } = require("./db");
const { TABS, runQuery } = require("../db/queries");
const { HttpError, clientIp, createRateLimiter } = require("./ratelimit");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "sts2_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;

function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
  return true;
}

// Statistics for everyone, or for one named profile, are the same for every visitor, so Vercel's
// shared cache may keep them for a minute. Responses that depend on who is signed in ("my profile"
// with no profile id) are never cached. The page adds ?v=<time> after an import to skip the cache.
const PUBLIC_CACHE = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
};
function cacheFor(url) {
  const scope = url.searchParams.get("scope");
  return scope !== "profile" || url.searchParams.get("profileId") ? PUBLIC_CACHE : {};
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
      throw new HttpError(413, "Request body is too large.");
    try {
      return typeof req.body === "string" ? JSON.parse(body) : req.body;
    } catch {
      throw new HttpError(400, "Request body must be valid JSON.");
    }
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
      if (tooLarge)
        return reject(new HttpError(413, "Request body is too large."));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = parseInt(value, 10);
  return Number.isSafeInteger(number) ? number : null;
}

async function resolveProfileScope(db, url, sessionProfile) {
  if (url.searchParams.get("scope") !== "profile") {
    return { profileId: null };
  }
  const requestedId = url.searchParams.get("profileId");
  if (!requestedId) {
    return sessionProfile
      ? { profileId: sessionProfile.id, profile: sessionProfile }
      : { error: 401, message: "Sign in or select a public profile." };
  }
  const profileId = Number(requestedId);
  if (!Number.isSafeInteger(profileId) || profileId < 1) {
    return { error: 400, message: "Invalid profile." };
  }
  const result = await db.execute({
    sql: "SELECT profile_id, username FROM profiles WHERE profile_id = ?",
    args: [profileId],
  });
  if (!result.rows.length) return { error: 404, message: "Profile not found." };
  return {
    profileId,
    profile: {
      id: Number(result.rows[0].profile_id),
      username: result.rows[0].username,
    },
  };
}

function createHandler(db) {
  const importer = createImporter(db);
  const limiter = createRateLimiter(db);

  return async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    let pathname = url.pathname;
    if (pathname === "/api/index" && url.searchParams.has("route")) {
      pathname = `/api/${url.searchParams.get("route").replace(/^\/+/, "")}`;
      url.searchParams.delete("route");
    }
    if (!pathname.startsWith("/api/")) return false;
    const ip = clientIp(req);

    try {
      if (pathname === "/api/register" && req.method === "POST") {
        await limiter.hit(
          `register:${ip}`,
          10,
          60 * MINUTE,
          "Too many accounts created from this network.",
        );
        const body = await readJson(req, 16 * 1024);
        const username = String(body?.username || "").trim();
        const password = String(body?.password || "");
        if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
          return send(res, 400, {
            error:
              "Username must be 3-24 letters, numbers, underscores, or hyphens.",
          });
        }
        if (password.length < 5 || password.length > 128) {
          return send(res, 400, {
            error: "Password must be between 5 and 128 characters.",
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
        const userKey = `login:user:${username.toLowerCase().slice(0, 64)}`;
        await limiter.hit(
          `login:ip:${ip}`,
          30,
          15 * MINUTE,
          "Too many sign-in attempts from this network.",
        );
        await limiter.hit(
          userKey,
          8,
          15 * MINUTE,
          "Too many failed sign-in attempts for this username.",
        );
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
        await limiter.reset(userKey);
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

      if (pathname === "/api/profiles" && req.method === "GET") {
        await limiter.hit(
          `search:${ip}`,
          120,
          MINUTE,
          "Too many profile searches.",
        );
        const search = (url.searchParams.get("q") || "").trim();
        // An empty search lists the most active players.
        if (search && !/^[a-zA-Z0-9_-]{1,24}$/.test(search))
          return send(res, 200, []);
        const suggestions = await db.execute({
          sql: `SELECT p.profile_id, p.username, COUNT(r.run_id) AS runs
            FROM profiles p
            LEFT JOIN profile_runs pr ON pr.profile_id = p.profile_id
            LEFT JOIN runs r ON r.run_id = pr.run_id AND r.abandoned = 0
            WHERE ? = '' OR instr(lower(p.username), lower(?)) > 0
            GROUP BY p.profile_id
            ORDER BY (lower(substr(p.username, 1, length(?))) = lower(?)) DESC,
                     runs DESC, p.username
            LIMIT 8`,
          args: [search, search, search, search],
        });
        return send(
          res,
          200,
          suggestions.rows.map((row) => ({
            id: Number(row.profile_id),
            username: row.username,
            runs: Number(row.runs),
          })),
        );
      }

      const profile = await getProfile(db, req);
      if (pathname === "/api/status") {
        const scope = await resolveProfileScope(db, url, profile);
        if (scope.error)
          return send(res, scope.error, { error: scope.message });
        const result = scope.profileId
          ? await db.execute({
              sql: "SELECT COUNT(*) AS runs FROM profile_runs pr JOIN runs r ON r.run_id = pr.run_id WHERE pr.profile_id = ? AND r.abandoned = 0",
              args: [scope.profileId],
            })
          : await db.execute("SELECT COUNT(*) AS runs FROM runs WHERE abandoned = 0");
        return send(res, 200, {
          runs: Number(result.rows[0].runs),
          profile: scope.profile || null,
        });
      }

      if (pathname === "/api/tabs") {
        return send(
          res,
          200,
          Object.entries(TABS)
            .filter(([, tab]) => !tab.hidden)
            .map(([id, tab]) => ({ id, title: tab.title, kind: tab.kind || "table" })),
        );
      }

      if (pathname === "/api/filters") {
        const scope = await resolveProfileScope(db, url, profile);
        if (scope.error)
          return send(res, scope.error, { error: scope.message });
        const args = scope.profileId ? [scope.profileId] : [];
        const condition = scope.profileId
          ? "WHERE EXISTS (SELECT 1 FROM profile_runs pr WHERE pr.run_id = runs.run_id AND pr.profile_id = ?)"
          : "";
        const patchCondition = `${condition ? `${condition} AND` : "WHERE"} build_id IS NOT NULL`;
        const [characters, ascensions, patches] = await Promise.all([
          db.execute({
            sql: `SELECT DISTINCT character FROM runs ${condition} ORDER BY 1`,
            args,
          }),
          db.execute({
            sql: `SELECT DISTINCT ascension FROM runs ${condition} ORDER BY 1`,
            args,
          }),
          db.execute({
            sql: `SELECT DISTINCT build_id FROM runs ${patchCondition}`,
            args,
          }),
        ]);
        return send(
          res,
          200,
          {
            characters: characters.rows.map((row) => row.character),
            ascensions: ascensions.rows.map((row) => row.ascension),
            patches: patches.rows.map((row) => row.build_id),
          },
          "application/json",
          cacheFor(url),
        );
      }

      if (pathname.startsWith("/api/stats/")) {
        const scope = await resolveProfileScope(db, url, profile);
        if (scope.error)
          return send(res, scope.error, { error: scope.message });
        const id = pathname.slice("/api/stats/".length);
        const rows = await runQuery(db, id, {
          character: url.searchParams.get("character") || null,
          ascension: intOrNull(url.searchParams.get("ascension")),
          patch: (url.searchParams.get("patch") || "").slice(0, 64) || null,
          source: ["NEOW", "ANCIENT", "OTHER"].includes(url.searchParams.get("source"))
            ? url.searchParams.get("source")
            : null,
          area: /^[A-Z_]{1,32}$/.test(url.searchParams.get("area") || "")
            ? url.searchParams.get("area")
            : null,
          min: Math.max(1, intOrNull(url.searchParams.get("min")) || 1),
          profileId: scope.profileId,
        });
        return rows
          ? send(res, 200, rows, "application/json", cacheFor(url))
          : send(res, 404, { error: "Unknown stat" });
      }

      if (pathname === "/api/import" && req.method === "POST") {
        if (!profile)
          return send(res, 401, {
            error: "Create a profile or sign in before importing runs.",
          });
        await limiter.hit(
          `import:${profile.id}`,
          120,
          10 * MINUTE,
          "Too many import requests.",
        );
        const payload = await readJson(req, 4 * 1024 * 1024);
        const results = {
          imported: 0,
          duplicate: 0,
          multiplayer: 0,
          invalid: 0,
          abandoned: 0, // imported runs that were abandoned (stored, not counted)
        };
        for (const run of Array.isArray(payload) ? payload : [payload]) {
          let status;
          try {
            status = (await importer.importRun(run, profile.id)).status;
          } catch (error) {
            console.error("Import failed for one run:", error.message);
            status = "invalid";
          }
          results[status]++;
          if (status === "imported" && run?.was_abandoned) results.abandoned++;
        }
        return send(res, 200, results);
      }

      if (pathname === "/api/sql" && req.method === "POST") {
        await limiter.hit(
          `admin:${ip}`,
          30,
          15 * MINUTE,
          "Too many admin requests.",
        );
        if (!hasAdminAccess(req))
          return send(res, 401, { error: "Admin key required." });
        const { sql: rawSql } = await readJson(req, 100 * 1024);
        const sql = String(rawSql || "").trim();
        if (!/^SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) {
          return send(res, 400, {
            error: "Only a single SELECT query is allowed.",
          });
        }
        try {
          return send(
            res,
            200,
            rowsToObjects(await db.execute(sql)).slice(0, 1000),
          );
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }

      if (pathname === "/api/export" && req.method === "GET") {
        await limiter.hit(
          `admin:${ip}`,
          30,
          15 * MINUTE,
          "Too many admin requests.",
        );
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
      if (error instanceof HttpError) {
        return send(
          res,
          error.status,
          { error: error.message },
          "application/json",
          error.headers,
        );
      }
      console.error(error);
      return send(res, 500, { error: "Something went wrong on the server." });
    }
  };
}

module.exports = { createHandler };
