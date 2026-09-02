# RPC and HTTP API reference

This document is the reference for the HTTP surface a QNet node exposes. Every node runs a single
[warp](https://crates.io/crates/warp) server, started by `start_rpc_server(blockchain, port)` in
`development/qnet-integration/src/rpc/mod.rs`, and that one server carries four surfaces: two plain-text
liveness probes, a WebSocket subscription endpoint, a JSON-RPC 2.0 endpoint registered at two paths,
and the REST routes under `/api/v1`.

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
by a fast container restart. If all 10 attempts fail, or if the warp server ever returns, the process
calls `std::process::exit(1)` so the supervisor restarts the node.

A separate warp server, defined in `development/qnet-integration/src/bin/qnet-node.rs`, binds
`rpc_port + 100` and answers `GET /metrics` in Prometheus text-exposition format, carrying the node
uptime series. Live node, chain and peer telemetry comes from the `/api/v1/*` paths with "metrics" in
their name, which return JSON.

## Liveness probes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Returns the literal string `OK` with HTTP 200. Touches no state. |
| GET | `/healthz` | Returns `ok h={height}` read from the `LOCAL_BLOCKCHAIN_HEIGHT` atomic. One atomic load, no locks. |

Container health checks should target `/healthz`. It reads no blockchain, P2P or mempool state, so it
stays accurate even when the heavier API surfaces are blocked. `/api/v1/node/health` reads all of that
state and is intended for monitoring dashboards rather than orchestrator liveness.

## Authentication

Authentication is per-endpoint and applies where an action is privileged or destructive.

| Gate | Where it applies | Behaviour |
| --- | --- | --- |
| `X-API-Key` header | `POST /rpc` and `POST /` | Matched against `QNET_API_KEY_EXPLORER` / `QNET_API_KEY_ADMIN`. Minimum 16 characters, enforced both at load and at check. A valid key bypasses rate limiting; it grants no extra methods. |
| `QNET_DEV_API_KEY` | same two routes | Additional key, compiled in under `#[cfg(debug_assertions)]` for debug builds. |
| Internal-IP check | `POST /api/v1/p2p/message`, `POST /api/v1/shutdown` | `is_internal_ip()` accepts loopback, RFC1918, IPv4 link-local, IPv6 loopback, `fc00::/7`, `fe80::/10`, and anything in `QNET_WHITELIST_IPS`. Unparseable strings are rejected. |
| `QNET_ADMIN_SECRET` | `POST /api/v1/shutdown` | Mandatory. If the variable is unset or empty the request is denied. Also requires an internal caller IP and a matching `admin_secret` field in the body. |
| `QNET_ADMIN_SECRET` | `GET /api/v1/node/secure-info` | Read from `Authorization: Bearer <secret>`, or from an `admin_secret` query parameter. Enforced whenever the variable is configured, so set it on any node whose API port is reachable. |
| Genesis-IP allowlist | `POST /api/v1/internal/fcm-token-sync` | Genesis IPs plus loopback; everyone else receives HTTP 403. |
| `QNET_BENCHMARK_SECRET` | `POST /api/v1/benchmark/start`, `POST /api/v1/benchmark/stop` | Start requires `QNET_BOOTSTRAP_ID` (genesis node) or a configured `QNET_BENCHMARK_SECRET`; whenever the secret is configured, the request body's `secret` must match it — genesis status does not bypass a configured secret. Stop additionally requires a genesis node or an internal IP whenever the secret is configured. |
| Submitter-IP match | `DELETE /api/v1/bundle/{bundle_id}` | Caller IP must equal the recorded submitter IP, or pass `is_internal_ip()`. |

The API key applies to the two JSON-RPC routes and is read from the `x-api-key` header.

Signature-based authorisation is separate from transport authentication. Every value transfer, reward
claim and contract deployment carries a mandatory ML-DSA-65 (FIPS 204) signature. Verification runs in
the handler whenever the public key is on the wire, and in `submit_transaction` for a transfer that
elides an already-committed key. See [cryptography](../architecture/cryptography.md).

## Rate limiting

Rate limiting is a per-IP, per-category sliding window. The client IP comes from the raw TCP peer
address (`warp::addr::remote()`).

| Category | Requests | Window | Block duration | Used by |
| --- | --- | --- | --- | --- |
| `read_only` | `max(tx_rate * 3, 300)` | 60 s | 30 s | most GET routes; all JSON-RPC methods except the write set |
| `general` | `max(tx_rate, 100)` | 60 s | 60 s | fallback bucket, including the `write`, `batch_transfer` and `register_node` handlers |
| `transaction` | `tx_rate` (default 100) | 60 s | 300 s | `POST /api/v1/transaction`, node registration/reactivation submit, non-view contract calls |
| `activation` | 5 | 3600 s | 3600 s | activation-code generation, `POST /api/v1/register-device`, contract/token/NFT/WASM deploy |
| `light_node_register` | 3 | 3600 s | 3600 s | `POST /api/v1/light-node/register` |
| `light_node_ping` | 6 | 60 s | 300 s | light-node ping response |
| `light_node_token_refresh` | 2 | 3600 s | 1800 s | `POST /api/v1/light-node/token-refresh` |
| `claim_rewards` | 10 | 3600 s | 1800 s | `POST /api/v1/rewards/claim` |
| `consensus` | 60 | 60 s | 60 s | `POST /api/v1/p2p/message` |
| `mev_bundle` | 30 | 60 s | 120 s | bundle submit/status/cancel |
| `benchmark` | 5 | 60 s | 300 s | all `/api/v1/benchmark/*`, `POST /api/v1/shutdown` |

`tx_rate` is `QNET_API_RATE_LIMIT`, parsed as requests per minute and clamped to `1..=10_000`,
default `100`.

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
the HTTP status. The retry hint is the `retry_after_seconds` field. The WebSocket upgrade refusal is
the one path that answers with HTTP 429, carrying the plain body
`WebSocket connection limit exceeded`.

### Whitelisting and the proxy note

`check_api_rate_limit` returns `Ok(())` for any IP in `WHITELIST_IPS` before touching a counter.
`WHITELIST_IPS` always contains `127.0.0.1` and `::1`, plus every address in `QNET_WHITELIST_IPS`.

The limiter keys on the raw socket address, so a reverse proxy terminating on localhost attributes
every request to `127.0.0.1`, which is whitelisted. Enforce rate limiting at the proxy in any proxied
deployment.

## Request and response conventions

- **REST handlers return HTTP 200** and carry the outcome in the JSON body (typically
  `{"success": false, "error": "..."}` or `{"error": "...", "details": "..."}`). Three REST paths set
  a non-200 status: `/api/v1/microblock/{height}` (404/500), `/api/v1/genesis/block` (404) and
  `/api/v1/internal/fcm-token-sync` (403/400/500).
- **Body size caps** are per-route, enforced by `warp::body::content_length_limit`:

  | Route | Cap |
  | --- | --- |
  | `POST /rpc`, `POST /` | 1 MiB |
  | `POST /api/v1/transaction` | 64 KiB |
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

`ALLOWED_ORIGINS` is a fixed list of 11 origins: `qnet.network` plus its `app`, `explorer`, `wallet`
and `docs` subdomains over HTTPS, `http://localhost:3000`, `http://localhost:8080`,
`http://127.0.0.1:3000`, `http://127.0.0.1:8080`, `capacitor://localhost` and `ionic://localhost`.

| Mode | Methods | Headers | `max_age` |
| --- | --- | --- | --- |
| Production (default) | POST, GET, OPTIONS | `Content-Type`, `Authorization`, `User-Agent`, `X-API-Key` | 86400 s |
| `QNET_DEV_MODE` set | adds PUT, DELETE | adds `X-Requested-With`; any origin allowed | 3600 s |

`allow_credentials` is never enabled.

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
| `node_getInfo` | none | `node_id` (`node_{port}`), height, peers, mempool size, version, node type, region, status. |
| `node_getPeers` | none | `{count, peers[], max_peers: 50, connection_status}`; each peer has id, address, node_type, region, last_seen, connection_time, reputation, version. |
| `chain_getHeight` | none | `{height}` |
| `chain_getBlock` | `{height}` | The block, or error `-32000`. |
| `chain_getBlocks` | `{start, limit}` | `limit` defaults to 10, capped at 100. Returns an array. |
| `tx_submit` | transaction object | |
| `tx_sendTransaction` | transaction object | Alias of `tx_submit`. |
| `tx_get` | `{hash}` | |
| `mempool_getTransactions` | none | |
| `mempool_submit` | transaction object | |
| `account_getInfo` | `{address}` | |
| `account_getBalance` | `{address}` | `{balance}` in nanoQNC. |
| `stats_get` | none | |
| `qrb_getRandomness` | epoch selector | Randomness beacon; error `-32001` if the epoch is not finalized. |
| `qrb_getLatestRandomness` | none | Error `-32001` if no epoch is finalized yet. |
| `qrb_getRandomnessWithSeed` | epoch selector + seed | |
| `device_migration` | `{activation_code, new_device_signature, dilithium_signature, dilithium_public_key}` | Verifies ML-DSA-65 over `migrate:{activation_code}:{new_device_signature}`. |
| `node_getTransferStatus` | `{activation_code}` | `{has_activation, node_type, activated_at, supports_transfer, device_support}` |
| `node_attestBurn` | burn attestation | Genesis-side verification of an external Phase 1 burn. |

### Error codes

| Code | Meaning |
| --- | --- |
| `-32000` | Internal error, or requested object not found |
| `-32001` | Epoch not yet finalized (randomness beacon) |
| `-32003` | ML-DSA-65 signature verification failed on device migration |
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

`GET /ws/subscribe?channels=...` upgrades to a WebSocket. Supported channel forms are `blocks`,
`account:ADDRESS`, `contract:ADDRESS`, `rewards:NODE_ID`, `mempool` and `tx:HASH`, comma-separated;
the default is `blocks`. On connect the server sends a welcome frame; `subscribed_channels` is the
number of channels parsed:

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

Three JSON-RPC methods are served over the socket: `chain_getBlocks` (limit capped at 20),
`chain_getBlock` and `chain_getHeight`. Anything else returns `-32601`. Exceeding the per-connection
rate limit returns `-32029`.

## REST: chain and blocks

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/height` | `{height, network_height, is_syncing, blocks_behind}` using `max(local, cached P2P height)` |
| GET | `/api/v1/block/latest` | Block at the current tip |
| GET | `/api/v1/block/{height}` | Block JSON plus `timeout_round`, `carried_baseline` and `abs_round` (= sum of the two) injected from the stored microblock |
| GET | `/api/v1/block/hash/{hash}` | `{hash, found, block{...}}`; searches the last 1000 blocks, recomputing each hash |
| GET | `/api/v1/genesis/block` | Full block 0 with its transactions, bincode + zstd, as `application/octet-stream` (computed once per process; identical bytes on every node, so a joining node's multi-source hash vote agrees); HTTP 404 `{error:"genesis_block_unavailable"}` when the node cannot reconstruct block 0 |
| GET | `/api/v1/microblock/{height}` | Deserialized microblock; HTTP 404 `Block not yet produced` for a future height, `Block not found` for a missing one; HTTP 500 `Failed to load block` on a storage error |
| GET | `/api/v1/microblocks?from=&to=` | `{from, to, items[{height, data}]}` with `data` as base64 raw bytes; `to` is clamped to `from + 100` |
| GET | `/api/v1/macroblock/{index}` | `{index, height, timestamp, micro_blocks_count, micro_blocks[], state_root, consensus_data{...}, previous_hash}` |
| GET | `/api/v1/blocks/stats` | Height, block-time and macroblock-boundary counters |

## REST: light-client proofs

These are the endpoints a device uses to verify chain state without trusting the server. See
[consensus](../architecture/consensus.md) and [state](../architecture/state.md) for what each root
commits to.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/macroblock/{index}/proof` | Full bundle: `{index, epoch, checkpoint, qc{signers, sigs}, committee, committee_pubkeys, eligible_raw, banned, recovery_anchor_checkpoint}`. `committee_pubkeys` covers the derived committee union the QC's actual signers. |
| GET | `/api/v1/registry/height/{height}` | `{registry_root, entries}` — the chain-confirmed roster as of that height plus its LtHash root |
| GET | `/api/v1/validators/proof` | `{validators[], epoch, merkle_root, last_update_height, current_height, total_validators, active_validators}`; the root is SHA3-256 over the tag `QNET_VALIDATOR_SET:` + epoch + each sorted validator's fields |
| GET | `/api/v1/account/{address}/balance/proof` | Balance, nonce, all four heartbeat leaf fields, `last_claimed_epoch`, `banned_at_height`, `is_node`, `merkle_proof[{sibling, is_right}]`, `state_root`, `block_height`, `proof_valid` |
| GET | `/api/v1/token/{contract}/{holder}/balance/proof` | Two-level proof: `storage_proof`/`storage_root` for the balance leaf plus `account_proof` and every contract-account leaf field, anchored by `state_root` and `block_height` |
| GET | `/api/v1/logs/proof?tx_hash=&log_index=` | Sharded two-level inclusion proof: `{tx_hash, log_index, window_start, window_end, block_index, leaf, proof, block_root, window_proof, logs_root}` |

The macroblock proof endpoint has five distinct error returns: `macroblock_not_found`,
`no_checkpoint_qc`, `qc_decode_failed`, `banned_decode_failed`, and `qc_sigs_pruned` (with
`action: "repin_recent_anchor"`).
The log-proof endpoint answers an unfinalized window with `{error:"window_not_finalized"}` and a
pruned window with `{error:"window_pruned", oldest_available}`.

The `checkpoint.total_supply` field is a string.

## REST: snapshots

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/snapshot/latest?max_height=` | `{height, ipfs_cid, available, node_id, timestamp}` or `{available:false}` |
| GET | `/api/v1/snapshot/{height}` | Compressed snapshot as `application/octet-stream` with a `Content-Disposition: attachment` header |
| GET | `/api/v1/snapshot/{height}/manifest` | Stored chunk manifest for parallel download |
| GET | `/api/v1/snapshot/{height}/chunk/{index}` | One chunk as `application/octet-stream` |

Full-file and chunk serving both acquire `SNAPSHOT_SERVE_SEM`, a node-global semaphore with 16
permits. When it is exhausted the response is `{error: "snapshot serve busy"}`.

## REST: accounts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/account/{address}` | Serialized account. The 1952-byte `dilithium_public_key` is replaced on the wire by a boolean `has_dilithium_pk`. An unknown account yields a zeroed default object. |
| GET | `/api/v1/account/{address}/balance` | `{address, balance}` in nanoQNC; addresses longer than 64 characters are rejected |
| GET | `/api/v1/account/{address}/transactions` | First page of up to 50 transactions plus a total count |
| GET | `/api/v1/account/{address}/token-transfers?limit=&before=` | `{address, count, transfers[], oldest_available}`, each transfer enriched with symbol, decimals, logo and a `{height:016x}_{log_index:08x}` cursor |
| GET | `/api/v1/account/{address}/tokens` | QRC-20 holdings. Uses the reverse owns-index when `OWNS_INDEX_READY` is set (`source: "reverse_index"`), otherwise a full account scan (`source: "blockchain_state"`) |
| GET | `/api/v1/richlist?limit=` | `{success, total_supply_raw, circulating_raw, burned_raw, holder_count, holders[{address, balance_raw, percent}], source}`; `circulating = total_supply − burn-sink balance`. Limit defaults to 100, clamped `1..=500`. |

Feed limits: token-transfer feeds default to 50 and are clamped `1..=200`; the `before` cursor must
be at most 40 characters of hex or underscore.

## REST: transactions and mempool

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/transaction` | Submit a signed transfer |
| GET | `/api/v1/transaction/{hash}` | `{tx_hash, transaction{...}, status}` |
| GET | `/api/v1/transactions/recent?page=&per_page=` | `{success, transactions[], pagination{...}, current_height}` |
| GET | `/api/v1/transactions/history?address=&page=&per_page=&tx_type=&direction=` | Filtered, paginated address history |
| GET | `/api/v1/mempool/status` | `{size, max_size, status, node_id, timestamp}` |
| GET | `/api/v1/mempool/transactions?limit=&offset=` | `{transactions, count, total_count, offset, limit, node_id}` |
| GET | `/api/v1/gas/recommendations` | Four tiers (`eco`, `standard`, `fast`, `priority`), each with `gas_price`, `estimated_time` and `cost_qnc`, plus `network_load`, `mempool_size`, `current_height`, `base_fee`, `node_id`. `base_fee` scales off `qnet_state::transaction::MIN_GAS_PRICE` by mempool depth. |

`per_page` on both history endpoints is clamped `1..=100`. Mempool paging defaults to a limit of 100
and is capped at 1000. `/api/v1/token-transfers?from=&to=&limit=&after=` (explorer ingestion) accepts
a range of at most 10 000 blocks with a limit defaulting to 2000, clamped `1..=5000`.

### Submitting a transfer

`POST /api/v1/transaction` validates both EON addresses before anything else, then requires the
ML-DSA-65 `dilithium_signature`. `dilithium_public_key` is optional under pk-elision: send it on
first use — the handler then binds `from` to it and verifies the signature inline — and omit it once
the key is committed on-chain, in which case `submit_transaction` rehydrates it from committed state
and rejects with `pk_unresolved` if it cannot:

```bash
curl -s -X POST http://127.0.0.1:8001/api/v1/transaction \
  -H 'Content-Type: application/json' \
  -d '{
        "from": "<eon-address>",
        "to": "<eon-address>",
        "amount": 1000000000,
        "gas_price": 1,
        "gas_limit": 21000,
        "nonce": 7,
        "dilithium_signature": "<hex>",
        "dilithium_public_key": "<hex>"
      }'
