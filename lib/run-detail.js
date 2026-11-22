// Everything the run page shows about one run (GET /api/run?id=...): how it ended, every room in order,
// the final deck and relics, who played it and who imported it.
//
// Runs imported before run_rooms existed have no rooms (and no game_mode). For those the path is rebuilt from the fights
// and events the database kept (shops, rest sites and treasure rooms are then missing), and the answer
// says partial: true so the page can suggest importing the folder again.

const { rowsToObjects } = require("./db");
const { GAME_DATA } = require("../public/game-data");

// Neow and the Ancients are events in the run file: EVENT.NEOW, EVENT.VAKUU...
const ANCIENT_EVENTS = new Set(["NEOW", ...GAME_DATA.ancients].map((name) => `EVENT.${name.toUpperCase()}`));

async function runDetail(db, runId) {
  // seed:start_time, plus :steam id for multiplayer. Only ever used as a bound parameter.
  if (typeof runId !== "string" || !runId || runId.length > 160) return null;
  const q = (sql) => db.execute({ sql, args: [runId] }).then(rowsToObjects);
  const [runs, rooms, cards, relics, acts, players, importers] = await Promise.all([
    q(`SELECT run_id, seed, character, ascension, win, abandoned, killed_by, run_time, start_time, build_id,
              player_count, player_id, game_mode, final_hp, max_hp, gold, potion_slots, potions
       FROM runs WHERE run_id = ?`),
    q(`SELECT floor, act, map_type, room_type, model_id, hp, max_hp, gold, detail
       FROM run_rooms WHERE run_id = ? ORDER BY floor`),
    // Deck order as the game listed it.
    q("SELECT card_id, upgrade, floor_added, enchantment FROM run_cards WHERE run_id = ? ORDER BY rowid"),
    q("SELECT relic_id, floor_added, origin FROM run_relics WHERE run_id = ? ORDER BY floor_added, rowid"),
    q("SELECT act, area FROM run_acts WHERE run_id = ? ORDER BY act"),
    q(`SELECT t.slot, t.player_id, t.character, p.profile_id, p.username
       FROM run_players t
       LEFT JOIN profiles p ON p.profile_id = (SELECT MIN(profile_id) FROM profiles WHERE steam_id = t.player_id)
       WHERE t.run_id = ? ORDER BY t.slot`),
    q(`SELECT p.profile_id, p.username FROM profile_runs pr JOIN profiles p ON p.profile_id = pr.profile_id
       WHERE pr.run_id = ? ORDER BY p.username`),
  ]);
  const run = runs[0];
  if (!run) return null;

  let path = rooms.map((room) => ({ ...room, detail: parseDetail(room.detail) }));
  // No rooms and no game mode: imported before the run page existed. (A run quit before its first
  // room has a game mode but no rooms, and isn't partial.)
  const partial = !path.length && run.game_mode == null;
  if (partial) path = await fallbackPath(q);
  return { run, rooms: path, partial, cards, relics, acts, players, importers };
}

function parseDetail(text) {
  try {
    const detail = JSON.parse(text);
    return detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
  } catch {
    return {};
  }
}

// The rooms an older run can still show: its fights and events, by floor.
async function fallbackPath(q) {
  const [fights, events] = await Promise.all([
    q("SELECT floor, act, type, encounter_id, turns, damage, hp_after FROM fights WHERE run_id = ?"),
    q("SELECT floor, act, event_id FROM events WHERE run_id = ?"),
  ]);
  const rooms = [
    ...fights.map((f) => ({
      floor: f.floor,
      act: f.act,
      map_type: f.type,
      room_type: f.type,
      model_id: f.encounter_id,
      hp: f.hp_after,
      max_hp: null,
      gold: null,
      detail: { ...(f.turns ? { turns: f.turns } : {}), ...(f.damage ? { damage: f.damage } : {}) },
    })),
    ...events.map((e) => ({
      floor: e.floor,
      act: e.act,
      map_type: ANCIENT_EVENTS.has(e.event_id) ? "ancient" : "unknown",
      room_type: "event",
      model_id: e.event_id,
      hp: null,
      max_hp: null,
      gold: null,
      detail: {},
    })),
  ];
  return rooms.sort((a, b) => a.floor - b.floor);
}

module.exports = { runDetail };
