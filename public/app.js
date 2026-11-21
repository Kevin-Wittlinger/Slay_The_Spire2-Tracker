"use strict";

const $ = (id) => document.getElementById(id);

// ---------- state ----------
const state = {
  tabs: [],
  tab: "characters",
  me: null, // signed-in profile {id, username} or null
  view: { scope: "global", profile: null }, // whose runs are shown
  page: "stats", // "stats" or "achievements" (the signed-in player's badges)
  characters: [], // character ids available in the current view
  accountMode: "login",
  importing: false,
  loadId: 0, // guards against out-of-order responses
  dataVersion: 0, // set after an import; sent as ?v= so cached statistics are skipped
  lastRefresh: 0,
};

const COLUMN_LABELS = {
  win_pct: "Win %",
  clear_pct: "Clear %",
  pick_pct: "Pick %",
  run_win_pct: "Run win %",
  avg_damage_taken: "Avg damage",
  avg_turns: "Avg turns",
  max_ascension: "Max ascension",
  killed_by: "Killed by",
  fights: "Fights",
  run_wins: "Run wins",
  teammates: "Played with (your WR together)",
  played_as: "Played as",
  last_played: "Last played",
};

// Cards that only exist in multiplayer (they help or target a teammate). Shown with a "Co-op" tag.
const COOP_CARDS = new Set(
  [
    "BEACON_OF_HOPE", "BELIEVE_IN_YOU", "COORDINATE", "DEMONIC_SHIELD", "ENERGY_SURGE",
    "FLANKING", "GANG_UP", "GLIMPSE_BEYOND", "HAMMER_TIME", "HUDDLE_UP", "IGNITION",
    "INTERCEPT", "KNOCKDOWN", "LARGESSE", "LEGION_OF_BONE", "LIFT", "MIMIC", "RALLY",
    "SNEAKY", "TAG_TEAM", "TANK",
  ].map((id) => `CARD.${id}`),
);

// Tabs whose default order is alphabetical, and the column they sort by.
const ALPHABETICAL_TABS = {
  card_win_rate: "card",
  card_pick_rate: "card",
  relic_win_rate: "relic",
  encounters: "encounter",
  killed_by: "killed_by",
};

// Columns that get a dropdown filter above the table.
// (Character is left out: the logo row at the top already filters every tab.)
// Only columns with a handful of values get a dropdown. Name columns (card, relic, enemy, event...)
// are left to the search box, where a dropdown with hundreds of entries would just repeat it.
const FILTERABLE = new Set(["ascension", "type", "result", "source", "rarity", "color"]);

// Logo banners in public/img/characters, as [width, height] in CSS pixels.
// The images are trimmed and scaled so the lettering is the same size in every logo;
// to add a character, drop in a PNG prepared the same way and add its size here.
const CHARACTER_LOGOS = {
  defect: [126, 26],
  fool: [97, 20],
  ironclad: [130, 20],
  necrobinder: [177, 27],
  regent: [124, 30],
  silent: [121, 23],
};

// Flame icons for ascension levels 0-10 (public/img/ascension/<level>.png, 31x46 source),
// drawn at [width, height] CSS pixels. Other levels fall back to plain text.
const ASCENSION_MAX = 10;
const ASCENSION_SIZE = [23, 34];

// Fight-type icons (public/img/fights/<kind>.png) shown beside the text in "type" columns.
// Fights are stored as monster / elite / boss; Killed by spells them "Regular combat" / "Elite" / "Boss".
const FIGHT_ICONS = {
  monster: ["normal", 28, 28],
  "regular combat": ["normal", 28, 28],
  elite: ["elite", 40, 34],
  boss: ["boss", 38, 43],
};

// The filter-row logos are drawn smaller so all characters fit on one line.
const PICKER_SCALE = 0.7;

// Characters always appear in this order wherever they are listed.
const CHARACTER_ORDER = [
  "ironclad",
  "silent",
  "regent",
  "necrobinder",
  "defect",
  "fool",
];

function characterSlug(value) {
  return String(value)
    .replace(/^CHARACTER./, "")
    .replace(/^THE_/, "")
    .toLowerCase();
}

function characterRank(value) {
  const rank = CHARACTER_ORDER.indexOf(characterSlug(value));
  return rank === -1 ? CHARACTER_ORDER.length : rank;
}

// Fixed order first; characters we don't know about follow alphabetically.
function sortCharacters(values) {
  return [...values].sort(
    (a, b) =>
      characterRank(a) - characterRank(b) || String(a).localeCompare(String(b)),
  );
}

// ---------- helpers ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] ||= "application/json";
  let response;
  try {
    response = await fetch(path, { ...opts, headers });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) {
    throw new Error(
      body?.error || `Request failed (${response.status} ${response.statusText})`,
    );
  }
  return body;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

