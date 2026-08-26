# Networking

This document describes the QNet node-to-node layer: the QUIC transport and its TLS configuration, the application
handshake that binds a peer identity to a connection, the bincode wire frame and the `NetworkMessage` catalogue, how
peers are discovered and admitted, how blocks and transactions propagate, the layered denial-of-service defences, the
HTTP calls nodes make to one another, the ports a node exposes, and the NAT and log-privacy facilities. The implementation lives in
`development/qnet-integration/src/unified_p2p/` and `quic_transport.rs`. Consensus semantics of these messages are in
[consensus.md](consensus.md); signature and hash primitives in [cryptography.md](cryptography.md).

## Transport

QUIC carries every `NetworkMessage`. The node wraps `quinn` over UDP. When a QUIC send fails the message is dropped and
`send_network_message` returns. A second, narrower node-to-node path runs over peers' TCP API port and is described
under [HTTP node-to-node calls](#http-node-to-node-calls).

TLS comes from `rustls` with the `aws-lc-rs` crypto provider, pinned to TLS 1.3 on both server and client sides, with
ALPN identifier `qnet-p2p-v1`. Certificates are self-signed via `rcgen` with a single SAN `qnet-{node_id}`, persisted
under the node data directory and regenerated if a loaded certificate's SAN no longer matches. On connections this node
dials out, trust comes from the SAN check plus a trust-on-first-use fingerprint pin (`TOFU_PIN_TTL_SECS` 86400,
`TOFU_PIN_GRACE_AFTER_SECS` 7200, `TOFU_MAX_PINS` 10000). A fingerprint change within the first two hours of a pin is
rejected as possible interception for every identity except `genesis_node_*`, whose address is pinned at compile time
and which may always re-pin; after the grace period a new fingerprint replaces the pin for any identity, so a rolling
restart with a regenerated certificate reconnects. Both directions then run the application handshake described below:
a connection completes only when the peer presents a valid post-quantum identity proof, and a peer that cannot present
one is refused.

| Transport parameter | Value |
| --- | --- |
| `CONNECT_TIMEOUT_SECS` / `MESSAGE_TIMEOUT_SECS` | 3 / 10 |
| `KEEP_ALIVE_SECS` / `IDLE_TIMEOUT_SECS` | 30 / 90 |
| `MAX_STREAMS_PER_CONN` | 500 (bidi and uni alike) |
| Congestion controller; receive / send window | BBR; 16 MB / 16 MB |
| `DEFAULT_INITIAL_RTT_MS` / min / max; `RTT_CACHE_MAX_ENTRIES` | 250 / 10 / 2000 ms; 10000 |
| `CONNECT_RETRY_ATTEMPTS` / `HANDSHAKE_RETRY_ATTEMPTS` | 3 / 5 |
| Send backoff `RETRY_DELAY_MS` / `MAX_RETRY_DELAY_MS` | 200 ms / 2000 ms |
| Connect backoff `CONNECT_RETRY_DELAY_MS` / `CONNECT_MAX_RETRY_DELAY_MS` | 1000 ms / 30000 ms |
| `PEER_RECONNECT_COOLDOWN_SECS` / `MAX_CONCURRENT_OUTBOUND_DIALS` | 5 / 10 |

Ordinary messages travel on unidirectional streams, fire-and-forget. Bidirectional streams with a one-byte
acknowledgement are reserved for `send_with_ack`, whose deadline adapts to the measured peer RTT; initial RTT is seeded
per peer from a bounded cache refreshed from live connection statistics. A connection idle for more than 60 seconds is
treated as a zombie even when QUIC reports no close reason, because a silent partition never sets one.

## Connection identity and handshake

Peer identity is asserted by an application-level handshake over the established connection, with its own frame ceiling
`MAX_HANDSHAKE_SIZE` (64 KB) read before any authentication.

```
NodeHandshake { node_id, cert_serial, protocol_version, node_type,
                timestamp, block_height, dilithium_proof: Vec<u8> }
```

The frame has exactly one canonical bincode shape and a frame that does not decode into it refuses the connection, so
the attacker-chosen deserialization surface is a single form.

`dilithium_proof` is a mandatory ML-DSA-65 signature over
`qnet-quic-handshake-v2:{node_id}:{timestamp}:{block_height}:{channel_binding}`. The channel binding is a TLS
keying-material export over that specific connection, label `qnet-quic-channel-binding-v1`, hex-encoded, so a proof
captured from one session cannot be replayed on another. If the exporter is unavailable the connection is refused. Each
side verifies the peer's proof before sending its own, and a node whose local crypto cannot sign its own proof refuses
the connection rather than putting an unprovable identity on the wire.

Verification is one registry lookup plus at most one ML-DSA-65 verify, and retains no per-peer state. An empty proof, a
proof whose bytes are not valid UTF-8, and a proof that fails under the claimed identity's registered key each close the
connection. Two outcomes admit the peer as unauthenticated transport instead: the claimed `node_id` has no entry in the
consensus public-key registry, and the local verifier is not yet published. The first is the fresh-joiner path — the
connection carries the peer's signed `VrfKeyAnnounce`, which installs its identity. An unauthenticated peer attests
nothing, and its claimed `block_height` is discarded; a verified handshake binds `(node_id, block_height)` as one signed
tuple, so a non-zero height attests the peer's tip immediately without waiting for a `HealthPing`. Authority is asserted
per message rather than per connection: every consensus-bearing message carries its own signature, verified against the
registry.

Before any ML-DSA-65 work, `ip_identity_gate` binds claimed identity to source IP: a `genesis_node_*` identity must
originate from its pinned address in `GENESIS_NODE_IPS`, an identity present in `NODE_ENDPOINT_REGISTRY` must match its
registered on-chain endpoint IP, and an identity with no registry record is admitted (the first-contact window).

`NODE_ENDPOINT_REGISTRY` maps a node id to the IP of its committed API endpoint. Block apply writes a row for every
`NodeRegistration` and, when the transaction announces a non-empty endpoint, for every `NodeReactivation`, so a node
that returns on a new address publishes it and keeps passing the gate. Each row is persisted under the `node_registry`
column family alongside the in-RAM entry, and `restore_node_endpoints` rehydrates the map at boot by scanning the
persisted `nep_genesis_node_*` and `nep_super_*` rows, so the gate is armed from the first inbound connection after a
restart or a snapshot cold join instead of falling through to first-contact for every peer. Genesis identities resolve
from the pinned binary table, so a persisted row never restates one. The map is bounded at 1,000,000 entries and
evicts one entry when a new registration arrives at capacity; a miss is re-resolved from the committed rows.

## Wire encoding

The payload encoding is bincode. Each message is framed as a 6-byte header plus payload, written to a QUIC stream
behind a 4-byte length prefix.

```
byte 0      PROTOCOL_VERSION      (1)
byte 1      message type
bytes 2..6  payload length, u32 big-endian
bytes 6..   bincode payload
```

`PROTOCOL_VERSION` and `MIN_SUPPORTED_PROTOCOL_VERSION` are both `1`; `parse_message` rejects any frame outside that
inclusive range. Accepting a range rather than a single value lets a coordinated version bump roll out node by node
without partitioning the network. Because bincode serializes enum variants by positional index, `NetworkMessage` is
append-only: new variants go at the tail, and inserting one mid-enum shifts every later index and breaks wire
compatibility with deployed binaries. A per-type size ceiling is enforced *before* deserialization, from the type byte
alone.

| Type byte | Messages | Ceiling |
| --- | --- | --- |
| 1 | `Block` | 10 MB |
| 2 | `Transaction` | 1 MB |
| 3 | `PeerDiscovery` | 256 KB |
| 4 | `HealthPing` | 16 KB |
| 8 | `ShredProtocolChunk` | 512 KB + 256 |
| 10 | `ConsensusV2`, `MacroblocksBatch`, `TimeoutCertificateBroadcast`, `TimeoutCertificatesResponse` | 10 MB |
| 0 | every other variant, and any unrecognised byte (catch-all) | 2 MB |

`MAX_MESSAGE_SIZE` bounds every frame at 10 MB.

One payload on a uni stream is a transport signal rather than a `NetworkMessage`: `ping_peer` writes a single `0xFF`
byte behind the 4-byte length prefix as a liveness probe. The receiver recognises a one-byte `0xFF` payload, refreshes
the connection's byte counters and last-activity stamp, and returns before header parsing, so the keepalive carries no
version, type or length header of its own.

## Message catalogue

Related request/response pairs share one row below.

| Variant | Type | Purpose |
| --- | --- | --- |
| `Block` | 1 | Whole-block carrier, used by the height-0 genesis broadcast |
| `MacroBlockBroadcast` | 0 | Dedicated zstd-compressed macroblock delivery channel |
| `RequestBlocks` / `BlocksBatch` | 0 | Ask for, and serve, a height range (batch capped at 100 blocks) |
| `RequestMacroblocks` / `MacroblocksBatch` | 0 / 10 | Ask for, and serve, macroblocks by index (server truncates a response to 10 macroblocks) |
| `RequestMacroblockAnchor` | 0 | Control-lane request for one QC-bound macroblock by index, answered with `MacroblocksBatch` |
| `ShredProtocolChunk` | 8 | One Reed-Solomon data or parity shred of a block body |
| `RequestMissingChunks` / `MissingChunksResponse` | 0 | Ask for, and serve, specific missing shred indices |
| `ConsensusV2` | 10 | Opaque Checkpoint-BFT frame routed to the consensus v2 runtime. A completed quorum or timeout certificate is relayed to `RELAY_FANOUT` (8) peers, not to every peer: committee members rebuild the same certificate from the votes they already collected, so the relay is redundancy rather than the delivery path |
| `TimeoutVote` | 0 | Signed failover vote for a window and round, carrying the voter's own high-QC and tip |
| `TimeoutCertificateBroadcast` | 10 | Aggregated per-voter timeout proofs forming a round certificate |
| `RequestTimeoutCertificates` | 0 | Pull timeout certificates for a height range |
| `TimeoutCertificatesResponse` | 10 | Serve those certificates with full per-voter payloads |
| `ProducerReady` / `ReadyAck` | 0 | Round-change handshake; fires only at failover round above 0, both signed |
| `ProducerHeartbeat` | 0 | Signed producer liveness beacon over the wire-supplied anchor hash |
| `BlockRejection` | 0 | Signed observer report of a rejected block, aggregated per (height, source) |
| `BlockAttestation` | 0 | Signed confirmation of an accepted block, emitted only by that height's committee slice |
| `VrfLeaderClaim` / `VrfKeyAnnounce` | 0 | Self-verifiable VRF leadership claim with gossip TTL; self-signed VRF public-key announcement |
| `RequestConsensusState` | 0 | Ask a peer for consensus state at a round |
| `GenesisCheckpointSig` / `GenesisCheckpoint` / `RequestGenesisCheckpoint` | 0 | A genesis node's partial signature, the quorum-signed capsule, and the cold-join pull for it |
| `Transaction` / `TransactionBatch` | 2 / 0 | One serialized transaction; or many in one frame with a batch timestamp |
| `PeerDiscovery` | 3 | Introduce the requesting node's `PeerInfo` |
| `PeerListRequest` / `PeerListResponse` | 0 | Ask for, and serve, `(addr, node_id, height)` peer triples |
| `FindNode` / `FindNodeResponse` | 0 | Lookup by target hash, answered from the routing table with the K closest pairs. The responder is live; nodes discover peers through bootstrap dial and peer exchange rather than by issuing lookups |
| `HealthPing` | 4 | Signed liveness and height beacon, plus unsigned certificate sync hints. Carries no public key: the verifying key is resolved from the consensus registry by sender id |
| `ActiveNodeAnnouncement` | 0 | Signed announcement of an active Super node with shard and reputation |
| `ActiveNodesRequest` / `ActiveNodesResponse` | 0 | Ask for, and serve, the active-node list |
| `SystemEvent` | 0 | Broadcast of a system-level event with JSON payload |
| `LightNodeRegistration` | 0 | Gossip a Light node's registration record into the registry |
| `LightNodeRegistryRequest` / `LightNodeRegistryResponse` | 0 | Ask for, and serve, registrations newer than a timestamp |
| `LightNodeAttestation` | 0 | Doubly-signed proof that a Light node answered a ping challenge |
| `CertificateAnnounce` / `CertificateRequest` / `CertificateResponse` | 0 | Announce a post-quantum certificate by serial; ask for and serve one by owner and serial |

## Inbound quality-of-service lanes

Every inbound message is dispatched into one of three channels before handling, so a cold-sync flood cannot delay
finality:

- **Finality lane** (reserved): `ConsensusV2`, `TimeoutVote`, `TimeoutCertificateBroadcast`, `ProducerReady`,
  `ReadyAck` — non-redundant quorum frames with no repair path. Overflow increments `FINALITY_LANE_DROPPED`, meaning
  unrepairable consensus loss; a non-zero value warrants investigation.
- **Bulk lane** (bounded, drop-on-full): `RequestBlocks`, `RequestMacroblocks`, `BlocksBatch`, `MacroblocksBatch`,
  `StateSnapshot`. Overflow increments `BULK_LANE_DROPPED` and is benign shedding.
- **Default lane**: everything else, including all gossip. A control-lane set — `RequestMacroblockAnchor`,
  `RequestGenesisCheckpoint`, `GenesisCheckpointSig`, `GenesisCheckpoint` — is kept out of the bulk classification so
  the anchor fetch every cold joiner must complete keeps a reserved serve quota on this lane.

## Peer discovery

Bootstrap is the five hardcoded `(IP, bootstrap_id)` pairs in `GENESIS_NODE_IPS`; a fresh node reaches the network
through one of those addresses or through an already-known peer address. Five mechanisms then populate the peer table.

**Challenge-response bootstrap.** When `connect_to_bootstrap_peers` is called with an empty list, `search_internet_peers`
assembles candidates itself: the `GENESIS_NODE_IPS` addresses that pass a liveness filter, plus every address in
`QNET_PEER_IPS`. Each candidate is dialled on TCP 8001 and must authenticate before it is admitted —
`POST /api/v1/auth/challenge` carries a freshly generated quantum challenge, and the reply must supply an ML-DSA-65
signature over that challenge together with the public key that verifies it. A verified candidate is inserted as a
`PeerInfo` with its region taken from the genesis IP table. The liveness filter reuses recent traffic when a candidate
has been heard from within `PEER_ALIVE_FRESHNESS_SECS`, otherwise makes up to three TCP attempts with 3 s, 5 s and 8 s
timeouts, and caches its verdict for 30 s on genesis nodes and 45 s elsewhere.

**Peer exchange.** A loop sends `PeerListRequest` over QUIC every 10 s on genesis nodes and every 300 s elsewhere;
non-genesis nodes query at most 3 peers per cycle, doubled plus two when an escalation raises the refresh flag.
`request_peer_list_from_node` returns immediately — peers arrive asynchronously in the `PeerListResponse` handler, and
a responder serves its full connected-peer map. What the handler does with a reply is described under
[peer admission](#peer-admission-scoring-and-eviction).

**Kademlia routing.** Node ids are hashed with SHA3-256 into a 256-bit space (`KADEMLIA_BITS` 256) with `KADEMLIA_K` 20
per bucket and `KADEMLIA_REFRESH_INTERVAL_SECS` 600. A full bucket evicts its
lowest-reputation member only if the newcomer's reputation is strictly higher; `FindNode` is answered with up to K
closest entries, excluding the requester.

**Announcement gossip.** `ActiveNodeAnnouncement`, `LightNodeRegistration` and `LightNodeAttestation` carry a
`gossip_hop` counter and are dropped at hop 3 or above. Announcement re-gossip fanout decays per hop:
`ceil(sqrt(peers))` clamped to 2..6 at hop 0, half that clamped to 1..3 at hop 1, and 1 thereafter. `VrfLeaderClaim` is
relayed only when newly verified, with `VRF_CLAIM_GOSSIP_TTL` 4 and a fanout of `ceil(sqrt(peer_count))` clamped to
2..20, excluding the sender.

**Implicit add.** Any peer that successfully delivers a non-Light message is added through `ensure_peer_connected` →
`add_peer_safe` → `add_peer_lockfree`; `LightNodeRegistration` and `LightNodeAttestation` are excluded because Light
nodes live in a separate registry.

## Peer admission, scoring and eviction

`add_peer_lockfree` is the one admission path: dialled, handshaked and gossip-learned peers all enter through it. It
rejects self-connections — by node id and by matching external IP — then applies three checks **to inbound peers only**.
Outbound connections bypass all three; genesis IPs bypass the reputation gate and the subnet caps, while the
reserved-outbound-slot check applies to every inbound peer, genesis included. The three counts come from one bounded
pass over the peer table, so a burst of admissions does not multiply scans.

| Check | Constant | Value |
| --- | --- | --- |
| Reserved outbound slots | `MIN_OUTBOUND_SLOTS` | 8 of `MAX_CONNECTED_PEERS` 1000 |
| Minimum inbound reputation | `MIN_INBOUND_PEER_REPUTATION` | 50.0 |
| Concurrent inbound per IPv4 /24 | `MAX_PEERS_PER_SUBNET_24` | 2 |
| Concurrent inbound per IPv4 /16 | `MAX_PEERS_PER_SUBNET_16` | 8 |

Both subnet caps are fixed compile-time parameters of the eclipse defence, identical on every node: at 8 inbound peers
per /16, filling the 992 non-reserved inbound slots takes at least 124 distinct /16s, so no single hoster owns a
meaningful share of a node's inbound view. An address that is not IPv4 dotted-quad yields no prefix and is subject to
the slot and reputation checks alone.

Peers named in a `PeerListResponse` take the same path, after the relay's claim is resolved to an identity the relay
does not get to choose. An address in `GENESIS_NODE_IPS` binds to that pinned `genesis_node_*` id; any other address
binds to the claimed id only when the chain-committed endpoint IP in `NODE_ENDPOINT_REGISTRY` for that id matches the
gossiped address. A `genesis_node_*` id claimed from a non-pinned address, and any other id with no matching committed
endpoint, is dropped as `unbound_identity`. An entry whose bound identity is already connected refreshes that peer's
last-seen stamp only — the gossiped height is unauthenticated and never sets `last_block_height`, which moves on signed
`HealthPing`s and applied blocks. A new peer is entered as inbound, consuming an inbound slot and facing every gate
above, and at most `MAX_GOSSIP_ADMITS_PER_RESPONSE` (16) new peers are taken from any one response, so discovery
converges over repeated exchange cycles rather than letting one relay shape the peer set. A node running a genesis
identity admits only pinned genesis addresses from gossip. `PeerInfo::combined_reputation()` returns the
`reputation` field verbatim, sourced at the P2P layer from `get_node_reputation_from_blockchain`. A separate
`calculate_peer_score` blends latency (60%) with a boolean stability flag (40%) and drives regional load-balanced peer
selection.

The peer blacklist distinguishes soft reasons (sync timeout, connection failure, slow response), hard reasons (invalid
blocks, malicious behaviour) and an identity-hard reason (public-key impersonation) whose authoritative enforcement
lives at the QUIC handshake against the presented ML-DSA-65 public key. Unresponsive peers get exponential cooldown
from `PEER_COOLDOWN_BASE_SECS` 2 to `PEER_COOLDOWN_MAX_SECS` 30; traffic within `PEER_ALIVE_FRESHNESS_SECS` 60 counts
as alive and skips the probe. The peer map is capped at `MAX_CONNECTED_PEERS` 1000 with LRU eviction.

Six geographic regions exist (North America, Europe, Asia, South America, Africa, Oceania) with a hardcoded adjacency
map, and each node derives a `shard_id` from the first byte of SHA3-256 of its node id, giving 256 shards. A regional
clustering task runs every 60 s and reports when the node holds fewer than 2 peers in its own region.

## Block propagation

Block bodies are split into `SHRED_PROTOCOL_CHUNK_SIZE` 512 KB chunks with Reed-Solomon parity over GF(2^8), bounded by
`SHRED_PROTOCOL_MAX_CHUNKS` 170 data chunks, with data plus parity capped at the 255-shard field limit. Redundancy is
adaptive: 2.0x at every size tier when the live peer count is 50 or fewer, and 1.5x / 1.75x / 1.5x for larger sets at
the under-100 KB, under-500 KB and 500 KB-and-above tiers. Every shred carries `num_coding_shreds` so the decoder
reconstructs with the producer's exact dimensions, plus a SHA3-256 hash of the original block so the reconstruction is
checked before full validation. The producer certificate is replicated onto chunk 0 and the first
`CERT_REDUNDANT_PARITY` (4) parity chunks, so chunk arrival order is irrelevant.

Relay follows a rotated F-ary heap over the canonical committee roster from `committee_for_height`, with the tier-0
root chosen as `chunk_index % roster_len` so every member builds a byte-identical tree. `shred_tree_fanout` is a pure
function of roster size — 8 for m ≤ 64, 16 for 65..1024, 32 above — so two honest members always derive the same value
and no index band is orphaned. Committee members are the tree; every other node obtains finalized blocks through
`RequestBlocks`. Forwarding is a duty independent of local reconstruction, guarded by a per-`(block_height,
chunk_index)` forward-once set. In genesis epochs, before a roster exists, the producer relays over a Kademlia-sorted
peer list shuffled by a SplitMix64-seeded Fisher-Yates keyed on block height, using the adaptive fanout.

Sends are paced: batch size between `PACING_BATCH_SIZE_MIN` 50 and `PACING_BATCH_SIZE_DEFAULT` 100, inter-batch delay
between `PACING_DELAY_MS_DEFAULT` 2 ms and `PACING_DELAY_MS_MAX` 20 ms, selected from the recent send-failure rate
against `PACING_FAILURE_THRESHOLD` 0.15 and `PACING_FAILURE_CRITICAL` 0.35, with a semaphore bounding concurrent sends.
Missing chunks are re-requested after `SHRED_CHUNK_TIMEOUT_SECS` 5 with up to `SHRED_CHUNK_MAX_RETRIES` 4 attempts,
served from a `SHRED_CHUNK_CACHE_SIZE` of 5000 blocks of cached chunks. Chunks at or below the local height are dropped
unless this node explicitly solicited the repair within a 30-second window, so a peer cannot force below-tip
reassembly.

Macroblocks use `MacroBlockBroadcast` rather than the shred path, because the shred layer dedupes by height and a
macroblock index would collide with a microblock height. Delivery is three attempts with exponential backoff, bounded
parallelism, and a second retry wave for failed peers. Payloads are zstd-compressed and decoded through a bounded
reader that short-circuits on the first byte past `MAX_MACROBLOCK_DECOMPRESSED`, guarding against a decompression bomb.

## Transaction propagation

Transaction routing is producer-directed. A transaction is sent straight to the cached current producer and then
gossiped to 2 backup peers, or 3 when no producer is cached. `broadcast_transaction_batch` skips the network entirely
when this node is the current producer, since the transactions are already in its own mempool. On receipt, transactions
are deduplicated by SHA3-256 of the raw bytes in a `seen_tx_hashes` set that is cleared at 1000000 entries; only unseen
transactions are queued and re-gossiped, to 2 random peers. A `TransactionBatch` carrying more than `MAX_TX_BATCH_SIZE`
10000 transactions is dropped as an out-of-memory guard. Random-peer gossip picks targets with `OsRng` over the whole
connected-peer map; a variant excludes the sender by IP prefix to break echo loops.

## Rate limiting and denial-of-service defences

Inbound work is filtered in a fixed order, cheapest first:

1. Pre-TLS per-source-IP ban from a failed-handshake token bucket: `HANDSHAKE_FAIL_THRESHOLD` 20 failures inside
   `HANDSHAKE_FAIL_WINDOW_SECS` 60 produce a `HANDSHAKE_FAIL_BAN_SECS` 600 cooldown; a successful handshake clears the
   counter, and genesis IPs are never banned.
2. Pre-TLS global cap `MAX_TOTAL_CONNECTIONS` 500, then a three-tier per-IP cap: genesis unlimited, previously-
   handshaked IPs 200 (`MAX_CONNECTIONS_PER_IP_KNOWN`), never-seen IPs 10 (`MAX_CONNECTIONS_PER_IP_UNKNOWN`), with
   promotion to the known tier after a first successful handshake.
3. `MAX_CONCURRENT_HANDSHAKES` 64 permits. On exhaustion the accept loop refuses and sleeps 10 ms so it cannot spin at
   accept/refuse speed. A handshake exceeding `INCOMING_HANDSHAKE_TIMEOUT_SECS` 5 releases its permit immediately.
4. `ip_identity_gate`, then ML-DSA-65 proof verification.
5. Per-type payload ceiling, applied before deserialization.
6. Per-request serve rate limits, keyed jointly on `(source IP, requester node-id prefix)` so that neither a shared
   address nor a rotating identity defeats them.

| Serve limit | Value |
| --- | --- |
| Block serve, synchronized requester | 10/min, 60 s block |
| Block serve, genuine catch-up (`to_height` at or below our tip) | 60/min, 30 s block |
| Per-IP aggregate priority ceiling | 180/min, 30 s block |
| Blocks per `BlocksBatch` | 100 |
| Macroblock serve, normal / requester behind | 5/min, 120 s block / 30/min, 60 s block |
| `HealthPing` | 60/min per peer, 300 s block |
| Bulk serve-send permits (`BULK_SEND_CONCURRENCY`) | 256, 2 s acquisition timeout |

Genesis peers bypass sync rate limiting, and the bypass is decided from the transport-verified source IP rather than a
self-declared node id. A node refuses to serve a range whose `from_height` is above its own servable height, avoiding
empty-batch spam; serve decisions read `HIGHEST_STORED_HEIGHT` (durably stored) rather than the applied height, and
that watermark is lowered after a rollback so the node stops advertising a range it no longer holds. Bulk serve
responses acquire a permit before sending while requests and consensus messages bypass it, reserving connection
headroom for consensus.

Signed consensus messages are exempt from count-based rate limiting: the protocol-level uniqueness invariants — one
vote per validator per round, distinct-observer sets — are the emission cap. `is_consensus_rate_limited` applies to
unsigned health pings and announcement telemetry. Individual paths add their own guards. `HealthPing` is deduplicated
by `(timestamp, height)` per claimed origin *before* the signature verify and before the rate-limit spend, and the
dedup marker only advances after a successful verify, so a spoofed future timestamp cannot poison a real origin's
floor. Its signature is checked against the public key resolved from the consensus registry, and a signed head is
relayed onward only when its height exceeds the known signed-head maximum by at least `HEAD_REPLY_MIN_GAP` 8, then only
to k peers sorted by Kademlia bucket, excluding the origin and the immediate sender. `ProducerHeartbeat` bounds replay
with a per-producer monotonic timestamp guard.

## HTTP node-to-node calls

Alongside QUIC, a node calls its peers' TCP API port. These are ordinary requests to the same public REST surface
documented in [rpc-api.md](../developers/rpc-api.md), so peers reach each other on port 8001 as well as on the QUIC
port.

| Call | Made by | Purpose |
| --- | --- | --- |
| `POST /api/v1/auth/challenge` | `verify_peer_authenticity` | Authenticates a bootstrap candidate before it enters the peer table |
| `GET /api/v1/microblock/{height}` | `check_block_exists_on_network` | Corroborates a height against several peers at once |

`check_block_exists_on_network` answers first from the signed heights already held in the peer table and falls back to
the HTTP probe when that is inconclusive. The sample size scales with the peer count — 3 peers on networks of 5 or
fewer, 5 up to 100, 7 above that — chosen at random and queried in parallel with a 3 s per-peer timeout under a 5 s
global budget. Each response body is parsed and checked before it counts, so a peer that answers 200 with empty or
malformed content does not register as holding the block.

## Ports

| Port | Protocol | Purpose | Reachability |
| --- | --- | --- | --- |
| 10876 | UDP | QUIC peer-to-peer (`QUIC_PORT`) | Must be reachable inbound for a Super node |
| 8001 | TCP | REST, JSON-RPC and WebSocket on one listener | Required for API clients and for the peer calls above; see [rpc-api.md](../developers/rpc-api.md) |
| 8101 | TCP | Prometheus metrics on `GET /metrics`, served by a second warp server at API port + 100 | Bound on all interfaces for local and monitoring access |

The QUIC endpoint binds `0.0.0.0:10876`. Peer addresses are recorded throughout as `ip:8001` and the QUIC socket
address is derived by adding `QUIC_PORT_OFFSET` 2875 to that port, so the two ports move together: changing the API
port changes the P2P port by the same amount. `QNET_P2P_PORT` (default 9876) is read at boot for a bind probe, node
labelling and the UPnP mapping attempt; the QUIC listener stays on `QUIC_PORT`. Environment variables are catalogued in
[configuration.md](../operators/configuration.md).

## NAT traversal

External-IP discovery under Docker honours `QNET_EXTERNAL_IP` and then `DOCKER_HOST_IP`. The address is otherwise
resolved by shelling out to `curl https://api.ipify.org`, then `hostname -I`, then reading the local address of a UDP
socket connected to a public resolver.

Port forwarding is attempted by shelling out to the external `upnpc` binary (from miniupnpc) when it is present on
PATH, for the configured node port. It is skipped under Docker, where ports are mapped by the container runtime, and
failure is non-fatal. Inbound QUIC reachability on UDP 10876 requires an explicit mapping: a forwarded router port or a
host-mapped container port.

Live inbound connections are additionally indexed by the peer's advertised listen address in
`INBOUND_CONN_BY_LISTEN_ADDR`. Such a connection lives under an ephemeral source port in the transport pool, so a send
targeting the advertised port would miss and re-dial a port NAT cannot accept inbound; consulting this index pushes
shreds and blocks back over the existing connection instead.

## IP privacy

Node logs refer to peers by a stable label rather than an address. `get_privacy_id_for_addr` derives it: a
genesis address becomes `genesis_node_{id}` (public information), an RFC 1918 private address becomes
`private_{8 hex}`, and any other address becomes `node_{8 hex}`, where the hex is a truncated BLAKE3 digest of a
domain-separated form of the IP. A 172.x address is treated as private for second octets 16 through 31. The mapping is
deterministic, so operators can correlate log lines about the same peer without the log exposing the address. It
applies to log output; on the wire, peer addresses are exchanged as plain `ip:port` in `PeerListResponse` and
`FindNodeResponse`, and the source IP of every connection is visible to its peer.

## Related documents

[overview.md](overview.md) places this layer in the wider node; [consensus.md](consensus.md) gives the semantics of the
consensus and failover messages; [cryptography.md](cryptography.md) covers ML-DSA-65, SHA3-256 and the TLS primitives;
[../operators/maintenance.md](../operators/maintenance.md) covers restart, upgrade and recovery.
