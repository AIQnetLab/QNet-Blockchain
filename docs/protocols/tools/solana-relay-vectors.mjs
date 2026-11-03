#!/usr/bin/env node
// Known answers for the wallets' Solana relay (docs/applications/explorer.md, Wallets' Solana relay): the Solana
// transactions QNet Wallet and the QNet extension build, as their messages and signed wire bytes, which the relay must
// take as exactly these shapes. A send is compiled with its keys in the order its instructions name them (both
// wallets), the extension's activation burn in the order of the reference client's compiler. Keys come from public
// labels; everything is assembled here from the wire format with node:crypto and the tools' shared encodings
// (encoding.mjs). Checked by the app
// (__tests__/SolanaTx.test.js), the extension (test/chains-activation-solana.test.mjs) and the site
// (src/lib/__tests__/solana-relay.test.mjs).
//
//   node docs/protocols/tools/solana-relay-vectors.mjs            write ../solana-relay.vectors.json
//   node docs/protocols/tools/solana-relay-vectors.mjs --check    exit 1 if the file differs from a fresh run

import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58, ed25519Pkcs8, unbase58 as decode58 } from './encoding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../solana-relay.vectors.json');

const RELAY_PATH = '/api/cabinet/solana';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ONE_DEV_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
const ONE_DEV_DECIMALS = 6;
const NODE_TYPE_MEMO = { light: 'QNET_NODE_TYPE:LIGHT', super: 'QNET_NODE_TYPE:SUPER' };

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');
// Every base58 value read here is a 32-byte key or hash.
const unbase58 = (text) => decode58(text, 32);

// Ed25519 point decoding, strict (y below p, no negative zero): whether 32 bytes are a key's address, not a program's.
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function power(b, e) {
  let r = 1n;
  let x = mod(b);
  for (let k = e; k > 0n; k >>= 1n) {
    if (k & 1n) r = mod(r * x);
    x = mod(x * x);
  }
  return r;
}
const D = mod(-121665n * power(121666n, P - 2n));
function isOnCurve(bytes) {
  const le = BigInt(`0x${hex(Buffer.from(bytes).reverse())}`);
  const y = le & ((1n << 255n) - 1n);
  if (y >= P) return false;
  const x2 = mod((y * y - 1n) * power(D * y * y + 1n, P - 2n));
  if (x2 === 0n) return (le >> 255n) === 0n;
  return power(x2, (P - 1n) / 2n) === 1n;
}

// The associated token account of `owner` for `mint`: the first bump from 255 down whose hash is off the curve.
function ata(owner, mint) {
  for (let bump = 255; bump > 0; bump--) {
    const h = sha256(unbase58(owner), unbase58(TOKEN), unbase58(mint), [bump], unbase58(ASSOCIATED_TOKEN), utf8('ProgramDerivedAddress'));
    if (!isOnCurve(h)) return base58(h);
  }
  throw new Error('no program address');
}

// A test key from a public label: its address and a signer of messages.
function keyOf(label) {
  const privateKey = createPrivateKey({ key: ed25519Pkcs8(sha256(utf8(label))), format: 'der', type: 'pkcs8' });
  const address = base58(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, sign: (message) => nodeSign(null, message, privateKey) };
}

const u64le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const readonly = (keys) => keys.map((k) => meta(k, false, false));

