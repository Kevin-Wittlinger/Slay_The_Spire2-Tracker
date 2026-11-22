"use strict";

// ---------- run page ----------
// A full rundown of one run, opened from the Details button on Recent runs (and from #...&run=<id>
// in the URL): how it ended, the map path through each area, relics, the final deck, and what happened
// on every floor. Data comes from GET /api/run (lib/run-detail.js).
//
// This file only defines functions; it uses helpers from app.js (el, pretty, titleCase, cardCell,
// relicCell, characterLogo, ascensionIcon, teammateLink, loadCardInfo, loadRelicInfo...), which are
// all defined by the time anything here runs.

// Map icons in public/img/map (from the wiki, `npm run update:map-icons`), by room type.
const MAP_ICONS = {
  monster: "monster",
  elite: "elite",
  boss: "boss",
  event: "event",
  unknown: "event",
  shop: "merchant",
  merchant: "merchant",
  rest_site: "restsite",
  treasure: "treasure",
  ancient: "neow",
};
const ROOM_NAMES = {
  monster: "Fight",
  elite: "Elite",
  boss: "Boss",
  event: "Event",
  shop: "Merchant",
  merchant: "Merchant",
  rest_site: "Rest site",
  treasure: "Treasure",
  ancient: "Ancient",
};
const FIGHT_ROOMS = new Set(["monster", "elite", "boss"]);

// Rarity groups in the order the summary lists them; anything else follows.
const RELIC_RARITY_ORDER = ["Ancient", "Boss", "Event", "Shop", "Rare", "Uncommon", "Common", "Starter"];
const CARD_RARITY_ORDER = ["Ancient", "Rare", "Uncommon", "Common", "Event", "Status", "Curse", "Basic", "Quest", "Token"];
const RARITY_LABEL = { Basic: "Starter" };

const runPage = { id: null, opener: null, loadId: 0 };

// "CARD.STRIKE_DEFECT" -> "Strike" (every character's starter Strike/Defend has the character in its id).
function cardName(id) {
  const match = typeof id === "string" && id.match(/^CARD\.(STRIKE|DEFEND)_[A-Z]+$/);
  return match ? titleCase(match[1]) : pretty(id);
}

// "ENCOUNTER.SEAPUNK_WEAK" -> "Seapunk (Weak)"
function encounterName(id) {
  const match = typeof id === "string" && id.match(/^ENCOUNTER\.([A-Z0-9_]+?)(?:_(NORMAL|WEAK|ELITE|BOSS))?$/);
  if (!match) return pretty(id) || "";
  const strength = match[2] === "WEAK" || match[2] === "NORMAL" ? ` (${titleCase(match[2])})` : "";
  return `${titleCase(match[1])}${strength}`;
}

// "TRASH_HEAP.pages.INITIAL.options.DIVE_IN.title" -> "Dive In"; "PANDORAS_BOX.title" -> "Pandoras Box"
function choiceName(key) {
  const match = String(key).match(/options\.([A-Z0-9_]+)\.title$/) || String(key).match(/^([A-Z0-9_]+)\.title$/);
  return match ? titleCase(match[1]) : pretty(key);
}

const roomKind = (room) => (room.map_type === "unknown" ? room.room_type : room.map_type) || room.room_type;

function roomTitle(room) {
  const kind = roomKind(room);
  if (FIGHT_ROOMS.has(room.room_type) && room.model_id) return encounterName(room.model_id);
  if ((room.room_type === "event" || kind === "ancient") && room.model_id) return pretty(room.model_id);
  return ROOM_NAMES[kind] || pretty(kind) || "Room";
}

// The map icon for a room: a boss or Ancient gets its own picture when there is one, else the plain
// icon for the room type. A missing picture falls back to that plain icon.
function mapIcon(room) {
  const kind = roomKind(room);
  const plain = `img/map/${MAP_ICONS[kind] || "event"}.png`;
  const own = (id, prefix, suffix) => {
    const match = typeof id === "string" && id.match(new RegExp(`^${prefix}\\.([A-Z0-9_]+?)${suffix}$`));
    return match ? `img/map/${match[1].replace(/_/g, "").toLowerCase()}.png` : null;
  };
  const src =
    (kind === "boss" && own(room.model_id, "ENCOUNTER", "(?:_BOSS)?")) ||
    (kind === "ancient" && own(room.model_id, "EVENT", "")) ||
    plain;
  const img = el("img", { src, alt: "", width: 30, height: 30, loading: "lazy" });
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== plain) img.src = plain;
    else img.remove();
  });
  return img;
}

