// How an address is shown where the user approves something sent to it: whole, in groups of four characters, so a
// look-alike that differs in the middle is as visible as one that differs at the ends (MPLAT-R5-01).

/** "02dca74ef2ea..." -> "02dc a74e f2ea ..."; anything that is not a string -> ''. */
export function groupAddress(address) {
  if (typeof address !== 'string') return '';
  const a = address.trim();
  return a ? a.match(/.{1,4}/g).join(' ') : '';
}
