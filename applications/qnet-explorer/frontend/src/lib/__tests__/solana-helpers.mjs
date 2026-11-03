// Solana keys, signed transactions and a fake RPC for the tests of the site's Solana doors (cabinet-send-guard.test.mjs,
// solana-relay.test.mjs). Keys come from public labels, so no key material is kept anywhere.

import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { compileLegacyMessage, singleSignerWire } from '../solana-message.ts';

export const seed = (label) => createHash('sha256').update(label).digest();
export const keyOf = (label) => ({ seed: seed(label), pub: bs58.encode(ed25519.getPublicKey(seed(label))) });
export const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// `instructions` with `signers[0]` the fee payer, at `blockhash`, signed by every signer: the wire bytes.
export function signedWith(blockhash, instructions, signers) {
  const message = compileLegacyMessage(instructions, signers[0].pub, blockhash);
  const sigs = signers.map((s) => ed25519.sign(message, s.seed));
  if (sigs.length === 1) return singleSignerWire(sigs[0], message);
  return Uint8Array.from([sigs.length, ...sigs.flatMap((s) => [...s]), ...message]);
}

// An RPC answering each method from `answers` (a value, a function of the params, or an Error it throws), recording
// every call.
export function fakeRpc(answers = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    const a = answers[method];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(params) : a;
  };
  return { rpc, calls };
}
