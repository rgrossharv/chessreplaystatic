# Replay

Replay imports public Chess.com and Lichess games and turns important mistakes
and engine-confirmed brilliancies into a spaced-repetition training deck. The production app is now a static web
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

The included `.github/workflows/pages.yml` publishes the contents of `static/`
without a build step. In the repository's **Settings → Pages**, choose
**GitHub Actions** as the source, then push `main` or run the workflow manually.

All application and asset URLs are relative, so the site works under the
`/chessreplaystatic/` project path as well as at a custom domain.

## Static-first architecture

- `static/lib/game-import.js` calls the official public Chess.com and Lichess
  APIs serially, parses PGN with the vendored `chess.js`, and builds the replay
  frames previously produced by Python.
- `static/lib/engine-providers.js` exposes one analysis contract. Stockfish runs
  in a Web Worker; configured Lc0 or Reckless services use the same contract.
- `static/lib/brilliancy.js` identifies material offers—including discovered
  sacrifices—and leaves the final classification to constrained engine search.
- `static/lib/analysis-board.js` provides a legal-play board, notation, position
  editing, FEN loading, and analysis through the selected engine provider.
- `static/lib/profile-store.js` replaces misleading server-local passwords with
  explicit device profiles. Preferences, cached analysis, and review schedules
  remain separate per profile in the browser.
- `static/config.js` contains public deployment configuration. Never put engine
  provider keys or other secrets there.

The static app is complete without a backend. Cross-device accounts, billing,
credits, and paid compute need a small external service because secrets and
authoritative account data cannot safely live in GitHub Pages. The expected API
boundaries are documented in [`docs/architecture.md`](docs/architecture.md).

## How training works

- Replay uses games played in the last seven days. If there are none, it falls
  back to the latest twenty games. Master decks use their latest 100 games.
- A position becomes a puzzle when the played move loses at least three pawns,
  misses a forced mate, or misses a clearly winning position.
- A move becomes a brilliancy lesson only when it offers meaningful material,
  is best or nearly best, leaves a sound position, and survives comparison with
  every legal alternative. This follows [Chess.com's published classification
  principles](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc)
  while keeping Replay's thresholds explicit and deterministic.
- Puzzles are added to the deck after each game finishes; training can begin
  while the remaining selected games continue analyzing.
- Again, Hard, Good, and Easy grades control when a puzzle returns.
- Pieces support click-to-move and pointer-based drag-and-drop for mouse, pen,
  and touch.
- Analysis results are cached in the browser by account, source, player, game,
  engine, and analysis version.

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
