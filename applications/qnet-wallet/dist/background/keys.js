// Transient key material (R02, R07, R18, R19). Private keys exist only inside one call here: derived
// from the vault entropy, used once, zeroized in `finally`. No other module ever receives a private key;
// they get signatures. Signing is disabled for the worker's lifetime if the bundle self-test fails.
import * as core from '../lib/qnet-core.js';
import { RECORD_ORIGIN, SOLANA, STORAGE_KEYS } from './config.js';
import { WalletError } from './errors.js';
import { log } from './log.js';
import * as session from './session.js';
import * as vault from './vault.js';

// Largest serialized Solana transaction (PACKET_DATA_SIZE); a message to sign is smaller still.
const SOLANA_MESSAGE_MAX_BYTES = 1232;
// chrome.storage.session[STORAGE_KEYS.SELF_TEST] after a pass: {v, bundle, passedAt}.
const SELF_TEST_RECORD = 1;
const SELF_TEST_KEYS = Object.freeze(['bundle', 'passedAt', 'v']);
const BUNDLE_FILE = 'lib/qnet-core.js';

let selfTestPassed = null;
let starting = null;

function assertSigningEnabled() {
  if (!initKeys()) throw new WalletError('SIGNING_DISABLED');
}

function runSelfTest() {
  let passed = false;
  try {
    passed = core.selfTest() === true;
  } catch {
    passed = false;
  }
  if (!passed) log.error('crypto self-test failed: signing disabled');
  selfTestPassed = passed;
  return passed;
}

// A cached pass is reused only for these exact bytes: CORE_VERSION and the SHA-256 of the shipped file.
async function bundleId() {
  const response = await fetch(globalThis.chrome.runtime.getURL(BUNDLE_FILE));
  if (!response.ok) throw new WalletError('INTERNAL');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
  return `${core.CORE_VERSION}:${core.bytesToHex(digest)}`;
}

async function cachedPass(bundle) {
  const stored = (await globalThis.chrome.storage.session.get(STORAGE_KEYS.SELF_TEST))?.[STORAGE_KEYS.SELF_TEST];
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    && Object.keys(stored).sort().join(',') === SELF_TEST_KEYS.join(',')
    && stored.v === SELF_TEST_RECORD && stored.bundle === bundle && Number.isSafeInteger(stored.passedAt) && stored.passedAt > 0;
}

const storePass = (bundle) => globalThis.chrome.storage.session.set({
  [STORAGE_KEYS.SELF_TEST]: { v: SELF_TEST_RECORD, bundle, passedAt: Date.now() },
});

/**
 * Worker start: signing is enabled by a self-test pass cached in chrome.storage.session (TRUSTED_CONTEXTS,
 * this browser session only) for this exact bundle, else by running core.selfTest(), whose pass is then
 * cached. A failure is never cached, so the next worker start runs the test again; without a readable
 * bundle nothing is cached. Idempotent; never rejects.
 * @returns {Promise<boolean>} whether signing is enabled
 */
export function startKeys() {
  starting ??= (async () => {
    let bundle = null;
    try {
      bundle = await bundleId();
    } catch {
      log.warn('bundle unreadable: the self-test pass is not cached');
    }
    if (selfTestPassed === null && bundle !== null && await cachedPass(bundle).catch(() => false)) {
      selfTestPassed ??= true;
      return selfTestPassed;
    }
    const passed = selfTestPassed ?? runSelfTest();
    if (passed && bundle !== null) await storePass(bundle).catch(() => log.warn('self-test pass not cached'));
    return passed;
  })();
  return starting;
}

/**
 * Synchronous gate: whether signing is enabled, running core.selfTest() now if neither a cached pass nor
 * a run has decided it yet (a request that arrives before startKeys settles). On failure every sign
 * function throws SIGNING_DISABLED for the worker's lifetime.
 * @returns {boolean} whether signing is enabled
 */
export function initKeys() {
  return selfTestPassed ?? runSelfTest();
}

/**
 * @returns {boolean} whether signing is enabled (a self-test pass in this worker, or one cached for this
 *   bundle in this browser session)
 */
export function signingEnabled() {
  return initKeys();
}

