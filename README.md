# STS2 TRACKER

Solo and multiplayer run statistics for Slay the Spire 2.

Create a profile or sign in, then choose **Import Run Folder** and select the folder that contains your `.run` files.
On Windows it is in AppData:

    %AppData%\SlayTheSpire2\steam\<your Steam ID>\profile1\saves

## Profiles

The home view combines every unique run in the database. Create a profile to import runs and switch between the
combined view and **My Profile**. A run is stored once by seed and start time; importing it again to the same
profile is counted as a duplicate. If another profile imports that run, it is linked to that profile without
creating a second global run.

Use the **Find a player** box to look up any profile and view their stats. Filters, tab, and whose runs you are
viewing are kept in the page URL, so a link can be shared or reloaded.

Run files already in the global database can be re-uploaded after creating a profile to include them in that
profile's stats. Passwords are stored as salted scrypt hashes, and sign-in uses an expiring secure cookie. There is
currently no password-reset flow.

## Personal achievements

Signed-in players get a **Personal achievements** button next to **My profile**. It shows three badges, worked out from
their own runs (abandoned runs don't count):

| Badge               | How to earn it                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| **All A10**         | Win on ascension 10 with every character.                                             |
| **Rotating Streak** | Win on ascension 10 with every character in a row, each one once. Any loss or lower-ascension run in between restarts the streak, and so does a second win with a character already in it (the streak then carries on from just after that character's earlier win). |
| **Speedrunner**     | Win a run in under 20 minutes, on any ascension.                                      |

"Every character" means every character anyone has played on the site, so a new character joins the requirement as
soon as someone imports a run with it. The rules are in `lib/achievements.js`.

## What it does

- **Imports selected `.run` files** from a folder in small batches. Repeated imports are safe.
- **Stores cloud data in Turso** so imported runs remain available between Vercel function calls.
- **Solo and multiplayer.** The **Mode** filter shows solo runs (the default), multiplayer runs, or both. A
  multiplayer run is stored from the uploader's side (their character, deck, relics, card picks and fights), so
  multiplayer-only cards (tagged "Co-op") show up in the card tables. **Recent runs** lists who you played with and
  your win rate with each of them, and the **Teammates** tab sums it up per teammate. Run files only hold Steam ids,
  so the uploader's id comes from the Steam folder in the path, or as the one player in all the selected multiplayer
  runs; it is then remembered on the profile. A teammate shows by username once they import their own runs here, otherwise by their Steam name (looked up by the server and cached for a week; set `STEAM_API_KEY` to use the Steam Web API instead of reading public profile pages),
  and always links to their Steam profile when they have no site profile. Personal achievements stay solo only.
- **No double counting.** A run is identified by seed plus start time (plus the uploader's Steam id for
  multiplayer), so repeated uploads are safe.
- Abandoned runs are excluded from all stats and counts. They are stored, and the **Abandoned** card on the overview
  shows how many there are, so a player's imported total can be larger than the runs shown.

## Files

| File               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `db/schema.sql`    | Tables for profiles, sessions, unique runs, and run details |
| `db/queries.js`    | Every statistic as a SQL query                              |
| `lib/importer.js`  | Parses one `.run` file into rows (solo or multiplayer)      |
| `lib/multiplayer.js` | Steam ids, finding the uploader, multiplayer migrations   |
| `lib/db.js`        | Opens local SQLite or remote Turso                          |
| `lib/handler.js`   | Profile auth and shared API routes                          |
| `lib/ratelimit.js` | Database-backed rate limiter                                |
| `api/index.js`     | Vercel Function entry point                                 |
| `server.js`        | Local development server                                    |
| `public/`          | The website (HTML, CSS, JS)                                 |
| `test/smoke.js`    | `npm test`                                                  |

Locally, the database lives at `data/spire-ledger.db`. Production data is stored in Turso.

## Trends

The **Trends** tab has two charts. The top one is your win rate over every run, after each run. The bottom one zooms in
on your latest 50 runs, where each point is the win rate of the 10 runs up to it. **By character** draws one line per
character in both charts, and clicking a character in the legend hides or shows it. The character, ascension and patch
filters apply, and hovering a chart shows the win rate at any run.

## Filters

Character, ascension, **patch** (the game build a run was played on) and minimum sample filter every tab. They are
kept in the page URL.

The **area** filter (Overgrowth, Underdocks, Hive, Glory) keeps runs that actually entered that area. Overgrowth and
Underdocks are the two alternatives for act 1. Enemy, boss and event tabs only count rooms fought inside that area.
Areas come from the `acts` list in each `.run` file. Runs imported before this filter existed get their areas
worked out when the server starts (`lib/areas.js`): acts 2 and 3 are Hive and Glory, and act 1 is Overgrowth or Underdocks
depending on which act-1 enemies the run fought, learned from runs that already have their areas. A run whose enemies
are unknown is skipped until its folder is imported again (nothing is duplicated).

The **Relic WR** tab has a source dropdown in its table toolbar: Neow, all Ancients, or one Ancient (Tezcatara, Tanx,
Vakuu, Orobas, Darv, Nonupeipe, Pael), or **No Neow or Ancients** for every other relic. The origin of every relic is stored in `run_relics.origin`, read from the room
type of the floor that gave it (`lib/relics.js`). The database also keeps shop, elite, boss, treasure, event and rest
site origins, and the API accepts them (`?source=SHOP`), but the dropdown doesn't offer them. Runs imported before the
column existed are filled in when the server starts, from the fights, events and card offers the database kept. That
cannot tell a treasure chest from a rest site, so those show as treasure until the run is imported again.

On the Enemies and Killed by tabs, a **Weak** encounter is from the easier pool of regular fights met early in an act;
**Normal** is the harder pool met later.

## Analytics

The site loads one Google tag, the container `GTM-PTM5ZFBX` (set in `public/analytics.js`), which reports to Google
Analytics 4. What it measures is configured in that container on Google's side, and Google asks for only one Google tag
per page, so don't add a second one. It does nothing on `localhost`, so local testing never reaches your reports. The tag is a separate file, not an inline snippet, and the
Content-Security-Policy in `vercel.json` and `server.js` lists the Google domains it needs. If you change the policy
or add another outside service, update both places or the browser will silently block it. Analytics sets cookies, so
visitors in some regions (for example the EU) may need a notice or a consent banner.

## Notes

- Win rate for a card or relic means: of the runs that ended with it, the share that were wins.
  Starter cards and starting relics are left out of card and relic stats. Small samples are noisy, so raise "Min sample".
- Event queries still exist in `db/queries.js` but are hidden from the site.
- Images under `public/img/` and `card-info.json` are cached by browsers for a week (`vercel.json`, and the same rule
  in `server.js`).
- An upload imports up to 4 runs at once (`IMPORT_CONCURRENCY` in `lib/handler.js`).
