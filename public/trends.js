"use strict";
// Trends tab: two stacked SVG line charts (no libraries).
//   Top:    win rate over all runs, after each run ("so far").
//   Bottom: zoomed to the latest 50 runs; each point is the win rate over the 10 runs up to it.
// Both support hover tooltips and, in "By character" mode, one line per character.
// buildTrends() is pure so it can be tested in Node; renderTrends() needs the page helpers
// from app.js (el, characterLogo, characterSlug, sortCharacters, pretty, nf, emptyMessage).

const TRENDS_RECENT = 50; // runs shown in the bottom chart
const TRENDS_FORM = 10; // runs in each point of the bottom chart
const TRENDS_COLORS = {
  ironclad: "#ef6b6b",
  silent: "#8be04a",
  regent: "#f2ab3c",
  necrobinder: "#e08fec",
  defect: "#7cc4ea",
  fool: "#e9ecf2",
};
const TRENDS_SPARE_COLORS = ["#9aa7ff", "#ffb38a", "#7fe0c2", "#e3d36b"];
const COLOR_ALL = "#e0b04a";
const COLOR_RECENT = "#6ab0ff";

const trendsState = { mode: "overall", hidden: new Set(), last: null };

// Adds one run to a series and returns its new point. `wins` holds every result so far,
// so the "form" value can look back over the last `formWindow` runs of that series.
function pushPoint(series, i, t, win, formWindow) {
  series.results.push(win);
  series.n++;
  series.wins += win;
  const span = Math.min(formWindow, series.n);
  let recentWins = 0;
  for (let k = series.n - span; k < series.n; k++)
    recentWins += series.results[k];
  const point = {
    i,
    n: series.n,
    wins: series.wins,
    t,
    rate: (100 * series.wins) / series.n,
    form: (100 * recentWins) / span,
    formRuns: span,
  };
  series.points.push(point);
  return point;
}

// rows: [{start_time, character, win}] oldest first.
function buildTrends(rows, formWindow = TRENDS_FORM) {
  const blank = (character) => ({
    character,
    points: [],
    results: [],
    wins: 0,
    n: 0,
  });
  const overall = blank(null);
  const byCharacter = new Map();
  rows.forEach((row, i) => {
    const win = Number(row.win) ? 1 : 0;
    const t = row.start_time ?? null;
    pushPoint(overall, i, t, win, formWindow);
    if (!byCharacter.has(row.character))
      byCharacter.set(row.character, blank(row.character));
    pushPoint(byCharacter.get(row.character), i, t, win, formWindow);
  });
  const order =
    typeof sortCharacters === "function"
      ? sortCharacters
      : (list) => [...list].sort();
  return {
    total: rows.length,
    overall: overall.points,
    characters: order([...byCharacter.keys()]).map((id) => {
      const { character, points, wins, n } = byCharacter.get(id);
      return { character, points, wins, n };
    }),
  };
}

