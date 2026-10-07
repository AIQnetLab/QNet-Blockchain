/**
 * The ping key answers the network's short status requests, and the same key authorises token refreshes.
 * So it signs exactly the two challenge forms the node issues (rpc/light_nodes.rs
 * handle_light_node_ping_response): a server stamp — hex of nonce(16) ‖ expiry(u64 BE) ‖ mac(16), from
 * rpc/mod.rs make_challenge_stamp — or the device's own "selfattest:{height}:{hash}". Anything else, and
 * any answer address outside the genesis names, is refused before anything is signed or sent.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { Platform } = require('react-native');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const { signWithDilithium, signDetached } = require('../src/crypto/DilithiumCrypto');
const Push = require('../src/services/PushService');
const { pollPreimage } = require('../src/crypto/NodePreimages');
const { GENESIS_NODES } = require('../src/config/nodes');

const NODE = 'light_mobile_83afab763b9058fd'; // shard 3: owners node4, node5, node1
const NOW = Math.floor(Date.now() / 1000);

function stamp(expirySecs, { nonce = 1, mac = 2 } = {}) {
  const e = Buffer.alloc(8);
  e.writeBigUInt64BE(BigInt(expirySecs));
  return Buffer.concat([Buffer.alloc(16, nonce), e, Buffer.alloc(16, mac)]).toString('hex');
}

describe('the challenge grammar', () => {
  it('accepts a server stamp and the device’s own self-attestation', () => {
    expect(Push.isSignableChallenge(stamp(NOW + 180), NOW)).toBe(true);
    expect(Push.isSignableChallenge(stamp(NOW + 14400), NOW)).toBe(true); // an epoch-long stamp
    expect(Push.isSignableChallenge(`selfattest:2097300:${'ab'.repeat(32)}`, NOW)).toBe(true);
  });

  it('refuses everything the same key could be tricked into authorising', () => {
    for (const c of [
      `token_refresh:${NODE}:${NOW}`,
      `delegate_ping:${'a'.repeat(3904)}:${NODE}`,
      `q1337|transfer:a:b:1:2:3:4`,
      `ping:v2:${'ab'.repeat(32)}:${NOW}`,
      stamp(NOW + 180).toUpperCase(),                 // the node emits lowercase hex only
      stamp(NOW + 180).slice(2),                      // 39 bytes
      `${stamp(NOW + 180)}00`,                        // 41 bytes
      stamp(NOW + 30 * 86400),                        // expiry far beyond any epoch
      stamp(NOW - 30 * 86400),                        // long expired
      `selfattest:2097300:${'AB'.repeat(32)}`,
      `selfattest:2097300:${'ab'.repeat(32)}:x`,
      `selfattest:-1:${'ab'.repeat(32)}`,
      '', null, undefined, 42,
    ]) {
      expect([c, Push.isSignableChallenge(c, NOW)]).toEqual([c, false]);
    }
  });
});

describe('answering a ping', () => {
  let calls;
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
    await AsyncStorage.setItem(`qnet_ping_dilithium_pk_${NODE}`, 'pk');
    calls = [];
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
  });

  it('never signs a string that is not a challenge, from a push or anywhere else', async () => {
    const ok = await Push.respondToChallenge(NODE, `token_refresh:${NODE}:${NOW}`, 'https://node1.aiqnet.io');
    expect(ok).toBe(false);
    expect(signWithDilithium).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('never sends an answer outside the genesis names', async () => {
    for (const url of ['https://operator.example.org', 'http://203.0.113.9:8001', 'https://node1.aiqnet.io.evil.example']) {
      expect(await Push.respondToChallenge(NODE, stamp(NOW + 180), url)).toBe(false);
    }
    expect(signWithDilithium).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('answers the genesis node that issued the stamp, at its public name', async () => {
    expect(await Push.respondToChallenge(NODE, stamp(NOW + 180), 'http://62.171.157.44:8001')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://node2.aiqnet.io/api/v1/light-node/ping-response']);
    expect(signWithDilithium).toHaveBeenCalledWith(stamp(NOW + 180), 'sk', 'pk', NODE);
  });

  it('with no answer address, answers the node’s own shard owner', async () => {
    expect(await Push.respondToChallenge(NODE, stamp(NOW + 180), null)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${GENESIS_NODES[3]}/api/v1/light-node/ping-response`]);
  });

  it('a polling phone takes its challenge from a genesis node and answers only that node', async () => {
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'polling' }));
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url });
      if (url.includes('/pending-challenge')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, has_challenge: true, challenge: `token_refresh:${NODE}:${NOW}` }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
    await Push.checkPendingChallenge();
    const hosts = calls.map((c) => new URL(c.url).origin);
    for (const h of hosts) expect(GENESIS_NODES).toContain(h);
    // The challenge it was handed is a token-refresh preimage, not a stamp: nothing is signed or posted.
    expect(calls.some((c) => c.url.endsWith('/ping-response'))).toBe(false);
    expect(signWithDilithium).not.toHaveBeenCalled();
  });

  it('a polling phone with no ping key, or one that cannot sign, polls unsigned and still takes its challenge', async () => {
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'polling' }));
    global.fetch = jest.fn((url) => {
      calls.push({ url });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, has_challenge: false }) });
    });
    Keychain.getGenericPassword.mockResolvedValue(false);
    await Push.checkPendingChallenge();
    Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
    signDetached.mockRejectedValueOnce(new Error('native'));
    await Push.checkPendingChallenge();
    signDetached.mockResolvedValueOnce('ab'.repeat(100)); // not a whole signature
    await Push.checkPendingChallenge();
    expect(calls).toHaveLength(3);
    for (const { url } of calls) {
      expect(new URL(url).search).toBe(`?node_id=${NODE}`);
    }
  });

  it('a token refresh goes only to genesis nodes, shard owners first', async () => {
    await AsyncStorage.multiSet([
      ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'fcm' })], ['qnet_ping_node_id', NODE],
    ]);
    global.fetch = jest.fn((url) => { calls.push({ url }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) }); });
    await Push.refreshFcmTokenOnServer(NODE);
    const hosts = calls.map((c) => new URL(c.url).origin);
    expect(hosts).toHaveLength(GENESIS_NODES.length);
    expect(new Set(hosts)).toEqual(new Set(GENESIS_NODES));
    expect(hosts.slice(0, 3)).toEqual([GENESIS_NODES[3], GENESIS_NODES[4], GENESIS_NODES[0]]);
  });
});

// L-5: the node counts a polling device as having fetched its challenge only when the poll is signed with its ping key
// (rpc/light_nodes.rs note_poll_fetched: `ts` within 300 s and `sig`, 6618 hex, over light_binding.rs
// light_poll_message). The same JS signs on iOS and Android, through the native signDetached of each.
describe('the signed poll', () => {
  const REPO = path.join(__dirname, '../../..');
  const SIG = 'c3'.repeat(3309);
  let urls;
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
    signDetached.mockResolvedValue(SIG);
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'polling' }));
    urls = [];
    global.fetch = jest.fn((url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, has_challenge: false }) });
    });
  });

  it('is the node\'s message, word for word', () => {
    expect(pollPreimage(NODE, 1700000000)).toBe(`q1337|light_poll:${NODE}:1700000000`);
    expect(() => pollPreimage('light_other', 1)).toThrow(TypeError);
    expect(() => pollPreimage(NODE, -1)).toThrow(TypeError);
    const binding = fs.readFileSync(path.join(REPO, 'development/qnet-integration/src/light_binding.rs'), 'utf8');
    expect(binding).toMatch(/pub fn light_poll_message\(node_id: &str, ts: u64\) -> String \{\s+format!\("\{\}light_poll:\{\}:\{\}", qnet_state::transaction::chain_tag\(\), node_id, ts\)/);
    const route = fs.readFileSync(path.join(REPO, 'development/qnet-integration/src/rpc/light_nodes.rs'), 'utf8');
    expect(route).toContain('params.get("ts")');
    expect(route).toContain('params.get("sig")');
    const doc = fs.readFileSync(path.join(REPO, 'docs/protocols/light-node-messages.md'), 'utf8');
    expect(doc).toContain('| Signed poll | `q1337\\|light_poll:{N}:{ts}` | ping key |');
  });

  it.each(['android', 'ios'])('on %s, a polling phone signs its poll with the ping key: ts now and sig', async (os) => {
    const was = Platform.OS;
    Platform.OS = os;
    try {
      const before = Math.floor(Date.now() / 1000);
      await Push.checkPendingChallenge();
      const after = Math.floor(Date.now() / 1000);
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0]);
      expect(GENESIS_NODES).toContain(url.origin);
      expect(url.pathname).toBe('/api/v1/light-node/pending-challenge');
      expect([...url.searchParams.keys()]).toEqual(['node_id', 'ts', 'sig']);
      const ts = Number(url.searchParams.get('ts'));
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
      expect(url.searchParams.get('sig')).toBe(SIG);
      expect(signDetached).toHaveBeenCalledTimes(1);
      expect(signDetached).toHaveBeenCalledWith(`q1337|light_poll:${NODE}:${ts}`, 'sk');
      expect(Keychain.getGenericPassword).toHaveBeenCalledWith({ service: `qnet_ping_sk_${NODE}` });
    } finally {
      Platform.OS = was;
    }
  });

  it('signs no challenge it is handed with the poll\'s key path, and answers a stamp as before', async () => {
    const challenge = stamp(NOW + 180);
    global.fetch = jest.fn((url) => {
      urls.push(url);
      const body = url.includes('/pending-challenge') ? { success: true, has_challenge: true, challenge } : { success: true };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });
    await AsyncStorage.setItem(`qnet_ping_dilithium_pk_${NODE}`, 'pk');
    expect(await Push.checkPendingChallenge()).toEqual(expect.objectContaining({ has_challenge: true }));
    // the poll's signature is over the poll message only; the challenge is answered by the ping reply's own signing
    expect(signDetached.mock.calls.map(([message]) => message)).toEqual([expect.stringMatching(/^q1337\|light_poll:/)]);
    expect(signWithDilithium).toHaveBeenCalledWith(challenge, 'sk', 'pk', NODE);
    expect(urls.filter((u) => u.endsWith('/ping-response'))).toHaveLength(1);
  });
});
