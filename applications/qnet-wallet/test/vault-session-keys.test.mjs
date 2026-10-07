// Transient keys (CONTRACTS.md section 9 keys.js; R02, R07, R18, R19, MISS-01): every signer re-checks the
// session, derives from the vault entropy, signs with the audited core (which self-verifies) and hands
// out signatures only; a dApp message is checked before any key exists and is domain-separated.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { KAT_EON, KAT_MNEMONIC, KAT_SOLANA, PASSWORD, loadWorker, rejectsWith, reset } from './helpers/vault-session-env.mjs';

const w = await loadWorker();
const { vault, session, keys, core } = w;
// An independent verifier: the audited library the bundle is built from (present after npm run bundle:install).
const ML_DSA = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const noble = existsSync(ML_DSA) ? await import(ML_DSA.href) : null;

const OTHER_EON = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const ORIGIN = 'https://aiqnet.io';

let env;
beforeEach(async () => {
  env?.unsubscribe();
  env = await reset(w);
});
after(() => env?.unsubscribe());

const unlocked = () => vault.createVault({ mnemonic: KAT_MNEMONIC, password: PASSWORD });
const transfer = (overrides = {}) => ({
  from: KAT_EON, to: OTHER_EON, amountNano: '1500000000', nonce: '7', gasPrice: '10', gasLimit: '10000', ...overrides,
});

