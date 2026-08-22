# Configuration

The QNet node is configured through environment variables supplied to the container at start. This document lists the operator-facing variables with their defaults, states which ports the node uses, and separates out the development and test variables that must never be set on a production node. For installation and startup, see [running a node](running-a-node.md).

## Configuration policy

Consensus and safety parameters are compile-time constants. Rotation interval, macroblock interval, checkpoint interval, quorum size, committee size, view timeout, failover limits, warmup length and retention windows are `const` values in the consensus and integration crates, several of them additionally protected by compile-time assertions. They are not operator-tunable: a node whose consensus behaviour differs from its peers forks or wedges.

## Supplying variables

Variables are passed to the container with `-e NAME=value` or through a compose `environment:` list. A secret should instead be mounted as a file: the wallet-seed loader checks `<NAME>_FILE` first and reads the mnemonic from the referenced path, falling back to the inline variable while logging a warning about its exposure through `docker inspect` and `/proc/<pid>/environ`.

```bash
printf %s "your mnemonic words here" > ./qnet_seed
chmod 600 ./qnet_seed
# then: -v $(pwd)/qnet_seed:/run/secrets/qnet_seed:ro -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed
```

## Minimum configuration

A Super node needs exactly this much to start; everything else has a working default.

```
DOCKER_ENV=1
QNET_PRODUCTION=1
QNET_ACTIVATION_CODE=QNET-SXXXXX-YYYYYY-ZZZZZZ
QNET_BURN_TX_HASH=<solana_burn_tx_signature>
QNET_BURN_AMOUNT=<amount_burned>
QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed
```

A genesis bootstrap node substitutes the activation triple for a bootstrap id; burn verification is skipped for genesis identities.

```
DOCKER_ENV=1
QNET_PRODUCTION=1
QNET_BOOTSTRAP_ID=001
QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed
```

If none of `QNET_BOOTSTRAP_ID`, `QNET_ACTIVATION_CODE` or a previously saved activation record is available, the node prints the required-variable list and exits.

## Resolution order

Several settings are resolved from more than one source. The order is fixed in code:

