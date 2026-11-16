const $ = (id) => document.getElementById(id);
let tabs = [],
  curTab = "characters";
let currentScope = "global";
let currentProfile = null;
let accountMode = "login";

async function api(path, opts) {
  const headers = { ...(opts?.headers || {}) };
  if (opts?.body !== undefined) headers["Content-Type"] ||= "application/json";
  const r = await fetch(path, { ...opts, headers });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function pretty(v) {
  if (typeof v !== "string") return v;
  const m =
    v.match(/^[A-Z]+\.([A-Z0-9_]+)$/) || v.match(/^([A-Z0-9_]+)\.title$/);
  if (!m) return v;
  return m[1]
    .toLowerCase()
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const qs = () => {
  const p = new URLSearchParams();
  if ($("fChar").value) p.set("character", $("fChar").value);
  if ($("fAsc").value) p.set("ascension", $("fAsc").value);
  p.set("min", $("fMin").value || 1);
  p.set("scope", currentScope);
  return p.toString();
};

function authHeaders() {
  const token = $("importToken").value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function renderTable(rows, host) {
  if (!rows.length) {
    host.innerHTML =
      '<div class="empty">No runs in this view yet. Import a folder of .run files to add your runs.</div>';
    return;
  }
  const cols = Object.keys(rows[0]);
  const data = rows.map((r) => cols.map((c) => r[c]));
  const filterableColumns = new Set([
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
  const selectedFilters = new Map();
  const filters = document.createElement("div");
  filters.className = "table-filters";
  let sortCol = -1,
    asc = false;
  const table = document.createElement("table");
  const thead = document.createElement("thead"),
    body = document.createElement("tbody");
  const hr = document.createElement("tr");
  const draw = () => {
    const visible = data.filter((row) =>
      [...selectedFilters].every(
        ([column, value]) => String(row[column]) === value,
      ),
    );
    if (sortCol >= 0) {
      visible.sort(
        (a, b) =>
          (a[sortCol] > b[sortCol] ? 1 : a[sortCol] < b[sortCol] ? -1 : 0) *
          (asc ? 1 : -1),
      );
    }
    body.innerHTML = "";
    for (const row of visible) {
      const tr = document.createElement("tr");
      row.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v === null ? "" : pretty(v);
        if (typeof v === "number") td.className = "num";
        if (/pct$/.test(cols[i]) && typeof v === "number")
          td.style.color = v >= 50 ? "var(--good)" : "var(--bad)";
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  };
  cols.forEach((c, i) => {
    const th = document.createElement("th");
    th.textContent = c.replace(/_/g, " ");
    th.onclick = () => {
      asc = sortCol === i ? !asc : false;
      sortCol = i;
      draw();
    };
    hr.appendChild(th);

    if (!filterableColumns.has(c)) return;
    const values = [...new Set(data.map((row) => row[i]).filter((v) => v != null))];
    if (values.length < 2) return;
    values.sort((a, b) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b)),
    );
    const label = document.createElement("label");
    label.className = "table-filter";
    label.append(document.createTextNode(`${c.replace(/_/g, " ")} `));
    const select = document.createElement("select");
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All";
    select.appendChild(all);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = pretty(String(value));
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      if (select.value) selectedFilters.set(i, select.value);
      else selectedFilters.delete(i);
      draw();
    });
    label.appendChild(select);
    filters.appendChild(label);
  });
  thead.appendChild(hr);
  table.append(thead, body);
  draw();
  host.innerHTML = "";
  if (filters.childElementCount) host.appendChild(filters);
  host.appendChild(table);
}

async function renderOverview() {
  const [o] = await api("/api/stats/overview?" + qs());
  const items = [
    ["Solo runs", o.runs],
    ["Wins", o.wins],
    ["Win rate", o.win_pct + "%"],
    ["Avg run (min)", o.avg_minutes],
  ];
  $("overview").innerHTML = items
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`)
    .join("");
}

function renderTabs() {
  $("tabs").innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.textContent = t.title;
    if (t.id === curTab) b.className = "on";
    b.onclick = () => {
      curTab = t.id;
      renderTabs();
      renderView();
    };
    $("tabs").appendChild(b);
  }
}

async function renderView() {
  const host = $("view");
  try {
    renderTable(await api(`/api/stats/${curTab}?` + qs()), host);
  } catch (e) {
    host.innerHTML = `<div class="err">${e.message}</div>`;
  }
}

async function fillFilters() {
  const f = await api("/api/filters");
  const [c, a] = [$("fChar").value, $("fAsc").value];
  $("fChar").innerHTML =
    '<option value="">All</option>' +
    f.characters
      .map((x) => `<option value="${x}">${pretty(x)}</option>`)
      .join("");
  $("fAsc").innerHTML =
    '<option value="">All</option>' +
    f.ascensions.map((x) => `<option>${x}</option>`).join("");
  $("fChar").value = c;
  $("fAsc").value = a;
}

async function updateStatus() {
  const s = await api(`/api/status?scope=${currentScope}`);
  $("status").textContent =
    currentScope === "profile"
      ? `${s.runs} runs in ${currentProfile.username}'s profile`
      : `${s.runs} runs in combined database`;
  $("status").className = "";
}

function renderProfileControls() {
  $("profileLabel").textContent = currentProfile
    ? `Signed in as ${currentProfile.username}`
    : "Combined public stats";
  $("profileScope").disabled = !currentProfile;
  $("globalScope").className = currentScope === "global" ? "on" : "";
  $("profileScope").className = currentScope === "profile" ? "on" : "";
  $("signInButton").hidden = Boolean(currentProfile);
  $("createProfileButton").hidden = Boolean(currentProfile);
  $("signOutButton").hidden = !currentProfile;
  $("importRunButton").hidden = !currentProfile;
  $("runFiles").disabled = !currentProfile;
}

function setAccountMode(mode) {
  accountMode = mode;
  $("accountSubmit").textContent =
    mode === "register" ? "Create profile" : "Sign in";
  $("accountPassword").autocomplete =
    mode === "register" ? "new-password" : "current-password";
}

async function refresh() {
  await fillFilters();
  await Promise.all([renderOverview(), renderView(), updateStatus()]);
}

async function importDropped(files) {
  if (!currentProfile) {
    $("status").textContent =
      "Create a profile or sign in before importing runs.";
    $("status").className = "warn";
    return;
  }
  const runFiles = [...files].filter((file) =>
    file.name.toLowerCase().endsWith(".run"),
  );
  if (!runFiles.length) {
    $("status").textContent = "No .run files found in that selection.";
    return;
  }

  const totals = { imported: 0, duplicate: 0, multiplayer: 0, invalid: 0 };
  const maxBatchBytes = 3 * 1024 * 1024;
  let batch = [],
    batchBytes = 2,
    processed = 0;

  async function sendBatch() {
    if (!batch.length) return;
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(batch),
    });
    for (const key of Object.keys(totals)) totals[key] += result[key];
    batch = [];
    batchBytes = 2;
  }

  try {
    for (const file of runFiles) {
      let run;
      try {
        run = JSON.parse(await file.text());
      } catch {
        totals.invalid++;
        processed++;
        continue;
      }
      const size = new TextEncoder().encode(JSON.stringify(run)).length + 1;
      if (size > maxBatchBytes) {
        totals.invalid++;
        processed++;
        continue;
      }
      if (batch.length && batchBytes + size > maxBatchBytes) await sendBatch();
      batch.push(run);
      batchBytes += size;
      processed++;
      $("status").textContent =
        `Reading runs ${processed} of ${runFiles.length}...`;
    }
    await sendBatch();
    $("status").textContent =
      `Processed ${processed}: imported ${totals.imported}, duplicates ${totals.duplicate}, multiplayer skipped ${totals.multiplayer}, invalid ${totals.invalid}`;
    await refresh();
  } catch (error) {
    $("status").textContent = error.message;
    $("status").className = "warn";
  }
}

