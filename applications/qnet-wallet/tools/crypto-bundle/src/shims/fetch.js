// The only network function inside the bundle. build.js injects this module for every free `fetch` of
// the compiled sources, so the mobile light client (QcLightClient: macroblock proofs and registry
// snapshots) reads through a hardened transport, as the extension's own nodeRequest does (R2-EXTQ-05):
// GET to an https URL only, no credentials, no redirect, no cache, no referrer, and a body over
// MAX_BODY_BYTES is refused while it is read, before anything is parsed (http.js readBoundedText, the reader
// the worker's own requests use too: R4-EXTQ-03).
import { readBoundedText } from '../http.js';

// The largest answer the light client takes (a registry snapshot: QcLightClient REGISTRY_MAX_BYTES).
export const MAX_BODY_BYTES = 16 << 20;

/**
 * fetch for the bundled light client: the answer's body is read in full (bounded) before it is returned.
 * @param {string|URL} url an https URL
 * @param {{signal?: AbortSignal}} [init] only the abort signal is taken over; method, headers and the
 *   rest are fixed here
 * @returns {Promise<{ok: boolean, status: number, text: () => Promise<string>, json: () => Promise<unknown>}>}
 */
export async function fetch(url, init = {}) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') throw new TypeError('https only');
  const response = await globalThis.fetch(target.href, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: init?.signal,
  });
  const text = await readBoundedText(response, MAX_BODY_BYTES);
  return Object.freeze({
    ok: response.ok,
    status: response.status,
    text: async () => text,
    json: async () => JSON.parse(text),
  });
}