- **Activation.** Genesis detection first (`QNET_BOOTSTRAP_ID` in `001`–`005`, `QNET_GENESIS_BOOTSTRAP=1`, or the host's detected public IP matching the pinned genesis IP list), which auto-generates a genesis code; then `QNET_ACTIVATION_CODE` when it is non-empty and starts with `QNET-`; then a previously saved activation in RocksDB; otherwise the process exits.
- **Wallet seed.** `<NAME>_FILE` (read from disk, trimmed) before the inline `<NAME>`; `QNET_WALLET_SEED` before `QNET_GENESIS_SEED`.
- **Data directory.** `QNET_DATA_DIR` when set; otherwise an automatic selection which, under Docker, prefers `/app/data` if it is writable.
- **Advertised external address.** `QNET_EXTERNAL_IP`, then `DOCKER_HOST_IP`, then STUN discovery against public servers.
- **Advertised API endpoint (on chain).** Suppressed entirely by `QNET_HIDE_IP`; otherwise `QNET_PUBLIC_IP`, then `EXTERNAL_IP`, then `HOST_IP`.
- **Pre-flight reachability address.** Detected by HTTP query to public IP services (`api.ipify.org`, `ifconfig.me`, `icanhazip.com`). When detection fails, the external reachability checks are skipped.
- **Genesis node list.** `QNET_GENESIS_NODES` (each entry security-validated), then a `genesis-nodes.json` file searched at `./`, `config/`, `/etc/qnet/` and `~/.qnet/` (files over 10 KB or listing more than 10 nodes are skipped), then the addresses pinned in the binary.
- **Genesis RPC base URL.** `QNET_RPC_URL`, then the first entry of `QNET_GENESIS_NODES` on port 8001, then `http://127.0.0.1:8001`.
- **Key-encryption secret.** `QNET_KEY_ENCRYPTION_SECRET` when it is exactly 64 hex characters, otherwise a `.qnet_encryption_secret` file in the key directory, generated on first use and integrity-tagged.

## Ports

| Port | Protocol | Bound by | Purpose |
|------|----------|----------|---------|
| 8001 | TCP | HTTP server (`QNET_API_PORT`) | REST API, JSON-RPC (`POST /rpc` and `POST /`), WebSocket `/ws/subscribe`, liveness probes |
| 10876 | UDP | QUIC listener (`QUIC_PORT`, bound on `0.0.0.0`) | The peer-to-peer transport. A peer's QUIC address is its API address plus `QUIC_PORT_OFFSET` (2875), so 8001 maps to 10876. Fixed. |
| 9876 | TCP | Pre-flight availability probe | Must be free; exposed by the image |
| 9877 | TCP | Pre-flight availability probe | Must be free; exposed by the image |
| 8101 | TCP | `QNET_API_PORT` + 100 | Bound inside the container; not published by the image and needs no firewall rule |

Pre-flight probes a fixed port set — 8001/TCP, 9876/TCP, 9877/TCP and 10876/UDP — regardless of the values of `QNET_API_PORT` and `QNET_P2P_PORT`. Those four ports must be free on the host even when the node is configured to serve elsewhere.

The QUIC listener binds IPv4. Pre-flight treats UDP 10876 as critical: if it is unreachable the node exits rather than run without block propagation.

## Identity and activation

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `QNET_ACTIVATION_CODE` | 25-character `QNET-...` activation code. Highest-priority activation source; a saved code in RocksDB is used only if this is unset. | none | `QNET-SXXXXX-YYYYYY-ZZZZZZ` |
| `QNET_BURN_TX_HASH` | Solana signature of the 1DEV burn that backs the code. Also selects the exact transaction to verify instead of scanning the wallet's recent signatures. | none | `<solana_tx_signature>` |
| `QNET_BURN_AMOUNT` | Whole 1DEV tokens burned. Part of the key material that decrypts the code, so it must match exactly. | `0` | `1500` |
| `QNET_WALLET_SEED_FILE` | Path to a file holding the BIP39 mnemonic. Preferred over the inline form. | none | `/run/secrets/qnet_seed` |
| `QNET_WALLET_SEED` | The mnemonic inline. The ML-DSA-65 consensus keypair is derived deterministically from it. | none | — |
| `QNET_GENESIS_SEED_FILE` / `QNET_GENESIS_SEED` | Same mechanism, consulted only when no wallet seed is present. | none | — |
| `QNET_BOOTSTRAP_ID` | Genesis bootstrap identity, `001`–`005`. Reserved for the five pinned genesis nodes; any other value is rejected. Also selects the light-node shard this node owns — `00N` pings and commits the eligibility bitmap for shard `N-1`, so the five values must be distinct across the genesis set. See [economics](../economics/overview.md). | none | `001` |
| `QNET_PRODUCTION` | `1` enables on-chain uniqueness checking of the activation code, Solana burn verification, and activation recording at startup. | unset | `1` |
| `QNET_NETWORK` | Selects the network profile: `mainnet`, `testnet` or `local`. An unrecognised value resolves to testnet. | `testnet` | `testnet` |
| `QNET_KEY_ENCRYPTION_SECRET` | 64 hex characters (32 bytes) used to encrypt the on-disk key material instead of the auto-generated file secret. Other lengths are rejected with a log line. | auto-generated | — |

`DOCKER_ENV=1` must also be set (or `/.dockerenv` must exist) — the binary runs in a container.

## Networking and peer discovery

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `QNET_P2P_PORT` | Fixed P2P port. Under Docker this must match the published port; the node retries the bind ten times and exits if it cannot claim it. | `9876` (auto-selected when neither this nor `DOCKER_ENV` is set) | `9876` |
| `QNET_API_PORT` | TCP port for the HTTP/JSON-RPC/WebSocket server. | `8001` | `8001` |
| `QNET_API_HOST` | Host used to build the node's own health-check URL at startup. | `0.0.0.0` | `127.0.0.1` |
| `QNET_EXTERNAL_IP` | Public address to advertise. Consulted before `DOCKER_HOST_IP` and before STUN discovery. | auto-detected | `<your.public.ip>` |
| `DOCKER_HOST_IP` | Fallback public address when `QNET_EXTERNAL_IP` is unset. | auto-detected | — |
| `EXTERNAL_IP` / `HOST_IP` | Address used for QUIC transport initialisation, and the fallbacks behind `QNET_PUBLIC_IP` when building the API endpoint advertised in the node's on-chain registration. | `0.0.0.0` for QUIC; empty for the endpoint | — |
| `QNET_PUBLIC_IP` | Address used when advertising the node's API endpoint on chain, in registration and in reactivation. | falls back to `EXTERNAL_IP`, then `HOST_IP` | — |
| `QNET_HIDE_IP` | If set (any value), the node advertises no API endpoint; a reactivation sent under it leaves the committed endpoint as it stands. | unset | `1` |
| `QNET_GENESIS_NODES` | Comma-separated genesis node addresses; each is security-validated. Also used to derive a genesis RPC URL when `QNET_RPC_URL` is unset. | pinned genesis list | `<ip1>,<ip2>` |
| `QNET_RPC_URL` | Explicit RPC base URL for genesis-side queries (device registration, uniqueness checks). | derived from `QNET_GENESIS_NODES`, else `http://127.0.0.1:8001` | `http://<host>:8001` |

Peer admission is fixed. The reserved outbound slots, the inbound reputation floor and the per-/24 and per-/16 subnet
caps are compile-time constants of the eclipse defence, identical on every node — see
[networking](../architecture/networking.md).

## Storage

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `QNET_DATA_DIR` | RocksDB data directory. Must be the mounted volume. | `/app/data` (set by the image); otherwise auto-selected | `/app/data` |
| `QNET_MAX_STORAGE_GB` | Storage ceiling in GB. When it is reached the node runs emergency cleanup and, if still full, refuses to save further blocks. | `2000` for Super | `2000` |
| `QNET_ACCOUNT_CACHE_CAPACITY` | Account read-through cache entries. Sizes RAM, not correctness — a cold entry reloads from the store. | `500000` | `500000` |
| `QNET_MERKLE_NODE_CACHE_CAP` | Merkle node read-through cache entries. Same caveat. | `2000000` | `2000000` |

Microblock-body pruning is fixed. Bodies are retained for `MICROBLOCK_BODY_RETENTION_BLOCKS`, a compile-time constant in the integration crate, and removed by `prune_old_microblock_bodies`.

## Logging

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `QNET_LOG_LEVEL` | In-process verbosity of the node's own `[LEVEL][MODULE]` lines, on the scale 0=OFF, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=TRACE. Read once before the first log line; values above 5 clamp to 5. | `3` (INFO) | `2` |
| `RUST_LOG` | Standard `env_logger` filter, governing output emitted through the `log` crate. If unset the node sets it to `info` before initialising the logger. | `info` | `info,qnet=debug` |
| `QNET_DETAILED_LOGGING` | `1` enables extra diagnostics in the endpoint registry. | unset | `1` |

Container-level log rotation is the operator's responsibility; the node is verbose at the default level. The reference compose file uses `max-size: 200m` with `max-file: 50`.

## API access control and rate limiting

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `QNET_ADMIN_SECRET` | Required for `POST /api/v1/shutdown`, which refuses every request without it, and enforced on `GET /api/v1/node/secure-info` whenever it holds a value. Set it: `secure-info` is authenticated only when this variable is set. | unset | 32 random bytes, hex |
| `QNET_API_KEY_EXPLORER` | API key that bypasses rate limiting, matched against the `X-API-Key` header. Minimum 16 characters; shorter values are logged and ignored. Applies to the two JSON-RPC routes. | unset | — |
| `QNET_API_KEY_ADMIN` | As above, for monitoring and administration tooling. | unset | — |
| `QNET_WHITELIST_IPS` | Comma-separated IPs that bypass rate limiting and satisfy the internal-caller check on privileged endpoints. Loopback is always included. | loopback only | `10.0.0.5` |
| `QNET_API_RATE_LIMIT` | Requests per 60-second window for the `transaction` bucket, clamped to 1–10000. | `100` | `100` |

Two behaviours matter when you build tooling against these. Rate-limit rejections are returned as HTTP 200 with an error body, so check the body rather than the status code; the WebSocket upgrade returns 429. The peer IP used for rate limiting and the internal-caller check is taken from the raw socket, so a reverse proxy attributes every request to itself, and a proxy terminating on loopback places everything behind it inside the whitelist.

## External services

The Solana RPC endpoint, the 1DEV mint, the burn-contract program id and the incinerator address all
come from the compiled network profile that `QNET_NETWORK` selects, so a node needs no Solana
configuration to verify burns.

| Variable | Purpose | Default |
|----------|---------|---------|
| `QNET_MAINNET_1DEV_MINT` | Replaces the pinned mainnet 1DEV mint. The value must be base58 of pubkey length; anything else logs `[CRIT][CONFIG] solana_address_invalid` and exits. An accepted override logs `[WARN][CONFIG] solana_address_overridden`. | pinned mainnet mint |
| `QNET_MAINNET_BURN_CONTRACT` | Replaces the pinned burn-contract program id, under the same check. | pinned program id |
| `IPFS_ENABLED`, `IPFS_API_URL`, `IPFS_GATEWAY_URL`, `IPFS_EXTRA_GATEWAYS` | Optional IPFS integration. | disabled |
| `FCM_PROJECT_ID`, `FCM_SERVER_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` | Push-notification delivery for mobile Light nodes; meaningful only on nodes that serve that role. | unset |

## Resource sizing

These affect local CPU and memory allocation. Most defaults adapt to the detected core count; change them only with a measured reason.

| Variable | Purpose | Default |
|----------|---------|---------|
| `QNET_CPU_LIMIT_PERCENT` | Percentage of detected cores the node may use (1–100). | `100` |
| `QNET_MAX_THREADS` | Absolute cap on worker threads; takes priority over the percentage. | unset |
| `QNET_SIGVERIFY_THREADS`, `QNET_BANKING_THREADS`, `QNET_REPLAY_THREADS`, `QNET_BROADCAST_THREADS` | Per-runtime worker-thread counts. `QNET_SIGVERIFY_THREADS` is clamped to 1..cores. | 1 on ≤4 cores, otherwise `cores/4` (minimum 2) |
| `QNET_VALUE_VERIFY_PERMITS` | Concurrency for value-transaction signature verification, per lane, minimum 4. | detected parallelism |
| `QNET_MEMPOOL_TTL` | Seconds before a never-confirmed transaction is evicted from the mempool. | `1800` |
| `QNET_MAX_PER_SENDER` | Mempool cap on pending transactions per sender. | `10000` |
| `QNET_PK_REGISTRY_CAP` | Consensus public-key registry capacity; clamped to a compile-time hard maximum of 1,000,000. | `1000000` |
| `QNET_PK_REGISTRY_IDLE_DAYS` | Idle threshold, in days, before a registry entry is evicted. | `30` |

## Operational controls

| Variable | Purpose | Notes |
|----------|---------|-------|
| `QNET_HALT_HEIGHT` | The node stops at this block height. | For coordinated upgrades. Meaningful only if the whole network agrees on the height; halting one node alone takes it offline. |
| `QNET_WEAK_SUBJECTIVITY_CHECKPOINT` | A syncing node refuses a chain whose tip is below this height, mitigating long-range attacks. | `0` by default. A value above the real tip makes the node unable to sync at all. Use only a height you have independently verified. |
| `QNET_CLEAN_DATA` | `1` deletes the known data directories and peer cache at startup. | Destructive and unconfirmed. It runs before storage is opened, after the startup guards (restart manifest, container check, logger, clock plausibility). |
| `QNET_FORCE_RESET` + `QNET_CONFIRM_RESET` | Resets stored chain height. Requires `QNET_FORCE_RESET=1` **and** `QNET_CONFIRM_RESET=YES`; either alone is refused. | Destructive; recovery procedure only. |

## Development and test only

**Do not set any of these on a production node.** They exist for local testing, load generation, controlled experiments and network creation, and several of them relax safety checks or change what the node produces and accepts.

| Variable | Effect |
|----------|--------|
| `QNET_BYPASS_DOCKER_CHECK` | Allows the binary to run outside a container. |
| `QNET_SKIP_RAM_CHECK` | Starts below the 4 GB memory floor. |
| `QNET_DEV_MODE` | Relaxes CORS to allow any origin and permits additional HTTP methods. |
| `QNET_DEV_API_KEY` | Extra API key, honoured in debug builds. |
| `QNET_BENCHMARK_MODE` | Prefunds a genesis set of 100 blake3-derived accounts at 10,000 QNC each and enlarges the mempool; the code logs `BENCHMARK_MODE_ACTIVE — NOT FOR PRODUCTION`. Genesis-creation only, and only on a chain that carries no value. |
| `QNET_BENCHMARK_SECRET` | Shared secret gating the benchmark start/stop endpoints. |
| `QNET_LOADTEST_ACCOUNTS`, `QNET_LOADTEST_BALANCE_QNC`, `QNET_LOADTEST_ALLOW` | Pre-funds generated accounts at genesis; refused unless `QNET_LOADTEST_ALLOW` is set. Pre-funded public-key accounts are drainable — never on a value-bearing chain. |
| `QNET_PEER_IPS` | Replaces peer discovery with a fixed list, pinning the node to a hand-written topology. |
| `QNET_MANUAL_IP` | Supplies an IP for the genesis duplication and authorisation checks when detection fails. |
| `QNET_GENESIS_FILE`, `QNET_GENESIS_MODE`, `QNET_BOOTSTRAP_NODE` | Genesis-file path and genesis-mode flags used when creating a network. |
| `QNET_MAINNET_LAUNCH_TIMESTAMP` | Sets the genesis block timestamp when a genesis node creates block 0, fixing chain identity and every slot-anchored timestamp thereafter. Genesis creation only. |
| `QNET_MICROBLOCK_INTERVAL` | Local block production interval in seconds (minimum 1). The protocol's slot cadence is one second; any other value desynchronises this node from the slot schedule. |
| `QNET_SKIP_GENESIS_DUPLICATION_CHECK` | Skips the startup scan for a duplicate genesis identity. Refused when `QNET_NETWORK=mainnet`. |
| `QNET_NODE_SECRET`, `QNET_AUDIT_SECRET` | Salts for local reputation and audit-chain hashes; both fall back to a node-id-derived value. |

## Handling secrets

Five values are secrets and must never appear in a committed file, a shell history, a support ticket or a log paste: the wallet mnemonic (`QNET_WALLET_SEED` / `QNET_GENESIS_SEED`), `QNET_ADMIN_SECRET`, `QNET_API_KEY_EXPLORER`, `QNET_API_KEY_ADMIN` and `QNET_KEY_ENCRYPTION_SECRET`. The activation code and burn transaction hash are not cryptographic secrets, but they identify your node licence and should be treated as private.

Practical guidance:

- Mount the mnemonic as a file with mode `0600` and set `QNET_WALLET_SEED_FILE`. The node warns once when it reads a seed from the environment instead.
- Generate `QNET_ADMIN_SECRET` and the API keys from a cryptographic source; API keys shorter than 16 characters are ignored.
- The node masks activation codes in its log output and never returns one over the API, but anything passed on a `docker run` command line remains visible in shell history and in `docker inspect`.
- Rotating the mnemonic changes the node identity, because the ML-DSA-65 consensus keypair is derived from it. Treat it as permanent for the life of the node.

## Related documents

- [Running a node](running-a-node.md) — installation, firewall, startup and verification.
- [Maintenance](maintenance.md) — monitoring, upgrades, restart and recovery.
- [RPC API](../developers/rpc-api.md) — endpoint reference, authentication and rate-limit behaviour.
- [Consensus](../architecture/consensus.md) — the compile-time parameters referenced above.
