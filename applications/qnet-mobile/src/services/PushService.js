/**
 * QNet Push Service
 * Supports FCM (Google Play), UnifiedPush (F-Droid), and Polling fallback
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import BackgroundFetch from 'react-native-background-fetch';

// Bootstrap node URLs
const BOOTSTRAP_NODES = [
  'http://154.38.160.39:8001',
  'http://62.171.157.44:8001',
  'http://161.97.86.81:8001',
  'http://5.189.130.160:8001',
  'http://162.244.25.114:8001',
];

// Push types
export const PushType = {
  FCM: 'fcm',
  UNIFIED_PUSH: 'unifiedpush',
  POLLING: 'polling',
};

/**
 * Get random bootstrap node URL
 */
function getRandomBootstrapNode() {
  return BOOTSTRAP_NODES[Math.floor(Math.random() * BOOTSTRAP_NODES.length)];
}

/**
 * Detect available push provider
 * Priority: UnifiedPush > FCM > Polling
 */
export async function detectPushProvider() {
  // Check for UnifiedPush distributor (F-Droid)
  // UnifiedPush distributors register themselves via Intent
  try {
    const unifiedPushEndpoint = await AsyncStorage.getItem('qnet_unified_push_endpoint');
    if (unifiedPushEndpoint) {
      console.log('[Push] Using UnifiedPush:', unifiedPushEndpoint);
      return { type: PushType.UNIFIED_PUSH, endpoint: unifiedPushEndpoint };
    }
  } catch (e) {
    console.log('[Push] UnifiedPush not available');
  }

  // Check for FCM (Google Play Services)
  try {
    const fcmToken = await messaging().getToken();
    if (fcmToken) {
      console.log('[Push] Using FCM');
      return { type: PushType.FCM, token: fcmToken };
    }
  } catch (e) {
    console.log('[Push] FCM not available:', e.message);
  }

  // Fallback to polling
  console.log('[Push] Using Polling fallback');
  return { type: PushType.POLLING };
}

/**
 * Register Light node with detected push provider
 */
