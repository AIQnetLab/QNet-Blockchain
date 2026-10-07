module.exports = {
  presets: ['module:@react-native/babel-preset'],
  env: {
    // Release bundles carry no console output at all (Metro builds them with BABEL_ENV=production): nothing
    // an app logs can reach logcat, os_log or a bug report.
    production: {
      plugins: ['transform-remove-console'],
    },
    // Metro turns import() into its own module loading; Jest's CommonJS runtime needs it as a require (the hash
    // modules ErrorBoundary and WalletManager load on first use).
    test: {
      plugins: ['@babel/plugin-transform-dynamic-import'],
    },
  },
};
