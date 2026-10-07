// A local check of a WebAssembly module against what a QNet deploy accepts and what every call needs, before
// anything is signed. It mirrors the node's deploy validator (core/qnet-vm validate_wasm_module: the size, no
// floating point, bulk memory, reference types, SIMD, threads, tail calls or exceptions, one memory with a maximum
// of at most 256 pages, no imported memory or table, at most 8,192 functions) and the contracts tool
// (contracts/tool/src/lib.rs check_module: host imports of module `env` with their exact types, an exported
// `memory`, entry points of type () -> ()). It decodes every section and instruction but does not type-check the
// operand stack: the node's own validator stays the authority.
import { contractDeployData, contractDeployIntrinsicGas, MAX_GAS_LIMIT, MAX_WASM_CODE_BYTES, wasmCodeHash } from './tx.js';

type ValType = 'i32' | 'i64';

/** The host functions of module `env` and their types, as the node binds them (contracts/tool HOST_FUNCTIONS). */
export const HOST_FUNCTIONS: Readonly<Record<string, { params: readonly ValType[]; results: readonly ValType[] }>> = Object.freeze({
  storage_read: { params: ['i32', 'i32', 'i32', 'i32'], results: ['i32'] },
  storage_write: { params: ['i32', 'i32', 'i32', 'i32'], results: [] },
  get_caller: { params: ['i32', 'i32'], results: ['i32'] },
  get_contract: { params: ['i32', 'i32'], results: ['i32'] },
  get_call_args: { params: ['i32', 'i32'], results: ['i32'] },
  set_return: { params: ['i32', 'i32'], results: [] },
  get_block_height: { params: [], results: ['i64'] },
  get_value: { params: [], results: ['i64'] },
  emit_log: { params: ['i32', 'i32'], results: [] },
  revert: { params: ['i32', 'i32'], results: [] },
  call_contract: { params: ['i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i64', 'i32', 'i32'], results: ['i32'] },
});

// core/qnet-vm VmLimits::default().
export const VM_MAX_CODE_BYTES = 512 * 1024;
export const VM_MAX_MEMORY_PAGES = 256;
export const VM_MAX_FUNCTIONS = 8192;
const MAX_LOCALS = 50_000;

export interface ModuleReport {
  bytes: number;
  codeHash: string;
  deployGas: number;
  entries: string[];
  imports: string[];
  memoryPages: { initial: number; maximum: number };
}

export interface ModuleCheck {
  ok: boolean;
  problems: string[];
  report: ModuleReport | null;
}

class Stop extends Error {}

interface FuncType {
  params: ValType[];
  results: ValType[];
}

const group = (n: number): string => n.toLocaleString('en-US');
const sig = (t: { params: readonly ValType[]; results: readonly ValType[] }): string => `(${t.params.join(', ')}) -> (${t.results.join(', ')})`;
const sameSig = (a: FuncType, b: { params: readonly ValType[]; results: readonly ValType[] }): boolean =>
  a.params.join() === b.params.join() && a.results.join() === b.results.join();

// Why a feature byte is refused, in the words of the deploy rules.
const FEATURE = {
  float: 'uses floating point, which the network refuses at deploy',
  bulk: 'uses bulk memory instructions, which the network refuses at deploy (build with bulk memory turned off)',
  ref: 'uses reference types, which the network refuses at deploy',
  simd: 'uses SIMD instructions, which the network refuses at deploy',
  threads: 'uses threads or atomics, which the network refuses at deploy',
  tail: 'uses tail calls, which the network refuses at deploy',
  exceptions: 'uses exception handling, which the network refuses at deploy',
  gc: 'uses typed function references or garbage collection, which the network refuses at deploy',
  multiMemory: 'addresses a second memory, which the network refuses at deploy',
};

class Reader {
  pos: number;

  constructor(readonly bytes: Uint8Array, start: number, readonly end: number, private readonly failAt: (why: string) => never) {
    this.pos = start;
  }

  fail(why: string): never {
    return this.failAt(why);
  }

