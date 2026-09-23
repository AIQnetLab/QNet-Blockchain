# Block explorer

This document describes the QNet block explorer in `applications/qnet-explorer`: a Next.js
application that serves block, transaction, address and token views from a PostgreSQL index that a
separate indexer process writes. It covers what the explorer shows,
how the three parts fit together, how chain data is ingested, which environment variables the
deployment needs, and how to run it locally.

## Layout

| Path | Role |
| --- | --- |
| `frontend/src/app/` | Next.js App Router pages and HTTP API routes |
| `frontend/src/components/` | UI components (search, faucet, node list, sections) |
| `frontend/lib/` | Web-tier server modules: read-only database access, security checks, rate limiting, monitoring |
| `frontend/src/lib/` | Client and shared helpers: API client, caching, token formatting, transaction mapping |
| `frontend/src/indexer/` | The indexer process: node client, chain follower, writer, migration runner |
| `frontend/src/server/head-hub.ts` | The per-process head snapshot the web tier serves |
| `frontend/migrations/` | Ordered schema migrations: `001_init.sql`, `002_batch_transfers.sql`, `003_indexer_v2.sql` |
| `frontend/scripts/` | Timestamp backfill, PostgreSQL install/backup/restore helpers, and `run-migrations.ts` behind `npm run db:migrate`, which reads only `001_init.sql` |
| `frontend/Dockerfile`, `frontend/docker-compose.yml` | Container build and a compose stack for the web tier with optional Redis and nginx |
| `frontend/ecosystem.config.example.js` | PM2 layout running the web tier and the indexer side by side |

The repository root of the explorer is a workspace whose `dev`, `build`, `start` and `lint` scripts
delegate into `frontend/`.

## What it shows

- `/explorer` — chain overview with recent blocks and transactions.
- `/explorer/block/[hash]` — block detail.
- `/explorer/tx/[hash]` — transaction detail, with the recipient list of a `BatchTransfers` envelope.
- `/explorer/address/[address]` — address page: balance, native transactions with incoming
  batch-transfer credits, and token transfers.
- `/explorer/tokens` and `/explorer/token/[contract]` — deployed token list, per-token page and
  holder list.
- `/explorer/qnc` — native QNC overview backed by the node rich list (top holders, total and
  circulating supply). QNC is the native coin, so this is a coin view, not a QRC-20 token page.
- `/nodes`, `/activate`, `/wallet`, `/testnet`, `/docs` — informational and tooling sections,
  including the testnet faucet and a node-activation helper.

## Architecture

Three parts, each its own process:

1. **Web tier** — one Next.js application. Pages are rendered by Next.js; the routes under
   `src/app/api/` are the explorer's own HTTP API. They read the PostgreSQL index through
   `lib/db.ts`, which issues only reads, and proxy the node directly for anything that must be live
   (rich list, search fallback, balance checks). `src/instrumentation.ts` runs once per server start
   in the Node.js runtime and starts the head hub.
2. **Indexer** — `src/indexer/`, compiled by `npm run build:indexer` into `dist-indexer/` and run by
   `npm run start:indexer`. It is the only writer: at start it takes the session advisory lock
   `pg_try_advisory_lock(hashtext('qnet-explorer-indexer'))`, exits if another indexer holds it,
   applies pending migrations and then follows the chain. It commits with `synchronous_commit = off`
   and at start re-derives the gaps from 5,000 heights below its stored prefix, so rows a crash lost
   are fetched again.
3. **Database** — PostgreSQL. The web tier can connect as a read-only role; the indexer needs write
   access.

