# Running a node

This document covers installing, starting, verifying, migrating and removing a QNet **Super node** on a Linux server. Super nodes are the node role that runs on server hardware: they store the chain, serve the HTTP API and participate in consensus. Light nodes run in the mobile app — see [mobile wallet](../applications/mobile-wallet.md). Everything below is Docker-based; the node binary runs inside a container. For the full variable reference see [configuration](configuration.md); for day-2 operations see [maintenance](maintenance.md).

## Node roles on a server

| Role | Where it runs | How it is activated | Consensus | HTTP API |
|------|---------------|---------------------|-----------|----------|
| Super | Linux server / VPS, in Docker | Activation code + 1DEV burn data + wallet mnemonic | Yes | Yes |
| Genesis (bootstrap) | Reserved for the five pinned genesis identities | `QNET_BOOTSTRAP_ID` = `001`..`005` | Yes | Yes |
| Light | Mobile app only | In-app, from the wallet | No | No |

The protocol has two node types, `Light` and `Super`. The server binary accepts a Super activation code; a Light code presented to it terminates the process.

## Prerequisites

### Hardware

| Resource | Requirement | Enforcement |
|----------|-------------|-------------|
| RAM | 4 GB minimum | Checked at startup (`MIN_RAM_SERVER_MB = 4000`); below this the node refuses to start |
| CPU | x86-64 | The production image is built with `RUSTFLAGS="-C target-cpu=x86-64"` |
| Disk | Sized for full history | Super nodes are archival by default; the storage cap defaults to 2000 GB and is tunable with `QNET_MAX_STORAGE_GB`. Chain history dominates; snapshots add less than the cadence suggests, because above 50 active nodes a deterministic one-in-five rotating sample materialises each one |
| Clock | NTP-synchronised | Block timestamps are slot-anchored; the node checks system time at startup and aborts on an implausible clock |

### Operating system and software

- A 64-bit Linux host. The production image is based on Ubuntu 22.04 (glibc 2.35).
- Docker Engine (a recent release with `docker compose` if you intend to use the bundled multi-node stack).
- A synchronised system clock (`chrony` or `systemd-timesyncd`). Clock drift is reported by the node and surfaced in the health endpoint as `clock_drift_ema_secs`.

```bash
# Docker (Debian/Ubuntu, using the convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker

# Time synchronisation
sudo apt-get install -y chrony
sudo systemctl enable --now chrony
timedatectl show | grep NTPSynchronized
```

## Obtaining the code

```bash
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet
```

## Building the image

The production Dockerfile is a two-stage build: it installs a pinned Rust toolchain (1.93.0), builds the `qnet-node` binary with the `release-fast` profile, then copies the stripped binary into a minimal Ubuntu 22.04 runtime image. Build from the repository root — the Dockerfile expects the whole workspace as its context.

```bash
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

To rebuild from a clean state after pulling changes:

```bash
docker system prune -f
docker build --no-cache -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

The image entrypoint runs as root only long enough to fix data-directory ownership, remove a stale RocksDB `LOCK` file left by an unclean shutdown, and check RocksDB integrity; it then drops to the unprivileged `qnet` user via `gosu`. The integrity check wipes the data directory only when database files exist but `MANIFEST-*` / `CURRENT` are missing — a healthy store is never touched.

## Firewall and ports (do this before the first start)

The node runs a mandatory pre-flight check at startup. If a required port cannot be bound locally, or if the QUIC UDP port is not reachable, the process exits with a fatal error. Open the ports first.

| Port | Protocol | Purpose | Notes |
|------|----------|---------|-------|
| 8001 | TCP | HTTP REST API, JSON-RPC and WebSocket | Single unified server; default of `QNET_API_PORT` |
| 9876 | TCP | P2P port (`QNET_P2P_PORT`) | Checked for availability at startup |
| 9877 | TCP | Second P2P port checked by pre-flight | Checked for availability at startup |
| 10876 | UDP | QUIC transport | The peer-to-peer transport; **must** be reachable from outside or the node cannot receive blocks |
| 8101 | TCP | `QNET_API_PORT` + 100 | Bound inside the container, not published by the `docker run` command below; no firewall rule needed |

QUIC is the peer-to-peer transport. A blocked UDP 10876 produces a node that answers HTTP but never syncs.

```bash
# UFW
sudo ufw allow 9876,9877,8001/tcp
sudo ufw allow 10876/udp
sudo ufw reload

# iptables
sudo iptables -A INPUT -p tcp --dport 8001 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 9876 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 9877 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 10876 -j ACCEPT
```

If the host is behind NAT, forward the same ports and set `QNET_EXTERNAL_IP` to the public address; automatic external-IP discovery honours that variable first, then `DOCKER_HOST_IP`, then STUN.

