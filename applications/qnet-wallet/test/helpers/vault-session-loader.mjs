// Module resolution hook for the vault-session tests (registered with node:module register() by
// vault-session-env.mjs): every import of dist/lib/qnet-core.js resolves to vault-session-core.mjs, the
// real bundle with a cheap Argon2id, so a vault test does not spend seconds per unlock.
// test/vault-session-kdf.test.mjs runs the real KDF without this hook.
const WRAPPER = new URL('./vault-session-core.mjs', import.meta.url).href;
const CORE = /\/dist\/lib\/qnet-core\.js$/;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (CORE.test(resolved.url) && context.parentURL !== WRAPPER) return { url: WRAPPER, shortCircuit: true };
  return resolved;
}
