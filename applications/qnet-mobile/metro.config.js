const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    alias: {
      'crypto': 'react-native-crypto-js',
      'stream': 'stream-browserify',
      'buffer': '@craftzdog/react-native-buffer',
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