  atEnd(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    if (this.pos >= this.end) this.fail('unexpected end');
    return this.bytes[this.pos++];
  }

  peek(): number {
    if (this.pos >= this.end) this.fail('unexpected end');
    return this.bytes[this.pos];
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 4 && (b & 0xf0) !== 0) this.fail('integer too large');
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    return this.fail('integer representation too long');
  }

  // Signed LEB128 of at most `bits` bits; only its well-formedness matters here.
  signed(bits: number): bigint {
    let result = 0n;
    let shift = 0n;
    const maxBytes = Math.ceil(bits / 7);
    for (let i = 0; i < maxBytes; i++) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (i === maxBytes - 1) {
          const unused = bits - 7 * (maxBytes - 1);
          const rest = b >> (unused - 1);
          if (rest !== 0 && rest !== (0x7f >> (unused - 1))) this.fail('integer too large');
        }
        if (b & 0x40) result -= 1n << shift;
        return result;
      }
    }
    return this.fail('integer representation too long');
  }

  take(n: number): Uint8Array {
    if (n > this.end - this.pos) this.fail('unexpected end');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  name(): string {
    const raw = this.take(this.u32());
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return this.fail('malformed UTF-8 name');
    }
  }
}

/** Checks `bytes` as a QNet deploy judges it plus what calls need. `ok` only when `problems` is empty. */
export function checkModule(bytes: Uint8Array): ModuleCheck {
  const problems: string[] = [];
  if (!(bytes instanceof Uint8Array)) return { ok: false, problems: ['not a byte array'], report: null };
  const refuse = (why: string): never => {
    problems.push(why);
    throw new Stop();
  };
  const malformed = (offset: () => number) => (why: string): never => refuse(`malformed module at byte ${offset()}: ${why}`);

  if (bytes.length > VM_MAX_CODE_BYTES) {
    problems.push(`${group(bytes.length)} bytes is over the network's ${group(VM_MAX_CODE_BYTES)}-byte module limit`);
  }
  if (bytes.length > MAX_WASM_CODE_BYTES) {
    const gas = 500_000 + 10 * (2 * bytes.length + 102);
    problems.push(`${group(bytes.length)} bytes is over the deployable ${group(MAX_WASM_CODE_BYTES)} (deploy gas ${group(gas)} > ${group(MAX_GAS_LIMIT)})`);
  }

  const types: FuncType[] = [];
  const funcTypes: number[] = []; // type index of every function, imports first
  const imports: Array<{ module: string; name: string; kind: number; type?: number }> = [];
  const globals: Array<{ type: ValType; mutable: boolean; imported: boolean }> = [];
  const exports: Array<{ name: string; kind: number; index: number }> = [];
  let importedFuncs = 0;
  let definedFuncs: number | null = null;
  let tables = 0;
  let memory: { initial: number; maximum: number | null } | null = null;
  let codeCount: number | null = null;

  try {
    const r: Reader = new Reader(bytes, 0, bytes.length, malformed(() => r.pos));
    const header = r.take(8);
    if (![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].every((b, i) => header[i] === b)) r.fail('not a WebAssembly 1.0 module');

    const valType = (s: Reader): ValType => {
      const b = s.u8();
      if (b === 0x7f) return 'i32';
      if (b === 0x7e) return 'i64';
      if (b === 0x7d || b === 0x7c) return refuse(FEATURE.float);
      if (b === 0x7b) return refuse(FEATURE.simd);
      if (b === 0x70 || b === 0x6f) return refuse(FEATURE.ref);
      if (b >= 0x63 && b <= 0x74) return refuse(FEATURE.gc);
      return s.fail(`unknown value type 0x${b.toString(16)}`);
    };
    const limits = (s: Reader, what: 'memory' | 'table'): { initial: number; maximum: number | null } => {
      const flags = s.u8();
      if (flags === 0x02 || flags === 0x03) return refuse(FEATURE.threads);
      if (flags > 0x01) return s.fail(`${what} limits flags 0x${flags.toString(16)} are not allowed`);
      const initial = s.u32();
      const maximum = flags === 0x01 ? s.u32() : null;
      if (maximum !== null && maximum < initial) s.fail(`${what} maximum is below its initial size`);
      return { initial, maximum };
    };
    // A constant expression of type `want`: one i32.const / i64.const / global.get of an imported constant global.
    const constExpr = (s: Reader, want: ValType): void => {
      const op = s.u8();
      let got: ValType;
      if (op === 0x41) {
        s.signed(32);
        got = 'i32';
      } else if (op === 0x42) {
        s.signed(64);
        got = 'i64';
      } else if (op === 0x23) {
        const g = globals[s.u32()];
        if (!g || !g.imported || g.mutable) s.fail('a constant expression may read only an imported constant global');
        got = g!.type;
      } else if (op === 0x43 || op === 0x44) {
        return refuse(FEATURE.float);
      } else if (op === 0xd0 || op === 0xd2) {
        return refuse(FEATURE.ref);
      } else {
        return s.fail('constant expression required');
      }
      if (got !== want) s.fail('type mismatch in constant expression');
      if (s.u8() !== 0x0b) s.fail('constant expression required');
    };

    const ORDER = [0, 1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];
    let lastRank = 0;
    while (!r.atEnd()) {
      const id = r.u8();
      const size = r.u32();
      const start = r.pos;
      if (size > r.end - start) r.fail('section size mismatch');
      const s: Reader = new Reader(bytes, start, start + size, malformed(() => s.pos));
      const rank = ORDER.indexOf(id);
      if (rank < 0) r.fail(`unknown section id ${id}`);
      if (id !== 0) {
        if (rank <= lastRank) r.fail('section out of order or repeated');
        lastRank = rank;
      }
      switch (id) {
        case 0:
          s.name();
          s.pos = s.end;
          break;
        case 1: {
          for (let n = s.u32(); n > 0; n--) {
            const form = s.u8();
            if (form === 0x4e || form === 0x50 || form === 0x4f || form === 0x5e || form === 0x5f) refuse(FEATURE.gc);
            if (form !== 0x60) s.fail('function type expected');
            const params: ValType[] = [];
            for (let k = s.u32(); k > 0; k--) params.push(valType(s));
            const results: ValType[] = [];
            for (let k = s.u32(); k > 0; k--) results.push(valType(s));
            types.push({ params, results });
          }
          break;
        }
        case 2: {
          for (let n = s.u32(); n > 0; n--) {
            const module = s.name();
            const name = s.name();
            const kind = s.u8();
            if (kind === 0x00) {
              const t = s.u32();
              if (t >= types.length) s.fail('unknown type');
              funcTypes.push(t);
              importedFuncs++;
              imports.push({ module, name, kind, type: t });
            } else if (kind === 0x01 || kind === 0x02) {
              refuse('imports a memory or a table, which the network refuses at deploy');
            } else if (kind === 0x03) {
              const type = valType(s);
              const m = s.u8();
              if (m > 1) s.fail('malformed mutability');
              globals.push({ type, mutable: m === 1, imported: true });
              imports.push({ module, name, kind });
            } else if (kind === 0x04) {
              refuse(FEATURE.exceptions);
            } else {
              s.fail('unknown import kind');
            }
          }
          break;
        }
        case 3: {
          const n = s.u32();
          if (n > VM_MAX_FUNCTIONS) refuse(`${group(n)} functions; the network allows at most ${group(VM_MAX_FUNCTIONS)}`);
          definedFuncs = n;
          for (let k = 0; k < n; k++) {
            const t = s.u32();
            if (t >= types.length) s.fail('unknown type');
            funcTypes.push(t);
          }
          break;
        }
        case 4: {
          for (let n = s.u32(); n > 0; n--) {
            const ref = s.u8();
            if (ref === 0x6f) refuse(FEATURE.ref);
            if (ref !== 0x70) s.fail('funcref table expected');
            limits(s, 'table');
            tables++;
          }
          if (tables > 1) refuse(`declares ${tables} tables; ${FEATURE.ref}`);
          break;
        }
        case 5: {
          const n = s.u32();
          if (n > 1) refuse(FEATURE.multiMemory);
          if (n === 1) {
            const m = limits(s, 'memory');
            if (m.initial > 65536) s.fail('memory size must be at most 65536 pages');
            if (m.maximum === null) {
              problems.push(`memory has no maximum; declare one of at most ${VM_MAX_MEMORY_PAGES} pages (16 MiB)`);
            } else if (m.maximum > VM_MAX_MEMORY_PAGES) {
              problems.push(`memory maximum is ${m.maximum} pages; the network allows at most ${VM_MAX_MEMORY_PAGES}`);
            }
            memory = m;
          }
          break;
        }
        case 6: {
          for (let n = s.u32(); n > 0; n--) {
            const type = valType(s);
            const m = s.u8();
            if (m > 1) s.fail('malformed mutability');
            constExpr(s, type);
            globals.push({ type, mutable: m === 1, imported: false });
          }
          break;
        }
        case 7: {
          const seen = new Set<string>();
          for (let n = s.u32(); n > 0; n--) {
            const name = s.name();
            if (seen.has(name)) s.fail(`duplicate export "${name}"`);
            seen.add(name);
            const kind = s.u8();
            const index = s.u32();
            const bound = [funcTypes.length, tables, memory ? 1 : 0, globals.length][kind];
            if (kind === 0x04) refuse(FEATURE.exceptions);
            if (bound === undefined) s.fail('unknown export kind');
            if (index >= bound!) s.fail(`export "${name}" names an unknown item`);
            exports.push({ name, kind, index });
          }
          break;
        }
        case 8: {
          const f = s.u32();
          if (f >= funcTypes.length) s.fail('unknown start function');
          const t = types[funcTypes[f]];
          if (t.params.length || t.results.length) s.fail('the start function must be () -> ()');
          break;
        }
        case 9: {
          for (let n = s.u32(); n > 0; n--) {
            const flags = s.u32();
            if (flags !== 0) refuse(flags === 1 || flags === 3 ? FEATURE.bulk : FEATURE.ref);
            if (tables === 0) s.fail('element segment without a table');
            constExpr(s, 'i32');
            for (let k = s.u32(); k > 0; k--) if (s.u32() >= funcTypes.length) s.fail('unknown function in element segment');
          }
          break;
        }
        case 10: {
          const n = s.u32();
          codeCount = n;
          if (n !== (definedFuncs ?? 0)) s.fail('function and code section have inconsistent lengths');
          for (let k = 0; k < n; k++) {
            const bodySize = s.u32();
            const bodyStart = s.pos;
            if (bodySize > s.end - bodyStart) s.fail('function body size mismatch');
            const body: Reader = new Reader(bytes, bodyStart, bodyStart + bodySize, malformed(() => body.pos));
            checkBody(body, types[funcTypes[importedFuncs + k]], {
              types, funcCount: funcTypes.length, globals, tables, hasMemory: memory !== null, refuse,
            });
            s.pos = bodyStart + bodySize;
          }
          break;
        }
        case 11: {
          for (let n = s.u32(); n > 0; n--) {
            const flags = s.u32();
            if (flags === 1) refuse(FEATURE.bulk);
            if (flags === 2) refuse(FEATURE.multiMemory);
            if (flags !== 0) s.fail('malformed data segment');
            if (!memory) s.fail('data segment without a memory');
            constExpr(s, 'i32');
            s.take(s.u32());
          }
          break;
        }
        case 12:
          refuse(FEATURE.bulk);
          break;
        case 13:
          refuse(FEATURE.exceptions);
          break;
        default:
          break;
      }
      if (s.pos !== s.end) s.fail('section size mismatch');
      r.pos = start + size;
    }
    if ((definedFuncs ?? 0) !== (codeCount ?? 0)) r.fail('function and code section have inconsistent lengths');
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { ok: false, problems, report: null };
  }

  // What the deploy does not check but every call needs.
  const hostImports: string[] = [];
  for (const imp of imports) {
    const host = HOST_FUNCTIONS[imp.name];
    if (imp.module !== 'env') {
      problems.push(`${imp.module}.${imp.name}: host functions come from module "env" only`);
    } else if (!Object.prototype.hasOwnProperty.call(HOST_FUNCTIONS, imp.name)) {
      problems.push(`env.${imp.name} is not a host function`);
    } else if (imp.kind !== 0x00) {
      problems.push(`env.${imp.name} is imported as a non-function`);
    } else if (!sameSig(types[imp.type!], host)) {
      problems.push(`env.${imp.name} is imported as ${sig(types[imp.type!])}; the host binds ${sig(host)}`);
    } else {
      hostImports.push(imp.name);
    }
  }
  if (!exports.some((e) => e.name === 'memory' && e.kind === 0x02)) {
    problems.push('no memory exported as "memory"; every host call needs it');
  }
  const entries: string[] = [];
  for (const e of exports) {
    if (e.kind !== 0x00) continue;
    const t = types[funcTypes[e.index]];
    if (t.params.length === 0 && t.results.length === 0) entries.push(e.name);
    else problems.push(`export "${e.name}" is ${sig(t)}; an entry point must be () -> ()`);
  }
  if (entries.length === 0) problems.push('no entry point exported');

  const mem = memory as { initial: number; maximum: number | null } | null;
  const report: ModuleReport = {
    bytes: bytes.length,
    codeHash: wasmCodeHash(bytes),
    deployGas: contractDeployIntrinsicGas(contractDeployData(bytes)),
    entries,
    imports: hostImports,
    memoryPages: { initial: mem?.initial ?? 0, maximum: mem?.maximum ?? 0 },
  };
  return { ok: problems.length === 0, problems, report };
}

