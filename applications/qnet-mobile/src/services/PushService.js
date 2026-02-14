/**
 * QNet Push Service
 * Supports FCM (Google Play), UnifiedPush (F-Droid), and Polling fallback
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import BackgroundFetch from 'react-native-background-fetch';
// v3.35: Centralized node configuration (no duplication!)
import { GENESIS_NODES, getRandomGenesisNode } from '../config/nodes';

// Push types
export const PushType = {
  FCM: 'fcm',
  UNIFIED_PUSH: 'unifiedpush',
  POLLING: 'polling',
};

/**
 * Get random synced node URL (scalable)
 * v3.36: Uses node discovery cache first, falls back to genesis nodes
 * When 100+ server nodes exist, this will select from all synced nodes
 */
async function getRandomBootstrapNodeAsync() {
  try {
    const cachedNodesStr = await AsyncStorage.getItem('qnet_discovered_nodes');
    if (cachedNodesStr) {
      const cachedNodes = JSON.parse(cachedNodesStr);
      const currentTime = Math.floor(Date.now() / 1000);
      const eligible = cachedNodes.filter(n => {
        const age = currentTime - (n.lastSeen || 0);
        return age < 300 && n.reputation >= 0.7 && n.isSynced !== false;
      });
      if (eligible.length > 0) {
        // Weighted random by reputation
        const totalRep = eligible.reduce((sum, n) => sum + (n.reputation || 0.7), 0);
        let random = Math.random() * totalRep;
        for (const node of eligible) {
          random -= (node.reputation || 0.7);
          if (random <= 0) return node.url;
        }
        return eligible[0].url;
      }
    }
  } catch (e) {
    // Ignore cache errors
  }
  // Fallback to genesis (first launch or stale cache)
  return getRandomGenesisNode();
}

