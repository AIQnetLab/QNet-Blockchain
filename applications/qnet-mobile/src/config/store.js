import { NativeModules, Platform } from 'react-native';

// The distribution this build came from: 'play' (Google Play), 'site' (the APK on aiqnet.io and GitHub)
// or 'ios'. Android reads the Gradle flavor through the QNetStore native module; a build that cannot say
// which flavor it is counts as Play, so the activation below stays off unless the site flavor confirms it.
export const STORE = Platform.OS === 'ios' ? 'ios' : (NativeModules.QNetStore?.STORE || 'play');

// Google Play requires its own billing for any in-app payment that unlocks a feature. Node activation
// burns 1DEV, so the Play build does not start one; it still recovers and registers an activation this
// wallet already holds on chain.
export const IN_APP_ACTIVATION = STORE !== 'play';

// The installed build (Android only; 0 / '' where the native module does not report it).
export const APP_VERSION_CODE = Number(NativeModules.QNetStore?.VERSION_CODE) || 0;
export const APP_VERSION_NAME = NativeModules.QNetStore?.VERSION_NAME || '';
