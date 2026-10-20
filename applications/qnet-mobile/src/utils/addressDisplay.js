// How an address is shown. Where the user approves something sent to it: whole, in groups of four characters, so a
// look-alike that differs in the middle is as visible as one that differs at the ends (MPLAT-R5-01). As a screen's
// subject: in its own structure. As a reference in a row: its start and end. The copied value is always the raw one.

/** "02dca74ef2ea..." -> "02dc a74e f2ea ..."; anything that is not a string -> ''. */
export function groupAddress(address) {
  if (typeof address !== 'string') return '';
  const a = address.trim();
  return a ? a.match(/.{1,4}/g).join(' ') : '';
}

const QNET_ADDRESS = /^([0-9a-f]{19})(eon)([0-9a-f]{15})([0-9a-f]{8})$/;

/** A QNet Blockchain address in its parts: 19 hex, "eon", 15 hex, the 8-hex check; null for anything else. */
export function addressParts(address) {
  const m = typeof address === 'string' ? QNET_ADDRESS.exec(address.trim()) : null;
  return m ? m.slice(1) : null;
}

/** An address as a reference in a row: its first and last six characters ("d9fa37…73823e"); a short text whole. */
export function shortAddress(address) {
  const a = typeof address === 'string' ? address.trim() : '';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}