function titleCase(text) {
  return text
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// "CHARACTER.THE_REGENT" -> "The Regent", "GOLDEN_PEARL.title > X.title" -> "Golden Pearl > X"
function pretty(value) {
  if (typeof value !== "string") return value;
  return value
    .split(" > ")
    .map((part) => {
      const match =
        part.match(/^[A-Z]+\.([A-Z0-9_]+)$/) ||
        part.match(/^([A-Z0-9_]+)\.title$/);
      return match ? titleCase(match[1]) : part;
    })
    .join(" > ");
}

// An <img> for a known character id (e.g. "CHARACTER.THE_SILENT"), else null.
function characterLogo(value, scale = 1) {
  if (typeof value !== "string") return null;
  const slug = characterSlug(value);
  const size = Object.hasOwn(CHARACTER_LOGOS, slug) ? CHARACTER_LOGOS[slug] : null;
  if (!size) return null;
  return el("img", {
    class: "char-logo",
    width: Math.round(size[0] * scale),
    height: Math.round(size[1] * scale),
    src: `img/characters/${slug}.png`,
    alt: pretty(value),
    title: pretty(value),
    loading: "lazy",
  });
}

// Icon plus the usual text, so the type is still readable and searchable. Null for other values.
// Relic icon + name. Icons come from the Slay the Spire wiki, saved as img/relics/<id>.png
// (RELIC.BURNING_BLOOD -> burning_blood.png). A relic without an icon just shows its name.
function relicCell(value) {
  const match = typeof value === "string" && value.match(/^RELIC\.([A-Z0-9_]+)$/);
  return match ? iconCell(`img/relics/${match[1].toLowerCase()}.png`, value, "relic") : null;
}

// Enemy picture + name. Pictures come from the area pages of the Slay the Spire wiki, saved per
// encounter without its strength suffix: ENCOUNTER.NIBBITS_WEAK -> img/monsters/nibbits.png.
function encounterCell(value, col) {
  const match = typeof value === "string" && value.match(/^ENCOUNTER\.([A-Z0-9_]+?)(?:_(?:NORMAL|WEAK|ELITE|BOSS))?$/);
  if (!match) return null;
  const cell = iconCell(`img/monsters/${match[1].toLowerCase()}.png`, value, col);
  if (/_WEAK$/.test(value)) cell.title = "Weak: easier pool of regular fights, early in an act";
  else if (/_NORMAL$/.test(value)) cell.title = "Normal: harder pool of regular fights, later in an act";
  return cell;
}

// Card picture + name, from the wiki card list: CARD.BASH -> img/cards/bash.png.
function cardCell(value) {
  const match = typeof value === "string" && value.match(/^CARD\.([A-Z0-9_]+)$/);
  if (!match) return null;
  const cell = iconCell(`img/cards/${match[1].toLowerCase()}.png`, value, "card", "cell-icon card-thumb");
  if (COOP_CARDS.has(value))
    cell.append(el("span", { class: "coop-tag", text: "Co-op", title: "Multiplayer-only card" }));
  return cell;
}

// ---------- teammates ----------
// "steam_id|profile_id|username|character|wins|runs" (the last three only in Recent runs).
// profile_id and username are empty when the teammate has no profile on this site.
function parseTeammate(raw) {
  const [steam = "", profileId, username, character, wins, runs] = String(raw).split("|");
  return {
    steam,
    profile: Number(profileId) > 0 && username ? { id: Number(profileId), username } : null,
    character: character || null,
    wins: wins ? Number(wins) : 0,
    runs: runs ? Number(runs) : 0,
  };
}

// Steam display names fetched from the server (see lib/steam.js), by Steam id.
const steamNames = new Map();
const teammateName = (mate) =>
  mate.profile?.username || steamNames.get(mate.steam) || `Steam …${mate.steam.slice(-4)}`;

// Looks up the Steam names of teammates without a site profile, before a table that shows them is
// drawn. Best effort: on any failure the shortened Steam id is shown instead.
async function loadSteamNames(rows) {
  const ids = new Set();
  for (const row of rows) {
    for (const col of TEAMMATE_COLUMNS) {
      if (typeof row[col] !== "string") continue;
      for (const part of row[col].split(";")) {
        const mate = parseTeammate(part);
        if (!mate.profile && mate.steam && !steamNames.has(mate.steam)) ids.add(mate.steam);
      }
    }
  }
  if (!ids.size) return;
  try {
    const found = await api(`/api/steam-names?ids=${[...ids].slice(0, 25).join(",")}`);
    for (const [id, name] of Object.entries(found)) steamNames.set(id, name);
  } catch {
    /* names are optional */
  }
}
const teammateWinPct = (mate) => (mate.runs ? Math.round((1000 * mate.wins) / mate.runs) / 10 : null);
// Plain text for searching and sorting: "alice (Silent, 50% of 2)".
function teammateText(mate) {
  const extra = [mate.character && pretty(mate.character), mate.runs && `${teammateWinPct(mate)}% of ${mate.runs}`];
  const details = extra.filter(Boolean).join(", ");
  return details ? `${teammateName(mate)} (${details})` : teammateName(mate);
}

// A teammate with a profile here links to their stats; anyone else to their Steam profile.
function teammateLink(mate) {
  if (mate.profile) {
    return el("button", {
      type: "button",
      class: "user-link",
      title: `View ${mate.profile.username}'s stats`,
      text: mate.profile.username,
      onclick: () => viewPlayer(mate.profile),
    });
  }
  return el("a", {
    class: "user-link",
    href: `https://steamcommunity.com/profiles/${encodeURIComponent(mate.steam)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    title: `Steam id ${mate.steam} (no profile on this site)`,
    text: teammateName(mate),
  });
}

function appendTeammates(row, td) {
  for (const mate of row.mates || []) {
    const pct = teammateWinPct(mate);
    td.append(
      el(
        "span",
        { class: "mate" },
        mate.character ? characterLogo(mate.character, 0.55) : null,
        teammateLink(mate),
        pct === null
          ? null
          : el("span", {
              class: `mate-wr ${pct >= 50 ? "good" : "bad"}`,
              title: `Your record with ${teammateName(mate)}: ${mate.wins} wins in ${mate.runs} runs`,
              text: `${pct}% · ${mate.wins}/${mate.runs}`,
            }),
      ),
    );
  }
}

// "CHARACTER.SILENT,CHARACTER.DEFECT" -> a row of small logos.
function characterListCell(value) {
  if (typeof value !== "string" || !value) return null;
  const chars = sortCharacters(value.split(","));
  return el(
    "span",
    { class: "char-list" },
    ...chars.map((c) => characterLogo(c, 0.6) || el("span", { text: pretty(c) })),
  );
}

// Hovering a card (picture or name) in a table shows it full size beside the pointer so its text can
// be read. Large pictures are img/cards-large/<id>.webp, the small ones' bigger siblings.
function setupCardPreview() {
  const preview = el("div", { class: "card-preview", hidden: "" }, el("img", { alt: "", width: 240 }));
  document.body.append(preview);
  const big = preview.firstChild;
  let current = null;

  const place = (cell) => {
    const rect = cell.getBoundingClientRect();
    const w = preview.offsetWidth || 240;
    const h = preview.offsetHeight || 300;
    // Right of the card's name if it fits, else left of its picture; never off the window edges.
    let left = rect.right + 16;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 8);
    const top = Math.min(Math.max(8, rect.top + rect.height / 2 - h / 2), window.innerHeight - h - 8);
    preview.style.setProperty("left", `${left}px`);
    preview.style.setProperty("top", `${top}px`);
  };
  const hide = () => {
    current = null;
    preview.hidden = true;
  };
  const cardCellOf = (node) => {
    const cell = node instanceof Element ? node.closest(".icon-cell") : null;
    return cell?.querySelector(".card-thumb") ? cell : null;
  };

  document.addEventListener("mouseover", (event) => {
    const cell = cardCellOf(event.target);
    if (!cell) return hide();
    if (cell === current) return;
    current = cell;
    const small = cell.querySelector(".card-thumb").getAttribute("src");
    big.onload = () => current === cell && ((preview.hidden = false), place(cell));
    big.onerror = hide;
    big.src = small.replace("img/cards/", "img/cards-large/").replace(/\.png$/, ".webp");
    if (big.complete && big.naturalWidth) big.onload();
  });
  document.addEventListener("mouseleave", hide);
  window.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("blur", hide);
}

// Small picture before the cell text; a missing picture just leaves the text.
function iconCell(src, value, col, cls = "cell-icon") {
  const img = el("img", { class: cls, src, alt: "", width: 32, height: 32, loading: "lazy" });
  img.addEventListener("error", () => img.remove(), { once: true });
  return el("span", { class: "icon-cell" }, img, el("span", { text: formatCell(value, col) }));
}

function fightTypeCell(value) {
  const info = typeof value === "string" ? FIGHT_ICONS[value.toLowerCase()] : null;
  if (!info) return null;
  const wrap = el("span", { class: "fight-type" });
  wrap.append(
    // Fixed-width slot so the text starts at the same spot whatever the icon width.
    el(
      "span",
      { class: "fight-icon-slot" },
      el("img", {
        class: "fight-icon",
        src: `img/fights/${info[0]}.png`,
        alt: "",
        width: info[1],
        height: info[2],
        loading: "lazy",
      }),
    ),
    el("span", { text: formatCell(value, "type") }),
  );
  return wrap;
}

function ascensionIcon(value) {
  if (!Number.isInteger(value) || value < 0 || value > ASCENSION_MAX)
    return null;
  return el("img", {
    class: "asc-icon",
    src: `img/ascension/${value}.png`,
    alt: `Ascension ${value}`,
    title: `Ascension ${value}`,
    width: ASCENSION_SIZE[0],
    height: ASCENSION_SIZE[1],
    loading: "lazy",
  });
}

// Row of clickable logo buttons (plus "All") that stands in for a dropdown.
// onChange receives the character id, or "" for All.
function createCharacterPicker(values, current, onChange) {
  const group = el("div", {
    class: "char-picker",
    role: "group",
    "aria-label": "Character",
  });
  const buttons = [];
  const select = (value) =>
    buttons.forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.value === value)),
    );
  const add = (value, content) => {
    const button = el(
      "button",
      {
        type: "button",
        "data-value": value,
        "aria-pressed": "false",
        title: value ? pretty(value) : "All characters",
      },
      content,
    );
    button.addEventListener("click", () => {
      select(value);
      onChange(value);
    });
    buttons.push(button);
    group.append(button);
  };
  add("", "All");
  for (const value of sortCharacters(values))
    add(value, characterLogo(value, PICKER_SCALE) || pretty(value));
  select(current);
  return group;
}

function renderCharacterPicker() {
  if (!state.characters.includes($("fChar").value)) $("fChar").value = "";
  $("charPicker").replaceChildren(
    createCharacterPicker(state.characters, $("fChar").value, (value) => {
      $("fChar").value = value;
      refreshStats();
    }),
  );
}

function columnLabel(name) {
  return COLUMN_LABELS[name] || titleCase(name);
}

const nf = new Intl.NumberFormat();
function formatCell(value, column) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (/pct$/.test(column)) return `${value}%`;
    return Number.isInteger(value) ? nf.format(value) : String(value);
  }
  return pretty(String(value));
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- filters ----------
// Every filter: its name in the URL and the API, and the input that holds it. The URL hash, the
// stats requests, the empty-table message and Reset all read this one list.
const FILTER_INPUTS = {
  mode: "fMode", // "" = solo, "multi" or "all"
  character: "fChar",
  ascension: "fAsc",
  patch: "fPatch",
  area: "fArea",
  source: "fSource", // relic source, only used on Relic WR
  min: "fMin",
};

// The filters that apply right now, empty ones left out.
// allCharacters: leave the character out (the Trends play-rate chart always compares them).
function activeFilters({ allCharacters = false } = {}) {
  const active = {};
  for (const [name, id] of Object.entries(FILTER_INPUTS)) {
    const value = $(id).value;
    if (!value) continue;
    if (name === "character" && allCharacters) continue;
    if (name === "source" && state.tab !== "relic_win_rate") continue;
    if (name === "min" && !(Number(value) > 1)) continue;
    active[name] = value;
  }
  return active;
}

// ---------- URL hash (shareable, survives reload) ----------
function viewToken() {
  const { scope, profile } = state.view;
  if (scope === "global") return "global";
  if (profile && (!state.me || profile.id !== state.me.id))
    return `${profile.id}:${profile.username}`;
  return "me";
}

function writeHash() {
  if (state.page === "achievements") return history.replaceState(null, "", "#view=achievements");
  const params = new URLSearchParams({ tab: state.tab, view: viewToken(), ...activeFilters() });
  if (trendsState.mode === "split") params.set("trend", "split");
  history.replaceState(null, "", `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const initial = { filters: {} };
  if (params.get("tab")) initial.tab = params.get("tab");
  if (params.get("trend") === "split") trendsState.mode = "split";
  const view = params.get("view") || "global";
  const other = view.match(/^(\d+):([\w-]{1,24})$/);
  if (other) {
    initial.view = {
      scope: "profile",
      profile: { id: Number(other[1]), username: other[2] },
    };
  } else if (view === "me") {
    initial.view = { scope: "me" };
  } else if (view === "achievements") {
    initial.page = "achievements";
  }
  for (const key of Object.keys(FILTER_INPUTS)) {
    if (params.get(key)) initial.filters[key] = params.get(key);
  }
  return initial;
}

// ---------- query building ----------
function scopeParams(params = new URLSearchParams()) {
  if (state.view.scope === "profile" && state.view.profile) {
    params.set("scope", "profile");
    params.set("profileId", state.view.profile.id);
  }
  if (state.dataVersion) params.set("v", state.dataVersion);
  return params;
}

function statsQuery(options) {
  return scopeParams(new URLSearchParams(activeFilters(options))).toString();
}

function viewLabel() {
  const { scope, profile } = state.view;
  if (scope === "global") return "the combined database";
  return state.me && profile.id === state.me.id
    ? "your profile"
    : `${profile.username}'s profile`;
}

// ---------- table ----------
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// What a cell sorts by, worked out once per cell: names by what is shown on screen ("Black Hole",
// not "CARD.BLACK_HOLE"), rarity in game order (Basic, Common, Uncommon, Rare, ...), numbers as numbers.
function sortKey(value, col) {
  if (value === null || value === undefined) return null;
  if (col === "rarity") return rarityRank(value);
  return typeof value === "number" ? value : pretty(String(value));
}

// Empty cells go last (in the default direction).
function compareKeys(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

// "3:alice,7:bob" -> [{id: 3, username: "alice"}, ...], sorted by name.
function parsePlayers(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => {
      const [id, ...name] = part.split(":");
      return { id: Number(id), username: name.join(":") };
    })
    .filter((player) => Number.isSafeInteger(player.id) && player.id > 0 && player.username)
    .sort((a, b) => collator.compare(a.username, b.username));
}

// Jump to a player's stats, keeping the current tab and filters.
function viewPlayer(player) {
  window.scrollTo({ top: 0 });
  if (state.me && player.id === state.me.id) return setView("me");
  return setView("other", { id: player.id, username: player.username });
}

// Fills a table cell with one clickable username per player.
function appendPlayers(row, td) {
  (row.players || []).forEach((player, index) => {
    if (index) td.append(", ");
    td.append(
      el("button", {
        type: "button",
        class: "user-link",
        title: `View ${player.username}'s stats`,
        text: player.username,
        onclick: () => viewPlayer(player),
      }),
    );
  });
}

function emptyMessage() {
  if (Object.keys(activeFilters()).length)
    return "Nothing matches these filters. Try lowering the minimum sample or resetting the filters.";
  if (state.view.scope === "global")
    return "No runs have been imported yet. Create a profile and import your .run folder to get started.";
  return state.me && state.view.profile.id === state.me.id
    ? "You haven't imported any runs yet. Use Import Run Folder, or drop your .run files on this page."
    : `${state.view.profile.username} hasn't imported any runs yet.`;
}

// The ONLY way a view's content should be replaced (tables, charts, errors).
// Emptying the container first makes the page briefly shorter, and the browser then
// clamps the scroll position, which looks like a jump to the top. So: build the new
// content off-screen, hold the old height for a frame, swap in one step, and keep the
// scroll position. Anything new that redraws the view should call this.
function swapView(host, ...nodes) {
  const scrollY = window.scrollY;
  host.style.setProperty("min-height", `${host.offsetHeight}px`);
  host.replaceChildren(...nodes);
  window.scrollTo({ top: scrollY });
  // A timer, not requestAnimationFrame: frames don't run in background tabs.
  setTimeout(() => host.style.removeProperty("min-height"), 60);
}

// What the user typed or picked in the table toolbar (search, dropdown filters, sort order).
// Kept while they stay on the same tab, so changing the character or another filter reloads the
// rows without wiping their search. Stored by column name; switching tabs clears it.
let tableMemory = null;

// Pictures in place of (or beside) plain text, by column. Each returns null when it has no picture
// for the value, and the cell then shows text.
const CELL_RENDERERS = {
  character: (value) => characterLogo(value),
  ascension: ascensionIcon,
  max_ascension: ascensionIcon,
  type: fightTypeCell,
  relic: relicCell,
  card: cardCell,
  encounter: encounterCell,
  killed_by: encounterCell,
  played_as: characterListCell,
};

// What the search box matches for a cell, where that differs from the text shown.
const SEARCH_TEXT = {
  card: (value) => `${pretty(value)}${COOP_CARDS.has(value) ? " co-op" : ""}`,
  played_as: (value) => String(value).split(",").map(pretty).join(", "),
};

// Columns holding teammates ("teammates": several, with your record; "teammate": one).
const TEAMMATE_COLUMNS = ["teammates", "teammate"];

const ENEMY_NOTE =
  "Weak = the easier pool of regular fights, met early in an act. Normal = the harder pool, met later.";

function buildCell(row, col, value) {
  const td = el("td");
  if (col === "player") {
    appendPlayers(row, td);
    return td;
  }
  if (TEAMMATE_COLUMNS.includes(col)) {
    td.className = "mates-cell";
    appendTeammates(row, td);
    return td;
  }
  if (typeof value === "number") td.className = "num";
  if (col === "character") td.className = "char-cell";
  if (col === "result" && (value === "WIN" || value === "LOSS"))
    td.className = value === "WIN" ? "result-win" : "result-loss";

  if (/pct$/.test(col) && typeof value === "number") {
    const good = value >= 50;
    const bar = el("span", { class: `bar ${good ? "good" : "bad"}` });
    bar.style.setProperty("--w", `${Math.min(100, value)}%`);
    td.append(el("span", { class: `pct ${good ? "good" : "bad"}`, text: formatCell(value, col) }), bar);
    return td;
  }
  const picture = CELL_RENDERERS[col]?.(value, col);
  if (picture) td.append(picture);
  else td.textContent = formatCell(value, col);
  return td;
}

function renderTable(rows, host) {
  if (!rows.length) {
    // Keep the source dropdown reachable so an empty result can be undone.
    const tools = state.tab === "relic_win_rate" && $("fSource").value
      ? [el("div", { class: "table-tools" }, relicSourceSelect())]
      : [];
    swapView(host, ...tools, el("div", { class: "empty", text: emptyMessage() }));
    return;
  }

  const cols = Object.keys(rows[0]);
  // Everything a redraw needs is worked out once per row: the values, what each sorts by, the
  // lowercase text the search box matches, and (on first display) the <tr> itself. Searching and
  // sorting then only filter and reorder rows that already exist.
  const data = rows.map((source) => {
    const row = { cells: cols.map((col) => source[col]), tr: null };
    if ("player" in source) {
      // Keep the clickable list on the row; the cell value becomes plain names
      // so sorting and searching work on what people see.
      const i = cols.indexOf("player");
      row.players = parsePlayers(row.cells[i]);
      row.cells[i] = row.players.map((p) => p.username).join(", ");
    }
    const mateCol = cols.findIndex((col) => TEAMMATE_COLUMNS.includes(col));
    if (mateCol >= 0) {
      // Same idea: the teammates stay on the row for drawing, the cell becomes readable text.
      const raw = row.cells[mateCol];
      row.mates = raw ? String(raw).split(";").map(parseTeammate) : [];
      row.cells[mateCol] = row.mates.map(teammateText).join(", ") || null;
    }
    row.keys = row.cells.map((value, i) => sortKey(value, cols[i]));
    row.text = row.cells
      .map((value, i) =>
        (value != null && SEARCH_TEXT[cols[i]] ? SEARCH_TEXT[cols[i]](value) : formatCell(value, "")).toLowerCase(),
      )
      .join("\n");
    return row;
  });
  const rowElement = (row) =>
    (row.tr ||= el("tr", {}, ...row.cells.map((value, i) => buildCell(row, cols[i], value))));

  if (!tableMemory || tableMemory.tab !== state.tab)
    tableMemory = { tab: state.tab, search: "", selected: new Map(), sortCol: null, ascending: false };
  const selected = new Map(); // column index -> chosen value
  for (const [name, value] of tableMemory.selected) {
    const i = cols.indexOf(name);
    if (i >= 0) selected.set(i, value);
  }
  let sortCol = cols.indexOf(tableMemory.sortCol); // -1 = default order
  let ascending = sortCol >= 0 && tableMemory.ascending;
  let search = tableMemory.search;
  const remember = () => {
    tableMemory.search = search;
    tableMemory.selected = new Map([...selected].map(([i, value]) => [cols[i], value]));
    tableMemory.sortCol = sortCol >= 0 ? cols[sortCol] : null;
    tableMemory.ascending = ascending;
  };
  // Default order: alphabetical on some tabs, otherwise the order the server sent.
  const defaultCol = cols.indexOf(ALPHABETICAL_TABS[state.tab]);

  const tbody = el("tbody");
  const count = el("span", { class: "row-count" });
  const headerCells = [];

  function draw() {
    remember();
    const needle = search.trim().toLowerCase();
    const visible = data.filter(
      (row) =>
        [...selected].every(([i, value]) => String(row.cells[i]) === value) &&
        (!needle || row.text.includes(needle)),
    );
    if (sortCol >= 0) {
      const direction = ascending ? 1 : -1;
      visible.sort((a, b) => compareKeys(a.keys[sortCol], b.keys[sortCol]) * direction);
    } else if (defaultCol >= 0) {
      visible.sort((a, b) => compareKeys(a.keys[defaultCol], b.keys[defaultCol]));
    }
    headerCells.forEach((th, i) => {
      th.setAttribute("aria-sort", i === sortCol ? (ascending ? "ascending" : "descending") : "none");
    });
    tbody.replaceChildren(...visible.map(rowElement));
    count.textContent =
      visible.length === data.length
        ? `${nf.format(data.length)} rows`
        : `${nf.format(visible.length)} of ${nf.format(data.length)} rows`;
  }

  // Toolbar: search + per-column dropdowns.
  const toolbar = el("div", { class: "table-tools" });
  const searchInput = el("input", {
    type: "search",
    placeholder: "Search this table...",
    "aria-label": "Search this table",
    value: search,
  });
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    draw();
  });
  toolbar.append(searchInput);
  if (state.tab === "relic_win_rate") toolbar.append(relicSourceSelect());

  const headRow = el("tr");
  const filteredCols = new Set(); // columns that got a dropdown
  cols.forEach((col, i) => {
    const th = el("th", { scope: "col", tabindex: "0", text: columnLabel(col) });
    // Clicking cycles: first direction -> opposite direction -> back to default order.
    // Text starts A-Z; numbers start highest first.
    const firstAscending = typeof data.find((row) => row.cells[i] != null)?.cells[i] === "string";
    const sort = () => {
      if (sortCol !== i) {
        sortCol = i;
        ascending = firstAscending;
      } else if (ascending === firstAscending) {
        ascending = !firstAscending;
      } else {
        sortCol = -1; // third click: default order
      }
      draw();
    };
    th.addEventListener("click", sort);
    th.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        sort();
      }
    });
    headerCells.push(th);
    headRow.append(th);

    if (!FILTERABLE.has(col)) return;
    const fixed =
      state.tab === "killed_by" && col === "type"
        ? ["Regular combat", "Elite", "Boss", "Other"]
        : null;
    let values = fixed;
    if (!values) {
      // Distinct values, in the same order the column sorts.
      const byValue = new Map();
      for (const row of data) if (row.cells[i] != null) byValue.set(row.cells[i], row.keys[i]);
      values = [...byValue].sort((a, b) => compareKeys(a[1], b[1])).map(([value]) => value);
      if (values.length < 2) return;
    }
    const select = el(
      "select",
      { "aria-label": `Filter by ${columnLabel(col)}` },
      el("option", { value: "", text: `All ${columnLabel(col).toLowerCase()}` }),
      ...values.map((value) => el("option", { value: String(value), text: pretty(String(value)) })),
    );
    // Re-apply the remembered choice, unless this data no longer offers that value.
    if (selected.has(i) && values.map(String).includes(selected.get(i))) select.value = selected.get(i);
    else selected.delete(i);
    select.addEventListener("change", () => {
      if (select.value) selected.set(i, select.value);
      else selected.delete(i);
      draw();
    });
    filteredCols.add(i);
    toolbar.append(select);
  });
  toolbar.append(count);
  // A remembered filter on a column that now has no dropdown (too few values) can't be cleared, so drop it.
  for (const i of [...selected.keys()]) if (!filteredCols.has(i)) selected.delete(i);

  draw();
  swapView(
    host,
    toolbar,
    el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, headRow), tbody)),
    ...(cols.includes("encounter") || cols.includes("killed_by") ? [el("p", { class: "hint", text: ENEMY_NOTE })] : []),
  );
}