describe('keys', () => {
  it('passes the bundle self-test once and derives the golden addresses', () => {
    assert.equal(keys.initKeys(), true);
    assert.equal(keys.signingEnabled(), true);
    assert.deepEqual(keys.deriveAddresses(core.mnemonicToEntropy(KAT_MNEMONIC)),
      { qnetAddress: KAT_EON, solanaAddress: KAT_SOLANA });
  });

  it('signs a QNC transfer over the node preimage with the wallet key, and nothing else', async () => {
    await unlocked();
    const tx = transfer();
    const signed = await keys.signQnetTransfer({ ...tx, extra: 'ignored' });
    assert.equal(signed.preimage, `q1337|transfer:${KAT_EON}:${OTHER_EON}:1500000000:7:10:10000`);
    assert.equal(signed.signature.length, core.ML_DSA65.SIGNATURE_BYTES);
    assert.equal(core.qnetAddressFromPublicKey(signed.publicKey), KAT_EON);
    assert.equal(core.verifyTransferSignature(tx, signed.signature, signed.publicKey), true);
    assert.equal(core.verifyTransferSignature(transfer({ amountNano: '1500000001' }), signed.signature, signed.publicKey), false);
    await rejectsWith(keys.signQnetTransfer(transfer({ from: OTHER_EON })), 'KEY_ADDRESS_MISMATCH');
    await rejectsWith(keys.signQnetTransfer(transfer({ amountNano: '0' })), 'INVALID_TRANSFER');
    assert.deepEqual(await keys.getQnetPublicKey(), signed.publicKey);
  });

  it('signs dApp messages with the domain-separated wrapper only, refusing protocol text before deriving', async () => {
    await rejectsWith(keys.signOffchain(ORIGIN, `q1337|transfer:${KAT_EON}:${OTHER_EON}:1:1:10:10000`), 'PROTOCOL_PREFIX');
    await rejectsWith(keys.signOffchain(ORIGIN, 'hello'), 'LOCKED');
    await unlocked();
    const signed = await keys.signOffchain(ORIGIN, 'Sign in to aiqnet.io');
    assert.equal(signed.address, KAT_EON);
    assert.equal(core.verifyOffchainMessage(ORIGIN, 'Sign in to aiqnet.io', signed.signature, signed.publicKey), true);
    assert.equal(core.verifyOffchainMessage('https://evil.example', 'Sign in to aiqnet.io', signed.signature,
      signed.publicKey), false, 'bound to the origin');
    await rejectsWith(keys.signOffchain(ORIGIN, 'selfattest:x'), 'PROTOCOL_PREFIX');
    await rejectsWith(keys.signOffchain('http://aiqnet.io', 'hello'), 'INVALID_ORIGIN');
  });

  it('signs a Solana message with the hardened-derivation key of the wallet', async () => {
    await unlocked();
    const message = Uint8Array.from({ length: 200 }, (_, i) => i);
    const { signature, publicKey } = await keys.signSolanaMessage(message);
    assert.equal(core.solanaAddressFromPublicKey(publicKey), KAT_SOLANA);
    assert.equal(core.verifySolanaSignature(signature, message, publicKey), true);
    await rejectsWith(keys.signSolanaMessage(new Uint8Array(0)), 'INTERNAL');
    await rejectsWith(keys.signSolanaMessage(new Uint8Array(1233)), 'INTERNAL');
    await rejectsWith(keys.signSolanaMessage('not bytes'), 'INTERNAL');
  });

  // The light node's signers (nodes.js): the core builds every message from the vault's own wallet, node id and burn;
  // the node verifies ML-DSA-65 with the empty context and the owner bind under the burner.
  it('signs the light node messages only for the wallet\'s own node and the vault\'s own light burn', async () => {
    await unlocked();
    const nodeId = core.lightNodeId(KAT_EON);
    const burnTx = core.KAT.activation.burnTx;
    const utf8 = (text) => new TextEncoder().encode(text);
    const verify = (preimage, signed) => core.verifyConsensusSignature(preimage, core.bytesToHex(signed.signature), core.bytesToHex(signed.publicKey));
    const fields = { nodeId, wallet: KAT_EON, burnTx, burner: KAT_SOLANA, timestamp: 1_790_000_000 };
    await rejectsWith(keys.signNodeRegistration(fields), 'NOT_FOUND', 'no light activation yet');
    await vault.updateState((s) => ({
      ...s,
      activation: {
        code: core.generateActivationCode('light', KAT_SOLANA, burnTx, 1500), nodeType: 'light', burnTx, burnAmount: 1500,
        solanaAddress: KAT_SOLANA, cluster: 'devnet', createdAt: 1,
      },
    }));
    const reg = await keys.signNodeRegistration(fields);
    assert.equal(reg.proof, core.registrationProof(burnTx, nodeId, KAT_EON));
    const consent = core.consentPreimage(nodeId, KAT_EON, reg.proof, fields.timestamp);
    assert.equal(await verify(consent, { signature: reg.consentSignature, publicKey: reg.publicKey }), true);
    const bind = core.ownerBindPreimage(nodeId, KAT_EON, reg.proof, fields.timestamp, core.bytesToHex(reg.publicKey), burnTx);
    assert.equal(core.verifySolanaSignature(reg.ownerSignature, utf8(bind), core.solanaAddressToBytes(KAT_SOLANA)), true);
    await rejectsWith(keys.signNodeRegistration({ ...fields, burner: core.KAT.activation.solanaAddress }), 'NOT_FOUND', 'another burner');
    await rejectsWith(keys.signNodeRegistration({ ...fields, wallet: OTHER_EON }), 'ADDRESS_MISMATCH');

    const quote = await keys.signNodeClaim({ nodeId, wallet: KAT_EON });
    assert.equal(await verify(core.claimQuotePreimage(nodeId, KAT_EON), quote), true);
    const payload = await keys.signClaimPayload({ wallet: KAT_EON, timestamp: 1_790_000_000, claimsData: '{"claims":[]}' });
    assert.equal(await verify(core.claimPayloadPreimage(KAT_EON, 1_790_000_000, '{"claims":[]}'), payload), true);
    const status = await keys.signNodeStatus({ nodeId, wallet: KAT_EON, timestamp: 1_790_000_060 });
    assert.equal(await verify(core.statusPreimage(nodeId, 1_790_000_060), status), true);
    await rejectsWith(keys.signNodeStatus({ nodeId: core.lightNodeId(OTHER_EON), wallet: KAT_EON, timestamp: 1 }), 'INVALID_NODE_MESSAGE');
    await rejectsWith(keys.signNodeClaim({ nodeId: core.lightNodeId(OTHER_EON), wallet: OTHER_EON }), 'KEY_ADDRESS_MISMATCH');
    // the wallet key's unbind of the node's device (decision 38)
    const unbind = await keys.signNodeUnbind({ nodeId, wallet: KAT_EON, seq: '1790035123', timestamp: 1_790_100_000 });
    assert.equal(await verify(core.walletUnbindPreimage(nodeId, '1790035123', 1_790_100_000), unbind), true);
    // never the ping form's message, which only the device's own key signs
    assert.equal(await verify(`q1337|light_unbind:${nodeId}:1790035123:1790100000`, unbind), false);
    await rejectsWith(keys.signNodeUnbind({ nodeId: core.lightNodeId(OTHER_EON), wallet: KAT_EON, seq: '1', timestamp: 1 }), 'INVALID_NODE_MESSAGE');
    await session.lock('user');
    await rejectsWith(keys.signNodeStatus({ nodeId, wallet: KAT_EON, timestamp: 1 }), 'LOCKED');
    await rejectsWith(keys.signNodeUnbind({ nodeId, wallet: KAT_EON, seq: '1', timestamp: 1 }), 'LOCKED');
  });

  // Decision 35: the proof of a burn record for aiqnet.io, made with both keys of the phrase from fields the session
  // checks; the server verifies it over exactly these bytes.
  it('signs a burn record\'s proof with the wallet key and the burner key over the contract\'s bytes, for the session\'s own wallet only', async () => {
    const burnTx = core.KAT.activation.burnTx;
    const fields = { wallet: KAT_EON, nodeType: 'super', burner: KAT_SOLANA, burnTx, burnAmount: 3000 };
    await rejectsWith(keys.signBurnRecord(fields), 'LOCKED');
    await unlocked();
    const text = `QNet burn record v1\nwallet: ${KAT_EON}\nnode: super\nburner: ${KAT_SOLANA}\nburn: ${burnTx}\namount: 3000\ncluster: devnet`;
    assert.equal(keys.burnRecordMessage(fields), text);
    const proof = await keys.signBurnRecord({ ...fields, extra: 'ignored' });
    assert.deepEqual(Object.keys(proof).sort(), ['pk', 'sig', 'solanaSig']);
    assert.match(proof.pk, /^[A-Za-z0-9_-]+$/);
    assert.match(proof.sig, /^[A-Za-z0-9_-]+$/);
    const pk = new Uint8Array(Buffer.from(proof.pk, 'base64url'));
    const sig = new Uint8Array(Buffer.from(proof.sig, 'base64url'));
    assert.equal(core.qnetAddressFromPublicKey(pk), KAT_EON);
    // the site-record signer's envelope, which a dApp's message never reaches (decision 36)
    assert.equal(core.verifySiteRecord('https://aiqnet.io', text, sig, pk), true);
    assert.equal(core.verifyOffchainMessage('https://aiqnet.io', text, sig, pk), false);
    const utf8 = (value) => new TextEncoder().encode(value);
    const envelope = utf8(`QNet Signed Message:\nhttps://aiqnet.io\n${utf8(text).length}\n${text}`);
    assert.deepEqual(core.buildSiteRecord('https://aiqnet.io', text), envelope);
    assert.equal(core.verifySolanaSignature(core.base58Decode(proof.solanaSig), envelope, core.solanaAddressToBytes(KAT_SOLANA)), true);
    // only the session's own wallet and burner, a known node type, a signature and a whole amount
    await rejectsWith(keys.signBurnRecord({ ...fields, wallet: OTHER_EON }), 'ADDRESS_MISMATCH');
    await rejectsWith(keys.signBurnRecord({ ...fields, burner: core.KAT.activation.solanaAddress }), 'ADDRESS_MISMATCH');
    for (const bad of [{ nodeType: 'full' }, { burnTx: 'x' }, { burnAmount: 0 }, { burnAmount: 1.5 }, { burnAmount: 1_000_000_001 }]) {
      await rejectsWith(keys.signBurnRecord({ ...fields, ...bad }), 'INTERNAL', JSON.stringify(bad));
    }
  });

  // Decision 36: the wallet's own request of aiqnet.io's reservation, signed with the wallet key from fields the session
  // checks, for the extension's way only; the server verifies it over exactly these bytes and refuses it once it is old.
  it('signs a reservation request with the wallet key over the contract\'s bytes, for the session\'s own wallet and address only', async () => {
    const fields = { wallet: KAT_EON, nodeType: 'light', way: 'extension', burner: KAT_SOLANA, time: 1_790_000_123 };
    await rejectsWith(keys.signReservation(fields), 'LOCKED');
    await unlocked();
    const text = `QNet node reservation v1\nwallet: ${KAT_EON}\nnode: light\nway: extension\nburner: ${KAT_SOLANA}\ntime: 1790000123\ncluster: devnet`;
    assert.equal(keys.reservationMessage(fields), text);
    assert.equal(keys.reservationMessage({ ...fields, way: 'payment', nodeType: 'super' }),
      text.replace('node: light', 'node: super').replace('way: extension', 'way: payment'));
    const proof = await keys.signReservation({ ...fields, extra: 'ignored' });
    assert.deepEqual(Object.keys(proof), ['pk', 'sig', 'time']);
    assert.equal(proof.time, 1_790_000_123);
    assert.match(proof.pk, /^[A-Za-z0-9_-]+$/);
    assert.match(proof.sig, /^[A-Za-z0-9_-]+$/);
    const pk = new Uint8Array(Buffer.from(proof.pk, 'base64url'));
    const sig = new Uint8Array(Buffer.from(proof.sig, 'base64url'));
    assert.deepEqual([pk.length, sig.length], [1952, 3309]);
    assert.equal(core.qnetAddressFromPublicKey(pk), KAT_EON);
    assert.equal(core.verifySiteRecord('https://aiqnet.io', text, sig, pk), true);
    assert.equal(core.verifySiteRecord('https://aiqnet.io', text.replace('1790000123', '1790000124'), sig, pk), false, 'the time is signed');
    assert.equal(core.verifyOffchainMessage('https://aiqnet.io', text, sig, pk), false, 'never a dApp message');
    // an independent verifier (the audited library the bundle is built from) over the contract's bytes, written out here
    if (noble) {
      const utf8 = (value) => new TextEncoder().encode(value);
      const envelope = utf8(`QNet Signed Message:\nhttps://aiqnet.io\n${utf8(text).length}\n${text}`);
      assert.equal(noble.ml_dsa65.verify(sig, envelope, pk, { context: utf8('QNET_OFFCHAIN_MSG_v1') }), true, 'ML-DSA-65, the off-chain context');
      assert.equal(noble.ml_dsa65.verify(sig, envelope, pk), false, 'never valid without the context');
    }
    // a page's message signer refuses this text and the burn record's before any key is derived: no approval hands one out
    await rejectsWith(keys.signOffchain(ORIGIN, text), 'PROTOCOL_PREFIX');
    await rejectsWith(keys.signOffchain(ORIGIN, keys.burnRecordMessage({
      wallet: KAT_EON, nodeType: 'light', burner: KAT_SOLANA, burnTx: core.KAT.activation.burnTx, burnAmount: 1500,
    })), 'PROTOCOL_PREFIX');
    // only the session's own wallet and address, the extension's way, a known node type and a time in whole seconds
    await rejectsWith(keys.signReservation({ ...fields, wallet: OTHER_EON }), 'ADDRESS_MISMATCH');
    await rejectsWith(keys.signReservation({ ...fields, burner: core.KAT.activation.solanaAddress }), 'ADDRESS_MISMATCH');
    for (const bad of [{ nodeType: 'full' }, { nodeType: undefined }, { way: 'payment' }, { way: undefined }, { time: 1.5 }, { time: 0 },
      { time: '1790000123' }, { time: Number.MAX_SAFE_INTEGER + 1 }]) {
      await rejectsWith(keys.signReservation({ ...fields, ...bad }), 'INTERNAL', JSON.stringify(bad));
    }
    await session.lock('user');
    await rejectsWith(keys.signReservation(fields), 'LOCKED');
  });

  it('refuses every signature while locked, including right after the deadline', async () => {
    await unlocked();
    await session.lock('user');
    await rejectsWith(keys.signQnetTransfer(transfer()), 'LOCKED');
    await rejectsWith(keys.signSolanaMessage(Uint8Array.of(1)), 'LOCKED');
    await rejectsWith(keys.getQnetPublicKey(), 'LOCKED');
  });

  it('locks when the vault entropy does not derive the unlocked addresses', async () => {
    await unlocked();
    const info = await session.requireUnlocked();
    const vaultKey = await session.withVaultKey((k) => k.slice());
    await session.startSession({ ...info, vaultKey, qnetAddress: OTHER_EON, autoLockMinutes: 15 });
    await rejectsWith(keys.signQnetTransfer(transfer({ from: OTHER_EON })), 'ADDRESS_MISMATCH');
    assert.equal(await session.isUnlocked(), false);
    assert.equal(env.changes.at(-1).reason, 'error');
  });
});

