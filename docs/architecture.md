# Replay static architecture

Replay is split into a fully static training application and two optional
server-side capabilities. GitHub Pages owns the static application. A small API
owns only data and secrets that cannot safely be authoritative in a browser.

## Static application

The browser imports public games directly from Chess.com and Lichess, parses
PGN with `chess.js`, evaluates positions, builds puzzles, renders the board, and
schedules reviews. Device profiles are intentionally described as device-only;
they are not password accounts and do not imply cross-device durability.

Browser storage is appropriate for the analysis cache, UI preferences, and an
offline/device profile. It is not the authority for purchased credits, engine
credentials, or a cross-device identity.

Device profiles include a local entitlement snapshot so the UI can clearly show
Free versus Plus state, but the snapshot is only advisory. The account API is
the source of truth for billing, subscriptions, quotas, and remote engine
tokens.

## Optional account and sync API

Use a hosted identity provider plus a durable database (for example, a small
edge worker with managed SQL). Avoid inventing another password database inside
the static app. The service should expose these logical operations:

| Operation | Purpose |
| --- | --- |
| `GET /v1/session` | Return the current user and engine entitlements. |
| `GET /v1/state` | Return the user's preferences and review schedule. |
| `PUT /v1/state` | Upsert versioned preferences and review cards. |
| `POST /v1/engine-token` | Mint a short-lived token scoped to one engine and quota. |

Every state row should include `user_id`, a stable state key, a version or
updated timestamp, and JSON data. Resolve concurrent updates per review card,
not by replacing an entire user's state with the last device to write.

For a GitHub Pages origin, prefer an OAuth/OIDC authorization-code flow with
PKCE. Keep long-lived sessions in secure, HTTP-only cookies when the chosen
domain layout permits it. Engine tokens should be short lived and narrowly
scoped even when the account session is longer lived.

### Entitlements and lapse behavior

Replay uses these product rules:

- Free users may import their own public games, run Stockfish in the browser,
  review locally cached decks, and keep device-profile preferences.
- Plus users may select configured Lc0 and Reckless gateways and build master
  decks from verified Chess.com grandmaster accounts.
- If a user upgrades mid-session, the existing deck stays intact. New analysis
  requests can use Plus engines after `GET /v1/session` reports the entitlement
  and `POST /v1/engine-token` succeeds.
- If Plus lapses, previously analyzed Plus puzzles remain visible and reviewable
  because the deck is user study history. New remote analysis, wrong-move
  remote evaluation, and new master-deck imports are blocked until Plus returns.

Persist entitlement state separately from review cards. Review cards should not
be deleted or rewritten when a subscription changes; only the ability to create
new Plus analysis is gated.

## Optional compute gateway

The browser's `RemoteEngine` sends a position to a configured HTTPS endpoint.
That gateway should:

1. Verify the short-lived Replay token.
2. Check the user's entitlement and remaining credits.
3. Validate FEN, optional `searchMoves`, and bounded analysis limits.
4. Queue work for Lc0 or Reckless without exposing provider credentials.
5. Atomically debit metered usage and return a normalized UCI-style result.

The response contract is shared by every engine:

```ts
type EngineResult = {
  bestmove: string;
  depth: number;
  cp: number | null;
  mate: number | null;
  pv: string[];
};
```

Centipawn and mate scores use the UCI side-to-move perspective. The gateway
must preserve that perspective for both unrestricted and `searchMoves` calls.

Returning this small contract keeps puzzle generation independent from any
specific vendor. A future asynchronous gateway can add a job resource while
preserving the same final result shape.

## Security boundary

Everything below `static/` is public. Do not place database credentials,
provider API keys, signing secrets, price rules, or trusted credit balances in
that directory. CORS is access control for browsers, not authentication; the
compute service must validate every request itself.