/**
 * Both addresses of an entropy (used at create, import, restore and unlock to compare with the AAD).
 * Zeroizes the seed and both private keys before returning. Refused while the self-test has failed:
 * an address from an unverified derivation must never be shown or stored.
 * @param {Uint8Array} entropy 16 or 32 bytes (not zeroized here)
 * @returns {{qnetAddress: string, solanaAddress: string}}
 * @throws {WalletError} SIGNING_DISABLED
 */
export function deriveAddresses(entropy) {
  assertSigningEnabled();
  let seed;
  let qnet;
  let solana;
  try {
    seed = core.entropyToSeed(entropy);
    qnet = core.deriveQnetKeypair(seed);
    solana = core.deriveSolanaKeypair(seed);
    return { qnetAddress: qnet.address, solanaAddress: solana.address };
  } finally {
    core.zeroize(seed, qnet?.secretKey, solana?.privateKey);
  }
}

// The unlocked wallet's recovery-phrase seed for the duration of `fn`; entropy and seed are zeroized after it.
async function withSeed(fn) {
  await startKeys();
  assertSigningEnabled();
  const info = await session.requireUnlocked();
  const entropy = await vault.readEntropy();
  let seed;
  try {
    seed = core.entropyToSeed(entropy);
    return await fn(seed, info);
  } finally {
    core.zeroize(entropy, seed);
  }
}

// A key that does not derive the session's address means the vault is not what was unlocked.
async function assertOwnAddress(derived, expected) {
  if (derived !== expected) {
    await session.lock('error');
    throw new WalletError('ADDRESS_MISMATCH');
  }
}

async function withQnetKeypair(fn) {
  return withSeed(async (seed, info) => {
    const pair = core.deriveQnetKeypair(seed);
    try {
      await assertOwnAddress(pair.address, info.qnetAddress);
      return await fn(pair, info);
    } finally {
      core.zeroize(pair.secretKey);
    }
  });
}

/**
 * Signs a QNC transfer with the wallet's ML-DSA-65 key over the node preimage (core.signTransfer builds
 * it from these typed fields and self-verifies). Re-checks the session first.
 * @param {{from: string, to: string, amountNano: string, nonce: string, gasPrice: string, gasLimit: string}} fields
 * @returns {Promise<{preimage: string, signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_ADDRESS, KEY_ADDRESS_MISMATCH, SIGNATURE_SELF_CHECK_FAILED
 */
export async function signQnetTransfer(fields) {
  const tx = {
    from: fields?.from,
    to: fields?.to,
    amountNano: fields?.amountNano,
    nonce: fields?.nonce,
    gasPrice: fields?.gasPrice,
    gasLimit: fields?.gasLimit,
  };
  return withQnetKeypair((pair) => {
    const { preimage, signature } = core.signTransfer(tx, pair.secretKey, pair.publicKey);
    return { preimage, signature, publicKey: pair.publicKey };
  });
}

/**
 * Signs a built-in token transfer (a contract call of "transfer" with [to, amount]): core.signTokenTransfer builds the
 * calldata, gas and preimage from these typed fields and self-verifies. Re-checks the session first.
 * @param {{from: string, token: string, to: string, amount: string, nonce: string}} fields amount in token base units
 * @returns {Promise<{tx: object, preimage: string, signature: Uint8Array, publicKey: Uint8Array}>} tx: the shared
 *   builder's transaction (core.buildTokenTransfer)
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_ADDRESS, INVALID_AMOUNT, KEY_ADDRESS_MISMATCH,
 *   SIGNATURE_SELF_CHECK_FAILED
 */
export async function signQnetTokenTransfer(fields) {
  const tx = { from: fields?.from, token: fields?.token, to: fields?.to, amount: fields?.amount, nonce: fields?.nonce };
  return withQnetKeypair((pair) => {
    const signed = core.signTokenTransfer(tx, pair.secretKey, pair.publicKey);
    return { tx: signed.tx, preimage: signed.preimage, signature: signed.signature, publicKey: pair.publicKey };
  });
}

/**
 * Signs a call of a WASM contract: core.signContractCall builds the calldata, gas and preimage from these typed fields
 * (args lowercase hex, '' for none; gasLimit null for the default fuel) and self-verifies. Re-checks the session first.
 * @param {{from: string, contract: string, method: string, args: string, nonce: string, gasLimit: string|null}} fields
 * @returns {Promise<{tx: object, preimage: string, signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_ADDRESS, INVALID_METHOD, INVALID_ARGS,
 *   INVALID_GAS_LIMIT, KEY_ADDRESS_MISMATCH, SIGNATURE_SELF_CHECK_FAILED
 */
