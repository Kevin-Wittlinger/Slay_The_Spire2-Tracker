-- Spire Ledger schema. One row per SOLO run in `runs`; everything else hangs off run_id.

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
  build_id    TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
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
  floor_added INTEGER NOT NULL DEFAULT 0     -- 1 = starter card
);

-- Relics held at the end of each run.
CREATE TABLE IF NOT EXISTS run_relics (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  relic_id    TEXT NOT NULL,
  floor_added INTEGER NOT NULL DEFAULT 0
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

-- Every event room and the choice(s) made in it.
CREATE TABLE IF NOT EXISTS events (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  floor    INTEGER NOT NULL,
  act      INTEGER NOT NULL,
  event_id TEXT,
  choice   TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_acts_area ON run_acts(area);
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
CREATE INDEX IF NOT EXISTS idx_profile_runs_run ON profile_runs(run_id);
