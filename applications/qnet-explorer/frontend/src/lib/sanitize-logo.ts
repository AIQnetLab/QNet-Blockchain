// Mirror of the node's on-chain ContractDeploy logo sanitizer (core/qnet-state transaction.rs). A logo
// the explorer derives client-side from RAW deploy calldata must carry the SAME guarantee as the
// node-sanitized on-chain value: never a non-https scheme, never an HTML/attribute-breaking string that
// could inject if ever rendered outside the escaping <TokenIcon>. Defense-in-depth — apply at every
// point a logo enters the explorer data model. Keep the rule in sync with the node.

// Chars that can break out of an HTML attribute / inject markup: quotes, angle brackets, backtick, and
// any whitespace (\s covers space/tab/newline/CR/FF and Unicode spaces).
const HTML_UNSAFE = /["'`<>\s]/;

export function sanitizeLogo(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const capped = raw.trim().slice(0, 256);
  if (!capped) return '';
  const htmlUnsafe = HTML_UNSAFE.test(capped);
  const lower = capped.toLowerCase();
  if (lower.includes('://') || lower.includes('javascript:') || lower.includes('data:')) {
    // Has a scheme ⇒ accept ONLY a clean https:// URL.
    return lower.startsWith('https://') && !htmlUnsafe ? capped : '';
  }
  // No scheme ⇒ a short emoji/label; drop if it carries markup-unsafe chars.
  return htmlUnsafe ? '' : capped;
}