// Small hoverable card / relic (same popups as the tables).
function miniCard(id) {
  const cell = cardCell(id);
  if (!cell) return el("span", { text: pretty(id) });
  cell.classList.add("mini");
  cardLabel(cell).textContent = cardName(id);
  return cell;
}
// The name inside a card cell (the first <span>; a "Co-op" tag may follow it).
const cardLabel = (cell) => cell.querySelector(":scope > span") || cell;
function miniRelic(id) {
  const cell = relicCell(id);
  if (!cell) return el("span", { text: pretty(id) });
  cell.classList.add("mini");
  return cell;
}

// Joins nodes with commas: [a, b, c] -> a, b, c
const joinNodes = (nodes) => nodes.flatMap((node, i) => (i ? [", ", node] : [node]));

// What happened in a room, as short lines (see roomDetail in lib/importer.js for the fields).
function roomSummary(room) {
  const d = room.detail || {};
  const lines = [];
  const line = (label, ...parts) => lines.push(el("div", { class: "log-line" }, el("span", { class: "log-label", text: label }), ...parts));
  const text = (value) => el("span", { text: value });
  const dim = (value) => el("span", { class: "dim", text: value });

  const numbers = [];
  if (d.turns) numbers.push(`${d.turns} ${d.turns === 1 ? "turn" : "turns"}`);
  if (d.damage) numbers.push(`took ${d.damage} damage`);
  if (d.healed) numbers.push(`healed ${d.healed}`);
  if (d.maxHpGained) numbers.push(`+${d.maxHpGained} max HP`);
  if (d.maxHpLost) numbers.push(`−${d.maxHpLost} max HP`);
  if (d.goldGained) numbers.push(`+${d.goldGained} gold`);
  if (d.goldSpent) numbers.push(`spent ${d.goldSpent} gold`);
  if (d.goldLost) numbers.push(`lost ${d.goldLost} gold`);
  if (numbers.length) lines.push(el("div", { class: "log-line dim", text: numbers.join(" · ") }));

  if (d.rest?.length) line("Rest site", text(d.rest.map(titleCase).join(", ")));
  if (d.choices?.length) line("Chose", text(d.choices.map(choiceName).join(" › ")));
  if (d.cards?.length || d.skipped?.length) {
    line(
      "Cards",
      ...(d.cards?.length ? joinNodes(d.cards.map(miniCard)) : [dim("took none")]),
      d.skipped?.length ? dim(` (skipped ${d.skipped.map(cardName).join(", ")})`) : null,
    );
  }
  if (d.upgraded?.length) line("Upgraded", ...joinNodes(d.upgraded.map(miniCard)));
  if (d.removed?.length) line("Removed", ...joinNodes(d.removed.map(miniCard)));
  if (d.transformed?.length)
    line("Transformed", ...joinNodes(d.transformed.map(([from, to]) => el("span", {}, miniCard(from), " → ", miniCard(to)))));
  if (d.enchanted?.length)
    line("Enchanted", ...joinNodes(d.enchanted.map(([card, ench]) => el("span", {}, miniCard(card), dim(` (${pretty(ench)})`)))));
  if (d.relics?.length || d.relicsSkipped?.length) {
    line(
      "Relics",
      ...(d.relics?.length ? joinNodes(d.relics.map(miniRelic)) : [dim("took none")]),
      d.relicsSkipped?.length ? dim(` (passed on ${d.relicsSkipped.map(pretty).join(", ")})`) : null,
    );
  }
  if (d.potions?.length) line("Potions", text(d.potions.map(pretty).join(", ")));
  if (d.potionsUsed?.length) line("Used", text(d.potionsUsed.map(pretty).join(", ")));
  if (d.potionsDiscarded?.length) line("Discarded", text(d.potionsDiscarded.map(pretty).join(", ")));
  return lines;
}

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

// "3 Ancient, 1 Event, 4 Uncommon" in a fixed rarity order.
function raritySummary(rarities, order) {
  const counts = new Map();
  for (const rarity of rarities) counts.set(rarity || "Other", (counts.get(rarity || "Other") || 0) + 1);
  const rank = (r) => (order.includes(r) ? order.indexOf(r) : order.length);
  return [...counts]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([rarity, n]) => `${n} ${RARITY_LABEL[rarity] || rarity}`)
    .join(", ");
}

