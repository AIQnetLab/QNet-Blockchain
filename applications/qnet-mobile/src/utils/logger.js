/**
 * Diagnostics for development builds only: every method is a no-op in a release build (and the release
 * bundle has its console calls stripped anyway, see babel.config.js). Never pass a token, challenge,
 * activation code, burn transaction, address or URL with a query to it.
 */

const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
const noop = () => {};

export const logger = {
  log: isDev ? (...args) => console.log(...args) : noop,
  error: isDev ? (...args) => console.error(...args) : noop,
  warn: isDev ? (...args) => console.warn(...args) : noop,
  info: isDev ? (...args) => console.info(...args) : noop,
  debug: isDev ? (...args) => console.debug(...args) : noop,
};

export default logger;
