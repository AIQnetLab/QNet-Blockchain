'use client';

// /node/activate with the QNet extension on a computer (unified plan flow C, docs/protocols/qnet-link-v1.md sections
// 10 and 14.10). The extension shows the price, holds the wallet's reservation in the site's activation registry, burns
// from its own Solana address and, for a light node, records the node on the QNet network in the same approval; the page
// checks the answer (validateActivation) and reads "Registered" from two genesis nodes itself. The node type and the
// button are offered only while every source of the wallet says it has nothing (the state `none`,
// src/lib/cabinet/wallet-activation.ts; R1, R6): neither choosing another type nor Try again brings the button back
// while the wallet has an activation, a burn on its way or a state not known. After any answer every source is read
// again. A light node's next step follows (NextSteps.tsx): the record on the network, then Link a device. A super node
// gets its server steps (R3). The extension answers through the browser, so its answer is its own report.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useWallet } from '@/contexts/AppContext';
import { useNodeStatus } from '@/hooks/useNodeStatus';
import { number, t } from '@/lib/texts';
import { parseSitePrice, type PriceQuote } from '@/lib/activation-price';
import {
  errorKey,
  extensionMayHaveBurned,
  failureKey,
  headingKey,
  leadKey,
  recordsLightNode,
} from '@/lib/cabinet/extension-view';
import { isLinkedState, nodeState } from '@/lib/cabinet/node-view';
import { SITE_ORIGIN, lightNodeId, type ActivationAnswer, type ActivationErrorCode, type ExtensionFailure, type NodeType } from '@/lib/qnet-link';
import { solanaTxUrl } from '@/lib/one-dev';
import CopyButton from './CopyButton';
import { useCabinet } from './CabinetProvider';
import { LinkPhone, Recording, SuperNext } from './NextSteps';

const NODE_TYPES: NodeType[] = ['light', 'super'];
const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

type Price = { state: 'loading' } | { state: 'ok'; quote: PriceQuote } | { state: 'unavailable' };
const LOADING: Price = { state: 'loading' };

type ExtState =
  | { phase: 'idle' }
  | { phase: 'waiting'; nodeType: NodeType }
  // `at`: when the page got the answer.
  | { phase: 'done'; nodeType: NodeType; answer: ActivationAnswer; at: number }
  | { phase: 'failed'; nodeType: NodeType; failure: ExtensionFailure };