interface BodyContext {
  types: FuncType[];
  funcCount: number;
  globals: Array<{ type: ValType; mutable: boolean }>;
  tables: number;
  hasMemory: boolean;
  refuse(why: string): never;
}

// Natural alignment (log2 bytes) of the integer loads 0x28-0x35 and stores 0x36-0x3e; null for the float ones.
const LOAD_STORE_ALIGN: Record<number, number | null> = {
  0x28: 2, 0x29: 3, 0x2a: null, 0x2b: null, 0x2c: 0, 0x2d: 0, 0x2e: 1, 0x2f: 1, 0x30: 0, 0x31: 0, 0x32: 1, 0x33: 1,
  0x34: 2, 0x35: 2, 0x36: 2, 0x37: 3, 0x38: null, 0x39: null, 0x3a: 0, 0x3b: 1, 0x3c: 0, 0x3d: 1, 0x3e: 2,
};

function checkBody(r: Reader, type: FuncType, cx: BodyContext): void {
  let locals = type.params.length;
  let declared = 0;
  for (let n = r.u32(); n > 0; n--) {
    const count = r.u32();
    declared += count;
    if (declared > MAX_LOCALS) r.fail('too many locals');
    const b = r.u8();
    if (b === 0x7d || b === 0x7c) cx.refuse(FEATURE.float);
    if (b === 0x7b) cx.refuse(FEATURE.simd);
    if (b === 0x70 || b === 0x6f) cx.refuse(FEATURE.ref);
    if (b !== 0x7f && b !== 0x7e) r.fail('unknown local type');
    locals += count;
  }
  const control: Array<'func' | 'block' | 'loop' | 'if' | 'else'> = ['func'];
  const blockType = () => {
    const b = r.peek();
    if (b === 0x40 || b === 0x7f || b === 0x7e) {
      r.u8();
      return;
    }
    if (b === 0x7d || b === 0x7c) cx.refuse(FEATURE.float);
    if (b === 0x7b) cx.refuse(FEATURE.simd);
    if (b === 0x70 || b === 0x6f) cx.refuse(FEATURE.ref);
    const index = r.signed(33);
    if (index < 0n) r.fail('unknown block type');
    if (index >= BigInt(cx.types.length)) r.fail('unknown type');
  };
  const label = () => {
    if (r.u32() >= control.length) r.fail('unknown label');
  };
  const needMemory = () => {
    if (!cx.hasMemory) r.fail('unknown memory 0');
  };
  const zeroByte = () => {
    if (r.u8() !== 0x00) r.fail('zero byte expected');
  };

  while (control.length > 0) {
    const op = r.u8();
    if (op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xa7 || op === 0xac || op === 0xad) continue;
    if ((op >= 0x45 && op <= 0x5a) || (op >= 0x67 && op <= 0x8a) || (op >= 0xc0 && op <= 0xc4)) continue;
    if (op === 0x43 || op === 0x44 || (op >= 0x5b && op <= 0x66) || (op >= 0x8b && op <= 0xa6)
      || (op >= 0xa8 && op <= 0xbf && op !== 0xac && op !== 0xad)) {
      cx.refuse(FEATURE.float);
    }
    switch (op) {
      case 0x02:
        blockType();
        control.push('block');
        break;
      case 0x03:
        blockType();
        control.push('loop');
        break;
      case 0x04:
        blockType();
        control.push('if');
        break;
      case 0x05:
        if (control[control.length - 1] !== 'if') r.fail('else found outside of an if block');
        control[control.length - 1] = 'else';
        break;
      case 0x0b:
        control.pop();
        break;
      case 0x0c:
      case 0x0d:
        label();
        break;
      case 0x0e:
        for (let n = r.u32(); n > 0; n--) label();
        label();
        break;
      case 0x10:
        if (r.u32() >= cx.funcCount) r.fail('unknown function');
        break;
      case 0x11:
        if (r.u32() >= cx.types.length) r.fail('unknown type');
        zeroByte();
        if (cx.tables === 0) r.fail('unknown table 0');
        break;
      case 0x20:
      case 0x21:
      case 0x22:
        if (r.u32() >= locals) r.fail('unknown local');
        break;
      case 0x23:
        if (r.u32() >= cx.globals.length) r.fail('unknown global');
        break;
      case 0x24: {
        const g = cx.globals[r.u32()];
        if (!g) r.fail('unknown global');
        if (!g!.mutable) r.fail('global is immutable');
        break;
      }
      case 0x3f:
      case 0x40:
        zeroByte();
        needMemory();
        break;
      case 0x41:
        r.signed(32);
        break;
      case 0x42:
        r.signed(64);
        break;
      case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a: case 0x18: case 0x19: case 0x1f:
        cx.refuse(FEATURE.exceptions);
        break;
      case 0x12:
      case 0x13:
        cx.refuse(FEATURE.tail);
        break;
      case 0x14: case 0x15: case 0xd3: case 0xd4: case 0xd5: case 0xd6: case 0xfb:
        cx.refuse(FEATURE.gc);
        break;
      case 0x1c: case 0x25: case 0x26: case 0xd0: case 0xd1: case 0xd2:
        cx.refuse(FEATURE.ref);
        break;
      case 0xfc: {
        const sub = r.u32();
        if (sub <= 7) cx.refuse(FEATURE.float);
        if (sub <= 14) cx.refuse(FEATURE.bulk);
        if (sub <= 17) cx.refuse(FEATURE.ref);
        r.fail(`unknown 0xfc instruction ${sub}`);
        break;
      }
      case 0xfd:
        cx.refuse(FEATURE.simd);
        break;
      case 0xfe:
        cx.refuse(FEATURE.threads);
        break;
      default: {
        const natural = LOAD_STORE_ALIGN[op];
        if (natural === undefined) r.fail(`unknown instruction 0x${op.toString(16)}`);
        if (natural === null) cx.refuse(FEATURE.float);
        const align = r.u32();
        if (align & 0x40) cx.refuse(FEATURE.multiMemory);
        if (align > natural!) r.fail('alignment must not be larger than natural');
        r.u32();
        needMemory();
      }
    }
  }
  if (!r.atEnd()) r.fail('operators remaining after end of function');
}
