const $ = id => document.getElementById(id);
let tabs = [], curTab = 'characters';

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function pretty(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^[A-Z]+\.([A-Z0-9_]+)$/) || v.match(/^([A-Z0-9_]+)\.title$/);
  if (!m) return v;
  return m[1].toLowerCase().split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const qs = () => {
  const p = new URLSearchParams();
  if ($('fChar').value) p.set('character', $('fChar').value);
  if ($('fAsc').value) p.set('ascension', $('fAsc').value);
  p.set('min', $('fMin').value || 1);
  return p.toString();
};

function renderTable(rows, host) {
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No data yet. Set your run folder (top right) or drop .run files on this page.</div>';
    return;
  }
  const cols = Object.keys(rows[0]);
  let data = rows.map(r => cols.map(c => r[c]));
  let sortCol = -1, asc = false;
  const table = document.createElement('table');
  const thead = document.createElement('thead'), body = document.createElement('tbody');
  const hr = document.createElement('tr');
  const draw = () => {
    body.innerHTML = '';
    for (const row of data) {
      const tr = document.createElement('tr');
      row.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v === null ? '' : pretty(v);
        if (typeof v === 'number') td.className = 'num';
        if (/pct$/.test(cols[i]) && typeof v === 'number') td.style.color = v >= 50 ? 'var(--good)' : 'var(--bad)';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  };
  cols.forEach((c, i) => {
    const th = document.createElement('th');
    th.textContent = c.replace(/_/g, ' ');
    th.onclick = () => {
      asc = sortCol === i ? !asc : false; sortCol = i;
      data.sort((a, b) => (a[i] > b[i] ? 1 : a[i] < b[i] ? -1 : 0) * (asc ? 1 : -1));
      draw();
    };
    hr.appendChild(th);
  });
  thead.appendChild(hr); table.append(thead, body); draw();
  host.innerHTML = ''; host.appendChild(table);
}

async function renderOverview() {
  const [o] = await api('/api/stats/overview?' + qs());
  const items = [['Solo runs', o.runs], ['Wins', o.wins], ['Win rate', o.win_pct + '%'], ['Avg run (min)', o.avg_minutes]];
  $('overview').innerHTML = items.map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}

function renderTabs() {
  $('tabs').innerHTML = '';
  for (const t of [...tabs, { id: 'sql', title: 'Custom SQL' }]) {
    const b = document.createElement('button');
    b.textContent = t.title;
    if (t.id === curTab) b.className = 'on';
    b.onclick = () => { curTab = t.id; renderTabs(); renderView(); };
    $('tabs').appendChild(b);
  }
}

async function renderView() {
  const host = $('view');
  if (curTab === 'sql') {
    if (!$('sqlBox')) {
      host.innerHTML = `<p class="hint">Read-only. Tables: <code>runs</code> <code>run_cards</code> <code>run_relics</code> <code>card_choices</code> <code>fights</code> <code>events</code>. Join on <code>run_id</code>.</p>
        <textarea id="sqlBox">SELECT character, COUNT(*) AS runs, SUM(win) AS wins FROM runs GROUP BY character</textarea>
        <p><button id="runSql">Run</button></p><div id="sqlOut"></div>`;
      $('runSql').onclick = async () => {
        try { renderTable(await api('/api/sql', { method: 'POST', body: JSON.stringify({ sql: $('sqlBox').value }) }), $('sqlOut')); }
        catch (e) { $('sqlOut').innerHTML = `<div class="err">${e.message}</div>`; }
      };
    }
    return;
  }
  try { renderTable(await api(`/api/stats/${curTab}?` + qs()), host); }
  catch (e) { host.innerHTML = `<div class="err">${e.message}</div>`; }
}

async function fillFilters() {
  const f = await api('/api/filters');
  const [c, a] = [$('fChar').value, $('fAsc').value];
  $('fChar').innerHTML = '<option value="">All</option>' + f.characters.map(x => `<option value="${x}">${pretty(x)}</option>`).join('');
  $('fAsc').innerHTML = '<option value="">All</option>' + f.ascensions.map(x => `<option>${x}</option>`).join('');
  $('fChar').value = c; $('fAsc').value = a;
}

async function updateStatus() {
  const s = await api('/api/status');
  const w = s.watching, st = $('status');
  const multi = s.files.multiplayer ? `, ${s.files.multiplayer} multiplayer skipped` : '';
  if (w.error) { st.textContent = w.error; st.className = 'warn'; }
  else if (w.dir) { st.textContent = `Watching ${w.dir}: ${s.runs} solo runs${multi}`; st.className = 'live'; }
  else { st.textContent = 'No run folder set yet. Click "Run folder".'; st.className = 'warn'; $('settings').hidden = false; }
}

async function refresh() {
  await fillFilters();
  await Promise.all([renderOverview(), renderView(), updateStatus()]);
}

async function importDropped(files) {
  const runs = [];
  for (const f of files) { try { runs.push(JSON.parse(await f.text())); } catch { /* not JSON */ } }
  if (!runs.length) return;
  const r = await api('/api/import', { method: 'POST', body: JSON.stringify(runs) });
  $('status').textContent = `Imported ${r.imported}, duplicates ${r.duplicate}, multiplayer skipped ${r.multiplayer}, invalid ${r.invalid}`;
}

async function main() {
  tabs = await api('/api/tabs');
  renderTabs();
  await refresh();
  ['fChar', 'fAsc', 'fMin'].forEach(id => $(id).addEventListener('change', () => { renderOverview(); renderView(); }));
  $('settingsBtn').onclick = () => { $('settings').hidden = !$('settings').hidden; };
  $('dirSave').onclick = async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ runsDir: $('dirInput').value.trim() }) });
      $('settingsMsg').textContent = 'Saved. Scanning...';
      setTimeout(refresh, 1500);
    } catch (e) { $('settingsMsg').textContent = e.message; }
  };
  document.body.addEventListener('dragover', e => e.preventDefault());
  document.body.addEventListener('drop', e => { e.preventDefault(); importDropped([...e.dataTransfer.files]); });

  // Live updates: the server pushes an event whenever a new run is imported.
  const es = new EventSource('/api/events');
  es.addEventListener('update', refresh);
  es.onerror = () => { $('status').textContent = 'Server connection lost, retrying...'; $('status').className = 'warn'; };
  es.onopen = updateStatus;
  setInterval(updateStatus, 10000);
}
main();
