/**
 * 29.09: the Solana transfers the app signs, byte for byte (src/crypto/SolanaTx.js). Every expected message below is
 * assembled here from the wire format itself (header, compact-u16 counts, 32-byte keys, blockhash, instructions with
 * program index, account indexes and data), from raw key bytes; the base58 texts and the associated token account come
 * from the separate implementation in the Solana library the app already depends on, and the result is read back by it
 * as well.
 */
import nacl from 'tweetnacl';
import { Message, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, PACKET_DATA_SIZE,
  associatedTokenAddress, base58Decode, base58Encode, compileMessage, decodeKey, fromBaseUnits, isOnCurve,
  isWalletAddress, messageFeePayer, serializeTransaction, toBaseUnits, transferInstructions, transferMessage,
} from '../src/crypto/SolanaTx';

const raw = (byte) => new Uint8Array(32).fill(byte);
const b58 = (bytes) => new PublicKey(bytes).toBase58(); // the library's own base58
const keyBytes = (text) => new PublicKey(text).toBytes();
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u64 = (n) => { const out = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; } return out; };

const FROM = raw(0x11);
const TO = raw(0x22);
const HASH = raw(0x33);
const MINT = raw(0x44);
const SOURCE = raw(0x55);
const REF = raw(0x66);
const SYSTEM = raw(0);
const TOKEN = keyBytes(TOKEN_PROGRAM_ID);
const ATA_PROGRAM = keyBytes(ASSOCIATED_TOKEN_PROGRAM_ID);
const MEMO = keyBytes(MEMO_PROGRAM_ID);
const DEST = PublicKey.findProgramAddressSync([TO, TOKEN, MINT], new PublicKey(ATA_PROGRAM))[0].toBytes();

const K = { from: b58(FROM), to: b58(TO), hash: b58(HASH), mint: b58(MINT), source: b58(SOURCE), ref: b58(REF), dest: b58(DEST) };

describe('base58 and addresses', () => {
  it('encodes and decodes as the other implementation does, leading zero bytes included', () => {
    for (const bytes of [FROM, SYSTEM, TOKEN, Uint8Array.of(0, 0, 1, 2, 255), nacl.randomBytes(64)]) {
      const text = base58Encode(bytes);
      if (bytes.length === 32) expect(text).toBe(b58(bytes));
      expect(Array.from(base58Decode(text))).toEqual(Array.from(bytes));
    }
    expect(base58Encode(SYSTEM)).toBe(SYSTEM_PROGRAM_ID);
    expect(base58Decode('0OIl')).toBe(null);
    expect(base58Encode(new Uint8Array(0))).toBe('');
    expect(base58Decode('')).toBe(null);
  });

  it('an address is base58 of exactly 32 bytes in its one canonical form', () => {
    expect(Array.from(decodeKey(K.from))).toEqual(Array.from(FROM));
    expect(decodeKey(TOKEN_PROGRAM_ID)).not.toBe(null);
    for (const bad of [base58Encode(nacl.randomBytes(31)), base58Encode(nacl.randomBytes(33)), `1${K.from}`, `${K.from} `,
      'not an address', '', null, 42, base58Encode(nacl.randomBytes(64))]) {
      expect([bad, decodeKey(bad)]).toEqual([bad, null]);
    }
  });

  it('a wallet address is a point on the curve; a program address is not', () => {
    const pair = nacl.sign.keyPair.fromSeed(raw(7));
    expect(isWalletAddress(base58Encode(pair.publicKey))).toBe(true);
    expect(isOnCurve(DEST)).toBe(false);
    expect(isWalletAddress(K.dest)).toBe(false);
    expect(PublicKey.isOnCurve(pair.publicKey)).toBe(true);
    expect(PublicKey.isOnCurve(DEST)).toBe(false);
  });

  it('the associated token account is the program address the other implementation derives', () => {
    expect(associatedTokenAddress(K.to, K.mint)).toBe(K.dest);
    for (let i = 0; i < 5; i++) {
      const owner = nacl.sign.keyPair.fromSeed(raw(100 + i)).publicKey;
      const mint = nacl.randomBytes(32);
      const expected = PublicKey.findProgramAddressSync([owner, TOKEN, mint], new PublicKey(ATA_PROGRAM))[0].toBase58();
      expect(associatedTokenAddress(b58(owner), b58(mint))).toBe(expected);
    }
  });
});

