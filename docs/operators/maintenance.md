# Node maintenance

This document covers day-to-day operation of a running QNet Super node: which endpoints to poll and what their
fields mean, how to read the node's consensus-position diagnostics, how logging works, how disk usage grows and what
the node prunes on its own, what must be backed up, how to upgrade, the coordinated-restart procedure, and how to work
through common failure states. Installation and first start are in [running-a-node.md](running-a-node.md); every
environment variable named here is described in [configuration.md](configuration.md).

## What to monitor

All monitoring endpoints are served by the node's single HTTP server on `QNET_API_PORT` (default `8001`, bound on
`0.0.0.0`, plain HTTP — TLS is terminated upstream). The full reference is [rpc-api.md](../developers/rpc-api.md).

| Endpoint | Use it for | Notes |
|---|---|---|
| `GET /healthz` | container liveness probe | Returns `ok h={height}` from a single atomic load and takes no lock. This is the probe to wire into the container runtime; `GET /health` returns a bare `OK`. |
| `GET /api/v1/node/health` | the main dashboard record | Rich, but touches blockchain, P2P and mempool state; do not use it as a liveness probe. |
| `GET /api/v1/sync/status` | catch-up progress | `local_height`, `network_height`, `is_syncing`, `is_ahead`, `blocks_behind`, `blocks_ahead`, `sync_progress`, `estimated_sync_time`. |
| `GET /api/v1/debug/consensus-position` | finality health | See below — the most useful endpoint during an incident. |
| `GET /api/v1/producer/status` | leadership | `is_producer`, `current_producer`, `leadership_round`, `next_rotation_height`, `blocks_until_rotation`, computed for the **next** block. |
| `GET /api/v1/peers` | connectivity | Full peer list plus `statistics`; appends up to two genesis bootstrap peers when the node holds fewer than three. |
| `GET /api/v1/diagnostics/network` | transport | Peer counts and a QUIC statistics block. |
| `GET /api/v1/mempool/status` | backlog | `size` is the live mempool count. |
| `GET /api/v1/blocks/stats` | production cadence | `current_height`, `macroblock_height`, `next_macroblock`, `blocks_until_macroblock`, `pending_transactions`. |
| `GET /api/v1/failovers` | failover history | Takes `limit` and `from_height`; `GET /api/v1/network/failovers` is an alias onto the same handler. |
| `GET /api/v1/reputation/history?node_id=` | reputation | `current_reputation` is read from the latest macroblock snapshot, so every node reports the same value. |

`GET /api/v1/node/health` reports `status` as one of `healthy`, `isolated` (zero peers), `syncing`, `degraded` (fewer
than four validated peers on a non-genesis node), `checking` (peers present but network height undeterminable) or
`bootstrap`. Alongside the obvious counters it carries the runtime consensus and clock observability fields:
`clock_drift_ema_secs`, `clock_drift_peak_secs`, `current_timeout_round` (0 in steady state, above 0 during BFT
failover), `max_slot_delay_secs`, `max_timeout_round_seen`, `failover_count` and `timestamp_rejections`.

Two API behaviours shape how you scrape a node. **Rate-limit rejections come back as HTTP 200**, carrying
`{"success":false,"error":"Rate limit exceeded","retry_after_seconds":…}` in the body, so a scraper must read the body.
The `read_only` bucket allows `max(QNET_API_RATE_LIMIT × 3, 300)` requests per 60 s and blocks for 30 s once exceeded,
while `127.0.0.1`, `::1` and anything in `QNET_WHITELIST_IPS` bypass rate limiting — scraping over loopback is the
reliable option. **The client IP comes from the raw socket**, so behind a reverse proxy every request is attributed to
the proxy address.

## Reading the consensus-position diagnostic

`GET /api/v1/debug/consensus-position` is the node's own answer to "am I keeping up with finality":

| Field | Meaning |
|---|---|
| `height`, `tip_hash` | local chain tip |
| `own_window` | `height / 90` — the macroblock window this node believes it is in |
| `last_sealed_mb_index` | index of the newest macroblock this node holds sealed |
| `sealed_lag_windows` | `own_window − last_sealed_mb_index`; the headline finality-lag number |
| `finalized_height` | last finalized height |
| `tc_window_floor` | observed timeout-certificate window floor |
| `floor_above_window` | true when the observed floor is ahead of this node's own window |
| `certified_round_current_window` | highest certified round seen for the current window |

