// The one-time payment key of an activation (plan-site section 4.1): an Ed25519 key the browser makes
// non-extractable, whose public key is the payment address. It signs exactly three things, each built here from
// verified inputs and never from bytes a relay, a node or a URL supplied: the burn, only under the wallet's reservation
// in the server's activation registry, which the wallet itself signed in QNet Wallet; the v2 owner bind of that reserved
// wallet's light node to the burn, right after the burn is signed and before it is sent (shared contract C4); and the
// refund of what is left to the wallet. Only the activation page imports this module.

import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { ACTIVATION_NETWORK } from '../one-dev.ts';
import { bytesToHex, consentProof, decodeB64url, eonOfPublicKey, lightNodeId, MLDSA65_PUBLIC_KEY_BYTES, utf8Bytes } from '../qnet-link.ts';
import { isEonAddress } from '../qnet-provider.ts';
import { compileLegacyMessage, singleSignerWire, type Instruction } from '../solana-message.ts';
import { burnInstructions, refundInstructions, type RefundPlan } from './burn-tx.ts';
import type { Network, PaymentRecord } from './flow.ts';
import { SIGN_MARGIN_MS } from './burn-record.ts';
import { ownerBindMessageV2 } from './registration.ts';
import { browserArea, requestPersistence, saveNew, storageAvailable, type PaymentArea } from './payment-store.ts';

export interface SignedTx {
  wire: Uint8Array;
  // The transaction id: the base58 of the fee payer's signature.
  signature: string;
}

// Whether this browser can make and keep a payment key: WebCrypto Ed25519 and IndexedDB in a secure context.
export async function paymentKeySupported(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<boolean> {
  if (!subtle || !storageAvailable() || globalThis.isSecureContext === false) return false;
  try {
    await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

// A new payment address in this browser for `wallet`'s light node, stored before anything else happens; null when the
// browser cannot keep one. It starts at `walletConfirm`: nothing shows the address until QNet Wallet confirmed that the
// light node is for that wallet (activation.ts takeHold), so nothing can be sent to it before. The browser is asked to
// keep the site's storage (SITE-R1-06), without waiting for its answer. Its network is the release's, never the page's
// choice: a devnet release makes no mainnet record (SITE-R3-01).
export async function createPaymentKey(
  {
    wallet, subtle = globalThis.crypto?.subtle, area = browserArea, now = Date.now(), persist = requestPersistence,
  }: { wallet: string; subtle?: SubtleCrypto; area?: PaymentArea; now?: number; persist?: () => Promise<boolean> },
): Promise<PaymentRecord | null> {
  const network: Network = ACTIVATION_NETWORK;
  if (!subtle || !isEonAddress(wallet)) return null;
  let pair: CryptoKeyPair;
  let pub: Uint8Array;
  try {
    pair = (await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  } catch {
    return null;
  }
  if (pub.length !== 32 || pair.privateKey.extractable) return null;
  const record: PaymentRecord = {
    v: 1, pub: bs58.encode(pub), key: pair.privateKey, network, createdAt: now, updatedAt: now, stage: 'walletConfirm',
    burn: null, link: null, answer: null, submit: null, refund: null, wallet,
  };
  if (!(await saveNew(record, area))) return null;
  void Promise.resolve().then(persist).catch(() => false);
  return record;
}

// Signs `message` with the record's key and checks the signature against its address before anything leaves.
async function sign(record: PaymentRecord, message: Uint8Array, subtle: SubtleCrypto): Promise<Uint8Array> {
  if (!record.key) throw new Error('no key');
  const signature = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, record.key, new Uint8Array(message)));
  if (!ed25519.verify(signature, message, bs58.decode(record.pub))) throw new Error('signature');
  return signature;
}

async function signTx(record: PaymentRecord, instructions: Instruction[], blockhash: string, subtle: SubtleCrypto): Promise<SignedTx> {
  const message = compileLegacyMessage(instructions, record.pub, blockhash);
  const signature = await sign(record, message, subtle);
  return { wire: singleSignerWire(signature, message), signature: bs58.encode(signature) };
}

// 1. The burn of `whole` 1DEV, only from a funded record whose wallet signed its reservation, and only under that
// wallet's reservation of that very amount with at least SIGN_MARGIN_MS of it left (shared contract C0): two browsers
// cannot both burn for one wallet, and nobody burns in a wallet's name without it.
export async function signBurn(record: PaymentRecord, whole: number, blockhash: string, subtle: SubtleCrypto = crypto.subtle, now: number = Date.now()): Promise<SignedTx> {
  if (record.stage !== 'funded') throw new Error('stage');
  const held = record.reservation;
  if (!held || !held.wallet || held.until - now < SIGN_MARGIN_MS || held.amount !== whole || record.hold?.wallet !== held.wallet) throw new Error('reservation');
  return signTx(record, burnInstructions(record.pub, whole), blockhash, subtle);
}

// 2. The v2 owner bind of the burn about to be sent (the funded record with the signed burn in record.burn): it names the
// reserved wallet's light node, the registration proof of this burn and the SHA3-256 of the wallet's own ML-DSA-65 key
// from its signed reservation, so the burn can register that wallet's node and no other. The hex signature the send
// carries (POST /api/cabinet/send), which the site keeps with the wallet's record.
export async function signOwnerBindV2(record: PaymentRecord, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const held = record.reservation;
  const hold = record.hold;
  if (record.stage !== 'funded' || !record.burn || !held || !hold || held.wallet !== hold.wallet) throw new Error('reservation');
  const pk = decodeB64url(hold.pk, MLDSA65_PUBLIC_KEY_BYTES);
  if (!pk || eonOfPublicKey(pk) !== hold.wallet) throw new Error('hold');
  const wallet = hold.wallet;
  const nodeId = lightNodeId(wallet);
  const message = ownerBindMessageV2(nodeId, wallet, consentProof(record.burn.tx, nodeId, wallet), pk, record.burn.tx);
  return bytesToHex(await sign(record, utf8Bytes(message), subtle));
}

// 3. What is left, back to the wallet's Solana address, only once the activation is recorded or has ended.
export async function signRefund(record: PaymentRecord, dest: string, plan: RefundPlan, blockhash: string, subtle: SubtleCrypto = crypto.subtle): Promise<SignedTx> {
  if (record.stage !== 'leftovers' && record.stage !== 'closing') throw new Error('stage');
  return signTx(record, refundInstructions(record.pub, dest, plan), blockhash, subtle);
}
