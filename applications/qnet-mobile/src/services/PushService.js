/**
 * QNet Push Service
 * Supports FCM (Google Play), UnifiedPush (F-Droid), and Polling fallback
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import BackgroundFetch from 'react-native-background-fetch';
import { AppState, Platform } from 'react-native';
// v3.35: Centralized node configuration (no duplication!)
import { GENESIS_NODES, getRandomGenesisNode, lightShardOwnerUrls, publicNodeUrl } from '../config/nodes';

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
let _eligibleUrlSnapshot = []; // in-memory eligible URLs, refreshed by the async picker for the sync one

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
        _eligibleUrlSnapshot = eligible.map(n => n.url); // warm the sync snapshot
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
  return getRandomGenesisNode(); // first launch / stale cache
}

// Sync picker: spread recurring status/reward/ping load across the discovered validator set (not
// pinned to the 5 genesis IPs). Uses the snapshot the async picker warms; genesis only until warm,
// and it kicks a background refresh so the next call is spread.
function getRandomBootstrapNode() {
  if (_eligibleUrlSnapshot.length > 0) {
    return _eligibleUrlSnapshot[Math.floor(Math.random() * _eligibleUrlSnapshot.length)];
  }
  getRandomBootstrapNodeAsync().catch(() => {}); // warm snapshot for subsequent calls
  return getRandomGenesisNode();
}

// RN fetch has no timeout of its own: an unreachable node would hold a call for the OS TCP timeout, past
// the ~30 s iOS gives a background wake. Every network call in this module goes through this cap.
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(0, ms));
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// The promise's value, or `onTimeout` once `deadline` passes first; the promise itself runs on.
function untilDeadline(promise, deadline, onTimeout) {
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

const _selfAttestRounds = new Map(); // node id -> { force, promise } of the round in flight
const _pingLanes = new Map();        // node id -> settles when the last queued answer for it is done

// One ping-response POST at a time per node, whichever path sends it. A queued answer gives up (false) once its
// own deadline leaves less than SELF_ATTEST_MIN_POST_MS; one that gives up keeps its place in the queue.
async function inPingLane(nodeId, deadline, answer) {
  const before = _pingLanes.get(nodeId);
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = before ? before.then(() => mine) : mine;
  _pingLanes.set(nodeId, tail);
  try {
    if (before && !(await untilDeadline(before.then(() => true), deadline - SELF_ATTEST_MIN_POST_MS, false))) return false;
    return await answer();
  } finally {
    release();
    if (_pingLanes.get(nodeId) === tail) _pingLanes.delete(nodeId);
  }
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
export async function registerLightNode(nodeId, walletAddress, quantumPubkey, quantumSignature, burnTxHash = null, burnAmount = null, burnWallet = null, ed25519Signature = null, signatureTimestamp = null, pingPubkey = null, pingDelegationCert = null) {
  const pushProvider = await detectPushProvider();
  const targetUrl = await getRandomBootstrapNodeAsync();

  const registrationData = {
    node_id: nodeId,
    wallet_address: walletAddress,
    device_id: await getDeviceId(),
    quantum_pubkey: quantumPubkey,
    quantum_signature: quantumSignature,
    push_type: pushProvider.type,
  };

  // v4.3: Include burn TX data for STATELESS code ownership verification
  // Node can verify code belongs to wallet WITHOUT any in-memory state:
  // XOR key = SHA3(burn_tx:type:amount) → decrypt wallet prefix from code → compare
  if (burnTxHash) registrationData.burn_tx_hash = burnTxHash;
  if (burnAmount != null) registrationData.burn_amount = burnAmount;
  // v4.6: burn_wallet = Solana address used during code generation (Phase 1)
  // wallet_address = EON (for rewards), burn_wallet = Solana (for XOR verification)
  if (burnWallet) registrationData.burn_wallet = burnWallet;
  // v4.7: Ed25519 signature proving ownership of burn_wallet (Solana key)
  // Prevents stolen code reuse — attacker cannot sign without Solana private key
  if (ed25519Signature) registrationData.ed25519_signature = ed25519Signature;
  if (signatureTimestamp != null) registrationData.signature_timestamp = signatureTimestamp;
  // PING DELEGATION v7.0 (optional — graceful degradation if Keychain unavailable)
  if (pingPubkey)        registrationData.ping_pubkey = pingPubkey;
  if (pingDelegationCert) registrationData.ping_delegation_cert = pingDelegationCert;
  // The chain commits only a hash of this key, so the node cannot look it up: the device carries it
  // and the node checks it against that commitment. Kept here so every later attestation can present
  // it without re-deriving the wallet's key material.
  if (quantumPubkey) { try { await AsyncStorage.setItem(`qnet_identity_pk_${nodeId}`, quantumPubkey); } catch (_) {} }

  // Add provider-specific data
  if (pushProvider.type === PushType.FCM) {
    registrationData.device_token = pushProvider.token;
  } else if (pushProvider.type === PushType.UNIFIED_PUSH) {
    registrationData.unified_push_endpoint = pushProvider.endpoint;
  }

  try {
    console.log('[Push] registering light node wallet=...' + (registrationData.wallet_address || '').slice(-8));
    const response = await fetchWithTimeout(`${targetUrl}/api/v1/light-node/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData),
    }, 15000);

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

      // Seed last-sent token so refresh logic doesn't fire immediately
      if (pushProvider.token) {
        await AsyncStorage.multiSet([
          ['qnet_last_sent_fcm_token', pushProvider.token],
          ['qnet_last_token_refresh_ts', String(Math.floor(Date.now() / 1000))],
        ]);
      }

      // Every push type gets the periodic self-attest; polling phones also get the precise ping wake.
      if (pushProvider.type === PushType.POLLING) {
        await setupPollingService(result.node_id, result.next_ping_time);
      } else {
        await configureBackgroundFetch();
      }

      console.log('[Push] ✅ Light node registered:', result.node_id, 'push:', pushProvider.type);
      return result;
    } else {
      throw new Error(result.error || 'Registration failed');
    }
  } catch (error) {
    console.warn('[Push] Registration failed:', error.message || error);
    throw error;
  }
}

/**
 * Get unique device ID
 */