// ---------- data loading ----------
async function renderOverview(loadId) {
  const [o] = await api(`/api/stats/overview?${statsQuery()}`);
  if (loadId !== state.loadId) return;
  const runsLabel = { multi: "Multiplayer runs", all: "Solo + multiplayer runs" }[$("fMode").value] || "Solo runs";
  const items = [
    [runsLabel, nf.format(o.runs)],
    ["Wins", nf.format(o.wins)],
    ["Win rate", `${o.win_pct}%`],
    ["Avg run length", `${o.avg_minutes} min`],
    ["Abandoned (not counted)", nf.format(o.abandoned)],
  ];
  $("overview").replaceChildren(
    ...items.map(([label, value]) =>
      el("div", { class: "stat" }, el("b", { text: value }), el("span", { text: label })),
    ),
  );
}

// Card rarity and colour (Ironclad, Silent, ..., Colorless) are fixed game data from the wiki card
// list, kept in a static file and added to card tables as "Color" and "Rarity" columns after the name.
const RARITY_ORDER = ["Basic", "Common", "Uncommon", "Rare", "Ancient", "Event", "Status", "Curse", "Quest", "Token"];
const rarityRank = (value) => {
  const i = RARITY_ORDER.indexOf(value);
  return i < 0 ? RARITY_ORDER.length : i;
};
let cardInfo = null;
function loadCardInfo() {
  cardInfo ||= fetch("card-info.json?v=1")
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}));
  return cardInfo;
}
async function withCardInfo(rows) {
  if (!rows.length || !("card" in rows[0])) return rows;
  const info = await loadCardInfo();
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value;
      if (key === "card") {
        out.color = info[value]?.[1] ?? null;
        out.rarity = info[value]?.[0] ?? null;
      }
    }
    return out;
  });
}