A healthy node holds `sealed_lag_windows` small and stable; a steadily rising value means blocks are still being
produced while finality is not advancing. Cross-check `current_timeout_round` on `/api/v1/node/health`, where a
non-zero value means producer failover is in progress. `floor_above_window` true on one node while its peers disagree
means that node is behind the fleet, not that the fleet is stalled — compare across at least three operators before
concluding. Production is bounded while finality is stuck: a node parks once its next block would exceed its seal
base — the greater of the last sealed macroblock's height and the QC-verified frontier — by
`MAX_DERIVED_ROSTER_WINDOWS × MACROBLOCK_INTERVAL = 32 × 90 = 2880` blocks, logging the throttle reason
`roster_derivation_horizon`. See [consensus.md](../architecture/consensus.md) for the machinery behind these fields.

## Logging

The node writes everything to stdout and stderr. Capture output through the container runtime (`docker logs`) or your
supervisor. Lines are structured as `[LEVEL][MODULE] message key=value key2=value2`, for example
`[INFO][BLOCK] produced height=1234 txs=50`.

`RUST_LOG` initialises `env_logger` at startup and is set to `"info"` when unset; it governs output emitted through the
`log` crate. The node's own `[LEVEL][MODULE]` lines are gated by an in-process level that runs at INFO on the scale
0=OFF, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=TRACE. Plan on INFO verbosity. High-frequency events are sampled by height
rather than printed per block: the common helper logs every 100th block, a second helper every 10th, with heights 0-5
always logged; both fall back to logging every block once the level is raised to DEBUG and TRACE respectively.

Lines worth alerting on directly:

| Line | Meaning |
|---|---|
| `[FATAL][RESTART] malformed_manifest` | the release's restart manifest failed its well-formedness check; the node refuses to start |
| `[CRIT][NODE] identity_anchor_mismatch` | the derived identity key does not match this node's chain anchor; startup is aborted |
| `[FATAL][GEN] WS restart pin active … refusing to mint` | a restart pin is set but the local chain is empty; the node halts rather than minting a fresh genesis |
| `[CRIT][MEMORY] … OOM_IMMINENT graceful_shutdown` | memory ceiling hit; the node flushes and exits 137 for the supervisor to restart |
| `[CRIT][STORAGE] … state=critically_full action=admin_required` | the internal storage budget is at or above 95 % |
| `[WARN][MONITOR] no_peers_connected` | emitted by the 30-second monitor loop |
| `[INFO][HALT] Reached halt_height=…` | coordinated-upgrade stop reached |
| `[CRIT][STATE] escalate=halt_signal` then `[CRIT][NODE] halt_requested` | the error ladder reached its terminal stage; the node exits 1 for the orchestrator to restart |
| `[CRIT][FAILOVER] … action=self_restart` | the stuck-height watchdog is spending one of its three restart attempts |
| `[CRIT][FAILOVER] … action=stay_up_degraded reason=restart_budget_exhausted` | the restart budget is spent; the node stays up and keeps syncing, and the cause is structural |
| `[CRIT][WATCHDOG] chain_stuck …` | the chain-stuck watchdog fired; alert only, the process keeps running |
| `[INFO][ARCHIVE] compliance_check_start` / `compliance_stats` | the four-hourly archive-replication report; informational, actual retention is governed by the pruning rules below |

Three of these describe how a node handles its own failure. The **error ladder** counts consecutive
transitions into a recoverable error state and resets on any other transition: at 10 cycles it requests a
background resync, at 30 it drops and rediscovers peers, and at 120 (about two minutes) it sets a halt flag
that the production loop consumes at the top of its next tick with `exit(1)`, before doing any work. Every
stage is signal-based; none touches consensus state, which is why nodes hitting the ladder at different
moments still derive the same producer. The **stuck-height self-restart** fires when a node has been unable
to obtain a block for more than 600 seconds while the network holds it: the attempt counter is persisted in
the data directory, so the loop cannot reset its own budget by restarting, and past `MAX_STUCK_SELF_RESTARTS
= 3` the node stays up rather than wiping the RAM consensus state that recovery needs to accumulate. The
**chain-stuck watchdog** deliberately never kills the process: it ticks every 60 s, treats fewer than one
block in 300 s as stuck but only while the network is at least 30 blocks ahead, and throttles itself to one
alert per stuck window. An operator decision, not a restart, is the intended response.

