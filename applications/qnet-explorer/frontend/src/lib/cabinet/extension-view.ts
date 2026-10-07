// What the node cabinet shows of the QNet extension's answers (docs/protocols/qnet-link-v1.md sections 7, 10 and
// 14.10), as text keys: an activation's heading, lead and error, a failed call, a move of the node balance. The
// extension answers through the browser itself, so its answer is its own report. Pure; the words are in
// src/lib/texts.ts.

import type { MessageKey } from '../texts.ts';
import type { ActivationAnswer, ActivationErrorCode, ClaimFailure, ExtensionActivation, ExtensionFailure, LinkAnswer, LinkError } from '../qnet-link.ts';

// What a checked activation answer is, for its heading: an `exists` that names a burn of the device that went
// through (protocol section 7.1) is 'superseded'.
export type AnswerKind = 'ok' | 'exists' | 'superseded' | 'pending' | 'rejected' | 'error';

export function answerKind(answer: Pick<ActivationAnswer, 'status' | 'supersededBurnTx'>): AnswerKind {
  return answer.status === 'exists' && answer.supersededBurnTx !== undefined ? 'superseded' : answer.status;
}

export function headingKey(answer: Pick<ActivationAnswer, 'status' | 'supersededBurnTx'>): MessageKey {
  return `ext_heading_${answerKind(answer)}`;
}

// The sentence under the heading.
export function leadKey(answer: Pick<ActivationAnswer, 'status' | 'supersededBurnTx'>): MessageKey {
  switch (answerKind(answer)) {
    case 'ok':
      return 'ext_lead_ok';
    case 'exists':
      return 'ext_lead_exists';
    case 'superseded':
      return 'ext_lead_superseded';
    case 'pending':
      return 'ext_lead_pending';
    default:
      return 'ext_lead_rejected';
  }
}

export function errorKey(code: ActivationErrorCode): MessageKey {
  return `ext_error_${code}`;
}

// A call that threw or answered what the page could not verify. An activation's timeout, failure and
// unverifiable answer leave a burn possible; a move of the node balance burns nothing; an unlink changes nothing the
// device rows would not show.
export function failureKey(failure: ClaimFailure, action: 'activate' | 'claim' | 'unlink'): MessageKey {
  if (failure === 'other_wallet') return action === 'unlink' ? 'unlink_failure_other_wallet' : 'claim_failure_other_wallet';
  if (action !== 'activate' && (failure === 'timeout' || failure === 'failed' || failure === 'unverifiable')) return `${action}_failure_${failure}`;
  return `ext_failure_${failure}`;
}

// Whether a burn of this wallet may be on its way after an answer: `pending` (sent, not final), and the two errors
// that do not rule a burn out, BURN_IN_PROGRESS and INTERNAL (protocol section 9, step 6).
export function answerMayHaveBurned(answer: Pick<ActivationAnswer, 'status' | 'error'>): boolean {
  if (answer.status === 'pending') return true;
  return answer.status === 'error' && (answer.error === 'BURN_IN_PROGRESS' || answer.error === 'INTERNAL');
}

// The same after the call, whose outcome is also unknown when it timed out, failed, answered unverifiably or was
// disconnected.
export function extensionMayHaveBurned(result: ExtensionActivation): boolean {
  if (result.ok) return answerMayHaveBurned(result.answer);
  const unknown: ExtensionFailure[] = ['timeout', 'failed', 'unverifiable', 'disconnected'];
  return unknown.includes(result.failure);
}

// A light activation whose wallet the page then follows on the QNet network until two genesis nodes list its node.
export function recordsLightNode(answer: ActivationAnswer): answer is ActivationAnswer & { qnet: string } {
  return answer.nodeType === 'light' && answer.qnet !== undefined && (answer.status === 'ok' || answer.status === 'exists' || answer.status === 'pending');
}

// ---------------------------------------------------------------- moving the node balance

export type ClaimVia = 'app' | 'extension';

// The error of a `claim` answer, told by the wallet that answered.
export function claimErrorKey(error: LinkError, via: ClaimVia): MessageKey {
  switch (error) {
    case 'NO_WALLET':
      return via === 'extension' ? 'ext_error_NO_WALLET' : 'link_error_NO_WALLET';
    case 'WALLET_MISMATCH':
      return 'link_error_WALLET_MISMATCH';
    case 'NO_NODE':
    case 'NETWORK':
    case 'CLAIM_REFUSED':
    case 'CLAIM_BUSY':
      return `claim_error_${error}`;
    default:
      return via === 'extension' ? 'ext_error_INTERNAL' : 'link_error_INTERNAL';
  }
}

// What a checked `claim` answer says, as the wallet's report: the key and the values it takes.
export type ClaimReport = { key: MessageKey; amountNano?: string; epoch?: string };

export function claimReport(answer: LinkAnswer, via: ClaimVia): ClaimReport {
  switch (answer.status) {
    case 'ok':
      return answer.stoppedAtEpoch
        ? { key: 'claim_ok_part', amountNano: answer.amountNano, epoch: answer.stoppedAtEpoch }
        : { key: 'claim_ok', amountNano: answer.amountNano };
    case 'empty':
      return { key: 'claim_empty' };
    case 'error':
      return { key: claimErrorKey(answer.error as LinkError, via) };
    default:
      return { key: via === 'extension' ? 'ext_failure_rejected' : 'link_answer_rejected' };
  }
}

// ---------------------------------------------------------------- unlinking the device

// The error of an `unlink` answer, told by the wallet that answered.
export function unlinkErrorKey(error: LinkError, via: ClaimVia): MessageKey {
  switch (error) {
    case 'NO_WALLET':
      return via === 'extension' ? 'ext_error_NO_WALLET' : 'link_error_NO_WALLET';
    case 'WALLET_MISMATCH':
      return 'link_error_WALLET_MISMATCH';
    case 'NOT_LINKED':
    case 'NETWORK':
    case 'UNLINK_REFUSED':
      return `unlink_error_${error}`;
    default:
      return via === 'extension' ? 'ext_error_INTERNAL' : 'link_error_INTERNAL';
  }
}

// What a checked `unlink` answer says, as the wallet's report: taken by the network, done on the device without the
// network's word, an error, or declined.
export function unlinkReport(answer: LinkAnswer, via: ClaimVia): MessageKey {
  if (answer.status === 'ok') return answer.unbound === true ? 'unlink_answer_ok' : 'unlink_answer_unconfirmed';
  if (answer.status === 'error' && answer.error) return unlinkErrorKey(answer.error, via);
  return via === 'extension' ? 'ext_failure_rejected' : 'link_answer_rejected';
}