export async function registerLightNode(nodeId, walletAddress, quantumPubkey, quantumSignature) {
  const pushProvider = await detectPushProvider();
  const apiUrl = getRandomBootstrapNode();

  const registrationData = {
    node_id: nodeId,
    wallet_address: walletAddress,
    device_id: await getDeviceId(),
    quantum_pubkey: quantumPubkey,
    quantum_signature: quantumSignature,
    push_type: pushProvider.type,
  };

  // Add provider-specific data
  if (pushProvider.type === PushType.FCM) {
    registrationData.device_token = pushProvider.token;
  } else if (pushProvider.type === PushType.UNIFIED_PUSH) {
    registrationData.unified_push_endpoint = pushProvider.endpoint;
  }

  try {
    const response = await fetch(`${apiUrl}/api/v1/light-node/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData),
    });

    const result = await response.json();

    if (result.success) {
      // Store registration info
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({
        nodeId: result.node_id,
        walletAddress,
        pushType: pushProvider.type,
        nextPingTime: result.next_ping_time,
        nextPingWindow: result.next_ping_window,
      }));

      // Setup polling if needed
      if (pushProvider.type === PushType.POLLING) {
        await setupPollingService(result.node_id, result.next_ping_time);
      }

      console.log('[Push] ✅ Light node registered:', result.node_id, 'push:', pushProvider.type);
      return result;
    } else {
      throw new Error(result.error || 'Registration failed');
    }
  } catch (error) {
    console.error('[Push] ❌ Registration failed:', error);
    throw error;
  }
}

/**
 * Get unique device ID
 */
async function getDeviceId() {
  let deviceId = await AsyncStorage.getItem('qnet_device_id');
  if (!deviceId) {
    deviceId = 'device_' + Math.random().toString(36).substr(2, 16);
    await AsyncStorage.setItem('qnet_device_id', deviceId);
  }
  return deviceId;
}

/**
 * Setup polling service for F-Droid users without UnifiedPush
 * ENERGY EFFICIENT: Only wakes up ~2 minutes before scheduled ping (once per 4h window)
 */
async function setupPollingService(nodeId, nextPingTime) {
  // Calculate when to check (2 minutes before expected ping)
  const now = Math.floor(Date.now() / 1000);
  const checkTime = nextPingTime - 120; // 2 minutes before
  const delaySeconds = Math.max(60, checkTime - now);

  console.log('[Polling] Next ping at', new Date(nextPingTime * 1000).toISOString());
  console.log('[Polling] Scheduling wake-up in', Math.round(delaySeconds / 60), 'minutes');

  try {
    // IMPORTANT: We use scheduleTask for PRECISE timing, not periodic fetch
    // This ensures app wakes up ONLY when needed (~once per 4 hours)
    
    // First, configure BackgroundFetch handler (required for scheduleTask to work)
    // NOTE: minimumFetchInterval is set high to prevent unnecessary periodic wakes
    await BackgroundFetch.configure({
      minimumFetchInterval: 240, // 4 hours - matches ping window, prevents extra wakes
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
    }, async (taskId) => {
      // This handler is called for BOTH periodic and scheduled tasks
      console.log('[Polling] Background task triggered:', taskId);
      
      // Check if we're near our ping time (within 5 minutes)
      const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
      if (nodeInfoStr) {
        const nodeInfo = JSON.parse(nodeInfoStr);
        const currentTime = Math.floor(Date.now() / 1000);
        const pingTime = nodeInfo.nextPingTime || 0;
        const timeToPing = pingTime - currentTime;
        
        // Only check challenge if we're within 5 minutes of ping time
        // This prevents wasted API calls from periodic background fetches
        if (timeToPing <= 300 && timeToPing >= -180) {
          console.log('[Polling] Within ping window, checking challenge...');
          await checkPendingChallenge();
        } else {
          console.log('[Polling] Not in ping window (', timeToPing, 'sec to ping), skipping');
        }
      }
      
      BackgroundFetch.finish(taskId);
    }, (taskId) => {
      console.log('[Polling] Task timeout:', taskId);
      BackgroundFetch.finish(taskId);
    });

    // Schedule PRECISE wake-up for this ping
    // This is the PRIMARY mechanism - wakes app exactly when needed
    await BackgroundFetch.scheduleTask({
      taskId: 'qnet-ping-check',
      delay: delaySeconds * 1000,
      periodic: false, // One-time task - will reschedule after ping
      forceAlarmManager: true, // Use AlarmManager for precise timing
      enableHeadless: true,
    });

    console.log('[Polling] ✅ Scheduled precise wake-up for ping');
  } catch (error) {
    console.error('[Polling] ❌ Failed to setup background fetch:', error);
  }
}

/**
 * Check for pending challenge (polling mode)
 */
export async function checkPendingChallenge() {
  try {
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      console.log('[Polling] No node registered');
      return null;
    }

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = getRandomBootstrapNode();

    const response = await fetch(
      `${apiUrl}/api/v1/light-node/pending-challenge?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }
    );

    const result = await response.json();

    if (result.success && result.has_challenge) {
      console.log('[Polling] 📥 Challenge received:', result.challenge);
      
      // Sign and respond
      await respondToChallenge(nodeInfo.nodeId, result.challenge);
      
      return result;
    } else if (result.next_ping_time) {
      // Schedule next check
      await setupPollingService(nodeInfo.nodeId, result.next_ping_time);
    }

    return null;
  } catch (error) {
    console.error('[Polling] ❌ Check failed:', error);
    return null;
  }
}

/**
 * Get next ping time from server
 */
