-- Spire Ledger schema. One row per run in `runs`; everything else hangs off run_id.
-- A multiplayer run is stored from the uploader's side: their character, deck, relics and room stats
-- (see lib/multiplayer.js). player_count, player_id and profiles.steam_id are added to older databases
-- at start-up.

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,      -- seed + ':' + start_time, unique per run
  seed        TEXT,
  character   TEXT NOT NULL,         -- e.g. CHARACTER.REGENT
  ascension   INTEGER NOT NULL DEFAULT 0,
  win         INTEGER NOT NULL,      -- 1 = victory, 0 = loss
  abandoned   INTEGER NOT NULL DEFAULT 0,
  killed_by   TEXT,                  -- encounter or event that ended the run
  run_time    INTEGER,               -- seconds
  start_time  INTEGER,               -- unix seconds
  build_id    TEXT,
  player_count INTEGER NOT NULL DEFAULT 1, -- 1 = solo, 2+ = multiplayer
  player_id   TEXT,                  -- multiplayer: the uploader's Steam id (NULL for solo)
  -- How the run ended, for the run page (NULL on runs imported before it was kept; see migration 5):
  game_mode   TEXT,                  -- standard, daily, custom...
  final_hp    INTEGER,
  max_hp      INTEGER,
  gold        INTEGER,
  potion_slots INTEGER,
  potions     TEXT                   -- potions held at the end, comma separated
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  steam_id      TEXT                 -- learned from the first multiplayer import
);

CREATE TABLE IF NOT EXISTS profile_sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_runs (
  profile_id INTEGER NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, run_id)
);

-- Personal achievement badges a profile has earned, kept even if the requirement grows later (a new
-- character is added): the badge then shows as earned but outdated. See lib/achievements.js.
CREATE TABLE IF NOT EXISTS profile_badges (
  profile_id INTEGER NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  badge_id   TEXT NOT NULL,          -- all_a10 | rotating_streak | speedrunner
  earned_at  INTEGER NOT NULL,       -- ms since epoch (when the site first saw it earned)
  characters TEXT NOT NULL,          -- JSON list of the characters it asked for at the time
  ascension  INTEGER NOT NULL,       -- the ascension it asked for at the time
  PRIMARY KEY (profile_id, badge_id)
);

-- When each start-up chore (lib/db.js) last ran, so a busy site doesn't redo it on every cold start.
CREATE TABLE IF NOT EXISTS maintenance (
  task     TEXT PRIMARY KEY,
  last_run INTEGER NOT NULL          -- ms since epoch
);

-- Fixed-window request counters used for rate limiting.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,     -- ms since epoch
  count        INTEGER NOT NULL
);

-- Final deck of each run (upgrade level, and the floor the card was added).
CREATE TABLE IF NOT EXISTS run_cards (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,
  upgrade     INTEGER NOT NULL DEFAULT 0,
  floor_added INTEGER NOT NULL DEFAULT 0,    -- 1 = starter card
  enchantment TEXT                           -- e.g. ENCHANTMENT.SLITHER (NULL = none, or not known)
);

-- Relics held at the end of each run.
CREATE TABLE IF NOT EXISTS run_relics (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  relic_id    TEXT NOT NULL,
  floor_added INTEGER NOT NULL DEFAULT 0,
  origin      TEXT                           -- NEOW | ANCIENT_<NAME> | SHOP | ELITE | ... (see lib/relics.js)
);

-- Every card reward / shop offer and whether it was taken.
CREATE TABLE IF NOT EXISTS card_choices (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  floor    INTEGER NOT NULL,
  source   TEXT NOT NULL,            -- map point type: monster, elite, boss, shop...
  card_id  TEXT NOT NULL,
  picked   INTEGER NOT NULL
);

-- The area (act) each run passed through: OVERGROWTH or UNDERDOCKS, then HIVE, then GLORY.
-- act is the 1-based act number, matching fights.act and events.act.
CREATE TABLE IF NOT EXISTS run_acts (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  act    INTEGER NOT NULL,
  area   TEXT NOT NULL,
  PRIMARY KEY (run_id, act)
);

-- Everyone who played in a multiplayer run (the uploader included), in the file's player order.
CREATE TABLE IF NOT EXISTS run_players (
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  slot      INTEGER NOT NULL,
  player_id TEXT NOT NULL,           -- Steam id
  character TEXT,
  PRIMARY KEY (run_id, slot)
);

-- Steam display names of teammates, looked up by lib/steam.js and refreshed weekly.
CREATE TABLE IF NOT EXISTS steam_names (
  steam_id   TEXT PRIMARY KEY,
  name       TEXT,                   -- NULL = Steam gave no name
  fetched_at INTEGER NOT NULL        -- ms since epoch
);

-- Every combat. died = 1 when HP reached 0 in that room.
CREATE TABLE IF NOT EXISTS fights (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  floor        INTEGER NOT NULL,
  act          INTEGER NOT NULL,
  type         TEXT NOT NULL,        -- monster | elite | boss
  encounter_id TEXT,
  monsters     TEXT,
  turns        INTEGER,
  damage       INTEGER,
  hp_after     INTEGER,
  died         INTEGER NOT NULL
);

-- Every room of the map in order, for the run page (lib/run-detail.js). Floors count map points from 1,
-- like fights.floor. detail is a small JSON object of what happened there (see roomDetail in
-- lib/importer.js). Runs imported before this table existed have no rows until imported again.
CREATE TABLE IF NOT EXISTS run_rooms (
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  floor     INTEGER NOT NULL,
  act       INTEGER NOT NULL,
  map_type  TEXT,                    -- what the map showed: monster, elite, boss, unknown, shop, ancient...
  room_type TEXT,                    -- what it turned out to be: monster, event, treasure...
  model_id  TEXT,                    -- encounter or event id
  hp        INTEGER,                 -- after the room
  max_hp    INTEGER,
  gold      INTEGER,
  detail    TEXT,
  PRIMARY KEY (run_id, floor)
);

-- Every event room and the choice(s) made in it.
CREATE TABLE IF NOT EXISTS events (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  floor    INTEGER NOT NULL,
  act      INTEGER NOT NULL,
  event_id TEXT,
  choice   TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_acts_area ON run_acts(area);
-- Speed up the statistics queries, which join these tables to runs by run_id.
CREATE INDEX IF NOT EXISTS idx_choices_run    ON card_choices(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_abandoned ON runs(abandoned);
CREATE INDEX IF NOT EXISTS idx_cards_card    ON run_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_cards_run     ON run_cards(run_id);
CREATE INDEX IF NOT EXISTS idx_relics_relic  ON run_relics(relic_id);
CREATE INDEX IF NOT EXISTS idx_relics_run    ON run_relics(run_id);
CREATE INDEX IF NOT EXISTS idx_choices_card  ON card_choices(card_id);
CREATE INDEX IF NOT EXISTS idx_fights_enc    ON fights(encounter_id);
CREATE INDEX IF NOT EXISTS idx_fights_run    ON fights(run_id);
CREATE INDEX IF NOT EXISTS idx_events_event  ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_run    ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_profile_sessions_expiry ON profile_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_run_players_player ON run_players(player_id);
CREATE INDEX IF NOT EXISTS idx_profile_runs_run ON profile_runs(run_id);
