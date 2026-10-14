// Hermes does not build a typed array's subarray through Symbol.species, so Buffer#subarray returns a plain Uint8Array
// there: toString with an encoding, readUInt32LE, equals and the other Buffer methods are lost on the result (its
// toString lists the bytes). Buffer#slice already restores the prototype; subarray gets the same, only on an engine
// that needs it (V8 keeps the Buffer, and nothing changes there).
import { Buffer } from 'buffer';

/** Makes `B#subarray` return a `B` where the engine does not; true when it had to. */
export function installBufferSubarray(B = Buffer) {
  if (B.alloc(1).subarray(0, 1) instanceof B) return false;
  const native = Uint8Array.prototype.subarray;
  B.prototype.subarray = function subarray(start, end) {
    const out = native.call(this, start, end);
    Object.setPrototypeOf(out, B.prototype);
    return out;
  };
  return true;
}

installBufferSubarray();
