// Downloads the Slay the Spire 2 map icons from the wiki into public/img/map/.
//
//   npm run update:map-icons
//
// The wiki names them "StS2_Map-<Name>.png": the room types (Monster, Elite, Event, Merchant, RestSite,
// Treasure, Boss), one per boss (Aeonglass, TheKin...) and one per Ancient (Neow, Darv...). Each is saved
// lowercase without separators (StS2_Map-TheKin.png -> thekin.png), which is how the run page looks them
// up (public/app.js, mapIcon). Run it after a patch adds a boss or an Ancient; a missing picture just
// falls back to the plain room icon. It only reads from the wiki and skips files it already has.

const fs = require("fs");
const path = require("path");

const API = "https://slaythespire.wiki.gg/api.php";
const OUT = path.join(__dirname, "..", "public", "img", "map");
const HEADERS = { "User-Agent": "sts2-tracker-fan-site (map icon refresh)" };
const PREFIX = "StS2_Map-";

// "StS2_Map-TheKin.png" -> "thekin.png"
const fileName = (wikiName) => `${wikiName.slice(PREFIX.length, -4).replace(/[^A-Za-z0-9]/g, "").toLowerCase()}.png`;

async function listImages() {
  const url = new URL(API);
  url.search = new URLSearchParams({
    action: "query",
    list: "allimages",
    aiprefix: PREFIX,
    ailimit: "500",
    format: "json",
  });
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`The wiki answered ${res.status}`);
  const body = await res.json();
  return (body.query?.allimages || []).filter((img) => /\.png$/i.test(img.name));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const images = await listImages();
  let added = 0;
  for (const img of images) {
    const target = path.join(OUT, fileName(img.name));
    if (fs.existsSync(target)) continue;
    const res = await fetch(img.url, { headers: HEADERS });
    if (!res.ok) {
      console.log(`Skipped ${img.name} (${res.status})`);
      continue;
    }
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    added++;
    await new Promise((resolve) => setTimeout(resolve, 300)); // be gentle with the wiki
  }
  console.log(`${images.length} map icons on the wiki, ${added} new saved to ${path.relative(process.cwd(), OUT)}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { fileName };
