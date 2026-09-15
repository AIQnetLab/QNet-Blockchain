/**
 * QNet Mobile Wallet
 * React Native Application
 * 
 * Supports multiple push providers:
 * - FCM (Google Play users)
 * - UnifiedPush (F-Droid users)
 * - Polling fallback (no push available)
 */

import React, { useEffect } from 'react';
import { StatusBar, Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import WalletScreen from './src/screens/WalletScreen';
import ErrorBoundary from './src/components/ErrorBoundary';
import PushService, { handlePushMessage, initializePushService } from './src/services/PushService';

// Request permission for push notifications
async function requestUserPermission() {
  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (enabled) {
      console.log('[Push] Authorization status:', authStatus);
      return true;
    }
  } catch (error) {
    // FCM not available (F-Droid build)
    console.log('[Push] FCM not available, will use alternative');
  }
  return false;
}

function App(): React.JSX.Element {
  useEffect(() => {
    // Initialize push service (auto-detects best provider)
    const initPush = async () => {
      try {
        // Initialize our unified push service
        const provider = await initializePushService();
        console.log('[Push] Provider initialized:', provider.type);

        // Request notification permission
        await requestUserPermission();

        // Setup FCM handlers if available
        try {
          // Handle foreground messages
          const unsubscribeForeground = messaging().onMessage(async remoteMessage => {
            console.log('[FCM] Foreground message:', remoteMessage);
            await handlePushMessage(remoteMessage.data);
          });

          // Background/quit handler is registered in index.js (top-level, headless-safe).
          // Only foreground handler and listeners belong here.

          // Handle notification opened app
          messaging().onNotificationOpenedApp(remoteMessage => {
            console.log('[FCM] Notification opened app:', remoteMessage);
          });

          // Check if app was opened from notification
          messaging()
            .getInitialNotification()
            .then(remoteMessage => {
              if (remoteMessage) {
                console.log('[FCM] App opened from notification:', remoteMessage);
              }
            });

          // Token refresh listener — immediately push to genesis nodes if possible
          const unsubscribeTokenRefresh = messaging().onTokenRefresh(async (newToken) => {
            console.log('[FCM] Token refreshed');
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            await AsyncStorage.setItem('qnet_fcm_token', newToken);
            await AsyncStorage.setItem('qnet_needs_token_refresh', 'true');
            try {
              const { backgroundRefreshFcmToken } = require('./src/services/PushService');
              await backgroundRefreshFcmToken();
            } catch (_) {}
          });

          return () => {
            unsubscribeForeground();
            unsubscribeTokenRefresh();
          };
        } catch (fcmError) {
          // FCM not available - using alternative push
          console.log('[Push] FCM handlers not available, using alternative');
        }
      } catch (error) {
        console.error('[Push] Initialization error:', error);
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
