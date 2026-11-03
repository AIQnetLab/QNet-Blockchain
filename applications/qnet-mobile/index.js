/**
 * @format
 */

// crypto-install MUST be the first import — sets global.crypto via OpenSSL JSI.
import './src/polyfills/crypto-install';
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import './src/polyfills/buffer-subarray';
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
import BackgroundFetch from 'react-native-background-fetch';
import { handlePushMessage, onBackgroundFetch } from './src/services/PushService';
import { watchWakes } from './src/services/NetworkWake';
import { installClientAgent } from './src/utils/clientAgent';

// Every request to aiqnet.io and the genesis nodes names the app's build, a background wake's too.
installClientAgent();

// A retry waiting on a back-off for aiqnet.io goes again when the app comes to the front or a network is back.
watchWakes();

// Background/killed FCM handler — MUST be at top level (not in useEffect).
// When the app is killed by OS and a push arrives, Android starts a headless
// JS context that executes index.js but does NOT render React components.
// If this handler were inside App's useEffect, killed-app pushes would be lost.
messaging().setBackgroundMessageHandler(async remoteMessage => {
  if (remoteMessage?.data) {
    await handlePushMessage(remoteMessage.data);
  }
});

// Android: background-fetch events after the app is terminated (stopOnTerminate:false) land here, in the
// same handler the live app configures. A timeout event only finishes the task.
BackgroundFetch.registerHeadlessTask(async ({ taskId, timeout }) => {
  if (timeout) { BackgroundFetch.finish(taskId); return; }
  await onBackgroundFetch(taskId);
});

// The app's screens load only when the system runs the app's view: a process started for a push or a fetch registers
// its handlers above with none of them loaded (an import would load them first), and App draws nothing until opened.
AppRegistry.registerComponent('QNetMobile', () => require('./App').default);