function resultLine(run, rooms) {
  const lastFloor = rooms.length ? rooms[rooms.length - 1].floor : null;
  const where = lastFloor ? ` on floor ${lastFloor}` : "";
  const killer = run.killed_by
    ? /^ENCOUNTER\./.test(run.killed_by)
      ? encounterName(run.killed_by)
      : pretty(run.killed_by)
    : null;
  if (run.abandoned) {
    const inFight = killer && /^ENCOUNTER\./.test(run.killed_by);
    return el("p", { class: "run-result loss", text: `Abandoned${where}${inFight ? `, during ${killer} (counts as killed by it)` : ""}` });
  }
  if (run.win) return el("p", { class: "run-result win", text: "Victory" });
  return el("p", { class: "run-result loss", text: killer ? `Killed by ${killer}${where}` : `Defeated${where}` });
}

function runHeader(data) {
  const { run, rooms } = data;
  const stat = (label, value, cls = "") => (value === null || value === undefined || value === "" ? null : el("span", { class: `run-stat ${cls}`, title: label }, el("small", { text: label }), el("b", { text: String(value) })));
  const potions = run.potions ? run.potions.split(",") : [];
  const started = run.start_time ? new Date(run.start_time * 1000) : null;
  const mode = `${run.player_count > 1 ? `Multiplayer (${run.player_count} players)` : "Singleplayer"}${run.game_mode ? `: ${titleCase(run.game_mode)}` : ""}`;

  return el(
    "div",
    { class: "run-head" },
    el(
      "div",
      { class: "run-head-main" },
      characterLogo(run.character) || el("strong", { text: pretty(run.character) }),
      ascensionIcon(run.ascension),
      stat("HP", run.final_hp !== null && run.final_hp !== undefined ? `${run.final_hp}/${run.max_hp ?? "?"}` : null, "hp"),
      stat("Gold", run.gold, "gold"),
      stat("Potions", run.potion_slots ? `${potions.length}/${run.potion_slots}` : null),
      stat("Floors", rooms.length ? rooms[rooms.length - 1].floor : null),
      stat("Time", formatDuration(run.run_time)),
    ),
    el(
      "div",
      { class: "run-head-side" },
      started ? el("div", { text: started.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) }) : null,
      run.seed ? el("div", {}, "Seed: ", el("b", { class: "seed", text: run.seed })) : null,
      el("div", { text: mode }),
      run.build_id ? el("div", { class: "dim", text: run.build_id }) : null,
    ),
    resultLine(run, rooms),
    potions.length ? el("p", { class: "run-potions dim", text: `Potions held at the end: ${potions.map(pretty).join(", ")}` }) : null,
  );
}

function runPeople(data) {
  const parts = [];
  const mates = data.players
    .filter((p) => p.player_id !== data.run.player_id)
    .map((p) => ({
      steam: String(p.player_id),
      profile: p.profile_id && p.username ? { id: Number(p.profile_id), username: p.username } : null,
      character: p.character,
    }));
  if (mates.length) {
    parts.push(
      el(
        "div",
        { class: "run-people" },
        el("span", { class: "dim", text: "Played with " }),
        ...mates.map((mate) => el("span", { class: "mate" }, mate.character ? characterLogo(mate.character, 0.55) : null, teammateLink(mate))),
      ),
    );
  }
  if (data.importers.length) {
    parts.push(
      el(
        "div",
        { class: "run-people" },
        el("span", { class: "dim", text: "Imported by " }),
        ...joinNodes(
          data.importers.map((p) =>
            el("button", {
              type: "button",
              class: "user-link",
              text: p.username,
              title: `View ${p.username}'s stats`,
              onclick: () => {
                closeRun();
                viewPlayer({ id: Number(p.profile_id), username: p.username });
              },
            }),
          ),
        ),
      ),
    );
  }
  return parts;
}