async function renderView(loadId) {
  const host = $("view");
  host.setAttribute("aria-busy", "true");
  host.classList.add("loading");
  try {
    const tab = state.tabs.find((t) => t.id === state.tab);
    const character = $("fChar").value;
    // With one character picked, the play-rate chart still needs everyone's runs (same other filters).
    const [rows, allRows] = await Promise.all([
      api(`/api/stats/${state.tab}?${statsQuery()}`),
      tab?.kind === "trends" && character
        ? api(`/api/stats/${state.tab}?${statsQuery({ allCharacters: true })}`)
        : null,
    ]);
    let shown = tab?.kind === "trends" ? rows : await withCardInfo(rows);
    // Solo runs have no teammates, so an all-solo table leaves that column out.
    if (shown.length && "teammates" in shown[0] && shown.every((row) => !row.teammates))
      shown = shown.map(({ teammates, ...row }) => row);
    if (tab?.kind !== "trends") await loadSteamNames(shown);
    if (loadId !== state.loadId) return;
    if (tab?.kind === "trends") renderTrends(rows, host, { character, allRows });
    else renderTable(shown, host);
  } catch (error) {
    if (loadId !== state.loadId) return;
    swapView(host, el("div", { class: "err", text: error.message }));
  } finally {
    if (loadId === state.loadId) {
      host.removeAttribute("aria-busy");
      host.classList.remove("loading");
    }
  }
}

