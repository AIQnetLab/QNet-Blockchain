// The local module check against the contract templates (contracts/, when built) and against small modules made
// byte by byte, one per deploy rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sdk from '../dist/index.js';
import { customSection, T, template, wasmModule } from './helpers.mjs';

const deployGas = (n) => 500_000 + 10 * (2 * n + 102);

function refused(bytes, pattern) {
  const r = sdk.checkModule(bytes);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(r.problems)}`);
  return r;
}

describe('module check', () => {
  it('passes the smallest valid contract and reports it', () => {
    const bytes = wasmModule();
    const r = sdk.checkModule(bytes);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.report.entries, ['run']);
    assert.deepEqual(r.report.memoryPages, { initial: 1, maximum: 1 });
    assert.equal(r.report.deployGas, deployGas(bytes.length));
    assert.equal(r.report.codeHash, sdk.wasmCodeHash(bytes));
  });

  const templates = [
    ['counter.wasm', ['reset', 'run'], 548_660],
    ['game_items.wasm', ['balance', 'mint', 'transfer'], null],
    ['qnet_contract_abi_probe.wasm', null, null],
  ];
  for (const [file, entries, gas] of templates) {
    const found = template(file);
    it(`passes the ${file} template the contracts tool builds`, found ? {} : { skip: 'contracts/ not built' }, () => {
      const bytes = new Uint8Array(readFileSync(found));
      const r = sdk.checkModule(bytes);
      assert.deepEqual(r.problems, []);
      assert.equal(r.report.deployGas, deployGas(bytes.length));
      if (entries) assert.deepEqual([...r.report.entries].sort(), entries);
      if (gas) assert.equal(r.report.deployGas, gas);
      if (file.includes('abi_probe')) assert.equal(r.report.imports.length, 11);
    });
  }

  it('refuses a memory without a maximum or above 256 pages, a second memory and imported memory or tables', () => {
    refused(wasmModule({ memory: [1] }), /no maximum/);
    refused(wasmModule({ memory: [1, 257] }), /maximum is 257 pages/);
    refused(wasmModule({ memories: [[1, 1], [1, 1]] }), /second memory/);
    refused(wasmModule({ imports: [['env', 'memory', [0x02, 0x01, 1, 1]]] }), /imports a memory or a table/);
    refused(wasmModule({ imports: [['env', 'table', [0x01, 0x70, 0x00, 1]]] }), /imports a memory or a table/);
  });

  it('refuses floating point anywhere', () => {
    refused(wasmModule({ types: [[[T.f32], []]], exports: [['memory', 2, 0]] }), /floating point/);
    refused(wasmModule({ bodies: [[0x43, 0, 0, 0, 0, 0x1a]] }), /floating point/);
    refused(wasmModule({ locals: [[1, T.f64]] }), /floating point/);
    refused(wasmModule({ bodies: [[0x41, 0, 0x2a, 2, 0, 0x1a]] }), /floating point/); // f32.load
    refused(wasmModule({ bodies: [[0x41, 0, 0xb2, 0x1a]] }), /floating point/); // f32.convert_i32_s
  });

  it('refuses bulk memory, reference types, SIMD, threads, tail calls and exceptions', () => {
    refused(wasmModule({ bodies: [[0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 10, 0, 0]] }), /bulk memory/);
    refused(wasmModule({ sections: [[12, [0]]] }), /bulk memory/);
    refused(wasmModule({ bodies: [[0xd0, 0x70, 0x1a]] }), /reference types/);
    refused(wasmModule({ bodies: [[0x41, 0, 0x41, 0, 0x41, 0, 0x1c, 1, T.i32, 0x1a]] }), /reference types/);
    refused(wasmModule({ bodies: [[0xfd, 0x0f]] }), /SIMD/);
    refused(wasmModule({ bodies: [[0x41, 0, 0xfe, 0x10, 2, 0, 0x1a]] }), /threads/);
    refused(wasmModule({ bodies: [[0x12, 0]] }), /tail calls/);
    refused(wasmModule({ bodies: [[0x06, 0x40, 0x0b]] }), /exception/);
  });

  it('refuses a call_indirect table index in more than one byte, as the node validator does', () => {
    const tables = [[0x70, 0x00, 1]];
    assert.equal(sdk.checkModule(wasmModule({ tables, bodies: [[0x41, 0, 0x11, 0, 0x00]] })).ok, true);
    refused(wasmModule({ tables, bodies: [[0x41, 0, 0x11, 0, 0x80, 0x00]] }), /zero byte expected/);
  });

  it('refuses more than 8,192 functions', () => {
    const n = 8193;
    refused(wasmModule({ funcs: new Array(n).fill(0), bodies: new Array(n).fill([]) }), /8,193 functions/);
  });

  it('refuses a module larger than one deploy carries', () => {
    const r = refused(wasmModule({ sections: [customSection('pad', sdk.MAX_WASM_CODE_BYTES)] }), /over the deployable 24,949/);
    assert.equal(r.problems.length, 1);
    const fits = wasmModule();
    const room = sdk.MAX_WASM_CODE_BYTES - fits.length - 2 - 4 - 2; // id, size (3 bytes), name
    const exact = wasmModule({ sections: [customSection('pad', room)] });
    assert.equal(exact.length <= sdk.MAX_WASM_CODE_BYTES, true);
    assert.equal(sdk.checkModule(exact).ok, true);
  });

  it('checks host imports by module, name and exact type', () => {
    const types = [[[], []], [[T.i32], []], [[T.i32, T.i32], []]];
    const exportsShifted = [['memory', 2, 0], ['run', 0, 1]];
    refused(wasmModule({ imports: [['env', 'foo', [0x00, 0]]], exports: exportsShifted }), /env\.foo is not a host function/);
    refused(wasmModule({ types, imports: [['env', 'emit_log', [0x00, 1]]], exports: exportsShifted }),
      /env\.emit_log is imported as \(i32\) -> \(\); the host binds \(i32, i32\) -> \(\)/);
    refused(wasmModule({ types, imports: [['host', 'emit_log', [0x00, 2]]], exports: exportsShifted }), /module "env" only/);
    refused(wasmModule({ imports: [['env', 'storage_read', [0x03, T.i32, 0x00]]] }), /imported as a non-function/);
    const ok = sdk.checkModule(wasmModule({ types, imports: [['env', 'emit_log', [0x00, 2]]], exports: exportsShifted }));
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.report.imports, ['emit_log']);
  });

  it('needs an exported memory and entry points of type () -> ()', () => {
    refused(wasmModule({ exports: [['run', 0, 0]] }), /no memory exported/);
    refused(wasmModule({ exports: [['memory', 2, 0]] }), /no entry point/);
    refused(wasmModule({ types: [[[], []], [[T.i32], []]], funcs: [0, 1], exports: [['memory', 2, 0], ['run', 0, 0], ['bad', 0, 1]] }),
      /export "bad" is \(i32\) -> \(\)/);
  });

  it('refuses what the node validator finds malformed', () => {
    refused(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0, 0, 0]), /not a WebAssembly 1\.0 module/);
    refused(wasmModule().subarray(0, 20), /malformed module/);
    refused(wasmModule({ globals: [[T.i32, 0x00, 0x41, 0x00, 0x0b]], bodies: [[0x41, 1, 0x24, 0]] }), /global is immutable/);
    refused(wasmModule({ bodies: [[0x41, 0, 0x28, 3, 0, 0x1a]] }), /alignment/);
    refused(wasmModule({ bodies: [[0x0c, 5]] }), /unknown label/);
    refused(wasmModule({ bodies: [[0x10, 9]] }), /unknown function/);
    refused(wasmModule({ memory: null, exports: [['run', 0, 0]], bodies: [[0x3f, 0x00, 0x1a]] }), /unknown memory/);
  });
});
