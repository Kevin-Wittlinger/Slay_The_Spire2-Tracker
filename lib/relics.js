// Where a relic came from: NEOW (the act 1 Ancient), ANCIENT (the act 2 and 3 Ancients) or OTHER
// (elites, chests, shops, events, ... and the starting relic). Stored in run_relics.source.
//
// New imports read it from the run file (the relic the player picked at an Ancient event).
// Older rows are worked out from the events table: an Ancient is the first room of its act and is
// recorded as an event, and a relic's floor_added matches the floor of the room that gave it.

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

// Adds the column to databases created before it existed. Safe to run every start.
async function ensureRelicSourceColumn(db) {
  const info = await db.execute("PRAGMA table_info(run_relics)");
  if (!info.rows.some((row) => row.name === "source"))
    await db.execute("ALTER TABLE run_relics ADD COLUMN source TEXT");
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_relics_source ON run_relics(source)",
  );
}

const FIRST_EVENT_OF_ACT = (act) => `(e.act ${act} AND e.floor = (
  SELECT MIN(e2.floor) FROM events e2 WHERE e2.run_id = e.run_id AND e2.act = e.act))`;

async function backfillRelicSources(db) {
  const pending = await db.execute(
    "SELECT 1 FROM run_relics WHERE source IS NULL LIMIT 1",
  );
  if (!pending.rows.length) return 0;
  const result = await db.execute(`
    UPDATE run_relics SET source = CASE
      WHEN run_relics.relic_id IN (${STARTING_RELIC_LIST}) THEN 'OTHER'
      WHEN EXISTS (
        SELECT 1 FROM events e
        WHERE e.run_id = run_relics.run_id AND e.floor = run_relics.floor_added
          AND (e.event_id = 'EVENT.NEOW' OR ${FIRST_EVENT_OF_ACT("= 1")})
      ) THEN 'NEOW'
      WHEN EXISTS (
        SELECT 1 FROM events e
        WHERE e.run_id = run_relics.run_id AND e.floor = run_relics.floor_added
          AND ${FIRST_EVENT_OF_ACT(">= 2")}
      ) THEN 'ANCIENT'
      ELSE 'OTHER'
    END
    WHERE source IS NULL`);
  return Number(result.rowsAffected || 0);
}

module.exports = {
  STARTING_RELICS,
  STARTING_RELIC_LIST,
  ensureRelicSourceColumn,
  backfillRelicSources,
};