function fillSelect(select, values, labelFor, allLabel) {
  const previous = select.value;
  select.replaceChildren(
    el("option", { value: "", text: allLabel }),
    ...values.map((value) =>
      el("option", { value: String(value), text: labelFor(value) }),
    ),
  );
  select.value = values.map(String).includes(previous) ? previous : "";
}

// The game's areas in the order they are played. Overgrowth and Underdocks are the two
// alternatives for act 1. The value is what the server stores in run_acts.area.
const AREA_NAMES = {
  OVERGROWTH: "Overgrowth",
  UNDERDOCKS: "Underdocks",
  HIVE: "Hive",
  GLORY: "Glory",
};

async function fillFilters() {
  fillSelect(
    $("fArea"),
    Object.keys(AREA_NAMES),
    (area) => AREA_NAMES[area],
    "All areas",
  );
  const filters = await api(`/api/filters?${scopeParams()}`);
  state.characters = filters.characters;
  renderCharacterPicker();
  fillSelect(
    $("fAsc"),
    filters.ascensions,
    (a) => `Ascension ${a}`,
    "All ascensions",
  );
  // Newest patch first; version numbers compare numerically (0.100 after 0.99).
  fillSelect(
    $("fPatch"),
    [...filters.patches].sort((a, b) => collator.compare(b, a)),
    (patch) => patch,
    "All patches",
  );
}