async function main() {
  const me = await api("/api/me");
  currentProfile = me.profile;
  renderProfileControls();
  setAccountMode("login");
  tabs = await api("/api/tabs");
  renderTabs();
  await refresh();
  ["fChar", "fAsc", "fMin"].forEach((id) =>
    $(id).addEventListener("change", () => {
      renderOverview();
      renderView();
    }),
  );
  $("globalScope").addEventListener("click", () => {
    currentScope = "global";
    renderProfileControls();
    refresh();
  });
  $("profileScope").addEventListener("click", () => {
    if (!currentProfile) return;
    currentScope = "profile";
    renderProfileControls();
    refresh();
  });
  const openAccountPanel = (mode) => {
    setAccountMode(mode);
    $("accountPanel").hidden = false;
    $("accountMessage").textContent = "";
  };
  $("signInButton").addEventListener("click", () => openAccountPanel("login"));
  $("createProfileButton").addEventListener("click", () =>
    openAccountPanel("register"),
  );
  $("accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("accountMessage").textContent = "Working...";
    try {
      const result = await api(`/api/${accountMode}`, {
        method: "POST",
        body: JSON.stringify({
          username: $("accountUsername").value,
          password: $("accountPassword").value,
        }),
      });
      currentProfile = result.profile;
      currentScope = "profile";
      $("accountPassword").value = "";
      $("accountPanel").hidden = true;
      renderProfileControls();
      await refresh();
    } catch (error) {
      $("accountMessage").textContent = error.message;
    }
  });
  $("signOutButton").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
      currentProfile = null;
      currentScope = "global";
      renderProfileControls();
      await refresh();
    } catch (error) {
      $("status").textContent = error.message;
      $("status").className = "warn";
    }
  });
  const runFiles = $("runFiles");
  runFiles.addEventListener("change", () => {
    importDropped(runFiles.files);
    runFiles.value = "";
  });
  const importToken = $("importToken");
  importToken.value = sessionStorage.getItem("spireImportToken") || "";
  importToken.addEventListener("input", () =>
    sessionStorage.setItem("spireImportToken", importToken.value),
  );
  $("dbDownload").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/export", { headers: authHeaders() });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || response.statusText);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "sts2-tracker-export.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      $("status").textContent = error.message;
      $("status").className = "warn";
    }
  });
  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    importDropped([...e.dataTransfer.files]);
  });

  setInterval(refresh, 60000);
}
main();
