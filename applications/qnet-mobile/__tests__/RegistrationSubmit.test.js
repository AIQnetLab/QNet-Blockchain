/**
 * The registration QNet Wallet sends itself right after the user consents on the QNet Link sheet to a one-time payment
 * address's burn (services/RegistrationSubmit): exactly the consent body aiqnet.io's register route takes (the site's
 * registration.ts CONSENT_KEYS), sent at once, again through a network that fails while the consent's window
 * lasts, once per consent from this app, kept across a restart until the chain lists the node, one job per wallet's node.
 */
const fs = require('fs');
const { Buffer } = require('buffer');
const path = require('path');
const { b64url, lightNodeId, registrationProof } = require('../src/crypto/NodePreimages');
const { EXPLORER_API } = require('../src/config/nodes');

const QNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const NODE = lightNodeId(QNET);
const BURN = '3iZJZvXPL1uMy6yKz56wub9nCsgSNfrMZ5uEi4JMXn3wQnSPcwMorZtyFm1KkSzSQD8RJy4bkiuXo4NrzX4se5SD';
const BURNER = '38Kx8ihEdt6PBkve289FmW2G2xHW9HGxBQvnP8RZn7qq';
const PK = new Uint8Array(1952).fill(7);
const SIG = new Uint8Array(3309).fill(9);
const CONSENT = { ts: '1793031451', pk: b64url(PK), sig: b64url(SIG) };
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const TX = 'a'.repeat(64);
// Another wallet on the same device, and a third.
const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
const X = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
// Where a node's job is kept.
const key = (qnet) => `qnet_registration_submit:${lightNodeId(qnet)}`;

