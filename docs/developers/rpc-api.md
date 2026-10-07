# RPC and HTTP API reference

This document is the reference for the HTTP surface a QNet node exposes. Every node runs a single
HTTP server, started by `start_rpc_server(blockchain, port)` in
`development/qnet-integration/src/rpc/mod.rs`, and that one server carries four surfaces: two plain-text
liveness probes, a WebSocket subscription endpoint, a JSON-RPC 2.0 endpoint registered at two paths,
and the REST routes under `/api/v1`.

## For application developers

The public routes answer any origin with no credentials ([CORS](#cors)), so a page may read them; a page
that signs or sends anything asks the user's wallet ([dApp integration](dapp-integration.md)). A server,
a script or the `qnet` command calls the same routes without an `Origin` header. The routes an
application uses:

| Need | Routes |
| --- | --- |
| Height and blocks | `GET /api/v1/height`, `GET /api/v1/block/latest`, `GET /api/v1/block/{height}`, `GET /api/v1/blocks/headers`, WebSocket `blocks` |
| Balance and nonce | `GET /api/v1/account/{address}`, `GET /api/v1/account/{address}/balance`, `GET /api/v1/account/{address}/balance/proof?mb=latest` (verifiable) |
| Submit | `POST /api/v1/transaction`, `POST /api/v1/contract/call`, `POST /api/v1/contract/deploy` ([Transactions](transactions.md)) |
| Follow a transaction | `GET /api/v1/transaction/{hash}`, `GET /api/v1/transactions/history` |
| Tokens | `GET /api/v1/token/{contract}`, `GET /api/v1/token/{contract}/balance/{holder}`, `GET /api/v1/token/{contract}/{holder}/balance/proof?mb=latest` (verifiable), `GET /api/v1/account/{address}/tokens`, the token-transfer feeds |
| Contracts | `GET /api/v1/logs`, `GET /api/v1/logs/proof` (verifiable), `POST /api/v1/contract/call` with `is_view: true`, `GET /api/v1/account/{contract}` ([Smart contracts](smart-contracts.md#reading-contract-state)) |
| Certified state | `GET /api/v1/state/certified`: the macroblocks this node serves proofs at, and its heights |
| Fees | `GET /api/v1/gas/recommendations` |

"Verifiable" answers carry a proof a client checks against a checkpoint the committee certified: the
certified form (`?mb=`) of the two balance proofs folds to the `state_root` of a macroblock whose quorum
certificate the client verifies itself ([Certified state proofs](#certified-state-proofs)), and
`/api/v1/logs/proof` to that checkpoint's `logs_root`. The legacy form of the balance proofs (no `mb`)
proves against the answering node's live root at its applied tip, which folds to a certified root only
while no account changed since that macroblock. Every other answer is the node's word.

The public testnet nodes are `https://node1.aiqnet.io` to `https://node5.aiqnet.io`: a TLS reverse
proxy on each server in front of the node's plain-HTTP port. Recorded from `node1` on 2026-09-25:

```bash
curl -s https://node1.aiqnet.io/api/v1/height
```

```json
{"blocks_behind":0,"height":2210863,"is_syncing":false,"network_height":2210863}
```

## Base URL and transport

| Property | Value |
| --- | --- |
| Bind address | `0.0.0.0` (all interfaces) |
| Port, Super nodes | `QNET_API_PORT`, default `8001` |
| Port, Light nodes | the node's P2P port (Light nodes reuse the same server entry point) |
| JSON-RPC path | `POST /rpc` and `POST /` |
| REST base | `http://<host>:<port>/api/v1/` |
| WebSocket | `ws://<host>:<port>/ws/subscribe` |

The listener is plain HTTP. Deployments that need HTTPS terminate TLS in a reverse proxy or load
balancer in front of the node — see the proxy note under [Rate limiting](#rate-limiting), because
proxying changes how the node sees client IPs.

The bind is probed with up to 10 attempts, 2 seconds apart, to survive a socket left in `TIME_WAIT`
by a fast container restart. If all 10 attempts fail, or if the server ever returns, the process
calls `std::process::exit(1)` so the supervisor restarts the node.

A separate HTTP server, defined in `development/qnet-integration/src/bin/qnet-node.rs`, binds
`rpc_port + 100` and answers `GET /metrics` in the plain-text metrics exposition format (a `# HELP`
line, a `# TYPE` line and one sample line per series) with five series:
`qnet_node_uptime_seconds` (counter) and the gauges `qnet_blocks_height` (applied height),
`qnet_network_height`, `qnet_blocks_behind` and `qnet_peers_connected`. Its bind is probed the same way;
if every attempt fails, the node runs without the metrics listener. Further node telemetry comes as JSON
from the `/api/v1/*` paths with "metrics" in their name.

## Liveness probes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Returns the literal string `OK` with HTTP 200. Touches no state. |
| GET | `/healthz` | Returns `ok h={height} build={build}`: the height from the `LOCAL_BLOCKCHAIN_HEIGHT` atomic and the build id (`QNET_BUILD_ID` as the image sets it, else `v{crate version}-unstamped`). One atomic load, no locks. |

Container health checks should target `/healthz`. It reads no blockchain, P2P or mempool state, so it
stays accurate even when the heavier API surfaces are blocked. `/api/v1/node/health` reads all of that
state and is intended for monitoring dashboards rather than orchestrator liveness.

## Authentication

Authentication is per-endpoint and applies where an action is privileged or destructive.

| Gate | Where it applies | Behaviour |
| --- | --- | --- |
| `X-API-Key` header | `POST /rpc`, `POST /`, `GET /api/v1/blocks/headers` and the `/api/v1/archive` routes | Matched against `QNET_API_KEY_EXPLORER` / `QNET_API_KEY_ADMIN`. Minimum 16 characters, enforced both at load and at check. A valid key bypasses rate limiting; it grants no extra methods. |
| `QNET_DEV_API_KEY` | same three routes | Additional key, compiled in under `#[cfg(debug_assertions)]` for debug builds. |
| Internal-IP check | `POST /api/v1/p2p/message`, `POST /api/v1/shutdown`, the JSON-RPC operator methods | `is_internal_ip()` accepts loopback, RFC1918, IPv4 link-local, IPv6 loopback, `fc00::/7`, `fe80::/10`, and anything in `QNET_WHITELIST_IPS`. Unparseable strings are rejected. A request with an `Origin` header (a web page) never passes ([CORS](#cors)). |
| `QNET_ADMIN_SECRET` | `POST /api/v1/shutdown` | Mandatory. If the variable is unset or empty the request is denied. Also requires an internal caller IP and a matching `admin_secret` field in the body. |
| `QNET_ADMIN_SECRET` | `GET /api/v1/node/secure-info` | Read from `Authorization: Bearer <secret>`, or from an `admin_secret` query parameter. Enforced whenever the variable is configured, so set it on any node whose API port is reachable. |
| Genesis-IP allowlist | `POST /api/v1/internal/fcm-token-sync`, `GET /api/v1/internal/fcm-token-get`, `GET /api/v1/internal/light-ping-keys-get`, `GET /api/v1/internal/light-reach-get`, `POST /api/v1/internal/light-unbind-sync`, `POST /api/v1/internal/light-device-attest`, `POST /api/v1/internal/light-device-sync`, `GET /api/v1/internal/light-device-get` | The five genesis addresses only (`GENESIS_NODE_IPS`, `is_genesis_peer_ip`); every other caller, loopback included, receives HTTP 403. A request through the host's TLS terminator counts as the client the terminator names in `X-Forwarded-For`, so one that arrives as loopback is a terminator that passed no client on ([genesis host checks](../operators/genesis-host-checks.md)). `light-device-attest` also requires the caller to be the genesis its `ingress` names. The genesis nodes call these routes over TLS at their HTTPS names; the device-layer routes, the three `-get` pulls, the unbind sync and a token sync without a `proof` never fall back to plain HTTP, and only a token sync carrying the device's `proof` may retry in plain HTTP when the connection to 443 cannot be made or the host answers 403 over TLS. |
| `QNET_BENCHMARK_SECRET` | every `/api/v1/benchmark/*` route (`start`, `stop`, `status`, `results`, `presets`) | Unset or shorter than 16 characters: every route answers `{"success": false, "error": "benchmark_disabled", ...}`, a genesis node included. Set: each route requires it in the `X-Benchmark-Secret` header (`start` also takes the body's `secret`), compared as SHA3-256 digests; anything else answers `{"success": false, "error": "unauthorized"}` and nothing is started, stopped or shown. |
| Submitter-IP match | `DELETE /api/v1/bundle/{bundle_id}` | Caller IP must equal the recorded submitter IP, or pass `is_internal_ip()`; a request with an `Origin` header never matches. |

The API key applies to the two JSON-RPC routes, to `GET /api/v1/blocks/headers` and to the `/api/v1/archive` routes,
and is read from the `x-api-key` header.

Signature-based authorisation is separate from transport authentication. Every value transfer, reward
claim and contract deployment carries a mandatory ML-DSA-65 (FIPS 204) signature. The transfer and
claim handlers verify it whenever the public key is on the wire, and `submit_transaction` verifies every
value transaction (transfer, batch transfer, contract deployment and call) before mempool admission,
rehydrating an elided key from committed state. See [cryptography](../architecture/cryptography.md).

## Rate limiting

Rate limiting is a per-IP, per-category sliding window. The client IP is the TCP peer's address,
except when the peer is loopback and the request carries `X-Forwarded-For`: then it is the last
address in that header, the one the TLS proxy on the same host appended (`client_addr` in
`rpc/mod.rs`), so a value a client writes into the header itself is never taken.

| Category | Requests | Window | Block duration | Used by |
| --- | --- | --- | --- | --- |
| `read_only` | `max(tx_rate * 3, 300)` | 60 s | 30 s | most GET routes; all JSON-RPC methods except the write set |
| `general` | `max(tx_rate, 100)` | 60 s | 60 s | fallback bucket, including the `write`, `batch_transfer` and `register_node` handlers |
| `transaction` | `tx_rate` (default 100) | 60 s | 300 s | `POST /api/v1/transaction`, node registration/reactivation submit, non-view contract calls |
| `activation` | 5 | 3600 s | 3600 s | `POST /api/v1/register-device`, contract/token/NFT/WASM deploy |
| `light_node_register` | 3 | 3600 s | 3600 s | `POST /api/v1/light-node/register` |
| `light_node_ping` | 120 | 60 s | 60 s | light-node ping response. An IP is not a device: a household answers from several phones and a carrier NAT fronts thousands, while the per-epoch dedup already bounds the verification work to one per node per epoch |
| failed light requests (`FailLimiter`, one per route) | 60 refusals | 60 s | 60 s | `POST /api/v1/light-node/bind` (a pending binding included), `POST /api/v1/light-node/unbind`, `POST /api/v1/light-node/token-refresh`: only a request refused before or at its signature check counts (a pending binding with no burn seen too), an IPv6 address by its /64; one whose signatures verify is limited per node instead (bind and unbind 5 an hour, the token refresh 6) |
| `light_node_wake` | 20 | 3600 s | 600 s | `POST /api/v1/light-node/wake`; the sender also caps each node |
| `light_node_status_signed` | 120 | 60 s | 60 s | `POST /api/v1/light-node/status` (the signed status) |
| `light_device_challenge` | 120 | 60 s | 60 s | `GET /api/v1/light-node/device-challenge` |
| `light_device_refresh` | 30 | 3600 s | 600 s | `POST /api/v1/light-node/device-refresh` |
| `light_device_rotate` | 30 | 3600 s | 600 s | `POST /api/v1/light-node/device-rotate` |
| `claim_rewards` | 10 | 3600 s | 1800 s | `POST /api/v1/rewards/claim` |
| `consensus` | 60 | 60 s | 60 s | `POST /api/v1/p2p/message` |
| `mev_bundle` | 30 | 60 s | 120 s | bundle submit/status/cancel |
| `benchmark` | 5 | 60 s | 300 s | all `/api/v1/benchmark/*`, `POST /api/v1/shutdown` |
| `headers` | 30 | 60 s | 60 s | `GET /api/v1/blocks/headers`; a valid API key bypasses it |
| `archive` | 30 | 60 s | 60 s | `GET /api/v1/archive`, `GET /api/v1/archive/segment/{epoch}`; a valid API key bypasses it |
| `certified_proof` | 600 | 60 s | 30 s | the certified form (`?mb=`) of `/api/v1/account/{address}/balance/proof` and `/api/v1/token/{contract}/{holder}/balance/proof`; an IPv6 address counts by its /64; refused with HTTP 429 ([Certified state proofs](#certified-state-proofs)) |
| `certified_state` | 600 | 60 s | 30 s | `GET /api/v1/state/certified`; an IPv6 address counts by its /64; refused with HTTP 429 |

`tx_rate` is `QNET_API_RATE_LIMIT`, parsed as requests per minute and clamped to `1..=10_000`,
default `100`. The two certified buckets do not scale with it.

Once a bucket is exceeded, `blocked_until = now + block_duration` is set, so requests are refused for
the entire block window regardless of how the client slows down afterwards. Stale limiter state is
garbage-collected every 1000 checks: if more than 1000 IPs are tracked, IPs with no request in the
last 600 seconds are dropped.

### Shape of a rejection

A throttled REST or JSON-RPC request returns HTTP 200 with the error inside the JSON body:

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "retry_after_seconds": 42,
  "message": "Too many requests. Please wait 42 seconds before retrying."
}
```

Client code should branch on `success === false` and `error === "Rate limit exceeded"` rather than on
the HTTP status. The retry hint is the `retry_after_seconds` field. Two paths answer with HTTP 429
instead: the WebSocket upgrade refusal, carrying the plain body `WebSocket connection limit exceeded`,
and the certified routes (the `?mb=` form of the balance proofs and `/api/v1/state/certified`), which
answer `{"proof_format": 2, "error": "rate_limited", "retry_after_seconds": N}` with `Retry-After` and
`Cache-Control: no-store`, so a client never takes a refusal for a legacy proof body.

### Whitelisting and the proxy note

`check_api_rate_limit` returns `Ok(())` for any IP in `WHITELIST_IPS` before touching a counter.
`WHITELIST_IPS` always contains `127.0.0.1` and `::1`, plus every address in `QNET_WHITELIST_IPS`.

A reverse proxy on the same host must append the client's address to `X-Forwarded-For`; without the
header every request it forwards counts as `127.0.0.1`, which is whitelisted. A proxy on another host
is seen as one client, so enforce rate limiting at that proxy.

## Request and response conventions

- **REST handlers return HTTP 200** and carry the outcome in the JSON body (typically
  `{"success": false, "error": "..."}` or `{"error": "...", "details": "..."}`). Fourteen REST paths set
  a non-200 status: `/api/v1/account/{address}` (503 `account_unreadable`, 400 `fields_unsupported`),
  `/api/v1/account/{address}/balance` (503 `account_unreadable`),
  `/api/v1/microblock/{height}` (404/500), `/api/v1/genesis/block` (404),
  `/api/v1/blocks/headers` (500), `/api/v1/archive/segment/{epoch}` (404),
  `/api/v1/internal/fcm-token-sync` (403/400/500), `/api/v1/internal/fcm-token-get` (403/400),
  `/api/v1/internal/light-ping-keys-get` (403), `/api/v1/internal/light-unbind-sync` (403/400),
  `/api/v1/internal/light-device-attest` (403), `/api/v1/internal/light-device-sync` (403/400),
  `/api/v1/internal/light-device-get` (403) and `/api/v1/internal/light-reach-get` (403/400). The
  certified form of the two balance-proof routes (400, 404, 410, 429, 503) and `/api/v1/state/certified`
  (429) answer with real statuses too ([Certified state proofs](#certified-state-proofs)).
- **The HTTP layer's own refusals are plain text**, not JSON: HTTP 400 for a JSON body or query that
  does not deserialize (a missing required field, an integer sent as a string, a number above the
  64-bit range), 413 above a route's body cap, 415 for a body that is not JSON, 405 for a known path
  with the wrong method (recorded: a GET request to `/api/v1/wasm/deploy` answers 405), 403
  `CORS request forbidden: ...` for a browser preflight that asks for a method or header outside the
  [CORS](#cors) lists, 403 with an empty body for a preflight to a gated route, and 429 on a refused
  WebSocket upgrade.
- **Body size caps** are per-route, enforced by `warp::body::content_length_limit`:

  | Route | Cap |
  | --- | --- |
  | `POST /rpc`, `POST /` | 1 MiB |
  | `POST /api/v1/transaction` | 64 KiB |
  | `POST /api/v1/batch/transfer` | 256 KiB |
  | `POST /api/v1/bundle/submit` | 256 KiB |
  | `POST /api/v1/contract/call` | 128 KiB |
  | `POST /api/v1/contract/estimate-gas` | 128 KiB |
  | `POST /api/v1/token/deploy`, `POST /api/v1/nft/deploy` | 128 KiB |
  | `POST /api/v1/node-registration/submit` | 128 KiB (large ML-DSA-65 signature) |
  | `POST /api/v1/light-node/ping-response` | 64 KiB (enveloped ML-DSA-65 signatures) |
  | `POST /api/v1/rewards/claim` | 256 KiB |
  | `POST /api/v1/p2p/message` | 2 MiB |
  | `POST /api/v1/contract/deploy` | 2 MiB |
  | `POST /api/v1/wasm/deploy` | 1 MiB |
  | `POST /api/v1/benchmark/start` | 64 KiB |
  | `POST /api/v1/shutdown` | 4 KiB |

- **EON addresses** are validated before any processing by `validate_eon_address_with_error`: exactly
  45 ASCII characters — 19 lowercase hex, the literal `eon`, 15 lowercase hex, and an 8-character
  checksum taken from the first 4 bytes of a SHA3-256 digest. Non-ASCII input is rejected before any
  slicing.
- **Large integers are serialized as JSON strings** wherever a value can exceed 2^53 and would round
  in a JavaScript client: checkpoint `total_supply`, QRC-20 `total_supply` / `total_minted` /
  `total_burned` / balances, and richlist balances.
- **Retention fields.** Endpoints that read prunable history return an `oldest_available` field (and
  a `pruned_below` field where relevant), so an empty result below the prune floor is distinguishable
  from an empty history: `/api/v1/logs`, both token-transfer feeds and the token-transfer range feed.
  `/api/v1/logs/proof` answers a pruned window with
  `{"error": "window_pruned", "oldest_available": ...}`.
- **Wallet addresses in headers.** `/api/v1/node/status`, `/api/v1/activations/by-wallet` and
  `/api/v1/verify-activation` accept the wallet in an `X-QNet-Wallet` request header instead of a
  query string, to keep it out of URLs and access logs.

### CORS

The public routes allow any origin: a web page, or the browser extension, whose
`chrome-extension://` or `moz-extension://` origin differs per build and per install. No route reads a
cookie or another browser credential, and `allow_credentials` is never enabled. The WebSocket
subscription is served outside the CORS filter (its feed carries only public notices). Requests
without an `Origin` header (servers, scripts, the wallets' own requests) are not affected.

| Mode | Methods | Headers | `max_age` |
| --- | --- | --- | --- |
| Production (default) | POST, GET, OPTIONS | `Content-Type`, `Authorization`, `User-Agent`, `X-API-Key` | 86400 s |
| `QNET_DEV_MODE` set | adds PUT, DELETE | adds `X-Requested-With` | 3600 s |

The gated routes are served outside the CORS filter and answer no CORS header: the internal-IP routes
(`POST /api/v1/p2p/message`, `POST /api/v1/shutdown`, `POST /api/v1/node-reactivation/submit`), the
genesis-only `/api/v1/internal/*` routes and `DELETE /api/v1/bundle/{bundle_id}`. A preflight for one
of their paths is answered 403 with no CORS header, and a request that carries an `Origin` header is
taken as coming from no address in particular (`0.0.0.0`): never internal, whitelisted or a genesis,
whatever address the visitor's browser sends from. The same holds for the JSON-RPC operator methods,
the full peer list of `GET /api/v1/nodes/discovery` and the genesis forward of
`POST /api/v1/light-node/wake`.

## JSON-RPC 2.0

`POST /rpc` and `POST /` share the same handler, the same 1 MiB cap, the same `x-api-key` handling and
the same rate-limit categories. They differ in how the path is matched: `POST /` matches the root and
nothing else, while `/rpc` is matched by prefix, so any path beneath it — `POST /rpc/v2`, for example —
reaches the same JSON-RPC dispatcher. Each request body carries exactly one request object.

Request envelope — `jsonrpc`, `method` and `id` are required, and `id` is an unsigned integer.
`params` is optional and may be omitted entirely for parameterless methods:

```json
{ "jsonrpc": "2.0", "method": "chain_getHeight", "params": {}, "id": 1 }
```

Response envelope — `result` and `error` are mutually exclusive and the absent one is omitted:

```json
{ "jsonrpc": "2.0", "result": { "height": 412977 }, "id": 1 }
```

### Methods

| Method | Params | Notes |
| --- | --- | --- |
| `node_getInfo` | none | `node_id` (`node_{port}`), height, peers, mempool size, version, `build` (as in `/healthz`), node type, region, status. |
| `node_getPeers` | none | `{count, peers[], max_peers: 50, connection_status}`; each peer has id, address, node_type, region, last_seen, connection_time, reputation, version. |
| `chain_getHeight` | none | `{height}` |
| `chain_getBlock` | `{height}` | The block JSON with its `hash`, or error `-32000`. |
| `chain_getBlocks` | `{start, limit}` | `limit` defaults to 10, capped at 100. Returns an array of block JSON with `hash`. |
| `tx_submit` | `{from, to, amount, gas_price?, gas_limit?, dilithium_signature, dilithium_public_key?}` | Builds a transfer with nonce 0, which the nonce rule (committed nonce + 1, at least 1) always refuses; submit transfers with `POST /api/v1/transaction`. |
| `tx_sendTransaction` | as `tx_submit` | Alias of `tx_submit`. |
| `tx_get` | `{hash}` | The transaction as `GET /api/v1/transaction/{hash}` finds it. |
| `mempool_getTransactions` | none | |
| `mempool_submit` | a transfer object, or an array of them: `{from, to, amount, nonce, timestamp?, dilithium_signature, dilithium_public_key}` | Transfers only, with the gas price fixed at 10 and the gas limit at 10,000 (sign those values) and the public key always required. `POST /api/v1/transaction` is the general route. |
| `account_getInfo` | `{address}` | |
| `account_getBalance` | `{address}` | `{balance}` in nanoQNC. |
| `stats_get` | none | |
| `qrb_getRandomness` | epoch selector | Randomness beacon; error `-32001` if the epoch is not finalized. |
| `qrb_getLatestRandomness` | none | Error `-32001` if no epoch is finalized yet. |
| `qrb_getRandomnessWithSeed` | epoch selector + seed | |
| `device_migration` | `{activation_code, new_device_signature, dilithium_signature, dilithium_public_key}` | Verifies ML-DSA-65 over `migrate:{activation_code}:{new_device_signature}`. |
| `node_getTransferStatus` | `{activation_code}` | `{has_activation, node_type, activated_at, supports_transfer, device_support}` |
| `node_attestBurn` | burn attestation | Genesis-side verification of an external Phase 1 burn. The owner bind in the params is the v1 form or, for a light node from the `wallet_one_node` gate at this node's next height, the form without a time ([light node messages](../protocols/light-node-messages.md#4-wallet-key-and-ping-key-messages)); a light node's bind in the form without a time that verifies before that gate is refused `-32602` with `data: {code: "bind_v2_pending"}` (a retry, not a refusal of the burn). From that gate a wallet that already has another node on chain is refused `-32602` `wallet already has a node` before any epoch, committee or Solana work. A first-sight Solana lookup is metered per burner (8 a minute) and per node (240 a minute): a caller outside the committee shares a lane of 60 a minute, each address 10 per 10 minutes; each committee caller (a member's address, or this node's own submit door asking in-process) spends its own share of the rest, split over the committee callers that spent a lookup in this window or the last (never over fewer than the five genesis nodes) and never below one burner's 8, so garbage pushed through one door never starves the others (`-32050` `attest_pending` with `retry_after_secs` once spent). A request whose `Origin` header is not one the registration doors answer (see `POST /api/v1/node-registration/submit`) is answered HTTP 403 with `-32005` `Origin not allowed` before any work; every other method is unaffected. |
| `node_armRecovery` | none | Operator. Dry-runs the recovery arm conditions; when they hold, hands the arm to the consensus loop and returns `{armed: true, anchor_mb, anchor_cp_index, anchor_digest, span_windows, committee, quorum_size, relaxed_quorum}`, otherwise `{armed: false, reason}`. |
| `node_disarmRecovery` | none | Operator. Hands a disarm to the consensus loop; `{disarm_requested, armed}`. |
| `node_recoveryStatus` | none | Operator. `{armed: true, anchor_mb, anchor_cp_index, anchor_digest, span_windows, heard_from, committee, quorum_size, relaxed_quorum}` while armed, otherwise `{armed: false, enabled, heard_from}`. |
| `node_decreeEndorse` | `{seq, target_height}` | Operator. Signs the recovery decree `RDCR:{genesis_hash}:{seq}:{target_height}` with this node's consensus key; `{node_id, sig}`. Only genesis signatures count toward a decree. |
| `node_decreeSubmit` | `{seq, target_height, sigs: [{node_id, sig}]}` | Operator. Accepts a `seq` above the applied decree floor whose valid genesis signatures reach `quorum_size` of the genesis set, gossips the decree to 16 random peers, and 3 s later prunes this node's chain above `target_height` and exits for a clean restart; `{accepted, seq, target_height}`. |

The last five methods are operator methods: a caller whose address fails `is_internal_ip()` receives
`-32004`.

### Error codes

| Code | Meaning |
| --- | --- |
| `-32000` | Internal error, or requested object not found |
| `-32001` | Epoch not yet finalized (randomness beacon) |
| `-32003` | ML-DSA-65 signature verification failed on device migration |
| `-32004` | Operator method called from an address that fails `is_internal_ip()` |
| `-32050` | `attest_pending` — the caller is not yet promoted by the attestation admission throttle; `error.data.retry_after_secs` carries the backoff hint |
| `-32601` | Method not found; also returned by `node_attestBurn` when this node is not an attestor for the requested `attest_epoch`, so treat it as method-specific before concluding a method is unsupported |
| `-32602` | Invalid or missing params |
| `-32029` | WebSocket-only: JSON-RPC rate limit exceeded |

### Example

```bash
curl -s -X POST http://127.0.0.1:8001/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"account_getBalance","params":{"address":"<eon-address>"},"id":1}'
```

## WebSocket

`GET /ws/subscribe?channels=...` upgrades to a WebSocket. The server accepts the channel forms
`blocks`, `account:ADDRESS`, `contract:ADDRESS`, `rewards:NODE_ID`, `mempool` and `tx:HASH`,
comma-separated, at most 50; the default is `blocks`. Only `blocks` and `mempool` deliver events: the
node broadcasts a `NewBlock` frame per block and a `PendingTx` frame per admitted transaction, and
sends nothing on the other channels. On connect the server sends a welcome frame;
`subscribed_channels` is the number of channels parsed:

```json
{
  "type": "connected",
  "message": "WebSocket connected to QNet node",
  "subscribed_channels": 1,
  "timestamp": 1755300000,
  "node_id": "...",
  "rate_limit": { "max_per_ip": 5, "your_connections": 1 }
}
```

| Limit | Value |
| --- | --- |
| Concurrent connections per IP | 5 |
| Concurrent connections node-wide | 10 000 |
| JSON-RPC requests per connection | 100 per 60 s sliding window |
| Maximum text frame | 65 536 bytes |

A block frame, recorded from `wss://node1.aiqnet.io/ws/subscribe?channels=blocks` on 2026-09-25
(hash shortened):

```json
{"type":"NewBlock","data":{"height":2211450,"hash":"4feb95bd…1a71","timestamp":1790361733,"tx_count":0,"producer":"genesis_node_001"}}
```

Three JSON-RPC methods are served over the socket: `chain_getBlocks` (limit capped at 20),
`chain_getBlock` and `chain_getHeight`. Anything else returns `-32601`. Exceeding the per-connection
rate limit returns `-32029`.

## REST: chain and blocks

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/height` | `{height, network_height, is_syncing, blocks_behind}` using `max(local, cached P2P height)`. Past the node-wide budget (four times the most pushes a genesis sends a second, 1,024 at once), after the per-address limit, HTTP 503 with `Retry-After` and `{success: false, reason: "overloaded", error, retry_after_seconds}` (light node messages section 5.10); never for another genesis or a whitelisted address |
| GET | `/api/v1/block/latest` | Block at the current tip |
| GET | `/api/v1/block/{height}` | Block JSON plus `timeout_round`, `carried_baseline` and `abs_round` (= sum of the two) injected from the stored microblock |
| GET | `/api/v1/block/hash/{hash}` | `{hash, found, height, block}`; looks the 32-byte hex hash up in the height→hash index from `tip − 1000` through the tip; `block` is `null` once the body is pruned |
| GET | `/api/v1/genesis/block` | Full block 0 with its transactions, bincode + zstd, as `application/octet-stream` (computed once per process; identical bytes on every node, so a joining node's multi-source hash vote agrees); HTTP 404 `{error:"genesis_block_unavailable"}` when the node cannot reconstruct block 0 |
| GET | `/api/v1/microblock/{height}` | Block JSON; HTTP 404 `Block not yet produced` for a future height, `Block not found` for a missing one; HTTP 500 `Failed to load block` on a storage error |
| GET | `/api/v1/microblocks?from=&to=` | `{from, to, items[{height, data}]}` with `data` as base64 raw bytes; `to` is clamped to `from + 100` |
| GET | `/api/v1/blocks/headers?from=&limit=` | `{from, next, head, items[{height, hash, body, timestamp, producer, tx_count, previous_hash, merkle_root}]}` for the heights this node holds in `[from, min(from + limit, head + 1))`, hashes hex; `from` defaults to 0 and `limit` to 100, clamped `1..=1000`. `hash` comes from the height→hash index and outlives the body; the header fields appear only when `body` is true, which past the retention window it is where this node's history archive holds the block, and a row that fails to decode comes back as `{height, hash, body: false, error: "undecodable"}`. `next` is the first height not covered, `head` the applied tip. `headers` rate bucket; at most 4 scans run at once |
| GET | `/api/v1/archive?from_epoch=&limit=` | `{enabled, segment_blocks, next_epoch, segments[{epoch, first_height, last_height, blocks, missing[[from, to]], macroblocks, macroblocks_unsigned, bytes, sha3}]}`: the history segments this node holds, ascending from `from_epoch` (default 0), `limit` default 100, clamped `1..=1000`. `macroblocks` counts the certifying macroblocks a segment carries, `macroblocks_unsigned` those whose committee signatures were already stripped when it was written. `enabled` is false and the list empty on a node started without `QNET_ARCHIVE=1`. `archive` rate bucket |
| GET | `/api/v1/archive/segment/{epoch}` | One segment file as written, streamed as `application/octet-stream` with `Content-Length` and `X-Segment-Sha3` (the index's `sha3`); HTTP 404 when this node holds no segment for the epoch. Format, little-endian: header `QARC`, version byte, epoch, first and last height (u64); frames of `zstd_len u32` + zstd of `{len u32, record}` records, each about 1 MiB uncompressed, holding first the blocks (bincode `MicroBlock` with `signature`, `vrf_proof` and `timeout_proof` emptied) and then every macroblock whose window covers the epoch (bincode `(MacroBlock bytes, [(signer, public key)])`, the committee signatures kept); a block index and a macroblock index, each `count u32` + `{key u64, frame_offset u64, record_offset u32}` (key = height or macroblock index); footer `block_index_offset u64` + `macro_index_offset u64` + `QARX`, so one record is read by decoding one frame. A segment verifies without trusting its server: signatures → checkpoint → the window's block hashes → block → transactions. `archive` rate bucket |
| GET | `/api/v1/macroblock/{index}` | `{index, height, timestamp, micro_blocks_count, micro_blocks[], state_root, consensus_data{...}, previous_hash}` |
| GET | `/api/v1/blocks/stats` | Height, block-time and macroblock-boundary counters |

`/api/v1/block/latest`, `/api/v1/block/{height}`, `/api/v1/block/hash/{hash}` and
`/api/v1/microblock/{height}`, and `chain_getBlock` / `chain_getBlocks` over JSON-RPC and WebSocket,
return the block JSON plus a `hash` field (past the retention window the block comes from the node's history
archive where it keeps one, with an empty `signature`): the block's consensus hash as hex from the height→hash index,
`null` when the index holds no row for the height and none can be rebuilt from the stored body.
`previous_hash` keeps its 32-element byte-array form.

## REST: light-client proofs

These are the endpoints a device uses to verify chain state without trusting the server. See
[consensus](../architecture/consensus.md) and [state](../architecture/state.md) for what each root
commits to.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/macroblock/{index}/proof` | Full bundle: `{index, epoch, checkpoint, qc{signers, sigs}, committee, committee_pubkeys, eligible_raw, banned, recovery_anchor_checkpoint}`. `committee_pubkeys` covers the derived committee union the QC's actual signers. Past the QC-signature retention the signatures and any signer key the node can no longer resolve come from its history archive, when it keeps one and the archived checkpoint hashes the same. |
| GET | `/api/v1/registry/height/{height}` | `{registry_root, entries}` — the chain-confirmed roster as of that height plus its LtHash root |
| GET | `/api/v1/validators/proof` | `{validators[], epoch, merkle_root, last_update_height, current_height, total_validators, active_validators}`; the root is SHA3-256 over the tag `QNET_VALIDATOR_SET:` + epoch + each sorted validator's fields, computed by the answering node over its own list and not tied to any checkpoint, so it is a plain read, not a proof |
| GET | `/api/v1/account/{address}/balance/proof?mb=latest\|{j}` | The certified form: the account at macroblock j, proven against that checkpoint's `state_root` ([Certified state proofs](#certified-state-proofs)) |
| GET | `/api/v1/token/{contract}/{holder}/balance/proof?mb=latest\|{j}` | The certified form of the two-level QRC-20 balance proof |
| GET | `/api/v1/state/certified` | `{proof_format, views[{macroblock_index, state_height, state_root}], newest_certified_index, finalized_height, applied_height, capture}` |
| GET | `/api/v1/account/{address}/balance/proof` | Legacy form, without `mb`: balance, nonce, all four heartbeat leaf fields, `last_claimed_epoch`, `banned_at_height`, `is_node`, `merkle_proof[{sibling, is_right}]`, `state_root`, `block_height`, `proof_valid`, proven against the node's live root at its applied tip |
| GET | `/api/v1/token/{contract}/{holder}/balance/proof` | Legacy form: `storage_proof`/`storage_root` for the balance leaf plus `account_proof` and every contract-account leaf field, anchored by the live `state_root` and `block_height` |
| GET | `/api/v1/logs/proof?tx_hash=&log_index=` | Sharded two-level inclusion proof: `{tx_hash, log_index, macroblock_index, window_start, window_end, block_index, leaf, proof, block_root, window_proof, logs_root}`; `macroblock_index` = `window_end / 90` names the checkpoint whose `logs_root` it folds to |

The macroblock proof endpoint has five distinct error returns: `macroblock_not_found`,
`no_checkpoint_qc`, `qc_decode_failed`, `banned_decode_failed`, and `qc_sigs_pruned` (with
`action: "repin_recent_anchor"`; only when neither the database nor the history archive holds the signatures).
The log-proof endpoint answers `{error:"window_not_finalized", window_end}` until this node both stores
macroblock `window_end / 90` and has applied the window, and a pruned window with
`{error:"window_pruned", oldest_available}`.

The legacy balance proofs can verify against a certified root only while no account changed since
that macroblock, and omit `is_contract`, `contract_code_hash` and `storage_root`, so a contract account
never verifies through them; their u64 values are JSON numbers. They are kept byte for byte for clients
that predate the certified form.

The `checkpoint.total_supply` field is a string.

### Certified state proofs

`?mb=` on the two balance-proof routes asks for the certified form (`rpc/certified_proofs.rs`): a proof of
the state after block 90j, whose root macroblock j's checkpoint carries and its committee signed. The proof
is built over one of the node's certified views (`storage/proof_views.rs`): RocksDB snapshots of the account
tree and of the proof rows taken behind block 90j, served only once the stored macroblock j certifies
exactly that root. A node holds at most three views, `{c, c−1, c−2}`, the window a client accepts. Macroblock
j is sealed once the checkpoint at 90j+30 is committed, so the newest view trails the applied tip by about
30 to 120 blocks; an index that is not certified is never served. Views do not survive a restart: a restarted
node answers `warming` until its first view, then 410 for the indices it lacks.

| Request | Answers at |
| --- | --- |
| `GET /api/v1/account/{address}/balance/proof?mb=latest` | the newest view this node holds |
| `GET /api/v1/account/{address}/balance/proof?mb={j}` | macroblock j |
| `GET /api/v1/token/{contract}/{holder}/balance/proof?mb=latest` or `?mb={j}` | the same, for a holder's QRC-20 balance |

`mb` appears exactly once: `latest`, or a decimal index from 1 with at most 20 digits. Other query keys
are ignored. An address, contract or holder is 1 to 64 printable ASCII characters. A node from before the
certified form ignores the query and answers its legacy body.

Account answer, HTTP 200:

| Field | Value |
| --- | --- |
| `proof_format` | `2` |
| `address` | the address asked for |
| `macroblock_index`, `state_height` | j and 90j: the proof is of the state after block 90j |
| `state_root` | the view's root as hex; a client folds to the root it verified for `macroblock_index`, never to this one |
| `exists`, `proof_kind` | `inclusion`; `absence` (the key's bucket is empty); `absence_in_bucket` (the bucket holds other keys) |
| `balance`, `nonce`, `heartbeat_epoch`, `heartbeat_final_epoch`, `last_claimed_epoch`, `banned_at_height` | decimal strings |
| `heartbeat_slots`, `heartbeat_final_slots` | numbers (16-bit masks) |
| `is_contract`, `is_node` | booleans |
| `contract_code_hash` | string or null |
| `storage_root` | hex; null exactly when `is_contract` is false |
| `merkle_proof` | `[{sibling, is_right}]`: for an inclusion, the in-bucket path then 40 tree steps; for an absence, exactly 40 |
| `bucket_entries` | `[{key, leaf}]`, ascending, 1 to 64 entries; only for `absence_in_bucket` |
| `servable` | the indices this node serves, newest first; only with `mb=latest` |

An absent account carries every field at zero, with a null code hash and storage root. There is no
`block_height`: the applied tip never shares a field with the certified height.

Token answer, HTTP 200: `proof_format`, `contract_address`, `holder`, `macroblock_index`, `state_height`,
`state_root`; `contract_status` (`absent`, `not_contract` or `contract`); level 1, the contract account, as
`account_proof_kind`, `account_proof` and `account_bucket_entries`, with its leaf fields `account_balance`,
`account_nonce`, `is_contract`, `is_node`, `contract_code_hash`, `storage_root` and the heartbeat, claim and
ban fields, typed as above; and for `contract` only, level 2 as `storage_proof_kind`, `token_balance` (the
raw stored decimal string, `"0"` for an absence), `storage_proof` and `storage_bucket_entries`. Level 2
proves the key `balance:{holder}` in the storage tree whose root the proven contract leaf commits to. A
contract that does not exist, or an account that is not a contract, is answered 200 with its level-1 proof
and no level 2: a proven negative is an answer. `servable` comes only with `latest`.

Shape of an account answer (values illustrative, hashes shortened):

```json
{"address":"<eon-address>","balance":"2909459674650000","banned_at_height":"0","contract_code_hash":null,"exists":true,"heartbeat_epoch":"0","heartbeat_final_epoch":"0","heartbeat_final_slots":0,"heartbeat_slots":0,"is_contract":false,"is_node":true,"last_claimed_epoch":"22720","macroblock_index":24581,"merkle_proof":[{"is_right":true,"sibling":"9c1f…"},…],"nonce":"2","proof_format":2,"proof_kind":"inclusion","servable":[24581,24580,24579],"state_height":2212290,"state_root":"5be0…","storage_root":null}
```

Every error carries `proof_format: 2` and `error`, with `Cache-Control: no-store`:

| Status | `error` | When | The body adds |
| --- | --- | --- | --- |
| 400 | `bad_parameter` | `mb` unparsable, repeated, over 20 digits, above the u64 range or 0; a bad address, contract or holder | `parameter`: `mb`, `address`, `contract` or `holder` |
| 404 | `macroblock_not_certified` | j is above the newest macroblock this node stores | `macroblock_index`, `newest_certified_index` |
| 410 | `view_not_retained` | j is certified here but its view is no longer held | `macroblock_index`, `servable` |
| 429 | `rate_limited` | the source is over its `certified_proof` bucket | `retry_after_seconds`, and `Retry-After` |
| 503 | `certified_state_unavailable` | `reason`: `warming` (no view yet), `disk_pressure`, `store_write_failed` or `aux_untrusted` (captures refused), `preimage_unavailable`, `storage_unavailable`, `read_error`, `inconsistent`, `bucket_oversize` | `reason`, `servable`, `retry_after_seconds`; `Retry-After` 30 for `warming`, 60 for `disk_pressure`, 5 otherwise |
| 503 | `busy` | the proof pool is full, the source already has two proofs queued or running, or the proof did not start within 1 s or finish within 3 s | `retry_after_seconds: 1`, and `Retry-After: 1` |

Deciding 404, 410 or `warming` reads no storage. Cache headers: an explicit index answers 200 with
`Cache-Control: public, max-age=300, immutable` (its body depends only on j and the keys, and carries no
`servable`); `latest` with `public, max-age=10`; `/api/v1/state/certified` with `public, max-age=5`.

`GET /api/v1/state/certified` answers
`{proof_format: 2, views: [{macroblock_index, state_height, state_root}], newest_certified_index, finalized_height, applied_height, capture}`
with the views newest first and three heights that never stand in for one another: `newest_certified_index`
is the highest macroblock index this node stores (never below a view it serves), `finalized_height` the
certified frontier (`LAST_FINALIZED_HEIGHT`, raised by each committed 30-block checkpoint) and
`applied_height` the applied tip. `capture` is `ok`, `warming` (captures allowed, no view yet),
`store_write_failed`, `aux_untrusted` or `disk_pressure`. Its bucket is `certified_state`, refused with the
same 429.

Each proof is built on one of `clamp(cores / 4, 2, 8)` dedicated threads (`qnet-proof-N`, a queue of four
jobs per thread) over the view's snapshots alone: no state lock, every read past the shared block cache,
O(log n) reads per proof and nothing that grows with a token's holder count. A source, an IPv4 address or
an IPv6 /64, may have two proofs queued or running at once. A 64 MiB cache keeps the explicit-index bodies
of hot keys. A missing proof row is never guessed: a plain account may be served from its one live
accounts row only when that row hashes to the view's leaf, a storage value from its one live slot under
the same check, and a contract never takes that path.

A client:

1. verifies macroblock `macroblock_index` through its own lineage and folds to the `state_root` of that
   verified checkpoint, never to the served `state_root`;
2. requires `state_height == 90 × macroblock_index`;
3. binds the address, contract and holder to what it asked for;
4. rebuilds the account leaf from every field, defaulting nothing;
5. checks the kind exactly: `inclusion` is the in-bucket path then 40 tree steps whose flags equal the
   key's bits; `absence` is the zero seed and exactly 40 steps; `absence_in_bucket` is exactly 40 steps
   seeded by the bucket fold of 1 to 64 entries, strictly ascending, all in the key's bucket, none equal to
   the key and none a zero leaf;
6. counts an answer fresh only when its index is at least the trust floor and at least `head − 2`, with
   `head` the larger of the highest index it verified and the second-highest `newest_certified_index` that
   at least three genesis or pinned nodes report from `/api/v1/state/certified`; never from
   `/api/v1/height`;
7. for a token, takes `storage_root` from the proven contract leaf, and accepts a `contract_status` only
   with its level-1 proof;
8. parses strictly and caps the answer at 64 KB (an answer is at most about 20 KB);
9. treats any answer without a verifiable proof as no answer (a legacy body, an error, a 429, a 5xx or a
   timeout): it asks another node and never shows it as a balance, a zero or an absence;
10. takes a body for legacy only when it is HTTP 200 with no `proof_format`, a boolean `proof_valid`, a
    numeric `block_height` and an array `merkle_proof` (for a token, `account_proof` and `storage_proof`),
    and marks that node old for at most 10 minutes, since nodes upgrade during a roll; nothing else marks a
    node old.

## REST: snapshots

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/snapshot/latest?max_height=` | `{height, ipfs_cid, available, node_id, timestamp}` or `{available:false}` |
| GET | `/api/v1/snapshot/{height}` | The whole compressed frame as `application/octet-stream` with a `Content-Disposition: attachment` header, streamed chunk by chunk |
| GET | `/api/v1/snapshot/{height}/manifest` | Stored chunk manifest for parallel download |
| GET | `/api/v1/snapshot/{height}/chunk/{index}` | One chunk as `application/octet-stream` |

Full-file and chunk serving both acquire `SNAPSHOT_SERVE_SEM`, a node-global semaphore with 16
permits. When it is exhausted the response is `{error: "snapshot serve busy"}`. A full-file transfer holds
its permit while the client keeps reading and ends when it stalls for 60 seconds; the manifest and each chunk
are one stored row.

## REST: accounts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/account/{address}` | Serialized account. The 1952-byte `dilithium_public_key` is replaced on the wire by a boolean `has_dilithium_pk`. An account the genesis block funded carries `genesis_allocation: true` (on the public testnet: a load-test account with a public key); the field appears once the node has read block 0, which it starts on the first such request. An unknown account yields a zeroed default object. `?fields=basic` answers exactly `{address, balance, nonce, has_dilithium_pk, is_contract, contract_type}` (`contract_type` `"qrc20"`, `"qrc721"`, `"wasm"` or `null`), without a contract's storage and code; any other `fields` value is HTTP 400 `{"success": false, "error": "fields_unsupported", ...}` |
| GET | `/api/v1/account/{address}/balance` | `{address, balance}` in nanoQNC; addresses longer than 64 characters are rejected |
| GET | `/api/v1/account/{address}/transactions` | First page of up to 50 transactions plus a total count |
| GET | `/api/v1/account/{address}/node-events` | `{address, count, events[{type: "node_activation", node_id, node_type, height, timestamp, burn_tx}]}` for the wallet's genesis, super and light node ids, read from the chain-confirmed node registry rows rather than the transaction index; `burn_tx` is the burn the registration committed (empty for a genesis node); `timestamp` is 0 once the registering block's body is pruned. One wallet has one node from the `wallet_one_node` gate; a wallet lists two only when it registered both types before that rule |
| GET | `/api/v1/account/{address}/token-transfers?limit=&before=` | `{address, count, transfers[], oldest_available}`, each transfer enriched with symbol, decimals, logo and a `{height:016x}_{log_index:08x}` cursor |
| GET | `/api/v1/account/{address}/tokens` | QRC-20 holdings. Uses the reverse owns-index when `OWNS_INDEX_READY` is set (`source: "reverse_index"`), otherwise a full account scan (`source: "blockchain_state"`) |
| GET | `/api/v1/richlist?limit=` | `{success, total_supply_raw, circulating_raw, burned_raw, holder_count, holder_count_all, genesis_allocations, holders[{address, balance_raw, percent}], source}`; `circulating = total_supply − burn-sink balance`. Accounts funded by the genesis block are left out of `holders` and `holder_count` and reported as `genesis_allocations: {accounts, holding, balance_raw}` (`holding` = those still holding a balance); `holder_count_all` is the raw count. Their balances were never minted into `total_supply`. `genesis_allocations` is null on a node without block 0, which then serves the unfiltered list. The filtered view is recomputed at most every 30 s. Limit defaults to 100, clamped `1..=500`. |

Feed limits: token-transfer feeds default to 50 and are clamped `1..=200`; the `before` cursor must
be at most 40 characters of hex or underscore.

An account row the node could not read from its storage answers HTTP 503
`{"success": false, "error": "account_unreadable", "message": "...; ask again or ask another node", "address": ...}`
on both routes, never the default object, and JSON-RPC `account_getInfo` and `account_getBalance` answer error
`-32000` with a message starting `account_unreadable:`. Ask another node then.

`nonce` is the last nonce the chain applied for the account; its next transaction carries `nonce + 1`.
Balances are nano-QNC as JSON numbers, which pass 2^53: read them from the raw text. Recorded from
`https://node4.aiqnet.io/api/v1/account/4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d` on 2026-09-25
(`storage_root` shortened):

```json
{"address":"4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d","balance":2909459674650000,"banned_at_height":0,"contract_code_hash":null,"contract_storage":{},"created_at":0,"has_dilithium_pk":true,"heartbeat_epoch":0,"heartbeat_final_epoch":0,"heartbeat_final_slots":0,"heartbeat_slots":0,"is_contract":false,"is_node":true,"last_claimed_epoch":22720,"node_type":"Super","nonce":2,"reputation":0.0,"storage_root":[87,160,80,…],"updated_at":1788150188}
```

## REST: transactions and mempool

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/transaction` | Submit a signed transfer |
| POST | `/api/v1/batch/transfer` | Up to 1000 transfers from one sender as one signed transaction: `{transfers[{from, to_address, amount, memo}], batch_id, nonce, gas_price, gas_limit, dilithium_signature, dilithium_public_key}` → `{success, batch_id, transaction_hash, signed_id, transfer_count, total_amount, from_address, message, processed_by}`. Every `from` is the same address, each `amount` is above 0, each `memo` at most 128 bytes, and `gas_limit` at least 10 000 (`gas_limits::TRANSFER`) per transfer; the signature covers the batch message under [Batch transfers](#batch-transfers), and `dilithium_public_key` may be elided as for a transfer |
| GET | `/api/v1/transaction/{hash}` | `{tx_hash, transaction{...}, status}`; `status` is `found`, `not_found` or `error`, and a found transaction's own `status` is `pending` (in this node's pool) or `confirmed` (in a stored block). There is no failed state: see [Transactions](transactions.md#status-and-outcome) |
| GET | `/api/v1/transaction/by-nonce/{from}/{nonce}` | The value transaction (transfer, batch, deploy or call) `from` signed at `nonce`: `{success: true, status, from, nonce, hash, signed_id}` with `status` `pending` (in this node's pool) or `confirmed` (in the sender's history this node keeps, about 28 hours, at most its last 500 index rows; two of one sender in one block are both found), or `{success: false, status: "not_found", from, nonce}`; older ones are in the explorer. `hash` is the hash of the copy this node holds. `read_only` bucket |
| GET | `/api/v1/transactions/recent?page=&per_page=` | `{success, transactions[{hash, from, to, amount, nonce, timestamp, type, gas_price, gas_limit, is_quantum_signed}], pagination{page, per_page, total_count, total_pages, has_next, has_prev}, current_height}`: the newest transactions, newest first (the higher block first, and within a block its last transaction first), from the last 3600 blocks up to and including `current_height` (about an hour), 1000 transactions at most. `total_count` counts that feed, not the chain's history, and a page past it is empty; older transactions are in the address history and the explorer. `type` is the transaction type with its fields as the node prints them. `read_only` bucket |
| GET | `/api/v1/transactions/history?address=&page=&per_page=&tx_type=&direction=` | Filtered, paginated address history |
| GET | `/api/v1/mempool/status` | `{size, max_size, status, node_id, timestamp}` |
| GET | `/api/v1/mempool/transactions?limit=&offset=` | `{transactions, count, total_count, offset, limit, node_id}` |
| GET | `/api/v1/gas/recommendations` | Four tiers (`eco`, `standard`, `fast`, `priority`), each with `gas_price`, `estimated_time` and `cost_qnc` (a transfer at that price, the ML-DSA premium of 1.5 × the gas price included), plus `network_load`, `mempool_size`, `current_height`, `base_fee`, `node_id`. `base_fee` scales off `qnet_state::transaction::MIN_GAS_PRICE` by mempool depth. |

`per_page` on both history endpoints is clamped `1..=100`. Mempool paging defaults to a limit of 100
and is capped at 1000. A client reads the committed nonce from the account and finds what it signed at a nonce
with `/api/v1/transaction/by-nonce/{from}/{nonce}`.

Recorded from `https://node3.aiqnet.io/api/v1/gas/recommendations` on 2026-09-25:

```json
{"base_fee":10,"current_height":2210984,"mempool_size":0,"network_load":"very_low","node_id":"genesis_node_003","recommendations":{"eco":{"cost_qnc":0.00015,"estimated_time":"15s","gas_price":10},"fast":{"cost_qnc":0.0003,"estimated_time":"5s","gas_price":20},"priority":{"cost_qnc":0.00045,"estimated_time":"3s","gas_price":30},"standard":{"cost_qnc":0.00022,"estimated_time":"10s","gas_price":15}}}
```

`/api/v1/token-transfers?from=&to=&limit=&after=` (explorer ingestion) accepts
a range of at most 10 000 blocks with a limit defaulting to 2000, clamped `1..=5000`.

### Submitting a transfer

`POST /api/v1/transaction` validates both EON addresses before anything else, then requires the
ML-DSA-65 `dilithium_signature`. `dilithium_public_key` is optional under pk-elision: send it on
first use — the handler then binds `from` to it and verifies the signature inline — and omit it once
the key is committed on-chain, in which case `submit_transaction` rehydrates it from committed state
and rejects with `pk_unresolved` if it cannot. The signed text, the gas rules and the nonce rule are
in [Transactions](transactions.md). The body of the transfer vector
(`applications/qnet-mobile/src/crypto/__vectors__/tx-vectors.json`, signature and key shortened):

```bash
curl -s -X POST https://node1.aiqnet.io/api/v1/transaction \
  -H 'Content-Type: application/json' \
  -d '{"from":"d9fa370374e24333242eon847d1d354dcd87fe873823e","to":"4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d","amount":1500000000,"dilithium_signature":"25aba85c…","gas_price":10,"gas_limit":10000,"nonce":1,"dilithium_public_key":"ee96d7a5…"}'
```

Success and failure both return HTTP 200:

```json
{ "success": true, "tx_hash": "...", "signed_id": "...", "message": "Transaction submitted successfully" }
```

```json
{ "success": false, "error": "Failed to add transaction to mempool", "details": "<real reason>" }
```

The `details` field carries the actual rejection reason on purpose: wallet self-heal paths key on it,
so a `pk_unresolved` rejection makes an eliding wallet re-attach its public key and a nonce rejection
makes it refetch.

A value transaction's `timestamp` is part of its hash but not of its signature, so a relay can re-stamp a
pending transfer, batch, deploy or call into a copy with another hash and the same signature. A node keeps
one pending version per (`from`, `nonce`):

- A submit whose signed fields (`from`, `nonce`, type and payload, `to`, `amount`, gas) all equal a version
  already pending here answers success with that version's hash: `tx_hash` (`transaction_hash` on the batch
  route, `hash` over JSON-RPC) names the copy pending at this node, which another node may hold under another hash.
- Another version at a pending (`from`, `nonce`) with a `gas_price` not above the pooled one is refused before
  its signature is checked: `[REJECT][TX] nonce_already_pending from=... nonce=N pending=<hash16> (a replacement
  must pay a higher gas_price)`. A version with a higher `gas_price` replaces the pooled one.
- `signed_id` (transfer and batch routes, and `/api/v1/transaction/by-nonce/{from}/{nonce}`) is the hex SHA3-256
  of the signed text followed by the raw ML-DSA-65 signature: the same for every copy of one signed transaction.

A wallet tracks `signed_id` or (`from`, `nonce`) rather than the returned hash: a send whose hash is missing has
landed once the account's nonce reaches the transaction's nonce, and is not sent again while that nonce is used.

A transfer whose recipient account is a contract is refused before the signature is checked, since a
contract can never send QNC or a built-in token on:

```json
{ "success": false, "error": "Recipient is a contract account", "code": "recipient_is_contract", "details": "<to> is a contract account: ...", "recipient": "<to>" }
```

`"code": "recipient_unreadable"` (`"error": "Recipient account could not be read"`) means this node could
not read the recipient's account: ask again or ask another node. `POST /api/v1/batch/transfer` refuses the
same way for any of its recipients and adds `transfer`, the 1-based index of the first one refused;
`POST /api/v1/contract/call` does for the recipient of a QRC-20 `transfer` or `transferFrom` and adds
`contract_address` and `method`; the JSON-RPC methods `tx_submit`, `tx_sendTransaction` and `mempool_submit` answer error `-32602` with a message starting
`recipient_is_contract:` or `recipient_unreadable:`. A new (missing) account and the burn address pass. The
check is made at these routes, not in the block rules: a block that carries such a transfer applies it.

Three refusals are about the answering node rather than the transaction, and the same body may be sent to
another node: `recipient_unreadable`; `"error": "Server busy: too many concurrent signature verifications"`
(or `verify_overloaded` in `details`); and a `gas_price` below the floor this node's own pool backlog sets.
A node whose state is behind answers `Invalid nonce: expected N, got M` with N below the nonce sent, or
`pk_unresolved` for a key the chain already holds.

`GET /api/v1/transaction/{hash}` returns `is_quantum_signed`, `signature_type`
(`"Dilithium3 (ML-DSA-65)"` when signed), an optional `quantum_security` block and optional
`finality_indicators` alongside the usual transaction fields. `tx_type` is the node's own text form of
the type (for example `"RewardDistribution"`, or `"Transfer { from: …, to: …, amount: … }"`), not
structured JSON, and the answer carries no calldata. The node looks through the first 1,000
transactions of its pool and the last 100,000 blocks of its index; the site's archive
(`https://aiqnet.io/api/tx/{hash}`) holds older ones.

### Batch transfers

`POST /api/v1/batch/transfer` is signed over

```
q1337|batch_transfer:{from}:{total}:{count}:{batch_id}:{digest}:{nonce}:{gas_price}:{gas_limit}
```

where `total` is the sum of the amounts, `count` the number of transfers, and `digest` the hex
SHA3-256 over each transfer in order: the `to_address` bytes, the amount as 8 little-endian bytes, a
`0x00` byte, the memo bytes when present, and a `0xff` byte (`build_canonical_verify_message` in
`development/qnet-integration/src/node/transactions.rs`).

## REST: MEV bundles

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/bundle/submit` | `{transactions[], min_timestamp, max_timestamp, reverting_tx_hashes[], signature, submitter_pubkey}` → `{success, bundle_id}`. Requires a node with an MEV mempool. |
| GET | `/api/v1/bundle/{bundle_id}/status` | `{success, bundle_id, status, transaction_count, total_gas_price, min_timestamp, max_timestamp}`; status is `pending`, `active` or `expired` |
| DELETE | `/api/v1/bundle/{bundle_id}` | Cancel. When a submitter IP was recorded, the caller IP must match it or pass `is_internal_ip()`. |

## REST: network and peers

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/peers` | `{peers[], total, statistics{super_nodes, full_nodes, light_nodes}}`. Appends up to 2 genesis bootstrap peers when the node has fewer than 3 peers. |
| GET | `/api/v1/nodes/discovery` | `{current_node, available_nodes[], total_nodes, network_status}`. Peer addresses and the local `api_endpoint` are masked for callers that fail `is_internal_ip()`, leaving node_id, node_type, region and reputation. |
| GET | `/api/v1/node/health` | status, node_id, height, network_height, sync_status, peers, validated_peers, mempool_size, node_type, region, uptime_seconds, version, api_version, `clock_drift_ema_secs`, `clock_drift_peak_secs`, `current_timeout_round`, `max_slot_delay_secs`, `max_timeout_round_seen`, `failover_count`, `timestamp_rejections` |
| GET | `/api/v1/sync/status` | local_height, network_height, is_syncing, is_ahead, blocks_behind, blocks_ahead, `sync_progress` (percentage string capped at 100%), estimated_sync_time |
| GET | `/api/v1/diagnostics/network` | node_health, network_status, total_peers, active_connections, current_height, node_type, consensus_participation, uptime_seconds, last_block_time, and a transport block with QUIC statistics |
| POST | `/api/v1/p2p/message` | Deserializes the body into `unified_p2p::NetworkMessage` and forwards it to `p2p.handle_message` with a pseudonymized peer id. Internal IPs only. |
| POST | `/api/v1/auth/challenge` | Requires `protocol_version: "qnet-v1.0"` and a timestamp within 300 s; returns `{signature, public_key, node_id, timestamp}` signed over `auth_challenge:{hex}:{timestamp}` with the node's ML-DSA-65 key |
| POST | `/api/v1/ping` | Requires a 64-hex-character challenge; returns `{success, node_id, node_type, signature, challenge, response_time_ms, height, timestamp, quantum_secure}` |

## REST: node and light-node lifecycle

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/node/status` | Accepts `node_id`, `wallet` or `activation_code`; the wallet may also arrive in `X-QNet-Wallet`. The first given of `node_id`, `wallet` and `activation_code` is used; a wallet resolves to the first of its genesis, super and light node ids that has a registry row. A light node in this node's light registry reports `heartbeat_count` 1 once it holds an on-chain attestation from either of the two previous epochs (`required_heartbeats` 1), and `is_online` is also true when an owner genesis of its light shard reports it active on `/api/v1/light-node/status`. For a light node `last_seen` is the start of the epoch of its last answer (the status's `device.last_answer_epoch`: that epoch's first block's time), never the answer's own second, which only the signed status gives (0 when unknown), and `last_seen_ago_seconds` is counted from it (`null` when it is unknown). |
| POST | `/api/v1/light-node/bind` | Links a registered light node to one device, or takes a pending binding for a node whose registration has not applied yet: the wallet key's delegation and attach with a sequence that must beat the stored one, the push channel, an optional unsigned `platform` (`android` or `ios`) and `model` (a short marketing name of the device, 1 to 40 ASCII letters, digits, spaces and `. , + ( ) / -`, never an identifier), both kept with the binding, shown by the public status and never a reason to refuse, the consent for a pending binding, and,
 once the node serves `device_v1`, the device's enrolment (`device`). Answers `{success, bound, node_id, seq, device_fp}` for exactly the sequence sent (`bound: false, pending: true` for a pending binding), with `device_state` and `effective_epoch` for a device block; refusals carry a stable `reason` ([light node messages](../protocols/light-node-messages.md) sections 4, 5.3 and 8) |
| POST | `/api/v1/light-node/unbind` | The end of the binding stored now, at its sequence: the bound device's ping key's `light_unbind` (`"signer": "ping"`), sent by the app on the node cabinet's `unlink` request that the user confirms on that device (QNet Link section 14), with the device key's release when the node holds it; or, from any device that holds the wallet, the wallet key's `light_unbind_wallet` (`"signer": "wallet"` with `identity_pubkey`, never a release), once two genesis nodes list `unbind_wallet`. Answers `{success: true, unbound: true, node_id, binding_seq, device_released}`; refusals carry a stable `reason` (light node messages sections 4, 5.7 and 8) |
| POST | `/api/v1/light-node/wake` | "I'm back" from the node cabinet: `{node_id}`, a silent push to the linked device (or a challenge for a polling device's next poll), outside the dormant rule (light node messages section 5.10 and the wake of QNet Link section 14.1). Every answer is `{success, reason, node_id}` with `reason` one of `sent` (the only one with `success: true`), `already_answered`, `no_device`, `not_registered`, `cooldown`, and `retry_after_seconds` only with `cooldown` (the address limit, the node's three wakes an epoch 600 s apart, the commit window and the 60 s before it, a refused push, or no owner reachable). A genesis that does not own the node's light shard checks only `not_registered` and hands the wake to the owners in rank order (at most 2 s each, TLS only), answering with the first owner's answer; a shard owner behind the network answers `cooldown` with HTTP 503 so the caller asks the next owner; every other answer is HTTP 200 |
| GET | `/api/v1/light-node/device-challenge?node_id=&purpose=` | A one-time challenge for a device enrolment, rotation, release or rebind, from the node's shard owners (light node messages section 5.2) |
| POST | `/api/v1/light-node/device-refresh` | The device key's lease refresh inside the window the signed status names (light node messages section 5.6) |
| POST | `/api/v1/light-node/device-rotate` | The device key's rotation, signed by the old key over the new key's attestation (light node messages section 5.4) |
| POST | `/api/v1/light-node/register` | The route of app builds before the v2 binding. For a node with a v2 binding it answers `bind_v2_required` to a caller that presents the node's committed key and its signature, and the inert `already_registered` to anyone else (light node messages section 8); current clients register through `POST /api/v1/node-registration/submit` and link a device through `/light-node/bind`. For a node without a v2 binding it keeps the older rules: per-wallet failed-attempt limiting (max 5 failures per 600 s, independent of IP), EON validation, and a `quantum_pubkey` that resolves to the node's identity key (below) reactivating a node already on chain. From the `wallet_one_node` gate a fresh registration for a wallet that already has another node on chain answers `{success: false, code: "wallet_has_node", error, node_id}` with the submit route's text |
| POST | `/api/v1/light-node/token-refresh` | A new push token for the bound device: the ping key's `token_refresh` for the binding's sequence (light node messages section 4). The earlier form, a `ping_dilithium:` signature over `token_refresh:{node_id}:{timestamp}` with the delegation `delegate_ping:{ping_pubkey}:{node_id}`, is refused for a node with a v2 binding (`bind_v2_required`) |
| GET, POST | `/api/v1/light-node/ping-response` | Registered twice — GET with query parameters, POST with a JSON map body under a 64 KiB cap — both routed to the same handler. Past the node-wide budget (twice the most pushes a genesis sends a second, 512 at once), after the `light_node_ping` limit and before any storage read or signature check, it answers HTTP 503 with `Retry-After` and `{success: false, reason: "overloaded", error, retry_after_seconds}`, the wait drawn from 60 to 300 s and never past the epoch's commit less 60 s (light node messages section 5.10). A signed response carries enveloped ML-DSA-65 signatures, so POST is the form that fits. A node that holds the device's key takes `ping_hw2:` replies (light node messages section 5.8). The reply may add `sent_at` (copied from the push), `received_at` and `answered_at` (the device's clock), decimal Unix seconds as strings — an earlier release takes a body of strings only, this one takes numbers too — from which the shard owner measures the push's delivery delay and the app's handling, never a reason to refuse (section 5.10). It may also add `push_receipts`, JSON text in a string field (at most 2,048 bytes, 8 entries): `{since, pushes: [{epoch, sent_at, received_at, outcome}]}`, the pushes the app received from epoch `since` on and did not answer, which a shard owner reads only from an answer that verified and counted, to refine the node's `last_miss` (`delivered_at`, `app_outcome`, or `not_delivered` when the app received no push of that epoch) and never its crediting; a report over the bound or malformed is ignored whole. Every answer belongs to its own epoch: a reply between the shard's commit and the epoch's end is credited nowhere, recorded as that epoch's late answer, and answered `{success: false, node_id, counted: false, reason: "epoch_closed", error}`, which names no other epoch; nothing is moved to the next one. A reply whose anchor is not a canonical block of the current epoch is refused with `reason: "anchor_not_current"`. A reply refused by the reply checks answers `{success: false, reason, error}` with `reason` the refusal code; `ping_signature` means this genesis holds no ping key of the node, or another one, and the reply is sent again with `ping_pubkey`, `ping_delegation_cert` and `identity_pubkey`, which a genesis already holding that key and delegation skips (one ML-DSA-65 check of `σ` instead of three) |
| GET | `/api/v1/light-node/status?node_id=&nonce=` | The public status of light node messages section 7 (`onchain_registered`, `registration_pending`, `device_bound`, `answered_this_epoch`, `needs_reactivation`, `counted`, `burn_tx`, `features` and `authoritative`; never `device_tag_h`, which only the signed status answers), beside `success`, `node_id`, `is_active`, `has_attestation_current_slot`, `next_ping_time` and `next_ping_window`, and `device`: `null` while the node is not on chain, else `{platform, model, linked_since, last_answer_epoch, state, last_miss}` with `state` `online`, `offline`, `unlinked` or `other_device_pending`, `model` the model the binding named (`null` when it named none), `linked_since` the UTC day of the binding, `last_answer_epoch` the epoch of the node's last answer, and `last_miss` `{epoch, reason, delivered}` (`delivered` true, false or `null`), `reason` one of `woken_no_answer`, `answered_late`, `not_delivered`, `not_woken_inactive`, `no_push_address`, `answer_refused`, `not_sent` (every push due failed or never went out) and `not_committed` (the node's shard committed no row in that epoch), the last two the system's misses, never toward the dormant rule: the latest epoch the node was not counted in as this genesis saw it, `null` while no device is bound. Anyone can read it for any wallet's node, so it carries no time of an answer, a wake or a delivery and nothing of what the app did: `last_answer_at`, the whole `last_miss` (`woken_at`, `answered_at`, `delivery_delay_secs`, `refused`, `delivered_at`, `app_outcome`) and `last_answer` (`{at, delivery_delay_secs, handling_secs}`) are the signed status's (light node messages sections 5.10 and 7). A reader takes, among the owners of the node's light shard, the `last_miss` of the highest epoch, at equal epochs the most specific (`not_committed`, `answered_late`, `not_delivered`, `answer_refused`, `woken_no_answer`, `no_push_address`, `not_sent`, `not_woken_inactive`), at an equal reason the one with `delivered_at` (in the public form the one with `delivered`), and ignores a reason it does not know. `onchain_registered` is true once the registration row is applied. `counted` and `needs_reactivation` leave out every epoch in which the node's shard committed no row. Before reporting a node inactive, a node asks every other owner genesis of its light shard at once and reports it answered when an owner that sees it on chain took its answer, active when any owner reports it active (cached 60 s). `read_only` bucket |
| POST | `/api/v1/light-node/status` | The signed status of light node messages section 7: the ping key's or the wallet key's `light_status` within ±300 s, answered with the public fields, the binding's sequence and device state, the whole `device` (`last_answer_at`, `last_miss` with its times, refusal code and `app_outcome`, and `last_answer`), `push_reregister` (true while a device is bound and this genesis cannot push it: the app registers its push token again), and `device_tag_h` for a `nonce` while a device is bound |
| GET | `/api/v1/light-node/next-ping?node_id=` | `{success, node_id, next_ping_time, next_ping_window, current_slot, current_window, slots_per_window: 240, window_duration_seconds: 14400}` |
| GET | `/api/v1/light-node/pending-challenge?node_id=&ts=&sig=` | Serves devices this genesis does not push, under the `read_only` bucket; a pushed device, or one whose device record does not count, gets the answer of a polling device whose slot is not due (`{success: true, has_challenge: false, message, next_ping_time}`). `ts` and `sig` (optional) are the ping key's signed poll (light node messages section 4) within ±300 s; only such a poll counts as the device's fetch of the challenge the pinger left it (section 5.10); `{success, node_id, has_challenge, challenge, created_at, expires_at}`; `expires_at` is how long the challenge stays answerable — until the shard's commit window opens, and never less than 180 s — while the pending row itself is dropped after 180 s, since the stamp verifies without it. A node that already answered in the current slot is served `{has_challenge: false, already_attested: true}` instead of a new challenge. Between the shard's commit and the epoch's end no challenge is served (`{has_challenge: false, next_ping_time}`, the node's own next slot): an answer then counts in no epoch. Nor while the answering genesis is behind the network (its epoch not the corroborated head's, or more than 60 blocks below it): its anchor is stale, and the device polls another genesis |
| GET | `/api/v1/node-device?node_id=` | `{success, node_id, device_id}`, `device_id` null when unset |
| POST | `/api/v1/register-device` | Requires the node to already be registered as type `super`; node ids starting with `genesis_node_` are rejected. Strict `activation` bucket (5/hour). |
| POST | `/api/v1/internal/fcm-token-sync` | `{pseudonym, token, push_type, endpoint, origin_ip, ts, seq, proof, writer, platform, model}` from the five genesis addresses only (64 KiB cap); `platform` and `model` are the bind's unsigned display hints (absent when it named none), stored only when valid and never a reason to refuse. For a node with a v2 binding the record must carry `proof` (`{identity_pubkey, ping_pubkey, delegation_cert, kind, sig, sig_ts}`: the wallet key's attach or the ping key's token refresh over this exact push target, at the binding sequence `seq`) and is re-verified from it, never taken on the sender's word; without it the answer is 400 `proof_required`. `ts` is the time the serving genesis stamped a record without a proof (arrival time when absent); a v2 record is ordered by `(seq, sig_ts)`. A record older than the stored one is ignored with `{success: true, applied: false, reason: "stale"}` (`"stale_seq"` for an older binding). 403 for any other caller, loopback included; 400 on missing fields or a proof that does not verify (`reason`); 500 on save failure |
| GET | `/api/v1/internal/fcm-token-get?node_id=` | The five genesis addresses only: the node's push-channel record `{success, token, push_type, endpoint, ts, seq, writer}`, or `{success: false, error: "not_found"}`; 403 for any other caller, loopback included; 400 without `node_id`. A shard owner that pulls it applies it only for the binding it already holds (a v2 record at exactly the stored sequence) |
| GET | `/api/v1/internal/light-ping-keys-get?node_id=` | The five genesis addresses only: `{success, ping_pubkey, ping_delegation_cert, identity_pubkey, seq, floor, v2, bound_at}`, the node's ping delegation and the identity key it was proven under (for a binding withdrawn by an unbind, empty keys and the signed `unbind` `{ts, sig, ping_pubkey, cert}` instead), or `{success: false, error: "not_found"}`; 403 for any other caller, loopback included. A shard owner that cannot verify a relayed attestation pulls this once per node and epoch and records it only when the identity resolves against the chain, the delegation verifies under it, and the relayed challenge signature verifies under the ping key |
| GET | `/api/v1/internal/light-reach-get?epoch=&shard=` | The five genesis addresses only: this genesis's reach record of a light shard's epoch, the nodes it reached (a push the provider took, a challenge fetched, the token gone) or held by the dormant rule that gave it no answer, as `{success: true, epoch, shard, signer, reach}` with `reach` a zstd-compressed bitmap over roster indices in base64, or `null` when it holds none of an epoch it decided; `{success: false, reason: "not_decided"}` before its misses of that epoch were recorded; 403 for any other caller, loopback included; 400 without `epoch` and a `shard` below 5. The other owners of the shard pull it once per epoch for the dormant rule (light node messages section 5.10) |
| POST | `/api/v1/internal/light-unbind-sync` | Another genesis's unbind (32 KiB cap): `{node_id, seq, ts, signer, sig, identity_pubkey, ping_pubkey, delegation_cert, origin_ip}`, the ping key's `light_unbind` with the wallet key's delegation, or (`signer` `wallet`, no ping key or delegation) the wallet key's `light_unbind_wallet`. Re-verified here from the signer's own signature and applied under the copy rule: `{success: true, applied, binding_seq}`, or `{success: true, applied: false, reason: "stale_seq"}` when a newer binding is held. 403 `{success: false, error: "Unauthorized"}` for any caller but the five genesis addresses, loopback included; 400 with the refusal's `reason` for an unbind that does not verify |
| POST | `/api/v1/internal/light-device-attest` | The attestor round of a device enrolment, rotation or rebind (96 KiB cap; light node messages section 5): the ingress genesis's request `{ingress, requested_at, statement, wallet, identity_pubkey, ping_pubkey, delegation_sig, seq, device, hw_pub, lease?, pi_jws?, key_node?, rotate?}`, public evidence only, never a vendor token. Answers `{success: true, genesis_id, sig}`, this genesis's signature over the statement, or `{success: false, reason}` (`rate_limited` above 600 requests a minute from one ingress, `not_attestor` on a node that runs no attestor, or the device refusal). 403 `{success: false, reason: "unauthorized"}` unless the caller is one of the five genesis addresses and the genesis `ingress` names, loopback included |
| POST | `/api/v1/internal/light-device-sync` | A final device statement (`bundle`) or a signed state change (`change`) from another genesis (96 KiB cap), every signature re-verified here: `{success: true, applied}` with `applied` one of `recorded`, `same`, `older`, `changed`, `unknown_statement` (this genesis then pulls the record from the sender), `not_newer` or `nothing`; 400 `{success: false, reason}` for one that does not verify; 403 `{success: false, reason: "unauthorized"}` for any caller but the five genesis addresses, loopback included |
| GET | `/api/v1/internal/light-device-get?node_id=` | The five genesis addresses only: a node's device record as another genesis re-verifies it, `{success: true, change, stmt_hash, ingress, bundle}` (the signed last change, the statement hash, the genesis that took the statement and, at that genesis, the statement's full proof), or `{success: false, reason: "not_found"}`; 403 `{success: false, reason: "unauthorized"}` for any other caller, loopback included |

The ping-response handler accepts two challenge forms: a server-issued stamp verified by
`verify_challenge_stamp`, or `selfattest:{height}:{block_hash}` checked against the canonical
microblock hash within the same 14 400-block epoch. A stamp carries its own expiry: the moment the
shard's owners start building the epoch bitmap, or 180 s, whichever is later. The reward unit is the
epoch, so an answer minutes late proves the same presence as an immediate one — a phone leaving doze,
a push the system held back or a node restarting under a roll no longer costs the device its epoch. See
[node activation](../economics/node-activation.md).

A push carries data only — the action, the block to answer with and `sent_at`, the sending genesis's time, never the
node — collapsed under one key, and lives exactly until the commit of the epoch it is for: no push goes out after it,
nor with less than a minute left. A node's first push falls in the epoch's first 138 slots, with two repeats 15 and 30
slots later and one retry round of the same shape an hour after the first, each only while the node is not counted, so
a node that answers the first push gets no other; the last of them leaves at least five minutes before the commit, so
every push and its answer belong to its own epoch (light node messages section 5.10). On Android it is sent at high priority (`"priority": "high"`, and `Urgency: high` on a delivery to a push
endpoint), which a sleeping device delivers at once; a normal-priority data message is held while the device sleeps. On iOS it is a background push
(`apns-push-type: background`, `apns-priority: 5`, `content-available` only), the form a data-only update takes, which the
system discards for an app the user swiped away.

A ping response signed `ping_dilithium:` may also carry `ping_pubkey`, `ping_delegation_cert` and
`identity_pubkey`; the node records that delegation only when the certificate verifies under the node's
identity key and the ping signature verifies under the presented ping key. The identity key is resolved
from the chain: the on-chain VRF key when the registry holds one; otherwise a presented key, or the one
the device last proved, accepted only when its SHA3-256 equals the registration's key commitment
(`vrf_pk_sha3`) or, for a registration that carries no commitment, when it derives the registered wallet
address. Token refresh, re-registration and relayed attestations resolve it the same way.

## REST: activation and registration

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/node-registration/submit` | Accepts `node_type: "light"`; super-node registration is server-initiated. A registration that embeds a burn is refused, retryably, with `{success: false, error, height, head}` while this node's applied height trails the corroborated network head by more than `DEFICIT_BOUND` (45) blocks. The owner bind is the v1 form or, from the `wallet_one_node` gate at this node's next height, the form without a time. From that gate a wallet that already has another node on chain is refused, after the `already_registered` check and before any attestation round, with `{success: false, code: "wallet_has_node", error: "This wallet already has a node on the QNet network: one wallet, one node", node_id}` (the other node; not retryable). A light owner bind in the form without a time that verifies before that gate, on a submit that passes every other check, is refused `{success: false, code: "bind_v2_pending"}` (retryable; the node lists the `owner_bind_v2` feature in `/api/v1/light-node/status` once it takes that form). The node asks its own attestor in-process first and the other committee members only once that burn has verified here; an attestation counts only from the member asked, once, with a signature that verifies under that member's committed key over the message the registration carries. The gathered registration is then judged as the producer and every node judge it, at this node's next height, and pooled only if it passes; otherwise `quorum_pending` (retryable). Only requests with no `Origin` header, or from `https://aiqnet.io`, `https://www.aiqnet.io` or any `chrome-extension://` or `moz-extension://` origin, are served; any other `Origin` gets HTTP 403 `{success: false, error: "Origin not allowed"}` before any check (the CORS answer is unchanged). Refusal codes: [light node messages](../protocols/light-node-messages.md#8-states-and-refusals) |
| POST | `/api/v1/node-reactivation/submit` | Reactivation. Takes `node_id`, `current_height`, `last_macroblock_hash`, `last_macroblock_index` and an optional `api_endpoint` that republishes the node's committed address; omitting it announces the node's own configured endpoint. Accepted for the node itself or from an internal caller address, and the endpoint is validated (`http(s)`, no loopback, RFC 1918 or link-local host) before it is signed. |
| POST | `/api/v1/nodes` | Super-node registration. A light node is registered through `POST /api/v1/node-registration/submit` (by the node cabinet or the browser extension, below) and linked to its device through `/api/v1/light-node/bind`. |
| GET | `/api/v1/verify-activation` | Resolves a wallet to the first of its genesis, super and light node ids whose registry row is chain-confirmed (`source: "storage_index"`; a row the node cached from RPC or discovery, with no registration height, never answers), then genesis wallet constants (`source: "genesis_constants"`). A wallet registered with both types before the one-node rule (`wallet_one_node`) answers its super node here; node-events lists both; `{verified, source, node_id, node_type, wallet_address}` or `{verified: false, authoritative, wallet_address, current_height, network_height, message}`; `authoritative` is false while this node is below the network height it has cached, so its negative answer does not settle the wallet |
| GET | `/api/v1/activations/by-wallet` | With `node_type` omitted, the wallet's node (the first of its genesis, super and light node ids that has a registry row) and, for a genesis wallet, its genesis node; accepts `X-QNet-Wallet` |
| GET | `/api/v1/activation/price?type=` | Phase 1: `{phase:1, cost, currency:"1DEV", base_cost:1500, min_cost:300, burn_percentage, savings, savings_percent, mechanism:"burn", universal_price:true}`. Phase 2 returns QNC pricing with a network-size multiplier. |

## REST: rewards

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/rewards/claim` | Claim accrued rewards |
| GET | `/api/v1/rewards/pending/{node_id}` | node_type, phase, `pending_rewards` (QNC), `pending_rewards_nano`, `first_unclaimed_epoch`, pools breakdown, epoch range, `last_claim`, `heartbeats{current, required, remaining}`, `is_active`, `is_eligible`, `is_claimable` |
| POST | `/api/v1/rewards/pending/batch` | `{node_ids: [...]}`, at most 100 → `{success, current_epoch, total_pending_qnc, count, nodes[]}` |
| GET | `/api/v1/rewards/history/{node_id}?offset=&limit=` | Per-epoch records, newest first. `block_range` is the work window the epoch paid for; `status` is `unavailable`, `not_eligible` (no reward that epoch), `claimed` or `claimable`. limit defaults to 10, capped at 100 |
| GET | `/api/v1/rewards/pools/{node_id}` | `current_phase`, `phase_description`, pending-rewards pool breakdown, `epoch_accumulated` |
| GET | `/api/v1/rewards/by-wallet/{wallet_address}` | `{wallet_address, total_nodes, total_pending_qnc, current_epoch, nodes[]}` for the wallet's node, resolved to the first of its genesis, super and light node ids that has a registry row |
| GET | `/api/v1/rewards/network/stats` | `current_epoch`, `current_height`, `blocks_until_next_epoch`, `epoch_accumulated`, `network_totals`, `emission_rate`. Served from a 30-second cache. |
| GET | `/api/v1/rewards/summary/{node_id}` | `lifetime_totals`, `epochs{total_epochs, epochs_claimed, epochs_missed, claim_rate_percent}`, `first_claim`, `last_claim`, `averages`, `current_pending_qnc`. Cached per node id, evicted above 5000 entries. |
| GET | `/api/v1/rewards/epoch/{epoch}/leafset?shard=` | One shard of an epoch's reward leaf set: `{epoch, shard, shards, wallets[[address, amount]]}`; `shard` defaults to 0, and `{epoch, shards: 0, wallets: []}` means this node holds no shards for the epoch. A node that cannot serve an epoch assembles the set from genesis peers and keeps it only if it hashes to the `reward_root` in its own certified macroblock |

The heartbeat requirement reported by `/api/v1/rewards/pending/{node_id}` is 9 for Super (`super_` and
`genesis_` ids) and 1 for Light (`light_` ids). See [economics](../economics/overview.md).

### Claiming

A claim requires a mandatory ML-DSA-65 signature over
`q{chain_id}|claim_rewards:{node_id}:{wallet_address}` plus the matching public key. A missing signature is rejected before any state is read;
a public key that does not derive `wallet_address` answers `{"success": false, "error", "reason": "key_not_wallet"}`
and a signature that does not verify `"reason": "bad_signature"`.

```bash
curl -s -X POST http://127.0.0.1:8001/api/v1/rewards/claim \
  -H 'Content-Type: application/json' \
  -d '{
        "node_id": "<node-id>",
        "wallet_address": "<eon-address>",
        "dilithium_signature": "<hex>",
        "dilithium_public_key": "<hex>"
      }'
```

`wallet_address` must pass full EON validation before any state is read; the wallet is then checked
against the on-chain node registration, and each proof is re-verified against the QC-certified reward
root at apply time.

The call above returns a **quote**: `claims_data`, `sign_message`, `claim_timestamp`,
`last_claimed_epoch` and `amount_nano` (a decimal string). Re-POSTing the same `claims_data` with a
`claims_signature` and the echoed `claim_timestamp` submits the claim and returns
`{success, tx_hash, amount_qnc, message}`.

A quote walks the epoch grid strictly above `last_claimed_epoch`, ascending, and stops rather than skips at
the first epoch it cannot serve. When it stops it carries `stopped_at_epoch` and `stopped_reason`:

| `stopped_reason` | Meaning | Client action |
| --- | --- | --- |
| `batch_full` | 512-epoch batch limit reached | re-call for the remainder |
| `quote_byte_budget` | 128 KiB quote budget reached | re-call for the remainder |
| `root_not_here` | this node holds no certified root for the epoch | retry against another node |
| `rebuild_budget` | the one leaf-set rebuild allowed per request was spent | re-call |
| `local_corruption` | this node's inputs do not reproduce the certified root; the epoch is parked for 3600 s while the node resyncs | claim against another node |
| `epoch_unservable` | the epoch yields no servable proof here | claim against another node |

Proof generation is bounded at 16 concurrent generations node-wide, and a per-node in-progress lock
refuses a second concurrent claim for the same `node_id`. See
[economics](../economics/overview.md).

## REST: smart contracts and tokens

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/contract/deploy` | Deploy base64-encoded WASM (2 MiB body): checks the magic bytes, runs `qnet_vm::validate_wasm_module`, requires an empty `constructor_args`, takes `gas_limit` (50,000 to 1,000,000) and `gas_price` from the body, and returns `{success, contract_address, code_hash, code_size, gas_limit, deployer, message, security{...}}` with no `tx_hash`. The one deploy route that works: the gas limit must cover the deploy's intrinsic gas ([Transactions](transactions.md#contract-deploy)) |
| POST | `/api/v1/wasm/deploy` | Deploy hex-encoded WASM: validates the module and returns `{success, tx_hash, contract{contract_address, creator}}`, but fixes `gas_price` 1,000 and `gas_limit` 200,000, below a deploy's intrinsic gas, so a deploy sent here cannot land |
| POST | `/api/v1/token/deploy` | QRC-20 deployment with `gas_limit` fixed at 50,000, below a deploy's intrinsic gas, so a deploy sent here cannot land |
| POST | `/api/v1/nft/deploy` | QRC-721 deployment with `gas_limit` fixed at 50,000, below a deploy's intrinsic gas, so a deploy sent here cannot land |
| POST | `/api/v1/contract/call` | A state-changing call (signature required, `transaction` bucket), or with `is_view: true` a read (`read_only` bucket, no signature). Every field of the body must be present, `args` may be `null`. A view of a QRC-20 or QRC-721 method answers `{success, is_view, contract_address, method, result, gas_used: 0, source}`; for a WASM contract, `storageGet` with `args: ["<key>"]` returns one stored value as text, and any other method runs with no input and returns no value (`"result": {"error": …}`) — see [Smart contracts](smart-contracts.md#reading-contract-state) |
| POST | `/api/v1/contract/estimate-gas` | A gas figure from `operation` (`deploy`/`call`/`view`) and sizes; its constants do not match the chain's intrinsic gas, so compute gas as [Transactions](transactions.md#gas-and-fees) describes |
| GET | `/api/v1/contract/{address}` | Reads a contract-info store that nothing writes: answers `Contract not found` for every contract. Use `GET /api/v1/account/{address}` |
| GET | `/api/v1/contract/{address}/state?key=` or `?keys=` | Reads a contract-state store that nothing writes: every key answers `null`. Use `GET /api/v1/account/{address}` or a `storageGet` view |
| GET | `/api/v1/logs?contract=&from=&to=` | `{success, from, to, oldest_available, pruned_below, count, logs[{height, log_index, tx_hash, contract, data}]}`; `log_index` is the event's position in its block's whole list, counted before the `contract` filter (the index `/api/v1/logs/proof` takes); at most 501 heights (`to` is cut to `from` + 500); `from` defaults to 0, below the prune floor |
| GET | `/api/v1/token/{contract}` | Serves both `qrc20` and `qrc721` as `{success, token{contract_address, standard, name, symbol, decimals, logo, total_supply, total_minted, total_burned, deployer, deployed_at}, source}`; supplies are strings, NFT `decimals` is 0 |
| GET | `/api/v1/token/{contract}/balance/{holder}` | `{success, contract_address, holder_address, balance, token_name, token_symbol, decimals, source}` read from `contract_storage["balance:{addr}"]`; `balance` is a string |
| GET | `/api/v1/token/{contract}/transfers?limit=&before=` | `{contract, count, transfers[], oldest_available}`, newest first |

All four deploy endpoints require the `dilithium_signature` and `dilithium_public_key` pair; the
public key cannot be left out on a deploy. All four use the `activation` bucket (5 per hour). See
[smart contracts](smart-contracts.md).

Recorded from the testnet nodes on 2026-09-25 (the burn address holds no token, and no contract
emitted events in that range):

```
GET /api/v1/token/0000000000000000000eon00000000000000036877022
{"contract_address":"0000000000000000000eon00000000000000036877022","error":"Token not found","success":false}
GET /api/v1/logs?from=2210000&to=2210100
{"count":0,"from":2210000,"logs":[],"oldest_available":2116800,"pruned_below":null,"success":true,"to":2210100}
```

## REST: statistics and monitoring

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/stats` | Nested `network` / `node` / `mempool` / `blockchain` objects plus a timestamp; includes `microblock_interval: 1`, `macroblock_interval: 90` and `current_round = height/30` |
| GET | `/api/v1/public/stats` | `active_nodes`, `light_nodes`, `full_nodes`, `super_nodes`, `height`, `phase`, `burn_percentage`, `supply_age_seconds` (the age of the 1DEV supply read behind `phase` and `burn_percentage`; all three are `null` when no read is available), `burn_address`, `qnc_burned`, `cached_at`, `cache_ttl_seconds`. Served from a 600-second cache. |
| GET | `/api/v1/producer/status` | `current_height`, `is_producer`, `current_producer`, `producer_endpoint`, `node_id`, `leadership_round`, `next_rotation_height`, `blocks_until_rotation`, `producer_selection_method`, `consensus_threshold` — computed for the next block |
| GET | `/api/v1/failovers?limit=&from_height=` | `{failovers[], total_count, from_height, limit, status, statistics, message}` |
| GET | `/api/v1/network/failovers` | Alias registered against the identical handler |
| GET | `/api/v1/reputation/history?node_id=&limit=` | `{node_id, current_reputation, history[], total_changes, limit, status}`; `current_reputation` comes from the latest macroblock snapshot |
| GET | `/api/v1/debug/consensus-position` | `{height, tip_hash, own_window, last_sealed_mb_index, sealed_lag_windows, finalized_height, tc_window_floor, floor_above_window, certified_round_current_window, certified_round_next_slot}`: the highest failover round certified anywhere in the current window, and the round the next slot is elected on (from the `failover_tenure_bound` gate, its own tenure's) |
| GET | `/api/v1/metrics/performance` | `mempool_size`, `current_height` and `peers_connected` read live, plus fields fixed in the handler or computed from those three |
| GET | `/api/v1/adaptive-bft/timeouts` | `current_height`, timeouts for block 1 / block 10 / the current block, and a config block: `base_timeout_ms 7000`, `timeout_multiplier 1.5`, `max_timeout_ms 20000`, `min_timeout_ms 1000` |
| GET | `/api/v1/shred-protocol/metrics` | Chunking parameters and status fields for block propagation |
| GET | `/api/v1/parallel-executor/metrics` | `enabled`, `pipeline_stages` and the five stage names (Validation, DependencyAnalysis, Execution, DilithiumSignature, Commitment), `max_parallel_tx`, `status` |
| GET | `/api/v1/pre-execution/status` | `enabled`, `lookahead_blocks`, `max_tx_per_block`, `cache_size`, counters and `status` |
| GET | `/api/v1/node/secure-info` | node_id, height, peers, mempool_size, version, node_type, region, status, uptime, pending_rewards, last_seen |

## REST: operator and load-generation routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/shutdown` | Internal IP + configured `QNET_ADMIN_SECRET` + matching `admin_secret` in the body. On success it spawns a delayed `flush_all()` then `process::exit(0)`. |
| POST | `/api/v1/benchmark/start` | Starts the internal transaction load generator. Ceilings: `num_accounts` 2 to 50,000, `total` at most 10,000,000, `target_tps` at most 150,000; a value above them answers `"error": "benchmark_limits"`. The generator submits only on a node started with `QNET_BENCHMARK_MODE` |
| POST | `/api/v1/benchmark/stop` | Stops it |
| GET | `/api/v1/benchmark/status` | Current run state |
| GET | `/api/v1/benchmark/results` | Result record of the last run |
| GET | `/api/v1/benchmark/presets` | Available configuration presets |

Every benchmark route answers `benchmark_disabled` unless `QNET_BENCHMARK_SECRET` (at least 16
characters) is set, then applies the `benchmark` rate-limit bucket, then requires the secret in the
`X-Benchmark-Secret` header (`start` also takes the body's `secret`); a wrong or missing secret answers
`unauthorized` and is logged as `[WARN][RPC] benchmark_auth_failed`. Leave the secret unset on a
production node.

## Related documents

- [Configuration and ports](../operators/configuration.md) — every environment variable named above
- [Maintenance](../operators/maintenance.md) — health checks, restart and recovery procedures
- [Networking](../architecture/networking.md) — the P2P transport behind `/api/v1/p2p/message`
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65 signing, EON address derivation
- [State](../architecture/state.md) — accounts, state roots and the proofs served above
- [Transactions](transactions.md) — the signed texts, gas and status of what the submit routes take
- [SDK](sdk.md) — `NodeClient`, a client of these routes
