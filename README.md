# Spire Ledger

Solo run statistics for Slay the Spire 2, stored in SQLite and shown on a local website.

## Setup

1. Install Node.js 18 or newer (the current LTS is fine).
2. In this folder, run:

       npm install
       npm start

3. Open http://localhost:3000
4. Click **Run folder** and paste the folder that holds your `.run` files, then **Save and scan**.
   (Tip: search your game save folder for `*.run`. Subfolders are scanned too.)

You can also skip the website step: `node server.js "C:\path\to\your\runs"`.
The folder is remembered in `config.json`.

## What it does

- **Imports every existing run** in the folder on the first scan (it can take a few seconds for large histories).
- **Keeps watching.** The server checks the folder every 3 seconds. When a new run file appears, it is imported
  and every open browser tab refreshes itself automatically. Keep the server running while you play.
- **Solo only.** Any file with more than one player is skipped and counted as "multiplayer skipped" in the status line.
- **No double counting.** A run is identified by seed plus start time, and each file's modified time is remembered,
  so restarts and re-scans are safe.
- Abandoned runs are excluded from all stats.

## Files

| File | Purpose |
| --- | --- |
| `db/schema.sql` | Table definitions (runs, run_cards, run_relics, card_choices, fights, events, imported_files) |
| `db/queries.js` | Every statistic as a SQL query |
| `lib/importer.js` | Parses one `.run` file into rows, rejects multiplayer |
| `lib/watcher.js` | Scans the folder and imports new files |
| `lib/db.js` | Opens the SQLite file and applies the schema |
| `server.js` | HTTP API, live updates (server-sent events), serves the site |
| `public/` | The website (HTML, CSS, JS) |
| `test/smoke.js` | `npm test` |

The database lives at `data/spire-ledger.db`. Delete it to start fresh (files are re-imported on the next scan).

## The database download button

The old browser-only version kept its database inside the browser, so "Export .sqlite" let you save a copy.
Now the database is already a real file in `data/`, so the **Download database** link is just a convenience:
a backup, or a way to open your data in a tool like DB Browser for SQLite. You never need it for the site to work.

## Custom SQL

The **Custom SQL** tab runs read-only queries, for example:

    SELECT card_id, COUNT(*) AS times_picked
    FROM card_choices WHERE picked = 1
    GROUP BY card_id ORDER BY times_picked DESC;

## Notes

- The server only listens on your own machine (127.0.0.1).
- Win rate for a card or relic means: of the runs that ended with it, the share that were wins.
  Starter cards are left out of card stats. Small samples are noisy, so raise "Min sample".
- Event stats are the win rate of runs that encountered the event, which is correlation, not proof the choice helped.
