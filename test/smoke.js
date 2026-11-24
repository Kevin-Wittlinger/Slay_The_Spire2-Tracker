// Smoke test: node test/smoke.js
const assert = require("assert");
const { Readable } = require("stream");
process.env.IMPORT_TOKEN = "smoke-test-token";
const { openDb } = require("../lib/db");
const { createImporter } = require("../lib/importer");
const { createHandler } = require("../lib/handler");
const { createRateLimiter } = require("../lib/ratelimit");
const { buildTrends } = require("../public/trends");
const { TABS, runQuery } = require("../db/queries");
const { computeAchievements } = require("../lib/achievements");
const { GAME_DATA } = require("../public/game-data");

function makeRun({
  seed,
  win = false,
  players = 1,
  character = "CHARACTER.REGENT",
  start = 1794596230,
}) {
  const player = {
    character,
    deck: [
      { id: "CARD.STRIKE_REGENT", floor_added_to_deck: 1 },
      {
        id: "CARD.RESONANCE",
        floor_added_to_deck: 2,
        current_upgrade_level: 1,
      },
    ],
    relics: [
      { id: "RELIC.DIVINE_RIGHT", floor_added_to_deck: 1 },
      { id: "RELIC.GOLDEN_PEARL", floor_added_to_deck: 1 },
    ],
  };
  const stat = (extra) => ({ current_hp: 50, damage_taken: 3, ...extra });
  return {
    seed,
    start_time: start,
    ascension: 10,
    win,
    was_abandoned: false,
    run_time: 581,
    killed_by_encounter: win ? "NONE.NONE" : "ENCOUNTER.CEREMONIAL_BEAST_BOSS",
    killed_by_event: "NONE.NONE",
    players: Array.from({ length: players }, () => player),
    map_point_history: [
      [
        {
          map_point_type: "monster",
          rooms: [
            {
              room_type: "monster",
              model_id: "ENCOUNTER.NIBBITS_WEAK",
              monster_ids: ["MONSTER.NIBBIT"],
              turns_taken: 4,
            },
          ],
          player_stats: Array.from({ length: players }, () =>
            stat({
              card_choices: [
                { card: { id: "CARD.RESONANCE" }, was_picked: true },
                { card: { id: "CARD.BLACK_HOLE" }, was_picked: false },
              ],
            }),
          ),
        },
        {
          map_point_type: "unknown",
          rooms: [{ room_type: "event", model_id: "EVENT.NEOW" }],
          player_stats: [
            stat({ event_choices: [{ title: { key: "GOLDEN_PEARL.title" } }] }),
          ],
        },
        {
          map_point_type: "boss",
          rooms: [
            {
              room_type: "boss",
              model_id: "ENCOUNTER.CEREMONIAL_BEAST_BOSS",
              monster_ids: ["MONSTER.CEREMONIAL_BEAST"],
              turns_taken: 7,
            },
          ],
          player_stats: [stat({ current_hp: win ? 10 : 0, damage_taken: 49 })],
        },
      ],
    ],
  };
}

