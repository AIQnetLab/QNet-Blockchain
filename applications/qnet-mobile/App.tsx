/**
 * QNet Mobile Wallet
 * React Native Application
 */

import React, { useEffect } from 'react';
import { StatusBar, Alert, Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import WalletScreen from './src/screens/WalletScreen';
import ErrorBoundary from './src/components/ErrorBoundary';

// Request permission for push notifications
async function requestUserPermission() {
  const authStatus = await messaging().requestPermission();
  const enabled =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (enabled) {
    console.log('[FCM] Authorization status:', authStatus);
    return true;
  }
  return false;
}

// Get FCM token for this device
async function getFCMToken(): Promise<string | null> {
  try {
    const token = await messaging().getToken();
    console.log('[FCM] Device token:', token);
    return token;
  } catch (error) {
    console.error('[FCM] Failed to get token:', error);
    return null;
  }
}

// Handle incoming FCM message (ping from QNet network)
async function handlePingMessage(remoteMessage: any) {
  const data = remoteMessage.data;
  
  if (data?.action === 'ping_response') {
    console.log('[QNet] Received ping challenge:', data.challenge);
    console.log('[QNet] Node ID:', data.node_id);
    
    try {
      // Import required modules for signing
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const nacl = require('tweetnacl');
      const CryptoJS = require('crypto-js');
      
      // Load wallet secret key from secure storage
      const walletDataStr = await AsyncStorage.getItem('qnet_wallet_encrypted');
      if (!walletDataStr) {
        console.error('[QNet] No wallet found for ping response');
        return;
      }
      
      // Get stored password hash for decryption (simplified - in production use Keychain)
      const passwordHash = await AsyncStorage.getItem('qnet_password_hash');
      if (!passwordHash) {
        console.error('[QNet] No password hash for wallet decryption');
        return;
      }
      
      // Decrypt wallet data
      const decrypted = CryptoJS.AES.decrypt(walletDataStr, passwordHash);
      const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
      
      // Sign the challenge with Ed25519 (mobile clients use Ed25519, not Dilithium)
      const challengeBytes = new TextEncoder().encode(data.challenge);
      const signature = nacl.sign.detached(challengeBytes, new Uint8Array(walletData.secretKey));
      const signatureHex = Buffer.from(signature).toString('hex');
      
      // Get bootstrap node URL
      const bootstrapNodes = [
        'https://bootstrap1.qnet.network',
        'https://bootstrap2.qnet.network',
        'https://bootstrap3.qnet.network',
        'https://bootstrap4.qnet.network',
        'https://bootstrap5.qnet.network'
      ];
      const apiUrl = bootstrapNodes[Math.floor(Math.random() * bootstrapNodes.length)];
      
      // Send ping response to network
      const response = await fetch(`${apiUrl}/api/v1/light-node/ping-response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          node_id: data.node_id,
          challenge: data.challenge,
          signature: signatureHex,
          timestamp: Date.now()
        })
      });
      
      if (response.ok) {
        console.log('[QNet] ✅ Ping response sent successfully');
      } else {
        const errorText = await response.text();
        console.error('[QNet] ❌ Ping response failed:', errorText);
      }
    } catch (error) {
      console.error('[QNet] ❌ Error handling ping:', error);
    }
  }
}

function App(): React.JSX.Element {
  useEffect(() => {
    // Initialize FCM
    const initFCM = async () => {
      const hasPermission = await requestUserPermission();
      
      if (hasPermission) {
        const token = await getFCMToken();
        if (token) {
          // Store token for Light node registration
          console.log('[FCM] Ready to receive push notifications');
        }
      }
    };

    initFCM();

    // Handle foreground messages
    const unsubscribeForeground = messaging().onMessage(async remoteMessage => {
      console.log('[FCM] Foreground message:', remoteMessage);
      await handlePingMessage(remoteMessage);
    });

    // Handle background/quit messages
    messaging().setBackgroundMessageHandler(async remoteMessage => {
      console.log('[FCM] Background message:', remoteMessage);
      await handlePingMessage(remoteMessage);
    });

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

    // Token refresh listener - update FCM token on QNet network
    const unsubscribeTokenRefresh = messaging().onTokenRefresh(async (newToken) => {
      console.log('[FCM] Token refreshed:', newToken);
      
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        
        // Store new token locally
        await AsyncStorage.setItem('qnet_fcm_token', newToken);
        
        // Get node registration info
        const nodeInfo = await AsyncStorage.getItem('qnet_light_node_info');
        if (!nodeInfo) {
          console.log('[FCM] No Light node registered, skipping token update');
          return;
        }
        
        const { nodeId, walletAddress } = JSON.parse(nodeInfo);
        
        // Update token on bootstrap nodes
        const bootstrapNodes = [
          'https://bootstrap1.qnet.network',
          'https://bootstrap2.qnet.network',
          'https://bootstrap3.qnet.network',
        ];
        const apiUrl = bootstrapNodes[Math.floor(Math.random() * bootstrapNodes.length)];
        
        const response = await fetch(`${apiUrl}/api/v1/light-node/update-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: nodeId,
            wallet_address: walletAddress,
            device_token: newToken,
            timestamp: Date.now()
          })
        });
        
        if (response.ok) {
          console.log('[FCM] ✅ Token updated on QNet network');
        } else {
          console.error('[FCM] ❌ Failed to update token:', await response.text());
        }
      } catch (error) {
        console.error('[FCM] ❌ Error updating token:', error);
      }
    });

    return () => {
      unsubscribeForeground();
      unsubscribeTokenRefresh();
    };
  }, []);

  return (
    <ErrorBoundary>
      <StatusBar barStyle="light-content" backgroundColor="#11131f" translucent={false} />
      <WalletScreen />
    </ErrorBoundary>
  );
}

export default App;