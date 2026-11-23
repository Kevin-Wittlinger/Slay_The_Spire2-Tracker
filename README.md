# STS2 TRACKER

Solo and multiplayer run statistics for Slay the Spire 2.

Create a profile or sign in, then choose **Import Run Folder** and select the folder that contains your `.run` files.
On Windows it is in AppData:

    %AppData%\SlayTheSpire2\steam\<your Steam ID>\profile1\saves

## Profiles

The home view combines every run imported to the site. Create a profile to import your own runs and switch between
the combined view and **My Profile**. Importing the same folder again is safe: runs you already added are skipped.

Use the **Find a player** box to look up any profile and view their stats. Filters, tab, and whose runs you are
viewing are kept in the page URL, so a link can be shared or reloaded.

Signed-in players have an **Account** button with two options:

- **Change password.** It needs the current password and signs out every other device.
- **Delete account.** It needs the password, and removes the profile and its runs.

There is no password reset for a forgotten password, because the site doesn't store email addresses.

## Personal achievements

Signed-in players get a **Personal achievements** button next to **My profile**. It shows three badges, worked out from
their own solo runs. Anyone can see another player's badges too: open their profile and use the **<name>'s
achievements** button. An abandoned run is a loss, so quitting a run that's about to be lost breaks a streak just like
losing it:

| Badge               | How to earn it                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| **All A10**         | Win on ascension 10 with every character.                                             |
| **Rotating Streak** | Win on ascension 10 with every character in a row, each one once. Any loss or lower-ascension run in between restarts the streak, and so does a second win with a character already in it (the streak then carries on from just after that character's earlier win). |
| **Speedrunner**     | Win a run in under 20 minutes, on any ascension.                                      |

If a requirement grows later (for example when a new character is added), players keep the badges they earned,
marked **Outdated** with a note saying what changed, until they earn them again.

## What it does

- **Imports `.run` files** straight from your save folder.
- **Solo and multiplayer.** When viewing a profile, the **Mode** filter shows solo runs (the default), multiplayer
  runs, or both, and the **Teammates** tab appears under the multiplayer modes. The combined **Everyone** view is
  solo runs only. A multiplayer run counts your own character, deck, relics, card picks and fights, so co-op-only
  cards show up in the card tables. **Recent runs** lists who you played with and your win rate with each of them.
  Teammates show by their site username if they have one, otherwise by their Steam name.
- **Abandoned runs count as losses** by default, in every stat and count. Recent runs labels them **ABANDONED**. The
  **Abandoned** card on the overview shows how many there are, and its **Count as losses** switch leaves them out
  of every stat instead. Personal achievements always count them as losses.

## Run page

Every row on **Recent runs** has a **Details** button (clicking the row works too) that opens the whole run, like the
game's run history:

- **Summary:** character, ascension, final HP, gold, potion slots, floors and time, plus the date, seed, game mode
  and patch, and how the run ended.
- **Map path:** one row of map icons per area. Bosses and Ancients get their own picture, and a `?` room shows
  what it turned out to be. Hovering an icon gives the floor, HP and gold; clicking it jumps to that floor below.
- **Relics and deck:** relic icons and the final deck, each with a count by rarity. Identical cards are grouped
  ("3x Strike"), upgraded ones are green and enchanted ones purple.
- **Floor by floor:** HP and gold after each room, plus what happened there: turns and damage, cards taken and
  skipped, removals, upgrades, transforms, enchantments, relics, potions, rest-site and event choices, gold.

A run page's link can be shared. Runs imported before the run page existed show only their fights and events;
importing your run folder again fills in the rest without counting anything twice.

## Trends

The **Trends** tab has two charts. The top one is your win rate over every run, after each run. The bottom one zooms in
on your latest 50 runs, where each point is the win rate of the 10 runs up to it. **By character** draws one line per
character in both charts, and clicking a character in the legend hides or shows it.

Below them, two bar charts show the **top 5 cards** and **top 5 relics** by win rate. A card or relic must be in at
least 5 runs to rank (or the Min sample, if higher), so a single lucky run can't top the list.

## Filters

Character, ascension, **patch** (the game build a run was played on) and minimum sample filter every tab.

The **area** filter (Overgrowth, Underdocks, Hive, Glory) keeps runs that entered that area. Overgrowth and
Underdocks are the two alternatives for act 1. Enemy, boss and event tabs only count rooms fought inside that area.

The **Relic WR** tab has a source dropdown: Neow, all Ancients, one Ancient, or **No Neow or Ancients** for every
other relic.

On the Enemies and Killed by tabs, a **Weak** encounter is from the easier pool of regular fights met early in an act;
**Normal** is the harder pool met later.

## Notes

- Win rate for a card or relic means: of the runs that ended with it, the share that were wins. Starter cards and
  starting relics are left out. Small samples are noisy, so raise "Min sample".
- Hovering a card or relic shows its picture or a popup with its rarity and what it does.
- Card, relic, monster, map and area images and relic text come from the
  [Slay the Spire wiki](https://slaythespire.wiki.gg/).
- The site uses Google Analytics, which sets cookies.

## Development

Requires Node 22. Optionally copy `.env.example` to `.env` and fill it in, then:

    npm install
    npm start        # local server
    npm test         # smoke tests (also run by GitHub Actions on every push)

Characters, areas, Ancients, co-op cards and the top ascension are listed once, in `public/game-data.js`; the top of
that file says what to add for new game content. After changing anything in `public/`, bump its `?v=` number in
`public/index.html` so browsers load the new version.

Wiki data can be refreshed after a game patch with `npm run update:relics` (relic text) and
`npm run update:map-icons` (map icons).
