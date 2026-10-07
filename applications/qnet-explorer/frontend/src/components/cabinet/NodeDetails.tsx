'use client';

// The Overview's Node details (owner, 29.09; before, the Activation code page): the chosen wallet's activation, from
// where the page learns it, by the code priority of the shared contracts (the network's registration record in the
// explorer's archive, the server's record, the QNet extension that holds the wallet, the burn on its own Solana address,
// the extension's answer kept in this browser, an activation of this browser; src/lib/cabinet/code-check.ts
// activationFacts): the activation code with Copy, the node type, the node id, the burn with its link and amount, and the
// block the QNet network recorded the node at. A light or a super node. The code is shown by itself, with no field to
// check another one (owner, 29.09), and only one: the form of whose burn it is (owner, 06.10; code-check.ts burnByOf),
// none until that is known. A code authorizes nothing; every read here is public.

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { number, t, type MessageKey } from '@/lib/texts';
import { useNodeStatus, useSuperStatus } from '@/hooks/useNodeStatus';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import {
  activationFacts, browserActivation, parseArchivedRecord, walletRegistration, type ActivationFacts, type ArchivedRecord, type BurnEvidence,
  type WalletRegistration,
} from '@/lib/cabinet/code-check';
import type { PaymentRecord } from '@/lib/cabinet/flow';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { ownSolanaOf } from '@/lib/cabinet/wallet-choice';
import { solanaTxUrl } from '@/lib/one-dev';
import type { NodeState } from '@/lib/cabinet/node-view';
import type { NodeType } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import CopyButton from './CopyButton';
import { SuperNext } from './NextSteps';

const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };
// While whose burn a registration's is cannot be told, its record is read again this often (the route keeps an answer
// half a minute).
const BURN_BY_RETRY_MS = 30_000;

const SOURCE_TEXT: Record<ActivationFacts['source'], MessageKey> = {
  network: 'code_source_network',
  record: 'code_source_record',
  extension: 'code_source_extension',
  scan: 'code_source_scan',
  kept: 'code_source_kept',
  browser: 'code_source_browser',
};

async function readArchived(wallet: string, nodeType: NodeType): Promise<ArchivedRecord | null> {
  try {
    const res = await fetch(`/api/cabinet/registration/${encodeURIComponent(wallet)}${nodeType === 'super' ? '?type=super' : ''}`, REQUEST);
    return res.status === 200 ? parseArchivedRecord(await res.json()) : null;
  } catch {
    return null;
  }
}

// The chosen wallet's registration of one node type: registered or not from the network, the burn facts and whose burn
// it is from the archive's route, with what the page knows itself (`evidence`). The archive's answer is kept with the
// wallet it is for, so another wallet chosen meanwhile never gets its burn; while its code cannot be told, it is read
// again while the page is shown, and a read that fails keeps the answer before it.
function useWalletRegistration(wallet: string | null, registered: boolean | null | undefined, evidence: BurnEvidence, nodeType: NodeType): WalletRegistration | null {
  const [archived, setArchived] = useState<{ wallet: string; record: ArchivedRecord | null } | undefined>(undefined);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!wallet || !registered) return;
    let live = true;
    void readArchived(wallet, nodeType).then((record) => {
      if (live) setArchived((before) => (record === null && before?.wallet === wallet && before.record !== null ? before : { wallet, record }));
    });
    return () => {
      live = false;
    };
  }, [wallet, registered, nodeType, round]);
  const mine = archived?.wallet === wallet ? archived : undefined;
  const registration = !wallet || registered === undefined || (registered && mine === undefined)
    ? null : walletRegistration(registered, mine?.record ?? null, wallet, evidence, nodeType);
  const unresolved = registration?.kind === 'code' && registration.code === null;
  useEffect(() => {
    if (!unresolved) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRound((n) => n + 1);
    }, BURN_BY_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [unresolved]);
  return registration;
}

export interface WalletActivation {
  facts: ActivationFacts | null;
  registration: WalletRegistration | null;
  // This browser's activations; null until read.
  records: PaymentRecord[] | null;
}