const systemTransfer = (from, to, lamports, refs) => ({
  programId: SYSTEM, keys: [meta(from, true, true), meta(to, false, true), ...readonly(refs)], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(lamports)]),
});
const createIdempotent = (payer, account, owner) => ({
  programId: ASSOCIATED_TOKEN,
  keys: [meta(payer, true, true), meta(account, false, true), ...readonly([owner, ONE_DEV_MINT, SYSTEM, TOKEN])],
  data: Buffer.from([1]),
});
const transferChecked = (source, destination, owner, amount, refs) => ({
  programId: TOKEN,
  keys: [meta(source, false, true), meta(ONE_DEV_MINT, false, false), meta(destination, false, true), meta(owner, true, false), ...readonly(refs)],
  data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([ONE_DEV_DECIMALS])]),
});
const requestMemo = (text) => ({ programId: MEMO, keys: [], data: utf8(text) });
const burnOf = (account, owner, amount) => ({
  programId: TOKEN, keys: [meta(account, false, true), meta(ONE_DEV_MINT, false, true), meta(owner, true, false)], data: Buffer.concat([Buffer.from([8]), u64le(amount)]),
});
const signedMemo = (text, signer) => ({ programId: MEMO, keys: [meta(signer, true, false)], data: utf8(text) });

function compactU16(n) {
  const out = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) return [...out, low];
    out.push(low | 0x80);
  }
}

// The legacy message: the fee payer first, then signers that write, signers, writable and read-only accounts; within a
// class, 'listed' keeps the order the instructions first name a key in (program ids after every instruction's accounts),
// 'client' sorts by the collation the reference client's compiler uses.
const COLLATOR = new Intl.Collator('en', { usage: 'sort', sensitivity: 'variant', ignorePunctuation: false, numeric: false, caseFirst: 'lower' });
function compile(instructions, feePayer, blockhash, order) {
  const metas = [...instructions.flatMap((ix) => ix.keys), ...instructions.map((ix) => meta(ix.programId, false, false))];
  const unique = [];
  for (const m of metas) {
    const seen = unique.find((u) => u.pubkey === m.pubkey);
    if (seen) Object.assign(seen, { isSigner: seen.isSigner || m.isSigner, isWritable: seen.isWritable || m.isWritable });
    else unique.push({ ...m });
  }
  const rest = unique.filter((m) => m.pubkey !== feePayer).sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return order === 'client' ? COLLATOR.compare(x.pubkey, y.pubkey) : 0;
  });
  const accounts = [meta(feePayer, true, true), ...rest];
  const keys = accounts.map((m) => m.pubkey);
  const header = [
    accounts.filter((m) => m.isSigner).length,
    accounts.filter((m) => m.isSigner && !m.isWritable).length,
    accounts.filter((m) => !m.isSigner && !m.isWritable).length,
  ];
  const out = [...header, ...compactU16(keys.length), ...keys.flatMap((k) => [...unbase58(k)]), ...unbase58(blockhash), ...compactU16(instructions.length)];
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.programId), ...compactU16(ix.keys.length), ...ix.keys.map((k) => keys.indexOf(k.pubkey)));
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Buffer.from(out);
}

const PAYER = keyOf('qnet solana relay vectors: payer');
const RECIPIENT = keyOf('qnet solana relay vectors: recipient').address;
const REFERENCES = [0, 1, 2, 3].map((i) => keyOf(`qnet solana relay vectors: reference ${i}`).address);
// Another 1DEV account of the payer: the app spends from its fullest one when the associated one lacks the amount.
const OTHER_SOURCE = keyOf('qnet solana relay vectors: another 1DEV account').address;
const BLOCKHASH = base58(sha256(utf8('qnet solana relay vectors: recent blockhash')));

// A send as both wallets plan it: SOL, or 1DEV from `source` into the recipient's associated account (created first
// when `createAccount`), with a payment request's references and memo.
function transferCase(name, builders, { asset, to = RECIPIENT, amount, createAccount = false, source = null, references = [], memo = null }) {
  const from = PAYER.address;
  const transfer = { asset, from, to, amount: String(amount), references, memo };
  const memoIx = memo === null ? [] : [requestMemo(memo)];
  let instructions;
  if (asset === 'sol') {
    instructions = [...memoIx, systemTransfer(from, to, amount, references)];
  } else {
    Object.assign(transfer, { createAccount, source: source ?? ata(from, ONE_DEV_MINT), destination: ata(to, ONE_DEV_MINT) });
    instructions = [
      ...(createAccount ? [createIdempotent(from, transfer.destination, to)] : []),
      ...memoIx,
      transferChecked(transfer.source, transfer.destination, from, amount, references),
    ];
  }
  return signedCase(name, builders, { transfer }, compile(instructions, from, BLOCKHASH, 'listed'), { kind: asset === 'sol' ? 'sol' : 'token', payer: from });
}

