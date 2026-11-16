"use strict";

const $ = (id) => document.getElementById(id);

// ---------- state ----------
const state = {
  tabs: [],
  tab: "characters",
  me: null, // signed-in profile {id, username} or null
  view: { scope: "global", profile: null }, // whose runs are shown
  characters: [], // character ids available in the current view
  accountMode: "login",
  importing: false,
  loadId: 0, // guards against out-of-order responses
  lastRefresh: 0,
};

const COLUMN_LABELS = {
  win_pct: "Win %",
  pick_pct: "Pick %",
  run_win_pct: "Run win %",
  avg_damage_taken: "Avg damage",
  avg_turns: "Avg turns",
  max_ascension: "Max ascension",
  killed_by: "Killed by",
  fights: "Fights",
  run_wins: "Run wins",
};

// Columns that get a dropdown filter above the table.
const FILTERABLE = new Set([
  "character",
  "ascension",
  "card",
  "relic",
  "type",
  "encounter",
  "killed_by",
  "result",
  "source",
  "event",
  "choice",
]);

// Logo banners in public/img/characters, as [width, height] in CSS pixels.
// The images are trimmed and scaled so the lettering is the same size in every logo;
// to add a character, drop in a PNG prepared the same way and add its size here.
const CHARACTER_LOGOS = {
  defect: [143, 30],
  fool: [110, 23],
  ironclad: [148, 23],
  necrobinder: [201, 31],
  regent: [141, 34],
  silent: [138, 26],
};

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
function characterLogo(value) {
  if (typeof value !== "string") return null;
  const slug = value
    .replace(/^CHARACTER./, "")
    .replace(/^THE_/, "")
    .toLowerCase();
  const size = Object.hasOwn(CHARACTER_LOGOS, slug) ? CHARACTER_LOGOS[slug] : null;
  if (!size) return null;
  return el("img", {
    class: "char-logo",
    width: size[0],
    height: size[1],
    src: `img/characters/${slug}.png`,
    alt: pretty(value),
    title: pretty(value),
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
  for (const value of values) add(value, characterLogo(value) || pretty(value));
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

// ---------- URL hash (shareable, survives reload) ----------
function viewToken() {
  const { scope, profile } = state.view;
  if (scope === "global") return "global";
  if (profile && (!state.me || profile.id !== state.me.id))
    return `${profile.id}:${profile.username}`;
  return "me";
}

function writeHash() {
  const params = new URLSearchParams();
  params.set("tab", state.tab);
  params.set("view", viewToken());
  if ($("fChar").value) params.set("character", $("fChar").value);
  if ($("fAsc").value) params.set("ascension", $("fAsc").value);
  if (Number($("fMin").value) > 1) params.set("min", $("fMin").value);
  history.replaceState(null, "", `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const initial = { filters: {} };
  if (params.get("tab")) initial.tab = params.get("tab");
  const view = params.get("view") || "global";
  const other = view.match(/^(\d+):([\w-]{1,24})$/);
  if (other) {
    initial.view = {
      scope: "profile",
      profile: { id: Number(other[1]), username: other[2] },
    };
  } else if (view === "me") {
    initial.view = { scope: "me" };
  }
  for (const key of ["character", "ascension", "min"]) {
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
  return params;
}

function statsQuery() {
  const params = new URLSearchParams();
  if ($("fChar").value) params.set("character", $("fChar").value);
  if ($("fAsc").value) params.set("ascension", $("fAsc").value);
  params.set("min", Math.max(1, Number($("fMin").value) || 1));
  return scopeParams(params).toString();
}

function viewLabel() {
  const { scope, profile } = state.view;
  if (scope === "global") return "the combined database";
  return state.me && profile.id === state.me.id
    ? "your profile"
    : `${profile.username}'s profile`;
}

// ---------- table ----------
function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function emptyMessage() {
  const filtered =
    $("fChar").value || $("fAsc").value || Number($("fMin").value) > 1;
  if (filtered)
    return "Nothing matches these filters. Try lowering the minimum sample or resetting the filters.";
  if (state.view.scope === "global")
    return "No runs have been imported yet. Create a profile and import your .run folder to get started.";
  return state.me && state.view.profile.id === state.me.id
    ? "You haven't imported any runs yet. Use Import run folder, or drop your .run files on this page."
    : `${state.view.profile.username} hasn't imported any runs yet.`;
}

function renderTable(rows, host) {
  host.replaceChildren();
  if (!rows.length) {
    host.append(el("div", { class: "empty", text: emptyMessage() }));
    return;
  }

  const cols = Object.keys(rows[0]);
  const data = rows.map((row) => cols.map((col) => row[col]));
  const selected = new Map(); // column index -> chosen value
  let sortCol = -1;
  let ascending = false;
  let search = "";

  const tbody = el("tbody");
  const count = el("span", { class: "row-count" });
  const headerCells = [];

  function draw() {
    const needle = search.trim().toLowerCase();
    const visible = data.filter(
      (row) =>
        [...selected].every(([i, value]) => String(row[i]) === value) &&
        (!needle ||
          row.some((v) => formatCell(v, "").toLowerCase().includes(needle))),
    );
    if (sortCol >= 0) {
      visible.sort(
        (a, b) => compareValues(a[sortCol], b[sortCol]) * (ascending ? 1 : -1),
      );
    }
    headerCells.forEach((th, i) => {
      th.setAttribute(
        "aria-sort",
        i === sortCol ? (ascending ? "ascending" : "descending") : "none",
      );
    });
    tbody.replaceChildren(
      ...visible.map((row) =>
        el(
          "tr",
          {},
          ...row.map((value, i) => {
            const col = cols[i];
            const td = el("td");
            const isPct = /pct$/.test(col) && typeof value === "number";
            if (typeof value === "number") td.className = "num";
            if (isPct) {
              const good = value >= 50;
              const bar = el("span", { class: `bar ${good ? "good" : "bad"}` });
              bar.style.setProperty("--w", `${Math.min(100, value)}%`);
              td.append(
                el("span", {
                  class: good ? "pct good" : "pct bad",
                  text: formatCell(value, col),
                }),
                bar,
              );
            } else {
              const logo = col === "character" ? characterLogo(value) : null;
              if (logo) td.append(logo);
              else td.textContent = formatCell(value, col);
            }
            return td;
          }),
        ),
      ),
    );
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
  });
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    draw();
  });
  toolbar.append(searchInput);

  const headRow = el("tr");
  cols.forEach((col, i) => {
    const th = el("th", { scope: "col", tabindex: "0", text: columnLabel(col) });
    const sort = () => {
      ascending = sortCol === i ? !ascending : typeof data[0][i] === "string";
      sortCol = i;
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
    const values =
      fixed ||
      [...new Set(data.map((row) => row[i]).filter((v) => v != null))].sort(
        compareValues,
      );
    if (!fixed && values.length < 2) return;
    if (col === "character") {
      toolbar.append(
        createCharacterPicker(values, "", (value) => {
          if (value) selected.set(i, value);
          else selected.delete(i);
          draw();
        }),
      );
      return;
    }
    const select = el(
      "select",
      { "aria-label": `Filter by ${columnLabel(col)}` },
      el("option", { value: "", text: `All ${columnLabel(col).toLowerCase()}` }),
      ...values.map((value) =>
        el("option", { value: String(value), text: pretty(String(value)) }),
      ),
    );
    select.addEventListener("change", () => {
      if (select.value) selected.set(i, select.value);
      else selected.delete(i);
      draw();
    });
    toolbar.append(select);
  });
  toolbar.append(count);

  host.append(
    toolbar,
    el(
      "div",
      { class: "table-wrap" },
      el("table", {}, el("thead", {}, headRow), tbody),
    ),
  );
  draw();
}

// ---------- data loading ----------
async function renderOverview(loadId) {
  const [o] = await api(`/api/stats/overview?${statsQuery()}`);
  if (loadId !== state.loadId) return;
  const items = [
    ["Solo runs", nf.format(o.runs)],
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

async function renderView(loadId) {
  const host = $("view");
  host.setAttribute("aria-busy", "true");
  host.classList.add("loading");
  try {
    const rows = await api(`/api/stats/${state.tab}?${statsQuery()}`);
    if (loadId !== state.loadId) return;
    renderTable(rows, host);
  } catch (error) {
    if (loadId !== state.loadId) return;
    host.replaceChildren(el("div", { class: "err", text: error.message }));
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

async function fillFilters() {
  const filters = await api(`/api/filters?${scopeParams()}`);
  state.characters = filters.characters;
  renderCharacterPicker();
  fillSelect(
    $("fAsc"),
    filters.ascensions,
    (a) => `Ascension ${a}`,
    "All ascensions",
  );
}

async function updateStatus() {
  const s = await api(`/api/status?${scopeParams()}`);
  setStatus(`${nf.format(s.runs)} runs in ${viewLabel()}`);
}

async function refresh() {
  const loadId = ++state.loadId;
  try {
    await fillFilters();
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
  const viewingMe = scope === "profile" && !viewingOther;

  $("globalScope").setAttribute("aria-pressed", String(scope === "global"));
  $("profileScope").hidden = !state.me;
  $("profileScope").setAttribute("aria-pressed", String(viewingMe));
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
  };
  const maxBatchBytes = 3 * 1024 * 1024;
  let batch = [];
  let batchBytes = 2;
  let processed = 0;

  const sendBatch = async () => {
    if (!batch.length) return;
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
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
        run = JSON.parse(await file.text());
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
    const parts = [
      totals.abandoned
        ? `${totals.imported} imported (${totals.abandoned} abandoned, not counted in stats)`
        : `${totals.imported} imported`,
    ];
    if (totals.duplicate) parts.push(`${totals.duplicate} already added`);
    if (totals.multiplayer) parts.push(`${totals.multiplayer} multiplayer skipped`);
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

// ---------- admin ----------
async function downloadBackup() {
  const token = $("importToken").value.trim();
  try {
    const response = await fetch("/api/export", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = (await response.json()).error || message;
      } catch {
        /* keep status text */
      }
      throw new Error(message);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = el("a", { href: url, download: "sts2-tracker-export.json" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

// ---------- startup ----------
function resetFilters() {
  $("fChar").value = "";
  renderCharacterPicker();
  $("fAsc").value = "";
  $("fMin").value = 1;
  refreshStats();
}

function wireEvents() {
  $("globalScope").addEventListener("click", () => setView("global"));
  $("profileScope").addEventListener("click", () => setView("me"));
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

  const onFilter = () => refreshStats();
  $("fAsc").addEventListener("change", onFilter);
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

  try {
    const importToken = $("importToken");
    importToken.value = sessionStorage.getItem("spireImportToken") || "";
    importToken.addEventListener("input", () =>
      sessionStorage.setItem("spireImportToken", importToken.value),
    );
  } catch {
    /* storage can be blocked; the key just won't be remembered */
  }
  $("dbDownload").addEventListener("click", downloadBackup);

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

  // Filter dropdowns are filled from the server; seed values from the URL first.
  const { character, ascension, min } = initial.filters;
  $("fMin").value = min || 1;
  renderScope();
  renderTabs();
  await fillFilters().catch(() => {});
  if (character) {
    $("fChar").value = character;
    renderCharacterPicker();
  }
  if (ascension) $("fAsc").value = ascension;
  await refresh();
}

main();
