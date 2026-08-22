# Block explorer

This document describes the QNet block explorer in `applications/qnet-explorer`: a Next.js
application that indexes the chain into PostgreSQL through an in-process sync service and serves
block, transaction, address and token views on top of that index. It covers what the explorer shows,
how the three parts fit together, how chain data is ingested, which environment variables the
deployment needs, and how to run it locally.

## Layout

| Path | Role |
| --- | --- |
| `frontend/src/app/` | Next.js App Router pages and HTTP API routes |
| `frontend/src/components/` | UI components (search, faucet, node list, sections) |
| `frontend/lib/` | Server-side modules: database pool, sync service, security checks, rate limiting, monitoring |
| `frontend/src/lib/` | Client and shared helpers: API client, caching, token formatting, transaction mapping |
| `frontend/migrations/001_init.sql` | The complete schema |
| `frontend/scripts/` | Migration runner, timestamp backfill, PostgreSQL install/backup/restore helpers |
| `frontend/Dockerfile`, `frontend/docker-compose.yml` | Container build and a compose stack with optional Redis and nginx |

The repository root of the explorer is a workspace whose `dev`, `build`, `start` and `lint` scripts
delegate into `frontend/`.

## What it shows

- `/explorer` — chain overview with recent blocks and transactions.
- `/explorer/block/[hash]` — block detail.
- `/explorer/tx/[hash]` — transaction detail.
- `/explorer/address/[address]` — address page: balance, native transactions and token transfers.
- `/explorer/tokens` and `/explorer/token/[contract]` — deployed token list, per-token page and
  holder list.
- `/explorer/qnc` — native QNC overview backed by the node rich list (top holders, total and
  circulating supply). QNC is the native coin, so this is a coin view, not a QRC-20 token page.
- `/nodes`, `/activate`, `/wallet`, `/testnet`, `/docs` — informational and tooling sections,
  including the testnet faucet and a node-activation helper.

## Architecture

Three parts, two processes:

1. **Frontend and API** — one Next.js application. Pages are rendered by Next.js; the routes under
   `src/app/api/` are the explorer's own HTTP API. They read the PostgreSQL index for historical
   data and proxy the node directly for anything that must be live (rich list, search fallback,
   balance checks).
2. **Sync service** — `src/instrumentation.ts` runs once per server start in the Node.js runtime: it
   opens the database pool, applies the schema from `migrations/001_init.sql`, then calls
   `startSyncService()` and re-checks after two seconds that it is running. The sync loop lives
   inside the Next.js server process.
3. **Database** — PostgreSQL, reached through a `pg` pool configured from the environment.

The migration runner in `instrumentation.ts` splits the SQL file on `;`, skips `CREATE USER`
statements, and executes statements beginning with `CREATE TABLE`, `CREATE INDEX`,
`CREATE OR REPLACE FUNCTION`, `CREATE TRIGGER`, `INSERT INTO`, `ALTER TABLE`, `GRANT` or `REVOKE`.
Anything outside that set — a `DO` block, or a `CREATE EXTENSION` such as the optional `pg_trgm`
index that makes token free-text search index-served — is a DBA step to apply by hand.

## Ingestion

The sync service reads from one node, chosen by `QNET_API_URL`, and sends `X-API-Key` when
`QNET_API_KEY` is set.

- **Realtime.** It subscribes over WebSocket to `/ws/subscribe?channels=blocks` (the HTTP URL with
  `http`/`https` rewritten to `ws`/`wss`) and reacts to new-block notifications. Reconnection backs
  off exponentially from 1 s to a 60 s ceiling, with a circuit breaker after 50 failed attempts and a
  30 s heartbeat ping to detect dead connections.
- **Bulk fetch.** Ranges of blocks are pulled with the JSON-RPC method `chain_getBlocks`, over the
  same WebSocket where possible and over HTTP JSON-RPC otherwise.
- **Single block.** `GET /api/v1/microblock/{height}` is the per-block REST path; responses over
  50 MB are rejected. Genesis is fetched over HTTP JSON-RPC because it is large.
- **Fallback polling.** If the WebSocket is unavailable the service polls `GET /api/v1/height` every
  5 seconds and catches up over REST.
