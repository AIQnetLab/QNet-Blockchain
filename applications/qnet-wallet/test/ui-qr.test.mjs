// The receive-screen QR encoder (dist/ui/qr.js) against an independent implementation and the
// ISO/IEC 18004 reference values. test/fixtures/ui-qr-reference.json was generated once with
// qrcode@1.5.4 (byte mode, level M, every mask) for the texts it lists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../dist/lib/qnet-core.js';
import { QR_MAX_VERSION, formatBits, qrMatrix, qrVersionFor, rsRemainder } from '../dist/ui/qr.js';

const REFERENCE = JSON.parse(await readFile(new URL('./fixtures/ui-qr-reference.json', import.meta.url), 'utf8'));

const rows = ({ size, modules }) => Array.from({ length: size }, (_, y) => Array.from(modules.subarray(y * size, (y + 1) * size)).join(''));

describe('ui qr', () => {
  it('matches the reference encoder module for module, for every mask and version in the fixture', () => {
    assert.ok(REFERENCE.cases.length >= 6);
    assert.ok(REFERENCE.cases.some((entry) => entry.version >= 7), 'covers the version-information area');
    assert.ok(REFERENCE.cases.some((entry) => entry.version === QR_MAX_VERSION), 'covers the 16-bit length field');
    for (const entry of REFERENCE.cases) {
      for (let mask = 0; mask < 8; mask += 1) {
        const matrix = qrMatrix(entry.text, { mask });
        assert.equal(matrix.version, entry.version, `${entry.text.length} bytes`);
        assert.deepEqual(rows(matrix), entry.masks[mask], `${entry.text.length} bytes, mask ${mask}`);
      }
      assert.equal(qrMatrix(entry.text).mask, entry.autoMask, `${entry.text.length} bytes: lowest-penalty mask`);
    }
  });

  it('encodes both wallet addresses of the KAT phrase', () => {
    for (const address of [core.KAT.qnetAddress, core.KAT.solanaAddress]) {
      const { version, size, modules } = qrMatrix(address);
      assert.equal(version, 4);
      assert.equal(size, 33);
      assert.equal(modules.length, 33 * 33);
      assert.ok(modules.every((value) => value === 0 || value === 1));
    }
  });

  it('uses the ISO 18004 Reed-Solomon code and level-M format bits', () => {
    // Annex I example: "01234567", version 1-M.
    assert.deepEqual(rsRemainder([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], 10),
      [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatBits(mask).toString(2).padStart(15, '0')), [
      '101010000010010', '101000100100101', '101111001111100', '101101101001011',
      '100010111111001', '100000011001110', '100111110010111', '100101010100000',
    ]);
  });

  it('picks the smallest version and refuses what version 10 cannot hold', () => {
    assert.deepEqual([1, 14, 15, 62, 63, 213].map(qrVersionFor), [1, 1, 2, 4, 5, 10]);
    assert.equal(qrVersionFor(214), 0);
    assert.throws(() => qrMatrix('z'.repeat(214)), RangeError);
    assert.throws(() => qrMatrix('q', { mask: 8 }), RangeError);
    assert.equal(qrMatrix('é').version, 1, 'UTF-8 bytes are counted');
  });
});
