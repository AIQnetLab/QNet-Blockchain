#!/usr/bin/env node
// Known answers for the registration of a light burn made from the wallet's own Solana address, finished with QNet
// Wallet's consent (qnet-link-v1.md section 14, the `link` request with `burner`; light-node-messages.md section 4):
// the wallet's Solana key on m/44'/501'/0'/0' of its recovery phrase, its owner bind v1 of the burn for the wallet's
// own light node at the consent's time T, the `link` request and its answer with `consent.ownerSig`, and the body the
// site submits to POST /api/v1/node-registration/submit. The wallets, burns, consents and T are those of
// light-node.vectors.json, so only the Solana key's signature is new here. Everything comes from node:crypto.
// Checked by the app (__tests__/OwnBurnConsent.test.js), the site (src/lib/__tests__/cabinet-own-burn.test.mjs) and
// the node (development/qnet-integration/src/node/mod.rs, own_burn_vector_*).
//
//   node docs/protocols/tools/own-burn-vectors.mjs            write ../light-node-own-burn.vectors.json
//   node docs/protocols/tools/own-burn-vectors.mjs --check    exit 1 if the file differs from a fresh run

import { createHash, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '../light-node.vectors.json');
const OUT = resolve(HERE, '../light-node-own-burn.vectors.json');
const SOLANA_PATH = [44, 501, 0, 0];
const BURN_AMOUNT = 1500;
const SUBMIT_KEYS = [
  'from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp', 'burn_tx_hash', 'burn_amount',
  'burn_wallet', 'dilithium_signature', 'dilithium_public_key', 'owner_signature',
];

const utf8 = (s) => Buffer.from(s, 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha3Hex = (b) => createHash('sha3-256').update(b).digest('hex');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${hex(bytes) || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// SLIP-0010 for ed25519: every level hardened.
function slip10(seed, path) {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);
  for (const index of path) {
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    I = createHmac('sha512', chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return Buffer.from(key);
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKeyOf = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
const publicKeyOf = (seed) => createPublicKey(privateKeyOf(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);

// The owner bind v1 (qnet-state burn_owner_bind_message): the node, the wallet, the proof, the consent's T, the wallet
// key's SHA3-256 and the burn.
const ownerBind = (nodeId, wallet, proof, ts, publicKeySha3, burnTx) =>
  `qnet_onchain_reg:${nodeId}:${wallet}:${proof}:${ts}:${publicKeySha3}:${burnTx}`;

function build() {
  const V = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const cases = V.node.map((n) => {
    const w = V.wallets.find((x) => x.name === n.wallet);
    const seed = pbkdf2Sync(utf8(w.mnemonic.normalize('NFKD')), utf8('mnemonic'), 2048, 64, 'sha512');
    if (hex(seed) !== w.phraseSeedHex) throw new Error(`${w.name}: phrase seed`);
    const solanaSeed = slip10(seed, SOLANA_PATH);
    const solanaPublic = publicKeyOf(solanaSeed);
    const burner = base58(solanaPublic);
    const consent = n.messages.find((m) => m.name === 'consent');
    const v1 = n.messages.find((m) => m.name === 'ownerBind');
    const ts = consent.inputs.ts;
    const preimage = ownerBind(n.nodeId, w.address, n.proof, ts, sha3Hex(Buffer.from(w.publicKey, 'hex')), n.burnTx);
    // The same preimage the vectors' burner signs: only the signer differs.
    if (preimage !== v1.preimage) throw new Error(`${w.name}: owner bind preimage`);
    const signature = nodeSign(null, utf8(preimage), privateKeyOf(solanaSeed));
    if (!nodeVerify(null, utf8(preimage), createPublicKey(privateKeyOf(solanaSeed)), signature)) throw new Error(`${w.name}: self-check`);
    const request = { burnTx: n.burnTx, walletHash: w.walletHash, check: false, burner };
    const requestText = JSON.stringify(request);
    const answer = {
      v: 1, intent: 'link', status: 'ok', qnet: w.address, nodeId: n.nodeId,
      consent: {
        ts, pk: b64u(Buffer.from(w.publicKey, 'hex')), sig: b64u(Buffer.from(consent.signature, 'hex')), ownerSig: b64u(signature),
      },
      bound: true,
    };
    const full = {
      from: w.address, node_id: n.nodeId, node_type: 'light', wallet_address: w.address, registration_proof: n.proof,
      timestamp: Number(ts), burn_tx_hash: n.burnTx, burn_amount: BURN_AMOUNT, burn_wallet: burner,
      dilithium_signature: consent.signature, dilithium_public_key: w.publicKey, owner_signature: hex(signature),
    };
    return {
      name: `own-burn-${w.name}`,
      wallet: { name: w.name, mnemonic: w.mnemonic, address: w.address, publicKey: w.publicKey, publicKeySha3: w.publicKeySha3, walletHash: w.walletHash },
      solana: { path: "m/44'/501'/0'/0'", seedHex: hex(solanaSeed), publicKey: hex(solanaPublic), address: burner },
      nodeId: n.nodeId,
      burnTx: n.burnTx,
      proof: n.proof,
      ts,
      burnAmount: BURN_AMOUNT,
      consent: { preimage: consent.preimage, signature: consent.signature },
      ownerBind: { preimage, signer: 'wallet-solana', signature: hex(signature) },
      request,
      requestText,
      reqHash: b64u(createHash('sha256').update(utf8(requestText)).digest()),
      plaintext: JSON.stringify(answer),
      submitBody: Object.fromEntries(SUBMIT_KEYS.map((k) => [k, full[k]])),
    };
  });
  return {
    about: 'A light burn made from the wallet\'s own Solana address, registered with QNet Wallet\'s consent: the wallet\'s Solana key, '
      + 'its owner bind v1 at the consent\'s time, the `link` request with `burner` and its answer with `consent.ownerSig`, and the '
      + 'body the site submits to the node. The wallets, burns, consents and T are those of light-node.vectors.json.',
    generator: 'docs/protocols/tools/own-burn-vectors.mjs',
    specs: ['docs/protocols/qnet-link-v1.md#14-revision-2', 'docs/protocols/light-node-messages.md'],
    source: 'docs/protocols/light-node.vectors.json',
    requestKeys: Object.keys(cases[0].request),
    consentKeys: Object.keys(JSON.parse(cases[0].plaintext).consent),
    submitKeys: SUBMIT_KEYS,
    cases,
  };
}

function main(argv) {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUT} differs from a fresh run`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUT} is up to date`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}

main(process.argv.slice(2));