export async function signQnetContractCall(fields) {
  const tx = {
    from: fields?.from, contract: fields?.contract, method: fields?.method, args: fields?.args, nonce: fields?.nonce,
    gasLimit: fields?.gasLimit ?? null,
  };
  return withQnetKeypair((pair) => {
    const signed = core.signContractCall(tx, pair.secretKey, pair.publicKey);
    return { tx: signed.tx, preimage: signed.preimage, signature: signed.signature, publicKey: pair.publicKey };
  });
}

/**
 * dApp message signature: core.signOffchainMessage over the domain-separated bytes with the FIPS 204
 * context OFFCHAIN_MESSAGE_CONTEXT. Never a raw-bytes signer. The message is checked before any key is
 * derived.
 * @param {string} origin the origin the router took from the port sender
 * @param {string} message
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array, address: string}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError PROTOCOL_PREFIX, INVALID_MESSAGE, MESSAGE_TOO_LONG, INVALID_ORIGIN
 */
export async function signOffchain(origin, message) {
  core.buildOffchainMessage(origin, message);
  return withQnetKeypair((pair) => core.signOffchainMessage(origin, message, pair.secretKey, pair.publicKey));
}

/**
 * Ed25519 over a serialized Solana transaction message built by solana.js (never bytes from a dApp).
 * @param {Uint8Array} messageBytes
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array}>} 64-byte signature, self-verified
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; INTERNAL for an empty or oversized message
 */
export async function signSolanaMessage(messageBytes) {
  if (!(messageBytes instanceof Uint8Array) || messageBytes.length === 0 || messageBytes.length > SOLANA_MESSAGE_MAX_BYTES) {
    throw new WalletError('INTERNAL');
  }
  return withSeed(async (seed, info) => {
    const pair = core.deriveSolanaKeypair(seed);
    try {
      await assertOwnAddress(pair.address, info.solanaAddress);
      return { signature: core.signSolanaMessage(messageBytes, pair.privateKey), publicKey: pair.publicKey };
    } finally {
      core.zeroize(pair.privateKey);
    }
  });
}

// ---------------------------------------------------------------- aiqnet.io's record of a burn (activation.js)

const BURN_AMOUNT_MAX = 1_000_000_000;
// base64url without padding (RFC 4648 section 5)
const base64url = (bytes) => core.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The text a burn record's proof covers (CONTRACTS.md decision 35): UTF-8, LF line breaks, no trailing LF, the amount in
 * decimal without leading zeros.
 * @param {{wallet: string, nodeType: 'light'|'super', burner: string, burnTx: string, burnAmount: number}} fields
 * @returns {string}
 */
export function burnRecordMessage({ wallet, nodeType, burner, burnTx, burnAmount }) {
  return [
    'QNet burn record v1', `wallet: ${wallet}`, `node: ${nodeType}`, `burner: ${burner}`, `burn: ${burnTx}`, `amount: ${burnAmount}`,
    `cluster: ${SOLANA.CLUSTER}`,
  ].join('\n');
}

/**
 * The proof that a burn is this wallet's, for aiqnet.io's record of it (decision 35): with M = burnRecordMessage(fields)
 * and E = core.buildSiteRecord(RECORD_ORIGIN, M), an ML-DSA-65 signature of E by the wallet's QNet key with the FIPS
 * 204 context QNET_OFFCHAIN_MSG_v1 (core.signSiteRecord, which a dApp's message never reaches: decision 36) and an
 * Ed25519 signature of the same E by the burner's key, the wallet's own Solana key. Only both keys of the phrase make one,
 * so nobody can plant a record for another wallet; it carries no time and may be sent again. Every field is checked
 * against the session first; no byte comes from a page.
 * @param {{wallet: string, nodeType: 'light'|'super', burner: string, burnTx: string, burnAmount: number}} fields
 * @returns {Promise<{pk: string, sig: string, solanaSig: string}>} base64url of the 1952-byte public key and of the
 *   3309-byte signature, base58 of the 64-byte Ed25519 signature
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, ADDRESS_MISMATCH (a wallet or burner not the session's), INTERNAL (a
 *   node type, signature or amount that is not one); CoreError SIGNATURE_SELF_CHECK_FAILED
 */
