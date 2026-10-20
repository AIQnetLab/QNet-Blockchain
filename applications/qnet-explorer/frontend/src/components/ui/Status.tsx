// Status words, the live dot and transaction types (B-SPEC 5.12, 5.9): coloured words, never filled pills. Live is the
// dot and a Paper word, done is Paper, needs-you or failed is Ember, quiet is Fog, no node is the Fog ring.

import type { ReactNode } from 'react';
import { heldText } from '@/lib/hold';

export type Tone = 'live' | 'done' | 'needs' | 'quiet' | 'none';

export function LiveDot() {
  return <span className="live-dot" aria-hidden="true" />;
}

// The widest label of a live list: a mouse or pen holds it and nothing waits yet (a phone's sheets hide it, data-k).
const POINTING = heldText({ count: 0, more: false }, false);

// A live list's label (B-SPEC 3.7): the dot and its name, or while it is held what waits. Every label sits in one cell,
// so the label keeps the widest one's width and nothing beside it moves.
export function HoldLabel({ hold, idle = 'Live' }: { hold: { holding: boolean; touch: boolean; back: { count: number; more: boolean } }; idle?: string }) {
  const said = hold.holding ? heldText(hold.back, hold.touch) : null;
  return (
    <>
      <LiveDot />
      <span className="swap">
        <span data-on={!said}>{idle}</span>
        <span data-on={said === POINTING} data-k="point">{POINTING}</span>
        <span data-on={!!said && said !== POINTING}>{said && said !== POINTING ? said : ' '}</span>
      </span>
    </>
  );
}

export function Ring() {
  return <span className="ring" aria-hidden="true" />;
}

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status" data-tone={tone}>
      {tone === 'live' && <LiveDot />}
      {tone === 'none' && <Ring />}
      {children}
    </span>
  );
}

// The colour of each type the explorer names (src/lib/tx-mapping.ts); the app's view labels keep the colour of the type
// they rename.
const TX_TONE: Record<string, 'paper' | 'mint' | 'lilac' | 'ember' | 'fog'> = {
  Transfer: 'paper',
  'Token Transfer': 'paper',
  Reward: 'mint',
  Swap: 'lilac',
  'Contract Call': 'lilac',
  Deploy: 'lilac',
  Activation: 'ember',
  Registration: 'ember',
  Heartbeat: 'fog',
  'Light Eligibility': 'fog',
  System: 'fog',
};

export const txTone = (type: string): string => TX_TONE[type] ?? 'paper';

// `type` is the explorer's name (it sets the colour); `label` what the page shows for it.
export function TxType({ type, label }: { type: string; label?: string }) {
  return <span className="txtype" data-tone={txTone(type)}>{label ?? type}</span>;
}
