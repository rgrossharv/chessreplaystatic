# Replay

Replay imports public Chess.com and Lichess games and turns important mistakes
into a spaced-repetition training deck. The production app is now a static web
site: public-game import, PGN parsing, legal move handling, puzzle creation, and
Stockfish 18 and Reckless analysis all run in the visitor's browser. The
Reckless browser integration is alpha software and may download about 61.5 MiB
of engine files when it is first used.

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
- `static/lib/engine-providers.js` exposes one analysis contract. Stockfish and
  Reckless run in Web Workers; configured Lc0 cloud or Reckless cloud services
  use the same contract without sharing IDs with the local engines.
- `static/lib/brilliancy.js` identifies material offers—including discovered
  sacrifices—and leaves the final classification to constrained engine search.
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

## Included Reckless browser assets

The complete Reckless alpha browser package—including its worker, JavaScript
wrapper, AGPL notices, rebuild information, and all four generated WASM
chunks—is committed under `static/vendor/reckless/` on `main`. No engine build
or asset installation is required after cloning. The browser downloads the
roughly 61.5 MiB package only after a visitor explicitly starts Reckless.

`scripts/install-reckless.sh` is retained only for maintainers replacing the
vendored package with a newly verified RecklessWeb build.

## How training works

- Free Replay uses games played in the last seven days. If there are none, it
  falls back to the latest twenty games and tells the user which fallback was
  used. If an account has fewer than twenty total public standard games, Replay
  imports all available games and says so explicitly. Missing usernames and
  accounts with no usable public games are separate error states.
- Free analysis uses Stockfish 18 or Reckless in the visitor's browser. The
  Reckless browser build is alpha software; it may need to download about 61.5
  MiB the first time it is initialized, remains entirely local, and uses a
  single-threaded 50,000-node search. Plus analysis uses
  separately configured Lc0 cloud or Reckless cloud compute gateways.
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
| Free | Public-game import, local Stockfish 18 or Reckless browser analysis, browser device profiles, review scheduling, and cached local decks. |
| Plus | Lc0 cloud analysis, Reckless cloud analysis, and master decks from verified grandmaster accounts. |

The static app can show and cache entitlement state, but it is not the authority
for billing. The account API must decide whether a user is Plus, mint short-lived
engine tokens, and enforce quotas server-side.

If a user subscribes mid-session, the current local-engine deck remains available;
new analysis can use Lc0 cloud or Reckless cloud after the account API returns a Plus
entitlement and engine token. If a subscription lapses, previously analyzed Plus
content remains visible and reviewable in the user's deck, but new Plus engine
analysis and new master-deck imports are blocked until the entitlement returns.

## Browser and mobile support

Replay is designed for current evergreen browsers:

| Browser | Support target | Notes |
| --- | --- | --- |
| Chrome / Edge | Current and previous two major versions | Best target for module workers, WebAssembly SIMD, and large local engine assets. |
| Firefox | Current and previous two major versions | Module workers and WebAssembly SIMD supported. |
| Safari / iOS Safari | 16.4+ | Older Safari builds are the highest-risk target for module-worker and WASM SIMD behavior. |
| Mobile browsers | Current iOS Safari and Android Chrome | Layouts are touch-friendly, but Reckless's 61.5 MiB download and memory/battery load may be impractical on constrained devices. |

If either browser engine cannot start, Replay shows the worker, download, or
unsupported-browser failure instead of silently falling back to empty analysis.

## Browser Reckless integration

The browser Reckless integration is currently alpha software. Visitors should
expect a possible 61.5 MiB download when they start Reckless analysis for the
first time, along with higher memory, battery, and mobile-data use than
Stockfish's lite browser build.

The local provider is `reckless-browser`; the optional paid gateway remains
`reckless`. Selecting the provider does not fetch the engine. Initialization
starts only when the user explicitly begins analysis, at which point download
progress is shown. All package files live in `static/vendor/reckless/`, and the
wrapper resolves the worker, glue, and WASM chunks with `new URL(...,
import.meta.url)`. No URL begins with `/`, so the same files work at a custom
domain root and beneath `/chessreplaystatic/` on GitHub Pages.

Replay gives browser Reckless a fixed 50,000-node budget rather than assuming
that depth 12 means the same cost or strength as Stockfish. The node budget is
publicly configurable at `replayConfig.browserReckless.nodes`; its value is part
of the engine cache fingerprint.

Constrained `searchMoves` are genuinely supported. The pinned Reckless root
move list is filtered before search by the distributed WASM patch, and the
worker rejects any returned move outside the requested set. It never substitutes
an unrestricted principal variation. Search replacement terminates the
synchronous worker, rejects the old promise as an expected `AbortError`, restores
the last confirmed position, and ignores messages from stale worker generations.

### Update or rebuild the vendored engine

The vendored browser package is based on
`EasternKentuckyDigital/recklesschessweb` commit
`a64199fbd26251914120a8fa6d08c89fa3ac50d6`. The engine is based on upstream
Reckless commit `a6fa482c7d46fb81831573f10be396f20a5efdb5` with the exact
`static/vendor/reckless/RECKLESS-SEARCHMOVES.patch` applied.

1. Check out those commits and apply the patch from the Reckless checkout.
2. Run RecklessWeb's `scripts/build-reckless-wasm.sh /path/to/Reckless` with
   Rust, `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.123 installed.
3. Carry the `searchMoves` worker/wrapper support forward, run
   `node scripts/build-package.mjs`, and copy the complete `dist/` directory to
   `static/vendor/reckless/`.
4. Update the pinned commits, compiled SHA-256, version, package size, and Replay
   cache fingerprint; then run the Node tests and real browser smoke test.

## Configure remote engines

This section applies only to the optional remote `lc0` and `reckless` providers,
not `reckless-browser`. Set an HTTPS endpoint in `static/config.js`. A configured
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
- Browser engine package: [Reckless Browser](https://github.com/EasternKentuckyDigital/recklesschessweb)
  0.1.0, based on [Reckless](https://github.com/codedeliveryservice/Reckless)
  0.10.0-dev, AGPL-3.0-only. The full license, provenance, exact source patch,
  generated glue, type files, worker, and split WASM are included at
  `static/vendor/reckless/`. Corresponding source and rebuild directions are in
  `static/vendor/reckless/SOURCE.md` and this README.
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
