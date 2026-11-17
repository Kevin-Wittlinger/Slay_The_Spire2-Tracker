// Fills a throwaway database with sample runs so the site can be tried out without real data.
//   node test/seed-demo.js            (creates data/demo.db)
//   DB_PATH=data/demo.db npm start    (PowerShell: $env:DB_PATH="data/demo.db"; npm start)
// Sign in with demo1 / demo1234, demo2 / demo1234 or demo3 / demo1234.
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const file = path.join(__dirname, "..", "data", "demo.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
for (const suffix of ["", "-wal", "-shm", "-journal"])
  fs.rmSync(file + suffix, { force: true });

const { openDb } = require("../lib/db");
const { createImporter } = require("../lib/importer");

// Small deterministic random generator so every seed gives the same data.
let seedState = 12345;
const random = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const CHARACTERS = ["IRONCLAD", "SILENT", "REGENT", "NECROBINDER", "DEFECT", "FOOL"];
const STARTER_RELIC = {
  IRONCLAD: "BURNING_BLOOD",
  SILENT: "RING_OF_THE_SNAKE",
  REGENT: "DIVINE_RIGHT",
  NECROBINDER: "BOUND_PHYLACTERY",
  DEFECT: "CRACKED_CORE",
  FOOL: "SONG_BOW",
};
const CARDS = ["ANGER", "BLACK_HOLE", "BLACKJACK", "RESONANCE", "STRIKE_PLUS", "SHIV", "WHIRLWIND"];
const RELICS = ["GOLDEN_PEARL", "LANTERN", "ANCHOR", "VAJRA", "ORICHALCUM"];
const ENEMIES = ["NIBBITS_WEAK", "SLIMES_WEAK", "GREMLIN_GANG", "LAGAVULIN_ELITE"];
const BOSSES = ["CEREMONIAL_BEAST_BOSS", "THE_GUARDIAN_BOSS"];
const PATCHES = ["v0.98.2", "v0.99.0", "v0.100.1"];

function makeRun(index) {
  const character = pick(CHARACTERS);
  const win = random() < 0.45;
  const abandoned = random() < 0.12;
  const bossDied = !win && random() < 0.5;
  const killer = `ENCOUNTER.${bossDied ? pick(BOSSES) : pick(ENEMIES)}`;
  const stat = (extra = {}) => ({ current_hp: 40, damage_taken: Math.floor(random() * 20), ...extra });
  const fight = (type, id, hp = 40) => ({
    map_point_type: type,
    rooms: [{ room_type: type, model_id: `ENCOUNTER.${id}`, monster_ids: [`MONSTER.${id}`], turns_taken: 2 + Math.floor(random() * 8) }],
    player_stats: [
      stat({
        current_hp: hp,
        card_choices: [
          { card: { id: `CARD.${pick(CARDS)}` }, was_picked: random() < 0.6 },
          { card: { id: `CARD.${pick(CARDS)}` }, was_picked: random() < 0.3 },
        ],
      }),
    ],
  });
  return {
    seed: `DEMO${index}`,
    start_time: 1790000000 + index * 86400 + Math.floor(random() * 3600),
    ascension: Math.floor(random() * 11),
    win,
    was_abandoned: abandoned,
    run_time: 900 + Math.floor(random() * 2400),
    build_id: pick(PATCHES),
    acts: [random() < 0.5 ? "ACT.OVERGROWTH" : "ACT.UNDERDOCKS", "ACT.HIVE", "ACT.GLORY"],
    killed_by_encounter: win ? "NONE.NONE" : killer,
    killed_by_event: "NONE.NONE",
    players: [
      {
        character: `CHARACTER.${character}`,
        deck: [
          { id: "CARD.STRIKE", floor_added_to_deck: 1 },
          { id: `CARD.${pick(CARDS)}`, floor_added_to_deck: 3, current_upgrade_level: random() < 0.3 ? 1 : 0 },
          { id: `CARD.${pick(CARDS)}`, floor_added_to_deck: 6 },
        ],
        relics: [
          { id: `RELIC.${STARTER_RELIC[character]}`, floor_added_to_deck: 1 },
          { id: `RELIC.${pick(RELICS)}`, floor_added_to_deck: 4 },
        ],
      },
    ],
    map_point_history: [
      [
        fight("monster", pick(ENEMIES)),
        fight("elite", "LAGAVULIN_ELITE"),
        fight("boss", bossDied ? killer.replace("ENCOUNTER.", "") : pick(BOSSES), win ? 12 : bossDied ? 0 : 20),
      ],
    ],
  };
}

async function main() {
  const db = await openDb(file);
  const importer = createImporter(db);
  const scrypt = (password, salt) =>
    new Promise((resolve, reject) =>
      crypto.scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key.toString("hex")))),
    );
  const profiles = [];
  for (const name of ["demo1", "demo2", "demo3"]) {
    const salt = crypto.randomBytes(16).toString("hex");
    const result = await db.execute({
      sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES (?,?,?,?)",
      args: [name, salt, await scrypt("demo1234", salt), Date.now()],
    });
    profiles.push(Number(result.lastInsertRowid));
  }
  const counts = {};
  for (let i = 0; i < 90; i++) {
    const run = makeRun(i);
    const { status } = await importer.importRun(run, profiles[i % 3]);
    counts[status] = (counts[status] || 0) + 1;
    // Every 10th run is shared by a second profile, like two friends importing one run.
    if (i % 10 === 0) await importer.importRun(run, profiles[(i + 1) % 3]);
  }
  await db.close();
  console.log(`Demo database written to ${file}`, counts);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