// One row of map icons per area, like the game's run history.
function runMap(data) {
  const areaOf = new Map(data.acts.map((a) => [Number(a.act), a.area]));
  const byAct = new Map();
  for (const room of data.rooms) {
    if (!byAct.has(room.act)) byAct.set(room.act, []);
    byAct.get(room.act).push(room);
  }
  const rows = [...byAct].sort((a, b) => a[0] - b[0]).map(([act, rooms]) => {
    const area = areaOf.get(Number(act));
    return el(
      "div",
      { class: "run-map-row" },
      el("span", { class: "run-map-area", text: (area && AREA_NAMES[area]) || (area ? titleCase(area) : `Act ${act}`) }),
      el(
        "div",
        { class: "run-map-rooms" },
        ...rooms.map((room) => {
          const facts = [`Floor ${room.floor}`, roomTitle(room)];
          if (room.map_type === "unknown") facts.push("(? room)");
          if (room.hp !== null && room.hp !== undefined) facts.push(`${room.hp}/${room.max_hp ?? "?"} HP`);
          if (room.gold !== null && room.gold !== undefined) facts.push(`${room.gold} gold`);
          return el(
            "a",
            {
              class: `map-room${room.floor === data.deathFloor ? " died" : ""}`,
              href: `#floor-${room.floor}`,
              title: facts.join(" · "),
              "aria-label": facts.join(", "),
              onclick: (event) => {
                event.preventDefault();
                const target = document.getElementById(`floor-${room.floor}`);
                target?.scrollIntoView({ block: "center", behavior: "smooth" });
                target?.classList.add("flash");
                setTimeout(() => target?.classList.remove("flash"), 1200);
              },
            },
            mapIcon(room),
          );
        }),
      ),
    );
  });
  return el("section", { class: "run-section" }, el("div", { class: "run-map" }, ...rows));
}

// The wiki's rarity; a relic the wiki doesn't list (like the Fake Merchant's) goes by where it came
// from instead, as the game does: an event relic is "Event", an Ancient's is "Ancient".
function relicRarity(relic, relicInfo) {
  const rarity = relicInfo[relic.relic_id]?.[0];
  if (rarity) return rarity;
  if (relic.origin === "EVENT") return "Event";
  if (relic.origin === "NEOW" || /^ANCIENT_/.test(relic.origin || "")) return "Ancient";
  if (relic.origin === "STARTING") return "Starter";
  return null;
}

function runRelics(data, relicInfo) {
  if (!data.relics.length) return null;
  return el(
    "section",
    { class: "run-section" },
    el("h3", {}, `Relics (${data.relics.length}): `, el("span", { class: "dim", text: raritySummary(data.relics.map((r) => relicRarity(r, relicInfo)), RELIC_RARITY_ORDER) })),
    el(
      "div",
      { class: "run-relics" },
      ...data.relics.map((r) => {
        const cell = relicCell(r.relic_id);
        if (!cell) return el("span", { class: "relic-chip", text: pretty(r.relic_id) });
        cell.classList.add("relic-only");
        cell.title = `${pretty(r.relic_id)}${r.floor_added > 1 ? ` (floor ${r.floor_added})` : ""}`;
        return cell;
      }),
    ),
  );
}

function runDeck(data, cardInfo) {
  if (!data.cards.length) return null;
  // Identical copies (same card, upgrade and enchantment) are shown once as "3x Strike", in deck order.
  const groups = new Map();
  for (const c of data.cards) {
    const key = `${c.card_id}|${c.upgrade}|${c.enchantment || ""}`;
    if (groups.has(key)) groups.get(key).count++;
    else groups.set(key, { ...c, count: 1 });
  }
  return el(
    "section",
    { class: "run-section" },
    el("h3", {}, `Cards (${data.cards.length}): `, el("span", { class: "dim", text: raritySummary(data.cards.map((c) => cardInfo[c.card_id]?.[0]), CARD_RARITY_ORDER) })),
    el(
      "div",
      { class: "run-deck" },
      ...[...groups.values()].map((c) => {
        const cell = miniCard(c.card_id);
        const name = cardLabel(cell);
        const plus = c.upgrade > 1 ? `+${c.upgrade}` : c.upgrade ? "+" : "";
        name.textContent = `${c.count > 1 ? `${c.count}x ` : ""}${cardName(c.card_id)}${plus}`;
        const notes = [];
        if (c.upgrade) {
          cell.classList.add("upgraded");
          notes.push("Upgraded");
        }
        if (c.enchantment) {
          cell.classList.add("enchanted");
          notes.push(`Enchanted: ${pretty(c.enchantment)}`);
        }
        if (c.floor_added > 1) notes.push(`Added on floor ${c.floor_added}`);
        if (notes.length) cell.title = notes.join(" · ");
        return el("div", { class: "deck-card" }, cell);
      }),
    ),
  );
}