## Disk growth and pruning

A Super node is archival by design: it keeps macroblocks, block hashes, snapshots and full account state for the whole
chain, while Light nodes store no chain data at all. Storage is RocksDB across 30 column families with `use_fsync`
enabled, WAL capped at 64 MB, RocksDB's own LOG files bounded to 64 MB × 10, one shared 512 MB LRU block cache, and
Lz4 compression at most levels with Zstd at the bottommost level and for cold families. The node prunes on two
independent schedules and never deletes chain history to free space:

- **Hourly maintenance pass** (`PRUNE_RUNS_PER_HOUR = 1`): ping history and attestations by timestamp; consensus
  rounds down to the last 1000; failover events on a 24-hour cutoff; snapshots down to the newest
  `SNAPSHOT_KEEP_COUNT = 3`; and transactions, `tx_index` and `tx_by_address` below
  `current_height − TX_INDEX_RETENTION_BLOCKS (100,000)`. Each index sweep resumes from a persisted cursor under a
  per-run row budget, so retention catches up across runs rather than in one pass. Compaction afterwards is selective:
  only column families that shed at least `COMPACT_MIN_ROWS = 1000` rows are compacted. Independently of this pass,
  every failover-event write trims the family to the newest 10,000 rows.
- **Microblock-body prune** at every 14,400-block boundary, on the apply path of *every* Super node, not only the
  producer. Bodies older than `MICROBLOCK_BODY_RETENTION_BLOCKS = 6 × 14,400 = 86,400` blocks are deleted along with
  their ancestry rows and per-block WASM log rows; macroblock objects, the height→hash aliases, snapshots and account
  state are kept, and block 0 is never pruned. Each run is bounded by a `body_prune_watermark` and is idempotent, so a
  single applied boundary reclaims the whole window. A compile-time assertion guarantees this retention window always
  exceeds both the snapshot-switch gap and the retained-snapshot span, so a cold or lagging node can never need a body
  that has been pruned.

Expect this in API answers: `/api/v1/logs`, `/api/v1/logs/proof` and the token-transfer feeds return
`oldest_available`, `pruned_below` or `window_pruned`, so an empty result below the prune floor is distinguishable
from "no events". Registry and total-supply seals are pruned one 14,400-block window below the head
(`REGISTRY_SEAL_RETENTION = 14400`). On a miss, a `registry_root` seal is recomputed from scratch, while the
checkpoint reader defers on a missing total-supply seal.

The node's own storage monitor runs hourly and needs care. It measures the directory named by `QNET_DATA_DIR`
(`./node_data` when unset, which may not be the directory the node chose at boot) against `QNET_MAX_STORAGE_GB`,
default 2000 GB for a Super node. That is a configured budget, not the filesystem's free space, and the 70 %, 85 % and
95 % thresholds are percentages of it. All three cleanup tiers clear caches and the transaction pool and force
compaction; chain data is kept. So: set `QNET_DATA_DIR` explicitly, set `QNET_MAX_STORAGE_GB` near the real volume
size, and monitor actual free space externally with `df` regardless.

Memory is sampled every 300 seconds, logging RSS, virtual size, the delta since the last sample and the sizes of the
major in-process structures. The limit is derived automatically — the cgroup memory limit at 85 % if visible,
otherwise 70 % of `MemAvailable` with a 2000 MB floor and a ceiling of 80 % of total RAM — and the thresholds are fixed
fractions of it: 60 % warn, 75 % emergency (clears both sync queues and the producer cache, forces a transaction-pool
cleanup, flushes RocksDB), 90 % fatal (final flush, then `exit(137)`). A Super node below 4 GB of RAM logs
`[CRIT][MEMORY] INSUFFICIENT_RAM` at startup.

## Backup and restore

**The identity secret is the BIP39 mnemonic, and nothing else.** The node's ML-DSA-65 keypair is derived
deterministically from the mnemonic at every boot. Back the mnemonic up offline. Supply it through
`QNET_WALLET_SEED_FILE` (a file readable only by the node, mode 0600) rather than `QNET_WALLET_SEED`: a value passed as
a container environment variable is readable through `docker inspect`, through `/proc/<pid>/environ` and by most
log-shipping agents, and the node emits a one-time `[WARN][SECURITY] wallet_seed_from_env` when you do it that way. A
malformed mnemonic fails the structural check and refuses boot rather than deriving a valid-but-wrong identity.

