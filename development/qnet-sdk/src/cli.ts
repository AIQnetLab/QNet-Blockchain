#!/usr/bin/env node
// qnet: the QNet command line. Keys stay in encrypted files on this computer; every transaction is built by the
// shared builders, shown, confirmed, signed here and sent to a node. Nothing secret is ever printed.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  isAnswerTooLarge, LOG_WINDOW, MAX_PROOF_AGE_BLOCKS, NodeClient, type AccountInfo, type SubmitResult, type WalkProgress,
} from './client.js';
import { QNetError, QNetNodeError } from './errors.js';
import { generateEntropy, recoveryPhraseToEntropy } from './keys.js';
import { createKey, keystoreDir, listKeys, PASSWORD_MIN_CHARS, readKeyInfo, unlockKey, type KeyInfo } from './keystore.js';
import {
  buildContractCall, buildContractDeploy, buildTokenTransfer, buildTransfer, CANONICAL_BURN_ADDRESS, isValidAddress,
  MIN_GAS_PRICE, signTransaction, TOKEN_ENTRY_DEPOSIT_NANO,
} from './tx.js';
import type { Tx } from './types.js';
import { formatUnits, parseUnits } from './units.js';
import { checkModule, type ModuleReport } from './wasm.js';

declare const __SDK_VERSION__: string;

class UsageError extends Error {}
/** The user stopped: nothing was sent. */
class Declined extends Error {}

const HELP = `qnet: the QNet command line

Usage: qnet <command> [options]

Keys (encrypted files in ~/.qnet/keys, or $QNET_HOME/keys):
  keys new [--name NAME] [--words 12|24]  create a key; its recovery phrase is never shown, so back up the key file
  keys import [--name NAME]               store the key of a 12- or 24-word recovery phrase
  keys list                               every key and its address
  keys address [NAME]                     the address of a key
  keys export-public [NAME]               the address and public key of a key

Reading:
  balance [ADDRESS] [--key NAME] [--verified]
  token info CONTRACT
  token balance CONTRACT [ADDRESS] [--key NAME]
  logs CONTRACT [--from HEIGHT] [--to HEIGHT]
  tx HASH

Sending (each shows what it will sign and asks before sending):
  transfer --to ADDRESS --amount QNC
  token transfer CONTRACT --to ADDRESS --amount AMOUNT
  call CONTRACT METHOD [--args HEX | --args-utf8 TEXT] [--fuel N | --gas-limit N]
  deploy FILE.wasm
  check FILE.wasm                         only the local module check

Sending options:
  --key NAME        the key to sign with (default: "default", or the only key)
  --gas-price N     nano-QNC per gas, at least ${MIN_GAS_PRICE}
  --nonce N         the nonce to use instead of reading it from a node
  --dry-run         print the exact text that would be signed and send nothing
  --yes             do not ask (required without a terminal)
  --no-wait         do not wait for the transaction to reach a block
  --burn            allow sending to the burn address, which destroys what is sent

Global options:
  --network testnet the network (testnet, the default and only one)
  --node URL        a node to use instead of the network's own (repeatable; https, or http on this machine)
  --home DIR        the QNet directory (default $QNET_HOME, else ~/.qnet)
  --timeout SECONDS how long to wait for each node request (default 10, at most 600)
  --json            machine-readable output on standard output; a send that asks first shows its review on
                    standard error
  --help, --version

Without a terminal, secrets are read from standard input, one per line: the recovery phrase (keys import), then
the password. There is no QNC faucet: test QNC comes from a funded wallet.
`;

type Flags = Record<string, string | string[] | boolean | undefined>;
type Kind = 'string' | 'strings' | 'boolean';

const GLOBAL_FLAGS: Record<string, Kind> = {
  network: 'string', node: 'strings', home: 'string', timeout: 'string', json: 'boolean', help: 'boolean', version: 'boolean',
};
const SEND_FLAGS: Record<string, Kind> = {
  key: 'string', 'gas-price': 'string', nonce: 'string', 'dry-run': 'boolean', yes: 'boolean', 'no-wait': 'boolean', burn: 'boolean',
};

interface Command {
  flags: Record<string, Kind>;
  positionals: [number, number];
  names: string;
  run(ctx: Ctx, args: string[]): Promise<void>;
}

interface Ctx {
  flags: Flags;
  json: boolean;
  home: string;
  /** Milliseconds each node request may take (--timeout), or undefined for the client's default. */
  timeoutMs: number | undefined;
  client(): NodeClient;
  out(text: string): void;
  /** Standard error: notes, and the review of a send that asks first under --json. */
  note(text: string): void;
  result(value: unknown): void;
}

function parseArgs(argv: string[], spec: Record<string, Kind>): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);
    if (kind === 'boolean') {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      if (flags[name] !== undefined) throw new UsageError(`--${name} is given twice`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    if (kind === 'strings') {
      flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
    } else {
      if (flags[name] !== undefined) throw new UsageError(`--${name} is given twice`);
      flags[name] = value;
    }
  }
  return { flags, positionals };
}

// ---- input: a terminal asks without echo; otherwise standard input gives one line per secret ----

const interactive = Boolean(process.stdin.isTTY);
let piped: string[] | null = null;

async function pipedLine(what: string): Promise<string> {
  if (piped === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    if (piped[piped.length - 1] === '') piped.pop();
  }
  const line = piped.shift();
  if (line === undefined) throw new UsageError(`standard input ended before the ${what}`);
  return line;
}

function hidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Declined('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

const secret = (question: string, what: string): Promise<string> => (interactive ? hidden(question) : pipedLine(what));

async function newPassword(): Promise<string> {
  const password = await secret(`New password for the key file (at least ${PASSWORD_MIN_CHARS} characters): `, 'password');
  if (interactive && (await hidden('Repeat the password: ')) !== password) throw new UsageError('the passwords differ');
  return password;
}

async function confirm(ctx: Ctx, question: string): Promise<void> {
  if (ctx.flags.yes) return;
  if (!interactive) throw new UsageError('nothing was sent: without a terminal, confirm with --yes');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} Type yes to send: `, resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') throw new Declined('Not sent.');
}

// ---- helpers ----

const qnc = (nano: bigint | string): string => `${formatUnits(nano)} QNC`;

function address(value: string, what: string): string {
  if (!isValidAddress(value)) throw new UsageError(`${what} is not a QNet address: ${value}`);
  return value;
}

function integer(value: string | undefined, what: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,15}$/.test(value) || Number(value) < min) throw new UsageError(`${what} must be a whole number of at least ${min}`);
  return Number(value);
}

async function pickKey(ctx: Ctx): Promise<KeyInfo> {
  const name = ctx.flags.key as string | undefined;
  if (name) return readKeyInfo(name, { home: ctx.home });
  const keys = (await listKeys({ home: ctx.home })).filter((k) => k.address);
  const chosen = keys.find((k) => k.name === 'default') ?? (keys.length === 1 ? keys[0] : undefined);
  if (chosen) return chosen;
  if (keys.length === 0) throw new UsageError('no key yet: create one with "qnet keys new" or "qnet keys import"');
  throw new UsageError(`several keys: choose one with --key (${keys.map((k) => k.name).join(', ')})`);
}

async function ownOrGiven(ctx: Ctx, given: string | undefined): Promise<string> {
  return given ? address(given, 'The address') : (await pickKey(ctx)).address;
}

function printable(hex: string): string | null {
  if (hex.length === 0) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(hex, 'hex'));
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

// Text a node, a token's deployer or a module's author chose, as the terminal gets it: control, format (bidirectional overrides among
// them) and line-separator characters escaped, so it cannot move the cursor, erase or reorder review lines, and at
// most `max` characters.
function shown(value: string | null | undefined, max = 120): string {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : text;
}

// The light client's verified checkpoints are a trust root: a file that other users can change is ignored, as are
// files in a directory they can write (where they could replace it). Windows has no file modes to check.
async function privateToUser(file: string, dir: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const uid = process.getuid?.();
  const [f, d] = await Promise.all([stat(file), stat(dir)]);
  return f.isFile() && (f.mode & 0o077) === 0 && (d.mode & 0o022) === 0 && (uid === undefined || (f.uid === uid && d.uid === uid));
}

// Writes `text` to `file` only while `dir` is this user's alone (DEVP-R1-05): into a new file of its own next to it
// (created exclusively, so nothing planted under that name is followed), then renamed over the name, which replaces
// whatever the name was instead of writing through it. A name that is anything but a plain file is left alone.
// Returns why it did not write, or null.
async function writePrivate(file: string, dir: string, text: string): Promise<string | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    const d = await stat(dir);
    if ((d.mode & 0o022) !== 0 || (uid !== undefined && d.uid !== uid)) return 'other users of this computer can write its directory';
  }
  const existing = await lstat(file).catch(() => null);
  if (existing && !existing.isFile()) return 'it is not a plain file';
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return null;
}

function anchorsStore(ctx: Ctx) {
  const file = path.join(ctx.home, `anchors-${ctx.client().network}.json`);
  let cached: unknown = null;
  let written: string | null = null;
  let writes: Promise<void> = Promise.resolve();
  let warned = false;
  const warn = (why: string) => {
    if (!warned) ctx.note(`qnet: not keeping the verified checkpoints in ${file}: ${why}`);
    warned = true;
  };
  const write = async (text: string) => {
    if (text === written) return;
    const why = await writePrivate(file, ctx.home, text);
    if (why) warn(why);
    else written = text;
  };
  return {
    file,
    load: () => cached,
    async prepare() {
      cached = null;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return;
      }
      try {
        if (!(await privateToUser(file, ctx.home))) {
          ctx.note(`qnet: ignoring ${file}: other users of this computer can change it (make it private: chmod 600, and its directory 700)`);
          return;
        }
        cached = JSON.parse(text);
      } catch {
        cached = null;
      }
    },
    // Called after every round of the walk, so what was verified is on disk even if the run is stopped.
    save: (anchors: unknown) => {
      cached = anchors;
      if (!anchors) return;
      const text = JSON.stringify(anchors);
      writes = writes.then(() => write(text)).catch((error: unknown) => warn(error instanceof Error ? error.message : String(error)));
    },
    flush: () => writes,
  };
}

// How long `balance --verified` walks the checkpoint lineage at most. It shows how far it got as it goes, and keeps
// checkpoints of what it verified after every round, so the next run whose proof is checked on the same parity chain
// (even or odd macroblocks) goes on from them.
const CLI_WALK_TIME_MS = 30 * 60_000;

// Whether the kept checkpoints (the anchors file's keys, macroblock indices) hold one on `parity`'s chain.
function keptOnChain(anchors: unknown, parity: number): boolean {
  if (typeof anchors !== 'object' || anchors === null) return false;
  return Object.keys(anchors).some((k) => /^[0-9]+$/.test(k) && Number(k) % 2 === parity);
}

interface SendPlan {
  key: KeyInfo;
  account: AccountInfo | null;
  tx: Tx;
  /** QNC the account must hold beyond the fee. */
  extraNano: bigint;
  lines: Array<[string, string]>;
  question: string;
}

async function nonceFor(ctx: Ctx, key: KeyInfo): Promise<{ nonce: string; account: AccountInfo | null }> {
  const given = ctx.flags.nonce as string | undefined;
  if (given !== undefined) {
    integer(given, '--nonce', 1);
    return { nonce: given, account: ctx.flags['dry-run'] ? null : await ctx.client().getAccount(key.address) };
  }
  const account = await ctx.client().getAccount(key.address);
  return { nonce: (BigInt(account.nonce) + 1n).toString(), account };
}

const gasPrice = (ctx: Ctx): number => integer(ctx.flags['gas-price'] as string | undefined, '--gas-price', 1) ?? MIN_GAS_PRICE;

// A contract account has no key, and no contract can send QNC or a built-in token on: whatever a transfer or a token
// transfer credits to one stays there for good (DEVP-R1-01). The nodes refuse such a transfer at their doors
// (`recipient_is_contract`), but a node without that check takes it and a block carrying it applies, so the command
// never sends one (DEVP-R3-02). The recipient is read first; an account too large to read (a contract's whole storage)
// counts as a contract. A dry run with --nonce contacts no node and is not checked.
async function checkRecipient(ctx: Ctx, to: string): Promise<void> {
  if (ctx.flags['dry-run'] && ctx.flags.nonce) return;
  let contract: boolean;
  try {
    contract = (await ctx.client().getAccount(to)).isContract;
  } catch (error) {
    if (!isAnswerTooLarge(error)) throw error;
    contract = true;
  }
  if (contract) {
    throw new UsageError(`${to} is a contract: nothing can ever move what is sent to it, so the command does not send there`);
  }
}

function checkBurn(ctx: Ctx, to: string): void {
  if (to === CANONICAL_BURN_ADDRESS && !ctx.flags.burn) {
    throw new UsageError('that is the burn address: whatever is sent there is destroyed. Add --burn if that is what you want');
  }
}

// One review line: the value at column 15, and never touching a label of 14 characters or more.
const label = (k: string, v: string): string => `${`${k}:`.padEnd(13)} ${v}`;

// Where a send's review goes: standard output, or under --json (which keeps standard output for the result) standard
// error, whenever the user is asked to confirm; nowhere only for --json --yes, where nobody is asked.
function reviewOut(ctx: Ctx): ((text: string) => void) | null {
  if (!ctx.json) return ctx.out;
  return ctx.flags.yes ? null : ctx.note;
}

// The one safe way to try again while a transaction's fate is open: the same nonce, since at most one transaction of
// an address applies at a nonce.
const sameNonceHint = (nonce: string): string => `To send it again safely, reuse the nonce: add --nonce ${nonce}; at most one of the two can apply.`;

async function execute(ctx: Ctx, plan: SendPlan): Promise<void> {
  const { tx, key } = plan;
  const lines: Array<[string, string]> = [
    ['Network', `${ctx.client().network} (q1337)`],
    ['From', `${tx.from} (key "${key.name}")`],
    ...plan.lines,
    ['Nonce', tx.nonce],
    ['Gas', `${tx.gasLimit} at ${tx.gasPrice} nano-QNC (the network charges 1.5 times the price)`],
    ['Fee at most', qnc(tx.maxFeeNano)],
  ];
  if (ctx.flags['dry-run']) {
    if (ctx.json) return ctx.result({ dryRun: true, path: tx.path, preimage: tx.preimage, tx });
    for (const [k, v] of lines) ctx.out(label(k, v));
    ctx.out(`Route:        POST ${tx.path}`);
    ctx.out('Text to sign:');
    ctx.out(tx.preimage);
    return;
  }
  const account = plan.account!;
  const need = BigInt(tx.maxFeeNano) + plan.extraNano;
  if (BigInt(account.balanceNano) < need) {
    throw new QNetError('INSUFFICIENT_FUNDS', `The account holds ${qnc(account.balanceNano)}; this needs up to ${qnc(need)}`);
  }
  const review = reviewOut(ctx);
  if (review) for (const [k, v] of lines) review(label(k, v));
  await confirm(ctx, plan.question);
  const password = await secret(`Password for key "${key.name}": `, 'password');
  const pair = await unlockKey(key.name, password, { home: ctx.home });
  let signature: Uint8Array;
  try {
    signature = signTransaction(tx, pair.secretKey, pair.publicKey);
  } finally {
    pair.secretKey.fill(0);
  }
  // Unlocking the key held this process for seconds, time in which the nonce may have been used and a node may have
  // closed the connection kept open to it (DEVP-R1-08). Reading the account again checks the one and renews the
  // other (a read on a reset connection is repeated on a new one), so the send does not go out on a dead connection.
  const fresh = await ctx.client().getAccount(tx.from);
  if (BigInt(fresh.nonce) >= BigInt(tx.nonce)) {
    throw new QNetError('INVALID_NONCE', `Nonce ${tx.nonce} is already used (the account is at nonce ${fresh.nonce}): nothing was sent`);
  }
  const attach = tx.kind === 'contractDeploy' || !account.hasPublicKey;
  let sent: SubmitResult | null = null;
  let uncertain: QNetNodeError | null = null;
  try {
    // An elided key goes on after all for a node that cannot resolve it yet (a block behind its first use).
    sent = await ctx.client().submit(tx, signature, attach ? pair.publicKey : null, { publicKeyIfUnresolved: pair.publicKey });
  } catch (error) {
    if (!(error instanceof QNetNodeError && error.code === 'SUBMIT_UNCERTAIN')) throw error;
    uncertain = error;
  }
  const txHash = sent?.txHash ?? null;
  if (!ctx.json) {
    if (sent) ctx.out(txHash ? `Sent to ${sent.node}: transaction ${txHash}` : `Sent to ${sent.node}`);
    else ctx.out(`Not confirmed by any node, and one that gave no answer may have taken it (${shown(uncertain!.reason, 300)}).`);
    ctx.out(`Its identity is (${tx.from}, nonce ${tx.nonce}); another node may name its copy with another hash.`);
  }
  if (ctx.flags['no-wait']) {
    if (ctx.json) ctx.result({ sent: sent ? true : 'unknown', txHash, from: tx.from, nonce: tx.nonce, node: sent?.node ?? null });
    else if (uncertain) ctx.out(`It may still apply: check that the account's nonce reaches ${tx.nonce} (qnet balance) before sending again. ${sameNonceHint(tx.nonce)}`);
    if (uncertain) process.exitCode = 1;
    return;
  }
  if (!ctx.json) ctx.out('Waiting for a block...');
  const wait = await ctx.client().waitForTransaction({ from: tx.from, nonce: tx.nonce, txHash });
  let deployed: boolean | null = null;
  if (tx.kind === 'contractDeploy' && wait.state === 'applied') {
    const contract = await ctx.client().getAccount(tx.contractAddress);
    deployed = contract.isContract && contract.contractType === 'wasm';
  }
  if (ctx.json) {
    ctx.result({ sent: sent ? true : 'unknown', txHash, from: tx.from, nonce: tx.nonce, state: wait.state, blockHeight: wait.blockHeight,
      ...(tx.kind === 'contractDeploy' ? { contractAddress: tx.contractAddress, deployed } : {}) });
  } else if (wait.state === 'applied') {
    if (tx.kind === 'contractDeploy') {
      ctx.out(deployed ? `Deployed. Contract address: ${tx.contractAddress}` : `The nonce was used, but no contract is at ${tx.contractAddress} yet.`);
    } else if (tx.kind === 'contractCall') {
      ctx.out(`In a block: nonce ${tx.nonce} is used. The network records no call result: check the contract's events (qnet logs) or its state.`);
    } else {
      ctx.out(`Done: nonce ${tx.nonce} is applied.`);
    }
  } else if (wait.state === 'not_applied') {
    ctx.out(`A block holds it (height ${wait.blockHeight}), but the network did not apply it: the nodes asked all report nonce ${tx.nonce} unused, so nothing was charged. ${sameNonceHint(tx.nonce)}`);
  } else if (wait.blockHeight !== null) {
    ctx.out(`A block holds it (height ${wait.blockHeight}), but no node has shown nonce ${tx.nonce} used yet. It has applied once the account's nonce reaches ${tx.nonce} (qnet balance shows it). ${sameNonceHint(tx.nonce)}`);
  } else {
    ctx.out(txHash
      ? `Not in a block yet. Check later with: qnet tx ${txHash}. ${sameNonceHint(tx.nonce)}`
      : `Not known yet whether it applied: it has once the account's nonce reaches ${tx.nonce} (qnet balance shows it). ${sameNonceHint(tx.nonce)}`);
  }
  if (wait.state === 'not_applied' || (uncertain && wait.state !== 'applied')) process.exitCode = 1;
}

