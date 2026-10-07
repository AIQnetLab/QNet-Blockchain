/**
 * Metro configuration of the old Android package's last update only (android/app/build.gradle, -PqnetLegacyMove sets it
 * as the bundle's config). The app is the same; two modules differ: src/config/legacy.js becomes legacy.move.js (the
 * move notice and its links) and src/i18n/overlay.android.js becomes overlay.legacy.js (the notice's texts). Every other
 * bundle is built with ./metro.config.js and carries none of them (SD-12).
 */
const path = require('path');
const base = require('./metro.config');

const SWAP = new Map([
  [path.join(__dirname, 'src', 'config', 'legacy.js'), path.join(__dirname, 'src', 'config', 'legacy.move.js')],
  [path.join(__dirname, 'src', 'i18n', 'overlay.android.js'), path.join(__dirname, 'src', 'i18n', 'overlay.legacy.js')],
]);

// The base config's own resolver when it has one, else Metro's.
const baseResolve = base.resolver.resolveRequest
  || ((context, moduleName, platform) => context.resolveRequest(context, moduleName, platform));

module.exports = {
  ...base,
  cacheVersion: `${base.cacheVersion}-legacy-move`,
  resolver: {
    ...base.resolver,
    resolveRequest: (context, moduleName, platform) => {
      const resolved = baseResolve(context, moduleName, platform);
      const swap = platform === 'android' && resolved && resolved.type === 'sourceFile' ? SWAP.get(resolved.filePath) : null;
      // The replacement itself imports the module it replaces (overlay.legacy.js builds on ./overlay.android): that one
      // import keeps the original, or the file would import itself and throw at load.
      if (swap && context.originModulePath && path.resolve(context.originModulePath) === swap) return resolved;
      return swap ? { ...resolved, filePath: swap } : resolved;
    },
  },
};
