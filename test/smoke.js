// Smoke test: node test/smoke.js
const assert = require("assert");
const { Readable } = require("stream");
process.env.IMPORT_TOKEN = "smoke-test-token";
const { openDb } = require("../lib/db");
const { createImporter } = require("../lib/importer");
const { createHandler } = require("../lib/handler");
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

  const handler = createHandler(db);
  assert.strictEqual(
    (await dispatch(handler, "/api/import", "POST", [makeRun({ seed: "D" })]))
      .status,
    401,
  );
  const registered = await dispatch(handler, "/api/register", "POST", {
    username: "alice",
    password: "a-secure-test-password",
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

  await db.close();
  console.log("All smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