// Export and import names are the module's own UTF-8 text, as untrusted as a node's: each goes through shown(), so a
// name cannot hide or fake the review lines printed after it.
function printModule(out: (text: string) => void, report: ModuleReport): void {
  out(`Module:       ${report.bytes.toLocaleString('en-US')} bytes, code hash ${report.codeHash}`);
  out(`Entries:      ${report.entries.map((e) => shown(e, 64)).join(', ')}`);
  out(`Imports:      ${report.imports.length ? report.imports.map((i) => shown(i, 64)).join(', ') : 'none'}`);
  out(`Memory:       ${report.memoryPages.initial} to ${report.memoryPages.maximum} pages of 64 KiB`);
  out(`Deploy gas:   ${report.deployGas.toLocaleString('en-US')}`);
}

async function readModule(file: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
}

// ---- commands ----

const COMMANDS: Record<string, Command> = {
  'keys new': {
    names: 'keys new', flags: { name: 'string', words: 'string' }, positionals: [0, 0],
    async run(ctx) {
      const words = (ctx.flags.words as string | undefined) ?? '24';
      if (words !== '12' && words !== '24') throw new UsageError('--words is 12 or 24');
      const name = (ctx.flags.name as string | undefined) ?? 'default';
      const password = await newPassword();
      const entropy = generateEntropy(Number(words) as 12 | 24);
      let key: KeyInfo;
      try {
        key = await createKey({ name, entropy, password }, { home: ctx.home });
      } finally {
        entropy.fill(0);
      }
      if (ctx.json) return ctx.result({ name: key.name, address: key.address, file: key.file });
      ctx.out(`Key "${key.name}" created: ${key.address}`);
      ctx.out(`File: ${key.file}`);
      ctx.out('Its recovery phrase is not shown and exists nowhere else: back up this file and keep its password.');
    },
  },
  'keys import': {
    names: 'keys import', flags: { name: 'string' }, positionals: [0, 0],
    async run(ctx) {
      const name = (ctx.flags.name as string | undefined) ?? 'default';
      const phrase = await secret('Recovery phrase (12 or 24 words): ', 'recovery phrase');
      const entropy = recoveryPhraseToEntropy(phrase);
      try {
        const password = await newPassword();
        const key = await createKey({ name, entropy, password }, { home: ctx.home });
        if (ctx.json) return ctx.result({ name: key.name, address: key.address, file: key.file });
        ctx.out(`Key "${key.name}" stored: ${key.address}`);
        ctx.out(`File: ${key.file}`);
      } finally {
        entropy.fill(0);
      }
    },
  },
  'keys list': {
    names: 'keys list', flags: {}, positionals: [0, 0],
    async run(ctx) {
      const keys = await listKeys({ home: ctx.home });
      if (ctx.json) return ctx.result(keys.map(({ name, address }) => ({ name, address: address || null })));
      if (keys.length === 0) return ctx.out(`No keys in ${keystoreDir({ home: ctx.home })}`);
      for (const k of keys) ctx.out(`${k.name.padEnd(20)} ${k.address || '(unreadable file)'}`);
    },
  },
  'keys address': {
    names: 'keys address', flags: {}, positionals: [0, 1],
    async run(ctx, [name]) {
      const key = name ? await readKeyInfo(name, { home: ctx.home }) : await pickKey(ctx);
      if (ctx.json) return ctx.result({ name: key.name, address: key.address });
      ctx.out(key.address);
    },
  },
  'keys export-public': {
    names: 'keys export-public', flags: {}, positionals: [0, 1],
    async run(ctx, [name]) {
      const key = name ? await readKeyInfo(name, { home: ctx.home }) : await pickKey(ctx);
      if (ctx.json) return ctx.result({ name: key.name, address: key.address, publicKey: key.publicKey });
      ctx.out(`Address:     ${key.address}`);
      ctx.out(`Public key:  ${key.publicKey}`);
    },
  },
  balance: {
    names: 'balance', flags: { key: 'string', verified: 'boolean' }, positionals: [0, 1],
    async run(ctx, [given]) {
      const who = await ownOrGiven(ctx, given);
      if (!ctx.flags.verified) {
        const a = await ctx.client().getAccount(who);
        if (ctx.json) return ctx.result({ address: who, balanceNano: a.balanceNano, nonce: a.nonce, verified: false });
        ctx.out(`Address:  ${who}`);
        ctx.out(`Balance:  ${qnc(a.balanceNano)}`);
        ctx.out(`Nonce:    ${a.nonce}`);
        ctx.out("One node's answer; add --verified to check it against the chain.");
        return;
      }
      const store = anchorsStore(ctx);
      await store.prepare();
      let reached: WalkProgress | null = null;
      let shownAt = 0;
      const client = new NodeClient({
        network: 'testnet', nodes: ctx.client().nodes, timeoutMs: ctx.timeoutMs, anchors: store, walkTimeMs: CLI_WALK_TIME_MS,
        onWalkProgress: (p) => {
          reached = p;
          if (Date.now() - shownAt < 5_000) return;
          shownAt = Date.now();
          ctx.note(`qnet: checking the checkpoint chain: macroblock ${p.verified.toLocaleString('en-US')} of ${p.target.toLocaleString('en-US')} verified`);
        },
      });
      const v = await client.getVerifiedAccount(who);
      await store.flush();
      if (!v.verified) process.exitCode = 1;
      const walked = reached as WalkProgress | null;
      const n = (i: number) => i.toLocaleString('en-US');
      // Why a consistent, fresh proof was not verified: the walk reached its checkpoint, which then holds another state
      // root; or it stopped on the way (time, no node served the next proof, the checkpoint is not signed yet), and the
      // next run goes on from what it kept (DEVP-R1-02).
      const checkable = !v.verified && v.proofFolds && v.behindBlocks !== null && v.behindBlocks <= MAX_PROOF_AGE_BLOCKS;
      const refuted = checkable && walked !== null && walked.verified >= walked.target;
      // The next proof may be checked on either parity chain (even or odd macroblocks), and each is walked on its own
      // (DEVP-R2-01): say whether the other one has kept checkpoints to go on from.
      const otherKept = walked !== null && keptOnChain(store.load(), 1 - (walked.target % 2));
      const hint = !checkable || refuted ? null : walked
        ? `qnet: the checkpoint chain was checked up to macroblock ${n(walked.verified)} of ${n(walked.target)}; `
          + `the checkpoints verified are kept in ${store.file}. Run the command again: when the next proof is checked on the same `
          + `line of checkpoints (every other macroblock, like ${n(walked.target)}), the check goes on from them. `
          + (otherKept
            ? 'The other line has checkpoints kept as well, and goes on from its own.'
            : 'The other line has no checkpoint kept yet: a proof on it is checked from the release\'s own checkpoint, so a run may need to go again until one finishes.')
        : "qnet: no checkpoint could be checked this time (no node served the next proof, or the proof's checkpoint is not signed yet). Run the command again in a few minutes.";
      if (ctx.json) {
        if (hint) ctx.note(hint);
        return ctx.result(v);
      }
      ctx.out(`Address:  ${who}`);
      ctx.out(`Balance:  ${qnc(v.balanceNano)}`);
      ctx.out(`Nonce:    ${v.nonce}`);
      // The balance is the account's as of the proof's height; the lag below the tip says how old that is.
      const at = `height ${v.blockHeight}, ${v.behindBlocks} blocks below the chain's tip (${v.tipHeight})`;
      ctx.out(v.verified
        ? `Verified: the proof leads to a checkpoint the committee signed. Balance and nonce as of ${at}.`
        : !v.proofFolds
          ? 'Not verified: the node\'s proof does not match these values.'
          : v.behindBlocks === null
            ? `Not verified: no node reported the chain's tip, so the age of the proof (height ${v.blockHeight}) is unknown.`
            : v.behindBlocks > MAX_PROOF_AGE_BLOCKS
              ? `Not verified: the proof is of ${at}; it may show a balance since spent.`
              : refuted
                ? `Not verified: the checkpoint the committee signed at macroblock ${n(walked!.target)} holds another state root than this node's proof (${at}): do not trust this node's answer.`
                : `Not verified: the proof is consistent, but its checkpoint could not be checked now (${at}).`);
      if (hint) ctx.note(hint);
    },
  },
  'token info': {
    names: 'token info', flags: {}, positionals: [1, 1],
    async run(ctx, [contract]) {
      const t = await ctx.client().getTokenInfo(address(contract, 'The token'));
      if (ctx.json) return ctx.result(t);
      ctx.out(`Token:        ${shown(t.name)} (${shown(t.symbol)}), ${shown(t.standard)}`);
      ctx.out(`Contract:     ${t.contract}`);
      ctx.out(`Decimals:     ${t.decimals}`);
      ctx.out(`Supply:       ${formatUnits(t.totalSupply, t.decimals)} ${shown(t.symbol)}`);
      if (t.deployer) ctx.out(`Deployer:     ${shown(t.deployer)}`);
      ctx.out("One node's description; the chain offers no proof of token details.");
    },
  },
  'token balance': {
    names: 'token balance', flags: { key: 'string' }, positionals: [1, 2],
    async run(ctx, [contract, given]) {
      const token = address(contract, 'The token');
      const who = await ownOrGiven(ctx, given);
      const [t, units] = await Promise.all([ctx.client().getTokenInfo(token), ctx.client().getTokenBalance(token, who)]);
      if (ctx.json) return ctx.result({ contract: token, address: who, balance: units, decimals: t.decimals, symbol: t.symbol });
      ctx.out(`${formatUnits(units, t.decimals)} ${shown(t.symbol)}  (${units} base units, one node's answer)`);
    },
  },
  transfer: {
    names: 'transfer', flags: { ...SEND_FLAGS, to: 'string', amount: 'string' }, positionals: [0, 0],
    async run(ctx) {
      if (!ctx.flags.to || !ctx.flags.amount) throw new UsageError('transfer needs --to and --amount');
      const to = address(ctx.flags.to as string, '--to');
      checkBurn(ctx, to);
      const amountNano = parseUnits(ctx.flags.amount as string);
      await checkRecipient(ctx, to);
      const key = await pickKey(ctx);
      const { nonce, account } = await nonceFor(ctx, key);
      const tx = buildTransfer({ from: key.address, to, amountNano, nonce, gasPrice: gasPrice(ctx) });
      await execute(ctx, {
        key, account, tx, extraNano: amountNano,
        lines: [['To', to], ['Amount', qnc(amountNano)], ['Total at most', qnc(amountNano + BigInt(tx.maxFeeNano))]],
        question: `Send ${qnc(amountNano)} to ${to}?`,
      });
    },
  },
  'token transfer': {
    names: 'token transfer', flags: { ...SEND_FLAGS, to: 'string', amount: 'string' }, positionals: [1, 1],
    async run(ctx, [contract]) {
      if (!ctx.flags.to || !ctx.flags.amount) throw new UsageError('token transfer needs --to and --amount');
      const token = address(contract, 'The token');
      const to = address(ctx.flags.to as string, '--to');
      checkBurn(ctx, to);
      await checkRecipient(ctx, to);
      // The decimals scale the amount, so they come from two nodes that agree (the only node, when one is given).
      const t = await ctx.client().getAgreedTokenInfo(token);
      if (t.standard !== 'qrc20') throw new UsageError(`${token} is a ${shown(t.standard, 20)} token; token transfer moves qrc20 tokens`);
      const amount = parseUnits(ctx.flags.amount as string, t.decimals);
      const described = ctx.client().nodes.length > 1 ? 'as two nodes describe it alike' : 'as the one node given describes it';
      const key = await pickKey(ctx);
      const { nonce, account } = await nonceFor(ctx, key);
      const tx = buildTokenTransfer({ from: key.address, token, to, amount, nonce, gasPrice: gasPrice(ctx) });
      // A recipient without a balance entry takes a refundable deposit from the sender. A send to the burn address
      // creates no entry: the node destroys the tokens and credits nobody, so it takes no deposit (DEVP-R4-03).
      const burn = to === CANONICAL_BURN_ADDRESS;
      const deposit = ctx.flags['dry-run'] || burn ? 0n
        : (await ctx.client().getTokenBalance(token, to)) === '0' ? BigInt(TOKEN_ENTRY_DEPOSIT_NANO) : 0n;
      await execute(ctx, {
        key, account, tx, extraNano: deposit,
        lines: [
          ['Token', `${shown(t.name)} (${shown(t.symbol)}) ${token}, ${described}; no proof covers token details`],
          ['Decimals', String(t.decimals)],
          ['To', burn ? `${to} (the burn address: the tokens are destroyed)` : to],
          ['Amount', `${formatUnits(amount, t.decimals)} ${shown(t.symbol)} (${amount} base units)`],
          ...(deposit > 0n ? [['Deposit', `${qnc(deposit)}, refundable: the recipient holds none of this token yet`] as [string, string]] : []),
        ],
        question: `Send ${formatUnits(amount, t.decimals)} ${shown(t.symbol)} (${amount} base units at ${t.decimals} decimals) to ${to}?`,
      });
    },
  },
  call: {
    names: 'call', flags: { ...SEND_FLAGS, args: 'string', 'args-utf8': 'string', fuel: 'string', 'gas-limit': 'string' }, positionals: [2, 2],
    async run(ctx, [contract, method]) {
      const target = address(contract, 'The contract');
      if (ctx.flags.args !== undefined && ctx.flags['args-utf8'] !== undefined) throw new UsageError('give --args or --args-utf8, not both');
      if (ctx.flags.fuel !== undefined && ctx.flags['gas-limit'] !== undefined) throw new UsageError('give --fuel or --gas-limit, not both');
      const hexArgs = ctx.flags['args-utf8'] !== undefined
        ? Buffer.from(ctx.flags['args-utf8'] as string, 'utf8').toString('hex')
        : (ctx.flags.args as string | undefined) ?? null;
      if (hexArgs !== null && !/^(?:[0-9a-fA-F]{2})+$/.test(hexArgs)) throw new UsageError('--args is even-length hex');
      const fuel = integer(ctx.flags.fuel as string | undefined, '--fuel', 1) ?? null;
      const gasLimit = integer(ctx.flags['gas-limit'] as string | undefined, '--gas-limit', 1) ?? null;
      const key = await pickKey(ctx);
      let unchecked = '';
      if (!(ctx.flags['dry-run'] && ctx.flags.nonce)) {
        // The account answer carries the contract's whole storage; one too large to read is a contract whose type is
        // not known here (DEVP-R1-03): the call goes on, and the review says it was not checked.
        let c: AccountInfo | null = null;
        try {
          c = await ctx.client().getAccount(target);
        } catch (error) {
          if (!isAnswerTooLarge(error)) throw error;
          unchecked = ' (its type is not checked: its account is too large to read)';
          ctx.note(`qnet: the account of ${target} is too large to read here: going on without checking that it is a WebAssembly contract`);
        }
        if (c && !c.isContract) throw new UsageError(`no contract is at ${target}`);
        if (c && (c.contractType === 'qrc20' || c.contractType === 'qrc721')) {
          throw new UsageError(`${target} is a built-in ${c.contractType} token, not a WebAssembly contract: use "qnet token transfer"`);
        }
        if (c && c.contractType !== 'wasm') throw new UsageError(`${target} is not a WebAssembly contract`);
      }
      const { nonce, account } = await nonceFor(ctx, key);
      const tx = buildContractCall({ from: key.address, contract: target, method, args: hexArgs, nonce, gasPrice: gasPrice(ctx), gasLimit, fuel });
      const text = hexArgs ? printable(hexArgs) : null;
      await execute(ctx, {
        key, account, tx, extraNano: 0n,
        lines: [
          ['Contract', `${target}${unchecked}`],
          ['Method', method],
          ['Arguments', hexArgs ? `${hexArgs.length / 2} bytes: ${tx.args}${text ? ` ("${text}")` : ''}` : 'none'],
          ['Fuel', `${tx.fuel} for the contract's code; what it does not use is refunded`],
        ],
        question: `Call ${method} on ${target}?`,
      });
    },
  },
  deploy: {
    names: 'deploy', flags: { ...SEND_FLAGS }, positionals: [1, 1],
    async run(ctx, [file]) {
      const code = await readModule(file);
      const check = checkModule(code);
      if (!check.ok) {
        for (const p of check.problems) process.stderr.write(`qnet: ${shown(p, 400)}\n`);
        throw new QNetError('INVALID_WASM');
      }
      const key = await pickKey(ctx);
      const { nonce, account } = await nonceFor(ctx, key);
      const tx = buildContractDeploy({ from: key.address, code, nonce, gasPrice: gasPrice(ctx) });
      const review = ctx.flags['dry-run'] ? (ctx.json ? null : ctx.out) : reviewOut(ctx);
      if (review) printModule(review, check.report!);
      await execute(ctx, {
        key, account, tx, extraNano: 0n,
        lines: [['Contract', `${tx.contractAddress} (derived from the sender and the nonce)`]],
        question: `Deploy this module to ${tx.contractAddress}?`,
      });
    },
  },
  check: {
    names: 'check', flags: {}, positionals: [1, 1],
    async run(ctx, [file]) {
      const check = checkModule(await readModule(file));
      if (ctx.json) {
        ctx.result(check);
      } else if (check.ok) {
        printModule(ctx.out, check.report!);
        ctx.out('The module passes the local check of the deploy rules.');
      } else {
        for (const p of check.problems) ctx.out(shown(p, 400));
      }
      if (!check.ok) process.exitCode = 1;
    },
  },
  logs: {
    names: 'logs', flags: { from: 'string', to: 'string' }, positionals: [1, 1],
    async run(ctx, [contract]) {
      const target = address(contract, 'The contract');
      let from = integer(ctx.flags.from as string | undefined, '--from');
      let to = integer(ctx.flags.to as string | undefined, '--to');
      if (from === undefined || to === undefined) {
        const tip = await ctx.client().height();
        to ??= tip;
        from ??= Math.max(0, to - (LOG_WINDOW - 1));
      }
      if (to < from) throw new UsageError('--to is below --from');
      const MAX_WINDOWS = 20;
      if (Math.ceil((to - from + 1) / LOG_WINDOW) > MAX_WINDOWS) {
        throw new UsageError(`at most ${(MAX_WINDOWS * LOG_WINDOW).toLocaleString('en-US')} heights per command`);
      }
      const rows = [];
      let prunedBelow: number | null = null;
      for (let cur = from; cur <= to;) {
        const end = Math.min(to, cur + LOG_WINDOW - 1);
        const page = await ctx.client().getLogs({ contract: target, from: cur, to: end });
        prunedBelow ??= page.prunedBelow;
        rows.push(...page.logs);
        if (page.to < end) break; // the node's tip
        cur = page.to + 1;
      }
      if (ctx.json) return ctx.result({ contract: target, from, to, prunedBelow, logs: rows });
      if (prunedBelow !== null) ctx.out(`This node keeps events from height ${prunedBelow} only; earlier ones are missing here.`);
      if (rows.length === 0) return ctx.out(`No events of ${target} in heights ${from} to ${to}.`);
      for (const r of rows) {
        const text = printable(r.data);
        ctx.out(`${r.height}  ${shown(r.txHash, 80)}  ${r.data}${text ? `  "${text}"` : ''}`);
      }
    },
  },
  tx: {
    names: 'tx', flags: {}, positionals: [1, 1],
    async run(ctx, [hash]) {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new UsageError('a transaction hash is 64 lowercase hex characters');
      const t = await ctx.client().getTransaction(hash);
      if (ctx.json) return ctx.result(t);
      if (t.status === 'not_found') {
        ctx.out('Not found. A node names only its own copy of a transaction; look it up by its sender and nonce (qnet balance shows the nonce).');
        process.exitCode = 1;
        return;
      }
      const pending = t.status === 'pending';
      ctx.out(`Status:   ${pending ? 'waiting for a block' : `in block ${t.blockHeight ?? '(height not given)'}${t.finality ? ` (${shown(t.finality, 40)})` : ''}`}`);
      if (t.txType) ctx.out(`Type:     ${shown(t.txType, 60)}`);
      if (t.from) ctx.out(`From:     ${shown(t.from, 64)}`);
      if (t.to) ctx.out(`To:       ${shown(t.to, 64)}`);
      if (t.nonce) ctx.out(`Nonce:    ${t.nonce}`);
      if (t.source === 'archive') ctx.out('From the site archive: the nodes no longer index it.');
      ctx.out(pending
        ? 'No block holds it yet: it waits in a node\'s pool and has not applied.'
        : 'A block holds it; whether it applied shows in the sender\'s nonce and balance.');
    },
  },
};

