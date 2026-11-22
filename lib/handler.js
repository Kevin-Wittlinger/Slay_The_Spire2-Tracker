const crypto = require("crypto");
const { promisify } = require("util");
const { createImporter } = require("./importer");
const { rowsToObjects } = require("./db");
const { TABS, runQuery } = require("../db/queries");
const { profileAchievements } = require("./achievements");
const { HttpError, clientIp, createRateLimiter } = require("./ratelimit");
const { steamId, inferSelfId } = require("./multiplayer");
const { steamNames } = require("./steam");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "sts2_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;
// Runs from one upload are imported a few at a time. Each run waits on the database twice, so on
// Turso this is what makes a big folder import several times faster than one run after another.
const IMPORT_CONCURRENCY = 4;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const PASSWORD_RULE = "Password must be between 5 and 128 characters.";
const validPassword = (password) => password.length >= 5 && password.length <= 128;

// A new salted scrypt hash: { salt, hash } as hex.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await scrypt(password, salt, 64)).toString("hex") };
}

// Whether `password` matches a stored salt and hash, compared in constant time.
async function passwordMatches(password, salt, hash) {
  const supplied = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// The signed-in profile with its password fields, or null.
async function getProfileWithPassword(db, req) {
  const profile = await getProfile(db, req);
  if (!profile) return null;
  const result = await db.execute({
    sql: "SELECT password_salt, password_hash FROM profiles WHERE profile_id = ?",
    args: [profile.id],
  });
  const row = result.rows[0];
  return row ? { ...profile, salt: row.password_salt, hash: row.password_hash } : null;
}

// Child tables of runs. libsql enforces foreign keys, so ON DELETE CASCADE would also clear them, but
// deleting them explicitly keeps this correct on any database where that setting is off.
const RUN_CHILD_TABLES = [
  "run_cards", "run_relics", "card_choices", "run_acts", "run_players", "fights", "events",
];

// Statements that delete a profile and everything only it owns. Runs another profile also imported
// stay (they are that player's runs too); only this profile's link to them goes.
function deleteProfileStatements(profileId) {
  const onlyMine = `SELECT pr.run_id FROM profile_runs pr
    WHERE pr.profile_id = ?
      AND NOT EXISTS (SELECT 1 FROM profile_runs o WHERE o.run_id = pr.run_id AND o.profile_id <> ?)`;
  return [
    ...RUN_CHILD_TABLES.map((table) => ({
      sql: `DELETE FROM ${table} WHERE run_id IN (${onlyMine})`,
      args: [profileId, profileId],
    })),
    { sql: `DELETE FROM runs WHERE run_id IN (${onlyMine})`, args: [profileId, profileId] },
    { sql: "DELETE FROM profile_runs WHERE profile_id = ?", args: [profileId] },
    { sql: "DELETE FROM profile_badges WHERE profile_id = ?", args: [profileId] },
    { sql: "DELETE FROM profile_sessions WHERE profile_id = ?", args: [profileId] },
    { sql: "DELETE FROM profiles WHERE profile_id = ?", args: [profileId] },
  ];
}
const toProfile = (row) => ({ id: Number(row.profile_id), username: row.username });

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
// shared cache may keep them for five minutes (then serve the old copy for up to an hour while it
// fetches a new one). Every cache hit is a query Turso doesn't bill rows for. Responses that depend on
// who is signed in ("my profile" with no profile id) are never cached. The page adds ?v=<time> after an
// import, so the importer sees their new runs at once; other visitors see them within about five minutes.
const PUBLIC_CACHE = {
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
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
    args: [hashToken(token), Date.now()],
  });
  return result.rows.length ? toProfile(result.rows[0]) : null;
}

