// Multiplayer (co-op) runs.
//
// A solo run file lists one player with id 1. A multiplayer file lists every player with their Steam id,
// and nothing in it says which of them saved the file. So the uploader's Steam id is worked out at import
// (from the Steam folder in the file path, or as the one id every multiplayer run in the upload shares),
// remembered on the profile (profiles.steam_id) and used to pick "your" deck, relics and room stats.
//
// Each player's file of the same run is stored as its own row (run_id = seed:start_time:steam_id), so a
// teammate who imports their copy adds their own perspective. run_players lists everyone in the run.

// Steam ids are 17 digits, past what a JS number holds exactly, so the page sends them as strings.
// A number that already lost precision is rejected instead of being stored wrong.
function steamId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const text = String(value ?? "");
  return /^\d{5,20}$/.test(text) && text !== "1" ? text : null;
}

// The one id found in every multiplayer run of an upload (and only one such id), else null.
function inferSelfId(runs) {
  const multi = runs.filter((j) => Array.isArray(j?.players) && j.players.length > 1);
  if (multi.length < 2) return null;
  const counts = new Map();
  for (const j of multi) {
    for (const id of new Set(j.players.map((p) => steamId(p?.id)).filter(Boolean)))
      counts.set(id, (counts.get(id) || 0) + 1);
  }
  const everywhere = [...counts].filter(([, n]) => n === multi.length).map(([id]) => id);
  return everywhere.length === 1 ? everywhere[0] : null;
}

// Adds the multiplayer columns to databases created before they existed. Safe to run every start.
async function ensureMultiplayerColumns(db) {
  const columns = async (table) =>
    (await db.execute(`PRAGMA table_info(${table})`)).rows.map((row) => row.name);
  const [runCols, profileCols] = await Promise.all([columns("runs"), columns("profiles")]);
  const changes = [];
  if (!runCols.includes("player_count"))
    changes.push("ALTER TABLE runs ADD COLUMN player_count INTEGER NOT NULL DEFAULT 1");
  if (!runCols.includes("player_id")) changes.push("ALTER TABLE runs ADD COLUMN player_id TEXT");
  if (!profileCols.includes("steam_id")) changes.push("ALTER TABLE profiles ADD COLUMN steam_id TEXT");
  changes.push(
    "CREATE INDEX IF NOT EXISTS idx_runs_player_count ON runs(player_count)",
    "CREATE INDEX IF NOT EXISTS idx_profiles_steam ON profiles(steam_id)",
  );
  await db.batch(changes, "write");
}

module.exports = { steamId, inferSelfId, ensureMultiplayerColumns };