async function getDeviceId() {
  let deviceId = await AsyncStorage.getItem('qnet_device_id');
  if (!deviceId) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    deviceId = 'device_' + Array.from(bytes).map(b => b.toString(36)).join('').slice(0, 16);
    await AsyncStorage.setItem('qnet_device_id', deviceId);
  }
  return deviceId;
}

/**
 * The one background-wake handler, live and headless (index.js): any wake self-attests (deduped per
 * epoch); a polling phone near its ping slot also pulls the pending challenge. Always finishes the task.
 */
export async function onBackgroundFetch(taskId) {
  // Everything this wake sends shares one deadline inside the ~30 s iOS gives a background fetch.
  const deadline = Date.now() + WAKE_FETCH_MS;
  try {
    console.log('[BackgroundFetch] Task triggered:', taskId);
    await selfAttestIfNeeded(undefined, false, deadline);

    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    const nodeInfo = nodeInfoStr ? JSON.parse(nodeInfoStr) : null;
    if (nodeInfo && nodeInfo.pushType === PushType.POLLING) {
      // Only within [-180, +300] s of the ping time, so periodic wakes cost no challenge call.
      const timeToPing = (nodeInfo.nextPingTime || 0) - Math.floor(Date.now() / 1000);
      if (timeToPing <= 300 && timeToPing >= -180) {
        await checkPendingChallenge(deadline);
      }
    }
  } catch (error) {
    console.warn('[BackgroundFetch] Task failed:', error.message || error);
  } finally {
    BackgroundFetch.finish(taskId);
  }
}

/**
 * Periodic wake for every push type: 30 min leaves several tries per 14,400-block epoch when the OS defers
 * some. From block 1,339,200 a wake sends no self-attestation for up to 2 hours after one (see
 * holdSelfAttest); a later wake in the same epoch costs one /height read, which re-arms the hold. A polling
 * phone within [-180, +300] s of its ping time still pulls the pending challenge.
 */
async function configureBackgroundFetch() {
  try {
    // stopOnTerminate, startOnBoot and enableHeadless are Android options. On iOS the wake is a
    // BGAppRefreshTask: the OS picks the time (at least 15 minutes apart) and never wakes a force-quit app.
    const status = await BackgroundFetch.configure({
      minimumFetchInterval: 30,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
    }, onBackgroundFetch, (taskId) => {
      console.log('[BackgroundFetch] Task timeout:', taskId);
      BackgroundFetch.finish(taskId);
    });
    await recordBackgroundRefreshStatus(status);
  } catch (error) {
    // iOS rejects with the Background App Refresh status itself: 0 restricted, 1 turned off.
    if (typeof error === 'number') await recordBackgroundRefreshStatus(error);
    console.warn('[BackgroundFetch] Configure failed:', (error && error.message) || error);
  }
}

// The last Background App Refresh status configure reported (2 = available), read by the node tab.
export const BG_REFRESH_STATUS_KEY = 'qnet_bg_refresh_status';
async function recordBackgroundRefreshStatus(status) {
  if (typeof status !== 'number') return;
  try { await AsyncStorage.setItem(BG_REFRESH_STATUS_KEY, String(status)); } catch (_) { /* best effort */ }
}

/**
 * Polling phones (no FCM, no UnifiedPush): the periodic wake, and on Android a precise one-shot wake ~2
 * minutes before the ping slot.
 */
async function setupPollingService(nodeId, nextPingTime) {
  // Calculate when to check (2 minutes before expected ping)
  const now = Math.floor(Date.now() / 1000);
  const checkTime = nextPingTime - 120; // 2 minutes before
  const delaySeconds = Math.max(60, checkTime - now);

  console.log('[Polling] Next ping at', new Date(nextPingTime * 1000).toISOString());
  console.log('[Polling] Scheduling wake-up in', Math.round(delaySeconds / 60), 'minutes');

  try {
    // Configured first: the one-shot wake is delivered to the same handler as the periodic fetch.
    await configureBackgroundFetch();

    // Android: a precise one-shot wake for this ping (AlarmManager). iOS has no precise wake: a polling
    // iPhone relies on the periodic wake and on opening the app.
    if (Platform.OS === 'android') {
      await BackgroundFetch.scheduleTask({
        taskId: 'qnet-ping-check',
        delay: delaySeconds * 1000,
        periodic: false, // One-time task - will reschedule after ping
        forceAlarmManager: true, // Use AlarmManager for precise timing
        enableHeadless: true,
      });
      console.log('[Polling] ✅ Scheduled precise wake-up for ping');
    }
  } catch (error) {
    console.warn('[Polling] Failed to setup background fetch:', error.message || error);
  }
}

