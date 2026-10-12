// The shared vectors of a site's move of a node balance (docs/protocols/node-claim.vectors.json, decision 47), the
// extension's side: the core's super node id of each wallet, the claim quote it signs for the wallet's light and super
// node (the node's form: ML-DSA-65, empty context), and its refusal of any node of another wallet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../dist/lib/qnet-core.js';

const V = JSON.parse(readFileSync(new URL('../../../docs/protocols/node-claim.vectors.json', import.meta.url), 'utf8'));
const L = JSON.parse(readFileSync(new URL('../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const noble = existsSync(NOBLE) ? await import(NOBLE.href) : null;
const needsNoble = noble ? {} : { skip: 'run npm run bundle:install' };

const { bytesToHex: hex, hexToBytes } = core;
const utf8 = (s) => new TextEncoder().encode(s);
const mnemonicOf = (name) => L.wallets.find((w) => w.name === name).mnemonic;

describe('node claim vectors: the named node', () => {
  it('names the wallets of the light node vectors, each with its light and super node id', () => {
    assert.deepEqual(V.wallets.map((w) => w.name), L.wallets.map((w) => w.name));
    assert.deepEqual(V.constants.requestKeys, ['walletHash', 'nodeId']);
    for (const w of V.wallets) {
      assert.equal(core.lightNodeId(w.address), w.lightNodeId);
      assert.equal(core.superNodeId(w.address), w.superNodeId);
      assert.match(w.superNodeId, new RegExp(V.constants.nodeIdPatterns.super));
      assert.notEqual(w.superNodeId.slice(-16), w.lightNodeId.slice(-16));
    }
    assert.throws(() => core.superNodeId('not an address'), TypeError);
    // the shared builder takes no other id: a genesis node, a malformed one
    for (const bad of ['genesis_node_001', `${V.wallets[0].superNodeId}0`, V.wallets[0].superNodeId.toUpperCase(), 'super_node_']) {
      assert.throws(() => core.claimQuotePreimage(bad, V.wallets[0].address), TypeError, bad);
    }
  });

  for (const w of V.wallets) {
    it(`${w.name}: the claim quote of its light and of its super node, in the node's form`, needsNoble, () => {
      const keys = core.deriveQnetKeypair(core.mnemonicToSeed(mnemonicOf(w.name)));
      try {
        assert.equal(keys.address, w.address);
        assert.deepEqual(w.claimQuotes.map((q) => q.nodeId), [w.lightNodeId, w.superNodeId]);
        for (const q of w.claimQuotes) {
          const signed = core.signClaimQuote({ nodeId: q.nodeId, wallet: w.address }, keys.secretKey, keys.publicKey);
          assert.equal(signed.preimage, q.preimage);
          assert.equal(noble.ml_dsa65.verify(signed.signature, utf8(q.preimage), keys.publicKey), true);
          // the vectors' deterministic signature verifies too, and is the one the same key gives without randomness
          assert.equal(noble.ml_dsa65.verify(hexToBytes(q.signature), utf8(q.preimage), keys.publicKey), true);
          assert.equal(hex(noble.ml_dsa65.sign(utf8(q.preimage), keys.secretKey, { extraEntropy: false })), q.signature);
          // never under the extension's off-chain message context
          assert.equal(noble.ml_dsa65.verify(signed.signature, utf8(q.preimage), keys.publicKey, { context: utf8('QNET_OFFCHAIN_MSG_v1') }), false);
        }
        // both quotes are the app's shared builder's, which takes a light or a super node id
        assert.equal(core.claimQuotePreimage(w.lightNodeId, w.address), w.claimQuotes[0].preimage);
        assert.equal(core.claimQuotePreimage(w.superNodeId, w.address), w.claimQuotes[1].preimage);
      } finally {
        core.zeroize(keys.secretKey);
      }
    });
  }

  it('refuses another wallet\'s node, a genesis node and a malformed id', () => {
    const [w, other] = V.wallets;
    const keys = core.deriveQnetKeypair(core.mnemonicToSeed(mnemonicOf(w.name)));
    const code = (fn) => {
      try {
        fn();
      } catch (error) {
        return error.code;
      }
      return 'no error';
    };
    try {
      for (const nodeId of [other.superNodeId, other.lightNodeId, 'genesis_node_001', w.superNodeId.toUpperCase(), `${w.superNodeId}0`]) {
        assert.equal(code(() => core.signClaimQuote({ nodeId, wallet: w.address }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE', nodeId);
      }
      // another wallet's own super node, under this wallet's key
      assert.equal(code(() => core.signClaimQuote({ nodeId: other.superNodeId, wallet: other.address }, keys.secretKey, keys.publicKey)),
        'KEY_ADDRESS_MISMATCH');
    } finally {
      core.zeroize(keys.secretKey);
    }
  });

  it('a site\'s qnet_signMessage can never carry a claim quote of either node', () => {
    for (const w of V.wallets) {
      for (const q of w.claimQuotes) assert.equal(core.hasProtocolPrefix(q.preimage), true, q.preimage);
    }
  });
});
