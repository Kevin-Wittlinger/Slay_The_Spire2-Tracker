// Turns one parsed .run file into rows. Solo and multiplayer runs are both kept; a multiplayer run is
// stored from the uploader's side, so it needs their Steam id (see lib/multiplayer.js).
// importRun returns { status }: imported | duplicate | invalid, or multiplayer when a multiplayer run
// was skipped because the uploader's Steam id is unknown or isn't one of the run's players.

const NONE = (v) => (!v || v === "NONE.NONE" ? null : v);
const { floorOrigins, relicOrigin, relicOriginUpdates } = require("./relics");
const { steamId } = require("./multiplayer");
const FIGHT_TYPES = new Set(["monster", "elite", "boss"]);

// ["ACT.OVERGROWTH", "ACT.HIVE", "ACT.GLORY"] -> one INSERT per act, e.g. (1, "OVERGROWTH").
// The acts list is the whole planned route, so a run that died in act 1 still lists Hive and
// Glory. Only acts with at least one map point (a room actually entered) are recorded.
function actStatements(runId, j) {
  if (!Array.isArray(j.acts)) return [];
  const history = Array.isArray(j.map_point_history) ? j.map_point_history : [];
  return j.acts
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => Array.isArray(history[i]) && history[i].length > 0)
    .map(({ id, i }) => ({
      sql: "INSERT OR IGNORE INTO run_acts (run_id, act, area) VALUES (?,?,?)",
      args: [runId, i + 1, String(id).replace(/^ACT\./, "").toUpperCase().slice(0, 32)],
    }))
    .filter((s) => /^[A-Z_]+$/.test(s.args[2]));
}

// ---------- the run page (run_rooms, and how the run ended) ----------
const id64 = (v) => (typeof v === "string" && v ? v.slice(0, 64) : null);
const ids = (list) => (Array.isArray(list) ? list.map(id64).filter(Boolean).slice(0, 30) : []);
const num = (v) => (Number.isFinite(v) ? v : null);

// What happened in one room, from the uploader's stats for it, as a small object with empty parts left
// out. The run page (public/app.js, roomSummary) turns it into text; unknown keys are just ignored there,
// so more can be added here later.
function roomDetail(room, ps) {
  const picked = (list) => (Array.isArray(list) ? list.filter((c) => c?.was_picked) : []);
  const notPicked = (list) => (Array.isArray(list) ? list.filter((c) => c && !c.was_picked) : []);
  const detail = {
    turns: room.turns_taken || null,
    damage: ps.damage_taken || null,
    healed: ps.hp_healed || null,
    maxHpGained: ps.max_hp_gained || null,
    maxHpLost: ps.max_hp_lost || null,
    goldGained: ps.gold_gained || null,
    goldSpent: ps.gold_spent || null,
    goldLost: (ps.gold_lost || 0) + (ps.gold_stolen || 0) || null,
    cards: ids((ps.cards_gained || []).map((c) => c?.id)),
    skipped: ids(notPicked(ps.card_choices).map((c) => c.card?.id)),
    removed: ids((ps.cards_removed || []).map((c) => c?.id)),
    upgraded: ids(ps.upgraded_cards),
    transformed: (ps.cards_transformed || [])
      .map((t) => [id64(t?.original_card?.id), id64(t?.final_card?.id)])
      .filter(([from, to]) => from && to)
      .slice(0, 30),
    enchanted: (ps.cards_enchanted || [])
      .map((e) => [id64(e?.card?.id), id64(e?.enchantment)])
      .filter(([card, ench]) => card && ench)
      .slice(0, 30),
    relics: [...new Set([...ids(picked(ps.relic_choices).map((c) => c.choice)), ...ids(ps.bought_relics)])],
    relicsSkipped: ids(notPicked(ps.relic_choices).map((c) => c.choice)),
    potions: [...ids(picked(ps.potion_choices).map((c) => c.choice)), ...ids(ps.bought_potions)],
    potionsUsed: ids(ps.potion_used),
    potionsDiscarded: ids(ps.potion_discarded),
    rest: ids(ps.rest_site_choices),
    choices: ids((ps.event_choices || []).map((c) => c?.title?.key)),
  };
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || (Array.isArray(value) && !value.length)) delete detail[key];
  }
  return detail;
}

