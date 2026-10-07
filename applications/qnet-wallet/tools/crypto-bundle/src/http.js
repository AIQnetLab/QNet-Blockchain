// The one bounded body reader of the extension: the worker's node, explorer and Solana reads (qnet.js,
// solana.js) and the bundled light client's fetch (shims/fetch.js) all take an answer through it, so no body
// larger than its cap is ever held in full, whatever the server declares (R2-EXTQ-05, R4-EXTQ-03). A chunked
// or compressed answer carries no usable length: the stream is cut as soon as the bytes read pass the cap.
import { fail } from './errors.js';

/**
 * The text of a fetch Response, read chunk by chunk and cancelled as soon as more than `maxBytes` bytes have
 * arrived (a Content-Length above the cap is refused before anything is read).
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>} the body as UTF-8 text
 * @throws {CoreError} RESPONSE_TOO_LARGE
 */
export async function readBoundedText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('INVALID_LENGTH');
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail('RESPONSE_TOO_LARGE');
  const reader = response?.body?.getReader?.();
  if (!reader) {
    // no stream to cut (an answer without a body): what text() gives, still bounded
    const text = await response.text();
    if (text.length > maxBytes) fail('RESPONSE_TOO_LARGE');
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      fail('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
