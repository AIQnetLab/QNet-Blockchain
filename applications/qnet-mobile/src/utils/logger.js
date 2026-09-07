/**
 * Production-safe logger utility
 * Logs only in development mode (__DEV__ = true)
 * In production, all logs are disabled to improve performance
 */

const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export const logger = {
  log: (...args) => {
    if (isDev) {
      console.log(...args);
    }
  },
  
  error: (...args) => {
    // Always log errors, even in production (for crash reporting).
    console.error(...args);
  },
  
  warn: (...args) => {
    if (isDev) {
      console.warn(...args);
    }
  },
  
  info: (...args) => {
    if (isDev) {
      console.info(...args);
    }
  },
  
  debug: (...args) => {
    if (isDev) {
      console.debug(...args);
    }
  }
};

export default logger;