## Activation code and burn data

A Super node needs proof that a node licence was purchased. In Phase 1 that proof is a 1DEV burn on Solana; the wallet turns it into an **activation code** — a 25-character string of the form `QNET-XXXXXX-XXXXXX-XXXXXX`. The code carries a 5-byte prefix of the wallet address, XOR-encrypted under a key derived from `SHA3-256("{burn_tx}:{node_type}:{burn_amount}")`. Given the burn transaction and the burned amount, that prefix can be checked against a wallet with no node state; the full wallet address is resolved from the on-chain activation record. See [node activation](../economics/node-activation.md).

Obtain the code, the Solana burn transaction signature and the exact burned amount from the mobile app (Settings, export activation data). Supply them to the container as environment variables:

| Variable | Value |
|----------|-------|
| `QNET_ACTIVATION_CODE` | The 25-character `QNET-...` code |
| `QNET_BURN_TX_HASH` | The Solana burn transaction signature |
| `QNET_BURN_AMOUNT` | The exact whole-token amount burned |
| `QNET_WALLET_SEED_FILE` | Path to a file containing the BIP39 mnemonic (preferred) |
| `QNET_WALLET_SEED` | The mnemonic inline (discouraged — see below) |

The mnemonic must be the **same wallet** that performed the burn: the server derives the Solana address from it and checks it against the address encrypted in the code. It also derives the node's ML-DSA-65 consensus keypair deterministically from the mnemonic, so the mnemonic alone reconstitutes the node identity.

Passing the mnemonic with `-e` makes it readable through `docker inspect` and `/proc/<pid>/environ`; the node logs a warning when it reads a seed from the environment. Mount a file instead:

```bash
printf %s "your mnemonic words here" > ./qnet_seed
chmod 600 ./qnet_seed
```

Never commit an activation code, burn hash or mnemonic to a repository, a shared config file or a support ticket.

## Running a Super node

```bash
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="<solana_burn_tx_signature>" \
  -e QNET_BURN_AMOUNT="<amount_burned>" \
  -v $(pwd)/qnet_seed:/run/secrets/qnet_seed:ro \
  -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed \
  -e QNET_MAX_STORAGE_GB=2000 \
  -p 8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876/udp \
  -v $(pwd)/qnet_data:/app/data \
  qnet-production
```

Notes on the command:

- `--name` is a local Docker label only. The network identity is derived from your wallet: the node id is a pseudonym of the form `super_node_<hash>`, and you do not set it.
- `QNET_PRODUCTION=1` enables blockchain uniqueness checking and on-chain burn verification of the activation code. `DOCKER_ENV=1` satisfies the container guard and pins the P2P port to the mapped value.
- The data volume must be mounted at `/app/data` — that is where RocksDB writes.
- Log rotation is worth setting explicitly; the node is verbose at the default log level.

If none of `QNET_BOOTSTRAP_ID`, `QNET_ACTIVATION_CODE` or a previously saved activation in RocksDB is present, the node prints the required-variable list and exits.

### Genesis bootstrap nodes

The five genesis identities start with `QNET_BOOTSTRAP_ID` set to `001`–`005` and a wallet seed, with no activation code or burn data; burn verification is skipped for them. The five ids and the genesis IP list are pinned in the binary. Genesis mode is also entered by setting `QNET_GENESIS_BOOTSTRAP=1` or by a source-IP match against the pinned genesis list. Do not set these variables on an ordinary Super node.

Before a fresh launch, prove the five seeds against the identities compiled into the binary. `verify_genesis_identity_linkage` derives both the consensus public key and the wallet eon address from each mnemonic and asserts each equals its committed constant, so the operator who imports seed *i* holds exactly the wallet the node credits its rewards to. Supply the mnemonics as files, one per identity, mode `0600`:

```bash
QNET_GEN_SEED_001_FILE=/run/secrets/gen001 \
QNET_GEN_SEED_002_FILE=/run/secrets/gen002 \
QNET_GEN_SEED_003_FILE=/run/secrets/gen003 \
QNET_GEN_SEED_004_FILE=/run/secrets/gen004 \
QNET_GEN_SEED_005_FILE=/run/secrets/gen005 \
cargo test -p qnet-integration --lib verify_genesis_identity_linkage -- --nocapture
```

The test logs `identity_linkage_skipped` when no seed is supplied, and fails when only some are, so a partial set cannot pass for a full one. Startup enforces both halves as well: a consensus-key mismatch halts with `[CRIT][NODE] identity_anchor_mismatch`, and a seed that derives a wallet other than the one the chain credits halts with `[CRIT][NODE] genesis_wallet_anchor_mismatch`.

### Light nodes

Light nodes run inside the mobile app and register through the wallet. They keep no chain data and hold no consensus key.

