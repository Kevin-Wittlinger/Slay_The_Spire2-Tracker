// Personal achievement badges, worked out from one profile's solo runs (abandoned and multiplayer
// runs never count).
//
//   All A10          a win on ascension 10 with every character
//   Rotating Streak  wins on ascension 10 in a row (no other run in between) that include every character
//   Speedrunner      a win in under 20 minutes, on any ascension
//
// "Every character" means every character in public/game-data.js. A newly released character joins the
// requirement when it is added there, not when someone happens to import a run with it, so one
// player's import never takes a badge away from everyone else.
//
// Earned badges are kept (profile_badges, with what they asked for at the time). When the requirement
// later grows, say a new character, a player who earned a badge keeps it, marked outdated with a note
// saying what changed, until they earn it again under the new requirement.

const { GAME_DATA, characterSlug } = require("../public/game-data");

const TOP_ASCENSION = GAME_DATA.maxAscension;
// The run file's id for each game-data character ("CHARACTER.IRONCLAD"), by slug ("ironclad").
const GAME_CHARACTERS = new Map(
  GAME_DATA.characters.map((c) => [characterSlug(c.id), `CHARACTER.${c.id}`]),
);
const SPEEDRUN_SECONDS = 20 * 60;

// runs: [{ character, ascension, win, run_time }], oldest first. characters: every character id.
// ascension: the level the A10 badges ask for.
function computeAchievements(runs, characters, { ascension = TOP_ASCENSION } = {}) {
  const isTopWin = (run) => Number(run.win) === 1 && Number(run.ascension) >= ascension;
  const total = characters.length;

  // All A10
  const beatenA10 = new Set(runs.filter(isTopWin).map((run) => run.character));
  const a10Done = characters.filter((c) => beatenA10.has(c));

  // Rotating Streak: the longest stretch of back-to-back A10 wins where every win is a different
  // character. Any other run (a loss, or a lower ascension) ends the stretch. Winning with a character
  // already in the stretch starts a new one just after that character's earlier win
  // (Ironclad, Silent, Ironclad leaves Silent, Ironclad).
  let best = [];
  let current = [];
  for (const run of runs) {
    if (!isTopWin(run)) {
      current = [];
      continue;
    }
    const repeat = current.indexOf(run.character);
    if (repeat >= 0) current = current.slice(repeat + 1);
    current.push(run.character);
    if (current.length > best.length) best = [...current];
  }
  best = new Set(best);
  const streakDone = characters.filter((c) => best.has(c));

  // Speedrunner
  const winTimes = runs
    .filter((run) => Number(run.win) === 1 && Number(run.run_time) > 0)
    .map((run) => Number(run.run_time));
  const fastest = winTimes.length ? Math.min(...winTimes) : null;

  return [
    {
      id: "all_a10",
      name: "All A10",
      description: `Win on ascension ${ascension} with every character.`,
      earned: total > 0 && a10Done.length === total,
      progress: `${a10Done.length} of ${total} characters`,
      characters: a10Done,
    },
    {
      id: "rotating_streak",
      name: "Rotating Streak",
      description: `Win on ascension ${ascension} with every character in a row, each one once, with no other run in between.`,
      earned: total > 0 && streakDone.length === total,
      progress: `Best streak: ${streakDone.length} of ${total} characters`,
      characters: streakDone,
    },
    {
      id: "speedrunner",
      name: "Speedrunner",
      description: "Win a run in under 20 minutes.",
      earned: fastest !== null && fastest < SPEEDRUN_SECONDS,
      progress: fastest === null ? "No wins yet" : `Fastest win: ${formatDuration(fastest)}`,
      characters: [],
    },
  ];
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// One profile's solo, non-abandoned runs, oldest first.
async function soloRuns(db, profileId) {
  const runs = await db.execute({
    sql: `SELECT r.character, r.ascension, r.win, r.run_time
      FROM runs r JOIN profile_runs pr ON pr.run_id = r.run_id
      WHERE pr.profile_id = ? AND r.abandoned = 0 AND r.player_count = 1
      ORDER BY COALESCE(r.start_time, 0), r.run_id`,
    args: [profileId],
  });
  return runs.rows;
}

// Spell a character the way game-data does ("CHARACTER.THE_SILENT" -> "CHARACTER.SILENT"), so a
// differently prefixed id still counts. Characters game-data doesn't list are kept as they are.
const canonical = (character) => GAME_CHARACTERS.get(characterSlug(character)) || character;

const recordStatement = (profileId, badge, characters, ascension, at = Date.now()) => ({
  sql: `INSERT OR IGNORE INTO profile_badges (profile_id, badge_id, earned_at, characters, ascension)
        VALUES (?,?,?,?,?)`,
  args: [profileId, badge.id, at, JSON.stringify(characters), ascension],
});

// What changed since a kept badge was earned, e.g. "Fool has been added since you earned it."
function outdatedNote(badge, record, characters) {
  const had = new Set(JSON.parse(record.characters || "[]").map((c) => characterSlug(c)));
  const added = characters.filter((c) => !had.has(characterSlug(c))).map((c) => GAME_NAMES.get(characterSlug(c)) || c);
  const changes = [];
  if (added.length) changes.push(`${listText(added)} ${added.length === 1 ? "has" : "have"} been added`);
  if (Number(record.ascension) !== TOP_ASCENSION)
    changes.push(`it now asks for ascension ${TOP_ASCENSION} instead of ${record.ascension}`);
  return changes.length
    ? `Outdated: ${changes.join(", and ")} since you earned it.`
    : "Outdated: the requirement has changed since you earned it.";
}
const GAME_NAMES = new Map(GAME_DATA.characters.map((c) => [characterSlug(c.id), c.name]));
const listText = (items) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

async function profileAchievements(db, profileId) {
  const [rows, recorded] = await Promise.all([
    soloRuns(db, profileId),
    db.execute({
      sql: "SELECT badge_id, earned_at, characters, ascension FROM profile_badges WHERE profile_id = ?",
      args: [profileId],
    }),
  ]);
  const kept = new Map(recorded.rows.map((row) => [row.badge_id, row]));
  const normalized = rows.map((run) => ({ ...run, character: canonical(run.character) }));
  const all = [...GAME_CHARACTERS.values()];
  const badges = computeAchievements(normalized, all);

  // Remember newly earned badges, so they are kept if the requirement grows later.
  const fresh = badges.filter((badge) => badge.earned && !kept.has(badge.id));
  if (fresh.length) {
    const now = Date.now();
    await db.batch(fresh.map((badge) => recordStatement(profileId, badge, all, TOP_ASCENSION, now)), "write");
    for (const badge of fresh) kept.set(badge.id, { earned_at: now });
  }

  for (const badge of badges) {
    const record = kept.get(badge.id);
    if (record) badge.earnedAt = Number(record.earned_at);
    // Earned once, but not under today's requirement: still earned, marked outdated.
    if (record && !badge.earned) {
      badge.earned = true;
      badge.outdated = true;
      badge.outdatedNote = outdatedNote(badge, record, all);
    }
  }
  return { characters: all, badges };
}

// Migration: records badges earned under the rule used before game-data.js, where "every character"
// meant every character anyone had played solo on the site. Without this, players who earned a badge
// that way would lose it when the requirement switched to game-data's list.
async function recordPastBadges(db) {
  const [profiles, characters] = await Promise.all([
    db.execute("SELECT DISTINCT profile_id FROM profile_runs"),
    db.execute("SELECT DISTINCT character FROM runs WHERE abandoned = 0 AND player_count = 1"),
  ]);
  const oldAll = characters.rows.map((row) => row.character);
  if (!oldAll.length) return;
  const statements = [];
  for (const { profile_id: profileId } of profiles.rows) {
    const badges = computeAchievements(await soloRuns(db, profileId), oldAll, { ascension: 10 });
    for (const badge of badges.filter((b) => b.earned))
      statements.push(recordStatement(Number(profileId), badge, oldAll, 10));
  }
  if (statements.length) await db.batch(statements, "write");
}

module.exports = {
  computeAchievements,
  profileAchievements,
  recordPastBadges,
  TOP_ASCENSION,
  SPEEDRUN_SECONDS,
};
