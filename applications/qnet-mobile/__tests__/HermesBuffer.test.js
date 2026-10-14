/**
 * Hermes builds no typed-array subarray through Symbol.species, so the app's Buffer (the `buffer` package) returns a
 * plain Uint8Array from subarray there, whose toString lists the bytes. The light client decoded every macroblock's
 * eligible producers that way, so on phones no committee key bound and no walk step ever verified (14.10). Node keeps
 * the Buffer, which is why every suite passed: these tests put the phone's behaviour back.
 */
const path = require('path');
const lc = require('../src/crypto/QcLightClient');
const { WS_CHECKPOINT } = require('../src/config/genesisConsensus');
const { installBufferSubarray } = require('../src/polyfills/buffer-subarray');

// The app's own Buffer implementation (Metro resolves `buffer` to this package; jest gives Node's).
const APP_BUFFER_PATH = path.join(__dirname, '../node_modules/buffer/index.js');

// Buffer#subarray as Hermes gives it: a plain Uint8Array over the same bytes. Returns the undo.
function hermesSubarray(B = Buffer) {
  const own = Object.getOwnPropertyDescriptor(B.prototype, 'subarray');
  B.prototype.subarray = function subarray(start, end) {
    return Uint8Array.prototype.subarray.call(new Uint8Array(this.buffer, this.byteOffset, this.length), start, end);
  };
  return () => {
    if (own) Object.defineProperty(B.prototype, 'subarray', own);
    else delete B.prototype.subarray;
  };
}

describe('the app\'s Buffer on Hermes', () => {
  let AppBuffer;
  let undo;
  beforeEach(() => {
    jest.isolateModules(() => { AppBuffer = require(APP_BUFFER_PATH).Buffer; });
    // Without Symbol.species the package's subarray is the engine's: a plain Uint8Array.
    Object.defineProperty(AppBuffer, Symbol.species, { get: () => Uint8Array, configurable: true });
    undo = () => { delete AppBuffer[Symbol.species]; delete AppBuffer.prototype.subarray; };
  });
  afterEach(() => undo());

  it('loses the Buffer on subarray: an id comes out as its bytes', () => {
    const b = AppBuffer.from('genesis_node_001');
    expect(b.subarray(0, 7) instanceof AppBuffer).toBe(false);
    expect(String(b.subarray(0, 7).toString('utf8'))).toBe('103,101,110,101,115,105,115');
    expect(b.toString('utf8', 0, 7)).toBe('genesis');
  });

  it('the app installs a subarray that keeps it, only where the engine needs one', () => {
    expect(installBufferSubarray(AppBuffer)).toBe(true);
    const b = AppBuffer.from('genesis_node_001');
    const part = b.subarray(8, 16);
    expect(part instanceof AppBuffer).toBe(true);
    expect(part.toString('utf8')).toBe('node_001');
    part[0] = 0x4e; // a view, not a copy, as before
    expect(b.toString('utf8')).toBe('genesis_Node_001');
    expect(installBufferSubarray(AppBuffer)).toBe(false); // a second call sees a Buffer and changes nothing
  });

  it('on V8 it changes nothing', () => {
    delete AppBuffer[Symbol.species];
    expect(installBufferSubarray(AppBuffer)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(AppBuffer.prototype, 'subarray')).toBe(false);
  });
});

describe('the light client on Hermes', () => {
  let undo;
  beforeEach(() => { undo = hermesSubarray(); });
  afterEach(() => undo());

  it('decodes the pin\'s eligible producers as their ids, not their bytes', () => {
    const k = WS_CHECKPOINT.index;
    for (const j of [k, k - 1]) {
      const ids = lc.decodeEligibleNodeIds(Buffer.from(WS_CHECKPOINT.anchors[j].eligible_raw, 'hex'));
      expect(ids.length).toBeGreaterThanOrEqual(5);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ids).toEqual(expect.arrayContaining(['genesis_node_001', 'genesis_node_002', 'genesis_node_003']));
    }
  });
});

module.exports = { hermesSubarray };