async function updateStatus() {
  const s = await api(`/api/status?${scopeParams()}`);
  setStatus(`${nf.format(s.runs)} runs in ${viewLabel()}`);
}

// Reloads everything. withFilters: false when the dropdown options were just loaded (page start).
async function refresh({ withFilters = true } = {}) {
  const loadId = ++state.loadId;
  try {
    if (withFilters) await fillFilters();
    if (loadId !== state.loadId) return;
    writeHash();
    await Promise.all([
      renderOverview(loadId),
      renderView(loadId),
      updateStatus(),
    ]);
    state.lastRefresh = Date.now();
  } catch (error) {
    if (loadId !== state.loadId) return;
    // A profile that no longer exists falls back to the combined view.
    if (state.view.scope === "profile" && /not found/i.test(error.message)) {
      setView("global");
      return;
    }
    $("view").replaceChildren(el("div", { class: "err", text: error.message }));
    setStatus(error.message, "warn");
  }
}

// Only the table and overview depend on filters/tabs, so skip refetching dropdown options.
function refreshStats() {
  const loadId = ++state.loadId;
  writeHash();
  renderOverview(loadId).catch((error) => setStatus(error.message, "warn"));
  renderView(loadId);
}

// ---------- tabs ----------
// Where a relic came from, as stored in run_relics.origin (see lib/relics.js). Only Relic WR uses it.
// "All Ancients" is every act 2 and 3 Ancient; Neow is the act 1 one. (The server also understands
// SHOP, ELITE, BOSS, TREASURE, EVENT, REST and OTHER; they just have no dropdown.)
const ANCIENT_NAMES = ["Tezcatara", "Tanx", "Vakuu", "Orobas", "Darv", "Nonupeipe", "Pael"];
const RELIC_SOURCES = {
  NEOW: "Neow",
  ANCIENT: "All Ancients",
  ...Object.fromEntries(ANCIENT_NAMES.map((name) => [`ANCIENT_${name.toUpperCase()}`, name])),
  NOT_ANCIENT: "No Neow or Ancients", // every other relic: shops, chests, fights, events...
};

const relicSourceOptions = () => [
  el("option", { value: "", text: "All relics" }),
  ...Object.entries(RELIC_SOURCES).map(([value, text]) => el("option", { value, text })),
];

// The visible dropdown, shown in the table toolbar on the Relic WR tab. The hidden #fSource keeps the
// value (so the URL, Reset and stats requests treat it like any other filter).
function relicSourceSelect() {
  const select = el(
    "select",
    { "aria-label": "Relic source", title: "Where the relic came from: Neow, an Ancient, or anywhere else. Starting relics are never counted." },
    ...relicSourceOptions(),
  );
  select.value = $("fSource").value;
  select.addEventListener("change", () => {
    $("fSource").value = select.value;
    refreshStats();
  });
  return select;
}

function renderTabs() {
  $("tabs").replaceChildren(
    ...state.tabs.map((tab) =>
      el("button", {
        type: "button",
        class: tab.id === state.tab ? "on" : "",
        "aria-pressed": String(tab.id === state.tab),
        text: tab.title,
        onclick: () => {
          state.tab = tab.id;
          tableMemory = null;
          // Teammates are multiplayer-only; switch Mode so the cards above describe the same runs.
          if (tab.id === "teammates" && !$("fMode").value) $("fMode").value = "multi";
          renderTabs();
          refreshStats();
        },
      }),
    ),
  );
}

// ---------- scope / profile switching ----------
function renderScope() {
  const { scope, profile } = state.view;
  const viewingOther = scope === "profile" && profile && profile.id !== state.me?.id;
  const onAchievements = state.page === "achievements";
  const viewingMe = scope === "profile" && !viewingOther && !onAchievements;

  $("globalScope").setAttribute("aria-pressed", String(scope === "global" && !onAchievements));
  $("profileScope").hidden = !state.me;
  $("profileScope").setAttribute("aria-pressed", String(viewingMe));
  $("achievementsScope").hidden = !state.me;
  $("achievementsScope").setAttribute("aria-pressed", String(onAchievements));
  $("statsPage").hidden = onAchievements;
  $("achievementsPage").hidden = !onAchievements;
  $("otherScope").hidden = !viewingOther;
  if (viewingOther) $("otherScope").textContent = `${profile.username} ✕`;
  $("otherScope").title = "Back to everyone";

  $("signInButton").hidden = Boolean(state.me);
  $("createProfileButton").hidden = Boolean(state.me);
  $("signOutButton").hidden = !state.me;
  $("importRunButton").hidden = !state.me;
  $("runFiles").disabled = !state.me || state.importing;
  $("importRunButton").classList.toggle("disabled", state.importing);
}

function setView(target, profile) {
  state.page = "stats";
  if (target === "global") state.view = { scope: "global", profile: null };
  else if (target === "me" && state.me)
    state.view = { scope: "profile", profile: state.me };
  else if (target === "other")
    state.view = { scope: "profile", profile };
  else state.view = { scope: "global", profile: null };
  renderScope();
  return refresh();
}

const searchBox = {
  results: [],
  active: -1,
};

function closeResults() {
  $("profileResults").hidden = true;
  searchBox.active = -1;
}

function highlightResult() {
  [...$("profileResults").children].forEach((item, i) =>
    item.classList.toggle("active", i === searchBox.active),
  );
}

function choosePlayer(player) {
  closeResults();
  $("profileSearch").value = "";
  if (state.me && player.id === state.me.id) setView("me");
  else setView("other", { id: player.id, username: player.username });
}

