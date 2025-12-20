/**
 * Polyfill for create-hmac module
 * Maps create-hmac to crypto-browserify for React Native compatibility
 */
const crypto = require('crypto-browserify');

module.exports = function createHmac(algorithm, key) {
  return crypto.createHmac(algorithm, key);
};

// Also export as default for ES6 compatibility
module.exports.default = module.exports;

