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

async function dispatch(handler, url, method = "GET", body, token, cookie) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.url = url;
  req.method = method;
  req.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const res = createResponse();
  await handler(req, res);
  return res;
}

async function main() {
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

  // Relic source: Neow (act 1 Ancient), Ancients (acts 2 and 3) and everything else.
  const relicDb = await openDb(":memory:");
  const relicImporter = createImporter(relicDb);
  const ancientRoom = (model, picked) => ({
    map_point_type: "ancient",
    rooms: [{ room_type: "event", model_id: model }],
    player_stats: [{ relic_choices: [{ choice: picked, was_picked: true }, { choice: "RELIC.NOT_TAKEN", was_picked: false }] }],
  });
  const plainRoom = (type, model) => ({
    map_point_type: type,
    rooms: [{ room_type: type, model_id: model, monster_ids: [] }],
    player_stats: [{ current_hp: 40, damage_taken: 1 }],
  });
  const relicRun = (seed, win) => ({
    ...makeRun({ seed, win }),
    map_point_history: [
      [ancientRoom("EVENT.NEOW", "RELIC.FROM_NEOW"), plainRoom("elite", "ENCOUNTER.X")],
      [ancientRoom("EVENT.TANX", "RELIC.FROM_ANCIENT"), plainRoom("elite", "ENCOUNTER.Y")],
    ],
  });
  const relicRunData = relicRun("R1", true);
  relicRunData.players[0].relics = [
    { id: "RELIC.DIVINE_RIGHT", floor_added_to_deck: 1 }, // starting relic, same floor as Neow
    { id: "RELIC.FROM_NEOW", floor_added_to_deck: 1 },
    { id: "RELIC.FROM_ANCIENT", floor_added_to_deck: 3 },
    { id: "RELIC.FROM_ELITE", floor_added_to_deck: 4 },
  ];
  await relicDb.execute("INSERT INTO profiles (username, password_salt, password_hash, created_at) VALUES ('r', 's', 'h', 0)");
  await relicImporter.importRun(relicRunData, 1);
  const sourcesOf = async () =>
    Object.fromEntries((await relicDb.execute("SELECT relic_id, source FROM run_relics")).rows.map((r) => [r.relic_id, r.source]));
  const expectedSources = {
    "RELIC.DIVINE_RIGHT": "OTHER",
    "RELIC.FROM_NEOW": "NEOW",
    "RELIC.FROM_ANCIENT": "ANCIENT",
    "RELIC.FROM_ELITE": "OTHER",
  };
  assert.deepStrictEqual(await sourcesOf(), expectedSources);
  const relicNames = async (source) =>
    (await runQuery(relicDb, "relic_win_rate", { source })).map((r) => r.relic).sort();
  assert.deepStrictEqual(await relicNames(null), ["RELIC.FROM_ANCIENT", "RELIC.FROM_ELITE", "RELIC.FROM_NEOW"]);
  assert.deepStrictEqual(await relicNames("NEOW"), ["RELIC.FROM_NEOW"]);
  assert.deepStrictEqual(await relicNames("ANCIENT"), ["RELIC.FROM_ANCIENT"]);
  assert.deepStrictEqual(await relicNames("OTHER"), ["RELIC.FROM_ELITE"]);
  // A database from before the column existed is upgraded and its rows worked out from the events table.
  const { ensureRelicSourceColumn, backfillRelicSources } = require("../lib/relics");
  await relicDb.execute("DROP INDEX idx_relics_source");
  await relicDb.execute("ALTER TABLE run_relics DROP COLUMN source");
  await ensureRelicSourceColumn(relicDb);
  assert.ok((await backfillRelicSources(relicDb)) > 0);
  assert.deepStrictEqual(await sourcesOf(), expectedSources);
  assert.strictEqual(await backfillRelicSources(relicDb), 0);
  // The API only accepts the three source names.
  const relicApi = createHandler(relicDb);
  const apiRelics = async (q) => JSON.parse((await dispatch(relicApi, "/api/stats/relic_win_rate" + q)).body).length;
  assert.strictEqual(await apiRelics("?source=NEOW"), 1);
  assert.strictEqual(await apiRelics("?source=bogus"), 3);
  await relicDb.close();

  // Caching: shared statistics may be cached briefly, anything tied to the signed-in user never.
  const cacheApi = createHandler(await openDb(":memory:"));
  const cacheOf = async (url) => (await dispatch(cacheApi, url)).headers["Cache-Control"];
  assert.match(await cacheOf("/api/stats/characters"), /s-maxage=60/);
  assert.match(await cacheOf("/api/filters"), /s-maxage=60/);
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
        password: "abcd",
      })
    ).status,
    400,
  );
  const registered = await dispatch(handler, "/api/register", "POST", {
    username: "alice",
    password: "abcde",
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
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "D" }), profileId)).status,
    "imported",
  );
  assert.strictEqual(
    (await importer.importRun(makeRun({ seed: "D" }), profileId)).status,
    "duplicate",
  );
  const status = await dispatch(handler, "/api/index?route=status");
  assert.strictEqual(JSON.parse(status.body).runs, 3);
  assert.strictEqual(
    (await runQuery(db, "overview", { profileId }))[0].runs,
    3,
  );
  assert.strictEqual(
    (await dispatch(handler, "/api/sql", "POST", { sql: "SELECT * FROM runs" }))
      .status,
    401,
  );
  assert.strictEqual((await dispatch(handler, "/api/export")).status, 401);

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

  // Abandoned runs are stored but never counted, so every count agrees.
  const abandoned = { ...makeRun({ seed: "ABANDONED", start: 1794700000 }), was_abandoned: true };
  const abandonedImport = await dispatch(
    handler,
    "/api/import",
    "POST",
    [abandoned],
    undefined,
    aliceCookie,
  );
  assert.strictEqual(JSON.parse(abandonedImport.body).abandoned, 1);
  assert.strictEqual(
    JSON.parse(
      (await dispatch(handler, `/api/stats/overview?scope=profile&profileId=${aliceId}`)).body,
    )[0].abandoned,
    1,
  );
  assert.strictEqual(
    JSON.parse((await dispatch(handler, "/api/profiles?q=alice")).body)[0].runs,
    1,
  );
  assert.strictEqual(
    JSON.parse(
      (await dispatch(handler, `/api/status?scope=profile&profileId=${aliceId}`)).body,
    ).runs,
    1,
  );
  assert.strictEqual(
    JSON.parse(
      (await dispatch(handler, `/api/stats/overview?scope=profile&profileId=${aliceId}`)).body,
    )[0].runs,
    1,
  );
  assert.strictEqual(
    JSON.parse(
      (
        await dispatch(
          handler,
          `/api/stats/overview?scope=profile&profileId=${aliceId}`,
        )
      ).body,
    )[0].runs,
    1,
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
    password: "abcde",
  });
  assert.strictEqual(locked.status, 429);
  assert(Number(locked.headers["Retry-After"]) > 0);

  // A successful sign-in clears the failure counter.
  await dispatch(handler, "/api/register", "POST", {
    username: "carol",
    password: "abcde",
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
        password: "abcde",
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
        password: "abcde",
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

  // Account creation is limited per network address.
  let lastStatus;
  for (let i = 0; i < 12; i++) {
    lastStatus = (
      await dispatch(handler, "/api/register", "POST", {
        username: `bulk${i}`,
        password: "abcde",
      })
    ).status;
  }
  assert.strictEqual(lastStatus, 429);

  await db.close();
  console.log("All smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