// The command is named by the first one or two words that are neither an option nor an option's value.
function findCommand(argv: string[]): { name: string | undefined; rest: string[] } {
  const takesValue = new Set(Object.entries({ ...GLOBAL_FLAGS, ...Object.assign({}, ...Object.values(COMMANDS).map((c) => c.flags)) })
    .filter(([, kind]) => kind !== 'boolean').map(([flag]) => `--${flag}`));
  const words: number[] = [];
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    if (argv[i].startsWith('-')) {
      if (takesValue.has(argv[i])) i++;
      continue;
    }
    words.push(i);
  }
  const two = words.length === 2 ? `${argv[words[0]]} ${argv[words[1]]}` : '';
  const used = COMMANDS[two] ? words : words.slice(0, 1);
  const name = used.length ? used.map((i) => argv[i]).join(' ') : undefined;
  return { name, rest: argv.filter((_, i) => !used.includes(i)) };
}

async function main(argv: string[]): Promise<void> {
  const { name, rest } = findCommand(argv);
  const command = name ? COMMANDS[name] : undefined;
  const { flags, positionals } = parseArgs(rest, { ...GLOBAL_FLAGS, ...(command?.flags ?? {}) });
  if (flags.version) {
    process.stdout.write(`${__SDK_VERSION__}\n`);
    return;
  }
  if (flags.help || argv.length === 0 || name === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (!command) throw new UsageError(`unknown command: ${name ?? argv[0]}`);
  const [min, max] = command.positionals;
  if (positionals.length < min || positionals.length > max) throw new UsageError(`wrong number of arguments for "${command.names}"`);
  const network = (flags.network as string | undefined) ?? 'testnet';
  if (network !== 'testnet') throw new UsageError(`unknown network "${network}": QNet runs as a testnet (--network testnet)`);
  const timeout = integer(flags.timeout as string | undefined, '--timeout', 1);
  if (timeout !== undefined && timeout > 600) throw new UsageError('--timeout is at most 600 seconds');
  const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
  let client: NodeClient | null = null;
  const json = Boolean(flags.json);
  const ctx: Ctx = {
    flags,
    json,
    home: (flags.home as string | undefined) || process.env.QNET_HOME || path.join(homedir(), '.qnet'),
    timeoutMs,
    client() {
      try {
        client ??= new NodeClient({ network: 'testnet', nodes: flags.node as string[] | undefined, timeoutMs });
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      return client;
    },
    out: (text) => process.stdout.write(`${text}\n`),
    note: (text) => process.stderr.write(`${text}\n`),
    result: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  };
  await command.run(ctx, positionals);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`qnet: ${error.message}\nRun "qnet --help" for usage.\n`);
    process.exitCode = 2;
  } else if (error instanceof Declined) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof QNetError) {
    // A node's refusal carries the node's own text.
    const extra = error instanceof QNetNodeError && error.retryAfterSeconds ? ` (retry in ${error.retryAfterSeconds} s)` : '';
    process.stderr.write(`qnet: ${shown(error.message, 400)}${extra} [${error.code}]\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`qnet: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