export async function getNextPingTime() {
  try {
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) return null;

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = getRandomBootstrapNode();

    const response = await fetch(
      `${apiUrl}/api/v1/light-node/next-ping?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }
    );

    const result = await response.json();

    if (result.success) {
      // Update stored info
      nodeInfo.nextPingTime = result.next_ping_time;
      nodeInfo.nextPingWindow = result.next_ping_window;
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));

      return result;
    }

    return null;
  } catch (error) {
    console.error('[Push] ❌ Failed to get next ping time:', error);
    return null;
  }
}

/**
 * Respond to ping challenge (sign and send)
 */
export async function respondToChallenge(nodeId, challenge) {
  try {
    const nacl = require('tweetnacl');
    const CryptoJS = require('crypto-js');

    // Load wallet
    const walletDataStr = await AsyncStorage.getItem('qnet_wallet_encrypted');
    if (!walletDataStr) {
      console.error('[Push] No wallet found');
      return false;
    }

    const passwordHash = await AsyncStorage.getItem('qnet_password_hash');
    if (!passwordHash) {
      console.error('[Push] No password hash');
      return false;
    }

    // Decrypt wallet
    const decrypted = CryptoJS.AES.decrypt(walletDataStr, passwordHash);
    const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));

    // Sign challenge with Ed25519
    const challengeBytes = new TextEncoder().encode(challenge);
    const signature = nacl.sign.detached(challengeBytes, new Uint8Array(walletData.secretKey));
    const signatureHex = Buffer.from(signature).toString('hex');

    // Send response
    const apiUrl = getRandomBootstrapNode();
    const response = await fetch(
      `${apiUrl}/api/v1/light-node/ping-response?node_id=${encodeURIComponent(nodeId)}&challenge=${encodeURIComponent(challenge)}&signature=${encodeURIComponent(signatureHex)}`,
      { method: 'GET' }
    );

    const result = await response.json();

    if (result.success) {
      console.log('[Push] ✅ Ping response sent successfully');
      
      // Update next ping time
      await getNextPingTime();
      
      return true;
    } else {
      console.error('[Push] ❌ Ping response failed:', result.error);
      return false;
    }
  } catch (error) {
    console.error('[Push] ❌ Error responding to challenge:', error);
    return false;
  }
}

/**
 * Handle incoming push message (FCM or UnifiedPush)
 */
export async function handlePushMessage(data) {
  if (data?.action === 'ping_response' && data?.challenge && data?.node_id) {
    console.log('[Push] 📥 Ping received:', data.node_id);
    return await respondToChallenge(data.node_id, data.challenge);
  }
  return false;
}

/**
 * Set UnifiedPush endpoint (called from UnifiedPush receiver)
 */
export async function setUnifiedPushEndpoint(endpoint) {
  await AsyncStorage.setItem('qnet_unified_push_endpoint', endpoint);
  console.log('[Push] UnifiedPush endpoint set:', endpoint);
  
  // Re-register with new endpoint
  const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
  if (nodeInfoStr) {
    const nodeInfo = JSON.parse(nodeInfoStr);
    // Trigger re-registration on next app open
    nodeInfo.needsReregistration = true;
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));
  }
}

/**
 * Check Light node status (is active, failure count, etc.)
 */
export async function checkNodeStatus() {
  try {
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      return { registered: false };
    }

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = getRandomBootstrapNode();

    const response = await fetch(
      `${apiUrl}/api/v1/light-node/status?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }
    );

    const result = await response.json();

    if (result.success) {
      // Update local status
      nodeInfo.isActive = result.is_active;
      nodeInfo.consecutiveFailures = result.consecutive_failures;
      nodeInfo.needsReactivation = result.needs_reactivation;
      nodeInfo.nextPingTime = result.next_ping_time;
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));

      return {
        registered: true,
        nodeId: result.node_id,
        isActive: result.is_active,
        consecutiveFailures: result.consecutive_failures,
        lastSeen: result.last_seen,
        pushType: result.push_type,
        hasAttestationCurrentSlot: result.has_attestation_current_slot,
        nextPingTime: result.next_ping_time,
        nextPingWindow: result.next_ping_window,
        needsReactivation: result.needs_reactivation,
      };
    }

    return { registered: false, error: result.error };
  } catch (error) {
    console.error('[Push] ❌ Status check failed:', error);
    return { registered: false, error: error.message };
  }
}

/**
 * Reactivate Light node (called when user clicks "I'm back" button)
 * Returns true if reactivation successful
 */