// One run_rooms row per map point, in order (floors count from 1, like fights.floor).
function roomStatements(runId, j, statsOf) {
  const statements = [];
  let floor = 0;
  (j.map_point_history || []).forEach((act, actIdx) => {
    for (const mp of Array.isArray(act) ? act : []) {
      floor++;
      const ps = statsOf(mp);
      const room = (mp.rooms || [])[0] || {};
      statements.push({
        sql: `INSERT OR IGNORE INTO run_rooms
          (run_id, floor, act, map_type, room_type, model_id, hp, max_hp, gold, detail)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [
          runId,
          floor,
          actIdx + 1,
          id64(mp.map_point_type),
          id64(room.room_type),
          id64(room.model_id),
          num(ps.current_hp),
          num(ps.max_hp),
          num(ps.current_gold),
          JSON.stringify(roomDetail(room, ps)),
        ],
      });
    }
  });
  return statements;
}

// How the run ended: [game_mode, final_hp, max_hp, gold, potion_slots, potions], read from the last
// room the uploader has stats for.
function runEnd(j, p, statsOf) {
  const rooms = (j.map_point_history || []).flat().filter(Boolean);
  const last = rooms.length ? statsOf(rooms[rooms.length - 1]) : {};
  const potions = ids((p.potions || []).map((potion) => potion?.id));
  return [
    id64(j.game_mode),
    num(last.current_hp),
    num(last.max_hp),
    num(last.current_gold),
    num(p.max_potion_slot_count),
    potions.length ? potions.join(",") : null,
  ];
}
const RUN_END_COLUMNS = ["game_mode", "final_hp", "max_hp", "gold", "potion_slots", "potions"];

const cardStatement = (runId, c) => ({
  sql: "INSERT INTO run_cards (run_id, card_id, upgrade, floor_added, enchantment) VALUES (?,?,?,?,?)",
  args: [runId, c.id, c.current_upgrade_level || 0, c.floor_added_to_deck ?? 0, id64(c.enchantment?.id)],
});

// One row per player of a multiplayer run (nothing for solo runs).
function playerStatements(runId, j) {
  if (j.players.length < 2) return [];
  return j.players
    .map((player, slot) => ({ player, slot, pid: steamId(player?.id) }))
    .filter(({ pid }) => pid)
    .map(({ player, slot, pid }) => ({
      sql: "INSERT OR IGNORE INTO run_players (run_id, slot, player_id, character) VALUES (?,?,?,?)",
      args: [runId, slot, pid, typeof player.character === "string" ? player.character.slice(0, 64) : null],
    }));
}

// Limits a real run file stays well inside; anything outside them is a broken or hand-made file.
// Loose on purpose so new game content (characters, higher ascensions, longer runs) still imports.
const LIMITS = {
  players: 8,
  ascension: 30,
  runSeconds: 7 * 24 * 60 * 60,
  rooms: 300,
  acts: 10,
  deck: 500,
  relics: 200,
};
const EARLIEST_START = 1_577_836_800; // 2020-01-01, in seconds like the game's start_time
const isCount = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const optional = (value, check) => value === undefined || value === null || check(value);

function plausibleRun(j, p) {
  const history = j.map_point_history;
  const nowSeconds = Date.now() / 1000;
  return (
    j.players.length <= LIMITS.players &&
    /^[A-Za-z0-9_-]{1,64}$/.test(String(j.seed)) &&
    typeof p.character === "string" &&
    /^CHARACTER\.[A-Z0-9_]{1,40}$/.test(p.character) &&
    optional(j.ascension, (a) => isCount(a, LIMITS.ascension)) &&
    optional(j.run_time, (t) => typeof t === "number" && t >= 0 && t <= LIMITS.runSeconds) &&
    // Up to a day ahead, for a clock in a far-off time zone.
    optional(j.start_time, (t) => Number.isInteger(t) && t >= EARLIEST_START && t <= nowSeconds + 86400) &&
    optional(history, (h) => Array.isArray(h) && h.length <= LIMITS.acts && h.flat().length <= LIMITS.rooms) &&
    optional(p.deck, (d) => Array.isArray(d) && d.length <= LIMITS.deck) &&
    optional(p.relics, (r) => Array.isArray(r) && r.length <= LIMITS.relics)
  );
}

function createImporter(db) {
  // selfId: the uploader's Steam id, needed for multiplayer runs only.
  async function importRun(j, profileId, { selfId = null } = {}) {
    profileId = Number(profileId);
    if (!j || typeof j !== "object" || !Array.isArray(j.players) || !j.players.length || !j.seed)
      return { status: "invalid" };
    if (j.players.length > LIMITS.players) return { status: "invalid" };
    if (!Number.isSafeInteger(profileId) || profileId < 1)
      return { status: "invalid" };
    const multi = j.players.length > 1;
    selfId = multi ? steamId(selfId) : null;
    const p = multi
      ? selfId && j.players.find((player) => steamId(player?.id) === selfId)
      : j.players[0];
    if (multi && !p) return { status: "multiplayer" };
    if (!p || !p.character || !plausibleRun(j, p)) return { status: "invalid" };
    // The uploader's line of each room's stats (a solo run has just one).
    const statsOf = (mp) => {
      const all = mp.player_stats || [];
      return (multi ? all.find((ps) => steamId(ps?.player_id) === selfId) : all[0]) || {};
    };
    const id = multi ? `${j.seed}:${j.start_time}:${selfId}` : `${j.seed}:${j.start_time}`;
    const exists = await db.execute({
      // has_page: the run already has its run-page data (rooms, or the game mode for a run quit before
      // its first room).
      sql: `SELECT game_mode IS NOT NULL OR EXISTS (SELECT 1 FROM run_rooms WHERE run_id = runs.run_id) AS has_page
            FROM runs WHERE run_id = ?`,
      args: [id],
    });
    if (exists.rows.length) {
      // A run's id (seed and start time) is public on the run page, so a hand-made file could reuse
      // someone else's. Only the profile that already has the run may refresh it; a run that belongs
      // to someone else is left alone and never added to this profile. A run nobody has any more can
      // be taken back by whoever imports it.
      const owners = await db.execute({
        sql: "SELECT MAX(profile_id = ?) AS mine, COUNT(*) AS owners FROM profile_runs WHERE run_id = ?",
        args: [profileId, id],
      });
      const { mine, owners: ownerCount } = owners.rows[0];
      if (Number(ownerCount) && !Number(mine)) return { status: "duplicate" };
      // Runs imported before areas and relic origins were tracked get them filled in on re-import.
      const refresh = [
        ...actStatements(id, j),
        ...relicOriginUpdates(id, j, p),
        ...playerStatements(id, j),
      ];
      // Runs imported before the run page existed: add its rooms and ending, and store the deck again
      // with enchantments (same cards, so no statistic changes).
      if (!Number(exists.rows[0].has_page)) {
        refresh.push(
          ...roomStatements(id, j, statsOf),
          {
            sql: `UPDATE runs SET ${RUN_END_COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE run_id = ?`,
            args: [...runEnd(j, p, statsOf), id],
          },
          { sql: "DELETE FROM run_cards WHERE run_id = ?", args: [id] },
          ...(p.deck || []).map((c) => cardStatement(id, c)),
        );
      }
      if (refresh.length) await db.batch(refresh, "write");
      const linked = await db.execute({
        sql: "INSERT OR IGNORE INTO profile_runs (profile_id, run_id, created_at) VALUES (?,?,?)",
        args: [profileId, id, Date.now()],
      });
      return linked.rowsAffected
        ? { status: "imported" }
        : { status: "duplicate" };
    }

    const statements = [
      {
        sql: `INSERT INTO runs
        (run_id, seed, character, ascension, win, abandoned, killed_by, run_time, start_time, build_id,
         player_count, player_id, ${RUN_END_COLUMNS.join(", ")})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          id,
          j.seed ?? null,
          p.character,
          j.ascension ?? 0,
          // An abandoned run is a loss, whatever else the file says (see db/queries.js).
          j.win && !j.was_abandoned ? 1 : 0,
          j.was_abandoned ? 1 : 0,
          NONE(j.killed_by_encounter) || NONE(j.killed_by_event),
          j.run_time ?? null,
          j.start_time ?? null,
          j.build_id ?? null,
          j.players.length,
          selfId,
          ...runEnd(j, p, statsOf),
        ],
      },
    ];
    statements.push(...actStatements(id, j), ...playerStatements(id, j), ...roomStatements(id, j, statsOf));
    const add = (sql, args) => statements.push({ sql, args });
    let floor = 0;
    (j.map_point_history || []).forEach((act, actIdx) => {
      for (const mp of act) {
        floor++;
        const ps = statsOf(mp);
        const room = (mp.rooms || [])[0] || {};
        if (FIGHT_TYPES.has(room.room_type)) {
          add(
            `INSERT INTO fights
            (run_id, floor, act, type, encounter_id, monsters, turns, damage, hp_after, died)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              id,
              floor,
              actIdx + 1,
              room.room_type,
              room.model_id ?? null,
              (room.monster_ids || []).join(","),
              room.turns_taken ?? null,
              ps.damage_taken ?? 0,
              ps.current_hp ?? null,
              (ps.current_hp ?? 1) <= 0 ? 1 : 0,
            ],
          );
        }
        if (room.room_type === "event") {
          const choice =
            (ps.event_choices || [])
              .map((c) => c.title?.key || "")
              .join(" > ") || null;
          add(
            "INSERT INTO events (run_id, floor, act, event_id, choice) VALUES (?,?,?,?,?)",
            [id, floor, actIdx + 1, room.model_id ?? null, choice],
          );
        }
        for (const c of ps.card_choices || []) {
          add(
            "INSERT INTO card_choices (run_id, floor, act, source, card_id, picked) VALUES (?,?,?,?,?,?)",
            [
              id,
              floor,
              actIdx + 1,
              mp.map_point_type || "unknown",
              c.card.id,
              c.was_picked ? 1 : 0,
            ],
          );
        }
      }
    });
    for (const c of p.deck || []) statements.push(cardStatement(id, c));
    const origins = floorOrigins(j);
    for (const r of p.relics || []) {
      add(
        "INSERT INTO run_relics (run_id, relic_id, floor_added, origin) VALUES (?,?,?,?)",
        [id, r.id, r.floor_added_to_deck ?? 0, relicOrigin(origins, r)],
      );
    }
    add(
      "INSERT INTO profile_runs (profile_id, run_id, created_at) VALUES (?,?,?)",
      [profileId, id, Date.now()],
    );

    try {
      await db.batch(statements, "write");
    } catch (error) {
      const linked = await db.execute({
        sql: "INSERT OR IGNORE INTO profile_runs (profile_id, run_id, created_at) SELECT ?, run_id, ? FROM runs WHERE run_id = ?",
        args: [profileId, Date.now(), id],
      });
      if (linked.rowsAffected) return { status: "imported" };
      const duplicate = await db.execute({
        sql: "SELECT 1 FROM profile_runs WHERE profile_id = ? AND run_id = ?",
        args: [profileId, id],
      });
      if (duplicate.rows.length) return { status: "duplicate" };
      throw error;
    }
    return { status: "imported", run_id: id };
  }

  return { importRun };
}

module.exports = { createImporter, roomDetail };
