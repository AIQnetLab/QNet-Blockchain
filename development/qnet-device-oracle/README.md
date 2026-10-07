# QNet device oracle

## Purpose

The device oracle keeps "one phone or tablet runs at most one light node at a time" true across
reinstalls, wallet switches and device resets. It is the only holder of the Apple key with DeviceCheck
enabled and of the Google Play Integrity keys. It reads and writes the few per-device bits that Apple and
Google keep for our apps, and it measures the multiplicity signals the platforms offer (the App Attest risk
metric, the attestation certificate count). It signs a lease statement that the five genesis nodes attach
to each device statement. These bits and signals are used only to limit abuse and fraud in node crediting.
They never identify, fingerprint or track a person or a device. They are never the only reason for a
penalty. Support can read the tickets of a reference and record an approval, but no node message carries
the approval's `reset_ref` yet (the protocol's `reset` reason is reserved), so an approval lifts no pause
today. The oracle cannot mint a device on its own: the genesis attestors verify the hardware evidence
themselves.

It is not on the per-reply path. Only enrolment, key rotation, lease refresh, release and the support
routes reach it. The message formats are in [light-node-messages.md](../../docs/protocols/light-node-messages.md)
sections 5 and 6. The oracle checks App Attest receipts, Play Integrity verdicts and the revocation list
with [`qnet-device-attest`](../../core/qnet-device-attest), the verifier the genesis attestors use. That
crate also holds the app identities (Team ID, bundle id, package, signing-certificate digests) and the
pinned Apple root, so none of them is configuration.

## What it does

| Area | Behaviour |
| --- | --- |
| Slot lease | `g = 2·b1 + b0` in Apple's two bits or Google's first two recall bits. The oracle picks every value at random and never lets the client choose. A claim never refuses an occupied slot: it classifies the value it replaces as `claimed_virgin`, `self_reclaim` or `claimed_foreign`. The current epoch applies only to a never-used slot with a never-bound key, or to a self-reclaim. A claim by the install that already holds the node's value (the same device key, its record live or released within 30 days) is judged as a refresh would judge it: another install's value is a strike, a second one with corroboration a pause, so claiming again never skips the slot check. The value the install's last other node on that key wrote (a wallet switch inside the install) is its own. Live strikes keep the 12-hour suspect lease under any state. |
| Refresh | Reads the slot and compares it with the node's own value. A match passes and rotates the value (iOS on every refresh, Android on every second). The node's previous value counts as a lost write. An unused slot is an anomaly; two in 90 days make the node `suspect`. Any other value is a strike. |
| Two strikes | A second foreign read within 7 days pauses the node for 30 days only when an independent signal agrees: on iOS a risk metric of 3 or more in the same 30 days; on Android recent device activity at level 3 or more, a high certificate count, or a second live key under one remote-provisioned attestation key. Accrued balance is never touched. |
| Hold | Android only. The third recall bit is set with a pause. It never lasts longer than 30 days: for the install whose pause set it, 30 days from that write; for any other install, where Google gives only the month of the write, 30 days from the start of that month. The first claim or refresh after that clears it; an approved support reset would clear it at once, but no node message carries one yet. |
| Release | The slot is never written as free. The node keeps its value 30 days for a self-reclaim only. If a token comes with the release, the value is rotated. A running pause does not end with the release. |
| Device keys | A key belongs to one node while that node's live record names it. After Stop, a move of the node to another device or a rotation, the install may link another wallet's node with it; that counts as a rebind. A rotation drops the old key's receipt and moves its hold record and rebind history to the new key. |
| Outages | Refreshes during a vendor outage extend leases that were clean, by the outage length, capped at 7 days. A new binding without a slot read is `check_pending` and never counts; its first slot read completes the claim, without an anomaly or a strike. |
| Gates | iOS risk metric above R (4) and Android certificate count above B (100). They are log-only until `gates.enforce`. The oracle is the one place that decides this: in log-only mode the statement says `ok` and the answer carries `gate_observed`. A rotation re-checks the gate with the new key's evidence and ends a hold when it passes. An Android count comes with an attestation chain only, so the daily recheck of a held Android node answers `needs: rotation`. |
| Limits | Per node: 6 bindings a day and 20 in 30 days, self-reclaims free. Per device key: 1 rebind a day plus one free switch back. Per remote-provisioned attestation key: 2 foreign claims a day; a factory attestation key is shared by a batch of devices, so it carries no limit and no second-live-key signal (factory chains get the 1-day lease instead). Per IP: 30 an hour, held in memory only. A limit that does not depend on the slot read refuses before any vendor call. |
| Trust | `store` for the app as the stores sign it. `test` for our upload-key builds: accepted on testnet, refused on mainnet. |
| Replay | Every token's SHA-256 is kept 24 hours. A retry of the same request within 10 minutes gets the first answer again. A Play token must carry the nonce of its message, name our package and be at most 10 minutes old. |
| Evidence | Sealed with AES-256-GCM, 7 days for accepted cases and 90 days for refused, suspect and paused ones. Tokens and IP addresses are never stored. |
| Revocation | The Android attestation status list is fetched per its cache lifetime, between 1 and 24 hours, and served as one snapshot signed by the oracle. An alert is raised once the snapshot is a day old. |
| Alarms | Vendor outages (after 3 failures in a row) and recoveries, vendor credential failures, half the daily Play quota used, unbound tokens above the hourly threshold (quota burn), an invalid receipt, a stale revocation list, a standby falling behind. |