describe('amounts in base units, never a float', () => {
  it('scales a decimal text by the token\'s decimals', () => {
    expect(toBaseUnits('1.5', 9)).toBe(1_500_000_000n);
    expect(toBaseUnits('0.000000001', 9)).toBe(1n);
    expect(toBaseUnits('1000', 6)).toBe(1_000_000_000n);
    expect(toBaseUnits('0001.250000', 6)).toBe(1_250_000n); // leading and trailing zeros
    expect(toBaseUnits('18446744073709.551615', 6)).toBe((1n << 64n) - 1n);
    expect(fromBaseUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(fromBaseUnits(1n, 9)).toBe('0.000000001');
    expect(fromBaseUnits(0n, 6)).toBe('0');
    expect(fromBaseUnits(2_039_280n, 9)).toBe('0.00203928');
  });

  it('refuses more decimal places than the token has, zero, negatives, exponents and junk', () => {
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(expect.objectContaining({ code: 'AMOUNT_DECIMALS', params: { decimals: 6 } }));
    expect(() => toBaseUnits('1.0000000001', 9)).toThrow(expect.objectContaining({ code: 'AMOUNT_DECIMALS' }));
    for (const bad of ['0', '0.000', '-1', '1e3', '.5', '1.', '1,5', ' ', '', 'abc', '18446744073709.551616']) {
      expect(() => toBaseUnits(bad, 6)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    }
  });
});

describe('the messages, byte for byte', () => {
  it('a SOL transfer: System program Transfer from the fee payer', () => {
    const expected = cat(
      [1, 0, 1], [3], FROM, TO, SYSTEM, HASH,
      [1], [2, 2, 0, 1, 12, 2, 0, 0, 0, ...u64(1_500_000_000)],
    );
    const message = transferMessage({ kind: 'sol', from: K.from, to: K.to, amount: 1_500_000_000n }, K.hash);
    expect(Array.from(message)).toEqual(Array.from(expected));
    expect(message.length).toBe(150);
    // The other implementation builds the very same bytes for this transfer.
    const tx = new Transaction({ feePayer: new PublicKey(FROM), recentBlockhash: K.hash })
      .add(SystemProgram.transfer({ fromPubkey: new PublicKey(FROM), toPubkey: new PublicKey(TO), lamports: 1_500_000_000 }));
    expect(Array.from(tx.compileMessage().serialize())).toEqual(Array.from(expected));
  });

  it('a token transfer to an existing associated account: TransferChecked with the mint\'s decimals', () => {
    const expected = cat(
      [1, 0, 2], [5], FROM, SOURCE, DEST, MINT, TOKEN, HASH,
      [1], [4, 4, 1, 3, 2, 0, 10, 12, ...u64(1_000_000), 6],
    );
    const plan = {
      kind: 'token', from: K.from, to: K.to, mint: K.mint, decimals: 6, amount: 1_000_000n, source: K.source,
      destination: K.dest, createDestination: false,
    };
    expect(Array.from(transferMessage(plan, K.hash))).toEqual(Array.from(expected));
  });

  it('a token transfer to an address that never held it: the idempotent account create first, paid by the sender', () => {
    const expected = cat(
      [1, 0, 5], [8], FROM, DEST, SOURCE, TO, MINT, SYSTEM, TOKEN, ATA_PROGRAM, HASH,
      [2],
      [7, 6, 0, 1, 3, 4, 5, 6, 1, 1],
      [6, 4, 2, 4, 1, 0, 10, 12, ...u64(250_000_000), 6],
    );
    const plan = {
      kind: 'token', from: K.from, to: K.to, mint: K.mint, decimals: 6, amount: 250_000_000n, source: K.source,
      destination: K.dest, createDestination: true,
    };
    const message = transferMessage(plan, K.hash);
    expect(Array.from(message)).toEqual(Array.from(expected));

    // Read back by the other implementation: the same instructions, accounts and roles.
    const [create, transfer] = Transaction.populate(Message.from(Buffer.from(message))).instructions;
    expect(create.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(create.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [K.from, true, true], [K.dest, false, true], [K.to, false, false], [K.mint, false, false],
      [SYSTEM_PROGRAM_ID, false, false], [TOKEN_PROGRAM_ID, false, false],
    ]);
    expect(Array.from(create.data)).toEqual([1]);
    expect(transfer.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);
    expect(transfer.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [K.source, false, true], [K.mint, false, false], [K.dest, false, true], [K.from, true, true],
    ]);
    expect(Array.from(transfer.data)).toEqual([12, ...u64(250_000_000), 6]);
  });

  it('a payment request\'s memo comes right before the transfer, its references as read-only accounts of it', () => {
    const memo = Array.from(Buffer.from('order-42', 'utf8'));
    const expected = cat(
      [1, 0, 3], [5], FROM, TO, REF, MEMO, SYSTEM, HASH,
      [2],
      [3, 0, memo.length, ...memo],
      [4, 3, 0, 1, 2, 12, 2, 0, 0, 0, ...u64(5)],
    );
    const plan = { kind: 'sol', from: K.from, to: K.to, amount: 5n, references: [K.ref], memo: 'order-42' };
    expect(Array.from(transferMessage(plan, K.hash))).toEqual(Array.from(expected));
    // The order the request standard gives: account create, memo, transfer.
    const token = transferInstructions({ ...plan, kind: 'token', mint: K.mint, decimals: 6, source: K.source, destination: K.dest, createDestination: true });
    expect(token.map((ix) => ix.programId)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID]);
    expect(token[2].keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]).slice(-1)).toEqual([[K.ref, false, false]]);
  });

  it('the wire form: one signature by the fee payer, then the message, which the signature verifies over', () => {
    const pair = nacl.sign.keyPair.fromSeed(raw(9));
    const from = base58Encode(pair.publicKey);
    const message = transferMessage({ kind: 'sol', from, to: K.to, amount: 42n }, K.hash);
    expect(messageFeePayer(message)).toBe(from);
    const signature = nacl.sign.detached(message, pair.secretKey);
    const wire = serializeTransaction(signature, message);
    expect(Array.from(wire)).toEqual([1, ...signature, ...message]);
    const back = Transaction.from(Buffer.from(wire));
    expect(back.verifySignatures()).toBe(true);
    expect(back.signature.toString('hex')).toBe(Buffer.from(signature).toString('hex'));
    expect(() => serializeTransaction(signature.slice(0, 63), message)).toThrow();
    expect(() => serializeTransaction(signature, Uint8Array.of(2, ...message.slice(1)))).toThrow();
    expect(PACKET_DATA_SIZE).toBe(1232);
  });

  it('refuses what is not a transfer it can build: no instruction, a bad key, a bad blockhash, a u64 overflow', () => {
    expect(() => compileMessage([], K.from, K.hash)).toThrow();
    expect(() => transferMessage({ kind: 'sol', from: 'nope', to: K.to, amount: 1n }, K.hash)).toThrow();
    expect(() => transferMessage({ kind: 'sol', from: K.from, to: K.to, amount: 1n }, 'nope')).toThrow();
    expect(() => transferMessage({ kind: 'sol', from: K.from, to: K.to, amount: 1n << 64n }, K.hash)).toThrow();
    expect(() => transferMessage({ kind: 'other', from: K.from, to: K.to, amount: 1n }, K.hash)).toThrow();
    expect(messageFeePayer(Uint8Array.of(2, 0, 1, 3))).toBe(null);
  });
});
