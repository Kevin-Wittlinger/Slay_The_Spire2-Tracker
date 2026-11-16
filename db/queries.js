// Every statistic on the site is one SQL query in this file.
// Named parameters: @character and @ascension (NULL = no filter), @min (minimum sample size).
// Abandoned runs are excluded everywhere. Multiplayer runs never reach the database.
const { rowsToObjects } = require("../lib/db");

const FILTER = `(@character IS NULL OR r.character = @character)
  AND (@ascension IS NULL OR r.ascension = @ascension)`;
const PROFILE_FILTER = `(@profileId IS NULL OR EXISTS (
  SELECT 1 FROM profile_runs pr WHERE pr.run_id = r.run_id AND pr.profile_id = @profileId
))`;
const BASE = `r.abandoned = 0 AND ${FILTER} AND ${PROFILE_FILTER}`;

// Every character begins with one of these, so they say nothing about a run. Left out of relic stats.
const STARTING_RELICS = [
  "RELIC.BURNING_BLOOD",
  "RELIC.RING_OF_THE_SNAKE",
  "RELIC.DIVINE_RIGHT",
  "RELIC.BOUND_PHYLACTERY",
  "RELIC.CRACKED_CORE",
  "RELIC.SONG_BOW",
];
const STARTING_RELIC_LIST = STARTING_RELICS.map((id) => `'${id}'`).join(", ");

