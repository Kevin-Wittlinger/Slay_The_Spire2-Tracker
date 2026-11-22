// Rebuilds public/relic-info.json (relic rarity and description text) from the Slay the Spire wiki.
//
//   npm run update:relics
//
// The wiki keeps every relic in a public "Relics" Cargo table. This asks it for the Slay the Spire 2
// rows, turns the wiki markup in each description into plain text, and writes one entry per relic:
//   "RELIC.BURNING_BLOOD": ["Starter", "At the end of combat, heal 6 HP."]
// The page shows that text in the relic popup (public/app.js). Run it after a game patch adds or
// changes relics, then commit the file. It only reads from the wiki, never writes to it.
//
// Descriptions come from wiki editors, so the page only ever shows them as plain text (never as HTML).

const fs = require("fs");
const path = require("path");

const API = "https://slaythespire.wiki.gg/api.php";
const OUT = path.join(__dirname, "..", "public", "relic-info.json");
const ICONS = path.join(__dirname, "..", "public", "img", "relics");
const PAGE = 100;

// Icons that have no text beside them in a description, by the wiki's data-name for the icon.
// Anything not listed here uses the data-name itself (Vigor, Gold, Channel...).
const ICON_WORDS = { "@ST": "Star", "@E": "Energy", "@EN": "Energy" };

async function fetchRows() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = new URL(API);
    url.search = new URLSearchParams({
      action: "cargoquery",
      tables: "Relics",
      fields: "Name,Rarity,Description",
      where: "Game='2'",
      limit: String(PAGE),
      offset: String(offset),
      format: "json",
    });
    const res = await fetch(url, { headers: { "User-Agent": "sts2-tracker-fan-site (relic data refresh)" } });
    if (!res.ok) throw new Error(`The wiki answered ${res.status}`);
    const body = await res.json();
    if (!body.cargoquery) throw new Error(`Unexpected wiki answer: ${JSON.stringify(body).slice(0, 200)}`);
    rows.push(...body.cargoquery.map((r) => r.title));
    if (body.cargoquery.length < PAGE) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1500)); // be gentle with the wiki
  }
}

// [[File:x.png|22px]] -> nothing, [[Page|Text]] -> Text, [[Page]] -> Page,
// [https://site Text] -> Text, ''italic'' -> italic.
const resolveLinks = (text) =>
  text
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "");

// "@CE" and "@NE" are the wiki's marker for the energy icon, and a run of them is that much energy:
// "lose @CE@CE" -> "lose 2 Energy". A lone one after "additional" reads best as just "Energy".
const energy = (text) =>
  text.replace(/(?:@(?:CE|NE)\s*)+/g, (run, offset) => {
    const count = (run.match(/@(?:CE|NE)/g) || []).length;
    const before = text.slice(Math.max(0, offset - 12), offset);
    return `${count === 1 && /additional\s$/.test(before) ? "" : `${count} `}Energy `;
  });

// "7 Star" -> "7 Stars" (the icon-only span is written as the word "Star").
const pluralStars = (text) => text.replace(/\b(\d+) Star\b/g, (m, n) => (Number(n) === 1 ? m : `${n} Stars`));

// Wiki markup -> one plain-text line.
function toPlainText(wikitext) {
  let text = wikitext.replace(/<br\s*\/?>/gi, " ");
  // Innermost <span> first. A span that is only an icon is written as the icon's name.
  const innermost = /<span\b([^>]*)>((?:(?!<span\b)[\s\S])*?)<\/span>/i;
  while (innermost.test(text)) {
    text = text.replace(innermost, (_, attrs, inner) => {
      const inside = resolveLinks(inner).trim();
      const name = attrs.match(/data-name\s*=\s*['"]([^'"]+)['"]/i)?.[1];
      return inside || (name ? ICON_WORDS[name] || name : "");
    });
  }
  return pluralStars(energy(resolveLinks(text)))
    .replace(/<[^>]*>/g, "") // anything left that looks like a tag
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

// "Burning Blood" -> "RELIC.BURNING_BLOOD"; "Pael's Claw" -> "RELIC.PAELS_CLAW".
const relicId = (name) =>
  `RELIC.${name.replace(/['’]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase()}`;

async function main() {
  const rows = await fetchRows();
  const info = {};
  for (const row of rows) {
    const description = toPlainText(row.Description || "");
    if (!row.Name || !description) continue;
    info[relicId(row.Name)] = [row.Rarity || "", description];
    // The wiki says "The Abacus" where the game id is RELIC.ABACUS, so both spellings are kept.
    if (/^The /i.test(row.Name)) info[relicId(row.Name.replace(/^The /i, ""))] ||= [row.Rarity || "", description];
  }
  const ids = Object.keys(info).sort();
  fs.writeFileSync(OUT, `{\n${ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(info[id])}`).join(",\n")}\n}\n`);
  console.log(`Wrote ${ids.length} relics to ${path.relative(process.cwd(), OUT)}.`);

  // Relics the site has a picture for but the wiki gave no text for (usually a naming difference).
  const have = new Set(ids);
  const missing = fs.readdirSync(ICONS).filter((f) => f.endsWith(".png")).map((f) => `RELIC.${f.slice(0, -4).toUpperCase()}`).filter((id) => !have.has(id));
  if (missing.length) console.log(`No description for ${missing.length} relic picture(s): ${missing.join(", ")}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { toPlainText, relicId };