const searchPlayers = debounce(async () => {
  const query = $("profileSearch").value.trim();
  try {
    const found = await api(`/api/profiles?q=${encodeURIComponent(query)}`);
    if ($("profileSearch").value.trim() !== query) return; // stale
    searchBox.results = found;
    searchBox.active = found.length ? 0 : -1;
    $("profileResults").replaceChildren(
      ...(found.length
        ? found.map((player) =>
            el("li", {
              role: "option",
              text: `${player.username} · ${nf.format(player.runs)} ${player.runs === 1 ? "run" : "runs"}`,
              onmousedown: (event) => {
                event.preventDefault();
                choosePlayer(player);
              },
            }),
          )
        : [
            el("li", {
              class: "none",
              text: query ? "No players found" : "No profiles yet",
            }),
          ]),
    );
    $("profileResults").hidden = false;
    highlightResult();
  } catch (error) {
    setStatus(error.message, "warn");
  }
}, 250);

// ---------- personal achievements ----------
// A page of its own (it replaces the filters, cards and tabs) for the signed-in player's badges.
// The server decides what is earned (lib/achievements.js).
// SVG_NS comes from trends.js, which loads first.
function svgIcon(...shapes) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}
const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" };
const BADGE_ICONS = {
  all_a10: () =>
    el("img", { src: `img/ascension/${ASCENSION_MAX}.png`, alt: "", width: ASCENSION_SIZE[0] * 1.4, height: ASCENSION_SIZE[1] * 1.4 }),
  // Two arrows chasing each other round a circle.
  rotating_streak: () =>
    svgIcon(
      ["path", { ...STROKE, d: "M38 18a15 15 0 0 0-26-3" }],
      ["path", { ...STROKE, d: "M10 30a15 15 0 0 0 26 3" }],
      ["path", { ...STROKE, d: "M12 7v8h8" }],
      ["path", { ...STROKE, d: "M36 41v-8h-8" }],
    ),
  // A stopwatch.
  speedrunner: () =>
    svgIcon(
      ["circle", { ...STROKE, cx: 24, cy: 27, r: 15 }],
      ["path", { ...STROKE, d: "M20 6h8M24 6v6M24 27l6-6M37 13l3-3" }],
    ),
};

function badgeCard(badge, allCharacters) {
  const done = new Set(badge.characters);
  const card = el(
    "article",
    { class: `badge ${badge.earned ? "earned" : "locked"}` },
    el("div", { class: "badge-medal" }, BADGE_ICONS[badge.id]?.() || null),
    el("h3", { text: badge.name }),
    el("p", { class: "badge-desc", text: badge.description }),
    el("p", { class: "badge-status", text: badge.earned ? `Earned · ${badge.progress}` : badge.progress }),
  );
  if (badge.id !== "speedrunner" && allCharacters.length) {
    card.append(
      el(
        "div",
        { class: "badge-chars" },
        ...sortCharacters(allCharacters).map((c) => {
          const logo = characterLogo(c, 0.6) || el("span", { text: pretty(c) });
          const wrap = el("span", { class: done.has(c) ? "have" : "missing", title: `${pretty(c)}${done.has(c) ? "" : " (not yet)"}` }, logo);
          return wrap;
        }),
      ),
    );
  }
  return card;
}

async function showAchievements() {
  if (!state.me) return setView("global");
  state.page = "achievements";
  state.loadId++; // drop any stats still loading
  renderScope();
  writeHash();
  const page = $("achievementsPage");
  page.replaceChildren(el("div", { class: "empty", text: "Loading achievements..." }));
  try {
    const data = await api("/api/achievements?scope=profile");
    if (state.page !== "achievements") return;
    const earned = data.badges.filter((b) => b.earned).length;
    updateStatus().catch(() => {});
    page.replaceChildren(
      el("h2", { class: "achievements-title", text: `${data.profile.username}'s achievements` }),
      el("p", { class: "hint", text: `${earned} of ${data.badges.length} earned. Abandoned runs don't count.` }),
      el("div", { class: "badges" }, ...data.badges.map((badge) => badgeCard(badge, data.characters))),
    );
  } catch (error) {
    page.replaceChildren(el("div", { class: "err", text: error.message }));
  }
}

// ---------- account ----------
function setAccountMode(mode) {
  state.accountMode = mode;
  const register = mode === "register";
  $("accountTitle").textContent = register ? "Create profile" : "Sign in";
  $("accountSubmit").textContent = register ? "Create profile" : "Sign in";
  $("accountSwitch").textContent = register
    ? "Have an account? Sign in"
    : "New here? Create profile";
  $("accountPassword").autocomplete = register
    ? "new-password"
    : "current-password";
}

function openAccountPanel(mode) {
  setAccountMode(mode);
  $("accountPanel").hidden = false;
  $("accountMessage").textContent = "";
  $("accountUsername").focus();
}

function closeAccountPanel() {
  $("accountPanel").hidden = true;
  $("accountPassword").value = "";
}