const TABS = {
  overview: {
    title: "Overview",
    hidden: true,
    sql: `
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(r.win), 0) AS wins,
             COALESCE(ROUND(100.0 * SUM(r.win) / NULLIF(COUNT(*), 0), 1), 0) AS win_pct,
             COALESCE(ROUND(AVG(r.run_time) / 60.0, 1), 0) AS avg_minutes,
             (SELECT COUNT(*) FROM runs r
              WHERE r.abandoned = 1 AND ${FILTER} AND ${PROFILE_FILTER}) AS abandoned
      FROM runs r
      WHERE ${BASE}`,
  },

  characters: {
    title: "Characters",
    sql: `
      SELECT r.character,
             COUNT(*) AS runs,
             SUM(r.win) AS wins,
             ROUND(100.0 * SUM(r.win) / COUNT(*), 1) AS win_pct,
             MAX(r.ascension) AS max_ascension
      FROM runs r
      WHERE ${BASE}
      GROUP BY r.character
      HAVING runs >= @min
      ORDER BY CASE
                 WHEN r.character LIKE '%IRONCLAD' THEN 1
                 WHEN r.character LIKE '%SILENT' THEN 2
                 WHEN r.character LIKE '%REGENT' THEN 3
                 WHEN r.character LIKE '%NECROBINDER' THEN 4
                 WHEN r.character LIKE '%DEFECT' THEN 5
                 WHEN r.character LIKE '%FOOL' THEN 6
                 ELSE 7
               END, runs DESC`,
  },

  ascensions: {
    title: "Ascensions",
    sql: `
      SELECT r.ascension,
             COUNT(*) AS runs,
             SUM(r.win) AS wins,
             ROUND(100.0 * SUM(r.win) / COUNT(*), 1) AS win_pct
      FROM runs r
      WHERE ${BASE}
      GROUP BY r.ascension
      HAVING runs >= @min
      ORDER BY r.ascension`,
  },

  card_win_rate: {
    title: "Card win rate",
    // A run counts once per card, no matter how many copies were in the final deck.
    // floor_added > 1 leaves out the starting deck.
    sql: `
      SELECT card,
             COUNT(*) AS runs,
             SUM(win) AS wins,
             ROUND(100.0 * SUM(win) / COUNT(*), 1) AS win_pct
      FROM (
        SELECT DISTINCT c.run_id, c.card_id AS card, r.win
        FROM run_cards c
        JOIN runs r ON r.run_id = c.run_id
        WHERE c.floor_added > 1 AND ${BASE}
      )
      GROUP BY card
      HAVING runs >= @min
      ORDER BY win_pct DESC, runs DESC`,
  },

  card_pick_rate: {
    title: "Card pick rate",
    // Only combat rewards (monster / elite / boss), not shop stock.
    sql: `
      SELECT cc.card_id AS card,
             COUNT(*) AS offered,
             SUM(cc.picked) AS picked,
             ROUND(100.0 * SUM(cc.picked) / COUNT(*), 1) AS pick_pct
      FROM card_choices cc
      JOIN runs r ON r.run_id = cc.run_id
      WHERE cc.source IN ('monster', 'elite', 'boss') AND ${BASE}
      GROUP BY cc.card_id
      HAVING offered >= @min
      ORDER BY pick_pct DESC, offered DESC`,
  },

  relic_win_rate: {
    title: "Relic win rate",
    sql: `
      SELECT relic,
             COUNT(*) AS runs,
             SUM(win) AS wins,
             ROUND(100.0 * SUM(win) / COUNT(*), 1) AS win_pct
      FROM (
        SELECT DISTINCT x.run_id, x.relic_id AS relic, r.win
        FROM run_relics x
        JOIN runs r ON r.run_id = x.run_id
        WHERE x.relic_id NOT IN (${STARTING_RELIC_LIST}) AND ${BASE}
      )
      GROUP BY relic
      HAVING runs >= @min
      ORDER BY win_pct DESC, runs DESC`,
  },

  fight_types: {
    title: "Normal / Elite / Boss",
    sql: `
      SELECT f.type,
             COUNT(*) AS fights,
             SUM(1 - f.died) AS won,
             ROUND(100.0 * SUM(1 - f.died) / COUNT(*), 1) AS win_pct,
             ROUND(AVG(f.damage), 1) AS avg_damage_taken,
             ROUND(AVG(f.turns), 1) AS avg_turns
      FROM fights f
      JOIN runs r ON r.run_id = f.run_id
      WHERE ${BASE}
      GROUP BY f.type
      HAVING fights >= @min
      ORDER BY CASE f.type WHEN 'monster' THEN 1 WHEN 'elite' THEN 2 ELSE 3 END`,
  },

  encounters: {
    title: "Enemies",
    sql: `
      SELECT f.encounter_id AS encounter,
             f.type,
             COUNT(*) AS fights,
             SUM(f.died) AS deaths,
             ROUND(100.0 * SUM(1 - f.died) / COUNT(*), 1) AS win_pct,
             ROUND(AVG(f.damage), 1) AS avg_damage_taken,
             ROUND(AVG(f.turns), 1) AS avg_turns
      FROM fights f
      JOIN runs r ON r.run_id = f.run_id
      WHERE ${BASE}
      GROUP BY f.encounter_id, f.type
      HAVING fights >= @min
      ORDER BY fights DESC, avg_damage_taken DESC`,
  },

  events: {
    title: "Events",
    hidden: true,
    // Run win rate for runs that hit the event at least once.
    sql: `
      SELECT event,
             COUNT(*) AS seen,
             SUM(win) AS run_wins,
             ROUND(100.0 * SUM(win) / COUNT(*), 1) AS run_win_pct
      FROM (
        SELECT DISTINCT e.run_id, e.event_id AS event, r.win
        FROM events e
        JOIN runs r ON r.run_id = e.run_id
        WHERE ${BASE}
      )
      GROUP BY event
      HAVING seen >= @min
      ORDER BY seen DESC`,
  },

  event_choices: {
    title: "Event choices",
    hidden: true,
    sql: `
      SELECT e.event_id AS event,
             e.choice,
             COUNT(*) AS times,
             SUM(r.win) AS run_wins,
             ROUND(100.0 * SUM(r.win) / COUNT(*), 1) AS run_win_pct
      FROM events e
      JOIN runs r ON r.run_id = e.run_id
      WHERE ${BASE}
      GROUP BY e.event_id, e.choice
      HAVING times >= @min
      ORDER BY times DESC`,
  },

  killed_by: {
    title: "Killed by",
    sql: `
      SELECT r.killed_by,
             CASE f.type
               WHEN 'monster' THEN 'Regular combat'
               WHEN 'elite' THEN 'Elite'
               WHEN 'boss' THEN 'Boss'
               ELSE 'Other'
             END AS type,
             COUNT(*) AS deaths
      FROM runs r
      LEFT JOIN fights f
        ON f.run_id = r.run_id
        AND f.encounter_id = r.killed_by
        AND f.floor = (
          SELECT MAX(f2.floor)
          FROM fights f2
          WHERE f2.run_id = r.run_id AND f2.encounter_id = r.killed_by
        )
      WHERE r.win = 0 AND r.killed_by IS NOT NULL AND ${BASE}
      GROUP BY r.killed_by, f.type
      ORDER BY deaths DESC`,
  },

  recent_runs: {
    title: "Recent runs",
    sql: `
      SELECT datetime(r.start_time, 'unixepoch', 'localtime') AS started,
             r.character,
             r.ascension,
             CASE r.win WHEN 1 THEN 'WIN' ELSE 'LOSS' END AS result,
             r.killed_by,
             ROUND(r.run_time / 60.0, 1) AS minutes,
             (SELECT COUNT(*) FROM fights f WHERE f.run_id = r.run_id) AS fights
      FROM runs r
      WHERE r.abandoned = 0 AND ${FILTER} AND ${PROFILE_FILTER}
      ORDER BY r.start_time DESC
      LIMIT 100`,
  },
};

// Runs one named query. Only the parameters that query actually uses are bound.
async function runQuery(db, id, raw = {}) {
  const t = TABS[id];
  if (!t) return null;
  const names = [...new Set([...t.sql.matchAll(/@(\w+)/g)].map((m) => m[1]))];
  const params = {};
  for (const n of names) params[n] = raw[n] ?? (n === "min" ? 1 : null);
  return rowsToObjects(await db.execute({ sql: t.sql, args: params }));
}

module.exports = { TABS, runQuery };
