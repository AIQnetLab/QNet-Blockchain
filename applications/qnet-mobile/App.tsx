/**
 * QNet Mobile Wallet
 * React Native Application
 *
 * A linked node is woken by Firebase Cloud Messaging data messages, or by polling where the device has no push token.
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import WalletScreen from './src/screens/WalletScreen';
import ErrorBoundary from './src/components/ErrorBoundary';
import { backgroundRefreshFcmToken, handlePushMessage, initializePushService } from './src/services/PushService';
import logger from './src/utils/logger';

// The app shows no notifications and asks for no notification permission: the network's pushes are silent data
// messages, which need none.
function App(): React.JSX.Element {
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
    <ErrorBoundary>
      <StatusBar barStyle="light-content" backgroundColor="#11131f" translucent={false} />
      <WalletScreen />
    </ErrorBoundary>
  );
}

export default App;
