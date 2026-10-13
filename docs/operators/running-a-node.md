# Running a node

This document covers installing, starting, verifying, migrating and removing a QNet Blockchain **Super node** on a Linux server. Super nodes are the node role that runs on server hardware: they store the chain, serve the HTTP API and participate in consensus. Light nodes run in QNet Wallet on a phone or tablet, one device per node — see [mobile wallet](../applications/mobile-wallet.md). Everything below is Docker-based; the node binary runs inside a container. For the full variable reference see [configuration](configuration.md); for day-2 operations see [maintenance](maintenance.md).

## Node roles on a server

| Role | Where it runs | How it is activated | Consensus | HTTP API |
|------|---------------|---------------------|-----------|----------|
| Super | Linux server / VPS, in Docker | Activation code + 1DEV burn data + wallet mnemonic | Yes | Yes |
| Genesis (bootstrap) | Reserved for the five pinned genesis identities | `QNET_BOOTSTRAP_ID` = `001`..`005` | Yes | Yes |
| Light | QNet Wallet on a phone or tablet only, one device per node | Registered on aiqnet.io/node (the cabinet's one-time payment key burns and QNet Wallet signs the wallet's consent) or by the QNet Wallet browser extension | No | No |

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

The production Dockerfile is a two-stage build: it installs a pinned Rust toolchain (1.93.0), builds the `qnet-node` binary with the `release-fast` profile, then copies the binary into a minimal Ubuntu 22.04 runtime image. The profile strips debug info and keeps the symbol table, so a thread backtrace taken on the host names its functions. Build from the repository root — the Dockerfile expects the whole workspace as its context. The runtime stage takes a `QNET_BUILD_ID` build argument (default `unstamped`) and exports it into the image; the node reports it as `build=` on `/healthz` and as `build` in the `node_getInfo` JSON-RPC answer, so building with `--build-arg QNET_BUILD_ID=$(git rev-parse --short HEAD)` makes every image name its commit.

```bash
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

To rebuild from a clean state after pulling changes:

```bash
docker system prune -f
docker build --no-cache -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

`tini` runs as PID 1 and reaps orphaned child processes. Under it the entrypoint script runs as root only long enough to remove a stale RocksDB `LOCK` file left by an unclean shutdown, check RocksDB integrity and fix data-directory ownership; it then drops to the unprivileged `qnet` user via `gosu`. The integrity check wipes the data directory only when database files exist but `MANIFEST-*` / `CURRENT` are missing — a healthy store is never touched.

## Firewall and ports (do this before the first start)

The node runs a mandatory pre-flight check at startup. If a required port cannot be bound locally, or if the QUIC UDP port is not reachable, the process exits with a fatal error. Open the ports first.

