// Module resolution hook for the chains-activation tests (registered with node:module register()).
// The worker modules of the vault/session area that qnet.js, solana.js and activation.js import resolve
// to an in-memory stand-in, so the chain code is tested without touching the shipped files.
const STUBS = new URL('./chains-activation-stubs.mjs', import.meta.url).href;
const REPLACED = new Set(['./session.js', './vault.js', './keys.js']);
// a query string loads a fresh instance of a module (a new worker)
const WORKER_MODULE = /\/dist\/background\/[a-z]+\.js(\?[^/]*)?$/;

export async function resolve(specifier, context, nextResolve) {
  if (REPLACED.has(specifier) && context.parentURL && WORKER_MODULE.test(context.parentURL)) {
    return { url: STUBS, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
