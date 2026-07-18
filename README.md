# Replay

Replay imports public Chess.com and Lichess games and turns important mistakes
into a spaced-repetition training deck. The production app is now a static web
site: public-game import, PGN parsing, legal move handling, puzzle creation, and
Stockfish 18 analysis all run in the visitor's browser.

## Run it locally

```bash
git clone https://github.com/rgrossharv/chessreplaystatic.git
cd chessreplaystatic
chmod +x run.sh
./run.sh
```

Open <http://localhost:47831>. The local command only serves files; it does not
install packages, create a database, or run application code on the server.

To select a different port or allow access from a trusted local network:

```bash
REPLAY_PORT=47832 ./run.sh
REPLAY_HOST=all ./run.sh
```

Do not expose this development server directly to the public internet.

## Deploy to GitHub Pages

The included `.github/workflows/pages.yml` can publish the contents of `static/`
without a build step. It runs on pull requests for validation, deploys on pushes
to `main`, and still supports manual `workflow_dispatch` runs. Choose **GitHub
Actions** in the repository's **Settings → Pages** before the first deployment.

All application and asset URLs are relative, so the site works under the
`/chessreplaystatic/` project path as well as at a custom domain.

## Static-first architecture

- `static/lib/game-import.js` calls the official public Chess.com and Lichess
  APIs serially, parses PGN with the vendored `chess.js`, and builds the replay
  frames previously produced by Python.
- `static/lib/engine-providers.js` exposes one analysis contract. Stockfish runs
  in a Web Worker; configured Lc0 or Reckless services use the same contract.
- `static/lib/analysis-board.js` provides click and drag legal play, PGN import,
  clickable notation history, position editing, FEN loading, arrows, live
  analysis, and progressive per-game accuracy through the selected engine
  provider.
- `static/lib/board-arrows.js` provides reusable right-drag board annotations for
  both training puzzles and the general analysis board.
- `static/lib/profile-store.js` replaces misleading server-local passwords with
  explicit device profiles. Preferences, cached analysis, and review schedules
  remain separate per profile in the browser.
- `static/lib/auth-sync.js` adds optional remembered Google and GitHub sign-in
  through Firebase, links matching-email providers to one UID, and syncs saved
  games, preferences, reports, and review schedules through Firestore.
- `static/lib/engine-play.js` provides a playable Stockfish board and the
  browser-native Reckless integration boundary.
- `static/lib/chess-report.js` scans up to 100 public games with local Stockfish,
  groups costly moves into tactical patterns, and links the strongest patterns
  to labeled Lichess puzzle themes.
- `static/config.js` contains public deployment configuration. Never put engine
  provider keys or other secrets there.

The static app is complete without a backend. Cross-device state uses optional
Firebase Authentication and Firestore; billing, credits, and paid compute still
need a service because secrets and authoritative entitlement data cannot safely
live in GitHub Pages. Setup and API boundaries are documented in
[`docs/architecture.md`](docs/architecture.md).

## Configure cloud accounts

Create a Firebase web app, enable Google and GitHub providers, keep the
Authentication setting at **one account per email address**, create Firestore,
and deploy [`firestore.rules`](firestore.rules). Add the public web configuration
to `static/config.js`:

```js
firebase: {
  apiKey: "...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  appId: "...",
},
```

Authorize the GitHub Pages domain in Firebase Authentication and in both OAuth
provider configurations. The SDK uses local auth persistence so an account is
remembered after the browser restarts.

## Install Reckless browser assets

The Reckless repository intentionally does not commit its generated 61.5 MiB
WASM chunks. After building its `dist/` directory, install it with:

```bash
sh scripts/install-reckless.sh /path/to/recklesschessweb/dist
```

Then set `browserEngines.reckless.enabled` to `true` in `static/config.js`.
Preserve the copied AGPL license, source notice, and upstream provenance.

## How training works

- Free Replay uses games played in the last seven days. If there are none, it
  falls back to the latest twenty games and tells the user which fallback was
  used. If an account has fewer than twenty total public standard games, Replay
  imports all available games and says so explicitly. Missing usernames and
  accounts with no usable public games are separate error states.