export async function signBurnRecord(fields) {
  const { wallet, nodeType, burner, burnTx, burnAmount } = fields ?? {};
  await startKeys();
  assertSigningEnabled();
  const info = await session.requireUnlocked();
  if (wallet !== info.qnetAddress || burner !== info.solanaAddress) throw new WalletError('ADDRESS_MISMATCH');
  if (!core.ACTIVATION_NODE_TYPES.includes(nodeType) || !core.isValidSolanaSignature(burnTx)
    || !Number.isSafeInteger(burnAmount) || burnAmount < 1 || burnAmount > BURN_AMOUNT_MAX) {
    throw new WalletError('INTERNAL');
  }
  const message = burnRecordMessage({ wallet, nodeType, burner, burnTx, burnAmount });
  const envelope = core.buildSiteRecord(RECORD_ORIGIN, message);
  const entropy = await vault.readEntropy();
  let seed;
  let pair;
  let burnerPair;
  try {
    seed = core.entropyToSeed(entropy);
    pair = core.deriveQnetKeypair(seed);
    await assertOwnAddress(pair.address, info.qnetAddress);
    burnerPair = core.deriveSolanaKeypair(seed);
    await assertOwnAddress(burnerPair.address, info.solanaAddress);
    const signed = core.signSiteRecord(RECORD_ORIGIN, message, pair.secretKey, pair.publicKey);
    const solanaSig = core.signSolanaMessage(envelope, burnerPair.privateKey);
    return { pk: base64url(pair.publicKey), sig: base64url(signed.signature), solanaSig: core.base58Encode(solanaSig) };
  } finally {
    core.zeroize(entropy, seed, pair?.secretKey, burnerPair?.privateKey, envelope);
  }
}

/**
 * The text a node reservation's proof covers (decision 36): UTF-8, LF line breaks, no trailing LF, the time in decimal
 * Unix seconds without leading zeros.
 * @param {{wallet: string, nodeType: 'light'|'super', way: 'extension'|'payment', burner: string, time: number}} fields
 * @returns {string}
 */
export function reservationMessage({ wallet, nodeType, way, burner, time }) {
  return [
    'QNet node reservation v1', `wallet: ${wallet}`, `node: ${nodeType}`, `way: ${way}`, `burner: ${burner}`, `time: ${time}`,
    `cluster: ${SOLANA.CLUSTER}`,
  ].join('\n');
}

/**
 * The proof that this wallet itself asks aiqnet.io's reservation for a burn (decision 36): with M =
 * reservationMessage(fields), an ML-DSA-65 signature of core.buildSiteRecord(RECORD_ORIGIN, M) by the wallet's QNet key
 * with the context QNET_OFFCHAIN_MSG_v1 (core.signSiteRecord). The way is always 'extension' and the burner the wallet's
 * own Solana address; aiqnet.io refuses it once it is more than 10 minutes old. Signed silently inside a burn the user
 * already confirmed; every field is checked against the session first, and no byte comes from a page.
 * @param {{wallet: string, nodeType: 'light'|'super', way: 'extension', burner: string, time: number}} fields time: Unix s
 * @returns {Promise<{pk: string, sig: string, time: number}>} base64url of the 1952-byte public key and of the 3309-byte
 *   signature, and the time signed
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, ADDRESS_MISMATCH (a wallet or burner not the session's), INTERNAL (a
 *   way, node type or time that is not one); CoreError SIGNATURE_SELF_CHECK_FAILED
 */
export async function signReservation(fields) {
  const { wallet, nodeType, way, burner, time } = fields ?? {};
  await startKeys();
  assertSigningEnabled();
  const info = await session.requireUnlocked();
  if (wallet !== info.qnetAddress || burner !== info.solanaAddress) throw new WalletError('ADDRESS_MISMATCH');
  if (way !== 'extension' || !core.ACTIVATION_NODE_TYPES.includes(nodeType) || !Number.isSafeInteger(time) || time < 1) {
    throw new WalletError('INTERNAL');
  }
  const message = reservationMessage({ wallet, nodeType, way, burner, time });
  const entropy = await vault.readEntropy();
  let seed;
  let pair;
  try {
    seed = core.entropyToSeed(entropy);
    pair = core.deriveQnetKeypair(seed);
    await assertOwnAddress(pair.address, info.qnetAddress);
    const signed = core.signSiteRecord(RECORD_ORIGIN, message, pair.secretKey, pair.publicKey);
    return { pk: base64url(pair.publicKey), sig: base64url(signed.signature), time };
  } finally {
    core.zeroize(entropy, seed, pair?.secretKey);
  }
}