```

Success and failure both return HTTP 200:

```json
{ "success": true, "tx_hash": "...", "message": "Transaction submitted successfully" }
```

```json
{ "success": false, "error": "Failed to add transaction to mempool", "details": "<real reason>" }
```

The `details` field carries the actual rejection reason on purpose: wallet self-heal paths key on it,
so a `pk_unresolved` rejection makes an eliding wallet re-attach its public key and a nonce rejection
makes it refetch.

`GET /api/v1/transaction/{hash}` returns `is_quantum_signed`, `signature_type`
(`"Dilithium3 (ML-DSA-65)"` when signed), an optional `quantum_security` block and optional
`finality_indicators` alongside the usual transaction fields.

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
| GET | `/api/v1/node/status` | Accepts `node_id`, `wallet` or `activation_code`; the wallet may also arrive in `X-QNet-Wallet`. Resolves through the on-chain wallet reverse index before falling back to activation-code mapping. |
| POST | `/api/v1/light-node/register` | Light-node registration with per-wallet failed-attempt limiting (max 5 failures per 600 s, independent of IP), EON validation, and `already_registered` / reactivation results |
| POST | `/api/v1/light-node/token-refresh` | Requires a signature prefixed `ping_dilithium:` over `token_refresh:{node_id}:{timestamp}`, a timestamp within 300 s, and a delegation certificate `delegate_ping:{ping_pubkey}:{node_id}` verified against the on-chain VRF key |
| GET, POST | `/api/v1/light-node/ping-response` | Registered twice — GET with query parameters, POST with a JSON map body under a 64 KiB cap — both routed to the same handler. A signed response carries enveloped ML-DSA-65 signatures, so POST is the form that fits. |
| GET | `/api/v1/light-node/status?node_id=` | `{success, node_id, is_active, registered_at, push_type, has_attestation_current_slot, next_ping_time, next_ping_window, needs_reactivation, onchain_registered}` |
| GET | `/api/v1/light-node/next-ping?node_id=` | `{success, node_id, next_ping_time, next_ping_window, current_slot, current_window, slots_per_window: 240, window_duration_seconds: 14400}` |
| GET | `/api/v1/light-node/pending-challenge?node_id=` | Serves nodes whose `push_type` is `Polling`; `{success, node_id, has_challenge, challenge, created_at, expires_at}` with a 180-second expiry |
| GET | `/api/v1/node-device?node_id=` | `{success, node_id, device_id}`, `device_id` null when unset |
| POST | `/api/v1/register-device` | Requires the node to already be registered as type `super`; node ids starting with `genesis_node_` are rejected. Strict `activation` bucket (5/hour). |
| POST | `/api/v1/internal/fcm-token-sync` | `{pseudonym, token, push_type, endpoint, origin_ip}` from genesis IPs or loopback only; 403 otherwise, 400 on missing fields, 500 on save failure |

The ping-response handler accepts two challenge forms: a server-issued stamp verified by
`verify_challenge_stamp`, or `selfattest:{height}:{block_hash}` checked against the canonical
microblock hash within the same 14 400-block epoch. See
[node activation](../economics/node-activation.md).

## REST: activation and registration

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/node-registration/submit` | Accepts `node_type: "light"`; super-node registration is server-initiated |
| POST | `/api/v1/node-reactivation/submit` | Reactivation. Takes `node_id`, `current_height`, `last_macroblock_hash`, `last_macroblock_index` and an optional `api_endpoint` that republishes the node's committed address; omitting it announces the node's own configured endpoint. Accepted for the node itself or from an internal caller address, and the endpoint is validated (`http(s)`, no loopback, RFC 1918 or link-local host) before it is signed. |
| POST | `/api/v1/nodes` | Super-node registration. Light nodes use `/api/v1/light-node/register`, which issues a post-quantum gossip signature. |
| POST | `/api/v1/generate-activation-code` | Validates the EON reward wallet. Strict `activation` bucket (5/hour). |
| GET | `/api/v1/verify-activation` | Resolves a wallet through the O(1) storage reverse index, then genesis wallet constants; `{verified, source, node_id, node_type, wallet_address}` or `{verified:false, current_height}` |
| GET | `/api/v1/activations/by-wallet` | All nodes for a wallet when `node_type` is omitted; accepts `X-QNet-Wallet` |
| GET | `/api/v1/activation/price?type=` | Phase 1: `{phase:1, cost, currency:"1DEV", base_cost:1500, min_cost:300, burn_percentage, savings, savings_percent, mechanism:"burn", universal_price:true}`. Phase 2 returns QNC pricing with a network-size multiplier. |