function runLog(data) {
  const rows = data.rooms.map((room) =>
    el(
      "tr",
      { id: `floor-${room.floor}`, class: room.floor === data.deathFloor ? "died" : "" },
      el("td", { class: "num", text: String(room.floor) }),
      el(
        "td",
        {},
        el(
          "span",
          { class: "log-room" },
          mapIcon(room),
          el("span", {}, roomTitle(room), room.map_type === "unknown" ? el("span", { class: "dim", text: " (?)" }) : null),
        ),
      ),
      el("td", { class: "num", text: room.hp !== null && room.hp !== undefined ? `${room.hp}/${room.max_hp ?? "?"}` : "" }),
      el("td", { class: "num", text: room.gold ?? "" }),
      el("td", { class: "log-what" }, ...roomSummary(room)),
    ),
  );
  return el(
    "section",
    { class: "run-section" },
    el("h3", { text: "Floor by floor" }),
    el(
      "div",
      { class: "table-wrap run-log" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...["Floor", "Room", "HP", "Gold", "What happened"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, ...rows),
      ),
    ),
  );
}

function renderRun(data, cardInfo, relicInfo) {
  // The floor the run ended on, when it was lost in a fight there.
  const last = data.rooms[data.rooms.length - 1];
  data.deathFloor = !data.run.win && last && FIGHT_ROOMS.has(last.room_type) && data.run.killed_by ? last.floor : null;
  return [
    runHeader(data),
    ...runPeople(data),
    data.partial
      ? el("p", {
          class: "hint run-partial",
          text: "This run was imported before run pages existed, so only its fights and events are shown. Importing the run folder again fills in the rest (nothing is counted twice).",
        })
      : null,
    data.rooms.length ? runMap(data) : null,
    runRelics(data, relicInfo),
    runDeck(data, cardInfo),
    data.rooms.length ? runLog(data) : null,
  ];
}

// Steam names for teammates without a profile here, before the page is drawn.
async function loadRunSteamNames(data) {
  const ids = data.players
    .filter((p) => !p.profile_id && p.player_id && !steamNames.has(String(p.player_id)))
    .map((p) => String(p.player_id));
  if (!ids.length) return;
  try {
    const found = await api(`/api/steam-names?ids=${ids.slice(0, STEAM_NAME_BATCH).join(",")}`);
    for (const [id, name] of Object.entries(found)) steamNames.set(id, name);
  } catch {
    /* names are optional */
  }
}

async function openRun(id) {
  if (!id) return;
  const overlay = $("runOverlay");
  const body = $("runBody");
  const loadId = ++runPage.loadId;
  if (overlay.hidden) runPage.opener = document.activeElement;
  runPage.id = id;
  overlay.hidden = false;
  document.body.classList.add("run-open");
  body.replaceChildren(el("div", { class: "empty", text: "Loading run..." }));
  $("runClose").focus();
  writeHash();
  try {
    const [data, cardInfo, relicInfo] = await Promise.all([
      api(`/api/run?id=${encodeURIComponent(id)}`),
      loadCardInfo(),
      loadRelicInfo(),
    ]);
    await loadRunSteamNames(data);
    if (loadId !== runPage.loadId) return;
    body.replaceChildren(...renderRun(data, cardInfo, relicInfo).filter(Boolean));
    $("runDialog").scrollTop = 0;
  } catch (error) {
    if (loadId !== runPage.loadId) return;
    body.replaceChildren(el("div", { class: "err", text: error.message }));
  }
}

function closeRun() {
  if ($("runOverlay").hidden) return;
  runPage.loadId++;
  runPage.id = null;
  $("runOverlay").hidden = true;
  document.body.classList.remove("run-open");
  writeHash();
  runPage.opener?.focus?.();
  runPage.opener = null;
}

function wireRunPage() {
  $("runClose").addEventListener("click", closeRun);
  // A click on the dimmed area around the page closes it.
  $("runOverlay").addEventListener("mousedown", (event) => {
    if (event.target === $("runOverlay")) closeRun();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("runOverlay").hidden) closeRun();
  });
  // Keep Tab inside the run page while it is open.
  $("runOverlay").addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...$("runDialog").querySelectorAll("a[href], button:not([disabled])")].filter((n) => n.offsetParent);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
