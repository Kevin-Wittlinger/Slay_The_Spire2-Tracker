// Smoke test: node test/smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');
const { createImporter } = require('../lib/importer');
const { Watcher } = require('../lib/watcher');
const { TABS, runQuery } = require('../db/queries');

function makeRun({ seed, win = false, players = 1, character = 'CHARACTER.REGENT', start = 1794596230 }) {
  const player = {
    character,
    deck: [
      { id: 'CARD.STRIKE_REGENT', floor_added_to_deck: 1 },
      { id: 'CARD.RESONANCE', floor_added_to_deck: 2, current_upgrade_level: 1 },
    ],
    relics: [{ id: 'RELIC.DIVINE_RIGHT', floor_added_to_deck: 1 }, { id: 'RELIC.GOLDEN_PEARL', floor_added_to_deck: 1 }],
  };
  const stat = extra => ({ current_hp: 50, damage_taken: 3, ...extra });
  return {
    seed, start_time: start, ascension: 10, win, was_abandoned: false, run_time: 581,
    killed_by_encounter: win ? 'NONE.NONE' : 'ENCOUNTER.CEREMONIAL_BEAST_BOSS', killed_by_event: 'NONE.NONE',
    players: Array.from({ length: players }, () => player),
    map_point_history: [[
      { map_point_type: 'monster', rooms: [{ room_type: 'monster', model_id: 'ENCOUNTER.NIBBITS_WEAK', monster_ids: ['MONSTER.NIBBIT'], turns_taken: 4 }],
        player_stats: Array.from({ length: players }, () => stat({ card_choices: [
          { card: { id: 'CARD.RESONANCE' }, was_picked: true }, { card: { id: 'CARD.BLACK_HOLE' }, was_picked: false }] })) },
      { map_point_type: 'unknown', rooms: [{ room_type: 'event', model_id: 'EVENT.NEOW' }],
        player_stats: [stat({ event_choices: [{ title: { key: 'GOLDEN_PEARL.title' } }] })] },
      { map_point_type: 'boss', rooms: [{ room_type: 'boss', model_id: 'ENCOUNTER.CEREMONIAL_BEAST_BOSS', monster_ids: ['MONSTER.CEREMONIAL_BEAST'], turns_taken: 7 }],
        player_stats: [stat({ current_hp: win ? 10 : 0, damage_taken: 49 })] },
    ]],
  };
}

const db = openDb(':memory:');
const importer = createImporter(db);

// solo run imports, duplicate is ignored, multiplayer and junk are rejected
assert.strictEqual(importer.importRun(makeRun({ seed: 'A' })).status, 'imported');
assert.strictEqual(importer.importRun(makeRun({ seed: 'A' })).status, 'duplicate');
assert.strictEqual(importer.importRun(makeRun({ seed: 'B', players: 2 })).status, 'multiplayer');
assert.strictEqual(importer.importRun({ nope: true }).status, 'invalid');
assert.strictEqual(importer.importRun(makeRun({ seed: 'C', win: true, start: 1794600000 })).status, 'imported');

assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 2);
assert.strictEqual(db.prepare("SELECT died FROM fights WHERE type='boss' AND run_id LIKE 'A:%'").get().died, 1);
assert.strictEqual(db.prepare("SELECT died FROM fights WHERE type='boss' AND run_id LIKE 'C:%'").get().died, 0);

// every stat query executes, with and without filters
for (const id of Object.keys(TABS)) {
  runQuery(db, id, {});
  runQuery(db, id, { character: 'CHARACTER.REGENT', ascension: 10, min: 1 });
}
assert.strictEqual(runQuery(db, 'overview', {})[0].win_pct, 50);
assert.strictEqual(runQuery(db, 'fight_types', {}).find(r => r.type === 'boss').win_pct, 50);

// watcher: imports a folder, skips multiplayer, picks up a new file on the next scan
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-'));
const db2 = openDb(':memory:');
const w = new Watcher(db2, createImporter(db2), { settleMs: 0 });
const put = (name, run) => fs.writeFileSync(path.join(dir, name), JSON.stringify(run));
put('1.run', makeRun({ seed: 'X1' }));
put('2.run', makeRun({ seed: 'X2', players: 2 }));
fs.writeFileSync(path.join(dir, '3.run'), '{ not json');
fs.utimesSync(path.join(dir, '3.run'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
w.dir = dir;
assert.strictEqual(w.scan(), 1);
assert.strictEqual(w.scan(), 0);
put('4.run', makeRun({ seed: 'X4', start: 1794700000 }));
assert.strictEqual(w.scan(), 1);
assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM runs').get().n, 2);
assert.strictEqual(db2.prepare("SELECT COUNT(*) n FROM imported_files WHERE status='multiplayer'").get().n, 1);

fs.rmSync(dir, { recursive: true });
console.log('All smoke tests passed.');