// Synchronous version for backward compatibility (returns genesis as fallback)
function getRandomBootstrapNode() {
  return getRandomGenesisNode();
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
  const apiUrl = await getRandomBootstrapNodeAsync();

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
 * MANDATORY: Dilithium3 (ML-DSA-65) quantum signature — no Ed25519 fallback
 */
export async function respondToChallenge(nodeId, challenge) {
  try {
    const CryptoJS = require('crypto-js');

    const passwordHash = await AsyncStorage.getItem('qnet_password_hash');
    if (!passwordHash) {
      console.error('[Push] No password hash');
      return false;
    }

    // MANDATORY: Dilithium3 signature for ping response
    const { getOrCreateDilithiumKeypair, signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
    if (!isDilithiumAvailable()) {
      console.error('[Push] Dilithium3 module required for ping');
      return false;
    }

    const activationState = await AsyncStorage.getItem('qnet_last_activated_node');
    const activationCode = activationState ? JSON.parse(activationState).code : null;
    if (!activationCode) {
      console.error('[Push] No activation code found for ping');
      return false;
    }

    const dilithiumKeys = await getOrCreateDilithiumKeypair(activationCode, passwordHash);
    const formattedSignature = await signWithDilithium(challenge, dilithiumKeys.secretKey, dilithiumKeys.publicKey, nodeId);

    // Send response
    const apiUrl = getRandomBootstrapNode();
    const response = await fetch(
      `${apiUrl}/api/v1/light-node/ping-response?node_id=${encodeURIComponent(nodeId)}&challenge=${encodeURIComponent(challenge)}&signature=${encodeURIComponent(formattedSignature)}`,
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

    // Create reactivation signature with Dilithium3 (ML-DSA-65)
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `reactivate:${nodeInfo.nodeId}:${timestamp}`;

    // MANDATORY: Dilithium3 signature — no Ed25519 fallback
    const { getOrCreateDilithiumKeypair, signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
    if (!isDilithiumAvailable()) {
      return { success: false, error: 'Dilithium3 module required for node reactivation' };
    }

    const activationState = await AsyncStorage.getItem('qnet_last_activated_node');
    const activationCode = activationState ? JSON.parse(activationState).code : null;
    if (!activationCode) {
      return { success: false, error: 'No activation code found for reactivation' };
    }

    const dilithiumKeys = await getOrCreateDilithiumKeypair(activationCode, passwordHash);
    const signatureStr = await signWithDilithium(message, dilithiumKeys.secretKey, dilithiumKeys.publicKey, nodeInfo.nodeId);

    const apiUrl = getRandomBootstrapNode();
    const response = await fetch(`${apiUrl}/api/v1/light-node/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: nodeInfo.nodeId,
        wallet_address: nodeInfo.walletAddress,
        signature: signatureStr,
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
 * Check Server node (Super/Genesis) status
 * Used for monitoring server nodes from mobile app
 * v3.35: Added retry logic with different nodes
 */
export async function checkServerNodeStatus(activationCode, nodeId = null, maxRetries = 3) {
  // GENESIS NODE SUPPORT: Convert Genesis activation code to node_id
  // Genesis codes: QNET-BOOT-001-STRAP → genesis_node_001
  let queryParams = '';
  const genesisMatch = activationCode?.match(/^QNET-BOOT-00([1-5])-STRAP$/);
  
  if (genesisMatch) {
    // Genesis node: use node_id format for API query
    const bootstrapId = genesisMatch[1].padStart(3, '0');
    const genesisNodeId = `genesis_node_${bootstrapId}`;
    console.log(`[Push] Genesis node detected: ${activationCode} → ${genesisNodeId}`);
    queryParams = `node_id=${encodeURIComponent(genesisNodeId)}`;
  } else if (nodeId) {
    // If nodeId is provided directly, use it
    console.log(`[Push] Using provided nodeId: ${nodeId}`);
    queryParams = `node_id=${encodeURIComponent(nodeId)}`;
  } else if (activationCode) {
    queryParams = `activation_code=${encodeURIComponent(activationCode)}`;
  } else {
    return { success: false, error: 'activation_code or node_id required' };
  }
  
  let lastError = null;
  const triedNodes = new Set();
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // v3.35: Get random node, avoid retrying same node
      let apiUrl = getRandomBootstrapNode();
      let retryCount = 0;
      while (triedNodes.has(apiUrl) && retryCount < 5) {
        apiUrl = getRandomBootstrapNode();
        retryCount++;
      }
      triedNodes.add(apiUrl);
      
      const url = `${apiUrl}/api/v1/node/status?${queryParams}`;
      console.log(`[Push] Checking server node status (attempt ${attempt + 1}): ${url}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const response = await fetch(url, { 
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Only Super/Genesis nodes are real nodes
        // Light nodes = regular mobile app users (NOT nodes)
        
        // Required heartbeats for NETWORK LIVENESS (NOT rewards!)
        // This is P2P heartbeat for node health, not transaction validation
        let requiredHeartbeats = result.required_heartbeats;
        if (!requiredHeartbeats && result.node_type === 'super') {
          requiredHeartbeats = 9; // Super nodes: 9/10 (90%) for network liveness
        }
        // NO FALLBACK - if node_type is not 'super', it's invalid
        
        return {
          success: true,
          nodeId: result.node_id,
          nodeType: result.node_type,
          isOnline: result.is_online,
          lastSeen: result.last_seen,
          lastSeenAgoSeconds: result.last_seen_ago_seconds,
          heartbeatCount: result.heartbeat_count || 0,
          requiredHeartbeats: requiredHeartbeats || 9, // Super nodes only
          isRewardEligible: result.is_reward_eligible,
          reputation: result.reputation, // BLOCKCHAIN reputation from DeterministicReputationState
          currentBlockHeight: result.current_block_height,
          needsAttention: result.needs_attention,
          message: result.message,
          // Rewards info (QNC tokens in smallest units)
          pendingRewards: result.pending_rewards,
        };
      }

      return { success: false, error: result.error || 'Unknown error' };
    } catch (error) {
      lastError = error;
      // v3.35: Wait before retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 500));
      }
    }
  }
  
  // All retries failed
  console.warn(`[Push] Server node status failed after ${maxRetries} retries:`, lastError?.message);
  return { success: false, error: lastError?.message || 'Network error' };
}

// NOTE: WebSocket support can be added later for real-time updates
// For now, server nodes don't need polling - user can pull-to-refresh
// Server handles heartbeats automatically, rewards calculated at end of 4h window

/**
 * Get ALL nodes owned by a wallet address (Light, Full, Super, Genesis)
 * Returns unified list for display in mobile app
 * @param {string} walletAddress - EON wallet address
 */
export async function getAllNodesByWallet(walletAddress) {
  try {
    const apiUrl = getRandomBootstrapNode();
    
    // NEW: Call without node_type to get ALL nodes
    const response = await fetch(
      `${apiUrl}/api/v1/activations/by-wallet?wallet_address=${encodeURIComponent(walletAddress)}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    
    if (result.success && result.nodes) {
      console.log(`[Nodes] Found ${result.nodes.length} nodes for wallet`);
      return {
        success: true,
        nodes: result.nodes,
        totalNodes: result.total_nodes || result.nodes.length
      };
    }
    
    return { success: true, nodes: [], totalNodes: 0 };
  } catch (error) {
    // Silent fail - no nodes found is not an error, just return empty
    // Battery optimization: don't spam logs
    return { success: true, nodes: [], totalNodes: 0 };
  }
}

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
  
  // Server node status (Super/Genesis - single API call)
  checkServerNodeStatus,
  
  // Get all nodes by wallet (unified view)
  getAllNodesByWallet,
};