Every block commit is one transaction. A commit that writes the head block, a delete that moves the
head and a reset each send `NOTIFY explorer_head` inside their transaction.
`src/server/head-hub.ts` keeps one `LISTEN` connection per web process and on each notification
refreshes one snapshot — `explorer_stats`, `sync_state` and the latest 50 enriched transactions —
that `/api/stream`, `/api/head` and the default first page of `/api/activity` serve from memory and
`/api/network/stats` takes its head and totals from; without a `LISTEN` connection it re-reads every
5 s. The overview, home and address pages follow the head through `useChainHead`: one `EventSource`
on `/api/stream` per tab, closed while the tab is hidden, with a 15 s poll of `/api/head` when the
stream fails. On a new head the overview refetches its default first page, the home page its stats at
most every 10 s and the address page its data at most every 3 s.

The migration runner (`src/indexer/migrate.ts`) applies every `migrations/NNN_*.sql` file not yet
recorded in `schema_migrations`, in name order, each file as one transaction. A database whose tables
predate that ledger is baselined by recording `001_init.sql` and `002_batch_transfers.sql` without
running them. `003_indexer_v2.sql` and `004_address_history.sql` set `lock_timeout = 5s` and `statement_timeout = 15min`, so a
migration that cannot take its locks fails rather than holding the read tier behind them. The
optional `pg_trgm` GIN index that makes token free-text search index-served is applied by hand.

## Ingestion

The indexer reads from every endpoint in `QNET_API_URLS` (comma-separated; `QNET_API_URL` when it is
unset) and sends `X-API-Key` when `QNET_API_KEY` is set. What enters the archive is what a quorum of
those endpoints names: with `n` endpoints the quorum is `floor(n/2) + 1`, and a value the block hash
does not cover needs `n - quorum + 1` matching answers, the smallest agreement that must include an
honest endpoint.

- **Identity.** Heights are read as compact header pages from `GET /api/v1/blocks/headers` (up to 1,000
  per request), asked of every endpoint not in quarantine at once; a page returns once every endpoint
  has answered, once a quorum has answered and at most one endpoint is outstanding, or 6 s after the
  request if a quorum has answered by then. A height is accepted with the hash a quorum names; its
  previous hash, merkle root, transaction count, producer and time need `n - quorum + 1` matching
  answers.
- **Bodies.** A block with transactions is fetched from `GET /api/v1/microblock/{height}` (responses
  over 64 MB are rejected) on the endpoints that report holding it. It is accepted when its
  transaction hashes rebuild the agreed merkle root (SHA3-256, leaf `0x00 || hash`, node
  `0x01 || left || right`, odd node duplicated) and `n - quorum + 1` endpoints serve identical rows. An
  endpoint whose body fails the root is quarantined for 30 minutes, or takes a 15 s cooldown when
  quarantining it would leave fewer than a quorum admitted. The row's hash, previous hash, merkle
  root, producer and agreed time come from the header; the body supplies the transactions.
- **Realtime.** One WebSocket at a time on `/ws/subscribe?channels=blocks` (the HTTP URL with
  `http`/`https` rewritten to `ws`/`wss`); a `NewBlock` event schedules the quorum read of its height.
  Reconnection backs off from 1 s to 30 s, and a socket that delivers no tip block for 45 s, or more
  than 500 events a second, is dropped so the subscription rotates to the next endpoint.
- **Network height.** `GET /api/v1/height` is asked of every healthy endpoint every 2 s while the
  socket is down, every 10 s while it is up but silent and every 30 s while blocks arrive. The network
  height is the quorum-th highest answer, and a single source may lead it by at most 600 blocks.
- **Gaps.** `sync_state.last_height` is the highest stored block and `indexed_prefix` the last height
  below the first hole; every hole is a `sync_gaps` range. Each second the catch-up claims the lowest
  due range and the highest due range inside the body retention window, ingests up to 1,000 heights
  of it in commits of at most 200 blocks or 150,000 estimated recipient rows, and requeues what is
  still missing with a backoff of `min(600, 15 × 2^min(tries, 6))` seconds.
