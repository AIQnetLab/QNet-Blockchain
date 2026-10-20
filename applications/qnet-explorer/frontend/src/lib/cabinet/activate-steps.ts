// The activation from a payment address as four numbered steps on its page (B-SPEC 5.18, 6.7): 1 confirm in QNet Wallet,
// 2 pay, 3 burn, 4 register. Which one a record's stage is at; 5 once registered; null for the stages outside them (what
// is left going back, a burn whose wallet's node came from another burn). Pure.

import type { Stage } from './flow.ts';

export const ACTIVATE_STEPS = 4;

const STEP: Record<Stage, number | null> = {
  walletConfirm: 1,
  funding: 2,
  // Both amounts arrived: the burn is the step now.
  funded: 3,
  burnSent: 3,
  burnUnknown: 3,
  burnFailed: 3,
  burnFinal: 4,
  linkOpen: 4,
  consentVerified: 4,
  mismatch: 4,
  consentStale: 4,
  nodeExists: 4,
  beneficiaryConfirmed: 4,
  submitted: 4,
  refused: 4,
  onChain: 4,
  done: 5,
  otherBurn: null,
  leftovers: null,
  closing: null,
};

export function activationStep(stage: Stage): number | null {
  return STEP[stage];
}

// A step's mark against the step now: done before it, now, or ahead.
export function stepAt(step: number, now: number): 'done' | 'now' | 'ahead' {
  return step < now ? 'done' : step === now ? 'now' : 'ahead';
}