## API

Internal only: mutual TLS 1.3 with hybrid post-quantum key exchange preferred, on the port in `listen`. A
client is known by the SHA-256 of its certificate (`clients`), and its role decides the routes. Bodies are
JSON. A refusal is HTTP 422 `{"error": "<reason>", "ref"?, "until"?, "retry_at"?}`, with the reasons of
section 8 of the message spec.

| Role | Route | Body → answer |
| --- | --- | --- |
| genesis | `POST /v1/claim` | `{node_id, platform, op: enrol\|rebind, preimage, hw_pub, prov, trust, key_new?, att_key?, certs_issued?, att_key_multi?, receipt?, dc_token\|pi_token, reset_ref?, client_ip?, evidence?}` → `{lease_statement, oracle_sig, lease, effective, gate, gate_observed, state, check, lease_valid_until, refresh_at, device_tag, pi_jws, pi_digest, metric, ref, superseded, rebound_from, reset}` |
| genesis | `POST /v1/refresh` | `{node_id, preimage, dc_token\|pi_token}` → `{result: pass\|lost_write\|anomaly\|strike\|two_strikes\|hold\|deferred\|check_pending\|paused, state, reason, lease_valid_until, refresh_at, paused_until, ref}` |
| genesis | `POST /v1/rotate` | `{node_id, preimage, hw_pub, prov, trust, att_key?, certs_issued?, att_key_multi?, receipt?, dc_token\|pi_token, evidence?}` → as claim, plus `result` |
| genesis | `POST /v1/release` | `{node_id, preimage, dc_token?\|pi_token?}` → `{state: ended, reason: released}` |
| genesis | `POST /v1/recheck` | `{node_id}` → `{state, reason, check, gate_observed, metric, next_check_at, needs}` (daily, for a gate-held node; `needs: rotation` when only a new chain can re-measure it) |
| genesis | `POST /v1/pi-decode` | `{token, nonce}` → `{jws, pi_digest, verdict}` |
| genesis | `POST /v1/refusal` | `{node_id, platform, hw_pub, nonce, reason, evidence?}` → `{ref}` (a refusal the genesis issued, filed for appeals) |
| genesis | `GET /v1/crl` | → `{fetched_at, serials, list_sha3, preimage, sig}` |
| support | `GET /v1/support/ticket?ref=` | → the tickets for that reference with their evidence |
| support | `POST /v1/support/approve` | `{ref, node_id?, operator}` → approval, valid 30 days, used once by the next claim carrying `reset_ref` (no node message carries one yet) |
| replica | `GET /v1/replica/status`, `/log?after=&limit=`, `/dump?cf=&after=&limit=` | replication (primary only) |
| any | `GET /v1/health` | role, network, sequence, schema, `synced`, `sync_in_progress`, revocation-list age, open outages, `oracle_key_sha3` |

