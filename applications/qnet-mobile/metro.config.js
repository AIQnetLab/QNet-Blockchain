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
    // Disable experimental exports-map resolution — causes spurious WARN on subpaths
    // not listed in package.json "exports" (noble/hashes, rpc-websockets, etc.).
    // File-based resolution is identical in behaviour and is the stable Metro path.
    unstable_enablePackageExports: false,
    extraNodeModules: {
      'css-tree': require.resolve('./css-tree-shim.js'),
      stream: require.resolve('readable-stream'),
      crypto: require.resolve('react-native-quick-crypto'),
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