## First-run expectations

A first start proceeds in this order, and each stage is logged:

1. **Guards.** Restart-manifest sanity check, container check, NTP synchronisation attempt, and a system-clock plausibility check that aborts on an implausible timestamp.
2. **Auto-configuration.** Port selection and bind probing, data-directory selection.
3. **Activation.** The activation source is resolved (genesis id, environment code, or a saved record), then the code is format-checked, phase- and price-checked, checked for prior use on chain, and the Solana 1DEV burn is verified. A failure at this stage is fatal.
4. **Pre-flight.** Local port availability, external IP detection, external reachability of the required ports, QUIC readiness, NTP status. A critical failure exits the process.
5. **Node start.** Memory check, storage open, P2P and API servers.
6. **Sync.** The node joins the network over QUIC and catches up. A node far behind the tip jumps to a verified state snapshot and then replays the tail; a node close to the tip replays blocks directly.
7. **Registration.** A boot-spawned convergence driver collects committee burn attestations and submits the on-chain `NodeRegistration`.
8. **Warmup.** A registered Super node becomes producer-eligible only after `ACTIVATION_WARMUP_BLOCKS = 180` blocks (two macroblock epochs) have been buried above its registration height. Expect to be a non-producing participant for that period.

Let the first sync finish rather than cycling the container: every restart re-runs the whole sequence above, including pre-flight and activation verification.

## Verifying the node is healthy

All of these are served on the API port.

```bash
# Liveness (lock-free, one atomic read — this is what a container health check should use)
curl -s http://localhost:8001/healthz            # -> "ok h=<height>"
curl -s http://localhost:8001/health             # -> "OK"

# Rich health: height vs network height, sync status, peer counts, clock drift, failover state
curl -s http://localhost:8001/api/v1/node/health

# Chain height only
curl -s http://localhost:8001/api/v1/height

# Peers and per-type counts
curl -s http://localhost:8001/api/v1/peers

# Detailed sync status
curl -s http://localhost:8001/api/v1/sync/status

# Whether this node is currently a producer
curl -s http://localhost:8001/api/v1/producer/status

# Your node's registration/activation state (also accepts wallet= or activation_code=)
curl -s "http://localhost:8001/api/v1/node/status?node_id=<your_node_id>"
```

What to look for:

- `/healthz` returns a height that increases.
- In `/api/v1/node/health`: `sync_status` reaches a synced state, `height` tracks `network_height`, `peers` and `validated_peers` are non-zero, `clock_drift_ema_secs` stays near zero, and `current_timeout_round` is 0 in steady state (a persistently non-zero value means the network is in failover).
- `/api/v1/peers` shows peers other than the bootstrap set.

### Boot contract

Every long-lived subsystem the node depends on signs in when its task spawns, and two minutes after
bring-up the node checks the register. A gap is fatal: the process prints
`[FATAL][BOOT] subsystems_missing` and exits, so a half-started node leaves the validator set
instead of running degraded. A healthy boot prints one line per subsystem and then the summary:

```bash
docker logs <container> | grep '\[BOOT\]'
```

Expected: twelve `subsystem_started` lines followed by `contract_satisfied`. The subsystems are
`signed_head_emitter`, `peer_cleanup`, `background_repair`, `background_height_sync`,
`reputation_validation`, `regional_clustering`, `tx_cache_cleanup`, `rate_limiter_cleanup`,
`static_cache_cleanup`, `quic_idle_reaper`, `external_ip_resolver` and
`device_migration_monitor`.

### Chain-halt alert

`[CRIT][WATCHDOG] chain_halted` means the best height known to this node has not moved for five
minutes. Unlike the behind-the-network alert it fires when the whole network is stopped, which is
the case a per-node lag check cannot see. Restarting a single node does not clear it — investigate
before acting.

When scripting against the API, read the JSON body rather than the status code: REST handlers return HTTP 200 and carry the outcome in the body, including rate-limit rejections (`{"success": false, "error": "Rate limit exceeded", ...}`). Full reference: [RPC API](../developers/rpc-api.md).

## Managing the container

```bash
# Is it running?
docker ps --filter name=qnet-super

# Follow logs
docker logs -f qnet-super
docker logs qnet-super --tail 200
docker logs qnet-super | grep -E "\[ERR\]|\[FATAL\]|\[CRIT\]"
docker logs qnet-super | grep -E "CONSENSUS|SYNC|P2P|PREFLIGHT"

# Resource usage
docker stats qnet-super --no-stream

# Graceful stop — the node handles SIGTERM, flushes storage and persists certificates.
# Give it time; the bundled compose stack allows 60 seconds.
docker stop -t 60 qnet-super

# Restart
docker restart qnet-super

# Remove the container but keep the data volume
docker rm qnet-super
```

