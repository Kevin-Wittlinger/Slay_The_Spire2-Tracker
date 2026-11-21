// Personal achievement badges, worked out from one profile's solo runs (abandoned and multiplayer
// runs never count).
//
//   All A10          a win on ascension 10 with every character
//   Rotating Streak  wins on ascension 10 in a row (no other run in between) that include every character
//   Speedrunner      a win in under 20 minutes, on any ascension
//
// "Every character" means every character anyone has played on the site, so a newly released character
// is added to the requirement as soon as someone imports a run with it.

const TOP_ASCENSION = 10;
const SPEEDRUN_SECONDS = 20 * 60;

// runs: [{ character, ascension, win, run_time }], oldest first. characters: every character id.
function computeAchievements(runs, characters) {
  const isTopWin = (run) => Number(run.win) === 1 && Number(run.ascension) >= TOP_ASCENSION;
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
      description: "Win on ascension 10 with every character.",
      earned: total > 0 && a10Done.length === total,
      progress: `${a10Done.length} of ${total} characters`,
      characters: a10Done,
    },
    {
      id: "rotating_streak",
      name: "Rotating Streak",
      description: "Win on ascension 10 with every character in a row, each one once, with no other run in between.",
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

async function profileAchievements(db, profileId) {
  const [runs, characters] = await Promise.all([
    db.execute({
      sql: `SELECT r.character, r.ascension, r.win, r.run_time
        FROM runs r JOIN profile_runs pr ON pr.run_id = r.run_id
        WHERE pr.profile_id = ? AND r.abandoned = 0 AND r.player_count = 1
        ORDER BY COALESCE(r.start_time, 0), r.run_id`,
      args: [profileId],
    }),
    db.execute("SELECT DISTINCT character FROM runs WHERE abandoned = 0 AND player_count = 1"),
  ]);
  const all = characters.rows.map((row) => row.character);
  return { characters: all, badges: computeAchievements(runs.rows, all) };
}

module.exports = { computeAchievements, profileAchievements, TOP_ASCENSION, SPEEDRUN_SECONDS };