// ---------------------------------------------------------------- the light node (nodes.js)

/**
 * The two signatures of this wallet's light node registration (docs/protocols/light-node-messages.md section 4): the
 * wallet's ML-DSA-65 consent and the burner's Ed25519 owner bind, both over the proof of the activation's burn at
 * `timestamp`. The core builds both messages and computes the proof; the node id must be the wallet's own.
 * `burnTx` and `burner` must be those of VaultState.activation (a light one), burned from the wallet's Solana address.
 * Re-checks the session first.
 * @param {{nodeId: string, wallet: string, burnTx: string, burner: string, timestamp: number}} fields timestamp: Unix s
 * @returns {Promise<{proof: string, consentSignature: Uint8Array, ownerSignature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, ADDRESS_MISMATCH, NOT_FOUND (no such light activation); CoreError
 *   INVALID_NODE_MESSAGE, KEY_ADDRESS_MISMATCH, SIGNATURE_SELF_CHECK_FAILED
 */
export async function signNodeRegistration(fields) {
  const { nodeId, wallet, burnTx, burner, timestamp } = fields ?? {};
  await startKeys();
  assertSigningEnabled();
  const info = await session.requireUnlocked();
  if (wallet !== info.qnetAddress) throw new WalletError('ADDRESS_MISMATCH');
  const { activation } = await vault.readState();
  if (activation?.nodeType !== 'light' || activation.burnTx !== burnTx || activation.solanaAddress !== burner) {
    throw new WalletError('NOT_FOUND');
  }
  if (burner !== info.solanaAddress) throw new WalletError('ADDRESS_MISMATCH');
  const entropy = await vault.readEntropy();
  let seed;
  let pair;
  let burnerPair;
  try {
    seed = core.entropyToSeed(entropy);
    pair = core.deriveQnetKeypair(seed);
    await assertOwnAddress(pair.address, info.qnetAddress);
    burnerPair = core.deriveSolanaKeypair(seed);
    await assertOwnAddress(burnerPair.address, info.solanaAddress);
    const message = { nodeId, wallet, burnTx, ts: timestamp };
    const consent = core.signNodeConsent(message, pair.secretKey, pair.publicKey);
    const owner = core.signOwnerBind(message, pair.publicKey, burnerPair.privateKey, burnerPair.publicKey);
    return { proof: consent.proof, consentSignature: consent.signature, ownerSignature: owner.signature, publicKey: pair.publicKey };
  } finally {
    core.zeroize(entropy, seed, pair?.secretKey, burnerPair?.privateKey);
  }
}

/**
 * Step 1 of moving this wallet's node balance: ML-DSA-65 over q1337|claim_rewards:{nodeId}:{wallet} (the core builds
 * it; the node id must be the wallet's own). Re-checks the session first.
 * @param {{nodeId: string, wallet: string}} fields
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_NODE_MESSAGE, KEY_ADDRESS_MISMATCH,
 *   SIGNATURE_SELF_CHECK_FAILED
 */
export async function signNodeClaim(fields) {
  const message = { nodeId: fields?.nodeId, wallet: fields?.wallet };
  return withQnetKeypair((pair) => ({
    signature: core.signClaimQuote(message, pair.secretKey, pair.publicKey).signature, publicKey: pair.publicKey,
  }));
}

/**
 * Step 2: ML-DSA-65 over q1337|qnet_claim_v1:{wallet}:{timestamp}:{sha3(claimsData)}, built by the core from the
 * payload a node quoted and its timestamp. Re-checks the session first.
 * @param {{wallet: string, timestamp: number, claimsData: string}} fields
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_NODE_MESSAGE, KEY_ADDRESS_MISMATCH,
 *   SIGNATURE_SELF_CHECK_FAILED
 */
export async function signClaimPayload(fields) {
  const message = { wallet: fields?.wallet, ts: fields?.timestamp, claimsData: fields?.claimsData };
  return withQnetKeypair((pair) => ({
    signature: core.signClaimPayload(message, pair.secretKey, pair.publicKey).signature, publicKey: pair.publicKey,
  }));
}

