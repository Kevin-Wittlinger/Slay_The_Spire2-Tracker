// Turns one parsed .run file into rows. Only SOLO runs are kept.
// importRun returns { status }: imported | duplicate | multiplayer | invalid

const NONE = (v) => (!v || v === "NONE.NONE" ? null : v);
const FIGHT_TYPES = new Set(["monster", "elite", "boss"]);

function createImporter(db) {
  async function importRun(j) {
    if (!j || typeof j !== "object" || !Array.isArray(j.players) || !j.seed)
      return { status: "invalid" };
    if (j.players.length !== 1) return { status: "multiplayer" };
    const p = j.players[0];
    if (!p || !p.character) return { status: "invalid" };
    const id = `${j.seed}:${j.start_time}`;
    const exists = await db.execute({
      sql: "SELECT 1 FROM runs WHERE run_id = ?",
      args: [id],
    });
    if (exists.rows.length) return { status: "duplicate" };

    const statements = [
      {
        sql: `INSERT INTO runs
        (run_id, seed, character, ascension, win, abandoned, killed_by, run_time, start_time, build_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [
          id,
          j.seed ?? null,
          p.character,
          j.ascension ?? 0,
          j.win ? 1 : 0,
          j.was_abandoned ? 1 : 0,
          NONE(j.killed_by_encounter) || NONE(j.killed_by_event),
          j.run_time ?? null,
          j.start_time ?? null,
          j.build_id ?? null,
        ],
      },
    ];
    const add = (sql, args) => statements.push({ sql, args });
    let floor = 0;
    (j.map_point_history || []).forEach((act, actIdx) => {
      for (const mp of act) {
        floor++;
        const ps = (mp.player_stats || [])[0] || {};
        const room = (mp.rooms || [])[0] || {};
        if (FIGHT_TYPES.has(room.room_type)) {
          add(
            `INSERT INTO fights
            (run_id, floor, act, type, encounter_id, monsters, turns, damage, hp_after, died)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              id,
              floor,
              actIdx + 1,
              room.room_type,
              room.model_id ?? null,
              (room.monster_ids || []).join(","),
              room.turns_taken ?? null,
              ps.damage_taken ?? 0,
              ps.current_hp ?? null,
              (ps.current_hp ?? 1) <= 0 ? 1 : 0,
            ],
          );
        }
        if (room.room_type === "event") {
          const choice =
            (ps.event_choices || [])
              .map((c) => c.title?.key || "")
              .join(" > ") || null;
          add(
            "INSERT INTO events (run_id, floor, act, event_id, choice) VALUES (?,?,?,?,?)",
            [id, floor, actIdx + 1, room.model_id ?? null, choice],
          );
        }
        for (const c of ps.card_choices || []) {
          add(
            "INSERT INTO card_choices (run_id, floor, source, card_id, picked) VALUES (?,?,?,?,?)",
            [
              id,
              floor,
              mp.map_point_type || "unknown",
              c.card.id,
              c.was_picked ? 1 : 0,
            ],
          );
        }
      }
    });
    for (const c of p.deck || []) {
      add(
        "INSERT INTO run_cards (run_id, card_id, upgrade, floor_added) VALUES (?,?,?,?)",
        [id, c.id, c.current_upgrade_level || 0, c.floor_added_to_deck ?? 0],
      );
    }
    for (const r of p.relics || []) {
      add(
        "INSERT INTO run_relics (run_id, relic_id, floor_added) VALUES (?,?,?)",
        [id, r.id, r.floor_added_to_deck ?? 0],
      );
    }

    try {
      await db.batch(statements, "write");
    } catch (error) {
      const duplicate = await db.execute({
        sql: "SELECT 1 FROM runs WHERE run_id = ?",
        args: [id],
      });
      if (duplicate.rows.length) return { status: "duplicate" };
      throw error;
    }
    return { status: "imported", run_id: id };
  }

  return { importRun };
}

module.exports = { createImporter };