async function issueSession(db, req, res, profile) {
  const token = crypto.randomBytes(32).toString("base64url");
  // One round trip: store the new session and clear expired ones.
  await db.batch(
    [
      {
        sql: "INSERT INTO profile_sessions (token_hash, profile_id, expires_at) VALUES (?,?,?)",
        args: [hashToken(token), profile.id, Date.now() + SESSION_TTL],
      },
      { sql: "DELETE FROM profile_sessions WHERE expires_at <= ?", args: [Date.now()] },
    ],
    "write",
  );
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

// Whose runs a request is about. The session is only looked up for "my profile", so public
// statistics never wait on a sessions query.
async function resolveProfileScope(db, url, req) {
  if (url.searchParams.get("scope") !== "profile") {
    return { profileId: null };
  }
  const requestedId = url.searchParams.get("profileId");
  if (!requestedId) {
    const sessionProfile = await getProfile(db, req);
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
  return { profileId, profile: toProfile(result.rows[0]) };
}

// Runs fn over items with at most `limit` running at once; results keep the input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The profile's Steam id. The first one found at import (folder path or inferred) is remembered;
// later imports use the remembered one.
async function resolveSteamId(db, profileId, found) {
  const row = await db.execute({
    sql: "SELECT steam_id FROM profiles WHERE profile_id = ?",
    args: [profileId],
  });
  const known = steamId(row.rows[0]?.steam_id);
  if (known || !found) return known;
  await db.execute({
    sql: "UPDATE profiles SET steam_id = ? WHERE profile_id = ? AND steam_id IS NULL",
    args: [found, profileId],
  });
  return found;
}

// Solo runs only (default), multiplayer only, or both.
function modeParam(url) {
  const value = url.searchParams.get("mode");
  return value === "multi" || value === "all" ? value : "solo";
}

// Optional string parameter that must look like an id (AREA, ANCIENT_VAKUU...), else null.
function idParam(url, name) {
  const value = url.searchParams.get(name) || "";
  return /^[A-Z_]{1,32}$/.test(value) ? value : null;
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
        if (!validPassword(password)) {
          return send(res, 400, { error: PASSWORD_RULE });
        }
        const { salt, hash } = await hashPassword(password);
        try {
          const result = await db.execute({
            sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES (?,?,?,?)",
            args: [username, salt, hash, Date.now()],
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
        if (!(await passwordMatches(password, row.password_salt, row.password_hash))) {
          return send(res, 401, { error: "Invalid username or password." });
        }
        await limiter.reset(userKey);
        return issueSession(db, req, res, toProfile(row));
      }

      // Change password: needs the current one. Every other signed-in device is signed out.
      if (pathname === "/api/password" && req.method === "POST") {
        const profile = await getProfileWithPassword(db, req);
        if (!profile) return send(res, 401, { error: "Sign in first." });
        await limiter.hit(`password:${profile.id}`, 8, 15 * MINUTE, "Too many password attempts.");
        const body = await readJson(req, 16 * 1024);
        const current = String(body?.currentPassword || "");
        const next = String(body?.newPassword || "");
        if (!(await passwordMatches(current, profile.salt, profile.hash)))
          return send(res, 401, { error: "Your current password is wrong." });
        if (!validPassword(next)) return send(res, 400, { error: PASSWORD_RULE });
        const { salt, hash } = await hashPassword(next);
        await db.batch(
          [
            {
              sql: "UPDATE profiles SET password_salt = ?, password_hash = ? WHERE profile_id = ?",
              args: [salt, hash, profile.id],
            },
            { sql: "DELETE FROM profile_sessions WHERE profile_id = ?", args: [profile.id] },
          ],
          "write",
        );
        return issueSession(db, req, res, profile);
      }

      // Delete account: needs the password. Removes the profile and every run no one else imported.
      if (pathname === "/api/delete-account" && req.method === "POST") {
        const profile = await getProfileWithPassword(db, req);
        if (!profile) return send(res, 401, { error: "Sign in first." });
        await limiter.hit(`password:${profile.id}`, 8, 15 * MINUTE, "Too many password attempts.");
        const body = await readJson(req, 16 * 1024);
        if (!(await passwordMatches(String(body?.password || ""), profile.salt, profile.hash)))
          return send(res, 401, { error: "That password is wrong." });
        await db.batch(deleteProfileStatements(profile.id), "write");
        setSessionCookie(req, res, "", 0);
        return send(res, 200, { profile: null });
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
            args: [hashToken(token)],
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

      if (pathname === "/api/status") {
        const scope = await resolveProfileScope(db, url, req);
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

      if (pathname === "/api/steam-names" && req.method === "GET") {
        await limiter.hit(`steam:${ip}`, 60, MINUTE, "Too many name lookups.");
        const ids = (url.searchParams.get("ids") || "").split(",").map((id) => id.trim());
        return send(res, 200, await steamNames(db, ids), "application/json", PUBLIC_CACHE);
      }

      if (pathname === "/api/achievements") {
        const scope = await resolveProfileScope(db, url, req);
        if (scope.error)
          return send(res, scope.error, { error: scope.message });
        if (!scope.profileId)
          return send(res, 400, { error: "Achievements belong to a profile." });
        return send(res, 200, {
          profile: scope.profile,
          ...(await profileAchievements(db, scope.profileId)),
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
        const scope = await resolveProfileScope(db, url, req);
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
        const scope = await resolveProfileScope(db, url, req);
        if (scope.error)
          return send(res, scope.error, { error: scope.message });
        const id = pathname.slice("/api/stats/".length);
        const rows = await runQuery(db, id, {
          character: url.searchParams.get("character") || null,
          ascension: intOrNull(url.searchParams.get("ascension")),
          patch: (url.searchParams.get("patch") || "").slice(0, 64) || null,
          source: idParam(url, "source"),
          area: idParam(url, "area"),
          mode: modeParam(url),
          min: Math.max(1, intOrNull(url.searchParams.get("min")) || 1),
          profileId: scope.profileId,
        });
        return rows
          ? send(res, 200, rows, "application/json", cacheFor(url))
          : send(res, 404, { error: "Unknown stat" });
      }

      if (pathname === "/api/import" && req.method === "POST") {
        const profile = await getProfile(db, req);
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
          multiplayer: 0, // multiplayer runs skipped: we couldn't tell which player is the uploader
          invalid: 0,
          abandoned: 0, // imported runs that were abandoned (stored, not counted)
          coop: 0, // imported runs that were multiplayer
        };
        // Either an array of runs, or { runs, playerId } where playerId is the Steam id the page
        // found in the folder path.
        const wrapped = payload && !Array.isArray(payload) && Array.isArray(payload.runs);
        const runs = wrapped ? payload.runs : Array.isArray(payload) ? payload : [payload];
        const selfId = await resolveSteamId(
          db,
          profile.id,
          (wrapped && steamId(payload.playerId)) || inferSelfId(runs),
        );
        const statuses = await mapLimit(runs, IMPORT_CONCURRENCY, async (run) => {
          try {
            return (await importer.importRun(run, profile.id, { selfId })).status;
          } catch (error) {
            console.error("Import failed for one run:", error.message);
            return "invalid";
          }
        });
        statuses.forEach((status, i) => {
          results[status]++;
          if (status === "imported" && runs[i]?.was_abandoned) results.abandoned++;
          if (status === "imported" && runs[i]?.players?.length > 1) results.coop++;
        });
        // Look up the new teammates' Steam names now, so the tables don't wait on Steam later.
        // Best effort: a failure here only means the names are fetched when a table is first viewed.
        if (results.coop) {
          const teammates = new Set();
          for (const run of runs)
            for (const player of run?.players?.length > 1 ? run.players : [])
              if (steamId(player?.id) && steamId(player.id) !== selfId) teammates.add(steamId(player.id));
          const ids = [...teammates].slice(0, 100);
          for (let i = 0; i < ids.length; i += 25)
            await steamNames(db, ids.slice(i, i + 25)).catch(() => {});
        }
        return send(res, 200, results);
      }

      // Both admin endpoints share one rate limit and need the IMPORT_TOKEN key.
      const isAdminRoute =
        (pathname === "/api/sql" && req.method === "POST") ||
        (pathname === "/api/export" && req.method === "GET");
      if (isAdminRoute) {
        await limiter.hit(`admin:${ip}`, 30, 15 * MINUTE, "Too many admin requests.");
        if (!hasAdminAccess(req))
          return send(res, 401, { error: "Admin key required." });
      }

      if (pathname === "/api/sql" && req.method === "POST") {
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
        // Everything needed to rebuild the site's data: runs, who imported them, and their areas.
        // Passwords, sessions and rate-limit counters are never exported.
        const tables = {
          runs: "SELECT * FROM runs",
          run_acts: "SELECT * FROM run_acts",
          run_players: "SELECT * FROM run_players",
          run_cards: "SELECT * FROM run_cards",
          run_relics: "SELECT * FROM run_relics",
          card_choices: "SELECT * FROM card_choices",
          fights: "SELECT * FROM fights",
          events: "SELECT * FROM events",
          profiles: "SELECT profile_id, username, created_at, steam_id FROM profiles",
          profile_runs: "SELECT * FROM profile_runs",
          steam_names: "SELECT * FROM steam_names",
        };
        const entries = await Promise.all(
          Object.entries(tables).map(async ([table, sql]) => [
            table,
            rowsToObjects(await db.execute(sql)),
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
