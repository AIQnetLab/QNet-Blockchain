'use client';

// Status words, the live dot and transaction types: coloured words, never filled pills. Live is the
// dot and a Paper word, done is Paper, needs-you or failed is Ember, quiet is Fog, no node is the Fog ring.

import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { heldText } from '@/lib/hold';

export type Tone = 'live' | 'done' | 'needs' | 'quiet' | 'none';

export function LiveDot() {
  return <span className="live-dot" aria-hidden="true" />;
}

// A live list's label: the dot and its name, or while it is held what waits. Every label sits in one cell,
// so the label keeps the widest one's width and nothing beside it moves; the widest is the one a mouse or pen holds
// while nothing waits yet (a phone's sheets hide it, data-k).
export function HoldLabel({ hold, idle }: { hold: { holding: boolean; touch: boolean; back: { count: number; more: boolean } }; idle?: string }) {
  const t = useT();
  const POINTING = heldText({ count: 0, more: false }, false, t);
  const said = hold.holding ? heldText(hold.back, hold.touch, t) : null;
  return (
    <>
      <LiveDot />
      <span className="swap">
        <span data-on={!said}>{idle ?? t('live')}</span>
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

// Each kind the explorer names (src/lib/tx-mapping.ts) has a colour of its own (styles/tokens.css --kind-*); the app's
// view labels keep the colour of the kind they rename, and a kind no page names reads as System.
export const TX_KINDS: Readonly<Record<string, string>> = {
  Transfer: 'transfer',
  'Token Transfer': 'token',
  Move: 'move',
  Reward: 'reward',
  Swap: 'swap',
  'Contract Call': 'call',
  Deploy: 'deploy',
  Activation: 'activation',
  Registration: 'registration',
  Heartbeat: 'heartbeat',
  'Light Eligibility': 'light',
  System: 'system',
};

export const txKind = (type: string): string => (Object.prototype.hasOwnProperty.call(TX_KINDS, type) ? TX_KINDS[type] : 'system');

// `type` is the explorer's name (it sets the colour); `label` what the page shows for it.
export function TxType({ type, label }: { type: string; label?: string }) {
  return <span className="txtype" data-kind={txKind(type)}>{label ?? type}</span>;
}