/**
 * Check for pending challenge (polling mode)
 */
export async function checkPendingChallenge(deadline = Date.now() + WAKE_FETCH_MS) {
  try {
    if (deadline - Date.now() < SELF_ATTEST_MIN_POST_MS) return null;
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      console.log('[Polling] No node registered');
      return null;
    }

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = getRandomBootstrapNode();

    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/light-node/pending-challenge?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }, Math.min(6000, deadline - Date.now())
    );

    const result = await response.json();

    if (result.success && result.has_challenge) {
      console.log('[Polling] 📥 Challenge received:', result.challenge);
      
      // Respond to the node that ISSUED the challenge. The stamp is a MAC keyed by that node's
      // own seed, so any other node rejects it as unrecognized — and with 5 bootstrap nodes an
      // independent second draw matched only 1 time in 5. The push and self-attest paths already
      // pass their URL through; this one dropped it.
      await respondToChallenge(nodeInfo.nodeId, result.challenge, apiUrl, deadline);
      
      return result;
    } else if (result.next_ping_time) {
      // Schedule next check
      await setupPollingService(nodeInfo.nodeId, result.next_ping_time);
    }

    return null;
  } catch (error) {
    console.warn('[Polling] Check failed:', error.message || error);
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

    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/light-node/next-ping?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }, 5000
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
    console.warn('[Push] Failed to get next ping time:', error.message || error);
    return null;
  }
}

/**
 * Respond to ping challenge (sign and send)
 * MANDATORY: Dilithium3 (ML-DSA-65) quantum signature — no Ed25519 fallback
 */
export async function respondToChallenge(nodeId, challenge, responseUrl, deadline = Date.now() + RESPONSE_MS) {
  try {
    const pingNodeId = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
    if (!pingNodeId) {
      console.warn('[Push] Dilithium3 ping key unavailable — ping missed (will retry next window)');
      return false;
    }
    // One answer at a time per node, whichever path sends it; the wait comes out of this caller's deadline.
    return await inPingLane(pingNodeId, deadline, () => answerChallenge(pingNodeId, challenge, responseUrl, deadline));
  } catch (error) {
    console.warn('[Push] Error responding to challenge:', error.message || error);
    return false;
  }
}