- Free analysis uses Stockfish 18 in the visitor's browser. Plus analysis uses
  configured Lc0 or Reckless compute gateways.
- Master decks are a Plus feature. A master deck is built from a verified
  Chess.com grandmaster account in the titled-player directory or the featured
  master list, scanning that player's latest 100 public standard games.
- A position becomes a puzzle when the played move loses at least three pawns,
  misses a forced mate, or misses a clearly winning position.
- Puzzles are added to the deck after each game finishes; training can begin
  while the remaining selected games continue analyzing.
- Again, Hard, Good, and Easy grades control when a puzzle returns.
- Pieces support click-to-move and pointer-based drag-and-drop for mouse, pen,
  and touch.
- Right-drag across either board to draw or remove an arrow. Shift-drag provides
  the same action for devices where a secondary-button drag is unavailable.
- Analysis results are cached in the browser by account, source, player, game,
  engine, and analysis version.

## Pricing and subscription behavior

Replay exposes the product boundary in the app:

| Tier | Included |
| --- | --- |
| Free | Public-game import, local Stockfish 18 analysis, browser device profiles, review scheduling, and cached local decks. |
| Plus | Lc0 cloud analysis, Reckless cloud analysis, and master decks from verified grandmaster accounts. |

The static app can show and cache entitlement state, but it is not the authority
for billing. The account API must decide whether a user is Plus, mint short-lived
engine tokens, and enforce quotas server-side.

If a user subscribes mid-session, the current Stockfish deck remains available;
new analysis can use Lc0 or Reckless after the account API returns a Plus
entitlement and engine token. If a subscription lapses, previously analyzed Plus
content remains visible and reviewable in the user's deck, but new Plus engine
analysis and new master-deck imports are blocked until the entitlement returns.

## Browser and mobile support

Replay is designed for current evergreen browsers:

| Browser | Support target | Notes |
| --- | --- | --- |
| Chrome / Edge | Current and previous two major versions | Best target for Web Worker and WASM Stockfish. |
| Firefox | Current and previous two major versions | Web Worker and WASM Stockfish supported. |
| Safari / iOS Safari | 16.4+ | Older Safari builds are the highest-risk target for WASM/worker behavior. |
| Mobile browsers | Current iOS Safari and Android Chrome | Board, analysis, and review layouts collapse to single-column touch-friendly views. |

If Stockfish cannot start, users should be shown the failure instead of silently
falling back to an empty analysis state.

## Configure remote engines

Set an HTTPS endpoint for `lc0` or `reckless` in `static/config.js`. A configured
endpoint receives:

```json
{
  "fen": "position in FEN notation",
  "searchMoves": ["optional", "uci", "moves"],
  "limit": { "depth": 12 }
}
```

It returns a UCI-style result:

```json
{
  "bestmove": "e2e4",
  "depth": 12,
  "cp": 34,
  "mate": null,
  "pv": ["e2e4", "e7e5"]
}
```

`cp` and `mate` use the normal UCI side-to-move perspective so constrained
`searchMoves` evaluations can be compared with the unrestricted best move.

The endpoint must enforce authentication, entitlement, quotas, and billing. It
should return a short-lived access token through the account flow; Replay reads
that token from `sessionStorage` under `replay:engine-access-token`.

## Open-source components

- Chess rules and PGN parsing: `chess.js` 1.4.0, BSD-2-Clause.
- Browser engine: Stockfish.js 18, GPLv3. Its license is included at
  `static/vendor/stockfish/COPYING.txt`.
- Piece artwork: Cburnett, Alpha, and Merida sets from Lichess. The Lichess
  license is included at `static/pieces/LICHESS-LICENSE.txt`.
- Optional Plus engine gateway: Lc0 source is available at
  <https://github.com/LeelaChessZero/lc0> under GPL-3.0-or-later.
- Optional Plus engine gateway: Reckless source is available at
  <https://github.com/codedeliveryservice/Reckless> under AGPL-3.0.

## Replay license

Replay's original website and application code is source-available under the
custom [`LICENSE`](LICENSE): personal, non-commercial use of unmodified copies is
allowed; modification, redistribution, and commercial use require separate
permission. This is not an OSI open-source license.