// The extension's activation burn: Burn of `amountWhole` 1DEV from the payer's associated account, then its signed memo.
function burnCase(name, nodeType, amountWhole) {
  const owner = PAYER.address;
  const instructions = [burnOf(ata(owner, ONE_DEV_MINT), owner, BigInt(amountWhole) * 10n ** BigInt(ONE_DEV_DECIMALS)), signedMemo(NODE_TYPE_MEMO[nodeType], owner)];
  return signedCase(name, ['extension'], { burn: { owner, nodeType, amountWhole } }, compile(instructions, owner, BLOCKHASH, 'client'),
    { kind: 'burn', payer: owner, whole: amountWhole, nodeType });
}

function signedCase(name, builders, plan, message, shape) {
  const signature = PAYER.sign(message);
  const transaction = Buffer.concat([Buffer.from([1]), signature, message]);
  if (transaction.length > 1232) throw new Error(`${name}: larger than a Solana node takes`);
  return { name, builders, ...plan, message: hex(message), transaction: transaction.toString('base64'), signature: base58(signature), shape };
}

function build() {
  const both = ['app', 'extension'];
  const cases = [
    transferCase('sol', both, { asset: 'sol', amount: 1_500_000_000n }),
    transferCase('sol to itself', both, { asset: 'sol', to: PAYER.address, amount: 5_000n }),
    transferCase('sol with a memo and four references', both, { asset: 'sol', amount: 1n, references: REFERENCES, memo: 'Order 42 ✓' }),
    transferCase('sol with the payer as a reference', both, { asset: 'sol', amount: 2_000_000n, references: [PAYER.address] }),
    transferCase('1dev with the create', both, { asset: '1dev', amount: 1_500_000n, createAccount: true }),
    transferCase('1dev to an existing account', both, { asset: '1dev', amount: 1n }),
    transferCase('1dev with the create, a memo and two references', both, {
      asset: '1dev', amount: 250_000_000n, createAccount: true, references: REFERENCES.slice(0, 2), memo: 'm'.repeat(200),
    }),
    transferCase('1dev to itself', both, { asset: '1dev', to: PAYER.address, amount: 7n }),
    transferCase('1dev with the payer as a reference', both, { asset: '1dev', amount: 3_000_000n, references: [PAYER.address] }),
    transferCase('1dev from another account of the payer', ['app'], { asset: '1dev', amount: 9_000_000n, source: OTHER_SOURCE }),
    burnCase('burn for a light node', 'light', 1500),
    burnCase('burn for a super node', 'super', 1_000_000_000),
  ];
  return {
    about: 'The Solana transactions QNet Wallet and the QNet extension build, each as its message (hex) and its wire bytes '
      + 'signed by the payer (base64), with the shape the site\'s relay must read them as: a SOL transfer, a 1DEV transfer '
      + '(the recipient\'s associated account created first or not, a payment request\'s memo and references), and the '
      + 'extension\'s activation burn. `builders` names the wallets that build the case from `transfer` or `burn`.',
    generator: 'docs/protocols/tools/solana-relay-vectors.mjs',
    specs: ['docs/applications/explorer.md#wallets-solana-relay', 'docs/applications/mobile-wallet.md', 'docs/applications/browser-wallet.md'],
    constants: { relayPath: RELAY_PATH, oneDevMint: ONE_DEV_MINT, oneDevDecimals: ONE_DEV_DECIMALS, recentBlockhash: BLOCKHASH },
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
