// Why the network did not take a binding of this device (light-node-messages section 8), in the words the Node tab and
// the QNet Link sheet share.
import { clock } from './timeText';

const REFUSAL_TEXT = {
  device_unsupported: 'node_cant_run',
  device_desktop: 'node_cant_run',
  device_emulator: 'node_cant_run',
  device_not_genuine: 'node_cant_run_now',
  device_compromised: 'node_cant_run_now',
  device_app_unrecognized: 'node_cant_run_now',
  device_unlicensed: 'node_cant_run_now',
  device_key_in_use: 'node_cant_run_now',
  device_slot_paused: 'node_cant_run_now',
  device_secondary_user: 'node_main_profile',
  identity_mismatch: 'node_use_err_key',
  bad_signature: 'node_use_err_key',
  not_registered: 'node_none',
  rate_limited: 'node_use_err_limit',
  device_rate_limited: 'node_use_err_limit',
  // The binding's time is off the network's clock (light_binding.rs Expired, FutureSeq): a retry never mends it.
  expired: 'node_use_err_clock',
  future_seq: 'node_use_err_clock',
};

/**
 * Why the network refused a binding of this device (`refusal`: { reason, retryAfterSeconds }): a limit with the time it
 * ends when the node names it, a clock that is off, a device that cannot run the node (any other device refusal: not
 * right now). null for a reason with no text of its own.
 */
export function reasonText(t, refusal, now = Date.now()) {
  const reason = refusal && typeof refusal.reason === 'string' ? refusal.reason : '';
  const key = (Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, reason) ? REFUSAL_TEXT[reason] : null)
    || (reason.startsWith('device_') ? 'node_cant_run_now' : null);
  if (!key) return null;
  if (key === 'node_use_err_limit' && refusal.retryAfterSeconds) {
    return t('node_move_limit', { time: clock(now + refusal.retryAfterSeconds * 1000) });
  }
  return t(key);
}
