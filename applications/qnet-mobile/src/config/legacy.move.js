// The last update of the old Android package com.qnetmobile (android/app/build.gradle, -PqnetLegacyMove): the wallet
// only, no node, and a notice to install the one QNet Wallet app and restore there with the recovery phrase. Only that
// build carries this file: metro.legacy.config.js takes it in place of ./legacy.js, so the io.aiqnet.wallet bundle holds
// neither the notice's links nor its texts (SD-12). The native flag stays a second guard.
import { NativeModules } from 'react-native';

export const LEGACY_MOVE = !!(NativeModules.QNetAppBuild && NativeModules.QNetAppBuild.legacyMove === true);

// Where the notice sends the user: the app on Google Play, and the site's page that offers the same file.
export const NEW_APP_PLAY_URL = 'https://play.google.com/store/apps/details?id=io.aiqnet.wallet';
export const NEW_APP_SITE_URL = 'https://aiqnet.io/wallet';
