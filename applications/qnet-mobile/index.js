/**
 * @format
 */

import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;

// Polyfill for process (must be before crypto-browserify)
if (typeof global.process === 'undefined') {
  global.process = require('process');
}
// Set process.browser to true for browserify compatibility
global.process.browser = true;
global.process.nextTick = global.process.nextTick || ((fn) => setTimeout(fn, 0));

// Polyfill for events (must be before crypto-browserify)
if (typeof global.EventEmitter === 'undefined') {
  global.EventEmitter = require('events').EventEmitter;
}

// Lazy load crypto-browserify to avoid blocking startup
// Only load when actually needed (when ed25519-hd-key is used)
let cryptoLoaded = false;
const loadCrypto = () => {
  if (!cryptoLoaded) {
    try {
      const crypto = require('crypto-browserify');
      if (typeof global.crypto === 'undefined') {
        global.crypto = crypto;
      }
      if (typeof global.createHmac === 'undefined') {
        global.createHmac = crypto.createHmac;
      }
      cryptoLoaded = true;
    } catch (error) {
      console.warn('Failed to load crypto-browserify:', error);
    }
  }
  return global.crypto;
};

// Set up lazy loading for create-hmac
if (typeof global.createHmac === 'undefined') {
  global.createHmac = function(algorithm, key) {
    const crypto = loadCrypto();
    return crypto.createHmac(algorithm, key);
  };
}

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('QNetMobile', () => App);