- **Token transfers.** After a block with transactions is stored, the effect-sourced transfer index is
  refreshed from the node's `/api/v1/token-transfers` endpoint for that height range.
- **Verification.** The batch insert path stores blocks as the node returned them. A periodic pass
  samples 50 stored transactions at random every 10 minutes and compares each against the node with
  `verifyTransactionIntegrity` from `lib/security.ts`; a mismatch is logged as a `data_tampering`
  security event and the row is restored from the node's copy.
- **Reorg handling.** A backward height move is treated as a bounded reorg and rolls back only to the
  reorg point: `REORG_LIMIT = 5000` blocks is the deepest move still treated as a reorg, a new tip at
  or below `GENESIS_FLOOR = 2` is treated as a genuine fresh genesis and wipes the index, the tail is
  re-validated `REVALIDATE_DEPTH = 64` blocks deep at most once per `REVALIDATE_INTERVAL` of 30 s, and
  a full integrity pass runs every 10 minutes with a missing-transaction recovery scan every 5 minutes.

## Database schema

`migrations/001_init.sql` creates four tables.

| Table | Key | Contents |
| --- | --- | --- |
| `blocks` | `height` | hash, `block_type`, version, timestamp, previous/merkle/state roots, producer and producer address, tx count, gas used, signature and `signature_type`, size, `consensus_data` JSONB, `micro_blocks` array |
| `transactions` | `hash` | from/to, amount, nonce, block, timestamp, gas price and limit, signature and public key, `tx_type` and `tx_type_data` JSONB, raw `data`, status |
| `token_transfers` | `(tx_hash, log_index)` | contract, from/to, `amount` as `NUMERIC(80,0)`, `kind`, `std`, `token_id`, block, timestamp |
| `sync_state` | single row, `id = 1` | `last_height` and sync timestamps |

Amounts and nonces use exact integer types, never floats. `nonce`, `gas_price` and
`token_transfers.amount` are `NUMERIC` and hold the full u64 range; `transactions.amount` is
`BIGINT`, so the native-amount column covers values up to 2^63−1 base units. The address and
contract indexes on `token_transfers` carry `(block DESC, log_index DESC)` so an address or token
page is an index-ordered scan bounded near the query limit.

## HTTP API routes

All under `/api` on the explorer itself (not the node). Read routes are rate-limited per client
identifier; `/api/activity`, for example, allows 100 requests per minute per IP.

| Route | Purpose |
| --- | --- |
| `GET /api/activity` | Recent transactions from the index, enriched for display |
| `GET /api/address/[address]` | Address summary and history |
| `GET /api/address/[address]/balance-proof` | Multi-node balance agreement check |
| `GET /api/blocks/[hash]` | Block by hash |
| `GET /api/tx/[hash]` | Transaction by hash |
| `GET /api/tokens`, `GET /api/token/[contract]`, `GET /api/token/[contract]/holders` | Token list, token detail, holders |
| `GET /api/qnc` | Native QNC rich list, proxied from the node's `/api/v1/richlist` |
| `GET /api/network/stats` | Network summary |
| `GET /api/search`, `GET /api/search/suggest` | Search and type-ahead |
| `POST /api/faucet/claim` | Testnet faucet dispatch |
| `POST /api/node/activate` | Node-activation helper, delegating to `BRIDGE_API_BASE` |
| `POST /api/sync/start` | Starts the sync service on demand |
| `GET /api/monitoring/health`, `GET /api/monitoring/alerts` | Health and alerting |
| `GET /api/verify-build` | Build provenance (commit and source-tree links) |

### Balance agreement check

`/api/address/[address]/balance-proof` pulls the eligible validator list from the node's
`/api/v1/validators/proof`, queries a random sample (five by default) in parallel with a 3 s timeout,
and reports `verified: true` when at least three nodes respond and two thirds of the responders
agree. The bootstrap node list is used to discover the eligible validator set when the primary
discovery node is unreachable. Results are cached 30 s per address and the validator list 60 s. A
balance checked against a committee quorum certificate is available in
[the mobile wallet](mobile-wallet.md).

### Faucet

