module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // App code logs through src/utils/logger, which is silent in release builds (and release bundles strip
    // every console call, babel.config.js).
    'no-console': 'error',
  },
  overrides: [
    {
      // The logger itself; the light client shared with the browser extension bundle; tooling and tests.
      files: ['src/utils/logger.js', 'src/crypto/QcLightClient.js', 'scripts/**', '__tests__/**', 'jest.setup.js'],
      rules: { 'no-console': 'off' },
    },
  ],
};
