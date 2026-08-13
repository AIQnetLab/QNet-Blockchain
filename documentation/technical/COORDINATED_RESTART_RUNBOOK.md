# Coordinated restart — runbook

The recovery procedure for a halted or forged chain. **Rehearse this on testnet before mainnet launch.**
An unrehearsed runbook is not a recovery plan.

## Why this exists

QNet has no staking. There is nothing to slash and nothing to leak, so the chain cannot bleed a stalled
quorum back to liveness the way a bonded chain does. Four impossibility results say the stall itself
cannot be prevented in-protocol:

| | |
|---|---|
| **T1** | No public witness can prove work. The heartbeat preimage `QNET_HEARTBEAT:{node_id}:{anchor_height}:{anchor_hash}` is entirely public, so it is script-forgeable. So is an empty microblock: its `state_root` equals the previous block's, and both are public. |
| **T2** | Per-identity costs cannot exceed flat per-identity income. |
| **T3** | A farm amortises any cost better than a single honest operator. |
| **T4** | A participation filter is either non-reproducible (a hashed checkpoint field must be a pure function of persisted data; participation is an observation), or frozen during the halt it exists to end, or inert at target scale. |

What remains is what every non-slashing chain actually does: **make the halt reversible.** A
coordinated restart is the established recovery procedure for this class of network.

**What a restart does NOT do.** It does not prevent the halt, does not make the attack expensive, and
does not remove the attacker's ability to buy new identities. It converts "the chain is dead" into
"the chain lost N hours". That is the whole claim. Do not describe it as anything more.

## Preconditions — when to restart

Restart only when **all** of these hold. Anything less is a bug to fix, not an incident to restart from.

1. Finality has not advanced for **> 2 hours** (production stops on its own ~48 min past the last seal,
   at the `roster_derivation_horizon`).
2. The recovery relaxation could not clear it — either it never armed, or it armed and the span expired
   with no seal. Check `node_recoveryStatus` on several nodes.
3. There is no software fix that restores liveness without abandoning chain data.

For a **forged finality** incident (a committee majority certified a bad `state_root`) the trigger is
different: restart as soon as it is confirmed, and pick `K` strictly **below** the first bad macroblock.

## Procedure

### 1. Freeze and gather

Stop producing. Collect from every reachable operator:

* the last macroblock index each node holds, and its `MacroBlock::hash()`;
* `node_recoveryStatus` output;
* the committee for the stuck window (`consensus_committee` of the last sealed macroblock).

### 2. Choose `K`

`K` = the newest macroblock that is **full-quorum sealed** and that **every** surviving operator agrees
on by hash. Never pick a macroblock only some nodes hold. For a forgery incident, `K` must be below the
first macroblock carrying forged state.

Record `hash(MB_K)`, and the committee-fields digests for `K` and `K-1`
(`galc::committee_fields_digest`) — the release needs all four values.

### 3. Build the exclusion list

The identities that were in the committee at the stall and did not vote.

**This is an off-chain, human judgement.** The chain cannot prove non-participation — that is T4. The
list is assembled from operator logs and published **with the evidence** so anyone can disagree before
the release ships. Getting this wrong bars an honest operator, so:

* only list identities that **multiple independent** operators observed as silent;
* prefer under-listing — a restart that leaves a few freeloaders in still recovers if the survivors
  clear quorum;
* the list must be **sorted and deduplicated** (the build fails otherwise).

### 4. Cut the release

In `development/qnet-integration/src/genesis_constants.rs`, set **together**:

```rust
pub const WS_CHECKPOINT: (u64, [u8; 32]) = (K, hash_of_MB_K);
pub const WS_CHECKPOINT_DIGEST_ANCHOR: [u8; 32] = digest_of_MB_K;
pub const WS_CHECKPOINT_DIGEST_PRED:   [u8; 32] = digest_of_MB_K_minus_1;

pub const RESTART_MANIFEST: RestartManifest = RestartManifest {
    resume_from_mb: K,
    resume_mb_hash: hash_of_MB_K,
    excluded: &["node_...", "node_..."],   // sorted, deduplicated
};
```

