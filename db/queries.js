// Every statistic on the site is one SQL query in this file.
// Named parameters: @character, @ascension, @patch and @area (NULL = no filter; @source only filters Relic WR), @min (minimum sample size),
// @mode ('solo' = solo runs only, the default; 'multi' = multiplayer runs only; 'all' = both).
// Abandoned runs count as losses by default (runs.win is always 0 for them; see lib/importer.js), so
// quitting a run to re-roll a seed or dodge a loss costs the same as losing it. Quitting during a fight
// counts as being killed by that fight (the game records it); quitting elsewhere has no killer.
// @abandoned = 'exclude' leaves them out instead (the toggle on the Abandoned card).
// A multiplayer run is a row per uploader, holding their own character, deck, relics and room stats;
// run_players lists who they played with.
const { rowsToObjects } = require("../lib/db");

const MODE = (r) => `(@mode = 'all' OR (@mode = 'multi') = (${r}.player_count > 1))`;
// @abandoned = 'exclude' (the toggle on the Abandoned card) leaves abandoned runs out entirely.
const ABANDONS = (r) => `(@abandoned IS NULL OR ${r}.abandoned = 0)`;
// The usual filters for runs under alias r. mode: false leaves out the solo/multiplayer filter;
// abandons: false ignores the abandoned toggle (to count the abandons themselves).
const filterFor = (r, { mode = true, abandons = true } = {}) => `(@character IS NULL OR ${r}.character = @character)
  AND (@ascension IS NULL OR ${r}.ascension = @ascension)
  AND (@patch IS NULL OR ${r}.build_id = @patch)
  AND (@area IS NULL OR EXISTS (
    SELECT 1 FROM run_acts ra WHERE ra.run_id = ${r}.run_id AND ra.area = @area
  ))${mode ? `\n  AND ${MODE(r)}` : ""}${abandons ? `\n  AND ${ABANDONS(r)}` : ""}`;
const FILTER = filterFor("r");
// Fights and events are further limited to the rooms that happened inside the chosen area.
const inArea = (alias) => `(@area IS NULL OR EXISTS (
  SELECT 1 FROM run_acts ra
  WHERE ra.run_id = ${alias}.run_id AND ra.act = ${alias}.act AND ra.area = @area
))`;
const PROFILE_FILTER = `(@profileId IS NULL OR EXISTS (
  SELECT 1 FROM profile_runs pr WHERE pr.run_id = r.run_id AND pr.profile_id = @profileId
))`;
const BASE = `${FILTER} AND ${PROFILE_FILTER}`;

// Every character begins with one of these, so they say nothing about a run. Left out of relic stats.
const { STARTING_RELIC_LIST } = require("../lib/relics");
const { GAME_DATA } = require("../public/game-data");

// Game ids are [A-Z_] only (checked here), so they are safe to write into the SQL below.
const sqlId = (id) => {
  if (!/^[A-Z0-9_]+$/.test(id)) throw new Error(`Bad game data id: ${id}`);
  return id;
};
// Characters in game-data.js order; ones the site doesn't know yet come last.
const CHARACTER_ORDER = `CASE
${GAME_DATA.characters.map((c, i) => `  WHEN r.character LIKE '%${sqlId(c.id)}' THEN ${i + 1}`).join("\n")}
  ELSE ${GAME_DATA.characters.length + 1}
END`;
// OVERGROWTH -> Overgrowth (unknown areas keep their id).
const AREA_NAME = (column) => `CASE ${column}
${GAME_DATA.areas.map((a) => `  WHEN '${sqlId(a.id)}' THEN '${a.name.replace(/'/g, "''")}'`).join("\n")}
  ELSE ${column}
