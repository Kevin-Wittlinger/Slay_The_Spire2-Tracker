// Fills in run_acts for runs that were imported before areas were tracked, so every player's old
// runs work with the Area filter without anyone importing again.
//
// Acts 2 and 3 are always Hive and Glory. Act 1 is Overgrowth or Underdocks, and each act-1 enemy
// only ever appears in one of them. So the mapping "enemy -> area" is learned from runs that
// already have their areas (imported with the `acts` list) and applied to the untagged ones.
// A run is left alone if its act-1 enemies are unknown or point at both areas.

const { GAME_DATA } = require("../public/game-data");

// Acts with only one possible area (game-data.js), e.g. 2 -> HIVE and 3 -> GLORY. Those runs can be
// tagged from the act number alone. Acts with alternatives (act 1) are worked out from the enemies.
function singleAreaActs() {
  const byAct = new Map();
  for (const area of GAME_DATA.areas) byAct.set(area.act, [...(byAct.get(area.act) || []), area.id]);
  return [...byAct]
    .filter(([act, ids]) => act > 1 && ids.length === 1 && /^[A-Z_]+$/.test(ids[0]))
    .map(([act, [id]]) => ({ act, id }));
}

const HAS_ACT = (runRef, act) =>
  `EXISTS (SELECT 1 FROM run_acts x WHERE x.run_id = ${runRef} AND x.act ${act})`;

async function backfillAreas(db) {
  // Cheap gate: most of the time there is nothing to do.
  const pending = await db.execute(`
    SELECT 1 FROM runs r
    WHERE NOT ${HAS_ACT("r.run_id", "= 1")}
      AND EXISTS (SELECT 1 FROM fights f WHERE f.run_id = r.run_id AND f.act = 1)
    LIMIT 1`);
  if (!pending.rows.length) return 0;

  // Act 1: the area every one of the run's act-1 enemies agrees on.
  const act1 = await db.execute(`
    INSERT OR IGNORE INTO run_acts (run_id, act, area)
    SELECT f.run_id, 1, MIN(k.area)
    FROM fights f
    JOIN (
      SELECT g.encounter_id, MIN(a.area) AS area
      FROM fights g
      JOIN run_acts a ON a.run_id = g.run_id AND a.act = 1
      WHERE g.act = 1
      GROUP BY g.encounter_id
      HAVING COUNT(DISTINCT a.area) = 1
    ) k ON k.encounter_id = f.encounter_id
    WHERE f.act = 1 AND NOT ${HAS_ACT("f.run_id", "= 1")}
    GROUP BY f.run_id
    HAVING COUNT(DISTINCT k.area) = 1`);

  // Later acts with a single possible area, for runs that now have an act 1 but nothing after it.
  const single = singleAreaActs();
  if (!single.length) return Number(act1.rowsAffected || 0);
  const later = await db.execute(`
    INSERT OR IGNORE INTO run_acts (run_id, act, area)
    SELECT DISTINCT f.run_id, f.act, CASE f.act ${single.map((s) => `WHEN ${s.act} THEN '${s.id}'`).join(" ")} END
    FROM fights f
    WHERE f.act IN (${single.map((s) => s.act).join(", ")})
      AND ${HAS_ACT("f.run_id", "= 1")}
      AND NOT ${HAS_ACT("f.run_id", ">= 2")}`);
  return Number(act1.rowsAffected || 0) + Number(later.rowsAffected || 0);
}

module.exports = { backfillAreas };