`restart_manifest_is_wellformed()` refuses to start the node if these disagree, if a digest is zero, or
if the list is unsorted. That check runs before storage opens — a malformed manifest is a broken
release, not a runtime condition.

**Why a compiled constant and not a signed message a running node accepts:** a restart re-roots trust.
An online authority able to re-root the chain is a worse standing risk than the halt it repairs. As a
`const` it is inert until someone publishes a release, the change is a reviewable diff, and a node
either runs that release or does not join.

### 5. Publish before executing, and confirm a retained-state source

Post, in one place, before anyone restarts:

* `K`, `hash(MB_K)`, both digests;
* the exclusion list **and the evidence for each entry**;
* the release commit hash and build instructions;
* the wall-clock time operators should start.

A restart without a published record is indistinguishable from an attack on the chain.

**PRECONDITION (mandatory).** At least one reachable node MUST retain chain state at or below `K` and
serve its snapshot. Balances at `K > 0` survive ONLY as retained chain data — there is no re-mint path
in the code. Designate that archival node, and confirm it answers a `K`-height snapshot request, BEFORE
anyone wipes. If no node retains `≤ K` state, the ledger is unrecoverable; do not proceed.

### 6. Execute

Every operator, including genesis:

```bash
docker stop qnet-node
```

Wipe chain data **above `K` only**. Do NOT wipe the data directory entirely unless the archival node
from step 5 is confirmed serving `≤ K` — a full wipe on every node destroys the ledger, and the boot
guard (`[FATAL][GEN] WS restart pin active … refusing to mint`) will halt an empty node under the pin
rather than re-mint a zero-state genesis. The pin path (`v2_ws_pin_mismatch`, `v2_below_ws`) rejects the
abandoned branch automatically, so a node that keeps stale data above `K` fails closed rather than forking.

Then run the new release. The archival node and genesis nodes first, then the rest.

### 7. Verify recovery

* Blocks are produced **and** finality advances (`committed_index` rises on several nodes).
* `eligible_producers` of the first newly sealed macroblock contains **none** of the barred identities.
* No node logs `[FATAL][RESTART] malformed_manifest`.
* Cross-check the tip hash across at least three operators.

### 8. Retire the manifest

Once the chain has been stable for a full epoch, the **next** release keeps the bumped `WS_CHECKPOINT`
(that is the ordinary bump discipline) and sets `RESTART_MANIFEST` back to inert **only if** the barred
identities should be allowed to re-register. Leaving them barred is a policy choice — state it publicly
either way.

**Un-barring is a COORDINATED cut-over, never a rolling upgrade.** `restart_excludes` filters the
derived producer/committee set, which feeds `consensus_committee` → `epoch_commitment` (a QC-bound
field). If some nodes un-bar a still-heartbeating identity before others, the two derive different
committees for the crossover windows and disagree on those checkpoints until the fleet converges. So:
publish a wall-clock cut-over, and un-bar only identities that are already heartbeat-absent (a dead
identity's removal is a no-op — the safe case). Barring (the restart itself) is already coordinated by
the WS pin; only retirement needs this note.

## Rehearsal checklist

Run the whole thing on testnet, timed, before mainnet:

- [ ] Halt a testnet deliberately (stop > 1/3 of the committee).
- [ ] Confirm production stops at the expected horizon (~48 min past the last seal).
- [ ] Choose `K`, verify the hash agrees across operators.
- [ ] Cut a release with a non-empty exclusion list.
- [ ] Confirm a node with stale data above `K` **fails closed** instead of forking.
- [ ] Confirm a malformed manifest refuses to start.
- [ ] Measure wall-clock from decision to restored finality. Publish that number.
