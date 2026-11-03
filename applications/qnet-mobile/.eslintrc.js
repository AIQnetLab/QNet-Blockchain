module.exports = {
  root: true,
  extends: '@react-native',
  // Every file runs with BigInt (Hermes), Buffer (index.js), and crypto, TextEncoder and TextDecoder
  // (polyfills/crypto-install).
  env: { es2020: true },
  globals: { Buffer: 'readonly', crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly' },
  rules: {
    // App code logs through src/utils/logger, which is silent in release builds (and release bundles strip
    // every console call, babel.config.js).
    'no-console': 'error',
  },
  overrides: [
    {
      // The logger itself; the light client and its hold, shared with the browser extension bundle; tooling and tests.
      files: [
        'src/utils/logger.js', 'src/crypto/QcLightClient.js', 'src/utils/userHold.js', 'scripts/**', '__tests__/**', 'jest.setup.js',
      ],
      rules: { 'no-console': 'off' },
    },
    {
      // The helpers the test files share run under Jest too.
      files: ['test-support/**'],
      env: { jest: true },
    },
  ],
};