async function submitAccount(event) {
  event.preventDefault();
  const submit = $("accountSubmit");
  submit.disabled = true;
  $("accountMessage").textContent = "Working...";
  try {
    const result = await api(`/api/${state.accountMode}`, {
      method: "POST",
      body: JSON.stringify({
        username: $("accountUsername").value.trim(),
        password: $("accountPassword").value,
      }),
    });
    state.me = result.profile;
    closeAccountPanel();
    $("accountUsername").value = "";
    await setView("me");
  } catch (error) {
    $("accountMessage").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function signOut() {
  try {
    await api("/api/logout", { method: "POST" });
    state.me = null;
    await setView("global");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

// ---------- import ----------
// The Steam id found in every multiplayer run of the selection, if exactly one is (same rule as the
// server's inferSelfId). Solo runs list player id 1, so only multiplayer files have 17-digit ids.
async function inferSteamId(files, maxBytes) {
  const counts = new Map();
  let multi = 0;
  for (const file of files) {
    if (file.size > maxBytes) continue;
    let text;
    try {
      text = await file.text();
    } catch {
      continue; // unreadable files are counted as invalid by the import itself
    }
    const ids = new Set([...text.matchAll(/"(?:id|player_id)"\s*:\s*"?(7656\d{13})\b/g)].map((m) => m[1]));
    if (ids.size < 2) continue;
    multi++;
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const everywhere = [...counts].filter(([, n]) => n === multi).map(([id]) => id);
  return multi >= 2 && everywhere.length === 1 ? everywhere[0] : null;
}
async function importFiles(files) {
  if (!state.me) {
    setStatus("Create a profile or sign in before importing runs.", "warn");
    openAccountPanel("register");
    return;
  }
  if (state.importing) return;
  const runFiles = [...files].filter((file) =>
    file.name.toLowerCase().endsWith(".run"),
  );
  if (!runFiles.length) {
    setStatus("No .run files found in that selection.", "warn");
    return;
  }

  state.importing = true;
  renderScope();
  const totals = {
    imported: 0,
    duplicate: 0,
    multiplayer: 0,
    invalid: 0,
    abandoned: 0,
    coop: 0,
  };
  const maxBatchBytes = 3 * 1024 * 1024;
  let batch = [];
  let batchBytes = 2;
  let processed = 0;
  // Multiplayer runs are stored from your side, so the server needs your Steam id. Picking the Steam
  // folder (or anything above it) puts it in the path: .../steam/7656119.../profile1/saves/history.
  // Otherwise it is the one player in all of the selected multiplayer runs (worked out over the whole
  // selection first, since a single batch may only hold runs with the same teammate).
  const pathIds = new Set(
    runFiles
      .map((file) => (file.webkitRelativePath || "").match(/(?:^|\/)(7656\d{13})(?:\/|$)/)?.[1])
      .filter(Boolean),
  );
  let playerId = pathIds.size === 1 ? [...pathIds][0] : null;
  if (!playerId) {
    setStatus("Reading runs...");
    playerId = await inferSteamId(runFiles, maxBatchBytes);
  }

  const sendBatch = async () => {
    if (!batch.length) return;
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(playerId ? { runs: batch, playerId } : batch),
    });
    for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
    state.dataVersion = Date.now();
    batch = [];
    batchBytes = 2;
  };

  try {
    for (const file of runFiles) {
      processed++;
      setStatus(`Importing ${processed} of ${runFiles.length}...`);
      // file.size is a close, cheap estimate of the JSON payload size.
      if (file.size + 1 > maxBatchBytes) {
        totals.invalid++;
        continue;
      }
      let run;
      try {
        // Steam ids (17 digits) don't fit in a JS number, so they're turned into strings first.
        run = JSON.parse(
          (await file.text()).replace(/("(?:id|player_id)"\s*:\s*)(\d{16,})/g, '$1"$2"'),
        );
      } catch {
        totals.invalid++;
        continue;
      }
      if (batch.length && batchBytes + file.size + 1 > maxBatchBytes)
        await sendBatch();
      batch.push(run);
      batchBytes += file.size + 1;
    }
    await sendBatch();
    const notes = [];
    if (totals.coop) notes.push(`${totals.coop} multiplayer`);
    if (totals.abandoned) notes.push(`${totals.abandoned} abandoned, not counted in stats`);
    const parts = [
      notes.length ? `${totals.imported} imported (${notes.join("; ")})` : `${totals.imported} imported`,
    ];
    if (totals.duplicate) parts.push(`${totals.duplicate} already added`);
    if (totals.multiplayer)
      parts.push(
        `${totals.multiplayer} multiplayer skipped (couldn't tell which player is you; import your whole history folder, or the Steam folder above it)`,
      );
    if (totals.invalid) parts.push(`${totals.invalid} invalid`);
    await setView("me");
    setStatus(`Done: ${parts.join(", ")}.`, "live");
  } catch (error) {
    setStatus(
      `Import stopped: ${error.message} (${totals.imported} imported so far)`,
      "warn",
    );
  } finally {
    state.importing = false;
    renderScope();
  }
}

// ---------- startup ----------
function resetFilters() {
  for (const id of Object.values(FILTER_INPUTS)) $(id).value = "";
  $("fMin").value = 1;
  renderCharacterPicker();
  refreshStats();
}

function wireEvents() {
  $("globalScope").addEventListener("click", () => setView("global"));
  $("profileScope").addEventListener("click", () => setView("me"));
  $("achievementsScope").addEventListener("click", showAchievements);
  $("otherScope").addEventListener("click", () => setView("global"));
  $("signInButton").addEventListener("click", () => openAccountPanel("login"));
  $("createProfileButton").addEventListener("click", () =>
    openAccountPanel("register"),
  );
  $("accountSwitch").addEventListener("click", () =>
    setAccountMode(state.accountMode === "login" ? "register" : "login"),
  );
  $("accountClose").addEventListener("click", closeAccountPanel);
  $("accountForm").addEventListener("submit", submitAccount);
  $("signOutButton").addEventListener("click", signOut);

  setupCardPreview();
  const onFilter = () => refreshStats();
  $("fMode").addEventListener("change", onFilter);
  $("fAsc").addEventListener("change", onFilter);
  $("fPatch").addEventListener("change", onFilter);
  $("fArea").addEventListener("change", onFilter);
  $("fMin").addEventListener("input", debounce(onFilter, 300));
  $("resetFilters").addEventListener("click", resetFilters);

  const search = $("profileSearch");
  search.addEventListener("input", searchPlayers);
  search.addEventListener("focus", searchPlayers);
  search.addEventListener("blur", closeResults);
  search.addEventListener("keydown", (event) => {
    const count = searchBox.results.length;
    if (event.key === "Escape") {
      closeResults();
    } else if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      searchBox.active = (searchBox.active + 1) % count;
      highlightResult();
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      searchBox.active = (searchBox.active - 1 + count) % count;
      highlightResult();
    } else if (event.key === "Enter" && searchBox.active >= 0) {
      event.preventDefault();
      choosePlayer(searchBox.results[searchBox.active]);
    }
  });

  const runFiles = $("runFiles");
  runFiles.addEventListener("change", () => {
    importFiles([...runFiles.files]);
    runFiles.value = "";
  });

  // Drag-and-drop import with a visible drop target.
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    $("dropOverlay").hidden = false;
  });
  document.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("dropOverlay").hidden = true;
  });
  document.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    importFiles([...event.dataTransfer.files]);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("accountPanel").hidden) closeAccountPanel();
  });

  // Catch up after the tab has been in the background for a while.
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      !state.importing &&
      Date.now() - state.lastRefresh > 2 * 60 * 1000
    )
      refresh();
  });
}

async function main() {
  wireEvents();
  setAccountMode("login");
  try {
    const [me, tabs] = await Promise.all([api("/api/me"), api("/api/tabs")]);
    state.me = me.profile;
    state.tabs = tabs;
  } catch (error) {
    setStatus(error.message, "warn");
    $("view").replaceChildren(el("div", { class: "err", text: error.message }));
    return;
  }

  const initial = readHash();
  if (initial.tab && state.tabs.some((tab) => tab.id === initial.tab))
    state.tab = initial.tab;
  else if (!state.tabs.some((tab) => tab.id === state.tab))
    state.tab = state.tabs[0]?.id;
  if (initial.view?.scope === "profile") state.view = initial.view;
  else if (initial.view?.scope === "me" && state.me)
    state.view = { scope: "profile", profile: state.me };

  // Filter dropdowns are filled from the server, then given the values from the URL.
  // (A value the dropdown doesn't offer, like an unknown relic source, is ignored by the select.)
  $("fSource").replaceChildren(...relicSourceOptions());
  renderScope();
  renderTabs();
  const filtersLoaded = await fillFilters().then(() => true, () => false);
  for (const [name, value] of Object.entries(initial.filters)) $(FILTER_INPUTS[name]).value = value;
  if (!$("fMin").value) $("fMin").value = 1;
  if (initial.filters.character) renderCharacterPicker();
  if (initial.page === "achievements" && state.me) {
    // The stats underneath load when the player goes back (through setView).
    state.view = { scope: "profile", profile: state.me };
    return showAchievements();
  }
  await refresh({ withFilters: !filtersLoaded });
}

main();
