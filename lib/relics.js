// Where a relic came from, stored in run_relics.origin:
//   NEOW             the act 1 Ancient
//   ANCIENT_<NAME>   an act 2 or 3 Ancient, e.g. ANCIENT_TEZCATARA, ANCIENT_VAKUU
//   SHOP, ELITE, BOSS, TREASURE (chests), REST (rest sites), EVENT (any other event)
//   STARTING         the character's starting relic
//   OTHER            anything else (a relic won in a normal fight)
//
// New imports work it out from the run file: a relic's floor_added is the floor of the room that gave
// it, and every floor has a room type. Rows from before the column existed are worked out from what the
// database kept (fights, events and card offers per floor). That can't tell a treasure chest from a rest
// site, so those show as TREASURE until the run file is imported again, which sets the exact value.

// Every character begins with one of these relics (picked on floor 1, like the Neow choice).
const STARTING_RELICS = [
  "RELIC.BURNING_BLOOD",
  "RELIC.RING_OF_THE_SNAKE",
  "RELIC.DIVINE_RIGHT",
  "RELIC.BOUND_PHYLACTERY",
  "RELIC.CRACKED_CORE",
  "RELIC.SONG_BOW",
];
const STARTING_RELIC_LIST = STARTING_RELICS.map((id) => `'${id}'`).join(", ");

const ROOM_ORIGINS = {
  event: "EVENT",
  shop: "SHOP",
  treasure: "TREASURE",
  elite: "ELITE",
  boss: "BOSS",
  rest_site: "REST",
};

// floor number -> origin, for one parsed run file. Floors count on across acts.
function floorOrigins(j) {
  const origins = new Map();
  let floor = 0;
  (j.map_point_history || []).forEach((act, actIdx) => {
    for (const mp of act) {
      floor++;
      const room = (mp.rooms || [])[0] || {};
      if (mp.map_point_type === "ancient") {
        const name = String(room.model_id || "").replace(/^EVENT\./, "").replace(/[^A-Z0-9_]/g, "").slice(0, 24);
        origins.set(floor, actIdx === 0 || !name || name === "NEOW" ? "NEOW" : `ANCIENT_${name}`);
      } else {
        origins.set(floor, ROOM_ORIGINS[room.room_type] || "OTHER");
      }
    }
  });
  return origins;
}

function relicOrigin(origins, relic) {
  if (STARTING_RELICS.includes(relic.id)) return "STARTING";
  return origins.get(relic.floor_added_to_deck ?? 0) || "OTHER";
}

// Statements that set the exact origin of a run's relics (used when a run is imported again).
function relicOriginUpdates(runId, j) {
  const origins = floorOrigins(j);
  return ((j.players || [])[0]?.relics || []).map((relic) => ({
    sql: "UPDATE run_relics SET origin = ? WHERE run_id = ? AND relic_id = ? AND floor_added = ? AND origin IS NOT ?",
    args: [relicOrigin(origins, relic), runId, relic.id, relic.floor_added_to_deck ?? 0, relicOrigin(origins, relic)],
  }));
}

// Adds the column to databases created before it existed and drops the first version of it
// (run_relics.source, which only knew Neow / Ancient / Other). Safe to run every start.
async function ensureRelicSourceColumn(db) {
  const columns = async () => (await db.execute("PRAGMA table_info(run_relics)")).rows.map((row) => row.name);
  let names = await columns();
  if (!names.includes("origin")) await db.execute("ALTER TABLE run_relics ADD COLUMN origin TEXT");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_relics_origin ON run_relics(origin)");
  if (names.includes("source")) {
    try {
      await db.execute("DROP INDEX IF EXISTS idx_relics_source");
      await db.execute("ALTER TABLE run_relics DROP COLUMN source");
    } catch (error) {
      console.error("Could not drop old run_relics.source:", error.message); // harmless, it is just unused
    }
  }
}

// The same rules as floorOrigins, from the tables we keep. The first event of an act is its Ancient.
const FIRST_EVENT_OF_ACT = `e.floor = (SELECT MIN(e2.floor) FROM events e2 WHERE e2.run_id = e.run_id AND e2.act = e.act)`;
const AT_RELIC_FLOOR = (table, alias) => `${table} ${alias} WHERE ${alias}.run_id = run_relics.run_id AND ${alias}.floor = run_relics.floor_added`;

async function backfillRelicSources(db) {
  const pending = await db.execute("SELECT 1 FROM run_relics WHERE origin IS NULL LIMIT 1");
  if (!pending.rows.length) return 0;
  const result = await db.execute(`
    UPDATE run_relics SET origin = COALESCE(
      CASE WHEN run_relics.relic_id IN (${STARTING_RELIC_LIST}) THEN 'STARTING' END,
      (SELECT 'NEOW' FROM ${AT_RELIC_FLOOR("events", "e")}
         AND (e.event_id = 'EVENT.NEOW' OR (e.act = 1 AND ${FIRST_EVENT_OF_ACT})) LIMIT 1),
      (SELECT 'ANCIENT_' || substr(e.event_id, 7) FROM ${AT_RELIC_FLOOR("events", "e")}
         AND e.act >= 2 AND ${FIRST_EVENT_OF_ACT} AND e.event_id IS NOT NULL LIMIT 1),
      (SELECT CASE f.type WHEN 'elite' THEN 'ELITE' WHEN 'boss' THEN 'BOSS' ELSE 'OTHER' END
         FROM ${AT_RELIC_FLOOR("fights", "f")} LIMIT 1),
      (SELECT 'EVENT' FROM ${AT_RELIC_FLOOR("events", "e")} LIMIT 1),
      (SELECT 'SHOP' FROM ${AT_RELIC_FLOOR("card_choices", "c")} LIMIT 1),
      'TREASURE')
    WHERE origin IS NULL`);
  return Number(result.rowsAffected || 0);
}

module.exports = {
  STARTING_RELICS,
  STARTING_RELIC_LIST,
  floorOrigins,
  relicOrigin,
  relicOriginUpdates,
  ensureRelicSourceColumn,
  backfillRelicSources,
};
