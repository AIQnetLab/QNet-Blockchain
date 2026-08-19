const rnPreset = require('react-native/jest-preset');

module.exports = {
  preset: 'react-native',
  // Several deps ship untranspiled ESM (.mjs among them); the preset transforms neither, so the app
  // graph cannot even parse under Jest without both of these.
  transform: { ...rnPreset.transform, '^.+\\.mjs$': 'babel-jest' },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native[^/]*|@react-native[^/]*|@solana|@noble|@scure|uuid)/)',
  ],
  // rpc-websockets (via @solana/web3.js) declares only "browser"/"node" export conditions, neither of
  // which the react-native resolver asks for, so point it at the CJS entry Metro ends up using.
  moduleNameMapper: {
    '^rpc-websockets$': '<rootDir>/node_modules/rpc-websockets/dist/index.cjs',
    '^rpc-websockets/(.*)$': '<rootDir>/node_modules/rpc-websockets/dist/$1',
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
};