// The route's own key list, read from the site's source: the app sends exactly what the route takes.
const siteKeys = (name) => {
  const src = fs.readFileSync(path.join(__dirname, '../../qnet-explorer/frontend/src/lib/cabinet/registration.ts'), 'utf8');
  const list = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(src)[1];
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

const answer = (status, body) => Promise.resolve({ status, json: async () => body });

let R;
let AsyncStorage;
let clock;
let waits;
const sleep = async (ms) => { waits.push(ms); clock += ms; };
const now = () => clock;
const job = (over = {}) => ({ qnet: QNET, burnTx: BURN, consent: CONSENT, until: clock + 86400_000, ...over });
const site = async () => ({ burnTx: BURN, burnAmount: 1500 });

beforeEach(async () => {
  jest.resetModules();
  AsyncStorage = require('@react-native-async-storage/async-storage');
  await AsyncStorage.clear();
  R = require('../src/services/RegistrationSubmit');
  clock = 1_793_031_451_000;
  waits = [];
});

describe('the body', () => {
  it('has the route\'s keys exactly, in its order', () => {
    expect([...R.CONSENT_KEYS]).toEqual(siteKeys('CONSENT_KEYS'));
  });

  it('a one-time payment address\'s burn: the consent, the node, the proof, the burn and its amount, the key as hex', () => {
    const body = R.registrationBody({ ...job(), burnAmount: 1500 });
    expect(Object.keys(body)).toEqual([...R.CONSENT_KEYS]);
    expect(body).toEqual({
      from: QNET, node_id: NODE, node_type: 'light', wallet_address: QNET, registration_proof: registrationProof(BURN, NODE, QNET),
      timestamp: 1793031451, burn_tx_hash: BURN, burn_amount: 1500, dilithium_signature: hex(SIG), dilithium_public_key: hex(PK),
    });
  });

  it('nothing is built from a missing part', () => {
    for (const bad of [
      { ...job(), burnAmount: null }, { ...job(), burnAmount: 0 }, { ...job({ consent: { ...CONSENT, ts: 'x' } }), burnAmount: 1 },
      { ...job({ consent: { ts: CONSENT.ts, pk: CONSENT.pk } }), burnAmount: 1 },
      { ...job({ qnet: 'not a wallet' }), burnAmount: 1 }, { ...job({ burnTx: 'not a burn' }), burnAmount: 1 },
    ]) {
      expect(R.registrationBody(bad)).toBe(null);
    }
  });
});

describe('sending it', () => {
  it('goes at once after the consent to aiqnet.io\'s route; taken, it says so once and waits for the chain', async () => {
    const fetchFn = jest.fn(() => answer(200, { result: 'admitted', txHash: TX }));
    const onStage = jest.fn();
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: site, sleep, now, onStage })).toBe('admitted');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${EXPLORER_API}/api/cabinet/register`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual(R.registrationBody({ ...job(), burnAmount: 1500 }));
    expect(onStage.mock.calls).toEqual([['admitted']]);
    expect(waits).toEqual([]);
    // Kept until the chain lists the node; then forgotten, and nothing more goes.
    expect(JSON.parse(await AsyncStorage.getItem(key(QNET)))).toMatchObject({ qnet: QNET, burnAmount: 1500 });
    expect(await R.resumeRegistration(NODE, true, { now, fetchFn })).toBe(null);
    expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a network that fails and a busy route are waited out, 5 s doubling, with the identical body', async () => {
    const replies = [
      () => Promise.reject(new Error('offline')), () => answer(429, {}), () => answer(200, { result: 'retry', code: 'in_flight' }),
      () => answer(503, {}), () => answer(200, { result: 'registered' }),
    ];
    const fetchFn = jest.fn(() => replies.shift()());
    const onStage = jest.fn();
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: site, sleep, now, onStage })).toBe('registered');
    expect(waits).toEqual([5000, 10000, 20000, 40000]);
    expect(new Set(fetchFn.mock.calls.map((c) => c[1].body)).size).toBe(1);
    expect(onStage.mock.calls).toEqual([['registered']]);
  });

  it('its back-off ends at once when the network comes back or the app comes to the front (services/NetworkWake)', async () => {
    const { wakeRetries } = require('../src/utils/pause');
    const replies = [() => Promise.reject(new Error('offline')), () => answer(200, { result: 'registered' })];
    const fetchFn = jest.fn(() => replies.shift()());
    const sent = R.sendRegistration(job(), { fetchFn, readBurn: site, now });
    for (let i = 0; i < 200 && fetchFn.mock.calls.length < 2; i += 1) {
      wakeRetries();
      await new Promise((r) => { setImmediate(r); });
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await sent).toBe('registered');
  });

  it('after a wake its back-off starts again from 5 s, never from the pause it had reached', async () => {
    const { wakeRetries } = require('../src/utils/pause');
    const replies = [1, 2, 3, 4].map(() => () => Promise.reject(new Error('offline'))).concat(() => answer(200, { result: 'registered' }));
    const fetchFn = jest.fn(() => replies.shift()());
    const paused = [];
    const wakeful = async (ms) => { paused.push(ms); if (paused.length === 2) wakeRetries(); };
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: site, sleep: wakeful, now })).toBe('registered');
    expect(paused).toEqual([5000, 10000, 5000, 10000]);
  });

  it('a refusal, a request the route will not take or a stale consent stops at once and is forgotten', async () => {
    for (const reply of [
      () => answer(200, { result: 'refused', code: 'other_burn' }), () => answer(400, { error: 'invalid_request' }),
      () => answer(200, { result: 'stale' }),
    ]) {
      await AsyncStorage.clear();
      const fetchFn = jest.fn(reply);
      const onStage = jest.fn();
      expect(['refused', 'stale']).toContain(await R.sendRegistration(job(), { fetchFn, readBurn: site, sleep, now, onStage }));
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(onStage).not.toHaveBeenCalled();
      expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
    }
  });

  it('the app sends one at a time: a second call for the same consent, or a status read meanwhile, sends nothing more', async () => {
    let take;
    const fetchFn = jest.fn(() => new Promise((resolve) => { take = () => resolve({ status: 200, json: async () => ({ result: 'admitted', txHash: TX }) }); }));
    const a = R.sendRegistration(job(), { fetchFn, readBurn: site, sleep, now });
    const b = R.sendRegistration(job(), { fetchFn, readBurn: site, sleep, now });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(await R.resumeRegistration(NODE, false, { now, fetchFn, readBurn: site, sleep })).toBe(null);
    take();
    expect(await a).toBe('admitted');
    expect(await b).toBe('admitted');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('the consent\'s window ends it: nothing is sent once the route could only call it stale', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('offline')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await R.sendRegistration(job({ until: clock + 6000 }), { fetchFn, readBurn: site, sleep, now })).toBe('expired');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
    // A registration that never reached the route says so.
    expect(warn).toHaveBeenCalledWith('[WARN][NODEREG] registration_not_sent reason=expired');
    warn.mockRestore();
  });

  it('two wallets on one device: the second consent never takes the place of the first; each goes until the route takes it', async () => {
    // The first wallet's send got no answer and waits to go again when the second wallet's user consents.
    const fetchFn = jest.fn((url, init) => (JSON.parse(init.body).from === QNET && fetchFn.mock.calls.length === 1
      ? Promise.reject(new Error('offline')) : answer(200, { result: 'admitted', txHash: TX })));
    let goOn;
    const first = R.sendRegistration(job(), { fetchFn, readBurn: site, now, sleep: () => new Promise((r) => { goOn = r; }) });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(typeof goOn).toBe('function');
    expect(await R.sendRegistration(job({ qnet: W }), { fetchFn, readBurn: site, sleep, now })).toBe('admitted');
    goOn();
    expect(await first).toBe('admitted');
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).from)).toEqual([QNET, W, QNET]);
    // Both kept until the chain lists each node, and each read finds its own.
    expect(JSON.parse(await AsyncStorage.getItem(key(QNET)))).toMatchObject({ qnet: QNET, admittedAt: clock });
    expect(JSON.parse(await AsyncStorage.getItem(key(W)))).toMatchObject({ qnet: W, admittedAt: clock });
    clock += R.READMIT_MS;
    expect(await R.resumeRegistration(lightNodeId(W), false, { now, fetchFn, readBurn: site, sleep })).toBe('admitted');
    expect(JSON.parse(fetchFn.mock.calls[3][1].body)).toMatchObject({ from: W, node_id: lightNodeId(W) });
    expect(await R.resumeRegistration(NODE, true, { now, fetchFn })).toBe(null);
    expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
    expect(JSON.parse(await AsyncStorage.getItem(key(W)))).toMatchObject({ qnet: W });
  });

  it('a job the chain settled while its send waited, or while the route answered, goes no further and is not written back', async () => {
    // Between two tries: a status read that finds the node on the chain forgets the job; the run sends nothing more.
    let goOn;
    const offline = jest.fn(() => Promise.reject(new Error('offline')));
    const first = R.sendRegistration(job(), { fetchFn: offline, readBurn: site, now, sleep: () => new Promise((r) => { goOn = r; }) });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(typeof goOn).toBe('function');
    expect(await R.resumeRegistration(NODE, true, { now, fetchFn: offline })).toBe(null);
    goOn();
    expect(await first).toBe('settled');
    expect(offline).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
    // While the route still answers: what it says comes through, and the forgotten job stays forgotten.
    let take;
    const slow = jest.fn(() => new Promise((resolve) => { take = resolve; }));
    const onStage = jest.fn();
    const second = R.sendRegistration(job(), { fetchFn: slow, readBurn: site, sleep, now, onStage });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(await R.resumeRegistration(NODE, true, { now, fetchFn: slow })).toBe(null);
    take({ status: 200, json: async () => ({ result: 'registered' }) });
    expect(await second).toBe('registered');
    expect(onStage.mock.calls).toEqual([['registered']]);
    expect(await AsyncStorage.getItem(key(QNET))).toBe(null);
  });

  it('a newer consent of the same wallet takes the place of its earlier one', async () => {
    let goOn;
    const fetchFn = jest.fn(() => (fetchFn.mock.calls.length === 1 ? Promise.reject(new Error('offline')) : answer(200, { result: 'admitted', txHash: TX })));
    const first = R.sendRegistration(job(), { fetchFn, readBurn: site, now, sleep: () => new Promise((r) => { goOn = r; }) });
    await new Promise((r) => { setTimeout(r, 0); });
    const newer = job({ consent: { ...CONSENT, ts: String(Number(CONSENT.ts) + 60) } });
    expect(await R.sendRegistration(newer, { fetchFn, readBurn: site, sleep, now })).toBe('admitted');
    goOn();
    expect(await first).toBe('replaced');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('what the site records of the burn', () => {
  it('names the amount; a record of no payment burn, or of another one, leaves the registration to the page', async () => {
    const fetchFn = jest.fn(() => answer(200, { result: 'admitted', txHash: TX }));
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: async () => ({ burnTx: null, burnAmount: null }), sleep, now }))
      .toBe('no_record');
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: async () => ({ burnTx: 'other', burnAmount: 3 }), sleep, now }))
      .toBe('no_record');
    expect(fetchFn).not.toHaveBeenCalled();
    // A record that cannot be read now is read again.
    const reads = [null, { burnTx: BURN, burnAmount: 1500 }];
    expect(await R.sendRegistration(job(), { fetchFn, readBurn: async () => reads.shift(), sleep, now })).toBe('admitted');
    expect(waits).toEqual([5000]);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).burn_amount).toBe(1500);
  });

  it('readRecordedBurn: a payment address\'s light burn sent or recorded, with its whole amount; nothing else names one', async () => {
    const { readRecordedBurn } = require('../src/services/NodeRecordRead');
    const record = (over) => ({ wallet: W, state: 'recorded', nodeType: 'light', way: 'payment', burner: BURNER, burnTx: BURN, burnAmount: 1500, ...over });
    const read = async (body, status = 200) => {
      global.fetch = jest.fn(() => answer(status, body));
      return readRecordedBurn(W);
    };
    expect(await read(record())).toEqual({ burnTx: BURN, burnAmount: 1500 });
    expect(await read(record({ state: 'sending' }))).toEqual({ burnTx: BURN, burnAmount: 1500 });
    // A burn of the wallet's own address is the page's to register: the route takes no consent body for it.
    for (const none of [record({ state: 'reserved', burnTx: null }), record({ nodeType: 'super' }), record({ burnAmount: 1.5 }),
      record({ burnTx: 'x' }), record({ way: 'extension' }), { wallet: W, state: 'none', nodeType: null }]) {
      expect(await read(none)).toEqual({ burnTx: null, burnAmount: null });
    }
    expect(await read({}, 503)).toBe(null);
  });
});

describe('kept across a restart', () => {
  it('the next process sends it again while the chain does not list the node, and not again soon after the pool took it', async () => {
    // The first process got no answer and ended while it waited.
    const first = R.sendRegistration(job(), { fetchFn: () => Promise.reject(new Error('offline')), readBurn: site, now, sleep: () => new Promise(() => {}) });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(first).toBeInstanceOf(Promise);
    // A new process: its own modules, the device's storage as it was left.
    const disk = await AsyncStorage.getItem(key(QNET));
    expect(JSON.parse(disk)).toMatchObject({ qnet: QNET, burnTx: BURN, burnAmount: 1500 });
    jest.resetModules();
    AsyncStorage = require('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem(key(QNET), disk);
    const next = require('../src/services/RegistrationSubmit');
    const fetchFn = jest.fn(() => answer(200, { result: 'admitted', txHash: TX }));
    const onStage = jest.fn();
    // A read that cannot tell sends nothing; one that says the chain does not list the node sends the kept body.
    expect(await next.resumeRegistration(NODE, null, { now, fetchFn, readBurn: site, sleep })).toBe(null);
    expect(await next.resumeRegistration(NODE, false, { now, fetchFn, readBurn: site, sleep, onStage })).toBe('admitted');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).timestamp).toBe(1793031451);
    expect(onStage).toHaveBeenCalledWith('admitted');
    // Taken into the pool: the next reads wait for the chain; one the chain still does not list READMIT_MS later goes again.
    expect(await next.resumeRegistration(NODE, false, { now, fetchFn, readBurn: site, sleep })).toBe(null);
    clock += next.READMIT_MS;
    expect(await next.resumeRegistration(NODE, false, { now, fetchFn, readBurn: site, sleep })).toBe('admitted');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Another wallet's node, or none kept: nothing.
    expect(await next.resumeRegistration(lightNodeId(W), false, { now, fetchFn })).toBe(null);
  });

  it('every job kept on the device goes on from the open wallet: one status read of its own node each', async () => {
    const keep = (qnet, over = {}) => AsyncStorage.setItem(key(qnet), JSON.stringify({ ...job({ qnet }), burnAmount: 1500, ...over }));
    await keep(QNET);
    await keep(W);
    await keep(X, { until: clock - 1 });
    await AsyncStorage.setItem('qnet_unrelated', 'x');
    // The chain lists W's node, not QNET's; X's consent window has ended.
    const readStatus = jest.fn(async (nodeId) => ({ onChain: nodeId === lightNodeId(W) }));
    const onStage = jest.fn();
    const fetchFn = jest.fn(() => answer(200, { result: 'admitted', txHash: TX }));
    await R.resumeKept({ readStatus, onStage, now, fetchFn, readBurn: site, sleep });
    expect(readStatus.mock.calls.map((c) => c[0]).sort()).toEqual([NODE, lightNodeId(W)].sort());
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).node_id)).toEqual([NODE]);
    expect(onStage.mock.calls).toEqual([[NODE, 'admitted']]);
    expect(JSON.parse(await AsyncStorage.getItem(key(QNET)))).toMatchObject({ admittedAt: clock });
    expect(await AsyncStorage.getItem(key(W))).toBe(null);
    expect(await AsyncStorage.getItem(key(X))).toBe(null);
    // A read that cannot tell sends nothing and keeps the job.
    clock += R.READMIT_MS;
    await R.resumeKept({ readStatus: async () => { throw new Error('offline'); }, now, fetchFn, readBurn: site, sleep });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(key(QNET))).not.toBe(null);
  });
});