async function answerChallenge(pingNodeId, challenge, responseUrl, deadline) {
  try {
    const Keychain = require('react-native-keychain');

    // ── PATH A: ML-DSA-65 ping delegation key (v7.1) — background-safe ──────
    // Loads ML-DSA-65 ping secret key from Keychain (AFTER_FIRST_UNLOCK).
    // No password needed. Full quantum safety for ping responses.
    {
      try {
        const keychainEntry = await Keychain.getGenericPassword({
          service: `qnet_ping_sk_${pingNodeId}`,
        });
        if (keychainEntry && keychainEntry.password) {
          const { signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
          if (isDilithiumAvailable()) {
            const pingSkHex = keychainEntry.password;
            const pingPkHex = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${pingNodeId}`);
            if (pingPkHex) {
              const dilithiumSig = await signWithDilithium(challenge, pingSkHex, pingPkHex, pingNodeId);
              const formattedSignature = `ping_dilithium:${dilithiumSig}`;
              // Present the ping delegation so the genesis verifies it against our committed on-chain key and
              // refreshes its ping-key store — overwrites any pre-registration gossip poison. Optional/graceful.
              const pingCert = await AsyncStorage.getItem(`qnet_ping_cert_${pingNodeId}`);
              // Presented so the node can verify the delegation against the hash the chain committed.
              const identityPk = await AsyncStorage.getItem(`qnet_identity_pk_${pingNodeId}`);

              // The ping names the node to answer, by address; the answer goes to that node's public name.
              const apiUrl = publicNodeUrl(responseUrl) || await getRandomBootstrapNodeAsync();
              // Capped after the Keychain read and the signing, which take their own share of the wake.
              const timeoutMs = Math.min(RESPONSE_MS, deadline - Date.now());
              if (timeoutMs < SELF_ATTEST_MIN_POST_MS) return false;
              const response = await fetchWithTimeout(
                `${apiUrl}/api/v1/light-node/ping-response`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    node_id: pingNodeId,
                    challenge,
                    signature: formattedSignature,
                    ...(pingPkHex ? { ping_pubkey: pingPkHex } : {}),
                    ...(pingCert ? { ping_delegation_cert: pingCert } : {}),
                    ...(identityPk ? { identity_pubkey: identityPk } : {}),
                  }),
                },
                timeoutMs
              );
              const result = await response.json();
              if (result.success) {
                console.log('[Push] ✅ Ping response sent (Dilithium3 delegation, quantum-safe)');
                // Not awaited: a background wake spends its time on the proof, not on the display refresh.
                getNextPingTime().catch(() => {});
                return true;
              }
              console.warn('[Push] Dilithium3 delegation ping rejected:', result.error);
            }
          }
        }
      } catch (keychainErr) {
        if (keychainErr.message && !keychainErr.message.includes('no item')) {
          console.warn('[Push] Keychain unavailable for ping:', keychainErr.message);
        }
      }
    }

    // PATH A is the only signing path — Keychain ping delegation key (ML-DSA-65).
    // No fallback: if Keychain is unavailable the ping is missed and will be retried
    // on the next ping window. The node is NOT penalised for a single missed ping.
    console.warn('[Push] Dilithium3 ping key unavailable — ping missed (will retry next window)');
    return false;
  } catch (error) {
    console.warn('[Push] Error responding to challenge:', error.message || error);
    return false;
  }
}

const SELF_ATTEST_HOLD_KEY = 'qnet_self_attest_hold';
// From this height a block is never stamped ahead of the wall clock, so an epoch cannot end sooner than
// one second per block still left in it.
const WALL_CLOCK_BOUND_HEIGHT = 1339200;

// No hold outlasts this: the node that answered the height may lag the chain, and a device clock can move.
const SELF_ATTEST_MAX_HOLD_MS = 2 * 3600000;

// After an attestation: hold until the epoch can have ended, counted from when the height was read and
// only where that bound holds. After a failure: back off 30 minutes, doubling, so a refused device does
// not re-sign on every wake. Either way at most SELF_ATTEST_MAX_HOLD_MS.
async function holdSelfAttest(nodeId, height, ok, readAt) {
  try {
    const prev = JSON.parse((await AsyncStorage.getItem(SELF_ATTEST_HOLD_KEY)) || 'null');
    const failures = ok ? 0 : ((prev && prev.nodeId === nodeId && prev.failures) || 0) + 1;
    const until = ok
      ? (height >= WALL_CLOCK_BOUND_HEIGHT ? readAt + Math.min((14400 - (height % 14400)) * 1000, SELF_ATTEST_MAX_HOLD_MS) : 0)
      : Date.now() + Math.min(30 * 60000 * Math.pow(2, failures - 1), SELF_ATTEST_MAX_HOLD_MS);
    await AsyncStorage.setItem(SELF_ATTEST_HOLD_KEY, JSON.stringify({ nodeId, at: Date.now(), until, failures }));
  } catch (_) { /* best effort */ }
}

// A background wake gets about 30 s on iOS (25 s for a push handled by React Native Firebase). Each wake sets
// one deadline inside that for everything it sends; a self-attest round also stays within its own budget,
// each request capped inside it.
const WAKE_FETCH_MS = 25000;
const WAKE_PUSH_MS = 22000;
const RESPONSE_MS = 8000;
const SELF_ATTEST_BUDGET_MS = 20000;
const SELF_ATTEST_CALL_MS = 6000;
const SELF_ATTEST_MIN_POST_MS = 2000; // no answer is started with less time than this left

/**
 * PULL self-attestation: sign a fresh same-epoch block hash and submit through the standard
 * ping-response endpoint (challenge = "selfattest:{height}:{hash}"). Proves this-epoch liveness
 * on ANY wakeup (push, background fetch, app open or return) — no dependency on FCM delivery.
 * Deduped per epoch locally; the node dedupes per epoch too. Rounds are per node: concurrent callers (a push
 * launch also mounts the app) share one, each within its own deadline; "I'm Back" (force) reruns only behind
 * a round that did not attest.
 */
export async function selfAttestIfNeeded(nodeId, force = false, wakeDeadline = undefined) {
  const deadline = Math.min(Date.now() + SELF_ATTEST_BUDGET_MS, wakeDeadline || Infinity);
  const id = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
  if (!id) return false;
  for (let running = _selfAttestRounds.get(id); running; running = _selfAttestRounds.get(id)) {
    const r = await untilDeadline(running.promise, deadline, null);
    if (r === null) return false;               // this caller's deadline came first; the round runs on
    if (r || !force || running.force) return r; // only a forced caller behind a round that did not attest goes on
  }
  const round = { force, promise: null };
  round.promise = runSelfAttest(id, force, deadline)
    .finally(() => { if (_selfAttestRounds.get(id) === round) _selfAttestRounds.delete(id); });
  _selfAttestRounds.set(id, round);
  return round.promise;
}

async function runSelfAttest(nodeId, force, deadline) {
  const cap = () => Math.min(SELF_ATTEST_CALL_MS, deadline - Date.now());
  const callDeadline = () => Math.min(deadline, Date.now() + SELF_ATTEST_CALL_MS);
  try {
    const pingNodeId = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
    if (!pingNodeId) return false;
    // No request while the attested epoch cannot have ended, or while a failed attempt backs off. A hold
    // written before the clock moved back, or longer than any hold is written for, is void.
    const hold = force ? null : JSON.parse((await AsyncStorage.getItem(SELF_ATTEST_HOLD_KEY)) || 'null');
    const now = Date.now();
    if (hold && hold.nodeId === pingNodeId && now < hold.until && now >= (hold.at || 0)
        && hold.until - now <= SELF_ATTEST_MAX_HOLD_MS) return false;
    const apiUrl = await getRandomBootstrapNodeAsync();
    const hr = await fetchWithTimeout(`${apiUrl}/api/v1/height`, {}, cap());
    const { height } = await hr.json();
    const readAt = Date.now();
    if (!height || height < 3) return false;
    const epoch = Math.floor(height / 14400);
    const last = await AsyncStorage.getItem('qnet_last_self_attest_epoch');
    // force = user pressed "I'm Back" — re-attest even if already done this epoch (B: attestation IS reactivation).
    if (!force && last !== null && parseInt(last, 10) === epoch) {
      await holdSelfAttest(pingNodeId, height, true, readAt);
      return false;
    }
    // Registration gate: don't attest before the node's on-chain key is committed — a ping is only
    // accepted once load_vrf_public_key(node_id) is present (else rejected no_onchain_key /
    // ping_dilithium_node_not_found). onChainRegistered mirrors that exact server condition and is
    // node-independent (a committed key is uniform across storage), unlike RAM-registry presence.
    // Skip ONLY on a DEFINITIVE on-chain false; proceed when true, when the field is absent (older
    // node — preserve prior behavior) or on a transient error, so a live node never misses its window.
    const reg = await checkNodeStatus({ timeoutMs: cap(), withHeight: false });
    if (reg && reg.onChainRegistered === false) return false;
    // Canonical hash of block `anchor` = previous_hash of block anchor+1 (the chain link).
    const anchor = height - 2;
    const br = await fetchWithTimeout(`${apiUrl}/api/v1/microblock/${anchor + 1}`, {}, cap());
    const block = await br.json();
    if (!Array.isArray(block?.previous_hash)) return false;
    // Server-supplied bytes: reject any non-integer / out-of-[0,255] element so a
    // malformed array can't produce a garbage hash (e.g. "nan") or a bad challenge.
    const phBytes = block.previous_hash;
    if (!phBytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return false;
    const hash = phBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    // Send it to the nodes that OWN this shard, not to whichever node answered the height query.
    // The owner is what records eligibility and commits the epoch bitmap; anywhere else the answer
    // has to be relayed to it, and the relay carries the signature without the ping key it was signed
    // with — so a device that rotated its key (every reinstall does) attests into a void. All three
    // owners are tried, which is also what makes one owner being down survivable.
    const challenge = `selfattest:${anchor}:${hash}`;
    let ok = false;
    for (const ownerUrl of lightShardOwnerUrls(pingNodeId)) {
      if (cap() < SELF_ATTEST_MIN_POST_MS) break;
      if (await respondToChallenge(pingNodeId, challenge, ownerUrl, callDeadline())) { ok = true; break; }
    }
    // Last resort: the node we already know answers. Better a relayed attestation than none.
    if (!ok && cap() >= SELF_ATTEST_MIN_POST_MS) ok = await respondToChallenge(pingNodeId, challenge, apiUrl, callDeadline());
    if (ok) {
      await AsyncStorage.setItem('qnet_last_self_attest_epoch', String(epoch));
      console.log('[SelfAttest] ✅ Attested for epoch', epoch);
    }
    await holdSelfAttest(pingNodeId, height, ok, readAt);
    return ok;
  } catch (error) {
    console.warn('[SelfAttest] failed:', error.message || error);
    return false;
  }
}

/**
 * Fully tear down the light-node attestation identity + background task.
 * MUST be called on wallet delete: otherwise the scheduled `qnet-ping-check` wake, the periodic
 * background-fetch handler, and the surviving ping key keep the "deleted" device attesting (and
 * earning eligibility) for another epoch or two, and leave the Dilithium ping secret key on device.
 */
export async function teardownLightNode() {
  try {
    const pingNodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    // Stop the precise scheduled wake AND the periodic configured fetch (both call selfAttest).
    try { await BackgroundFetch.stop('qnet-ping-check'); } catch (e) {}
    try { await BackgroundFetch.stop(); } catch (e) {}
    if (pingNodeId) {
      // Wipe the Dilithium ping signing key (Keychain secret + its public half).
      try {
        const Keychain = require('react-native-keychain');
        await Keychain.resetGenericPassword({ service: `qnet_ping_sk_${pingNodeId}` });
      } catch (e) {}
      await AsyncStorage.removeItem(`qnet_ping_dilithium_pk_${pingNodeId}`);
      await AsyncStorage.removeItem(`qnet_ping_cert_${pingNodeId}`);
    }
    await AsyncStorage.multiRemove([
      'qnet_light_node_info',
      'qnet_ping_node_id',
      'qnet_last_self_attest_epoch',
      SELF_ATTEST_HOLD_KEY,
    ]);
    console.log('[LightNode] teardown complete: attestation stopped, ping key wiped');
  } catch (error) {
    console.warn('[LightNode] teardown failed:', error.message || error);
  }
}

/**
 * Handle incoming push message (FCM or UnifiedPush)
 */
export async function handlePushMessage(data) {
  // The answer and a fallback self-attest share one deadline inside the 25 s a background push gets.
  const deadline = Date.now() + WAKE_PUSH_MS;
  if (data?.action === 'ping_response' && data?.challenge && data?.node_id) {
    console.log('[Push] 📥 Ping received:', data.node_id, 'from:', data.response_url || 'random');
    const ok = await respondToChallenge(data.node_id, data.challenge, data.response_url,
                                        Math.min(deadline, Date.now() + RESPONSE_MS));
    // A late (expired stamp) or refused ping still leaves this epoch provable by a self-attest.
    return ok || await selfAttestIfNeeded(data.node_id, false, deadline);
  }
  // Any other wakeup still proves liveness for this epoch.
  return await selfAttestIfNeeded(data?.node_id, false, deadline);
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
 * Check Light node status. B: needs_reactivation is derived on-chain (committed attestation recency),
 * node-independent — a single fetch to ANY node is authoritative (no fan-out / optimistic window).
 */
export async function checkNodeStatus({ timeoutMs = 6000, withHeight = true } = {}) {
  // The server's verdict only when the reply carries one: a rate-limit or error reply has no field, and
  // reading it as false would claim the chain has no such node.
  const onChainOf = (r) => ((r && typeof r.onchain_registered === 'boolean') ? r.onchain_registered : null);
  try {
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      return { registered: false };
    }

    const nodeInfo = JSON.parse(nodeInfoStr);
    const nodeId = nodeInfo.nodeId;
    const apiUrl = await getRandomBootstrapNodeAsync();

    // RN fetch has NO default timeout: a slow/unreachable bootstrap node (e.g. during a fresh-genesis
    // relaunch before nodes are up) would hang this call for the OS TCP timeout, sticking the UI on
    // "Checking…"/"Connecting…" indefinitely. Abort each request on a short budget so the status
    // resolves fast (and falls to the error branch → the Activate button stays actionable).
    let result = null;
    let fetchErr = null;
    try {
      const r = await fetchWithTimeout(`${apiUrl}/api/v1/light-node/status?node_id=${encodeURIComponent(nodeId)}`, { method: 'GET' }, timeoutMs);
      result = await r.json();
    } catch (e) { fetchErr = e; }

    // Block height for the "Next Rewards" display (secondary — shorter budget; the attest path skips it).
    let currentBlockHeight = 0;
    if (withHeight) {
      try {
        const heightResp = await fetchWithTimeout(`${apiUrl}/api/v1/status`, { method: 'GET' }, 4000);
        if (heightResp.ok) {
          const heightData = await heightResp.json();
          currentBlockHeight = heightData.height || heightData.current_height || 0;
        }
      } catch (_) {}
    }

    if (!result || !result.success) {
      // Distinguish a transport failure (result null) from a real success:false verdict: on a network hiccup
      // return a TRUTHY error so the UI shows the neutral 'Checking…' state, never a false 'Not Activated'.
      // onChainRegistered must stay UNKNOWN (null) on a transient failure — a definitive `false` here makes
      // selfAttestIfNeeded's `onChainRegistered === false` gate SKIP the epoch attestation on a mere network
      // hiccup (a live node would miss its window). Emit a real boolean ONLY when the reply carries the field.
      return { registered: false,
               error: result ? result.error : ((fetchErr && (fetchErr.message || 'unreachable')) || 'unreachable'),
               onChainRegistered: onChainOf(result), currentBlockHeight };
    }

    const needsReactivation = result.needs_reactivation === true;
    nodeInfo.isActive = !needsReactivation;
    nodeInfo.needsReactivation = needsReactivation;
    nodeInfo.nextPingTime = result.next_ping_time;
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));

    return {
      registered: true,
      nodeId,
      isActive: !needsReactivation,
      hasAttestationCurrentSlot: result.has_attestation_current_slot === true,
      nextPingTime: result.next_ping_time,
      nextPingWindow: result.next_ping_window,
      needsReactivation,
      currentBlockHeight,
      onChainRegistered: onChainOf(result),
    };
  } catch (error) {
    console.warn('[Push] Status check failed:', error.message || error);
    return { registered: false, error: error.message };
  }
}

// ─── FCM Token Refresh ───────────────────────────────────────────────
// Lightweight Ed25519-signed token update — works without Dilithium.
// Called on: AppState→active (if token changed), after reactivation,
// or when `needsTokenRefresh` flag is set by onTokenRefresh callback.
// Debounced: max 1 HTTP call per hour. Skips if token is unchanged.

const TOKEN_REFRESH_DEBOUNCE_SEC = 3600; // 1 hour

/**
 * Refresh FCM token on all genesis nodes (via a single endpoint).
 * Auth is rooted in the Dilithium3 ping-delegation key (same key path as ping
 * responses / reactivation), NOT the Ed25519 gossip key. Background-safe:
 * the ping SK lives in Keychain (AFTER_FIRST_UNLOCK), so no wallet unlock needed.
 * @param {string} nodeId — light-node pseudonym
 * @returns {{ success, updated, reason? }}
 */
export async function refreshFcmTokenOnServer(nodeId) {
  try {
    if (!nodeId) {
      return { success: false, error: 'missing_params' };
    }

    const pushProvider = await detectPushProvider();
    const currentToken = pushProvider.token;
    if (!currentToken) {
      return { success: true, updated: false, reason: 'no_fcm_token' };
    }

    // Skip if token unchanged since last successful refresh
    const lastSent = await AsyncStorage.getItem('qnet_last_sent_fcm_token');
    if (lastSent === currentToken) {
      await AsyncStorage.setItem('qnet_needs_token_refresh', 'false');
      return { success: true, updated: false, reason: 'unchanged' };
    }

    // Debounce: max 1 call per hour
    const lastRefreshStr = await AsyncStorage.getItem('qnet_last_token_refresh_ts');
    const now = Math.floor(Date.now() / 1000);
    if (lastRefreshStr && (now - parseInt(lastRefreshStr, 10)) < TOKEN_REFRESH_DEBOUNCE_SEC) {
      return { success: true, updated: false, reason: 'debounced' };
    }

    // ML-DSA-65 ping-delegation signature: "token_refresh:{node_id}:{timestamp}".
    // Load ping SK from Keychain + ping PK from AsyncStorage (same path as selfAttestIfNeeded).
    const { signWithDilithium, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
    if (!isDilithiumAvailable()) {
      return { success: false, error: 'Dilithium3 module required for token refresh' };
    }
    const Keychain = require('react-native-keychain');
    const keychainEntry = await Keychain.getGenericPassword({
      service: `qnet_ping_sk_${nodeId}`,
    });
    if (!keychainEntry || !keychainEntry.password) {
      return { success: false, error: 'Ping delegation key unavailable' };
    }
    const pingSkHex = keychainEntry.password;
    const pingPkHex = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${nodeId}`);
    if (!pingPkHex) {
      return { success: false, error: 'Ping public key not found' };
    }

    const timestamp = now;
    const message = `token_refresh:${nodeId}:${timestamp}`;
    const dilithiumSig = await signWithDilithium(message, pingSkHex, pingPkHex, nodeId);
    const signatureStr = `ping_dilithium:${dilithiumSig}`;

    const body = JSON.stringify({
      node_id: nodeId,
      device_token: currentToken,
      push_type: pushProvider.type,
      endpoint: pushProvider.endpoint || undefined,
      signature: signatureStr,
      timestamp,
    });
    const postRefresh = async (apiUrl) => {
      try {
        const response = await fetchWithTimeout(`${apiUrl}/api/v1/light-node/token-refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }, 10000);
        return await response.json();
      } catch (e) {
        return { success: false, error: e.message };
      }
    };
    // Only a node that took this device's ping replies holds its identity: the shard owners. Try them in
    // rank order, and a random node only when every owner fails.
    let result = { success: false };
    for (const ownerUrl of lightShardOwnerUrls(nodeId)) {
      result = await postRefresh(ownerUrl);
      if (result.success) break;
    }
    if (!result.success) result = await postRefresh(await getRandomBootstrapNodeAsync());
    if (result.success) {
      await AsyncStorage.multiSet([
        ['qnet_last_sent_fcm_token', currentToken],
        ['qnet_last_token_refresh_ts', String(now)],
        ['qnet_needs_token_refresh', 'false'],
      ]);
      if (result.updated) {
        console.log('[Push] ✅ FCM token refreshed on server');
      }
    }
    return result;
  } catch (error) {
    console.warn('[Push] Token refresh failed:', error.message || error);
    return { success: false, error: error.message };
  }
}

/**
 * Background-safe FCM token refresh (v7.1).
 * Called from onTokenRefresh — refreshFcmTokenOnServer now signs with the
 * Dilithium3 ping-delegation key (Keychain AFTER_FIRST_UNLOCK), so the refresh
 * works without the wallet being unlocked. No gossip-key load here.
 */
export async function backgroundRefreshFcmToken() {
  try {
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    if (!nodeId) return;

    await refreshFcmTokenOnServer(nodeId);
    console.log('[Push] ✅ FCM token refreshed in background');
  } catch (e) {
    console.warn('[Push] Background token refresh failed (will retry on foreground):', e.message);
  }
}

/**
 * Check if FCM token refresh is pending (set by onTokenRefresh callback).
 * Returns true if the stored token differs from the last-sent token,
 * or if the needsTokenRefresh flag is explicitly set.
 */
export async function isTokenRefreshNeeded() {
  try {
    const flag = await AsyncStorage.getItem('qnet_needs_token_refresh');
    if (flag === 'true') return true;

    // Also compare current FCM token with last-sent
    const lastSent = await AsyncStorage.getItem('qnet_last_sent_fcm_token');
    if (!lastSent) return true; // never sent — first refresh after registration

    const pushProvider = await detectPushProvider();
    return pushProvider.token && pushProvider.token !== lastSent;
  } catch {
    return false;
  }
}


let _resumeAttest = null; // the AppState subscription, registered once per process

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

    // Every push type gets the periodic self-attest; polling phones also get the precise ping wake.
    if (nodeInfo.pushType === PushType.POLLING) {
      await setupPollingService(nodeInfo.nodeId, nodeInfo.nextPingTime);
    } else {
      await configureBackgroundFetch();
    }

    // PULL: app open is a wakeup — attest for this epoch if not yet done (deduped inside).
    selfAttestIfNeeded(nodeInfo.nodeId).catch(() => {});
  }

  // Returning to the app is a wake too, a locked wallet included (the ping key needs no password). The
  // self-attest hold keeps repeated returns from sending anything.
  if (!_resumeAttest) {
    _resumeAttest = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      // The user may have changed Background App Refresh in Settings meanwhile.
      BackgroundFetch.status().then(recordBackgroundRefreshStatus).catch(() => {});
      AsyncStorage.getItem('qnet_light_node_info')
        .then((s) => { const info = s ? JSON.parse(s) : null; return info && info.nodeId ? selfAttestIfNeeded(info.nodeId) : false; })
        .catch(() => {});
    });
  }

  return pushProvider;
}

/**
 * Check Server node (Super/Genesis) status
 * Used for monitoring server nodes from mobile app
 * v3.35: Added retry logic with different nodes
 */
export async function checkServerNodeStatus(activationCode, nodeId = null, walletAddress = null, maxRetries = 3) {
  // GENESIS NODE SUPPORT: Convert Genesis activation code to node_id
  // Genesis codes: QNET-BOOT-001-STRAP → genesis_node_001
  let queryParams = '';
  let walletHeader = null; // wallet sent via X-QNet-Wallet header, never the URL
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
  } else if (walletAddress) {
    // Wallet-bridge: resolve the node on-chain by wallet (works for server-activated supers and
    // offline/banned nodes — no dependence on the RAM activation registry that misses them).
    // Privacy: the wallet goes in the X-QNet-Wallet header, NOT the URL (see fetch below).
    walletHeader = walletAddress;
  } else if (activationCode) {
    queryParams = `activation_code=${encodeURIComponent(activationCode)}`;
  } else {
    return { success: false, error: 'node_id, wallet, or activation_code required' };
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
      
      const url = queryParams
        ? `${apiUrl}/api/v1/node/status?${queryParams}`
        : `${apiUrl}/api/v1/node/status`;
      console.log(`[Push] Checking server node status (attempt ${attempt + 1}): ${url}`);

      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: walletHeader ? { 'X-QNet-Wallet': walletHeader } : undefined,
      }, 8000);
      
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
          // TODO(trustless): pending_rewards is an UNPROVEN /node/status value (a
          // malicious node can inflate it). To make it MITM-proof, source it from the
          // QC-certified account path: extend the /balance/proof endpoint to return
          // pending_rewards and fold it into the merkle leaf (verifyMerkleProof already
          // hashes a pending_rewards slot, currently pinned 0), then gate the displayed
          // figure on QcLightClient.verifyMacroblockStateRoot like the balance. Node-side
          // change required; out of scope for this light-client module.
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
    
    // NEW: Call without node_type to get ALL nodes. Wallet via header, not the URL (privacy).
    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/activations/by-wallet`,
      { method: 'GET', headers: { 'X-QNet-Wallet': walletAddress } }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    
    if (result.success && result.nodes) {
      // CRITICAL: Filter out pending_activation and HASH-only entries
      // These are NOT real activated nodes — just code generation records
      const realNodes = result.nodes.filter(n => 
        n.status !== 'pending_activation' && 
        !(n.activation_code && typeof n.activation_code === 'string' && n.activation_code.startsWith('HASH:'))
      );
      console.log(`[Nodes] Found ${realNodes.length} real nodes for wallet (${result.nodes.length} total incl pending)`);
      return {
        success: true,
        nodes: realNodes,
        totalNodes: realNodes.length
      };
    }
    
    // The node answered but did not answer with a node list: unknown, not "this wallet owns nothing".
    // Reported as success it collapsed the node view exactly like the HTTP failure below.
    if (result && result.success === false) {
      return { success: false, nodes: [], totalNodes: 0, error: result.error || 'node returned success:false' };
    }
    return { success: true, nodes: [], totalNodes: 0 };
  } catch (error) {
    // Distinguish a network/HTTP failure from a genuinely empty wallet: a failed
    // lookup must NOT read as "no nodes" (that collapses the node view on a transient
    // hiccup). success:false → the caller keeps its last-known node state.
    return { success: false, nodes: [], totalNodes: 0, error: error.message };
  }
}

/**
 * Claimable reward total for a node from the dedicated, STATUS-INDEPENDENT endpoint.
 * Reads the merkle reward-root claimable (the real lazy reward) by node_id — returns the true accrued
 * amount whether the node is online, offline, or banned. Use this for "Pending Rewards", NOT the
 * node-status response (which derives 0 from a failed status lookup).
 */
export async function getPendingRewards(nodeId) {
  try {
    const apiUrl = getRandomBootstrapNode();
    const response = await fetchWithTimeout(`${apiUrl}/api/v1/rewards/pending/${encodeURIComponent(nodeId)}`, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const r = await response.json();
    return {
      success: true,
      // Base units (nanoQNC) so the UI's /1e9 display + claim gating match /node/status semantics.
      pendingRewards: (r.pending_rewards_nano != null) ? r.pending_rewards_nano : Math.round((r.pending_rewards || 0) * 1e9),
      isClaimable: !!r.is_claimable,
      isEligible: !!r.is_eligible,
      currentEpoch: r.current_epoch,
      heartbeats: r.heartbeats,
    };
  } catch (error) {
    return { success: false, error: error.message };
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
  selfAttestIfNeeded,
  handlePushMessage,
  setUnifiedPushEndpoint,
  initializePushService,
  
  // Light node status (for mobile ping system)
  checkNodeStatus,

  // FCM token refresh (automatic, Ed25519-signed)
  refreshFcmTokenOnServer,
  isTokenRefreshNeeded,
  backgroundRefreshFcmToken,
  
  // Server node status (Super/Genesis - single API call)
  checkServerNodeStatus,
  
  // Get all nodes by wallet (unified view)
  getAllNodesByWallet,

  // Status-independent claimable rewards by node_id
  getPendingRewards,
};

