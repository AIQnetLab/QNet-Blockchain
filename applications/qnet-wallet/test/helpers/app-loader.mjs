// Module resolution hook for the parity tests (registered by app-modules.mjs): the mobile app's own modules under
// applications/qnet-mobile/src are ES modules in .js files, imported without extensions, of a package that does not
// say so; they load read-only as they are, and their dependencies from the app's node_modules.
const APP_SRC = new URL('../../../qnet-mobile/src/', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(APP_SRC) && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, url.startsWith(APP_SRC) ? { ...context, format: 'module' } : context);
}