/**
 * The request for the signed status of this wallet's light node (its registration record): ML-DSA-65 over
 * q1337|light_status:{nodeId}:{timestamp}, built by the core; the node id must be the wallet's own. Re-checks the
 * session first.
 * @param {{nodeId: string, wallet: string, timestamp: number}} fields timestamp: Unix s
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_NODE_MESSAGE, KEY_ADDRESS_MISMATCH,
 *   SIGNATURE_SELF_CHECK_FAILED
 */
export async function signNodeStatus(fields) {
  const message = { nodeId: fields?.nodeId, wallet: fields?.wallet, ts: fields?.timestamp };
  return withQnetKeypair((pair) => ({
    signature: core.signNodeStatus(message, pair.secretKey, pair.publicKey).signature, publicKey: pair.publicKey,
  }));
}

/**
 * The wallet key's unbind of this wallet's light node from the device binding `seq` (CONTRACTS.md decision 38):
 * ML-DSA-65 over q1337|light_unbind_wallet:{nodeId}:{seq}:{timestamp}, built by the core; the node id must be the
 * wallet's own. Re-checks the session first.
 * @param {{nodeId: string, wallet: string, seq: string, timestamp: number}} fields seq: the binding's sequence (u64
 *   decimal); timestamp: Unix s
 * @returns {Promise<{signature: Uint8Array, publicKey: Uint8Array}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED; CoreError INVALID_NODE_MESSAGE, KEY_ADDRESS_MISMATCH,
 *   SIGNATURE_SELF_CHECK_FAILED
 */
export async function signNodeUnbind(fields) {
  const message = { nodeId: fields?.nodeId, wallet: fields?.wallet, seq: fields?.seq, ts: fields?.timestamp };
  return withQnetKeypair((pair) => ({
    signature: core.signNodeUnbind(message, pair.secretKey, pair.publicKey).signature, publicKey: pair.publicKey,
  }));
}

/**
 * Handler of `vault.exportKey` (popup only, owner 06.10: the private key behind the same protection as the recovery
 * phrase): after a fresh password check (vault.verifyPassword, with its backoff), the private key of one account in its
 * compact standard form. QNet: the 32-byte ML-DSA-65 KeyGen seed the wallet derives its key pair from
 * (core.walletXi of the phrase's seed; docs/applications/mobile-wallet.md, "QNet wallet key"), lowercase hex. Solana: the
 * 64-byte secret key (the Ed25519 private seed followed by the public key) in base58. The key pair is derived and checked
 * against the session's address first; the result is the only response that carries a private key, and nothing of it is
 * logged or kept. No import by private key exists (the owner decides that separately).
 * @param {{password: string, network: 'qnet'|'solana'}} params
 * @returns {Promise<{network: 'qnet'|'solana', address: string, privateKey: string}>}
 * @throws {WalletError} LOCKED, BACKOFF, BAD_PASSWORD, SIGNING_DISABLED, ADDRESS_MISMATCH, INVALID_PARAMS
 */
export async function exportPrivateKey(params) {
  const { password, network } = params ?? {};
  if (network !== 'qnet' && network !== 'solana') throw new WalletError('INVALID_PARAMS', { field: 'network' });
  await vault.verifyPassword(password);
  return withSeed(async (seed, info) => {
    if (network === 'qnet') {
      const pair = core.deriveQnetKeypair(seed);
      const xi = core.walletXi(seed);
      try {
        await assertOwnAddress(pair.address, info.qnetAddress);
        return { network, address: pair.address, privateKey: core.bytesToHex(xi) };
      } finally {
        core.zeroize(pair.secretKey, xi);
      }
    }
    const pair = core.deriveSolanaKeypair(seed);
    const secret = new Uint8Array(64);
    try {
      await assertOwnAddress(pair.address, info.solanaAddress);
      secret.set(pair.privateKey, 0);
      secret.set(pair.publicKey, 32);
      return { network, address: pair.address, privateKey: core.base58Encode(secret) };
    } finally {
      core.zeroize(pair.privateKey, secret);
    }
  });
}

/**
 * The wallet's ML-DSA-65 public key (for the dilithium_public_key field).
 * @returns {Promise<Uint8Array>} 1952 bytes
 * @throws {WalletError} LOCKED
 */
export async function getQnetPublicKey() {
  return withQnetKeypair((pair) => pair.publicKey);
}