async function fetchPrice(type: NodeType): Promise<Price> {
  try {
    const res = await fetch(`/api/activation/price?type=${type}`, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (res.status !== 200) return { state: 'unavailable' };
    const quote = parseSitePrice(await res.json(), type);
    return quote ? { state: 'ok', quote } : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

// The node type ?type= names (the Overview's two buttons), light otherwise.
export function requestedType(search: string): NodeType {
  return new URLSearchParams(search).get('type') === 'super' ? 'super' : 'light';
}

function PriceLabel({ price }: { price: Price }) {
  if (price.state === 'loading') return <>{t('ext_price_loading')}</>;
  if (price.state === 'unavailable') return <>{t('ext_price_unavailable')}</>;
  if (price.quote.phase === 2) return <>{t('ext_price_phase2')}</>;
  return <>{t('ext_price', { price: number(price.quote.cost) })}</>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="activate-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// A light node the extension recorded: shown as registered once two genesis nodes list it, or once the network lists it
// for the cabinet's wallet (wallet-activation.ts); until then its record on the network, then, by itself, Link your
// phone. `since`: when the page got the answer.
function LightNext({ qnet, since, burnFinal }: { qnet: string; since: number; burnFinal: boolean }) {
  const { ready, choice, choose, view } = useCabinet();
  const { state } = useNodeStatus(lightNodeId(qnet));
  // The extension's wallet becomes the cabinet's wallet when none was chosen.
  useEffect(() => {
    if (ready && !choice) choose({ qnet, source: 'extension' });
  }, [ready, choice, choose, qnet]);
  const listed = choice?.qnet === qnet && view.nodes.includes('light');
  const registered = listed || (state.phase === 'ok' && nodeState(state.value) !== 'none' && nodeState(state.value) !== 'pending');
  const pending = state.phase === 'ok' && nodeState(state.value) === 'pending';
  const linked = state.phase === 'ok' && isLinkedState(nodeState(state.value));
  // Linked, but the network asks the device to come back: it does not run now.
  const offline = state.phase === 'ok' && nodeState(state.value) === 'offline';
  // A device just linked that has not answered yet.
  const waiting = state.phase === 'ok' && nodeState(state.value) === 'device_pending';
  return (
    <div className="activate-next">
      <h4>{t('ext_next')}</h4>
      {registered ? (
        <>
          <p className="activate-result">{t('ext_light_registered')}</p>
          {linked ? <p>{t(offline ? 'next_offline' : waiting ? 'next_device_pending' : 'next_running')}</p> : <LinkPhone />}
        </>
      ) : (
        <Recording qnet={qnet} since={since} burnFinal={burnFinal} pending={pending} />
      )}
      {ready && choice && choice.qnet !== qnet && (
        <button type="button" className="activate-link-button" onClick={() => choose({ qnet, source: 'extension' })}>{t('ext_show_wallet')}</button>
      )}
    </div>
  );
}

function AnswerView({ answer, requested, at }: { answer: ActivationAnswer; requested: NodeType; at: number }) {
  const title = t(headingKey(answer));
  if (answer.status === 'rejected') {
    return (
      <div className="activate-result" role="status">
        <h4>{title}</h4>
        <p>{t('ext_lead_rejected')}</p>
      </div>
    );
  }
  if (answer.status === 'error') {
    return (
      <div className="activate-result activate-result-warn" role="alert">
        <h4>{title}</h4>
        <p>{t(errorKey(answer.error as ActivationErrorCode))}</p>
      </div>
    );
  }
  const burnTx = answer.burnTx as string;
  const burnAmount = answer.burnAmount as number;
  const typeKey = answer.nodeType === 'super' ? 'ext_type_super' : 'ext_type_light';
  return (
    <div className="activate-result" role="status">
      <h4>{title}</h4>
      <p>{t(leadKey(answer), { amount: number(burnAmount) })}</p>
      {answer.status === 'exists' && answer.nodeType !== requested && (
        <p>{t('ext_other_type', { got: t(typeKey), chosen: t(requested === 'super' ? 'ext_type_super' : 'ext_type_light') })}</p>
      )}
      <dl className="activate-fields">
        <Field label={t('ext_field_type')}>{t(typeKey)}</Field>
        {answer.code && (
          <Field label={t('ext_field_code')}>
            <span className="activate-code">{answer.code}</span> <CopyButton value={answer.code} />
          </Field>
        )}
        <Field label={t('ext_field_burn')}>
          <span>{t('ext_amount', { amount: number(burnAmount) })}</span>{' '}
          <a href={solanaTxUrl(burnTx)} target="_blank" rel="noopener noreferrer" className="activate-mono">{burnTx}</a>
        </Field>
        {answer.supersededBurnTx && (
          <Field label={t('ext_field_superseded')}>
            <a href={solanaTxUrl(answer.supersededBurnTx)} target="_blank" rel="noopener noreferrer" className="activate-mono">{answer.supersededBurnTx}</a>
          </Field>
        )}
        <Field label={t('ext_field_qnet')}>
          <span className="activate-mono">{answer.qnet}</span>
        </Field>
        <Field label={t('ext_field_solana')}>
          <span className="activate-mono">{answer.solana}</span>
        </Field>
      </dl>
      <p className="activate-note">{t(answer.code ? 'ext_footer_code' : 'ext_footer')}</p>
      {recordsLightNode(answer) && requested === 'light' ? (
        <LightNext qnet={answer.qnet} since={at} burnFinal={answer.status !== 'pending'} />
      ) : answer.nodeType === 'super' && answer.code ? (
        <SuperNext code={answer.code} burnTx={burnTx} burnAmount={burnAmount} />
      ) : null}
    </div>
  );
}

// Keyed by the cabinet's wallet (NodeActivate), so another wallet starts afresh. `offer`: the wallet's state is `none`,
// so the node type and the burn button may show. `onAnswered`: the extension answered (the page then shows the answer,
// not the state card).
export default function ExtensionActivate({ offer, onAnswered }: { offer: boolean; onAnswered?: () => void }) {
  const { activateNode } = useWallet();
  const { keepActivation, refreshActivation } = useCabinet();
  const [canonical, setCanonical] = useState<boolean | null>(null);
  const [prices, setPrices] = useState<Record<NodeType, Price>>({ light: LOADING, super: LOADING });
  const [nodeType, setNodeType] = useState<NodeType>('light');
  const [ext, setExt] = useState<ExtState>({ phase: 'idle' });
  // Set when the extension's burn may still be on its way: kept for the life of the page.
  const [burnInFlight, setBurnInFlight] = useState(false);
  const busy = ext.phase === 'waiting';

  const loadPrices = useCallback(async () => {
    setPrices({ light: LOADING, super: LOADING });
    const [light, superNode] = await Promise.all([fetchPrice('light'), fetchPrice('super')]);
    setPrices({ light, super: superNode });
  }, []);

  useEffect(() => {
    // The extension answers aiqnet.io only (and a local build).
    const origin = window.location.origin;
    const ok = origin === SITE_ORIGIN || LOCAL_ORIGIN_RE.test(origin);
    setCanonical(ok);
    setNodeType(requestedType(window.location.search));
    if (ok) void loadPrices();
  }, [loadPrices]);

  // Another type only while nothing is known of the wallet's activation.
  const choose = (next: NodeType) => {
    if (busy || !offer || next === nodeType) return;
    setNodeType(next);
    setExt({ phase: 'idle' });
  };

  const run = async () => {
    if (busy || !offer) return;
    const requested = nodeType;
    setExt({ phase: 'waiting', nodeType: requested });
    const result = await activateNode(requested);
    if (extensionMayHaveBurned(result)) setBurnInFlight(true);
    if (result.ok) keepActivation(result.answer);
    setExt(result.ok
      ? { phase: 'done', nodeType: requested, answer: result.answer, at: Date.now() }
      : { phase: 'failed', nodeType: requested, failure: result.failure });
    onAnswered?.();
    // Whatever it answered, every source is read again before anything else is offered.
    refreshActivation();
  };

  if (canonical === null) return null;
  if (!canonical) {
    return offer ? (
      <div className="activate-card">
        <p>
          {t('ext_other_origin')} <a href={`${SITE_ORIGIN}/node/activate`}>aiqnet.io/node/activate</a>
        </p>
      </div>
    ) : null;
  }
  // Nothing to show while the wallet is not offered an activation and the extension gave no answer here.
  if (!offer && ext.phase === 'idle' && !burnInFlight) return null;

  const phase2 = NODE_TYPES.some((type) => {
    const p = prices[type];
    return p.state === 'ok' && p.quote.phase === 2;
  });
  const priceMissing = NODE_TYPES.some((type) => prices[type].state === 'unavailable');
  const again = offer && (ext.phase === 'failed' || (ext.phase === 'done' && (ext.answer.status === 'rejected' || ext.answer.status === 'error')));

  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('ext_title')}</h3>
      {offer && (
        <>
          <p>{t('ext_lead')}</p>
          <div className="activate-types" role="radiogroup" aria-label={t('ext_type_label')}>
            {NODE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={nodeType === type}
                className={`activate-type${nodeType === type ? ' selected' : ''}`}
                onClick={() => choose(type)}
                disabled={busy}
              >
                <span className="activate-type-name">{t(type === 'light' ? 'ext_type_light' : 'ext_type_super')}</span>
                <span className="activate-type-where">{t(type === 'light' ? 'ext_type_light_where' : 'ext_type_super_where')}</span>
                <span className="activate-type-price"><PriceLabel price={prices[type]} /></span>
              </button>
            ))}
          </div>
          {priceMissing && (
            <p className="activate-note">
              {t('ext_price_missing')}{' '}
              <button type="button" className="activate-link-button" onClick={() => void loadPrices()}>{t('try_again')}</button>
            </p>
          )}
          <ul className="activate-facts">
            <li>{t('ext_fact_destroyed')}</li>
            <li>{t('ext_fact_one')}</li>
            <li>{t('ext_fact_recover')}</li>
          </ul>
        </>
      )}
      {phase2 && offer ? (
        <p>{t('ext_phase2')}</p>
      ) : (
        <>
          {ext.phase === 'idle' && offer && (
            <>
              <button type="button" className="qnet-button activate-primary" onClick={() => void run()}>{t('ext_start')}</button>
              <p className="activate-note">{t('ext_start_note')}</p>
            </>
          )}
          {ext.phase === 'waiting' && <p className="activate-status" aria-live="polite">{t('wallet_extension_waiting')}</p>}
          {ext.phase === 'done' && <AnswerView answer={ext.answer} requested={ext.nodeType} at={ext.at} />}
          {ext.phase === 'failed' && <p className="activate-error" role="alert">{t(failureKey(ext.failure, 'activate'))}</p>}
          {/* A declined request or an error ends this ask; the extension is asked again only while the wallet still has
              nothing anywhere (every source read again first). */}
          {again && <button type="button" className="qnet-button secondary" onClick={() => setExt({ phase: 'idle' })}>{t('try_again')}</button>}
        </>
      )}
      {burnInFlight && <p className="activate-note" role="status">{t('ext_in_flight')}</p>}
    </div>
  );
}
