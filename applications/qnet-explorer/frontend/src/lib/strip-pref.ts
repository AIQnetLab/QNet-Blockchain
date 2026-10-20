// Whether a visitor hid the explorer's Latest blocks strip (owner 20.10: the strip folds away and stays as the visitor
// left it). One cookie, written only by Hide and deleted by Show, scoped to the explorer's pages; the server reads it so
// the page paints the strip folded or open from the first byte, and nothing moves after load.

export const STRIP_COOKIE = 'qnet.blocks';
const HIDDEN = 'hidden';
// A year: the strip stays folded until the visitor shows it again.
const KEEP_S = 365 * 24 * 60 * 60;

export const stripHidden = (value: string | null | undefined): boolean => value === HIDDEN;

// The strip's state from a Cookie header or document.cookie.
export function stripHiddenIn(cookies: string): boolean {
  for (const part of cookies.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === STRIP_COOKIE) return stripHidden(part.slice(at + 1).trim());
  }
  return false;
}

// The Set-Cookie value Hide (hidden) and Show (not hidden) write; Show deletes the cookie.
export function stripCookie(hidden: boolean, secure: boolean): string {
  const value = `${STRIP_COOKIE}=${hidden ? HIDDEN : ''}; Path=/explorer; Max-Age=${hidden ? KEEP_S : 0}; SameSite=Lax`;
  return secure ? `${value}; Secure` : value;
}