- **Pruned bodies.** Nodes keep block bodies for `MICROBLOCK_BODY_RETENTION_BLOCKS` = 86,400 blocks. A
  height whose body the network has pruned is stored as an identity-only row
  (`body_indexed = FALSE`). Its time is the agreed header's; where the header carries none, below
  `SLOT_GAP_REANCHOR_GATE_HEIGHT` = 1,339,200 it is the slot time, the quorum-agreed time of block 0
  plus one second per height, and from that height on a lower bound from the nearest stored row below
  it. A stored body stays when a header calls its height empty. Nodes started with `QNET_ARCHIVE=1` keep
  archived bodies past that window and report them as `body: true`; the indexer asks `GET /api/v1/archive`
  where each endpoint's archive starts and treats heights at or above the `n - quorum + 1`-th lowest start as still
  obtainable: a missing body there is retried, not recorded as pruned.
- **Token transfers.** After blocks with transactions are stored, the node's `/api/v1/token-transfers`
  rows for that height range are fetched from the endpoints that served the agreed bodies, and each
  window of up to 10,000 heights is replaced when `n - quorum + 1` of them return identical rows.
- **Reorgs.** The `previous_hash` linkage with the stored neighbours is checked after every commit,
  and every 10 minutes up to 32 random stored heights are compared with the quorum's hashes. Where a
  quorum names another block at a stored height, the contradicted run is walked up to 1,000 heights
  each way: every row the quorum contradicts is deleted and queued for refill, and the walk stops at
  the first row it confirms or cannot decide. A quorum naming another block at the archive's anchor
  (block 1, re-asked every 30 minutes and before every repair) is a fresh genesis: the archive is
  truncated and rebuilt, and the dissenting endpoints are quarantined. Twenty consecutive header pages
  on which the endpoints agree on nothing halt ingestion; the next page they agree on lifts the halt.
- **Heal.** Every minute, or 10 minutes after a pass that finds or changes nothing, rows without a real
  hash, bodies inside the retention window whose transaction rows fall short of
  `tx_count - tx_skipped`, and identity-only rows back inside the window or at or above the archive reach are
  re-read through the same quorum path.

## Database schema

The three migrations create seven tables; the runner adds `schema_migrations`, its ledger of applied
files.

| Table | Key | Contents |
| --- | --- | --- |
| `blocks` | `height` | hash, `block_type`, version, timestamp, previous/merkle/state roots, producer and producer address, tx count, `tx_skipped`, `body_indexed`, gas used, signature and `signature_type`, size, `consensus_data` JSONB, `micro_blocks` array |
| `transactions` | `hash` | from/to, amount, nonce, block and `tx_index`, timestamp, gas price and limit, signature and public key, `tx_type` and `tx_type_data` JSONB, raw `data`, status |
| `batch_transfers` | `(tx_hash, tx_index)` | one row per recipient of a `BatchTransfers` envelope: block, timestamp, from/to, amount |
| `token_transfers` | `(tx_hash, log_index)` | contract, from/to, `amount` as `NUMERIC(80,0)`, `kind`, `std`, `token_id`, block, timestamp |
| `explorer_stats` | single row, `id = 1` | transaction totals overall and per type, block and batch-recipient totals, emission total, head height, hash and time |
| `sync_state` | single row, `id = 1` | `last_height`, `indexed_prefix`, `genesis_hash`, and the node height, subscription state, endpoint and heal backlog the indexer publishes every 5 s |
| `sync_gaps` | `start_h` | height ranges still to fetch, with a try count and the next retry time |

`tx_skipped` counts the transactions of a block that have no row of their own: genesis prefund
transfers, transactions from or to `EON1benchmark` accounts, transactions whose hash or addresses fail
the column checks, and a hash stored earlier in the block or under another block. `explorer_stats`
moves inside every commit by what the inserts reported as new minus what the deletes removed. A full
rebuild runs when `rebuilt_at` is null; a daily audit compares the counters with real counts and
clears `rebuilt_at` on a mismatch, so the next start rebuilds them.