A Super node also needs its activation code (`QNET_ACTIVATION_CODE`), plus the burn transaction hash and amount on
first activation. The code is persisted encrypted with AES-256-GCM under a key derived from the code itself, which is
never stored, so the on-disk copy is worthless without the code — keep code and mnemonic together. See
[node-activation.md](../economics/node-activation.md). If a node's derived public key does not match its chain anchor,
startup aborts with `[CRIT][NODE] identity_anchor_mismatch` and a hash of both keys for comparison; the remedy is to
restore the correct mnemonic.

For chain data:

```bash
docker stop qnet-node        # SIGTERM; the node flushes RocksDB and persists certificates
tar -C /path/to/datadir -czf qnet-data-$(date +%F).tar.gz .
docker start qnet-node
```

Stop the node first. `docker stop` sends SIGTERM, which the node handles by running `storage.flush_all()` (WAL to SST)
and persisting certificate state before exiting; a hot copy of a live RocksDB directory is not a consistent backup.
Restoring is the reverse: stop, replace the directory contents, start. For most incidents a chain-data backup is an
optimisation, not a requirement — a wiped node re-joins from peers, snapshot-jumping when it is more than
`SNAPSHOT_SYNC_SWITCH_GAP = 1500` blocks behind and block-replaying the tail. The one case where it is not optional is
a coordinated restart: at least one node must retain state at or below the chosen resume point. A controlled remote
stop is available at `POST /api/v1/shutdown`, which requires an internal caller IP, a configured `QNET_ADMIN_SECRET`
and a matching `admin_secret` in the body; it flushes and exits 0.

## Upgrading a node

**Rolling upgrade (no consensus-visible change).** Stop the node, replace the image or binary, start it again with
`QNET_HALT_HEIGHT` unset. It catches up on its own, snapshot-jumping if it fell far enough behind. Do one node at a
time and wait until it reports `healthy` on `/api/v1/node/health` with `blocks_behind` at zero on
`/api/v1/sync/status` before touching the next. Track `validated_peers` while you work: taking down more of the
committee than the fault bound tolerates turns a maintenance window into a liveness incident.