| Port | Protocol | Purpose | Notes |
|------|----------|---------|-------|
| 8001 | TCP | HTTP REST API, JSON-RPC and WebSocket | Single unified server; default of `QNET_API_PORT` |
| 9876 | TCP | P2P port (`QNET_P2P_PORT`) | Checked for availability at startup |
| 9877 | TCP | Second P2P port checked by pre-flight | Checked for availability at startup |
| 10876 | UDP | QUIC transport | The peer-to-peer transport; **must** be reachable from outside or the node cannot receive blocks |
| 8101 | TCP | `QNET_API_PORT` + 100 | Bound inside the container, not published by the `docker run` command below; no firewall rule needed |
| 443 | TCP | Public RPC for wallets over HTTPS ([Public RPC](#public-rpc-port-443)) | Super nodes; host 443 is published to container port 8443. Optional: without it the node serves no wallet reads and nothing else changes |

QUIC is the peer-to-peer transport. A blocked UDP 10876 produces a node that answers HTTP but never syncs.

```bash
# UFW
sudo ufw allow 9876,9877,8001,443/tcp
sudo ufw allow 10876/udp
sudo ufw reload

# iptables
sudo iptables -A INPUT -p tcp --dport 8001 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 9876 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 9877 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 10876 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
```

If the host is behind NAT, forward the same ports and set `QNET_PUBLIC_IP` to the public IPv4 address: the node announces its endpoint from that variable (then `EXTERNAL_IP`, then `HOST_IP`). Without one, the public RPC learns the address from two genesis nodes that agree on it.

## Activation code and burn data

A Super node needs proof of activation. In Phase 1 that proof is a 1DEV burn on Solana, signed by the wallet in the QNet Wallet [browser extension](../applications/browser-wallet.md) (see [node activation](../economics/node-activation.md)): from its Activate tab (choose Super), or when the node cabinet at aiqnet.io/node asks it. The cabinet's one-time payment key burns for Light nodes only. The wallet derives an **activation code** from the burn — a 25-character string of the form `QNET-SXXXXX-XXXXXX-XXXXXX`, one code per wallet. The code carries a 5-byte prefix of the wallet address, XOR-encrypted under a key derived from `SHA3-256("{burn_tx}:{node_type}:{burn_amount}")`. Given the burn transaction and the burned amount, that prefix can be checked against a wallet with no node state; the full wallet address is resolved from the on-chain activation record. See [node activation](../economics/node-activation.md).

After a Super burn the aiqnet.io/node cabinet that asked shows the code, the Solana burn transaction signature and the exact burned amount next to the variable names below; the extension keeps the code alone, in its Settings, and its Activate tab shows one line to aiqnet.io/node ("Recover my code" in the extension finds the code again for the wallet's existing burn). The Overview of aiqnet.io/node shows them too, with the server's settings and a `docker run` command filled in, for the wallet in any browser where it is connected: the site keeps a verified record of the wallet's burn (see [node activation](../economics/node-activation.md#one-wallet-one-code)). One wallet has one code, for a Light or a Super node: a wallet that already burned for a Light node gets no Super code, and the other way round. From the network's one-node rule (gate `wallet_one_node`) the network itself refuses a second node of either type for one wallet, and a server whose wallet already has another node never registers: it refuses the activation at start ("This wallet already has a light node on QNet Blockchain (...)", naming the other node) or, when it only learns of the other node once it has caught up with the chain, logs `[ERR][REG] wallet_has_node` and stops its registration. Supply them to the container as environment variables:

| Variable | Value |
|----------|-------|
| `QNET_ACTIVATION_CODE` | The 25-character `QNET-...` code |
| `QNET_BURN_TX_HASH` | The Solana burn transaction signature |
| `QNET_BURN_AMOUNT` | The exact whole-token amount burned |
| `QNET_WALLET_SEED_FILE` | Path to a file containing the 12- or 24-word recovery phrase (mnemonic) (preferred) |
| `QNET_WALLET_SEED` | The mnemonic inline (discouraged — see below) |

The mnemonic must be the **same wallet** that performed the burn: the server derives the Solana address from it and checks it against the address encrypted in the code. It also derives the node's ML-DSA-65 consensus keypair deterministically from the mnemonic, so the mnemonic alone reconstitutes the node identity.

Write the mnemonic exactly in its canonical form: the 12 or 24 words in lowercase, on one line, separated by single spaces. The node derives the keys from the text as written (it only trims the ends) and does not check the words or their checksum, so capitals, a line break between words, a double space or a typo silently give another wallet, whose Solana address does not match the burn.

Passing the mnemonic with `-e` makes it readable through `docker inspect` and `/proc/<pid>/environ`; the node logs a warning when it reads a seed from the environment. Mount a file instead:

```bash
printf %s "your mnemonic words here" > ./qnet_seed
chmod 600 ./qnet_seed
```

The file stays readable by its owner only. The container starts as root and runs the node as its own `qnet` user, which cannot read a mounted file of another owner with mode `0600`: before it starts the node, the entrypoint copies the file named by `QNET_WALLET_SEED_FILE` (or `QNET_GENESIS_SEED_FILE`) to `/dev/shm` inside the container, in memory, owned by `qnet` with mode `0400`, and points the variable at the copy (`development/qnet-integration/Dockerfile.production`).

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
  -p 0.0.0.0:8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876/udp \
  -p 0.0.0.0:443:8443 \
  -v $(pwd)/qnet_data:/app/data \
  qnet-production
```

Notes on the command:

- `--name` is a local Docker label only. The network identity is derived from your wallet: the node id is a pseudonym of the form `super_node_<hash>`, and you do not set it.
- `QNET_PRODUCTION=1` enables blockchain uniqueness checking and on-chain burn verification of the activation code. `DOCKER_ENV=1` satisfies the container guard and pins the P2P port to the mapped value.
- The data volume must be mounted at `/app/data` — that is where RocksDB writes.
- Log rotation is worth setting explicitly; the node is verbose at the default log level.
- `-p 0.0.0.0:443:8443` publishes the [public RPC](#public-rpc-port-443) on IPv4 on every interface, so the node sees each wallet's own address. Leave it out to serve no wallet reads.
- `-p 0.0.0.0:8001:8001` publishes the API on IPv4 only. Published for IPv6 as well, an IPv6 client would reach it through the container runtime's own proxy, which hides the client's address, and the node would then take an `X-Forwarded-For` header that client wrote as its address.

If none of `QNET_BOOTSTRAP_ID`, `QNET_ACTIVATION_CODE` or a previously saved activation in RocksDB is present, the node prints the required-variable list and exits.

Once the server has joined the network, the Overview of aiqnet.io/node follows the node for its wallet: online or not (the nodes' peer view or the node's on-chain heartbeat), when it was last seen, its heartbeats this epoch against the number needed, and its node balance, which moves to the wallet from My node (the QNet Wallet extension or QNet Wallet confirms) or from the Node tab of QNet Wallet with the same wallet on any phone; History lists its epochs one by one. The Device tab says that a Super node runs on its server and has no device to link.

Below the `super_reward_admission` gate (epoch 258) every registered, unbanned Super node with 9 heartbeats in an epoch earns that epoch's operator share. From epoch 258 it earns it only while the network admits it to consensus: while the emergency committee allowlist is in force (see [consensus](../architecture/consensus.md#emergency-committee-allowlist)) the admitted set is the five genesis nodes and `super_node_c78c3017a4f93464`, and a node outside it earns no super share, however many heartbeats it sends; it keeps its registration, and rewards it already earned stay claimable. The node's `/api/v1/node/status` and `/api/v1/rewards/pending/{node_id}` report this as `admission`: `waiting` while outside, `admitted`, or `not_required` for an epoch no admission rule governs ([RPC API](../developers/rpc-api.md)). A Super node must run a build that carries this gate before height 3,729,690, where epoch 258's super reward set is filed: a node still on an older build files it under the old rule there, and its reward root no longer matches the certified one. The auto-updater installed by `install-super-node.sh` takes the build once `:latest` moves to it, after the genesis fleet runs it.

### Genesis bootstrap nodes

The five genesis identities start with `QNET_BOOTSTRAP_ID` set to `001`–`005` and a wallet seed, with no activation code or burn data; burn verification is skipped for them. The five ids and the genesis IP list are pinned in the binary. Genesis mode is also entered by setting `QNET_GENESIS_BOOTSTRAP=1` or by a source-IP match against the pinned genesis list. Do not set these variables on an ordinary Super node.

The boot barrier on a genesis node clears on a **quorum** of the genesis set. It prefers a
connection to each of the other four identities, and once the two-minute wait window elapses it
clears on `MIN_PEERS_FOR_QUORUM` — three connected peers, which with this node makes the
four-of-five quorum. Below that the wait resets and the barrier keeps trying, so a partially
connected set never starts producing, while one absent identity leaves the other four able to
start. `MIN_PEERS_FOR_QUORUM` is defined in `development/qnet-integration/src/node/lifecycle.rs`.

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

Light nodes run inside QNet Wallet on a phone or tablet, one device per node, after the system's device check. The Light burn is made on aiqnet.io/node by the cabinet's one-time payment key, after QNet Wallet confirms the wallet the node is for, with the wallet's consent signed in QNet Wallet on a sheet a verified `link.aiqnet.io` link opens, or by the QNet Wallet browser extension with the wallet's own key; the cabinet or the extension submits the registration. The app links the node to its device ("Use this device") and moves the node balance. Light nodes keep no chain data and hold no consensus key. See [mobile wallet](../applications/mobile-wallet.md) and [node activation](../economics/node-activation.md).

## First-run expectations

A first start proceeds in this order, and each stage is logged:

1. **Guards.** Restart-manifest sanity check, container check, and a system-clock plausibility check that aborts on an implausible timestamp.
2. **Auto-configuration.** Port selection and bind probing, data-directory selection.
3. **Activation.** The activation source is resolved (genesis id, environment code, or a saved record), then the code is format-checked, phase- and price-checked, checked for prior use on chain, and the Solana 1DEV burn is verified. A failure at this stage is fatal.
4. **Pre-flight.** Local port availability, external IP detection, external reachability of the required ports, QUIC readiness, NTP status. A critical failure exits the process.
5. **Node start.** Memory check, storage open, P2P and API servers, then a boot barrier that holds the node out of production until it has connected to enough peers for consensus — three peers on an ordinary Super node, a quorum of the genesis set on a genesis node (see below).
6. **Sync.** The node joins the network over QUIC and catches up. A node far behind the tip jumps to a verified state snapshot and then replays the tail; a node close to the tip replays blocks directly.
7. **Registration.** A boot-spawned convergence driver collects committee burn attestations and submits the on-chain `NodeRegistration`.
8. **Warmup.** A registered Super node becomes producer-eligible only after `ACTIVATION_WARMUP_BLOCKS = 180` blocks (two macroblock epochs) have been buried above its registration height. Expect to be a non-producing participant for that period.

Let the first sync finish rather than cycling the container: every restart re-runs the whole sequence above, including pre-flight and activation verification.

## Verifying the node is healthy

All of these are served on the API port.

```bash
# Liveness (lock-free, one atomic read — this is what a container health check should use)
curl -s http://localhost:8001/healthz            # -> "ok h=<height> build=<id>"
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

- `/healthz` returns a height that increases, and its `build=` is the `QNET_BUILD_ID` the running image was built with.
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

Expected: thirteen `subsystem_started` lines followed by `contract_satisfied`. The subsystems are
`signed_head_emitter`, `peer_cleanup`, `background_repair`, `background_height_sync`,
`reputation_validation`, `regional_clustering`, `tx_cache_cleanup`, `rate_limiter_cleanup`,
`static_cache_cleanup`, `quic_idle_reaper`, `external_ip_resolver`, `committee_links` and
`device_migration_monitor`. A branch that deliberately does not spawn one signs in as
`subsystem_skipped` with a reason, which satisfies the contract in its place.

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

Upgrading is a rebuild plus a container replacement with the same volume and the same environment, less any one-shot recovery variable (`QNET_ROLLBACK_TO_LAST_SEALED`, `QNET_ROLLBACK_TO_HEIGHT`), which acts again on every start it is present for; see [maintenance](maintenance.md) for the coordinated-stop variable `QNET_HALT_HEIGHT` and the rest of the upgrade procedure.

### Bundled multi-node stack

`docker-compose.production.yml` at the repository root brings up a local multi-node testnet (one genesis plus two peers), an nginx TLS terminator and a Prometheus/Grafana pair. It is a development and integration-testing stack, not the way to run a single production Super node. Before using it: it requires `QNET_ADMIN_SECRET` to be present in a `.env` file, it ships a placeholder Grafana admin password that must be replaced, and it expects TLS material under `infrastructure/nginx/ssl` that you supply.

## Public RPC (port 443)

A Super node also answers wallet reads over HTTPS on `https://<its public IPv4>`: the certified reads a
wallet verifies itself (macroblock proofs, registry snapshots, the certified state and certified balance
proofs) and transaction submits, nothing else. Wallets choose nodes at random from the network's certified
lists and check each one's signed serving identity, so a node can only answer correctly or be dropped. The
routes, limits and formats are in the [RPC reference](../developers/rpc-api.md#wallet-plane).

- **Certificate.** The node obtains a certificate for its IP address from a public ACME certificate
  authority and renews it itself; no DNS name and no port 80 are needed. A certificate lasts about 6.7
  days and is renewed about every 80 hours. The first one is requested within about 6 hours of the first
  start (spread so that all nodes do not ask at once), and only after a genesis node confirmed that host
  port 443 reaches this very node (not another server on the address). One exception: while the genesis
  nodes run a version without that check (during an upgrade), a node with `QNET_PUBLIC_IP` (or
  `EXTERNAL_IP`, `HOST_IP`) set requests it without the confirmation, under the same backoff; one without
  waits. When no genesis node can answer the check (busy or unreachable), the node simply asks again
  some minutes later. **Publishing port 443 accepts that authority's subscriber terms**; the
  installer says so before it starts the node.
- **Network.** Inbound TCP 443 must be reachable from the whole internet: the authority checks it from
  several places, so do not geo-block it. Outbound TCP 443 to the authority must stay open; its addresses
  are not published and change without notice. If something else on the host already uses 443 (a
  listening service, or another container that publishes it), the installer leaves the mapping out and
  says `public RPC off: port 443 is in use`; if the start with the mapping still fails, it starts the node
  without it.
- **Opt-out.** Run the installer with `--no-public-rpc`, or leave `-p 0.0.0.0:443:8443` out of
  `docker run`. Without the mapping the node probes 443 about every 6 hours, logs
  `public_rpc_off reason=port_443_unreachable` and places no certificate orders; consensus duty is
  unaffected. A node that already held a certificate tries its next renewal once: when the authority
  cannot reach it, it logs `acme_failed stage=challenge` and from then on probes 443 before any further
  order, as above. 48 hours after its last certificate expired, once it has tried to renew in its current
  run (or found 443 unreachable), it commits `http://<IP>:8001` again by itself.
  `QNET_HIDE_IP` keeps its meaning: no announced address, so no public RPC either, and the node commits
  nothing by itself. A node that served and is then switched to `QNET_HIDE_IP` keeps `https://<IP>` on
  chain (wallets then find a closed port and leave it alone) and logs
  `hidden_node_endpoint_still_https` at each start: submit one reactivation with
  `"api_endpoint": "http://<IP>:8001"` (see [Publishing the new address](#publishing-the-new-address)) to
  announce the plain form; a reactivation without `api_endpoint` leaves the endpoint as it is.
- **Its address on chain.** Once a certificate for its IP was issued, two genesis nodes see the same
  address and the node is registered, the node commits `https://<IP>` as its endpoint by itself, through
  the ordinary reactivation transaction, at most once per 100 macroblocks. Peers read only the IP from it.
  For a node that had already committed `http://<IP>:8001`, peer connections therefore do not change.
  For a node whose committed endpoint was empty, which is every node set up by the installer so far, the
  first commit announces an address for the first time: from the next block its peer-to-peer identity is
  bound to that IP (other nodes accept its QUIC connections and gossip only from it), and committee and
  burn-attestation calls start dialing `http://<IP>:8001`. The IP is the one two genesis nodes see as this
  server's TCP source address. A server whose UDP traffic leaves from another address would lose its
  peers: commit the right address yourself (see
  [Publishing the new address](#publishing-the-new-address)) or set `QNET_HIDE_IP`. After 48 hours with no
  valid certificate it commits `http://<IP>:8001` again, as long as that IP is still its own; after a move
  the new address is published as described in [Publishing the new address](#publishing-the-new-address).
- **Genesis trouble.** The node keeps the address it last resolved (or, at a start, the one its valid
  certificate names) while the genesis nodes are down, busy or disagree: it keeps serving, renewing and
  applying the 48-hour rule, and only waits with new endpoint commits.
- **Cost.** The node spends at most 100 Mbit/s on wallet answers (a token bucket with a 25 MB burst,
  charged as bytes are actually sent); past it the heaviest answers are refused for a moment and wallets
  go elsewhere. With many serving nodes the average is a few to a few tens of Mbit/s. Memory is bounded
  too: at most 128 MiB of the heaviest answers are in flight at once (two per client address), and a
  download that stops moving is dropped after 20 seconds. There is no reward change for serving.
- **Files.** Everything lives in `<data dir>/wallet_tls/` on the data volume, owner-only: the CA account
  key, the certificate and its key, the single-purpose serving key and the serving certificate the wallet
  key signed, and the schedule (each attempt is recorded before it starts, so a restart, even in the
  middle of one, never asks the authority early). The wallet key itself is derived from the mounted
  phrase only to sign the serving certificate; the node then wipes its own working copies of the phrase
  and of the key. The signing library's internal memory is out of its reach, and so are the phrase's
  other copies: the mounted file, the in-memory copy under `/dev/shm` that the image makes for the
  container's lifetime when the node's user cannot read the mounted file, and a `QNET_WALLET_SEED`
  variable, if one is used, in the process environment.
- **Existing installs** re-run the installer once: the auto-updater changes the image, never the port
  mappings. The phrase and the data are kept.
- **Downgrade.** An older image does not open port 8443 and ignores `wallet_tls/`; its committed
  `https://<IP>` stays, and wallets get "connection refused" from it and leave it alone. Peers are
  unaffected. To announce the plain form again, submit a reactivation with
  `"api_endpoint": "http://<IP>:8001"` (see [Publishing the new address](#publishing-the-new-address)).

The node's log lines for it:

| Line | Meaning |
| --- | --- |
| `[INFO][WALLETTLS] cert_issued ip= not_after=` | a certificate was issued or renewed |
| `[WARN][WALLETTLS] acme_failed stage= reason= retry_in=` | a certificate step failed; the node retries after `retry_in` |
| `[WARN][WALLETTLS] cert_expiring hours_left=` | under 24 hours left on the certificate |
| `[INFO][WALLETRPC] public_rpc_off reason=` | why the node serves no wallet reads now (`port_443_unreachable`, `genesis_busy`, `genesis_without_probe`, `no_public_ip`, `hide_ip`) |
| `[WARN][WALLETRPC] hidden_node_endpoint_still_https endpoint=` | under `QNET_HIDE_IP` with `https://<IP>` still committed: see Opt-out |
| `[WARN][WALLETRPC] public_ip_unusable reason=` | the address is not public, or today's endpoint rule refuses it |
| `[WARN][WALLETRPC] public_ip_env_differs env= seen=` | `QNET_PUBLIC_IP` differs from what genesis sees |
| `[INFO][WALLETRPC] endpoint_commit from= to= reason=` | the node committed its endpoint (`serving` or `lapsed`) |
| `[WARN][WALLETRPC] client_ip_masked` | 443 reaches the node through the container runtime's proxy, which hides wallets' addresses; publish it on `0.0.0.0` |
| `[INFO][WALLETRPC] stats` | every 5 minutes: connections, answers, refusals, connections dropped for a stalled answer (`stalled`), heavy answers in flight, egress, certificate hours left |

```bash
# Is the public RPC answering? (from anywhere)
curl https://<public IPv4>/healthz
docker logs qnet-super 2>&1 | grep -E 'WALLETRPC|WALLETTLS' | tail
```

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
and peers bind the identity to the new address from the next block on. A node that serves the
[public RPC](#public-rpc-port-443) announces `https://<ip>` instead, and commits the new address by itself
once its certificate for it was issued.

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
