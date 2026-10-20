/**
 * Addresses are shown in one module (utils/addressDisplay): whole in groups of four where a send is approved, in their
 * own structure where an address is a screen's subject, by their first and last six characters as a reference in a row.
 * The copied value is always the raw one; no other module writes its own short form.
 */
import fs from 'fs';
import path from 'path';
import { addressParts, groupAddress, shortAddress } from '../src/utils/addressDisplay';

const QNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

it('a QNet Blockchain address in its structure: 19 hex, eon, 15 hex, the 8-hex check, joining back to itself', () => {
  const parts = addressParts(QNET);
  expect(parts).toEqual(['d9fa370374e24333242', 'eon', '847d1d354dcd87f', 'e873823e']);
  expect(parts.join('')).toBe(QNET);
  expect(parts.map((p) => p.length)).toEqual([19, 3, 15, 8]);
  for (const other of [SOL, '', null, `${QNET}0`, QNET.toUpperCase(), QNET.replace('eon', 'eom')]) expect(addressParts(other)).toBeNull();
});

it('a reference in a row: the first and last six characters; a short text whole', () => {
  expect(shortAddress(QNET)).toBe('d9fa37…73823e');
  expect(shortAddress(SOL)).toBe('HAgk14…3DKpqk');
  expect(shortAddress('So1Recipient')).toBe('So1Recipient');
  expect(shortAddress(undefined)).toBe('');
});

it('approving a send: whole, in groups of four', () => {
  expect(groupAddress(QNET)).toBe('d9fa 3703 74e2 4333 242e on84 7d1d 354d cd87 fe87 3823 e');
  expect(groupAddress(QNET).replace(/ /g, '')).toBe(QNET);
});

it('no other module writes its own short form of an address', () => {
  const src = path.join(__dirname, '..', 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const defining = walk(src).filter((f) => f.endsWith('.js') && /(const|function|let)\s+shortAddress\b/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(src, f).split(path.sep).join('/'));
  expect(defining).toEqual(['utils/addressDisplay.js']);
});