END`;

// "profile_id|username" of the site profile that owns a Steam id, or "|" when no one does.
const SITE_PROFILE = (steamRef) => `COALESCE((
  SELECT p.profile_id || '|' || p.username FROM profiles p
  WHERE p.steam_id = ${steamRef} ORDER BY p.profile_id LIMIT 1), '|')`;

const TABS = {
  overview: {
    title: "Overview",
    hidden: true,
    sql: `
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(r.win), 0) AS wins,
             COALESCE(ROUND(100.0 * SUM(r.win) / NULLIF(COUNT(*), 0), 1), 0) AS win_pct,
             COALESCE(ROUND(AVG(r.run_time) / 60.0, 1), 0) AS avg_minutes,
             -- How many abandons the other filters match, whether or not they are counted, so the
             -- Abandoned card shows the number either way.
             (SELECT COUNT(*) FROM runs r
              WHERE r.abandoned = 1 AND ${filterFor("r", { abandons: false })} AND ${PROFILE_FILTER}) AS abandoned
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
             -- Highest ascension actually won; losses and abandoned runs at a high level don't count.
             MAX(CASE WHEN r.win = 1 THEN r.ascension END) AS max_ascension
      FROM runs r
      WHERE ${BASE}
      GROUP BY r.character
      HAVING runs >= @min
      ORDER BY ${CHARACTER_ORDER}, runs DESC`,
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
    title: "Card WR",
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
    title: "Relic WR",
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
          AND (@source IS NULL OR x.origin = @source
               OR (@source = 'ANCIENT' AND substr(x.origin, 1, 8) = 'ANCIENT_')
               -- every relic that didn't come from Neow or an Ancient (shops, chests, fights, events...)
               OR (@source = 'NOT_ANCIENT' AND COALESCE(x.origin, '') <> 'NEOW'
                   AND substr(COALESCE(x.origin, ''), 1, 8) <> 'ANCIENT_'))
      )
      GROUP BY relic
      HAVING runs >= @min
      ORDER BY win_pct DESC, runs DESC`,
  },

  areas: {
    title: "Areas",
    // How often each area is beaten. A run enters an area when it has rooms there. It clears it by
    // entering the next act, or by winning (the last act has no next one). So Overgrowth and
    // Underdocks (both act 1) each lead on to Hive, and the route a run took doesn't matter.
    sql: `
      SELECT ${AREA_NAME("t.area")} AS area,
             COUNT(*) AS entered,
             SUM(cleared) AS cleared,
             COUNT(*) - SUM(cleared) AS failed,
             ROUND(100.0 * SUM(cleared) / COUNT(*), 1) AS clear_pct
      FROM (
        SELECT a.area, a.act,
               CASE WHEN r.win = 1 OR EXISTS (
                 SELECT 1 FROM run_acts n WHERE n.run_id = a.run_id AND n.act = a.act + 1
               ) THEN 1 ELSE 0 END AS cleared
        FROM run_acts a
        JOIN runs r ON r.run_id = a.run_id
        WHERE ${BASE}
      ) t
      GROUP BY t.act, t.area
      HAVING entered >= @min
      ORDER BY t.act, t.area`,
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
      WHERE ${BASE} AND ${inArea("f")}
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
      WHERE ${BASE} AND ${inArea("f")}
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
        WHERE ${BASE} AND ${inArea("e")}
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
      WHERE ${BASE} AND ${inArea("e")}
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
      -- Deaths, plus runs abandoned during a fight (killed by that fight). A run abandoned at an event
      -- or between rooms had no killer, so it isn't listed.
      WHERE r.win = 0 AND r.killed_by IS NOT NULL
        AND (r.abandoned = 0 OR r.killed_by LIKE 'ENCOUNTER.%') AND ${BASE}
        AND (@area IS NULL OR (f.act IS NOT NULL AND ${inArea("f")}))
      GROUP BY r.killed_by, f.type
      ORDER BY deaths DESC`,
  },

  recent_runs: {
    title: "Recent runs",
    sql: `
      SELECT datetime(r.start_time, 'unixepoch', 'localtime') AS started,
             -- "id:name,id:name" for every profile that imported this run
             (SELECT group_concat(p.profile_id || ':' || p.username, ',')
              FROM profile_runs pr JOIN profiles p ON p.profile_id = pr.profile_id
              WHERE pr.run_id = r.run_id) AS player,
             r.character,
             -- Multiplayer: "steam_id|profile_id|username|character|wins|runs;..." per teammate, where
             -- wins/runs is this player's record with that teammate (any character or area; the
             -- ascension and patch filters apply).
             (SELECT group_concat(
                       t.player_id || '|' || ${SITE_PROFILE("t.player_id")} || '|' || COALESCE(t.character, '')
                       || '|' || (SELECT COALESCE(SUM(r2.win), 0) || '|' || COUNT(*)
                                  FROM runs r2
                                  JOIN run_players t2 ON t2.run_id = r2.run_id AND t2.player_id = t.player_id
                                  WHERE r2.player_id = r.player_id AND ${ABANDONS("r2")}
                                    AND (@ascension IS NULL OR r2.ascension = @ascension)
                                    AND (@patch IS NULL OR r2.build_id = @patch)),
                       ';')
              FROM run_players t
              WHERE t.run_id = r.run_id AND t.player_id <> r.player_id) AS teammates,
             r.ascension,
             -- An abandoned run counts as a loss everywhere, but is labelled as what it was.
             CASE WHEN r.abandoned = 1 THEN 'ABANDONED' WHEN r.win = 1 THEN 'WIN' ELSE 'LOSS' END AS result,
             -- Abandoned mid-fight: that fight; abandoned anywhere else: no killer.
             CASE WHEN r.abandoned = 1 AND r.killed_by NOT LIKE 'ENCOUNTER.%' THEN NULL ELSE r.killed_by END AS killed_by,
             ROUND(r.run_time / 60.0, 1) AS minutes,
             (SELECT COUNT(*) FROM fights f WHERE f.run_id = r.run_id) AS fights,
             -- Not shown as a column: the page uses it for the Details button (run page).
             r.run_id
      FROM runs r
      WHERE ${FILTER} AND ${PROFILE_FILTER}
      ORDER BY r.start_time DESC
      LIMIT 100`,
  },

  teammates: {
    title: "Teammates",
    // Everyone played with in multiplayer runs, and the win rate of those runs. Always multiplayer,
    // whatever the Mode filter says (solo runs have no teammates). @character is your character.
    sql: `
      SELECT t.player_id || '|' || ${SITE_PROFILE("t.player_id")} AS teammate,
             group_concat(DISTINCT t.character) AS played_as,
             COUNT(*) AS runs,
             SUM(r.win) AS wins,
             ROUND(100.0 * SUM(r.win) / COUNT(*), 1) AS win_pct,
             datetime(MAX(r.start_time), 'unixepoch', 'localtime') AS last_played
      FROM run_players t
      JOIN runs r ON r.run_id = t.run_id
      WHERE t.player_id <> r.player_id
        AND ${filterFor("r", { mode: false })} AND ${PROFILE_FILTER}
      GROUP BY t.player_id
      HAVING runs >= @min
      ORDER BY runs DESC, win_pct DESC`,
  },

  trends: {
    title: "Trends",
    kind: "trends", // drawn as a line chart by public/trends.js instead of a table
    // One row per run, oldest first. The page works out the win rate over time.
    sql: `
      SELECT r.start_time, r.character, r.win
      FROM runs r
      WHERE ${BASE}
      ORDER BY COALESCE(r.start_time, 0), r.run_id
      LIMIT 20000`,
  },
};

// Runs one named query. Only the parameters that query actually uses are bound.
async function runQuery(db, id, raw = {}) {
  const t = TABS[id];
  if (!t) return null;
  const names = [...new Set([...t.sql.matchAll(/@(\w+)/g)].map((m) => m[1]))];
  const params = {};
  const defaults = { min: 1, mode: "solo" };
  for (const n of names) params[n] = raw[n] ?? defaults[n] ?? null;
  return rowsToObjects(await db.execute({ sql: t.sql, args: params }));
}

module.exports = { TABS, runQuery };