// Owner, 06.10: the private key of each account can be exported as the recovery phrase is, behind a fresh password check:
// QNet as the 32-byte ML-DSA-65 KeyGen seed in hex, Solana as the 64-byte secret key in base58. No import by key exists.
describe('keys: private key export (owner, 06.10)', () => {
  it('needs the session and the password, with the backoff of every password check', async () => {
    await rejectsWith(keys.exportPrivateKey({ password: PASSWORD, network: 'qnet' }), 'NO_VAULT');
    await unlocked();
    await rejectsWith(keys.exportPrivateKey({ password: 'wrong password', network: 'qnet' }), 'BAD_PASSWORD');
    await rejectsWith(keys.exportPrivateKey({ password: PASSWORD, network: 'ethereum' }), 'INVALID_PARAMS');
    await session.lock('user');
    await rejectsWith(keys.exportPrivateKey({ password: PASSWORD, network: 'qnet' }), 'LOCKED');
  });

  it("QNet: the hex of the 32-byte seed the key pair is made from, which makes the wallet's own address again", async () => {
    await unlocked();
    const exported = await keys.exportPrivateKey({ password: PASSWORD, network: 'qnet' });
    assert.deepEqual(Object.keys(exported).sort(), ['address', 'network', 'privateKey']);
    assert.equal(exported.network, 'qnet');
    assert.equal(exported.address, KAT_EON);
    assert.match(exported.privateKey, /^[0-9a-f]{64}$/);
    const seed = core.mnemonicToSeed(KAT_MNEMONIC);
    assert.equal(exported.privateKey, core.bytesToHex(core.walletXi(seed)), 'SHAKE-256 of the canonical seed string, 32 bytes');
    if (noble) {
      const pair = noble.ml_dsa65.keygen(core.hexToBytes(exported.privateKey));
      assert.equal(core.qnetAddressFromPublicKey(pair.publicKey), KAT_EON, 'the exported seed alone makes the same key pair');
    }
  });

  it('Solana: the 64-byte secret key in base58, its private seed then its public key', async () => {
    await unlocked();
    const exported = await keys.exportPrivateKey({ password: PASSWORD, network: 'solana' });
    assert.equal(exported.network, 'solana');
    assert.equal(exported.address, KAT_SOLANA);
    const secret = core.base58Decode(exported.privateKey);
    assert.equal(secret.length, 64);
    assert.equal(core.base58Encode(secret.slice(32)), KAT_SOLANA, 'the second half is the public key');
    const message = new TextEncoder().encode('exported key');
    const signature = core.signSolanaMessage(message, secret.slice(0, 32));
    assert.equal(core.verifySolanaSignature(signature, message, core.base58Decode(KAT_SOLANA)), true, 'the first half signs for the address');
  });
});
