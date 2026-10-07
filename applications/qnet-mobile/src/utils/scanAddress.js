/**
 * What the QR scan of the QNet Send screen takes: a QNet address and nothing else. The text of a QR code is accepted
 * only when, trimmed, it is an address WalletManager.recipientAddress accepts, the same check as the address field and
 * the send itself (45 characters, "eon" in the middle, SHA3 checksum), and it comes back lowercase. The app's own
 * Receive QR carries the bare address, so there is no payment form to read. Anything else (a Solana address, a web
 * address, a 64-character hex value, any other text or payment code) is null, and nothing read is ever opened.
 */
import WalletManager from '../components/WalletManager';

// Longer than any address with room for spaces around it; a longer text is refused before any check runs.
const MAX_SCAN_TEXT = 128;

export function qnetAddressFromScan(text) {
  if (typeof text !== 'string' || text.length > MAX_SCAN_TEXT) return null;
  try {
    return WalletManager.recipientAddress(text.trim());
  } catch (_) {
    return null;
  }
}
