# STS2 TRACKER

Solo run statistics for Slay the Spire 2, stored in SQLite and shown on a local website.

## Setup

1. Install Node.js 22.
2. In this folder, run:

   npm install
   npm start

3. Open http://localhost:3000
4. Create a profile or sign in, then choose **Import run folder** and select the folder that contains your `.run` files.
   The browser uploads the selected files to the server.

## Vercel

Create a Turso database and auth token, then import this repository into Vercel with the **Other** framework preset.
Set these project environment variables in Vercel:

- `TURSO_DATABASE_URL`: the database URL from Turso.
- `TURSO_AUTH_TOKEN`: the Turso auth token.
- `IMPORT_TOKEN`: a separate long random admin key for backups and the admin SQL endpoint.

Deploy after saving the variables. The database schema is created automatically. Everyone can view combined stats;
users create or sign in to a profile to import and view their own runs. Enter the `IMPORT_TOKEN` (under **Admin tools**)
only to download backups.

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

## Rate limiting

Limits are stored in the database (`rate_limits` table), so they hold across Vercel instances. Exceeding one returns
HTTP 429 with a `Retry-After` header.

| Action                  | Limit                                              |
| ----------------------- | -------------------------------------------------- |
| Sign in                 | 8 attempts per username and 30 per network / 15 min |
| Create profile          | 10 per network / hour                              |
| Import                  | 120 requests per profile / 10 min                  |
| Player search           | 120 per network / minute                           |
| Admin SQL and backups   | 30 per network / 15 min                            |

A successful sign-in clears that username's counter. Locally the network address is the socket address; on Vercel it is
the first `x-forwarded-for` entry.

## What it does

- **Imports selected `.run` files** from a folder in small batches. Repeated imports are safe.
- **Stores cloud data in Turso** so imported runs remain available between Vercel function calls.
- **Solo only.** Any file with more than one player is skipped and counted as "multiplayer skipped" in the status line.
- **No double counting.** A run is identified by seed plus start time, so repeated uploads are safe.
- Abandoned runs are excluded from all stats.

## Files

| File              | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `db/schema.sql`   | Tables for profiles, sessions, unique runs, and run details |
| `db/queries.js`   | Every statistic as a SQL query                              |
| `lib/importer.js` | Parses one `.run` file into rows, rejects multiplayer       |
| `lib/db.js`       | Opens local SQLite or remote Turso                          |
| `lib/handler.js`  | Profile auth and shared API routes                          |
| `lib/ratelimit.js`| Database-backed rate limiter                                |
| `api/index.js`    | Vercel Function entry point                                 |
| `server.js`       | Local development server                                    |
| `public/`         | The website (HTML, CSS, JS)                                 |
| `test/smoke.js`   | `npm test`                                                  |

Locally, the database lives at `data/spire-ledger.db`. Production data is stored in Turso.

## Notes

- The local development server listens only on your own machine (127.0.0.1). Vercel uses a serverless function.
- Win rate for a card or relic means: of the runs that ended with it, the share that were wins.
  Starter cards are left out of card stats. Small samples are noisy, so raise "Min sample".
- Event queries still exist in `db/queries.js` but are hidden from the site.