function trendsColor(character, index) {
  const slug =
    typeof characterSlug === "function" ? characterSlug(character) : "";
  return (
    TRENDS_COLORS[slug] ||
    TRENDS_SPARE_COLORS[index % TRENDS_SPARE_COLORS.length]
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  node.append(...children.filter((child) => child != null));
  return node;
}

const pct1 = (value) => `${value.toFixed(1)}%`;

function trendsDate(seconds, withYear) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function swatch(color) {
  const node = el("i", { class: "swatch" });
  node.style.setProperty("background", color);
  return node;
}

// Draws one chart. config:
//   title, subtitle  - heading text
//   series           - [{id, label, color, points, valueOf, width, character?}]
//   start            - first run index on the x axis (0 for all runs)
//   detail(p)        - extra tooltip text after the value, e.g. " (12/20)"
function drawChart(data, config, width) {
  const { series, start } = config;
  const height = width < 520 ? 230 : 290;
  const pad = { l: 46, r: 16, t: 12, b: 42 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const lastIndex = data.total - 1;
  const span = lastIndex - start;
  const xAt = (i) => pad.l + (span ? ((i - start) / span) * plotW : plotW / 2);
  const yAt = (rate) => pad.t + (1 - rate / 100) * plotH;

  const svg = svgEl("svg", {
    class: "trend-svg",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": config.title,
  });

  // grid + y axis
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(
      svgEl("line", {
        class: v === 50 ? "grid mid" : "grid",
        x1: pad.l,
        x2: width - pad.r,
        y1: yAt(v),
        y2: yAt(v),
      }),
      svgEl(
        "text",
        { class: "axis", x: pad.l - 8, y: yAt(v) + 4, "text-anchor": "end" },
        `${v}%`,
      ),
    );
  }

  // x axis: run number, with the date underneath
  const inRange = data.overall.slice(start);
  const firstT = inRange.find((p) => p.t)?.t;
  const lastT = [...inRange].reverse().find((p) => p.t)?.t;
  const withYear = Boolean(firstT && lastT && lastT - firstT > 330 * 86400);
  const tickCount = Math.min(width < 520 ? 3 : 6, span + 1);
  for (let k = 0; k < tickCount; k++) {
    const i =
      tickCount === 1
        ? start
        : start + Math.round((k / (tickCount - 1)) * span);
    const anchor = k === 0 ? "start" : k === tickCount - 1 ? "end" : "middle";
    svg.append(
      svgEl(
        "text",
        { class: "axis", x: xAt(i), y: height - 22, "text-anchor": anchor },
        `Run ${i + 1}`,
      ),
      svgEl(
        "text",
        { class: "axis dim", x: xAt(i), y: height - 8, "text-anchor": anchor },
        trendsDate(data.overall[i].t, withYear),
      ),
    );
  }

  // lines (only the part inside the visible run range)
  const visible = series
    .filter((s) => !trendsState.hidden.has(s.id))
    .map((s) => ({ ...s, points: s.points.filter((p) => p.i >= start) }))
    .filter((s) => s.points.length);
  for (const s of visible) {
    const d = s.points
      .map(
        (p, k) =>
          `${k ? "L" : "M"}${xAt(p.i).toFixed(1)} ${yAt(s.valueOf(p)).toFixed(1)}`,
      )
      .join("");
    const end = s.points[s.points.length - 1];
    svg.append(
      svgEl("path", {
        class: "trend-line",
        d,
        stroke: s.color,
        "stroke-width": s.width,
      }),
      svgEl("circle", {
        cx: xAt(end.i),
        cy: yAt(s.valueOf(end)),
        r: 3.5,
        fill: s.color,
      }),
    );
  }

  // hover
  const guide = svgEl("line", {
    class: "guide",
    y1: pad.t,
    y2: pad.t + plotH,
    visibility: "hidden",
  });
  const dots = svgEl("g");
  const tip = el("div", { class: "trend-tip" });
  tip.hidden = true;
  const pointAt = (s, i) => {
    let found = null;
    for (const p of s.points) {
      if (p.i > i) break;
      found = p;
    }
    return found;
  };
  const showAt = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) * (width / (rect.width || width));
    const i = Math.max(
      start,
      Math.min(lastIndex, start + Math.round(((px - pad.l) / plotW) * span)),
    );
    guide.setAttribute("x1", xAt(i));
    guide.setAttribute("x2", xAt(i));
    guide.setAttribute("visibility", "visible");
    dots.replaceChildren();
    const date = trendsDate(data.overall[i].t, true);
    const lines = [
      el("div", {
        class: "tip-title",
        text: `Run ${i + 1}${date ? ` · ${date}` : ""}`,
      }),
    ];
    for (const s of visible) {
      const p = pointAt(s, i);
      if (!p) continue;
      dots.append(
        svgEl("circle", {
          cx: xAt(p.i),
          cy: yAt(s.valueOf(p)),
          r: 4,
          fill: s.color,
          stroke: "#12141a",
          "stroke-width": 1.5,
        }),
      );
      lines.push(
        el(
          "div",
          {},
          swatch(s.color),
          `${s.label}: `,
          el("b", { text: pct1(s.valueOf(p)) }),
          config.detail(p),
        ),
      );
    }
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const left = Math.min(
      Math.max(xAt(i) + 12, 4),
      Math.max(4, width - tip.offsetWidth - 4),
    );
    tip.style.setProperty("left", `${left}px`);
    tip.style.setProperty("top", `${pad.t}px`);
  };
  const hide = () => {
    guide.setAttribute("visibility", "hidden");
    dots.replaceChildren();
    tip.hidden = true;
  };
  const overlay = svgEl("rect", {
    x: pad.l,
    y: pad.t,
    width: plotW,
    height: plotH,
    fill: "transparent",
  });
  overlay.addEventListener("pointermove", (event) => showAt(event.clientX));
  overlay.addEventListener("pointerleave", hide);
  svg.append(guide, dots, overlay);

  return el(
    "section",
    { class: "trend-chart" },
    el(
      "h3",
      { class: "trend-title" },
      config.swatchColor ? swatch(config.swatchColor) : null,
      config.title,
      el("span", { class: "trend-sub", text: config.subtitle }),
    ),
    el("div", { class: "trend-canvas" }, svg, tip),
  );
}

