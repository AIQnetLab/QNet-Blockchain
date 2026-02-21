const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const path = require('path');

const config = {
  transformer: {
    // Disable inline requires so ALL modules go into the main bundle upfront.
    // Without this, js-sha3 and @solana/web3.js are lazy-loaded as separate
    // bundle requests that take >60s and cause the device-side timeout.
    inlineRequires: false,
  },
  resolver: {
    extraNodeModules: {
      // css-tree is a Node.js CSS parser pulled in by react-native-svg for its
      // CSS-in-SVG feature. The wallet app does not use SvgCss/SvgWithCss, so
      // replacing it with a stub is safe and prevents Hermes compile errors.
      'css-tree': require.resolve('./css-tree-shim.js'),
      stream: require.resolve('readable-stream'),
      crypto: require.resolve('crypto-browserify'),
      'create-hmac': path.resolve(__dirname, 'create-hmac-polyfill.js'),
      'create-hash': require.resolve('crypto-browserify'),
      'pbkdf2': require.resolve('crypto-browserify'),
      events: require.resolve('events'),
      _stream_writable: require.resolve('readable-stream/lib/_stream_writable'),
      _stream_readable: require.resolve('readable-stream/lib/_stream_readable'),
      _stream_duplex: require.resolve('readable-stream/lib/_stream_duplex'),
      _stream_transform: require.resolve('readable-stream/lib/_stream_transform'),
      _stream_passthrough: require.resolve('readable-stream/lib/_stream_passthrough'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
