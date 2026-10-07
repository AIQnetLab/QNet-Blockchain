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

// Device-side light-node paths. Native modules are mocked in jest.setup.js; signing and the network are
// mocked here so each test sees exactly which node the device talks to.
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
}));

describe('light node wakes and token refresh', () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  const Keychain = require('react-native-keychain');
  const BackgroundFetch = require('react-native-background-fetch').default;
  const Push = require('../src/services/PushService');
  const NODE = 'light_mobile_83afab763b9058fd'; // shard 3: owners 004, 005, 001
  const REFRESH = '/api/v1/light-node/token-refresh';
  const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  let calls;

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    Keychain.getGenericPassword.mockResolvedValue(false);
    calls = [];
  });

  const withPingKey = async () => {
    Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
    await AsyncStorage.setItem(`qnet_ping_dilithium_pk_${NODE}`, 'pk');
  };
  // A binding an older build made (no sequence): only such a device sends its push target anywhere.
  const linkedHere = () => AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'fcm' })],
    ['qnet_ping_node_id', NODE],
  ]);

  it('sends a token refresh to the shard owners in rank order and stops at the first success', async () => {
    await withPingKey();
    await linkedHere();
    global.fetch = jest.fn((url) => { calls.push(url); return reply({ success: calls.length === 2 }); });
    const res = await Push.refreshFcmTokenOnServer(NODE);
    expect(res.success).toBe(true);
    expect(calls).toEqual(lightShardOwnerUrls(NODE).slice(0, 2).map(u => u + REFRESH));
  });

  it('sends no push target for a node that is not linked to this device', async () => {
    await withPingKey();
    global.fetch = jest.fn((url) => { calls.push(url); return reply({ success: true }); });
    expect(await Push.refreshFcmTokenOnServer(NODE)).toEqual({ success: false, error: 'not_linked' });
    expect(calls).toEqual([]);
  });

  it('falls back to another node only after every owner failed', async () => {
    await withPingKey();
    await linkedHere();
    global.fetch = jest.fn((url) => { calls.push(url); return reply({ success: calls.length === 4 }); });
    const res = await Push.refreshFcmTokenOnServer(NODE);
    expect(res.success).toBe(true);
    expect(calls.slice(0, 3)).toEqual(lightShardOwnerUrls(NODE).map(u => u + REFRESH));
    expect(GENESIS_NODES.map(u => u + REFRESH)).toContain(calls[3]);
  });

  it('self-attests when a pushed ping is refused', async () => {
    // No ping key in the Keychain: the challenge answer fails, as it does for an expired stamp.
    global.fetch = jest.fn((url) => {
      calls.push(url);
      return reply(url.endsWith('/api/v1/height') ? { height: 1000 } : {});
    });
    await Push.handlePushMessage({ action: 'ping_response', challenge: 'c', node_id: NODE, response_url: 'http://x' });
    expect(calls.some(u => u.endsWith('/api/v1/height'))).toBe(true);
  });

  it('does not self-attest when the pushed ping was answered', async () => {
    await withPingKey();
    global.fetch = jest.fn((url) => { calls.push(url); return reply({ success: true }); });
    // A real stamp shape (nonce ‖ expiry ‖ mac), from genesis 003 naming itself by address.
    const expiry = Buffer.alloc(8); expiry.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000) + 600));
    const stamp = Buffer.concat([Buffer.alloc(16, 1), expiry, Buffer.alloc(16, 2)]).toString('hex');
    const ok = await Push.handlePushMessage({ action: 'ping_response', challenge: stamp, node_id: NODE, response_url: 'http://161.97.86.81:8001' });
    expect(ok).toBe(true);
    expect(calls).toEqual(['https://node3.aiqnet.io/api/v1/light-node/ping-response']);
  });

  it('configures the periodic wake for an FCM phone', async () => {
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'fcm' }));
    global.fetch = jest.fn(() => reply({}));
    await Push.initializePushService();
    await new Promise(r => setTimeout(r, 50)); // let the fire-and-forget app-open attest settle
    expect(BackgroundFetch.configure).toHaveBeenCalledWith(
      expect.objectContaining({ minimumFetchInterval: 30, stopOnTerminate: false, enableHeadless: true }),
      Push.onBackgroundFetch, expect.any(Function));
    expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
  });

  it('self-attests on every background wake; only a polling phone in its window pulls the challenge', async () => {
    const inWindow = Math.floor(Date.now() / 1000) + 60;
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    global.fetch = jest.fn((url) => { calls.push(url); return reply({}); });
    for (const pushType of ['fcm', 'polling']) {
      calls = [];
      // A reply with no height is a failure to retry (F10): its short wait would keep the next wake silent.
      await AsyncStorage.removeItem('qnet_self_attest_hold');
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType, nextPingTime: inWindow }));
      await Push.onBackgroundFetch(`t-${pushType}`);
      expect(calls.some(u => u.endsWith('/api/v1/height'))).toBe(true);
      expect(calls.some(u => u.includes('/pending-challenge'))).toBe(pushType === 'polling');
      expect(BackgroundFetch.finish).toHaveBeenCalledWith(`t-${pushType}`);
    }
  });

  it('sends nothing while an attested epoch cannot have ended; a forced attest still goes out', async () => {
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    global.fetch = jest.fn((url) => { calls.push(url); return reply(url.endsWith('/api/v1/height') ? { height: 1339300 } : {}); });
    await AsyncStorage.setItem('qnet_last_self_attest_epoch', String(Math.floor(1339300 / 14400)));
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false); // already attested: holds until the epoch can end
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(calls).toEqual([]);
    await Push.selfAttestIfNeeded(NODE, true);
    expect(calls.some(u => u.endsWith('/api/v1/height'))).toBe(true);
  });

  it('backs off after a refused self-attestation instead of re-signing on every wake', async () => {
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    global.fetch = jest.fn((url) => {
      calls.push(url);
      if (url.endsWith('/api/v1/height')) return reply({ height: 1000 });
      if (url.includes('/api/v1/microblock/')) return reply({ previous_hash: new Array(32).fill(1) });
      return reply({});
    });
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false); // no ping key in the Keychain: refused
    calls = [];
    expect(await Push.selfAttestIfNeeded(NODE)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('ignores a hold written under a clock that has since moved back, or longer than any hold', async () => {
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    global.fetch = jest.fn((url) => { calls.push(url); return reply({}); });
    const now = Date.now();
    for (const hold of [
      { nodeId: NODE, at: now + 3600000, until: now + 5400000, failures: 1 }, // clock moved back, under the cap
      { nodeId: NODE, at: now - 1000, until: now + 3 * 3600000, failures: 0 }, // longer than the cap
    ]) {
      calls = [];
      await AsyncStorage.setItem('qnet_self_attest_hold', JSON.stringify(hold));
      await Push.selfAttestIfNeeded(NODE);
      expect(calls.some(u => u.endsWith('/api/v1/height'))).toBe(true);
    }
  });

  it('reads a rate-limited status reply as unknown, not as absent from the chain', async () => {
    const { readNodeStatus } = require('../src/services/LightNode');
    global.fetch = jest.fn((url) => { calls.push(url); return reply({ success: false, error: 'Rate limit exceeded' }); });
    expect((await readNodeStatus(NODE)).onChain).toBeNull();
    // Only the node's shard owners are asked.
    expect(calls.map((u) => u.split('/api/')[0]).sort()).toEqual([...lightShardOwnerUrls(NODE)].sort());
  });
});
