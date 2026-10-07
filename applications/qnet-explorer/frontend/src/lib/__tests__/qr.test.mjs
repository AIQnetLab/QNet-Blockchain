// The vendored QR encoder (src/lib/qr.ts) against the extension encoder's reference fixture, generated
// with qrcode@1.5.4 (applications/qnet-wallet/test/fixtures/ui-qr-reference.json), and on QNet links.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QR_MAX_VERSION, formatBits, qrMatrix, qrPath, qrVersionFor, rsRemainder } from '../qr.ts';
import { VECTORS } from './link-helpers.mjs';

const REFERENCE = JSON.parse(
  readFileSync(new URL('../../../../../qnet-wallet/test/fixtures/ui-qr-reference.json', import.meta.url), 'utf8'),
);

const rows = ({ size, modules }) => Array.from({ length: size }, (_, y) => Array.from(modules.subarray(y * size, (y + 1) * size)).join(''));

test('matches the reference encoder module for module, for every mask and version in the fixture', () => {
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

test('uses the ISO 18004 Reed-Solomon code and level-M format bits', () => {
  assert.deepEqual(rsRemainder([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], 10),
    [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatBits(mask).toString(2).padStart(15, '0')), [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000',
  ]);
});

test('a QNet link fits: 112 and 119 characters give version 7 (45 modules, up to 122 bytes at level M)', () => {
  for (const c of VECTORS.cases) {
    const m = qrMatrix(c.link);
    assert.equal(c.link.length, c.intent === 'activate' ? 119 : 112);
    assert.equal(m.version, 7);
    assert.equal(m.size, 45);
  }
  assert.deepEqual([1, 14, 15, 62, 63, 213].map(qrVersionFor), [1, 1, 2, 4, 5, 10]);
  assert.throws(() => qrMatrix('z'.repeat(214)), RangeError);
});

test('the SVG path holds only numbers and path commands, one square per dark module', () => {
  const m = qrMatrix(VECTORS.cases[0].link);
  const d = qrPath(m, 4);
  assert.match(d, /^(M\d+ \d+h1v1h-1z)+$/);
  const dark = m.modules.reduce((sum, v) => sum + v, 0);
  assert.equal(d.split('M').length - 1, dark);
  assert.ok(d.startsWith('M4 4h1v1h-1z'), 'the finder pattern corner, offset by the quiet zone');
});