Amounts and nonces use exact integer types, never floats: `amount`, `nonce`, `gas_price` and
`gas_limit` in `transactions`, and `batch_transfers.amount`, are `NUMERIC(20,0)` and hold the full u64
range; `blocks.total_gas_used` is `NUMERIC(30,0)`. The transaction list pages by keyset on
`(block, tx_index)` over `(block DESC, tx_index DESC)` indexes, and the address and contract indexes
on `token_transfers` carry `(block DESC, log_index DESC)`, so an address or token page is an
index-ordered scan bounded near the query limit.

## HTTP API routes

All under `/api` on the explorer itself (not the node). Read routes are rate-limited per client
identifier; `/api/activity`, for example, allows 600 requests per minute per client.

| Route | Purpose |
| --- | --- |
| `GET /api/activity` | Transaction list from the index, enriched for display: keyset pages by `cursor` and `dir`, numbered `page` jumps up to 200, a `types` filter; the default first page comes from the head snapshot |
| `GET /api/address/[address]` | Address summary and history, with incoming `BatchTransfers` credits merged in |
| `GET /api/address/[address]/history?cursor=&limit=` | The wallet's history feed: transactions sent or received, batch credits and token transfers as one newest-first list, `limit` 1–100 (default 50), ordered by block, source, position and hash, paged by the returned `next_cursor`. Amounts are raw (nano QNC or token base units, with the token's deploy-time symbol, decimals and logo); `fee` is the nano QNC the chain debited a sender |
| `GET /api/address/[address]/balance-proof` | Multi-node balance agreement check |
| `GET /api/blocks/[hash]` | Block by hash |
| `GET /api/tx/[hash]` | Transaction by hash; a `BatchTransfers` envelope carries its recipients |
| `GET /api/tokens`, `GET /api/token/[contract]`, `GET /api/token/[contract]/holders` | Token list, token detail, holders |
| `GET /api/qnc` | Native QNC rich list, proxied from the node's `/api/v1/richlist`; the genesis-funded load-test accounts come apart as `genesis_allocations` and the QNC page shows them on one line instead of among holders. `GET /api/address/[address]` sets `genesisAllocation` for such an account and the address page says so |
| `GET /api/network/stats` | Head, totals and emission from the head snapshot, plus Super nodes (distinct `Heartbeat` senders in the last complete 14,400-block epoch) and Light nodes (the largest per-epoch sum of bitmap `eligible_count` over the last three complete epochs), cached 60 s |
| `GET /api/search`, `GET /api/search/suggest` | Search and type-ahead |
| `POST /api/faucet/claim` | Testnet faucet dispatch |
| `POST /api/node/activate` | Node-activation helper, delegating to `BRIDGE_API_BASE` |
| `GET /api/head` | The head snapshot as JSON, the poll fallback for `/api/stream` |
| `GET /api/stream` | Server-sent `head` event on each new head snapshot; at most 6 streams per client, 15 s heartbeat |
| `GET /api/sync/start` | The indexer's published state: head, prefix, node height, lag, subscription, heal backlog, and `healthy` when the lag is at most 600 blocks and the last commit is under 120 s old; `POST` answers 410 |
| `GET /api/monitoring/health`, `GET /api/monitoring/alerts` | Health (database, indexer lag and freshness, monitoring) and alerting; health reports `degraded` when the last commit is over 120 s old or the lag exceeds 600 blocks |
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
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Connection fields for `scripts/backfill-timestamps.ts` |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | TLS for the database connection |
| `QNET_API_URL` | Single node URL, used when `QNET_API_URLS` is unset |
| `QNET_API_URLS` | Comma-separated node URLs: the indexer reads and votes over them; the API routes ask them in turn |
| `QNET_BOOTSTRAP_NODES` | Comma-separated node list used for validator discovery |
| `QNET_NODE_URL` | Node URL used by node-facing helpers |
| `QNET_API_KEY` | Sent as `X-API-Key` to the node to bypass its rate limits |
| `BRIDGE_API_BASE` | Base URL of the activation bridge used by `/api/node/activate` |
| `RATE_LIMIT_TRUSTED_PROXY`, `FAUCET_TRUSTED_PROXY` | Trust `X-Forwarded-For` when behind a proxy |
| `FAUCET_ENV`, `NEXT_PUBLIC_NETWORK` | Selects the testnet or mainnet faucet configuration |
| `FAUCET_PRIVATE_KEY` | Faucet signing key, read only at runtime |
| `SECURITY_WEBHOOK_URL` | Destination for security and alert events |
| `INDEXER_LOG_LEVEL` | Indexer log level: `err`, `warn` or `info` (the default) |
| `VERIFY_BUILD_ALLOWED_ORIGINS` | Extra origins allowed to call `/api/verify-build` |
| `NEXT_PUBLIC_GIT_COMMIT` | Commit shown by the build-verification route |
| `NODE_ENV` | Standard Next.js environment selector |

