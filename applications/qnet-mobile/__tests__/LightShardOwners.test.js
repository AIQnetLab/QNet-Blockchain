/**
 * The device picks which genesis nodes to send its return to, so its shard arithmetic must be the
 * chain's arithmetic. These expectations were produced by the node itself (node/mod.rs
 * light_shard_of) — if the two ever drift, the return goes to nodes that do not own the shard, are
 * not the ones that record eligibility, and have to relay it to whoever does. That relay carries the
 * signature without the ping key it was signed with, which is exactly how a reinstalled device ends
 * up attesting into a void.
 */
import { lightShardOwnerUrls, GENESIS_NODES } from '../src/config/nodes';

// node/mod.rs: blake3(node_id)[..8] as a little-endian u64, mod 5.
const NODE_REFERENCE = {
  light_mobile_83afab763b9058fd: 3,
  light_mobile_0000000000000001: 0,
  light_mobile_deadbeefdeadbeef: 4,
  light_mobile_abcdef0123456789: 2,
  light_mobile_ffffffffffffffff: 1,
};

describe('light shard owners', () => {
  it('derives the same shard the chain does', () => {
    for (const [nodeId, shard] of Object.entries(NODE_REFERENCE)) {
      // light_shard_owners: the shard's own genesis and the next two around the ring.
      const expected = [shard % 5, (shard + 1) % 5, (shard + 2) % 5].map(i => GENESIS_NODES[i]);
      expect(lightShardOwnerUrls(nodeId)).toEqual(expected);
    }
  });

  it('puts the primary owner first, then the two that cover for it', () => {
    // Shard 3 is owned by genesis 004, backed by 005 and 001 — the live case: the attestation landed
    // on 004 and both backups refused it, because a relayed attestation carries no key.
    expect(lightShardOwnerUrls('light_mobile_83afab763b9058fd'))
      .toEqual([GENESIS_NODES[3], GENESIS_NODES[4], GENESIS_NODES[0]]);
  });

  it('never returns an empty target list', () => {
    // A device with nothing to hash still has to reach someone, or the return is silently lost.
    expect(lightShardOwnerUrls('').length).toBe(GENESIS_NODES.length);
    expect(lightShardOwnerUrls(null).length).toBe(GENESIS_NODES.length);
    expect(lightShardOwnerUrls('light_mobile_83afab763b9058fd').length).toBe(3);
  });
});