export async function reactivateNode() {
  try {
    const nacl = require('tweetnacl');
    const CryptoJS = require('crypto-js');

    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      console.error('[Push] No node to reactivate');
      return { success: false, error: 'Node not registered' };
    }

    const nodeInfo = JSON.parse(nodeInfoStr);

    // Load wallet for signing
    const walletDataStr = await AsyncStorage.getItem('qnet_wallet_encrypted');
    if (!walletDataStr) {
      return { success: false, error: 'No wallet found' };
    }

    const passwordHash = await AsyncStorage.getItem('qnet_password_hash');
    if (!passwordHash) {
      return { success: false, error: 'Wallet locked' };
    }

    // Decrypt wallet
    const decrypted = CryptoJS.AES.decrypt(walletDataStr, passwordHash);
    const walletData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));

    // Create reactivation signature
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `reactivate:${nodeInfo.nodeId}:${timestamp}`;
    const messageBytes = new TextEncoder().encode(message);
    
    // Note: For production, this should use Dilithium signature
    // For now using Ed25519 as placeholder
    const signature = nacl.sign.detached(messageBytes, new Uint8Array(walletData.secretKey));
    const signatureHex = Buffer.from(signature).toString('hex');

    const apiUrl = getRandomBootstrapNode();
    const response = await fetch(`${apiUrl}/api/v1/light-node/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: nodeInfo.nodeId,
        wallet_address: nodeInfo.walletAddress,
        signature: signatureHex,
        timestamp: timestamp,
      }),
    });

    const result = await response.json();

    if (result.success) {
      console.log('[Push] ✅ Node reactivated:', result.was_reactivated ? 'yes' : 'already active');
      
      // Update local status
      nodeInfo.isActive = true;
      nodeInfo.needsReactivation = false;
      nodeInfo.consecutiveFailures = 0;
      nodeInfo.nextPingTime = result.next_ping_time;
      nodeInfo.nextPingWindow = result.next_ping_window;
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));

      // Re-setup polling if needed
      if (nodeInfo.pushType === PushType.POLLING && result.next_ping_time) {
        await setupPollingService(nodeInfo.nodeId, result.next_ping_time);
      }

      return {
        success: true,
        wasReactivated: result.was_reactivated,
        nextPingTime: result.next_ping_time,
        message: result.message,
      };
    }

    return { success: false, error: result.error };
  } catch (error) {
    console.error('[Push] ❌ Reactivation failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Initialize push service
 */
export async function initializePushService() {
  const pushProvider = await detectPushProvider();
  console.log('[Push] Initialized with provider:', pushProvider.type);

  // Check if already registered
  const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
  if (nodeInfoStr) {
    const nodeInfo = JSON.parse(nodeInfoStr);
    
    // Setup polling if needed
    if (nodeInfo.pushType === PushType.POLLING) {
      await setupPollingService(nodeInfo.nodeId, nodeInfo.nextPingTime);
    }
  }

  return pushProvider;
}

/**
 * Check Server node (Full/Super/Genesis) status
 * Used for monitoring server nodes from mobile app
 */
export async function checkServerNodeStatus(activationCode, nodeId = null) {
  try {
    const apiUrl = getRandomBootstrapNode();
    
    // GENESIS NODE SUPPORT: Convert Genesis activation code to node_id
    // Genesis codes: QNET-BOOT-000X-STRAP → genesis_node_00X
    let queryParams = '';
    const genesisMatch = activationCode?.match(/^QNET-BOOT-000([1-5])-STRAP$/);
    
    if (genesisMatch) {
      // Genesis node: use node_id format for API query
      const bootstrapId = genesisMatch[1].padStart(3, '0');
      const genesisNodeId = `genesis_node_${bootstrapId}`;
      queryParams = `node_id=${encodeURIComponent(genesisNodeId)}`;
    } else if (activationCode) {
      queryParams = `activation_code=${encodeURIComponent(activationCode)}`;
    } else if (nodeId) {
      queryParams = `node_id=${encodeURIComponent(nodeId)}`;
    } else {
      return { success: false, error: 'activation_code or node_id required' };
    }
    
    const response = await fetch(
      `${apiUrl}/api/v1/node/status?${queryParams}`,
      { method: 'GET' }
    );

    const result = await response.json();

    if (result.success) {
      return {
        success: true,
        nodeId: result.node_id,
        nodeType: result.node_type,
        isOnline: result.is_online,
        lastSeen: result.last_seen,
        lastSeenAgoSeconds: result.last_seen_ago_seconds,
        heartbeatCount: result.heartbeat_count,
        requiredHeartbeats: result.required_heartbeats,
        isRewardEligible: result.is_reward_eligible,
        reputation: result.reputation,
        currentBlockHeight: result.current_block_height,
        needsAttention: result.needs_attention,
        message: result.message,
        // Rewards info (QNC tokens in smallest units)
        pendingRewards: result.pending_rewards,
      };
    }

    return { success: false, error: result.error };
  } catch (error) {
    console.error('[Push] ❌ Server node status check failed:', error);
    return { success: false, error: error.message };
  }
}

// NOTE: WebSocket support can be added later for real-time updates
// For now, server nodes don't need polling - user can pull-to-refresh
// Server handles heartbeats automatically, rewards calculated at end of 4h window

export default {
  // Push provider detection
  PushType,
  detectPushProvider,
  
  // Light node registration and ping handling
  registerLightNode,
  checkPendingChallenge,
  getNextPingTime,
  respondToChallenge,
  handlePushMessage,
  setUnifiedPushEndpoint,
  initializePushService,
  
  // Light node status (for mobile ping system)
  checkNodeStatus,
  reactivateNode,
  
  // Server node status (Full/Super/Genesis - single API call)
  checkServerNodeStatus,
};