## REST: rewards

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/rewards/claim` | Claim accrued rewards |
| GET | `/api/v1/rewards/pending/{node_id}` | node_type, phase, `pending_rewards` (QNC), `pending_rewards_nano`, `first_unclaimed_epoch`, pools breakdown, epoch range, `last_claim`, `heartbeats{current, required, remaining}`, `is_active`, `is_eligible`, `is_claimable` |
| POST | `/api/v1/rewards/pending/batch` | `{node_ids: [...]}`, at most 100 → `{success, current_epoch, total_pending_qnc, count, nodes[]}` |
| GET | `/api/v1/rewards/history/{node_id}?offset=&limit=` | Per-epoch claim records; limit defaults to 10, capped at 100 |
| GET | `/api/v1/rewards/pools/{node_id}` | `current_phase`, `phase_description`, pending-rewards pool breakdown, `epoch_accumulated` |
| GET | `/api/v1/rewards/by-wallet/{wallet_address}` | `{wallet_address, total_nodes, total_pending_qnc, current_epoch, nodes[]}` from the storage wallet→nodes index |
| GET | `/api/v1/rewards/network/stats` | `current_epoch`, `current_height`, `blocks_until_next_epoch`, `epoch_accumulated`, `network_totals`, `emission_rate`. Served from a 30-second cache. |
| GET | `/api/v1/rewards/summary/{node_id}` | `lifetime_totals`, `epochs{total_epochs, epochs_claimed, epochs_missed, claim_rate_percent}`, `first_claim`, `last_claim`, `averages`, `current_pending_qnc`. Cached per node id, evicted above 5000 entries. |

The heartbeat requirement reported by `/api/v1/rewards/pending/{node_id}` is 9 for Super, 8 for Full
and 1 for Light. See [economics](../economics/overview.md).

### Claiming

A claim requires a mandatory ML-DSA-65 signature over `claim_rewards:{node_id}:{wallet_address}`
plus the matching public key. A missing signature is rejected before any state is read.

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

A quote covers epochs strictly above `last_claimed_epoch`, ascending, and stops rather than skips at
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

| Method | Path | Purpose | Rate bucket |
| --- | --- | --- | --- |
| POST | `/api/v1/wasm/deploy` | Deploy executable WASM: hex-decodes the code, runs `qnet_vm::validate_wasm_module`, returns `{success, tx_hash, contract{contract_address, creator}}` | `activation` |
| POST | `/api/v1/token/deploy` | QRC-20 deployment | `activation` |
| POST | `/api/v1/nft/deploy` | QRC-721 deployment | `activation` |
| POST | `/api/v1/contract/deploy` | Deploy base64-encoded WASM up to 2 MiB: checks the magic bytes, runs `qnet_vm::validate_wasm_module`, requires an empty `constructor_args`, and returns `{success, contract_address, code_hash, code_size, gas_limit, deployer, security{...}}` | `activation` |
| POST | `/api/v1/contract/call` | Call a contract; `is_view: true` needs no signature and reads directly from state | `read_only` for views, `transaction` otherwise |
| POST | `/api/v1/contract/estimate-gas` | Gas figure from `operation` (`deploy`/`call`/`view`) plus code and argument sizes | `general` |
| GET | `/api/v1/contract/{address}` | `{success, contract{address, deployer, deployed_at, code_hash, version, total_gas_used, call_count, is_active}}` | `read_only` |
| GET | `/api/v1/contract/{address}/state?key=` or `?keys=` | Single or multiple storage values; requires one of the two parameters | `read_only` |
| GET | `/api/v1/logs?contract=&from=&to=` | `{success, from, to, oldest_available, pruned_below, count, logs[{height, tx_hash, contract, data}]}`; range capped at 500 blocks (`MAX_LOG_RANGE`) | `read_only` |
| GET | `/api/v1/token/{contract}` | Serves both `qrc20` and `qrc721`; `total_supply`, `total_minted` and `total_burned` are strings, NFT `decimals` is 0 | none |
| GET | `/api/v1/token/{contract}/balance/{holder}` | `{success, contract_address, holder_address, balance, token_name, token_symbol, decimals, source}` read from `contract_storage["balance:{addr}"]` | none |
| GET | `/api/v1/token/{contract}/transfers?limit=&before=` | `{contract, count, transfers[], oldest_available}`, newest first | `read_only` |

All four deploy endpoints (`wasm`, `token`, `nft`, `contract`) require a mandatory
`dilithium_signature` and `dilithium_public_key` pair. See [smart contracts](smart-contracts.md).

## REST: statistics and monitoring

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/stats` | Nested `network` / `node` / `mempool` / `blockchain` objects plus a timestamp; includes `microblock_interval: 1`, `macroblock_interval: 90` and `current_round = height/30` |
| GET | `/api/v1/public/stats` | `active_nodes`, `light_nodes`, `full_nodes`, `super_nodes`, `height`, `phase`, `burn_percentage`, `burn_address`, `qnc_burned`, `cached_at`, `cache_ttl_seconds`. Served from a 600-second cache. |
| GET | `/api/v1/producer/status` | `current_height`, `is_producer`, `current_producer`, `producer_endpoint`, `node_id`, `leadership_round`, `next_rotation_height`, `blocks_until_rotation`, `producer_selection_method`, `consensus_threshold` — computed for the next block |
| GET | `/api/v1/failovers?limit=&from_height=` | `{failovers[], total_count, from_height, limit, status, statistics, message}` |
| GET | `/api/v1/network/failovers` | Alias registered against the identical handler |
| GET | `/api/v1/reputation/history?node_id=&limit=` | `{node_id, current_reputation, history[], total_changes, limit, status}`; `current_reputation` comes from the latest macroblock snapshot |
| GET | `/api/v1/debug/consensus-position` | `{height, tip_hash, own_window, last_sealed_mb_index, sealed_lag_windows, finalized_height, tc_window_floor, floor_above_window, certified_round_current_window}` |
| GET | `/api/v1/metrics/performance` | Mempool size and capacity, current height, peers connected, and fields derived from them |
| GET | `/api/v1/adaptive-bft/timeouts` | `current_height`, timeouts for block 1 / block 10 / the current block, and a config block: `base_timeout_ms 7000`, `timeout_multiplier 1.5`, `max_timeout_ms 20000`, `min_timeout_ms 1000` |
| GET | `/api/v1/shred-protocol/metrics` | Chunking parameters and status fields for block propagation |
| GET | `/api/v1/parallel-executor/metrics` | `enabled`, `pipeline_stages` and the five stage names (Validation, DependencyAnalysis, Execution, DilithiumSignature, Commitment), `max_parallel_tx`, `status` |
| GET | `/api/v1/pre-execution/status` | `enabled`, `lookahead_blocks`, `max_tx_per_block`, `cache_size`, counters and `status` |
| GET | `/api/v1/node/secure-info` | node_id, height, peers, mempool_size, version, node_type, region, status, uptime, pending_rewards, last_seen |

