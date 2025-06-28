const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  devtool: 'source-map',
  
  entry: {
    popup: './src/popup/index.js',
    background: './src/background/index.js',
    content: './src/content/index.js'
  },
  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', {
                targets: {
                  chrome: '88'
                },
                modules: false
              }]
            ],
            plugins: [
              '@babel/plugin-transform-class-properties',
              '@babel/plugin-transform-private-methods'
            ]
          }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg)$/,
        type: 'asset/resource',
        generator: {
          filename: 'icons/[name][ext]'
        }
      },
      {
        test: /\.json$/,
        type: 'asset/resource',
        generator: {
          filename: 'locales/[name][ext]'
        }
      }
    ]
  },
  
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /\.pem$/
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /test_key\.pem$/
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /test_rsa_privkey\.pem$/
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /test_rsa_pubkey\.pem$/
    }),
    new webpack.IgnorePlugin({
      contextRegExp: /public-encrypt/,
      resourceRegExp: /test/
    }),
    new CopyWebpackPlugin({
      patterns: [
        { 
          from: 'popup.html', 
          to: 'popup.html',
          transform(content) {
            return content.toString()
              .replace(
                '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
                '<!-- Local fonts only -->'
              );
          }
        },
        { 
          from: 'manifest.json', 
          to: 'manifest.json',
          transform(content) {
            return content.toString()
              .replace('"service_worker": "dist/background.js"', '"service_worker": "background.js"')
              .replace('"js": ["dist/content.js"]', '"js": ["content.js"]')
              .replace('"dist/*"', '"*"');
          }
        },
        { from: 'icons', to: 'icons' },
        { from: 'styles', to: 'styles' },
        { from: 'inject.js', to: 'inject.js' }
      ]
    })
  ],
  
  resolve: {
    fallback: {
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer'),
      util: require.resolve('util'),
      process: require.resolve('process/browser'),
      path: require.resolve('path-browserify'),
      fs: false,
      os: false
    },
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  
  optimization: {
    minimize: true,
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all'
        }
      }
    }
  },
  // Exclude test files and private keys
  externals: {
    'test_key.pem': 'undefined',
    'test_rsa_privkey.pem': 'undefined', 
    'test_rsa_pubkey.pem': 'undefined'
  }
}; 