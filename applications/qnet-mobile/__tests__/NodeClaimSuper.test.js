/**
 * A site's move of the wallet's super node balance, end to end on the device with a mocked network: the relay's session
 * names the super node, the sheet shows "Super node" with its id above the amount the app read, Confirm moves that node's
 * balance (the quote the wallet key signs and the claim both name the super node), and the sealed answer names it.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import Action from '../src/components/ui/Action';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn().mockResolvedValue('ab'.repeat(8)),
  generateRawDilithiumKeypair: jest.fn(),
}));

const { sha3_256 } = require('js-sha3');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { signWithDilithium } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const { nodeLinkActions } = require('../src/services/NodeLinkActions');
const { parseLink, openAnswer, plaintextProblem } = require('../src/services/QNetLink');
const { claimQuotePreimage } = require('../src/crypto/NodePreimages');
const QNetLinkScreen = require('../src/screens/QNetLinkScreen').default;
const t = require('../src/i18n').makeT('en');
const V = require('../../../docs/protocols/node-claim.vectors.json');

const CASE = V.cases.find((c) => c.name === 'claim-super-ok');
const W = V.wallets.find((w) => w.walletHash === CASE.request.walletHash);
const S = W.superNodeId;
const TX = 'cd'.repeat(32);
const SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const CLAIMS = JSON.stringify({ claims: [{ epoch: 5, amount: 20000000000 }, { epoch: 6, amount: 28000000000 }] });

const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
const button = (tree, label) => tree.root.findAllByType(Action).find((b) => b.props.label === label);
const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));

let posted;
let reads;

beforeEach(async () => {
  await AsyncStorage.clear();
  signWithDilithium.mockClear();
  posted = [];
  reads = [];
  // The relay (its session, then the answer) and the genesis nodes (the super node's status, its balance).
  global.fetch = jest.fn(async (url, init = {}) => {
    reads.push(url);
    const json = (status, body) => ({ status, ok: status < 400, url: '', text: async () => JSON.stringify(body), json: async () => body });
    if (url === `https://aiqnet.io/api/link/sessions/${CASE.sessionId}`) return json(200, { ...CASE.sessionView, answered: false, expiresIn: 500 });
    if (url === `https://aiqnet.io/api/link/sessions/${CASE.sessionId}/response`) {
      posted.push(JSON.parse(init.body));
      return json(201, { ok: true });
    }
    if (url.endsWith(`/api/v1/node/status?node_id=${S}`)) return json(200, { success: true, node_id: S, onchain_registered: true });
    if (url.endsWith(`/api/v1/rewards/pending/${S}`)) return json(200, { success: true, pending_rewards_nano: 48000000000, first_unclaimed_epoch: 5 });
    return json(404, { error: 'not_found' });
  });
});

// The wallet's own claim (WalletManager.claimRewards), its key and the node's answers stubbed: the quote, the other
// nodes' head and node balance (a whole batch is held to both), the submit.
function manager() {
  const wm = new WalletManager();
  wm.loadWallet = async () => ({ qnetAddress: W.address });
  wm._walletDilithiumKeys = async () => ({ secretKey: 'sk', publicKey: 'pk' });
  wm.getTrustedNodes = () => ['https://node1.aiqnet.io', 'https://node2.aiqnet.io', 'https://node3.aiqnet.io'];
  wm._hedged = jest.fn(async (p) => (p === '/api/v1/rewards/claim'
    ? {
      ok: true, base: 'https://node1.aiqnet.io',
      data: {
        success: true, needs_signature: true, claims_data: CLAIMS, last_claimed_epoch: 4, amount_nano: '48000000000',
        claim_timestamp: 1790000000, stopped_at_epoch: null,
        sign_message: `q1337|qnet_claim_v1:${W.address}:1790000000:${sha3_256(CLAIMS)}`,
      },
    }
    : { ok: true, data: { node_id: S, first_unclaimed_epoch: 5, pending_rewards_nano: 48000000000 } }));
  wm._submitClaim = jest.fn(async () => ({ ok: true, data: { success: true, tx_hash: TX, amount_qnc: 48 } }));
  return wm;
}

it('the sheet names the super node, and Confirm moves its balance under its id, which the answer names', async () => {
  const wm = manager();
  const link = parseLink(CASE.link);
  const authenticate = jest.fn(async () => true);
  const onClaimed = jest.fn();
  const node = nodeLinkActions({ walletManager: wm, credential: 'pw', onClaimed });
  let tree;
  await act(async () => {
    tree = renderer.create(
      <QNetLinkScreen link={link} wallet={{ qnetAddress: W.address, solanaAddress: SOLANA }} t={t} node={node}
        authenticate={authenticate} onClose={jest.fn()} />,
    );
  });
  await wait(0);
  await wait(0);
  // The sheet: the super node and its id above the amount the app read from the genesis nodes.
  const shown = texts(tree);
  for (const s of [t('link_title_claim'), t('node_title_super'), S, t('link_claim_amount'), '48 QNC', W.address]) expect(shown).toContain(s);
  expect(shown).not.toContain(t('node_title_light'));
  expect(shown.indexOf(S)).toBeLessThan(shown.indexOf('48 QNC'));
  expect(reads.filter((u) => u.endsWith(`/api/v1/node/status?node_id=${S}`))).toHaveLength(5);
  expect(reads.filter((u) => u.includes('/api/v1/light-node/status'))).toEqual([]);
  expect(wm._hedged).not.toHaveBeenCalled();

  await wait(1100);
  const confirm = button(tree, 'Confirm');
  await act(async () => { confirm.props.onPressIn(); await confirm.props.onPress(); });
  await wait(0);
  expect(authenticate).toHaveBeenCalledWith(t('link_auth_claim'));

  // The quote the wallet key signed names the super node, as the shared builder and the vectors write it.
  const quote = signWithDilithium.mock.calls[0][0];
  expect(quote).toBe(claimQuotePreimage(S, W.address));
  expect(quote).toBe(W.claimQuotes.find((q) => q.nodeId === S).preimage);
  // The claim and its submit carry the super node's id.
  expect(wm._hedged.mock.calls[0][0]).toBe('/api/v1/rewards/claim');
  expect(wm._hedged.mock.calls[0][1].body).toMatchObject({ node_id: S, wallet_address: W.address });
  expect(wm._submitClaim).toHaveBeenCalledWith(expect.objectContaining({ node_id: S, wallet_address: W.address }));
  expect(onClaimed).toHaveBeenCalledWith(S, expect.objectContaining({ success: true, txHash: TX }), 48000000000);

  // The answer the site opens names the super node, and passes the site's checks for the request.
  expect(posted).toHaveLength(1);
  const text = openAnswer({ id: CASE.sessionId, intent: 'claim', reqHash: CASE.reqHash, sitePrivateKey: Uint8Array.from(Buffer.from(CASE.sitePrivateKey, 'hex')), ...posted[0] });
  expect(JSON.parse(text)).toEqual({
    v: 1, intent: 'claim', status: 'ok', qnet: W.address, nodeId: S, amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null,
  });
  expect(plaintextProblem(text, { intent: 'claim', request: CASE.request })).toBe(null);
  expect(texts(tree)).toContain(t('link_result_claim', { amount: '48 QNC' }));
  await act(async () => { tree.unmount(); });
});

it('a request naming another wallet\'s super node is refused before anything is read or signed', async () => {
  const other = V.wallets.find((w) => w !== W);
  const c = V.cases.find((x) => x.name === 'claim-error-mismatch');
  expect(c.request.nodeId).toBe(other.superNodeId);
  global.fetch = jest.fn(async () => ({
    status: 200, ok: true, url: '', text: async () => JSON.stringify({ ...c.sessionView, answered: false, expiresIn: 500 }),
  }));
  const wm = manager();
  let tree;
  await act(async () => {
    tree = renderer.create(
      <QNetLinkScreen link={parseLink(c.link)} wallet={{ qnetAddress: W.address, solanaAddress: SOLANA }} t={t}
        node={nodeLinkActions({ walletManager: wm, credential: 'pw' })} authenticate={jest.fn(async () => true)} onClose={jest.fn()} />,
    );
  });
  await wait(0);
  await wait(0);
  expect(texts(tree)).toContain(t('link_err_WALLET_MISMATCH'));
  // Only the relay's session was read; nothing was asked of a node, nothing signed.
  expect(global.fetch.mock.calls.map((x) => x[0])).toEqual([`https://aiqnet.io/api/link/sessions/${c.sessionId}`]);
  expect(wm._hedged).not.toHaveBeenCalled();
  expect(signWithDilithium).not.toHaveBeenCalled();
  await act(async () => { tree.unmount(); });
});
