"use strict";
// Slay the Spire 2 content the site needs to know about, in one place. The page loads this file as a
// script (it defines GAME_DATA) and the server requires it, so both always agree.
//
// When the game adds content, update it here:
//   - a character: add it to `characters` (the position sets its display order everywhere), then add
//     img/characters/<slug>.png (logo, sized as `logo`) and img/heads/<slug>.png (Trends chart icon).
//   - an area / act: add it to `areas`.
//   - an Ancient (act 2 or 3 relic event): add its name to `ancients`.
//   - a multiplayer-only card: add it to `coopCards`.
//   - a higher ascension: raise `maxAscension` and add img/ascension/<level>.png.
// Ids are the game's own, without the "CHARACTER." / "RELIC." / "CARD." prefix.

const GAME_DATA = {
  // In display order. color: Trends chart line. logo: [width, height] in CSS pixels of the banner in
  // img/characters/ (trimmed so the lettering is the same size in every logo).
  characters: [
    { id: "IRONCLAD", name: "Ironclad", color: "#ef6b6b", logo: [130, 20], startingRelic: "BURNING_BLOOD" },
    { id: "SILENT", name: "Silent", color: "#8be04a", logo: [121, 23], startingRelic: "RING_OF_THE_SNAKE" },
    { id: "REGENT", name: "Regent", color: "#f2ab3c", logo: [124, 30], startingRelic: "DIVINE_RIGHT" },
    { id: "NECROBINDER", name: "Necrobinder", color: "#e08fec", logo: [177, 27], startingRelic: "BOUND_PHYLACTERY" },
    { id: "DEFECT", name: "Defect", color: "#7cc4ea", logo: [126, 26], startingRelic: "CRACKED_CORE" },
    { id: "FOOL", name: "Fool", color: "#e9ecf2", logo: [97, 20], startingRelic: "SONG_BOW" },
  ],

  // Areas in play order. Areas that share an act are alternatives (a run visits one of them).
  // The id is the run file's "ACT.<ID>", stored in run_acts.area.
  areas: [
    { id: "OVERGROWTH", name: "Overgrowth", act: 1 },
    { id: "UNDERDOCKS", name: "Underdocks", act: 1 },
    { id: "HIVE", name: "Hive", act: 2 },
    { id: "GLORY", name: "Glory", act: 3 },
  ],

  // Act 2 and 3 Ancients (Neow is act 1's). Stored as relic origin ANCIENT_<NAME IN CAPS>.
  ancients: ["Tezcatara", "Tanx", "Vakuu", "Orobas", "Darv", "Nonupeipe", "Pael"],

  // Cards that only exist in multiplayer (they help or target a teammate).
  coopCards: [
    "BEACON_OF_HOPE", "BELIEVE_IN_YOU", "COORDINATE", "DEMONIC_SHIELD", "ENERGY_SURGE",
    "FLANKING", "GANG_UP", "GLIMPSE_BEYOND", "HAMMER_TIME", "HUDDLE_UP", "IGNITION",
    "INTERCEPT", "KNOCKDOWN", "LARGESSE", "LEGION_OF_BONE", "LIFT", "MIMIC", "RALLY",
    "SNEAKY", "TAG_TEAM", "TANK",
  ],

  // Highest ascension. Personal achievements ask for wins at this level.
  maxAscension: 10,
};

// "CHARACTER.THE_SILENT" -> "silent". Used for image file names and to match game data.
function characterSlug(value) {
  return String(value)
    .replace(/^CHARACTER\./, "")
    .replace(/^THE_/, "")
    .toLowerCase();
}

if (typeof module !== "undefined") module.exports = { GAME_DATA, characterSlug };