Upgrading is a rebuild plus a container replacement with the same volume and the same environment; see [maintenance](maintenance.md) for the coordinated-stop variable `QNET_HALT_HEIGHT` and the rest of the upgrade procedure.

### Bundled multi-node stack

`docker-compose.production.yml` at the repository root brings up a local multi-node testnet (one genesis plus two peers), an nginx TLS terminator and a Prometheus/Grafana pair. It is a development and integration-testing stack, not the way to run a single production Super node. Before using it: it requires `QNET_ADMIN_SECRET` to be present in a `.env` file, it ships a placeholder Grafana admin password that must be replaced, and it expects TLS material under `infrastructure/nginx/ssl` that you supply.

## Migrating a node to a new server

The consensus keypair is derived deterministically from the mnemonic, so migration does not require copying key files — the same mnemonic plus the same activation data reproduces the same identity. Chain data can be re-synced from the network, so the data volume does not have to be moved either (copying it only saves sync time).

Migration is coordinated on-chain by a device identifier:

1. On the **new** server, complete the prerequisites and firewall setup, then start the container with the **same** `QNET_ACTIVATION_CODE`, `QNET_BURN_TX_HASH`, `QNET_BURN_AMOUNT` and mnemonic.
2. At activation the new node posts its device id to a genesis node (`POST /api/v1/register-device`).
3. The **old** node polls `GET /api/v1/node-device?node_id=<id>` roughly every 30 seconds. When it sees a different device id, it logs `device_changed ... action=shutdown`, stops its QUIC transport, clears its stored activation record and exits with status 0.
4. Remove the old container promptly. A clean `exit(0)` under `--restart=always` is still a restart from Docker's point of view, and the old host still has the activation code in its environment — leaving it in place makes the two servers take turns claiming the identity.

```bash
# On the OLD server, once the new one is up and registered
docker stop -t 60 qnet-super && docker rm qnet-super
```

If you prefer to move the chain data rather than re-sync, stop the old node first, copy the volume, and start the new one:

```bash
docker stop -t 60 qnet-super
sudo tar czf qnet-data-$(date +%Y%m%d).tar.gz -C $(pwd) qnet_data
# transfer the archive, extract it on the new host, then start the container there
```

Activation codes are bound to the wallet, not to hardware, and remain valid across servers.

### Publishing the new address

A node's peers reach it at the API endpoint committed on chain, and the QUIC identity gate requires a
registered identity's inbound connections to arrive from that committed address. Moving to a new IP
therefore means republishing it. Set `QNET_PUBLIC_IP` on the new server (or `EXTERNAL_IP`, then
`HOST_IP`, which the node falls back to) to the new public address, and the node announces
`http://<ip>:8001` in its reactivation. Applying that reactivation refreshes the committed endpoint,
and peers bind the identity to the new address from the next block on.

Reactivation is submitted with `POST /api/v1/node-reactivation/submit`, either from the node itself
or from an internal address; the request takes an optional `api_endpoint` and otherwise announces the
node's own configured one. The address is validated before it is signed: it must be `http(s)` and
must not name a loopback, RFC 1918 or link-local host. Under `QNET_HIDE_IP` the node announces no
endpoint and the committed value stays as it is — a hidden node keeps whatever address it last
published, so clear `QNET_HIDE_IP` for the reactivation that moves the address.

Each node keeps the id-to-endpoint map on disk next to its chain data and rebuilds it from those rows
at boot, so a restarted or freshly synced peer applies the address binding to its very first inbound
connection.

## Clean removal

```bash
# 1. Stop gracefully and remove the container
docker stop -t 60 qnet-super
docker rm qnet-super

# 2. Optional: back up the mnemonic file and data before deleting anything
tar czf ~/qnet-backup-$(date +%Y%m%d).tar.gz ./qnet_seed ./qnet_data

# 3. Delete the chain data
rm -rf ./qnet_data

# 4. Remove the image and reclaim Docker space
docker rmi qnet-production
docker system prune -f

# 5. Remove the source checkout
cd .. && rm -rf QNet-Blockchain
```

Removing a node locally does not remove it from the chain: on-chain registration rows are stamped once and are immutable. A node that stops running stops meeting the liveness conditions that make it reward-eligible — see [economics overview](../economics/overview.md).

## Related documents

- [Configuration](configuration.md) — every operator-facing environment variable, with defaults.
- [Maintenance](maintenance.md) — monitoring, upgrades, restarts and recovery.
- [Node activation](../economics/node-activation.md) — phases, pricing and the registration flow.
- [RPC API](../developers/rpc-api.md) — the complete endpoint reference.
- [Networking](../architecture/networking.md) — QUIC transport, discovery and message types.