**Gated rule change (rolling).** A consensus rule that ships behind a feature gate rolls like an ordinary upgrade.
The release carries the rule dormant with an activation height compiled into the binary, every node flips it at that
height, and the operator's whole job is to have the new binary deployed fleet-wide before the height arrives — so
treat the activation height as the deadline for the rolling pass above. The current gates and their heights are in
[consensus.md](../architecture/consensus.md#consensus-feature-gates); a release note that names one is telling you
when the deployment must be finished.

**Protocol-breaking upgrade.** A change that alters what any node considers valid and is not carried by a gate cannot
be rolled. Use the halt-height mechanism: set the *same* `QNET_HALT_HEIGHT` on every node. The 30-second monitor loop compares the
current height against it, and at or above that height the node flushes storage and exits 0, logging
`[INFO][HALT] Reached halt_height=…`. Operators then swap binaries and restart with the variable removed. Publish the
halt height, the release commit and the restart wall-clock time ahead of time.

**Un-barring identities from a restart manifest is also a coordinated cut-over, never a rolling change.** The
exclusion list filters the derived producer and committee set, which feeds `consensus_committee` and from there the
QC-bound `epoch_commitment`. If some nodes un-bar a still-heartbeating identity before others, the two groups derive
different committees for the crossover windows and disagree on those checkpoints until the fleet converges. Publish a
wall-clock cut-over, and prefer un-barring only identities already heartbeat-absent, where the removal is a no-op.

## Coordinated restart

This is the recovery procedure for a halted or forged chain: the fleet agrees on the newest macroblock everyone holds,
pins it in a new release, and resumes production from it. **Rehearse it on a test network before you need it** — an
unrehearsed runbook is not a recovery plan.

### When to restart

Restart only when **both** of these hold. Anything less is a bug to fix, not an incident:

1. Finality has not advanced for more than two hours. Production stops on its own once the
   `roster_derivation_horizon` (2880 blocks past the last seal) is reached.
2. There is no software fix that restores liveness without abandoning chain data.

For a **forged finality** incident — a committee majority certified a bad `state_root` — the trigger is different:
restart as soon as it is confirmed, and pick `K` strictly below the first bad macroblock.

### Procedure

1. **Freeze and gather.** Stop producing. From every reachable operator collect the last macroblock index held and its
   `MacroBlock::hash()`, and the `consensus_committee` of the last sealed macroblock.
2. **Choose `K`** — the newest macroblock that is full-quorum sealed *and* that every surviving operator agrees on by
   hash; never one that only some nodes hold. Record `hash(MB_K)` and the committee-fields digests for `K` and `K-1`;
   the release needs all four values.
3. **Build the exclusion list** — the identities that were in the committee at the stall and did not vote. Assemble it
   off-chain from operator logs and publish it with the evidence so anyone can disagree before the release ships. List
   only identities multiple independent operators observed as silent, prefer under-listing (a restart that leaves a few
   passive identities in still recovers if the survivors clear quorum), and keep the list sorted and deduplicated — the
   build check fails otherwise.
4. **Cut the release.** In `development/qnet-integration/src/genesis_constants.rs` set together
   `WS_CHECKPOINT = (K, hash_of_MB_K)`, `WS_CHECKPOINT_DIGEST_ANCHOR`, `WS_CHECKPOINT_DIGEST_PRED`, and
   `RESTART_MANIFEST { resume_from_mb: K, resume_mb_hash: hash_of_MB_K, excluded: &[…] }`.
   `restart_manifest_is_wellformed()` runs before storage opens and refuses to start the node if the manifest disagrees
   with the pin index or hash, if either digest is zero, or if the list is unsorted or contains duplicates — a
   malformed manifest is a broken release, not a runtime condition.
5. **Publish before executing, and confirm a retained-state source.** Post in one place: `K`, `hash(MB_K)`, both
   digests, the exclusion list with per-entry evidence, the release commit hash and build instructions, and the
   wall-clock start time — a restart without a published record is indistinguishable from an attack on the chain.
   **Mandatory precondition:** at least one reachable node must retain chain state at or below `K` and serve its
   snapshot, because balances at `K > 0` survive only as retained chain data. Designate that archival node and confirm
   it answers a `K`-height snapshot request *before* anyone wipes. If none retains state at or below `K`, the ledger is
   unrecoverable; do not proceed.
6. **Execute.** Every operator, genesis included, stops their node and wipes chain data **above `K` only**. Do not wipe
   a data directory entirely unless the archival node is confirmed serving state at or below `K`: a full wipe everywhere
   destroys the ledger, and the boot guard halts an empty node under the pin rather than minting a fresh genesis. A node
   that keeps stale data above `K` fails closed on the pin path (`v2_ws_pin_mismatch`, `v2_below_ws`) rather than
   forking. Then run the new release — archival node and genesis nodes first, then the rest.
7. **Verify recovery.** Blocks are produced *and* finality advances (`last_sealed_mb_index` rises on several nodes);
   the `eligible_producers` of the first newly sealed macroblock contains none of the barred identities; no node logs
   `[FATAL][RESTART] malformed_manifest`; the tip hash matches across at least three operators.
8. **Retire the manifest.** Once the chain has been stable for a full epoch, the next release keeps the bumped
   `WS_CHECKPOINT` and clears `RESTART_MANIFEST` back to an empty exclusion list only if the barred identities should be allowed to
   re-register. Leaving them barred is a policy choice — state it publicly either way, and follow the coordinated
   cut-over rule above.

### Rehearsal checklist

Run the whole thing on a test network, timed, before you need it in production:

- [ ] Halt a test network deliberately by stopping more than one third of the committee.
- [ ] Confirm production stops at the expected horizon (2880 blocks past the last seal).
- [ ] Choose `K` and verify the hash agrees across operators.
- [ ] Cut a release with a non-empty exclusion list.
- [ ] Confirm a node with stale data above `K` fails closed instead of forking.
- [ ] Confirm a malformed manifest refuses to start.
- [ ] Measure the wall-clock time from decision to restored finality, and publish it.

## Common failure states

**Node stuck syncing.** Check `blocks_behind` on `/api/v1/sync/status` and whether it is falling. If flat, check
`/api/v1/peers` and `/api/v1/node/health`: `isolated` means zero peers (firewall or discovery — see
[networking.md](../architecture/networking.md) and the port table in [configuration.md](configuration.md));
`degraded` means fewer than four validated peers, enough to sync but not to participate safely. A node more than 1500
blocks behind should snapshot-jump rather than block-replay; if it does not, check that a peer actually serves one
(`GET /api/v1/snapshot/latest` against that peer) — snapshot serving is capped at 16 concurrent transfers node-wide
and answers `snapshot serve busy` beyond that, so a fleet-wide restart can starve joiners temporarily. Restarting the
stuck node is safe and is the usual first move; it resumes from its persisted height.

**Node isolated after moving to a new address.** Peers bind a registered identity to the IP of the endpoint it
committed on chain, and inbound connections arriving from anywhere else are refused before any signature work. Confirm
`QNET_PUBLIC_IP` on the new host names the new public address, then reactivate
(`POST /api/v1/node-reactivation/submit`) — applying that transaction refreshes the committed endpoint, and peers pick
up the new binding as the block applies. Each peer keeps the map on disk and rebuilds it at boot, so a peer that
restarts before the reactivation lands still holds the old address until it does. See
[running-a-node.md](running-a-node.md).

**Node not producing.** Confirm it should be: `GET /api/v1/producer/status` reports `is_producer` for the *next* block
and names `current_producer`. Eligibility comes from the `eligible_producers` snapshot of an earlier macroblock, so a
freshly registered Super is ineligible until `ACTIVATION_WARMUP_BLOCKS = 180` blocks have passed, and reputation must
be at or above the consensus minimum of 70 (`/api/v1/reputation/history`). If the node is elected but no blocks
appear, look at `current_timeout_round` and `failover_count` on `/api/v1/node/health` — the network is rotating away
from it — and at `clock_drift_ema_secs` and `timestamp_rejections`. If `sealed_lag_windows` is climbing past the
horizon the node has parked on `roster_derivation_horizon`, and the problem is network-wide finality, not this node.

**Storage full.** Distinguish the two meanings. If the *filesystem* is full the node cannot flush and should be stopped
before it is starved; free space outside the data directory, then restart. If the node logs `storage_warn_85pct_full`
or `critically_full`, that is the internal budget against `QNET_MAX_STORAGE_GB`, whose cleanups touch caches only. The
real levers: confirm the body prune is running (`[INFO][PIPELINE] microblock_bodies_pruned` appears at 14,400-block
boundaries — a node that has not crossed one since starting has not pruned yet), confirm `QNET_DATA_DIR` points at the
directory the node really uses, then provision more disk. Never hand-delete files from the RocksDB directory.

**Reward-epoch commitment deferring.** The checkpoint's `reward_epoch_root` folds every certified epoch
root up to the N-2 macroblock, resuming from a persisted prefix, and defers rather than seal a shorter
set. Two log lines name what it is waiting on. `[WARN][REWARDS] epoch_root_gap … action=defer+repair`
means the macroblock is simply absent and the node has already fired a targeted repair fetch — it
resolves itself; watch that the named `missing_mb` stops recurring. `[ERR][REWARDS]
epoch_root_mb_no_usable_qc … action=operator_resync` means the macroblock is on this node's disk but
unreadable, and it needs you: the object is QC-certified and sits below the weak-subjectivity floor,
so the node keeps it rather than deleting it, and forward sync never revisits that height. Resync this
node from a snapshot; do not hand-delete anything from the RocksDB directory. A third line,
`epoch_root_target_unknown … action=defer_no_repair`, means a storage read itself failed — treat it as
a disk fault on this node.

**Node refuses to start.** Read the first fatal line. `malformed_manifest` is a bad release — rebuild it, do not work
around it. `identity_anchor_mismatch` is a wrong or lost mnemonic — restore the correct one, never "fix" it by editing
the anchor. `WS restart pin active … refusing to mint` means the node has a restart pin but no local chain and must
cold-join from the resume macroblock rather than mint a fresh genesis. A repeated exit 137 is the memory ceiling, not a
crash: give the container more memory or reduce what else runs on the host.

Choosing `K`, deciding who goes on the exclusion list, and judging whether a stall is a bug or an incident are operator
decisions taken off-chain. Say so to the other operators and publish the evidence: getting them wrong bars an honest
operator or abandons real state.
