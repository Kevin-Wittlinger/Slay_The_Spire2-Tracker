// Steam display names for teammates who have no profile on this site.
//
// Run files only hold Steam ids, so names are looked up on Steam by the server and kept in
// steam_names. Only ids that appear in run_players are looked up, so this can't be used to query
// arbitrary Steam accounts. With STEAM_API_KEY set the Steam Web API is used (one request for
// many ids); without it each id's public profile page is read instead.

const STEAM_ID = /^7656\d{13}$/;
const MAX_IDS = 25;
const FOUND_TTL = 7 * 24 * 60 * 60 * 1000; // names are looked up again after a week
// A failed lookup (Steam down, rate limited, private profile without an API key) is retried after an
// hour, so a bad spell doesn't leave Steam ids on screen for a whole day.
const MISSING_TTL = 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

const cleanName = (value) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || null;

async function fetchFromApi(ids, key) {
  const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  url.searchParams.set("key", key);
  url.searchParams.set("steamids", ids.join(","));
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Steam API answered ${res.status}`);
  const players = (await res.json())?.response?.players || [];
  return new Map(players.map((p) => [String(p.steamid), cleanName(p.personaname)]));
}

async function fetchFromProfile(id) {
  const res = await fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Steam answered ${res.status}`);
  const match = (await res.text()).match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/);
  return cleanName(match?.[1]);
}

// id -> name (or null when Steam has none). Ids Steam could not be asked about are left out, so they
// keep whatever name is already stored.
async function fetchNames(ids) {
  const key = process.env.STEAM_API_KEY;
  if (key) return fetchFromApi(ids, key);
  const found = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        found.set(id, await fetchFromProfile(id));
      } catch (error) {
        console.error(`Steam name lookup failed for one id: ${error.message}`);
      }
    }),
  );
  return found;
}

// { steamId: name } for the requested ids that have a name.
async function steamNames(db, requested) {
  const ids = [...new Set(requested.filter((id) => STEAM_ID.test(id)))].slice(0, MAX_IDS);
  if (!ids.length) return {};
  const marks = ids.map(() => "?").join(",");
  const now = Date.now();

  const cached = new Map(
    (await db.execute({ sql: `SELECT steam_id, name, fetched_at FROM steam_names WHERE steam_id IN (${marks})`, args: ids })).rows.map(
      (row) => [row.steam_id, { name: row.name, at: Number(row.fetched_at) }],
    ),
  );
  const due = ids.filter((id) => {
    const hit = cached.get(id);
    return !hit || now - hit.at > (hit.name ? FOUND_TTL : MISSING_TTL);
  });

  if (due.length) {
    const known = new Set(
      (await db.execute({ sql: `SELECT DISTINCT player_id FROM run_players WHERE player_id IN (${due.map(() => "?").join(",")})`, args: due })).rows.map(
        (row) => row.player_id,
      ),
    );
    const toAsk = due.filter((id) => known.has(id));
    let fetched = new Map();
    try {
      if (toAsk.length) fetched = await fetchNames(toAsk);
    } catch (error) {
      console.error(`Steam name lookup failed: ${error.message}`);
    }
    // Ids Steam answered about are stored; a failed one is stamped too (keeping any old name) so a
    // down Steam isn't asked again on every page view.
    const writes = toAsk.map((id) => ({
      sql: `INSERT INTO steam_names (steam_id, name, fetched_at) VALUES (?,?,?)
            ON CONFLICT(steam_id) DO UPDATE SET name = COALESCE(excluded.name, steam_names.name), fetched_at = excluded.fetched_at`,
      args: [id, fetched.get(id) ?? null, now],
    }));
    if (writes.length) await db.batch(writes, "write");
    for (const [id, name] of fetched) if (toAsk.includes(id)) cached.set(id, { name, at: now });
    for (const id of toAsk) if (!fetched.has(id) && !cached.has(id)) cached.set(id, { name: null, at: now });
  }

  const out = {};
  for (const id of ids) if (cached.get(id)?.name) out[id] = cached.get(id).name;
  return out;
}

module.exports = { steamNames, STEAM_ID };