## REST: operator and load-generation routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/shutdown` | Internal IP + configured `QNET_ADMIN_SECRET` + matching `admin_secret` in the body. On success it spawns a delayed `flush_all()` then `process::exit(0)`. |
| POST | `/api/v1/benchmark/start` | Starts the internal transaction load generator. Requires `QNET_BOOTSTRAP_ID` or a configured `QNET_BENCHMARK_SECRET`; when the secret is configured the body `secret` must match it regardless of node type. |
| POST | `/api/v1/benchmark/stop` | Stops it; additionally requires a genesis node or an internal IP when the secret is configured. |
| GET | `/api/v1/benchmark/status` | Current run state |
| GET | `/api/v1/benchmark/results` | Result record of the last run |
| GET | `/api/v1/benchmark/presets` | Available configuration presets |

The three GET benchmark routes are guarded by the `benchmark` rate-limit bucket alone. Block them at
the proxy on any node whose API port is publicly reachable.

## Related documents

- [Configuration and ports](../operators/configuration.md) — every environment variable named above
- [Maintenance](../operators/maintenance.md) — health checks, restart and recovery procedures
- [Networking](../architecture/networking.md) — the P2P transport behind `/api/v1/p2p/message`
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65 signing, EON address derivation
- [State](../architecture/state.md) — accounts, state roots and the proofs served above
- [SDK](sdk.md)
