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
profile's stats. Passwords are stored as salted scrypt hashes, and sign-in uses an expiring secure cookie.

Signed-in players have an **Account** button with two options:

- **Change password.** It needs the current password and signs out every other device.
- **Delete account.** It needs the password, and removes the profile and every run that only that player imported.
  Runs another player also imported stay in that player's stats.

There is no password reset for a forgotten password, because the site doesn't store email addresses.

## Personal achievements

Signed-in players get a **Personal achievements** button next to **My profile**. It shows three badges, worked out from
their own solo runs. An abandoned run is a loss, so quitting a run that's about to be lost breaks a streak just like
losing it:

| Badge               | How to earn it                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| **All A10**         | Win on ascension 10 with every character.                                             |
| **Rotating Streak** | Win on ascension 10 with every character in a row, each one once. Any loss or lower-ascension run in between restarts the streak, and so does a second win with a character already in it (the streak then carries on from just after that character's earlier win). |
| **Speedrunner**     | Win a run in under 20 minutes, on any ascension.                                      |

"Every character" means every character listed in `public/game-data.js`, and "ascension 10" is its `maxAscension`.
A new character joins the requirement when it is added there, not when someone imports a run with it, so one player's
import can't take a badge away from everyone else. The rules are in `lib/achievements.js`.

Earned badges are saved (`profile_badges`) with what they asked for at the time. If the requirement grows later, for
example when a new character is added, players keep the badge, marked **Outdated** with a note saying what changed,
until they earn it again under the new requirement. This also covers badges earned before abandoned runs counted as
losses: if a streak only held because abandons used to be skipped, the badge is kept and its note says so.

## Adding new game content

Characters, areas, Ancients, co-op cards and the top ascension are listed once, in `public/game-data.js`. The page
and the server both read that file. The top of the file says what to add for each kind of content. A new character
also needs its two images (`img/characters/<name>.png` and `img/heads/<name>.png`). Bump the `?v=` numbers in
`public/index.html` after changing it, so browsers load the new version.

## What it does

- **Imports selected `.run` files** from a folder in small batches. Repeated imports are safe.
- **Stores cloud data in Turso** so imported runs remain available between Vercel function calls.
- **Solo and multiplayer.** When viewing a profile, the **Mode** filter shows solo runs (the default), multiplayer
  runs, or both, and the **Teammates** tab is available. The combined **Everyone** view is always solo runs only, with
  no Mode filter or Teammates tab: each teammate who imports a co-op run stores their own side of it, so combining
  them would count the run once per teammate. A
  multiplayer run is stored from the uploader's side (their character, deck, relics, card picks and fights), so
  multiplayer-only cards (tagged "Co-op") show up in the card tables. **Recent runs** lists who you played with and
  your win rate with each of them, and the **Teammates** tab sums it up per teammate. Run files only hold Steam ids,
  so the uploader's id comes from the Steam folder in the path, or as the one player in all the selected multiplayer
  runs; it is then remembered on the profile. A teammate shows by username once they import their own runs here, otherwise by their Steam name (looked up when runs are imported and cached for a week; set `STEAM_API_KEY` in `.env` or your host to use the Steam Web API, see `.env.example`; without it public profile pages are read),
  and always links to their Steam profile when they have no site profile. Personal achievements stay solo only.
- **No double counting.** A run is identified by seed plus start time (plus the uploader's Steam id for
  multiplayer), so repeated uploads are safe.
- **Abandoned runs count as losses** by default, in every stat and count, so re-rolling for a good seed or quitting a
  run that's about to be lost costs the same as losing it. Quitting during a fight counts as being **killed by** that
  fight (the game records it); quitting at an event or between rooms has no killer. Recent runs labels them
  **ABANDONED**. The **Abandoned** card on the overview shows how many there are, and its **Count as losses** switch
  leaves them out of every stat instead (kept in the page URL as `abandoned=exclude`). Personal achievements always
  count them, whatever the switch says. An abandoned run is stored with `win = 0` even if its file says otherwise
  (`lib/importer.js`, and migration 4 for runs imported before this rule).

## Files

| File               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `db/schema.sql`    | Tables for profiles, sessions, unique runs, and run details |
| `db/queries.js`    | Every statistic as a SQL query                              |
| `lib/importer.js`  | Parses one `.run` file into rows (solo or multiplayer)      |
| `lib/multiplayer.js` | Steam ids, finding the uploader, multiplayer migrations   |
| `lib/db.js`        | Opens local SQLite or remote Turso                          |
| `lib/migrations.js` | Numbered database changes, each applied once (how to add one is at the top) |
| `public/game-data.js` | Characters, areas, Ancients, co-op cards; shared by page and server |
| `lib/handler.js`   | Profile auth and shared API routes                          |
| `lib/ratelimit.js` | Database-backed rate limiter                                |
| `api/index.js`     | Vercel Function entry point                                 |
| `server.js`        | Local development server                                    |
| `public/`          | The website (HTML, CSS, JS)                                 |
| `scripts/db-health.js` | `npm run db:health`: table sizes and leftover data (see below) |
| `scripts/update-relic-info.js` | `npm run update:relics`: rebuilds `public/relic-info.json` from the wiki |
| `public/relic-info.json` | Relic rarity and description text, shown in the relic popup |
| `test/smoke.js`    | `npm test`; also run by GitHub Actions on every push (`.github/workflows/test.yml`) |

Locally, the database lives at `data/spire-ledger.db`. Production data is stored in Turso.

## Database health and Turso usage

`npm run db:health` prints the size of every table and looks for leftover data: rows of runs that no longer exist,
links to missing runs or profiles, expired sign-ins and old rate-limit counters. It only reads unless you add
`-- --fix`, which deletes those leftovers. It never deletes runs or profiles. It uses `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` from `.env` (or the shell) to check the live database, otherwise the local one.

A multiplayer run that two teammates both imported is stored twice on purpose, once from each player's side, so
this isn't overlap.

On Turso, the limit that matters is **rows read**: every row a query looks at counts, not just the rows it returns.
Three things keep it down:

- Shared statistics are cached by Vercel for five minutes.
- The start-up backfills run at most once a day (the `maintenance` table).
- Indexes cover the filters.

Turso's dashboard shows which queries read the most rows.

## Trends

The **Trends** tab has two charts. The top one is your win rate over every run, after each run. The bottom one zooms in
on your latest 50 runs, where each point is the win rate of the 10 runs up to it. **By character** draws one line per
character in both charts, and clicking a character in the legend hides or shows it. The character, ascension and patch
filters apply, and hovering a chart shows the win rate at any run.

Below them, two bar charts show the **top 5 cards** and **top 5 relics** by win rate, from the same numbers as the Card WR
and Relic WR tabs (same filters, starter cards and relics left out). A card or relic must be in at least 5 runs to rank,
or the Min sample if that is higher, so a single lucky run can't top the list. Hovering one shows its card or relic
popup, and **See every card / relic** opens the full table.

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
- Hovering a relic anywhere it is listed shows a popup with its rarity and what it does, like the card pictures do for
  cards. The text comes from the wiki's relic data: after a game patch adds or changes relics, run
  `npm run update:relics` (it only reads from the wiki), add the new relic's picture to `public/img/relics/`, bump the
  `relic-info.json?v=` number in `public/app.js`, and commit the file. A relic without a description (a brand-new
  one, or the Fake Merchant's fake relics, which aren't on the wiki) simply has no popup; nothing breaks and no test
  fails. The script lists the relic pictures it found no text for.
- Images under `public/img/`, `card-info.json` and `relic-info.json` are cached by browsers for a week (`vercel.json`, and the same rule
  in `server.js`).
- An upload imports up to 4 runs at once (`IMPORT_CONCURRENCY` in `lib/handler.js`).