The API routes read the node through `src/lib/node-api.ts`: each read goes to the first node in the list that is
not cooling down, and a transport failure, timeout or 5xx moves it to the next and benches the failed node for
15 s, so one node restarting in a roll or saturated by a load test does not take balances and lookups with it. A
swap submission is a write and goes to one node only. A production build keeps only http(s) URLs with a publicly
routable host (a loopback, private, link-local or CGNAT host is dropped); with none left `/api/tx/[hash]` answers
503 naming the misconfiguration. Outside production an empty list falls back to `http://127.0.0.1:8001`. The
indexer accepts any http(s) URL in `QNET_API_URLS`.

## Running locally

Requires Node.js and a reachable PostgreSQL instance. Set the environment first — at minimum
`DATABASE_URL`, plus `QNET_API_URLS` (or `QNET_API_URL`) for the nodes to index.

```bash
cd applications/qnet-explorer/frontend
npm install
npm run dev               # next dev, bound to 0.0.0.0
```

The indexer runs beside the web tier from the same directory and applies the migrations when it
starts:

```bash
npm run build:indexer     # tsc -p tsconfig.indexer.json into dist-indexer/
npm run start:indexer     # node dist-indexer/main.js
npm run test:indexer      # builds, then runs the indexer's pure-function tests with node --test
```

Production build and start of the web tier:

```bash
npm run build
npm start
```

Containers:

```bash
cd applications/qnet-explorer/frontend
docker compose up -d      # web tier on port 3000, plus optional nginx
```

The compose stack runs the web tier; the indexer runs as its own process against the same database.
`ecosystem.config.example.js` lays out both under PM2, the web tier connecting as a read-only role.

The compose file forwards a fixed list — `NODE_ENV`, `PORT`, `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_NETWORK`, `QNET_API_URL`, `SECURITY_WEBHOOK_URL`, `ALERT_EMAIL`, `DB_SSL`
and `DB_SSL_REJECT_UNAUTHORIZED` — and writes the database connection string into the file with only
`POSTGRES_PASSWORD` interpolated. Anything else a deployment needs (API key, faucet key, bridge base,
proxy-trust flags) is added to the `environment:` block before compose passes it
through. Supply secrets from an env file or your orchestrator's secret store.

`npm run lint` runs `bunx biome lint --write && bunx tsc --noEmit`, so it needs bun in addition to
Node.js, and `--write` makes Biome apply its fixes to the working tree.

Never place database credentials, API keys or node hostnames in the repository; all of them are
environment inputs.

## Related documents

- [RPC API](../developers/rpc-api.md) — the node endpoints the indexer and proxy routes consume.
- [State](../architecture/state.md) — transaction types and state commitment behind the indexed rows.
- [Mobile wallet](mobile-wallet.md) — the verifying light client.
- [Maintenance](../operators/maintenance.md) — monitoring and operational practice.