function createResponse() {
  return {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

async function dispatch(handler, url, method = "GET", body, token, cookie, ip) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.url = url;
  req.method = method;
  if (ip) req.socket = { remoteAddress: ip };
  req.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const res = createResponse();
  await handler(req, res);
  return res;
}

async function main() {
  // Relic popup text (public/relic-info.json, built by scripts/update-relic-info.js from wiki markup).
  {
    const { toPlainText, relicId } = require("../scripts/update-relic-info");
    assert.strictEqual(relicId("Burning Blood"), "RELIC.BURNING_BLOOD");
    assert.strictEqual(relicId("Pael's Claw"), "RELIC.PAELS_CLAW");
    // Icons, links, line breaks and energy markers become plain words.
    assert.strictEqual(
      toPlainText(`At the start of each combat, gain 8 <span class="power-trigger" data-name="Vigor">[[File:V.png|22px|link=X]] [[Slay_the_Spire_2:Vigor|Vigor]]</span>.`),
      "At the start of each combat, gain 8 Vigor.",
    );
    assert.strictEqual(toPlainText("gain 7<br><span data-name='@ST'>[[File:S.png|24px|link=]]</span>."), "gain 7 Stars.");
    assert.strictEqual(toPlainText("lose @CE@CE, then gain an additional @CE next turn"), "lose 2 Energy, then gain an additional Energy next turn");
    assert.strictEqual(toPlainText("a random [https://x.test/?a=b Rare Card] to add"), "a random Rare Card to add");
    assert.strictEqual(toPlainText("''Once'' per [[Combat|fight]] <b>now</b>"), "Once per fight now");
    // The shipped data file is deliberately not checked: a relic missing from it (a new relic, or one
    // the wiki doesn't list) just has no popup, and that must never fail a build.
  }

  // Migrations: a database from before the multiplayer and relic-origin columns is upgraded once,
  // and later starts skip what is already recorded.
  {
    const { createClient } = require("@libsql/client");
    const { migrate, MIGRATIONS } = require("../lib/migrations");
    const old = createClient({ url: ":memory:" });
    // Player 1 won A10 with both characters the site had seen, which earned All A10 under the old
    // "every character anyone played" rule.
    await old.executeMultiple(`
      CREATE TABLE runs (run_id TEXT PRIMARY KEY, character TEXT NOT NULL, ascension INTEGER, win INTEGER NOT NULL,
        abandoned INTEGER NOT NULL DEFAULT 0, run_time INTEGER, start_time INTEGER);
      CREATE TABLE profiles (profile_id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE profile_runs (profile_id INTEGER, run_id TEXT, created_at INTEGER);
      CREATE TABLE run_relics (run_id TEXT, relic_id TEXT, floor_added INTEGER, source TEXT);
      CREATE TABLE profile_badges (profile_id INTEGER, badge_id TEXT, earned_at INTEGER, characters TEXT,
        ascension INTEGER, PRIMARY KEY (profile_id, badge_id));
      INSERT INTO profiles VALUES (1, 'veteran');
      INSERT INTO runs VALUES ('a', 'CHARACTER.IRONCLAD', 10, 1, 0, 1800, 1), ('b', 'CHARACTER.SILENT', 10, 1, 0, 1800, 2),
        ('c', 'CHARACTER.SILENT', 10, 1, 1, 1800, 3); -- abandoned, though marked as a win
      INSERT INTO profile_runs VALUES (1, 'a', 0), (1, 'b', 0), (1, 'c', 0);`);
    assert.deepStrictEqual(await migrate(old), MIGRATIONS.map((m) => m.version));
    // Card offers get their act (migration 6): from the fight on that floor, else the run page's room.
    {
      const offers = createClient({ url: ":memory:" });
      await offers.executeMultiple(`
        CREATE TABLE card_choices (run_id TEXT, floor INTEGER, source TEXT, card_id TEXT, picked INTEGER);
        CREATE TABLE fights (run_id TEXT, floor INTEGER, act INTEGER);
        CREATE TABLE run_rooms (run_id TEXT, floor INTEGER, act INTEGER);
        INSERT INTO card_choices VALUES ('a', 3, 'monster', 'CARD.X', 1), ('a', 20, 'shop', 'CARD.Y', 0), ('a', 40, 'boss', 'CARD.Z', 0);
        INSERT INTO fights VALUES ('a', 3, 1);
        INSERT INTO run_rooms VALUES ('a', 20, 2);`);
      await MIGRATIONS.find((m) => m.version === 6).up(offers);
      const acts = (await offers.execute("SELECT act FROM card_choices ORDER BY floor")).rows.map((r) => r.act);
      assert.deepStrictEqual(acts, [1, 2, null], "a floor with no fight or room stays unknown");
      offers.close();
    }
    const columns = async (table) => (await old.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);
    assert.ok((await columns("runs")).includes("player_count"));
    assert.ok((await columns("profiles")).includes("steam_id"));
    assert.ok((await columns("run_relics")).includes("origin"));
    assert.ok(!(await columns("run_relics")).includes("source"), "the old source column is dropped");
    for (const col of ["game_mode", "final_hp", "max_hp", "gold", "potion_slots", "potions"])
      assert.ok((await columns("runs")).includes(col), `runs.${col} is added for the run page`);
    const kept = (await old.execute("SELECT badge_id, characters FROM profile_badges ORDER BY badge_id")).rows;
    assert.deepStrictEqual(kept.map((r) => r.badge_id), ["all_a10", "rotating_streak"]);
    assert.deepStrictEqual(JSON.parse(kept[0].characters).sort(), ["CHARACTER.IRONCLAD", "CHARACTER.SILENT"]);
    // Abandoned runs are losses: an old row marked as a win is corrected, and keeps its abandoned flag.
    const c = (await old.execute("SELECT win, abandoned FROM runs WHERE run_id = 'c'")).rows[0];
    assert.deepStrictEqual([Number(c.win), Number(c.abandoned)], [0, 1]);
    assert.deepStrictEqual(await migrate(old), [], "nothing runs twice");
    old.close();
  }

  const db = await openDb(":memory:");
  const importer = createImporter(db);
  const profile = await db.execute({
    sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES (?,?,?,?)",
    args: ["tester", "salt", "hash", Date.now()],
  });
  const profileId = Number(profile.lastInsertRowid);
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "A" }), profileId)).status,
    "imported",
  );
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "A" }), profileId)).status,
    "duplicate",
  );
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "B", players: 2 }), profileId))
      .status,
    "multiplayer",
  );
  assert.strictEqual(
    (await importer.importRun({ nope: true })).status,
    "invalid",
  );
  assert.strictEqual(
    (
      await importer.importRun(
        makeRun({ seed: "C", win: true, start: 1794600000 }),
        profileId,
      )
    ).status,
    "imported",
  );

  const count = await db.execute("SELECT COUNT(*) AS n FROM runs");
  assert.strictEqual(Number(count.rows[0].n), 2);
  const lostFight = await db.execute(
    "SELECT died FROM fights WHERE type='boss' AND run_id LIKE 'A:%'",
  );
  assert.strictEqual(Number(lostFight.rows[0].died), 1);
  const wonFight = await db.execute(
    "SELECT died FROM fights WHERE type='boss' AND run_id LIKE 'C:%'",
  );
  assert.strictEqual(Number(wonFight.rows[0].died), 0);

  for (const id of Object.keys(TABS)) {
    await runQuery(db, id, {});
    await runQuery(db, id, {
      character: "CHARACTER.REGENT",
      ascension: 10,
      min: 1,
    });
  }
  assert.strictEqual((await runQuery(db, "overview", {}))[0].win_pct, 50);
  assert.strictEqual(
    (await runQuery(db, "fight_types", {})).find((row) => row.type === "boss")
      .win_pct,
    50,
  );

  // Starting relics are left out of relic stats; other relics stay.
  const relicRows = (await runQuery(db, "relic_win_rate", {})).map((row) => row.relic);
  assert(!relicRows.includes("RELIC.DIVINE_RIGHT"));
  assert(relicRows.includes("RELIC.GOLDEN_PEARL"));

  const handler = createHandler(db);
  const killedByDb = await openDb(":memory:");
  const killerSamples = [
    ["normal", "ENCOUNTER.NORMAL", "monster"],
    ["elite", "ENCOUNTER.ELITE", "elite"],
    ["boss", "ENCOUNTER.BOSS", "boss"],
  ];
  const killerStatements = [];
  for (const [runId, encounter, type] of killerSamples) {
    killerStatements.push(
      {
        sql: "INSERT INTO runs (run_id, character, win, killed_by) VALUES (?,?,?,?)",
        args: [runId, "CHARACTER.REGENT", 0, encounter],
      },
      {
        sql: "INSERT INTO fights (run_id, floor, act, type, encounter_id, died) VALUES (?,?,?,?,?,?)",
        args: [runId, 1, 1, type, encounter, 1],
      },
    );
  }
  await killedByDb.batch(killerStatements, "write");
  const killerTypes = (await runQuery(killedByDb, "killed_by", {}))
    .map((row) => row.type)
    .sort();
  assert.deepStrictEqual(killerTypes, ["Boss", "Elite", "Regular combat"]);
  await killedByDb.close();

  // Patch filter: every stat can be limited to one build, and the filter list offers each build.
  const patchDb = await openDb(":memory:");
  await patchDb.batch(
    [
      ["p1", "v0.98.2", 1],
      ["p2", "v0.98.2", 0],
      ["p3", "v0.99.0", 1],
      ["p4", null, 1],
    ].map(([id, build, win]) => ({
      sql: "INSERT INTO runs (run_id, character, win, build_id) VALUES (?,?,?,?)",
      args: [id, "CHARACTER.IRONCLAD", win, build],
    })),
    "write",
  );
  assert.strictEqual((await runQuery(patchDb, "overview", {}))[0].runs, 4);
  assert.strictEqual(
    (await runQuery(patchDb, "overview", { patch: "v0.98.2" }))[0].runs,
    2,
  );
  assert.strictEqual(
    (await runQuery(patchDb, "characters", { patch: "v0.99.0" }))[0].runs,
    1,
  );
  assert.strictEqual(
    (await runQuery(patchDb, "recent_runs", { patch: "v0.99.0" })).length,
    1,
  );
  assert.strictEqual((await runQuery(patchDb, "recent_runs", {})).length, 4);
  const patchApi = await dispatch(createHandler(patchDb), "/api/filters");
  assert.deepStrictEqual(JSON.parse(patchApi.body).patches.sort(), [
    "v0.98.2",
    "v0.99.0",
  ]);
  await patchDb.close();

  // Area filter: runs are tagged with the acts they played (Overgrowth/Underdocks, Hive, Glory).
  // Run-level stats keep runs that passed through the area; fights only count that area's rooms.
  const areaDb = await openDb(":memory:");
  const areaImporter = createImporter(areaDb);
  const areaRun = (seed, acts, win, fights) => ({
    ...makeRun({ seed }),
    acts,
    win,
    map_point_history: fights.map((encounter) => [
      {
        map_point_type: "monster",
        rooms: [{ room_type: "monster", model_id: encounter, monster_ids: [], turns_taken: 3 }],
        player_stats: [{ damage_taken: 5, current_hp: 40 }],
      },
    ]),
  });
  const underdocksRun = areaRun("U", ["ACT.UNDERDOCKS", "ACT.HIVE"], false, [
    "ENCOUNTER.BUG_A",
    "ENCOUNTER.BUG_B",
  ]);
  const overgrowthRun = areaRun("O", ["ACT.OVERGROWTH", "ACT.HIVE", "ACT.GLORY"], true, [
    "ENCOUNTER.PLANT",
    "ENCOUNTER.BUG_C",
    "ENCOUNTER.KNIGHT",
  ]);
  const areaProfile = 1;
  await areaDb.execute({
    sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('a', 's', 'h', 0)",
    args: [],
  });
  await areaImporter.importRun(underdocksRun, areaProfile);
  await areaImporter.importRun(overgrowthRun, areaProfile);
  const areaRuns = async (area) =>
    (await runQuery(areaDb, "overview", { area }))[0].runs;
  assert.strictEqual(await areaRuns(null), 2);
  assert.strictEqual(await areaRuns("UNDERDOCKS"), 1);
  assert.strictEqual(await areaRuns("OVERGROWTH"), 1);
  assert.strictEqual(await areaRuns("HIVE"), 2);
  assert.strictEqual(await areaRuns("GLORY"), 1);
  assert.strictEqual(await areaRuns("NOWHERE"), 0);
  // Fights are limited to the chosen area's own act: act 1 = floors 1, act 2 = floor 2, ...
  const fightCount = async (area) =>
    (await runQuery(areaDb, "fight_types", { area })).reduce((n, r) => n + r.fights, 0);
  assert.strictEqual(await fightCount(null), 5);
  assert.strictEqual(await fightCount("UNDERDOCKS"), 1);
  assert.strictEqual(await fightCount("HIVE"), 2);
  assert.strictEqual(await fightCount("GLORY"), 1);
  // Areas tab: clearing an area = entering the next act (or winning). U died in Hive (2 acts),
  // O won (3 acts), so Underdocks 1/1, Overgrowth 1/1, Hive 1/2, Glory 1/1.
  const areaRows = Object.fromEntries(
    (await runQuery(areaDb, "areas", {})).map((r) => [r.area, [r.entered, r.cleared, r.clear_pct]]),
  );
  assert.deepStrictEqual(areaRows, {
    Overgrowth: [1, 1, 100],
    Underdocks: [1, 1, 100],
    Hive: [2, 1, 50],
    Glory: [1, 1, 100],
  });
  assert.deepStrictEqual((await runQuery(areaDb, "areas", {})).map((r) => r.area), [
    "Overgrowth",
    "Underdocks",
    "Hive",
    "Glory",
  ]);
  // Card pick rate by area: a reward counts for the area its fight was in (same floor), not for the
  // whole run. O's floor 1 is Overgrowth, floor 2 Hive, floor 3 Glory.
  await areaDb.batch(
    [1, 2, 3].map((floor) => ({
      sql: "INSERT INTO card_choices (run_id, floor, act, source, card_id, picked) SELECT run_id, ?, ?, 'monster', 'CARD.AREA_TEST', ? FROM runs WHERE seed = 'O'",
      args: [floor, floor, floor === 1 ? 1 : 0],
    })),
    "write",
  );
  const pickRow = async (area) =>
    (await runQuery(areaDb, "card_pick_rate", { area })).find((r) => r.card === "CARD.AREA_TEST");
  assert.deepStrictEqual(
    [(await pickRow(null)).offered, (await pickRow(null)).picked],
    [3, 1],
  );
  assert.deepStrictEqual(
    [(await pickRow("OVERGROWTH")).offered, (await pickRow("OVERGROWTH")).picked],
    [1, 1],
  );
  assert.strictEqual((await pickRow("HIVE")).offered, 1);
  assert.strictEqual((await pickRow("HIVE")).picked, 0);
  assert.strictEqual(await pickRow("UNDERDOCKS"), undefined, "no run through Underdocks was offered it");
  // Backfill: runs imported before areas existed get them from what the learned enemies say.
  // V is an Overgrowth run (PLANT is known from O); W only fought an enemy nobody has tagged.
  const { backfillAreas } = require("../lib/areas");
  const vRun = areaRun("V", ["ACT.OVERGROWTH", "ACT.HIVE", "ACT.GLORY"], true, [
    "ENCOUNTER.PLANT",
    "ENCOUNTER.BUG_C",
    "ENCOUNTER.KNIGHT",
  ]);
  const wRun = areaRun("W", ["ACT.UNDERDOCKS", "ACT.HIVE"], false, ["ENCOUNTER.NEVER_SEEN", "ENCOUNTER.BUG_B"]);
  await areaImporter.importRun(vRun, areaProfile);
  await areaImporter.importRun(wRun, areaProfile);
  await areaDb.execute("DELETE FROM run_acts WHERE run_id LIKE 'V:%' OR run_id LIKE 'W:%'");
  assert.ok((await backfillAreas(areaDb)) > 0);
  const areasOf = async (prefix) =>
    (await areaDb.execute({ sql: "SELECT area FROM run_acts WHERE run_id LIKE ? ORDER BY act", args: [prefix + ":%"] })).rows.map((r) => r.area);
  assert.deepStrictEqual(await areasOf("V"), ["OVERGROWTH", "HIVE", "GLORY"]);
  assert.deepStrictEqual(await areasOf("W"), []); // unknown enemy: left alone, not guessed
  assert.strictEqual(await backfillAreas(areaDb), 0); // nothing left that can be worked out
  await areaDb.execute("DELETE FROM runs WHERE run_id LIKE 'V:%' OR run_id LIKE 'W:%'");

  // Re-importing a run that was saved before areas were tracked fills the areas in.
  await areaDb.execute("DELETE FROM run_acts");
  assert.strictEqual(await areaRuns("HIVE"), 0);
  assert.strictEqual((await areaImporter.importRun(overgrowthRun, areaProfile)).status, "duplicate");
  assert.strictEqual(await areaRuns("GLORY"), 1);
  // The API passes ?area= through and ignores anything that is not an area name.
  const areaApi = createHandler(areaDb);
  assert.strictEqual(JSON.parse((await dispatch(areaApi, "/api/stats/overview?area=GLORY")).body)[0].runs, 1);
  assert.strictEqual(JSON.parse((await dispatch(areaApi, "/api/stats/overview?area=glory%27%3B--")).body)[0].runs, 2);
  await areaDb.close();

  // Relic origin: Neow, each Ancient, shop, elite, boss, treasure, events, rest sites.
  const relicDb = await openDb(":memory:");
  const relicImporter = createImporter(relicDb);
  const ancientRoom = (model) => ({
    map_point_type: "ancient",
    rooms: [{ room_type: "event", model_id: model }],
    player_stats: [{}],
  });
  const room = (mapType, roomType, model, extra = {}) => ({
    map_point_type: mapType,
    rooms: [{ room_type: roomType, model_id: model, monster_ids: [] }],
    player_stats: [{ current_hp: 40, damage_taken: 1, ...extra }],
  });
  const relicRun = (seed) => ({
    ...makeRun({ seed, win: true }),
    map_point_history: [
      [
        ancientRoom("EVENT.NEOW"), // floor 1
        room("elite", "elite", "ENCOUNTER.X"), // 2
        room("shop", "shop", undefined, { card_choices: [{ card: { id: "CARD.SHOP_OFFER" }, was_picked: false }] }), // 3
      ],
      [
        ancientRoom("EVENT.TANX"), // 4
        room("treasure", "treasure"), // 5
        room("unknown", "event", "EVENT.SOME_EVENT"), // 6
        room("rest_site", "rest_site"), // 7
        room("boss", "boss", "ENCOUNTER.B"), // 8
      ],
      [ancientRoom("EVENT.VAKUU")], // 9
    ],
  });
  const relicRunData = relicRun("R1");
  relicRunData.players[0].relics = [
    { id: "RELIC.DIVINE_RIGHT", floor_added_to_deck: 1 }, // starting relic, same floor as Neow
    { id: "RELIC.FROM_NEOW", floor_added_to_deck: 1 },
    { id: "RELIC.FROM_ELITE", floor_added_to_deck: 2 },
    { id: "RELIC.FROM_SHOP", floor_added_to_deck: 3 },
    { id: "RELIC.FROM_TANX", floor_added_to_deck: 4 },
    { id: "RELIC.FROM_CHEST", floor_added_to_deck: 5 },
    { id: "RELIC.FROM_EVENT", floor_added_to_deck: 6 },
    { id: "RELIC.FROM_REST", floor_added_to_deck: 7 },
    { id: "RELIC.FROM_BOSS", floor_added_to_deck: 8 },
    { id: "RELIC.FROM_VAKUU", floor_added_to_deck: 9 },
  ];
  await relicDb.execute("INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('r', 's', 'h', 0)");
  await relicImporter.importRun(relicRunData, 1);
  const originsOf = async () =>
    Object.fromEntries((await relicDb.execute("SELECT relic_id, origin FROM run_relics")).rows.map((r) => [r.relic_id, r.origin]));
  const expectedOrigins = {
    "RELIC.DIVINE_RIGHT": "STARTING",
    "RELIC.FROM_NEOW": "NEOW",
    "RELIC.FROM_ELITE": "ELITE",
    "RELIC.FROM_SHOP": "SHOP",
    "RELIC.FROM_TANX": "ANCIENT_TANX",
    "RELIC.FROM_CHEST": "TREASURE",
    "RELIC.FROM_EVENT": "EVENT",
    "RELIC.FROM_REST": "REST",
    "RELIC.FROM_BOSS": "BOSS",
    "RELIC.FROM_VAKUU": "ANCIENT_VAKUU",
  };
  assert.deepStrictEqual(await originsOf(), expectedOrigins);
  const relicNames = async (source) =>
    (await runQuery(relicDb, "relic_win_rate", { source })).map((r) => r.relic.replace("RELIC.FROM_", "")).sort();
  assert.strictEqual((await relicNames(null)).length, 9); // the starting relic is never listed
  assert.deepStrictEqual(await relicNames("NEOW"), ["NEOW"]);
  assert.deepStrictEqual(await relicNames("ANCIENT"), ["TANX", "VAKUU"]); // every act 2 and 3 Ancient
  assert.deepStrictEqual(await relicNames("ANCIENT_TANX"), ["TANX"]);
  assert.deepStrictEqual(await relicNames("SHOP"), ["SHOP"]);
  assert.deepStrictEqual(await relicNames("ELITE"), ["ELITE"]);
  assert.deepStrictEqual(await relicNames("BOSS"), ["BOSS"]);
  assert.deepStrictEqual(await relicNames("TREASURE"), ["CHEST"]);
  assert.deepStrictEqual(await relicNames("EVENT"), ["EVENT"]);
  // A database from before the column existed is upgraded and its rows worked out from the tables we keep.
  // Treasure chests and rest sites can't be told apart there, so the rest site shows as TREASURE.
  const { ensureRelicSourceColumn, backfillRelicSources } = require("../lib/relics");
  await relicDb.execute("DROP INDEX idx_relics_origin");
  await relicDb.execute("ALTER TABLE run_relics DROP COLUMN origin");
  await relicDb.execute("ALTER TABLE run_relics ADD COLUMN source TEXT"); // the first version of the column
  await ensureRelicSourceColumn(relicDb);
  assert.ok(!(await relicDb.execute("PRAGMA table_info(run_relics)")).rows.some((c) => c.name === "source"));
  assert.ok((await backfillRelicSources(relicDb)) > 0);
  assert.deepStrictEqual(await originsOf(), { ...expectedOrigins, "RELIC.FROM_REST": "TREASURE" });
  assert.strictEqual(await backfillRelicSources(relicDb), 0);
  // Importing the run file again sets the exact value.
  assert.strictEqual((await relicImporter.importRun(relicRunData, 1)).status, "duplicate");
  assert.deepStrictEqual(await originsOf(), expectedOrigins);
  // The API takes upper-case names only.
  const relicApi = createHandler(relicDb);
  const apiRelics = async (q) => JSON.parse((await dispatch(relicApi, "/api/stats/relic_win_rate" + q)).body).length;
  assert.strictEqual(await apiRelics("?source=ANCIENT_VAKUU"), 1);
  assert.strictEqual(await apiRelics("?source=ANCIENT"), 2);
  assert.strictEqual(await apiRelics("?source=bogus"), 9);
  // "No Neow or Ancients" is everything else: the three choices add up to all relics.
  assert.strictEqual(
    (await apiRelics("?source=NEOW")) + (await apiRelics("?source=ANCIENT")) + (await apiRelics("?source=NOT_ANCIENT")),
    9,
  );
  assert.ok((await apiRelics("?source=NOT_ANCIENT")) >= 5);
  await relicDb.close();

  // Start-up chores run at most once a day (each cold start would otherwise re-read every run on Turso).
  {
    const { claimDailyTask } = require("../lib/db");
    const choreDb = await openDb(":memory:"); // opening it already ran (and stamped) the backfills
    assert.strictEqual(await claimDailyTask(choreDb, "backfills"), false);
    assert.strictEqual(await claimDailyTask(choreDb, "other"), true);
    assert.strictEqual(await claimDailyTask(choreDb, "other"), false, "only one caller gets it");
    await choreDb.execute("UPDATE maintenance SET last_run = last_run - 25 * 60 * 60 * 1000");
    assert.strictEqual(await claimDailyTask(choreDb, "backfills"), true, "due again after a day");
    await choreDb.close();
  }

  // Caching: shared statistics may be cached briefly, anything tied to the signed-in user never.
  const cacheApi = createHandler(await openDb(":memory:"));
  const cacheOf = async (url) => (await dispatch(cacheApi, url)).headers["Cache-Control"];
  assert.match(await cacheOf("/api/stats/characters"), /s-maxage=300/);
  assert.match(await cacheOf("/api/filters"), /s-maxage=300/);
  assert.strictEqual(await cacheOf("/api/stats/characters?scope=profile"), "no-store");
  assert.strictEqual(await cacheOf("/api/status"), "no-store");
  assert.strictEqual(await cacheOf("/api/stats/nothing"), "no-store");

  // Google Analytics: the tag is loaded from a file (inline scripts are blocked by the
  // Content-Security-Policy) and both CSPs must allow Google's domains, or it fails silently.
  const publicFile = (name) => require("fs").readFileSync(require("path").join(__dirname, "..", name), "utf8");
  assert(publicFile("public/index.html").includes('<script src="analytics.js"></script>'));
  const analyticsSource = publicFile("public/analytics.js");
  assert(analyticsSource.includes('"GTM-PTM5ZFBX"'));
  // Google: only one Google tag per page. A direct gtag.js tag next to the container would double count.
  assert(!analyticsSource.includes("gtag/js"), "only the container tag is loaded");
  assert(!publicFile("public/index.html").includes("googletagmanager"), "tag is loaded from analytics.js only");
  const cspOf = (text) => text.match(/default-src 'self'[^"]*/)[0];
  assert.strictEqual(cspOf(publicFile("vercel.json")), cspOf(publicFile("server.js")));
  for (const need of ["script-src 'self' https://*.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.g.doubleclick.net"])
    assert(cspOf(publicFile("vercel.json")).includes(need), need);
  assert(!publicFile("public/index.html").match(/<script(?![^>]*src=)[^>]*>/), "no inline scripts");

  // Guard against scroll-jump bugs: views must be replaced through swapView() in app.js,
  // never by emptying the container first (see the comment on swapView).
  const fs = require("fs");
  const pageSource = (name) => fs.readFileSync(require("path").join(__dirname, "..", "public", name), "utf8");
  assert.strictEqual(pageSource("app.js").split("host.replaceChildren(").length - 1, 1);
  assert.strictEqual(pageSource("trends.js").includes("host.replaceChildren("), false);
  assert.strictEqual(pageSource("trends.js").includes("host.append("), false);

  // Trends: one row per run, oldest first, and the page-side math for win rate over time.
  const trendRows = await runQuery(db, "trends", {});
  assert.strictEqual(trendRows.length, 2);
  assert(trendRows.every((row, i) => i === 0 || row.start_time >= trendRows[i - 1].start_time));
  const series = buildTrends(
    [1, 0, 1, 1].map((win, i) => ({ start_time: 1000 + i, character: i % 2 ? "B" : "A", win })),
    2, // "form" window: win rate of the last 2 runs
  );
  assert.deepStrictEqual(
    series.overall.map((p) => p.rate),
    [100, 50, (100 * 2) / 3, 75],
  );
  assert.deepStrictEqual(
    series.overall.map((p) => p.form),
    [100, 50, 50, 100],
  );
  assert.deepStrictEqual(
    series.characters.map((c) => [c.character, c.n, c.wins, c.points.at(-1).rate, c.points.at(-1).form]),
    [["A", 2, 2, 100, 100], ["B", 2, 1, 50, 50]],
  );
  assert.strictEqual(buildTrends([]).total, 0);

  // Trends' top 5 cards / relics: enough runs to count, best win rate first, ties to the bigger sample.
  {
    const { topWinRates, TOP_MIN_RUNS } = require("../public/trends");
    const row = (card, runs, wins) => ({ card, runs, wins, win_pct: Math.round((1000 * wins) / runs) / 10 });
    const rows = [
      row("CARD.LUCKY", 1, 1), // 100%, but only one run: left out
      row("CARD.A", 10, 8), row("CARD.B", 20, 16), row("CARD.C", 6, 3),
      row("CARD.D", 5, 4), row("CARD.E", 9, 1), row("CARD.F", 12, 6), row("CARD.G", 7, 7),
    ];
    assert.strictEqual(TOP_MIN_RUNS, 5);
    assert.deepStrictEqual(
      topWinRates(rows, "card").map((r) => r.card),
      ["CARD.G", "CARD.B", "CARD.A", "CARD.D", "CARD.F"],
    );
    assert.deepStrictEqual(topWinRates(rows, "card", 10).map((r) => r.card), ["CARD.B", "CARD.A", "CARD.F"]);
    assert.deepStrictEqual(topWinRates([], "card"), []);
    assert.deepStrictEqual(topWinRates(null, "relic"), []);
  }
  const tabList = JSON.parse((await dispatch(createHandler(db), "/api/tabs")).body);
  assert.strictEqual(tabList.find((tab) => tab.id === "trends").kind, "trends");
  assert.strictEqual(tabList.find((tab) => tab.id === "characters").kind, "table");

  // The Characters tab always lists characters in the fixed display order.
  const orderDb = await openDb(":memory:");
  await orderDb.batch(
    ["DEFECT", "FOOL", "NECROBINDER", "REGENT", "SILENT", "IRONCLAD", "NEWGUY"].map(
      (name, i) => ({
        sql: "INSERT INTO runs (run_id, character, win) VALUES (?,?,?)",
        args: [`o${i}`, `CHARACTER.${name}`, 0],
      }),
    ),
    "write",
  );
  assert.deepStrictEqual(
    (await runQuery(orderDb, "characters", {})).map((row) =>
      row.character.replace("CHARACTER.", ""),
    ),
    ["IRONCLAD", "SILENT", "REGENT", "NECROBINDER", "DEFECT", "FOOL", "NEWGUY"],
  );
  await orderDb.close();

  const tabs = await dispatch(handler, "/api/tabs");
  const visibleTabs = JSON.parse(tabs.body).map((tab) => tab.id);
  assert(!visibleTabs.includes("events"));
  assert(!visibleTabs.includes("event_choices"));
  assert.strictEqual(
    (await dispatch(handler, "/api/import", "POST", [makeRun({ seed: "D" })]))
      .status,
    401,
  );
  assert.strictEqual(
    (
      await dispatch(handler, "/api/register", "POST", {
        username: "short-password",
        password: "abcdefg", // 7: new passwords need 8
      })
    ).status,
    400,
  );
  const registered = await dispatch(handler, "/api/register", "POST", {
    username: "alice",
    password: "abcdefgh",
  });
  assert.strictEqual(registered.status, 200);
  const aliceCookie = registered.headers["Set-Cookie"].split(";")[0];
  const me = await dispatch(
    handler,
    "/api/me",
    "GET",
    undefined,
    undefined,
    aliceCookie,
  );
  assert.strictEqual(JSON.parse(me.body).profile.username, "alice");
  assert.strictEqual(
    (
      await dispatch(handler, "/api/register", "POST", {
        username: "Alice",
        password: "another-secure-password",
      })
    ).status,
    409,
  );
  const imported = await dispatch(
    handler,
    "/api/import",
    "POST",
    [makeRun({ seed: "D" })],
    undefined,
    aliceCookie,
  );
  assert.strictEqual(imported.status, 200);
  assert.strictEqual(JSON.parse(imported.body).imported, 1);
  const repeated = await dispatch(
    handler,
    "/api/import",
    "POST",
    [makeRun({ seed: "D" })],
    undefined,
    aliceCookie,
  );
  assert.strictEqual(JSON.parse(repeated.body).duplicate, 1);
  assert.strictEqual(
    (await dispatch(handler, "/api/stats/overview?scope=profile")).status,
    401,
  );
  assert.strictEqual(
    JSON.parse(
      (
        await dispatch(
          handler,
          "/api/stats/overview?scope=profile",
          "GET",
          undefined,
          undefined,
          aliceCookie,
        )
      ).body,
    )[0].runs,
    1,
  );
  // Alice's run can't be added to another profile (its id is public, so anyone could forge the file).
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "D" }), profileId)).status,
    "duplicate",
  );
  const status = await dispatch(handler, "/api/index?route=status");
  assert.strictEqual(JSON.parse(status.body).runs, 3);
  assert.strictEqual(
    (await runQuery(db, "overview", { profileId }))[0].runs,
    2,
  );
  assert.strictEqual(
    (await dispatch(handler, "/api/sql", "POST", { sql: "SELECT * FROM runs" }))
      .status,
    401,
  );
  assert.strictEqual((await dispatch(handler, "/api/export")).status, 401);
  // The export holds everything needed to rebuild the data, but never passwords or sessions.
  {
    const exported = await dispatch(handler, "/api/export", "GET", undefined, "smoke-test-token");
    assert.strictEqual(exported.status, 200);
    const dump = JSON.parse(exported.body);
    for (const table of ["runs", "run_acts", "profiles", "profile_runs", "run_players", "steam_names"])
      assert.ok(Array.isArray(dump[table]), `export includes ${table}`);
    assert.ok(dump.profiles.length >= 1);
    assert.ok(dump.profiles.every((p) => !("password_hash" in p) && !("password_salt" in p)));
    assert.ok(!("profile_sessions" in dump));
  }
  // The admin SQL endpoint never shows password hashes or sessions, even with the key.
  {
    const sql = (query) => dispatch(handler, "/api/sql", "POST", { sql: query }, "smoke-test-token");
    assert.strictEqual((await sql("SELECT password_hash FROM profiles")).status, 400);
    assert.strictEqual((await sql("SELECT * FROM profile_sessions")).status, 400);
    const everything = await sql("SELECT * FROM profiles");
    assert.strictEqual(everything.status, 200);
    const rows = JSON.parse(everything.body);
    assert.ok(rows.length && rows.every((p) => p.username && !("password_hash" in p) && !("password_salt" in p)));
  }

  // Profile search and viewing another player's public stats.
  const found = JSON.parse(
    (await dispatch(handler, "/api/profiles?q=ali")).body,
  );
  assert.deepStrictEqual(
    found.map((p) => p.username),
    ["alice"],
  );
  assert.deepStrictEqual(
    JSON.parse((await dispatch(handler, "/api/profiles?q=%25")).body),
    [],
  );
  // Matches anywhere in the name, and an empty search lists active players.
  assert.deepStrictEqual(
    JSON.parse((await dispatch(handler, "/api/profiles?q=lic")).body).map(
      (p) => p.username,
    ),
    ["alice"],
  );
  const top = JSON.parse((await dispatch(handler, "/api/profiles")).body);
  assert(top.length >= 2 && top[0].runs >= top[top.length - 1].runs);
  const aliceId = found[0].id;
  // Recent runs say who played each run, as "id:name" pairs the page turns into links.
  const recent = await runQuery(db, "recent_runs", {});
  const withAlice = recent.find((row) => String(row.player).includes(":alice"));
  assert(withAlice, "a recent run lists alice as a player");
  assert(
    (await runQuery(db, "recent_runs", { profileId: aliceId })).every((row) =>
      String(row.player).includes(":alice"),
    ),
  );

  // Abandoned runs count as losses everywhere (so quitting can't dodge a loss), even if the file
  // says otherwise; only "Killed by" leaves them out, and Recent runs labels them.
  const aliceOverview = async () =>
    JSON.parse((await dispatch(handler, `/api/stats/overview?scope=profile&profileId=${aliceId}`)).body)[0];
  const before = await aliceOverview();
  const abandoned = { ...makeRun({ seed: "ABANDONED", start: 1794700000, win: true }), was_abandoned: true };
  const abandonedImport = await dispatch(handler, "/api/import", "POST", [abandoned], undefined, aliceCookie);
  assert.strictEqual(JSON.parse(abandonedImport.body).abandoned, 1);
  const after = await aliceOverview();
  assert.strictEqual(after.abandoned, 1);
  assert.strictEqual(after.runs, before.runs + 1, "counted as a run");
  assert.strictEqual(after.wins, before.wins, "and as a loss, though the file said win");
  assert.strictEqual(
    JSON.parse((await dispatch(handler, "/api/profiles?q=alice")).body)[0].runs,
    before.runs + 1,
  );
  assert.strictEqual(
    JSON.parse((await dispatch(handler, `/api/status?scope=profile&profileId=${aliceId}`)).body).runs,
    before.runs + 1,
  );
  const abandonedRow = (await runQuery(db, "recent_runs", { profileId: aliceId })).find((r) => r.result === "ABANDONED");
  assert.ok(abandonedRow, "Recent runs labels it ABANDONED");
  assert.strictEqual(abandonedRow.killed_by, null, "quitting isn't dying");
  const deaths = async () =>
    (await runQuery(db, "killed_by", { profileId: aliceId })).reduce((n, k) => n + k.deaths, 0);
  const deathsBefore = await deaths();
  assert.strictEqual(deathsBefore, after.runs - after.wins - after.abandoned, "an abandon outside a fight has no killer");

  // Quitting during a fight counts as being killed by it (the game records that fight as killed_by).
  const quitMidFight = {
    ...makeRun({ seed: "QUIT_FIGHT", start: 1794800000 }),
    was_abandoned: true,
    killed_by_encounter: "ENCOUNTER.QUIT_HERE_ELITE",
  };
  await dispatch(handler, "/api/import", "POST", [quitMidFight], undefined, aliceCookie);
  const killedBy = await runQuery(db, "killed_by", { profileId: aliceId });
  assert.ok(killedBy.some((k) => k.killed_by === "ENCOUNTER.QUIT_HERE_ELITE"));
  assert.strictEqual(await deaths(), deathsBefore + 1);
  const quitRow = (await runQuery(db, "recent_runs", { profileId: aliceId })).find((r) => r.killed_by === "ENCOUNTER.QUIT_HERE_ELITE");
  assert.strictEqual(quitRow.result, "ABANDONED");

  // The Abandoned card's switch leaves abandons out of every stat, but the card still shows how many.
  const counted = await aliceOverview();
  const excluded = JSON.parse(
    (await dispatch(handler, `/api/stats/overview?scope=profile&profileId=${aliceId}&abandoned=exclude`)).body,
  )[0];
  assert.strictEqual(counted.abandoned, 2);
  assert.strictEqual(excluded.abandoned, 2, "the card shows the number either way");
  assert.strictEqual(excluded.runs, counted.runs - 2);
  assert.strictEqual(excluded.wins, counted.wins);
  const recentExcluded = await runQuery(db, "recent_runs", { profileId: aliceId, abandoned: "exclude" });
  assert.ok(recentExcluded.every((r) => r.result !== "ABANDONED"));
  assert.strictEqual(
    (await runQuery(db, "killed_by", { profileId: aliceId, abandoned: "exclude" })).reduce((n, k) => n + k.deaths, 0),
    deathsBefore,
  );
  // Anything but "exclude" counts them (the default).
  assert.strictEqual(
    JSON.parse((await dispatch(handler, `/api/stats/overview?scope=profile&profileId=${aliceId}&abandoned=bogus`)).body)[0].runs,
    counted.runs,
  );
  assert.strictEqual(
    (await dispatch(handler, "/api/stats/overview?scope=profile&profileId=9999"))
      .status,
    404,
  );
  assert.strictEqual(
    (await dispatch(handler, "/api/stats/overview?ascension=abc")).status,
    200,
  );

  // Bad input is a client error, never a crash.
  assert.strictEqual(
    (await dispatch(handler, "/api/import", "POST", [{ players: [{}] }], undefined, aliceCookie)).status,
    200,
  );

  // Rate limiting: repeated failed sign-ins lock the username out.
  for (let i = 1; i <= 8; i++) {
    const attempt = await dispatch(handler, "/api/login", "POST", {
      username: "alice",
      password: "wrong-password",
    });
    assert.strictEqual(attempt.status, 401, `attempt ${i}`);
  }
  const locked = await dispatch(handler, "/api/login", "POST", {
    username: "alice",
    password: "abcdefgh",
  });
  assert.strictEqual(locked.status, 429);
  assert(Number(locked.headers["Retry-After"]) > 0);

  // A successful sign-in clears the failure counter.
  await dispatch(handler, "/api/register", "POST", {
    username: "carol",
    password: "abcdefgh",
  });
  for (let i = 0; i < 5; i++) {
    await dispatch(handler, "/api/login", "POST", {
      username: "carol",
      password: "nope-nope",
    });
  }
  assert.strictEqual(
    (
      await dispatch(handler, "/api/login", "POST", {
        username: "carol",
        password: "abcdefgh",
      })
    ).status,
    200,
  );
  for (let i = 0; i < 5; i++) {
    await dispatch(handler, "/api/login", "POST", {
      username: "carol",
      password: "nope-nope",
    });
  }
  assert.strictEqual(
    (
      await dispatch(handler, "/api/login", "POST", {
        username: "carol",
        password: "abcdefgh",
      })
    ).status,
    200,
  );

  // Limiter unit behaviour: window counts, then rejects with Retry-After.
  const limiter = createRateLimiter(db);
  await limiter.hit("unit", 2, 60000);
  await limiter.hit("unit", 2, 60000);
  await assert.rejects(
    () => limiter.hit("unit", 2, 60000),
    (error) => error.status === 429 && Boolean(error.headers["Retry-After"]),
  );
  await limiter.reset("unit");
  await limiter.hit("unit", 2, 60000);

  // Personal achievements.
  {
    const chars = ["CHARACTER.IRONCLAD", "CHARACTER.SILENT", "CHARACTER.DEFECT"];
    const run = (character, ascension, win, run_time = 1800) => ({ character, ascension, win, run_time });
    const byId = (runs) => Object.fromEntries(computeAchievements(runs, chars).map((b) => [b.id, b]));
    // Every character beaten on A10, but a loss and a lower ascension win break the streak.
    let badges = byId([
      run(chars[0], 10, 1), run(chars[1], 10, 1), run(chars[2], 10, 0),
      run(chars[2], 10, 1), run(chars[0], 9, 1), run(chars[1], 10, 1), run(chars[0], 10, 1, 1200),
    ]);
    assert.strictEqual(badges.all_a10.earned, true);
    assert.strictEqual(badges.rotating_streak.earned, false);
    assert.strictEqual(badges.rotating_streak.characters.length, 2);
    assert.strictEqual(badges.speedrunner.earned, false, "exactly 20:00 is not under 20 minutes");
    assert.strictEqual(badges.speedrunner.progress, "Fastest win: 20:00");
    // A repeated character inside the streak doesn't count twice: I, S, I, D is at best S, I, D.
    badges = byId([run(chars[0], 10, 1), run(chars[1], 10, 1), run(chars[0], 10, 1), run(chars[2], 10, 1)]);
    assert.strictEqual(badges.rotating_streak.earned, true);
    // I, I, S is only two different characters in a row (the second Ironclad restarts it).
    badges = byId([run(chars[0], 10, 1), run(chars[0], 10, 1), run(chars[1], 10, 1)]);
    assert.strictEqual(badges.rotating_streak.earned, false);
    assert.strictEqual(badges.rotating_streak.characters.length, 2);
    // S, I, S, I never holds all three, however long the streak.
    badges = byId([run(chars[1], 10, 1), run(chars[0], 10, 1), run(chars[1], 10, 1), run(chars[0], 10, 1)]);
    assert.strictEqual(badges.rotating_streak.earned, false);
    // Three different characters back to back, and a fast win on a low ascension.
    badges = byId([
      run(chars[0], 3, 1, 1199), run(chars[2], 10, 1), run(chars[0], 10, 1), run(chars[1], 10, 1),
    ]);
    assert.strictEqual(badges.rotating_streak.earned, true);
    assert.strictEqual(badges.speedrunner.earned, true);
    // No runs, or a fast loss, earns nothing.
    badges = byId([run(chars[0], 10, 0, 300)]);
    assert.ok(Object.values(badges).every((b) => !b.earned));
    assert.strictEqual(badges.speedrunner.progress, "No wins yet");
    // The endpoint needs a signed-in player (or a profile id) and asks for every character in game-data.js,
    // whatever has been imported (so an import of a new character can't take badges away).
    assert.strictEqual((await dispatch(handler, "/api/achievements?scope=profile")).status, 401);
    const mine = await dispatch(handler, "/api/achievements?scope=profile", "GET", undefined, undefined, aliceCookie);
    assert.strictEqual(mine.status, 200);
    const body = JSON.parse(mine.body);
    assert.deepStrictEqual(body.badges.map((b) => b.name), ["All A10", "Rotating Streak", "Speedrunner"]);
    assert.deepStrictEqual(
      body.characters,
      GAME_DATA.characters.map((c) => `CHARACTER.${c.id}`),
    );
    assert.strictEqual((await dispatch(handler, "/api/achievements")).status, 400);
    // Anyone can look at a player's badges by profile id, signed in or not (they are shared like the
    // player's statistics, so the shared cache may keep them), but not at one that doesn't exist.
    const theirs = await dispatch(handler, `/api/achievements?scope=profile&profileId=${body.profile.id}`);
    assert.strictEqual(theirs.status, 200);
    assert.deepStrictEqual(JSON.parse(theirs.body), body);
    assert.match(theirs.headers["Cache-Control"], /s-maxage/);
    assert.ok(!/s-maxage/.test(mine.headers["Cache-Control"]), "my own badges depend on who is signed in");
    assert.strictEqual((await dispatch(handler, "/api/achievements?scope=profile&profileId=99999")).status, 404);
  }

  // Earned badges are kept when the requirement grows, marked outdated; earning it again clears that.
  {
    const { profileAchievements } = require("../lib/achievements");
    const bDb = await openDb(":memory:");
    const p = Number(
      (await bDb.execute({
        sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('vet','s','h',0)",
      })).lastInsertRowid,
    );
    const all = GAME_DATA.characters.map((c) => `CHARACTER.${c.id}`);
    const addWin = async (i, character) => {
      await bDb.batch([
        { sql: "INSERT INTO runs (run_id, character, ascension, win, run_time, start_time) VALUES (?,?,10,1,1800,?)", args: [`w${i}`, character, i] },
        { sql: "INSERT INTO profile_runs (profile_id, run_id, created_at) VALUES (?,?,0)", args: [p, `w${i}`] },
      ], "write");
    };
    // Won with every character but the last, and earned All A10 back when the last didn't exist yet.
    for (const [i, c] of all.slice(0, -1).entries()) await addWin(i, c);
    await bDb.execute({
      sql: "INSERT INTO profile_badges (profile_id, badge_id, earned_at, characters, ascension) VALUES (?, 'all_a10', 1, ?, 10)",
      args: [p, JSON.stringify(all.slice(0, -1))],
    });
    let result = Object.fromEntries((await profileAchievements(bDb, p)).badges.map((b) => [b.id, b]));
    assert.strictEqual(result.all_a10.earned, true, "kept");
    assert.strictEqual(result.all_a10.outdated, true);
    const lastName = GAME_DATA.characters.at(-1).name;
    assert.ok(result.all_a10.outdatedNote.includes(`${lastName} has been added`), result.all_a10.outdatedNote);
    assert.strictEqual(result.all_a10.earnedAt, 1);
    assert.strictEqual(result.rotating_streak.earned, false, "never earned, so nothing to keep");
    // A newly earned badge is recorded, and stays earned (not outdated) under today's rule.
    await addWin(99, all.at(-1));
    result = Object.fromEntries((await profileAchievements(bDb, p)).badges.map((b) => [b.id, b]));
    assert.strictEqual(result.all_a10.earned, true);
    assert.ok(!result.all_a10.outdated);
    assert.strictEqual(result.rotating_streak.earned, true);
    const saved = await bDb.execute({ sql: "SELECT COUNT(*) n FROM profile_badges WHERE profile_id = ?", args: [p] });
    assert.strictEqual(Number(saved.rows[0].n), 2);

    // Abandoning a run that's about to be lost breaks a streak like losing it. A streak kept only by
    // skipping abandons (the old rule) stays earned, marked outdated for that reason.
    const q = Number(
      (await bDb.execute("INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('quitter','s','h',0)")).lastInsertRowid,
    );
    let played = 0; // start times in the order the runs are added
    const addRun = async (i, character, abandonedRun) =>
      bDb.batch([
        {
          sql: "INSERT INTO runs (run_id, character, ascension, win, abandoned, run_time, start_time) VALUES (?,?,10,?,?,1800,?)",
          args: [`q${i}`, character, abandonedRun ? 0 : 1, abandonedRun ? 1 : 0, ++played],
        },
        { sql: "INSERT INTO profile_runs (profile_id, run_id, created_at) VALUES (?,?,0)", args: [q, `q${i}`] },
      ], "write");
    for (const [i, character] of all.entries()) {
      if (i === 2) await addRun(100 + i, character, true); // quit a doomed run mid-streak
      await addRun(i, character, false);
    }
    result = Object.fromEntries((await profileAchievements(bDb, q)).badges.map((b) => [b.id, b]));
    assert.strictEqual(result.all_a10.earned, true, "every character still won at A10");
    assert.strictEqual(result.rotating_streak.earned, false, "the abandon broke the streak");
    await bDb.execute({
      sql: "INSERT INTO profile_badges (profile_id, badge_id, earned_at, characters, ascension) VALUES (?, 'rotating_streak', 1, ?, 10)",
      args: [q, JSON.stringify(all)],
    });
    result = Object.fromEntries((await profileAchievements(bDb, q)).badges.map((b) => [b.id, b]));
    assert.strictEqual(result.rotating_streak.earned, true, "kept");
    assert.strictEqual(result.rotating_streak.outdated, true);
    assert.match(result.rotating_streak.outdatedNote, /abandoned runs count as losses/);
    await bDb.close();
  }

  // Multiplayer runs: stored from the uploader's side, filtered by mode, with teammates listed.
  {
    const mpDb = await openDb(":memory:");
    const mpApi = createHandler(mpDb);
    // Imports look up teammates' Steam names; the tests must never reach the real Steam.
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    const ME = "76561198000000001";
    const MATE = "76561198000000002";
    const OTHER = "76561198000000003";
    const coop = (seed, win, mate = MATE) => {
      const run = makeRun({ seed, win, players: 2 });
      run.players = [
        { ...run.players[0], id: mate, character: "CHARACTER.SILENT", deck: [{ id: "CARD.FLANKING", floor_added_to_deck: 2 }] },
        { ...run.players[1], id: ME, character: "CHARACTER.IRONCLAD", deck: [{ id: "CARD.TAG_TEAM", floor_added_to_deck: 2 }] },
      ];
      for (const act of run.map_point_history)
        for (const mp of act) {
          const stats = mp.player_stats[0] || {};
          mp.player_stats = [
            { ...stats, player_id: mate, damage_taken: 1, card_choices: [] },
            { ...stats, player_id: ME, damage_taken: 9 },
          ];
        }
      return run;
    };
    const register = await dispatch(mpApi, "/api/register", "POST", { username: "duo", password: "abcdefgh" });
    const cookie = register.headers["Set-Cookie"].split(";")[0];
    const imports = async (body) =>
      JSON.parse((await dispatch(mpApi, "/api/import", "POST", body, undefined, cookie)).body);

    // One multiplayer run alone doesn't say which player you are, so it is skipped...
    assert.strictEqual((await imports([coop("M1", true)])).multiplayer, 1);
    // ...but the Steam id from the folder path is enough, and is remembered on the profile.
    let result = await imports({ runs: [coop("M1", true), makeRun({ seed: "S1" })], playerId: ME });
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.coop, 1);
    result = await imports([coop("M2", false), coop("M3", false, OTHER)]);
    assert.strictEqual(result.imported, 2);
    // A Steam id that lost precision as a JS number is refused rather than stored wrong.
    assert.strictEqual(require("../lib/multiplayer").steamId(76561198000000001), null);

    const row = (await mpDb.execute("SELECT * FROM runs WHERE seed = 'M1'")).rows[0];
    assert.strictEqual(row.character, "CHARACTER.IRONCLAD");
    assert.strictEqual(Number(row.player_count), 2);
    assert.strictEqual(row.run_id, `M1:1794596230:${ME}`);
    const myDamage = await mpDb.execute({ sql: "SELECT DISTINCT damage FROM fights WHERE run_id = ?", args: [row.run_id] });
    assert.deepStrictEqual(myDamage.rows.map((r) => Number(r.damage)), [9]);

    // Multiplayer stats belong to a profile; the combined Everyone view is always solo, without teammates.
    const duoId = JSON.parse(register.body).profile.id;
    const everyone = async (path) => JSON.parse((await dispatch(mpApi, `/api/stats/${path}`)).body);
    assert.strictEqual((await everyone("overview?mode=multi"))[0].runs, 1, "Everyone ignores Mode");
    assert.strictEqual((await everyone("overview?mode=all"))[0].runs, 1);
    assert.deepStrictEqual(await everyone("teammates"), []);
    const stat = async (path) =>
      JSON.parse(
        (await dispatch(mpApi, `/api/stats/${path}${path.includes("?") ? "&" : "?"}scope=profile&profileId=${duoId}`)).body,
      );
    assert.strictEqual((await stat("overview"))[0].runs, 1); // solo is the default
    assert.strictEqual((await stat("overview?mode=multi"))[0].runs, 3);
    assert.strictEqual((await stat("overview?mode=all"))[0].runs, 4);
    assert.strictEqual((await stat("overview?mode=bogus"))[0].runs, 1);
    const cards = (await stat("card_win_rate?mode=multi")).map((r) => r.card);
    assert.ok(cards.includes("CARD.TAG_TEAM") && !cards.includes("CARD.FLANKING"));

    const mates = await stat("teammates");
    assert.deepStrictEqual(
      mates.map((m) => [m.teammate, m.runs, m.win_pct, m.played_as]),
      [[`${MATE}||`, 2, 50, "CHARACTER.SILENT"], [`${OTHER}||`, 1, 0, "CHARACTER.SILENT"]],
    );
    const recent = await stat("recent_runs?mode=multi");
    const m1 = recent.find((r) => r.result === "WIN");
    assert.strictEqual(m1.teammates, `${MATE}|||CHARACTER.SILENT|1|2`);
    assert.ok((await stat("recent_runs")).every((r) => r.teammates === null));

    // Once the teammate has a profile with their Steam id, they show by name.
    await mpDb.execute({
      sql: "INSERT INTO profiles (username, password_salt, password_hash, created_at, steam_id) VALUES ('mate','s','h',0,?)",
      args: [MATE],
    });
    assert.match((await stat("teammates"))[0].teammate, new RegExp(`^${MATE}\\|\\d+\\|mate$`));
    assert.strictEqual((await mpDb.execute("SELECT steam_id FROM profiles WHERE username = 'duo'")).rows[0].steam_id, ME);
    // Steam names: looked up once, kept in the database, and only for ids that appear in run_players.
    {
      const realFetch = global.fetch;
      const asked = [];
      await mpDb.execute("DELETE FROM steam_names"); // the offline imports above stamped failed lookups
      global.fetch = async (url) => {
        asked.push(String(url));
        const id = String(url).match(/profiles\/(\d+)/)?.[1];
        return { ok: true, text: async () => `<profile><steamID><![CDATA[Team Mate ${id.slice(-2)}]]></steamID></profile>` };
      };
      try {
        const names = async (ids) => JSON.parse((await dispatch(mpApi, `/api/steam-names?ids=${ids}`)).body);
        assert.deepStrictEqual(await names(`${OTHER},76561198999999999,abc`), { [OTHER]: "Team Mate 03" });
        assert.strictEqual(asked.length, 1); // the stranger and the junk id were never looked up
        assert.deepStrictEqual(await names(OTHER), { [OTHER]: "Team Mate 03" });
        assert.strictEqual(asked.length, 1); // second time comes from the database
        global.fetch = async () => {
          throw new Error("offline");
        };
        await mpDb.execute({ sql: "UPDATE steam_names SET fetched_at = 0 WHERE steam_id = ?", args: [OTHER] });
        assert.deepStrictEqual(await names(OTHER), { [OTHER]: "Team Mate 03" }); // keeps the old name when Steam is down
      } finally {
        global.fetch = realFetch;
      }
    }
    global.fetch = originalFetch;
    await mpDb.close();
  }

  // Account creation is limited per network address.
  let lastStatus;
  for (let i = 0; i < 12; i++) {
    lastStatus = (
      await dispatch(handler, "/api/register", "POST", {
        username: `bulk${i}`,
        password: "abcdefgh",
      })
    ).status;
  }
  assert.strictEqual(lastStatus, 429);

  // Changing a password and deleting an account.
  {
    const accDb = await openDb(":memory:");
    const acc = createHandler(accDb);
    const cookieOf = (res) => res.headers["Set-Cookie"].split(";")[0];
    const register = (username) =>
      dispatch(acc, "/api/register", "POST", { username, password: "first-pass" });
    let bob = cookieOf(await register("bob"));
    const carol = cookieOf(await register("carol"));
    const importAs = (cookie, runs) => dispatch(acc, "/api/import", "POST", runs, undefined, cookie);
    await importAs(bob, [makeRun({ seed: "BOB_ONLY" }), makeRun({ seed: "SHARED" })]);
    // Carol can't add bob's run by importing it; a run shared from before that rule is linked directly.
    assert.strictEqual(JSON.parse((await importAs(carol, [makeRun({ seed: "SHARED" })])).body).duplicate, 1);
    await accDb.execute(
      "INSERT INTO profile_runs (profile_id, run_id, created_at) SELECT profile_id, (SELECT run_id FROM runs WHERE seed = 'SHARED'), 0 FROM profiles WHERE username = 'carol'",
    );
    const post = (path, body, cookie) => dispatch(acc, path, "POST", body, undefined, cookie);
    const whoAmI = async (cookie) =>
      JSON.parse((await dispatch(acc, "/api/me", "GET", undefined, undefined, cookie)).body).profile;

    // Password change: the current password is checked, the new one must be valid, and old sessions end.
    assert.strictEqual((await post("/api/password", { currentPassword: "x", newPassword: "second-pass" })).status, 401);
    assert.strictEqual((await post("/api/password", { currentPassword: "wrong", newPassword: "second-pass" }, bob)).status, 401);
    assert.strictEqual((await post("/api/password", { currentPassword: "first-pass", newPassword: "abc" }, bob)).status, 400);
    const changed = await post("/api/password", { currentPassword: "first-pass", newPassword: "second-pass" }, bob);
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(await whoAmI(bob), null, "the old session is signed out");
    bob = cookieOf(changed);
    assert.strictEqual((await whoAmI(bob)).username, "bob");
    assert.strictEqual((await post("/api/login", { username: "bob", password: "first-pass" })).status, 401);
    assert.strictEqual((await post("/api/login", { username: "bob", password: "second-pass" })).status, 200);

    // Deleting: needs the password; removes bob, his own runs and their rows, but not a run carol also has.
    assert.strictEqual((await post("/api/delete-account", { password: "first-pass" }, bob)).status, 401);
    assert.strictEqual((await post("/api/delete-account", { password: "second-pass" }, bob)).status, 200);
    assert.strictEqual(await whoAmI(bob), null);
    const count = async (sql) => Number((await accDb.execute(sql)).rows[0].n);
    assert.strictEqual(await count("SELECT COUNT(*) n FROM profiles WHERE username = 'bob'"), 0);
    assert.strictEqual(await count("SELECT COUNT(*) n FROM runs WHERE seed = 'BOB_ONLY'"), 0);
    assert.strictEqual(await count("SELECT COUNT(*) n FROM run_cards WHERE run_id LIKE 'BOB_ONLY:%'"), 0);
    assert.strictEqual(await count("SELECT COUNT(*) n FROM runs WHERE seed = 'SHARED'"), 1);
    assert.strictEqual(await count("SELECT COUNT(*) n FROM profile_runs"), 1, "only carol's link is left");
    assert.strictEqual((await whoAmI(carol)).username, "carol");
    await accDb.close();
  }

  // Security: a forged file can't claim or change someone else's run, broken files are refused, a
  // Steam id can't be taken from another profile, failed sign-ins can't lock a player out from
  // elsewhere, and a profile can only hold so many runs.
  {
    const secDb = await openDb(":memory:");
    const sec = createHandler(secDb);
    const signUp = async (username) =>
      (await dispatch(sec, "/api/register", "POST", { username, password: "long-enough" })).headers["Set-Cookie"].split(";")[0];
    const victim = await signUp("victim");
    const thief = await signUp("thief");
    const importAs = async (cookie, body) =>
      JSON.parse((await dispatch(sec, "/api/import", "POST", body, undefined, cookie)).body);
    const snapshot = async () => {
      const rows = {};
      for (const table of ["runs", "run_acts", "run_cards", "run_relics", "run_rooms", "run_players"])
        rows[table] = (await secDb.execute(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map((r) => JSON.stringify(r));
      return rows;
    };

    // An older run with no run page yet: the case a re-import used to fill in (rooms, deck, ending).
    assert.strictEqual((await importAs(victim, [makeRun({ seed: "VICTIMWIN", win: true })])).imported, 1);
    await secDb.batch(["DELETE FROM run_rooms", "UPDATE runs SET game_mode = NULL"], "write");
    const before = await snapshot();
    const forged = makeRun({ seed: "VICTIMWIN", win: true, character: "CHARACTER.SILENT" });
    forged.players[0].deck = [{ id: "CARD.FORGED", floor_added_to_deck: 1 }];
    forged.players[0].relics = [{ id: "RELIC.FORGED", floor_added_to_deck: 3 }];
    forged.map_point_history.push(forged.map_point_history[0]);
    const attempt = await importAs(thief, [forged]);
    assert.strictEqual(attempt.duplicate, 1);
    assert.strictEqual(attempt.imported, 0);
    assert.deepStrictEqual(await snapshot(), before, "the victim's run is unchanged");
    const thiefRuns = await secDb.execute(
      "SELECT COUNT(*) n FROM profile_runs pr JOIN profiles p USING (profile_id) WHERE p.username = 'thief'",
    );
    assert.strictEqual(Number(thiefRuns.rows[0].n), 0, "the win isn't added to the thief's profile");
    // The owner can still fill in their own older run.
    await importAs(victim, [makeRun({ seed: "VICTIMWIN", win: true })]);
    assert.ok(Number((await secDb.execute("SELECT COUNT(*) n FROM run_rooms")).rows[0].n) > 0);

    // Files no game would write are refused.
    const broken = [
      { ...makeRun({ seed: "ASC" }), ascension: 99 },
      { ...makeRun({ seed: "NEG" }), ascension: -1 },
      makeRun({ seed: "FUTURE", start: Math.floor(Date.now() / 1000) + 30 * 86400 }),
      makeRun({ seed: "ANCIENT", start: 1000 }),
      { ...makeRun({ seed: "SLOW" }), run_time: 30 * 86400 },
      makeRun({ seed: "ODD", character: "<img src=x>" }),
      makeRun({ seed: "bad seed!" }),
      { ...makeRun({ seed: "HUGE" }), players: Array.from({ length: 9 }, () => makeRun({ seed: "x" }).players[0]) },
    ];
    broken[7].players.forEach((p, i) => (p.id = `7656119800000${String(i).padStart(4, "0")}`));
    assert.strictEqual((await importAs(thief, broken)).invalid, broken.length);

    // A Steam id already on one profile can't be claimed by another through the folder path.
    const STEAM = "76561198000000042";
    const coopRun = (seed) => {
      const run = makeRun({ seed, players: 2 });
      run.players = [
        { ...run.players[0], id: STEAM },
        { ...run.players[1], id: "76561198000000043" },
      ];
      return run;
    };
    assert.strictEqual((await importAs(victim, { runs: [coopRun("CO1")], playerId: STEAM })).imported, 1);
    assert.strictEqual((await importAs(thief, { runs: [coopRun("CO2")], playerId: STEAM })).multiplayer, 1);
    // Teammates who both import the same co-op run each get it: every player's copy has its own id.
    const mate = await signUp("teammate");
    assert.strictEqual((await importAs(mate, { runs: [coopRun("CO1")], playerId: "76561198000000043" })).imported, 1);
    const coRows = await secDb.execute(
      "SELECT pr.run_id, p.username FROM profile_runs pr JOIN profiles p USING (profile_id) WHERE pr.run_id LIKE 'CO1:%' ORDER BY 2",
    );
    assert.deepStrictEqual(
      coRows.rows.map((r) => [r.username, r.run_id.split(":")[2]]),
      [["teammate", "76561198000000043"], ["victim", STEAM]],
    );
    const steamIds = await secDb.execute("SELECT username, steam_id FROM profiles ORDER BY username");
    assert.deepStrictEqual(
      steamIds.rows.map((r) => [r.username, r.steam_id]),
      [["teammate", "76561198000000043"], ["thief", null], ["victim", STEAM]],
    );

    // Failing sign-ins from one network locks only that network out of the account.
    const login = (password, ip) => dispatch(sec, "/api/login", "POST", { username: "victim", password }, undefined, undefined, ip);
    for (let i = 0; i < 8; i++) assert.strictEqual((await login("wrong-guess", "10.0.0.66")).status, 401);
    assert.strictEqual((await login("long-enough", "10.0.0.66")).status, 429);
    assert.strictEqual((await login("long-enough", "10.0.0.7")).status, 200, "the real player still gets in");

    // A profile that is full can't import more. (The filler links point at no real run.)
    await secDb.execute("PRAGMA foreign_keys = OFF");
    await secDb.execute(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
      INSERT INTO profile_runs (profile_id, run_id, created_at)
      SELECT (SELECT profile_id FROM profiles WHERE username = 'thief'), 'filler' || i, 0 FROM n`);
    assert.strictEqual(
      (await dispatch(sec, "/api/import", "POST", [makeRun({ seed: "ONEMORE" })], undefined, thief)).status,
      403,
    );
    await secDb.close();
  }

  // The run page (GET /api/run): every room in order with what happened, how the run ended, the deck
  // with enchantments. Runs imported before it existed are filled in by importing them again.
  {
    const runDb = await openDb(":memory:");
    const handler = createHandler(runDb);
    const importer = createImporter(runDb);
    const run = makeRun({ seed: "RUNPAGE", win: true });
    run.game_mode = "standard";
    run.players[0].max_potion_slot_count = 3;
    run.players[0].potions = [{ id: "POTION.FIRE_POTION", slot_index: 0 }];
    run.players[0].deck[1].enchantment = { id: "ENCHANTMENT.SLITHER", amount: 1 };
    run.map_point_history[0][2].player_stats[0] = {
      ...run.map_point_history[0][2].player_stats[0],
      max_hp: 80,
      current_gold: 123,
      potion_used: ["POTION.BLOCK_POTION"],
    };
    await runDb.execute("INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('dee', 'x', 'x', 0)");
    assert.strictEqual((await importer.importRun(run, 1)).status, "imported");
    const runId = `RUNPAGE:${run.start_time}`;
    const [recent] = await runQuery(runDb, "recent_runs", {});
    assert.strictEqual(recent.run_id, runId, "Recent runs gives the page the run id");

    const page = async (id) => dispatch(handler, `/api/run?id=${encodeURIComponent(id)}`);
    const res = await page(runId);
    assert.strictEqual(res.status, 200);
    const detail = JSON.parse(res.body);
    assert.strictEqual(detail.partial, false);
    assert.deepStrictEqual(
      [detail.run.final_hp, detail.run.max_hp, detail.run.gold, detail.run.potion_slots, detail.run.potions, detail.run.game_mode],
      [10, 80, 123, 3, "POTION.FIRE_POTION", "standard"],
    );
    assert.deepStrictEqual(detail.rooms.map((r) => [r.floor, r.map_type, r.room_type]), [
      [1, "monster", "monster"],
      [2, "unknown", "event"],
      [3, "boss", "boss"],
    ]);
    // Empty parts are left out (this test room has no cards_gained list).
    assert.deepStrictEqual(detail.rooms[0].detail, { turns: 4, damage: 3, skipped: ["CARD.BLACK_HOLE"] });
    assert.deepStrictEqual(detail.rooms[1].detail.choices, ["GOLDEN_PEARL.title"]);
    assert.deepStrictEqual(detail.rooms[2].detail.potionsUsed, ["POTION.BLOCK_POTION"]);
    assert.deepStrictEqual(detail.cards.map((c) => [c.card_id, c.upgrade, c.enchantment]), [
      ["CARD.STRIKE_REGENT", 0, null],
      ["CARD.RESONANCE", 1, "ENCHANTMENT.SLITHER"],
    ]);
    assert.deepStrictEqual(detail.importers.map((p) => p.username), ["dee"]);
    assert.strictEqual((await page("NOPE:1")).status, 404);
    assert.strictEqual((await dispatch(handler, "/api/run")).status, 404);

    // An older run (no rooms, no ending, no enchantments) shows its fights and events, and says so.
    await runDb.batch([
      { sql: "DELETE FROM run_rooms", args: [] },
      { sql: "UPDATE runs SET final_hp = NULL, gold = NULL, game_mode = NULL", args: [] },
      { sql: "UPDATE run_cards SET enchantment = NULL", args: [] },
    ], "write");
    const old = JSON.parse((await page(runId)).body);
    assert.strictEqual(old.partial, true);
    assert.deepStrictEqual(old.rooms.map((r) => [r.floor, r.room_type, r.model_id]), [
      [1, "monster", "ENCOUNTER.NIBBITS_WEAK"],
      [2, "event", "EVENT.NEOW"],
      [3, "boss", "ENCOUNTER.CEREMONIAL_BEAST_BOSS"],
    ]);
    assert.strictEqual(old.rooms[1].map_type, "ancient", "Neow is an Ancient");
    // Importing it again fills everything in, without adding a second copy of the deck.
    assert.strictEqual((await importer.importRun(run, 1)).status, "duplicate");
    const filled = JSON.parse((await page(runId)).body);
    assert.strictEqual(filled.partial, false);
    assert.strictEqual(filled.rooms.length, 3);
    assert.strictEqual(filled.run.gold, 123);
    assert.deepStrictEqual(filled.cards.map((c) => c.enchantment), [null, "ENCHANTMENT.SLITHER"]);
    // A later import leaves it alone (the rooms are there now).
    assert.strictEqual((await importer.importRun(run, 1)).status, "duplicate");
    assert.strictEqual(Number((await runDb.execute("SELECT COUNT(*) n FROM run_cards")).rows[0].n), 2);
    await runDb.close();
  }

  await db.close();
  console.log("All smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