The claim route signs with `FAUCET_PRIVATE_KEY`, which is read at runtime and must be present for the
route to serve. Per-claim maxima are 1500 1DEV in both environments, with 1.0 SOL and 50,000 QNC on
testnet and 0.1 SOL and 1,000 QNC on mainnet. Outside testnet the route also applies a 24-hour
cooldown and an hourly per-IP request cap; the cooldown is keyed on the `(address, token type)` pair,
so parallel claims of different tokens do not block each other, and the slot is reserved before the
transaction is dispatched and released again only when the send definitively cannot have landed.

## Environment variables

Values are operator-supplied. Never commit them; never place them in a document.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Per-field alternative to `DATABASE_URL` |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | TLS for the database connection |
| `QNET_API_URL` | Base URL of the QNet node the sync service and proxy routes read from |
| `QNET_BOOTSTRAP_NODES` | Comma-separated node list used for validator discovery |
| `QNET_NODE_URL` | Node URL used by node-facing helpers |
| `QNET_API_KEY` | Sent as `X-API-Key` to the node to bypass its rate limits |
| `BRIDGE_API_BASE` | Base URL of the activation bridge used by `/api/node/activate` |
| `REDIS_URL` | Enables Redis-backed distributed rate limiting |
| `RATE_LIMIT_TRUSTED_PROXY`, `FAUCET_TRUSTED_PROXY` | Trust `X-Forwarded-For` when behind a proxy |
| `FAUCET_ENV`, `NEXT_PUBLIC_NETWORK` | Selects the testnet or mainnet faucet configuration |
| `FAUCET_PRIVATE_KEY` | Faucet signing key, read only at runtime |
| `SECURITY_WEBHOOK_URL` | Destination for security and alert events |
| `SYNC_DEBUG` | Set to `true` to enable verbose sync logging |
| `VERIFY_BUILD_ALLOWED_ORIGINS` | Extra origins allowed to call `/api/verify-build` |
| `NEXT_PUBLIC_GIT_COMMIT` | Commit shown by the build-verification route |
| `NODE_ENV` | Standard Next.js environment selector |

`QNET_API_URL` must name a publicly routable node: the sync service rejects any value whose host is
loopback or an RFC1918 address, logs that the configured URL points at a private IP, and falls back
to its built-in endpoint.

## Running locally

Requires Node.js and a reachable PostgreSQL instance. Set the environment first — at minimum
`DATABASE_URL`, plus `QNET_API_URL` for the node to index, which per the rule above is a remote node
even when the explorer itself runs locally.

```bash
cd applications/qnet-explorer/frontend
npm install
npm run dev               # next dev, bound to 0.0.0.0
```

The tables, indexes and the seed row are applied on server start by `src/instrumentation.ts`.
Production build and start:

```bash
npm run build
npm start
```

Containers:

```bash
cd applications/qnet-explorer/frontend
docker compose up -d      # explorer on port 3000, plus optional redis and nginx
```

The compose file forwards a fixed list — `NODE_ENV`, `PORT`, `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_NETWORK`, `QNET_API_URL`, `REDIS_URL`, `SECURITY_WEBHOOK_URL`, `ALERT_EMAIL`, `DB_SSL`
and `DB_SSL_REJECT_UNAUTHORIZED` — and writes the database connection string into the file with only
`POSTGRES_PASSWORD` interpolated. Anything else a deployment needs (API key, faucet key, bridge base,
proxy-trust flags, the `PG*` fields) is added to the `environment:` block before compose passes it
through. Supply secrets from an env file or your orchestrator's secret store.

`npm run lint` runs `bunx biome lint --write && bunx tsc --noEmit`, so it needs bun in addition to
Node.js, and `--write` makes Biome apply its fixes to the working tree.

Never place database credentials, API keys or node hostnames in the repository; all of them are
environment inputs.

## Related documents

- [RPC API](../developers/rpc-api.md) — the node endpoints the sync service and proxy routes consume.
- [State](../architecture/state.md) — transaction types and state commitment behind the indexed rows.
- [Mobile wallet](mobile-wallet.md) — the verifying light client.
- [Maintenance](../operators/maintenance.md) — monitoring and operational practice.