// What the page knows of the chosen wallet's activation of `nodeType`, whichever way the wallet was connected: the
// network's record, then every other source (the cabinet's view of the wallet), then an activation of this browser.
export function useWalletActivation(nodeType: NodeType = 'light'): WalletActivation {
  const { choice, nodeId, superId, activation, view } = useCabinet();
  const stored = usePaymentRecords();
  const records = stored ?? [];
  const wallet = choice?.qnet ?? null;
  const light = useNodeStatus(nodeType === 'light' ? nodeId : null).state;
  const superRead = useSuperStatus(nodeType === 'super' ? superId : null).state;
  const read = nodeType === 'super' ? superRead : light;
  const registered = read.phase === 'ok' ? read.value.registered : read.phase === 'unavailable' ? null : undefined;
  const known = view.burn && view.burn.nodeType === nodeType ? view.burn : null;
  // Whose burn the registration's is, as far as the page knows: the wallet's own Solana address (the one it shared, else
  // the one its extension burned from), the burn the other sources know, this browser's payment addresses.
  const evidence: BurnEvidence = { ownSolana: ownSolanaOf(choice) ?? activation?.solana ?? null, known, records };
  const registration = useWalletRegistration(wallet, registered, evidence, nodeType);
  const facts = wallet ? activationFacts(registration, known, nodeType === 'light' ? browserActivation(records, wallet) : null, nodeType) : null;
  return { facts, registration, records: stored };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="activate-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The one code, or that it follows later (a burn not final yet, or a registration whose burn the page cannot tell yet).
function CodeValue({ facts }: { facts: ActivationFacts }) {
  if (!facts.code) return <span className="activate-note">{t('code_code_later')}</span>;
  return (
    <div className="cabinet-choice">
      <p>
        <span className="activate-code">{facts.code}</span> <CopyButton value={facts.code} />
      </p>
    </div>
  );
}

// The details card of the wallet's node of `nodeType`, and a super node's server settings. `statusText`: how the node
// stands on the network; `nodeId`: the node's id.
export default function NodeDetails({ nodeType = 'light', nodeId, statusText, known }: { nodeType?: NodeType; nodeId: string; statusText: string; known: WalletActivation }) {
  const { facts, registration } = known;
  const light = nodeType === 'light';
  return (
    <>
      <div className="activate-card">
        <h3 className="activate-step">{t('details_title')}</h3>
        <dl className="activate-fields">
          <Field label={t('code_field_status')}>{statusText}</Field>
          <Field label={t('ext_field_type')}>{t(light ? 'ext_type_light' : 'ext_type_super')}</Field>
          <Field label={t(light ? 'code_field_node' : 'super_id')}>
            <span className="activate-mono">{nodeId}</span>
          </Field>
          {facts && (
            <>
              <Field label={t('act_code')}><CodeValue facts={facts} /></Field>
              <Field label={t('act_burn_tx')}>
                <a href={solanaTxUrl(facts.burnTx)} target="_blank" rel="noopener noreferrer" className="activate-mono">{facts.burnTx}</a>
              </Field>
              <Field label={t('code_field_amount')}>{t('ext_amount', { amount: number(facts.amount) })}</Field>
            </>
          )}
        </dl>
        {facts ? (
          <p className="activate-note">{t(SOURCE_TEXT[facts.source])}</p>
        ) : registration === null ? (
          <p className="activate-status" aria-live="polite">{t('checking')}</p>
        ) : registration.kind === 'none' ? null : (
          // Registered, without its burn details here: the explorer keeps none, or could not be read.
          <p>{t(registration.kind === 'notArchived' ? 'code_not_archived' : 'code_archive_unavailable')}</p>
        )}
        {/* A light node's code is only a receipt; a super node's server needs it (audit M23). */}
        {facts?.code && <p className="activate-note">{t(light ? 'details_note' : 'details_note_super')}</p>}
        {facts?.open && <Link href={TAB_HREF.activate} className="qnet-button activate-primary">{t('code_continue')}</Link>}
      </div>
      {!light && facts?.code && <div className="activate-card"><SuperNext code={facts.code} burnTx={facts.burnTx} burnAmount={facts.amount} /></div>}
    </>
  );
}

// How a light node stands on the network, for its details.
export function lightStatusText(state: NodeState, height: number | null): string {
  if (state === 'none') return t('code_status_not_yet');
  if (state === 'pending') return t('code_status_pending');
  return height != null ? t('code_status_recorded_at', { height: number(height) }) : t('code_status_recorded');
}