function renderTrends(rows, host, options = {}) {
  trendsState.last = { rows, host, options };
  host.replaceChildren();
  if (rows.length < 2) {
    host.append(
      el("div", {
        class: "empty",
        text: rows.length
          ? "Trends need at least 2 runs. Play or import a few more."
          : emptyMessage(),
      }),
    );
    return;
  }

  const data = buildTrends(rows);
  const canSplit = !options.character && data.characters.length > 1;
  const mode = canSplit ? trendsState.mode : "overall";
  const last = data.overall[data.total - 1];
  const start = Math.max(0, data.total - TRENDS_RECENT);
  const recentWins =
    last.wins - (start ? data.overall[start - 1].wins : 0);
  const recentRuns = data.total - start;
  const rerender = () => renderTrends(rows, host, options);
  const wrap = el("div", { class: "trend-wrap" });

  // ----- header: summary + mode switch -----
  const header = el(
    "div",
    { class: "trend-head" },
    el(
      "div",
      { class: "trend-summary" },
      el("span", {}, el("b", { text: nf.format(data.total) }), " runs"),
      el("span", {}, el("b", { text: pct1(last.rate) }), " all-time win rate"),
      el(
        "span",
        {},
        el("b", { text: pct1((100 * recentWins) / recentRuns) }),
        ` over the last ${recentRuns}`,
      ),
    ),
  );
  if (canSplit) {
    const group = el("div", {
      class: "trend-mode",
      role: "group",
      "aria-label": "Chart view",
    });
    for (const [value, label] of [
      ["overall", "Overall"],
      ["split", "By character"],
    ]) {
      group.append(
        el("button", {
          type: "button",
          "aria-pressed": String(mode === value),
          text: label,
          onclick: () => {
            trendsState.mode = value;
            if (typeof writeHash === "function") writeHash();
            rerender();
          },
        }),
      );
    }
    header.append(group);
  }
  wrap.append(header);

  // ----- shared legend (By character: click a character to hide or show its lines) -----
  if (mode === "split") {
    const legend = el("div", { class: "trend-legend" });
    data.characters.forEach((c, index) => {
      const color = trendsColor(c.character, index);
      const off = trendsState.hidden.has(c.character);
      const logo = characterLogo(c.character, 0.5);
      const button = el(
        "button",
        {
          type: "button",
          class: "legend-item",
          "aria-pressed": String(!off),
          title: "Click to hide or show this character in both charts",
        },
        swatch(color),
        logo || pretty(c.character),
        el("span", {
          class: "legend-rate",
          text: ` ${pct1(c.points[c.points.length - 1].rate)} · ${c.n} ${c.n === 1 ? "run" : "runs"}`,
        }),
      );
      button.addEventListener("click", () => {
        if (off) trendsState.hidden.delete(c.character);
        else trendsState.hidden.add(c.character);
        rerender();
      });
      legend.append(button);
    });
    wrap.append(legend);
  }

  // ----- the two charts -----
  const width = Math.max(
    300,
    Math.floor((host.clientWidth || 800) - 34), // minus the panel padding
  );
  const makeSeries = (valueOf, overallColor, overallLabel, overallWidth) =>
    mode === "overall"
      ? [
          {
            id: "overall",
            label: overallLabel,
            color: overallColor,
            points: data.overall,
            valueOf,
            width: overallWidth,
          },
        ]
      : data.characters.map((c, index) => ({
          id: c.character,
          label: pretty(c.character),
          color: trendsColor(c.character, index),
          points: c.points,
          valueOf,
          width: 2.2,
        }));

  wrap.append(
    drawChart(
      data,
      {
        title: "Win rate over all runs",
        subtitle: "after each run, from your first run to now",
        swatchColor: mode === "overall" ? COLOR_ALL : null,
        start: 0,
        series: makeSeries((p) => p.rate, COLOR_ALL, "Win rate so far", 2.6),
        detail: (p) => ` (${p.wins}/${p.n})`,
      },
      width,
    ),
    drawChart(
      data,
      {
        title: `Last ${recentRuns} runs`,
        subtitle: `each point is the win rate of the ${TRENDS_FORM} runs up to it`,
        swatchColor: mode === "overall" ? COLOR_RECENT : null,
        start,
        series: makeSeries(
          (p) => p.form,
          COLOR_RECENT,
          `Last ${TRENDS_FORM} runs`,
          2.6,
        ),
        detail: (p) => ` (last ${p.formRuns})`,
      },
      width,
    ),
    el("p", {
      class: "hint",
      text:
        canSplit && mode === "overall"
          ? "Use the filters above to narrow by character, ascension or patch, or switch to By character to compare them."
          : "Use the filters above to narrow by ascension or patch. Hover a chart for exact numbers.",
    }),
  );
  host.append(wrap);
}

// Redraw at the new width when the window is resized.
if (typeof window !== "undefined") {
  let timer;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const last = trendsState.last;
      if (
        last &&
        last.host.isConnected &&
        last.host.querySelector(".trend-wrap")
      )
        renderTrends(last.rows, last.host, last.options);
    }, 150);
  });
}

if (typeof module !== "undefined") module.exports = { buildTrends };
