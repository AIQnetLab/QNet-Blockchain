// The mobile app's own modules, imported read-only by the parity tests: one payment request read alike, one transfer
// built to the same bytes. null when this checkout cannot load them (the app's dependencies are not installed); the
// tests then compare with the app's recorded vectors only, and say so.
import { register } from 'node:module';

register('./app-loader.mjs', import.meta.url);

/**
 * @param {string} file path under applications/qnet-mobile/src, with its extension
 * @returns {Promise<object|null>}
 */
export async function importApp(file) {
  try {
    return await import(new URL(`../../../qnet-mobile/src/${file}`, import.meta.url).href);
  } catch {
    return null;
  }
}
