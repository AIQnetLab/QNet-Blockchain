/**
 * QNet Mobile Wallet
 * React Native Application
 *
 * A linked node is woken by Firebase Cloud Messaging data messages, or by polling where the device has no push token.
 */

import React, { useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import messaging from '@react-native-firebase/messaging';
import WalletScreen from './src/screens/WalletScreen';
import ErrorBoundary from './src/components/ErrorBoundary';
import { color } from './src/theme';
import { settleLayoutDirection } from './src/i18n/direction';
import { backgroundRefreshFcmToken, handlePushMessage, initializePushService } from './src/services/PushService';
import logger from './src/utils/logger';

// A restart for the layout that has not replaced the JS by then never will: the screen is drawn as it is.
const LAYOUT_RESTART_GRACE_MS = 4000;

// The app shows no notifications and asks for no notification permission: the network's pushes are silent data
// messages, which need none.
function App(): React.JSX.Element {
  // The wallet screen starts once the layout has the saved language's direction (i18n/direction), so nothing it begins
  // (an unlock prompt, the light node) is cut off by the restart that turns it.
  const [layoutSettled, setLayoutSettled] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    settleLayoutDirection()
      .then((ready) => {
        if (ready) setLayoutSettled(true);
        else timer = setTimeout(() => setLayoutSettled(true), LAYOUT_RESTART_GRACE_MS);
      }, () => setLayoutSettled(true));
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    // The wakes of a node linked to this device; no push token is taken here (one exists only while a node is linked).
    const initPush = async () => {
      try {
        await initializePushService();

        // Setup FCM handlers if available
        try {
          // Handle foreground messages
          const unsubscribeForeground = messaging().onMessage(async remoteMessage => {
            logger.log('[FCM] foreground message');
            await handlePushMessage(remoteMessage.data);
          });

          // Background/quit handler is registered in index.js (top-level, headless-safe).
          // Only foreground handler and listeners belong here.

          // A new token of a linked node goes to its shard owners (signed by the ping key); nothing is kept otherwise.
          const unsubscribeTokenRefresh = messaging().onTokenRefresh(async () => {
            logger.log('[FCM] Token refreshed');
            await backgroundRefreshFcmToken();
          });

          return () => {
            unsubscribeForeground();
            unsubscribeTokenRefresh();
          };
        } catch (fcmError) {
          // FCM not available - using alternative push
          logger.log('[Push] FCM handlers not available, using alternative');
        }
      } catch (error) {
        logger.error('[Push] Initialization error:', error);
      }
    };

    initPush();
  }, []);

  return (
    // Every SafeAreaView reads the device's insets (status bar, Dynamic Island, home indicator, rounded corners) from
    // this provider; on the legacy architecture one without it gets none.
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <ErrorBoundary>
        <StatusBar barStyle="light-content" backgroundColor={color.ink} translucent={false} />
        {layoutSettled ? <WalletScreen /> : null}
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

export default App;
