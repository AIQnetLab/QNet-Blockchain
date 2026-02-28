/**
 * @format
 */

// crypto-install MUST be the first import — sets global.crypto via OpenSSL JSI.
import './src/polyfills/crypto-install';
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;

if (typeof global.process === 'undefined') {
  global.process = require('process');
}
global.process.browser = true;
global.process.nextTick = global.process.nextTick || ((fn) => setTimeout(fn, 0));

if (typeof global.EventEmitter === 'undefined') {
  global.EventEmitter = require('events').EventEmitter;
}

import { AppRegistry } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import { handlePushMessage } from './src/services/PushService';
import App from './App';

// Background/killed FCM handler — MUST be at top level (not in useEffect).
// When the app is killed by OS and a push arrives, Android starts a headless
// JS context that executes index.js but does NOT render React components.
// If this handler were inside App's useEffect, killed-app pushes would be lost.
messaging().setBackgroundMessageHandler(async remoteMessage => {
  if (remoteMessage?.data) {
    await handlePushMessage(remoteMessage.data);
  }
});

AppRegistry.registerComponent('QNetMobile', () => App);