For the genesis side:
- Verify every oracle signature under the pinned public key (`qnet-device-oracle pubkey`).
- Pass Play tokens and DeviceCheck tokens only on the dedicated route. Never log or gossip them.
- Verify the public evidence before calling `claim` or `rotate`.
- Allow at least 30 seconds per call: a claim can make three vendor round trips.
- On a standby's `503 {"error": "standby"}`, call the other oracle.

The client certificate of each genesis node is installed at `/opt/qnet-oracle-client/{ca.crt,client.crt,client.key}`.

## Configuration and secrets

See [oracle.example.json](oracle.example.json). Hosts, URLs and secret paths are configuration.

| Secret | Placed by | Where |
| --- | --- | --- |
| Apple `.p8` key with DeviceCheck enabled | owner, from the developer account | `secrets/devicecheck.p8` |
| Play Integrity decryption and verification keys (base64 text) | owner, from the Play Console | `secrets/play_decryption.key`, `secrets/play_verification.key` |
| Service account limited to Play Integrity | owner, from the linked Cloud project | `secrets/service_account.json` |
| Oracle ML-DSA-65 signing key | `deploy-oracle.sh keys`, generated on the primary, copied to the standby | `secrets/oracle.key` |
| Evidence sealing key | same | `secrets/evidence.key` |
| Alert webhook URL | owner, optional | `secrets/alert_webhook.url` |
| TLS server key, and the standby's replication client key | `deploy-oracle.sh pki` and `install` | `tls/server.key`, `tls/replica.key` |

Every secret is owned by the oracle user (uid 10001) with mode 0400. A mainnet start refuses looser modes.
Secrets never go into the repository, the image or another container's environment.

## Operations

`scripts/deploy-oracle.sh` runs these steps with `ORACLE_PRIMARY`, `ORACLE_STANDBY` and `NETWORK` set,
plus `APPLE_KEY_ID` to switch iOS on and `ANDROID=1` to switch Android on:
`pki` → `install` → `keys` → (the owner places the vendor secrets) → `secrets-check` → `up` →
`client-certs` → `status`. Afterwards `check-logs` confirms no log line carries a token, and `promote`
turns the standby into the primary.

- The image is `ghcr.io/aiqnetlab/qnet-device-oracle`, tested and published by
  `.github/workflows/oracle-image.yml`; `BUILD_LOCAL=1` builds it from the checkout instead.
- The primary and the standby run on two hosts, each in its own container with the host network.
- The oracle port accepts the five genesis hosts (and the standby) only.
- The container runs read-only, without capabilities, as uid 10001, and rotates its logs.
- The standby follows the primary's log of committed batches. It copies the whole database when it is
  new or more than `replica_log_days` behind. Both oracles keep `replica_log_days` of that log and trim
  older entries every 10 minutes, so a promoted standby serves its log to the next standby. A copy in progress is marked from before its wipe until its
  last page: a primary starts only on a synced database or an empty one, so a standby promoted in the
  middle of a copy refuses to start instead of serving a partial database. Promote a standby whose
  `/v1/health` shows `synced: true`, `sync_in_progress: false` and the primary's last sequence; a refused
  promotion is recovered by finishing the sync or restoring a backup.
- The database records its schema. A build of another schema refuses to open it, and a standby does not
  follow a primary of another schema. A record that cannot be read or decoded answers 500: no operation
  goes on as if it were missing.
- Logs use `[LEVEL][SUBSYSTEM] event key=value`. Alerts also appear as `[WARN][ALERT]` lines for the
  log digest.

## Tests

```
cargo test
```

All tests use a scripted vendor side and never reach a vendor. They cover:
- every row of the lease table, lost writes and two strikes with and without corroboration;
- the hold, reset tickets, outages and the extension cap, and the gates in both modes;
- limits, replay, quota-burn alarms and rotation;
- Play tokens sealed and signed the way Google does it, checked by the shared verdict rules;
- the lease statement, tags, references, nonces and the revocation snapshot against the protocol vectors;
- replication, and the mutual-TLS roles.

Receipt signatures and the Apple sample are tested in `qnet-device-attest`; here receipts are handles
whose verified fields each test chooses.
