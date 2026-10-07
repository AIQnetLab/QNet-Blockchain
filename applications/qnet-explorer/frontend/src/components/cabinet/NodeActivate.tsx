'use client';

// /node/activate (unified plan flows A and B; shared contracts C1 and C4): a light node paid from a one-time payment
// address in this browser. QNet Wallet first confirms the wallet the node is for (a QNet Link `reserve` request: the
// wallet signs its reservation, and the address exists for that wallet only), then the address is funded from the
// user's own wallet as on mainnet (owner, 29.09: the page names the exact amounts, with payment request QR codes; on
// testnet it links the Testnet page's faucet for test tokens to the wallet), the burn is bound to that wallet's light
// node before it is sent and shows its code once final, and one QNet Link `link` request that QNet Wallet confirms
// registers the node. That last step also works later from any browser where the wallet is connected (NextSteps.tsx
// FinishLight): the burn is the wallet's activation for good.
// The record of the activation lives in this browser (src/lib/cabinet/payment-store.ts); every step is a function of
// src/lib/cabinet/activation.ts, taken again from the record after a reload, so the phone browser may discard this
// tab while QNet Wallet is in front. On a computer with the QNet extension that holds the chosen wallet the extension
// burns and records instead (ExtensionActivate, flow C); an extension that holds another wallet is never offered, since
// it burns for its own wallet only (audit M4). The payment address is offered only while the site's phone flows are on
// (src/server/phone-flows.ts): without QNet Wallet's answers it could not be confirmed or registered. Before the burn
// the key lives at most 24 hours; then what arrived goes back to the wallet (test tokens only when the page knows the
// wallet's Solana address) and the key is deleted. After the burn the key only sends back what is left: once the node
// is recorded, or at once when the user asks. Nothing new is offered here unless every source of the chosen wallet says
// it has nothing (the state `none`, src/lib/cabinet/wallet-activation.ts; unified plan R1 and R6): a wallet with a node,
// a burn, a burn on its way, another browser's reservation or a source that did not answer gets its state and next step
// instead. The burn is signed only under the wallet's reservation in the site's activation registry (activation.ts
// burn). The payment address burns for a light node only; a super node is activated only in the QNet extension, on a
// computer, and runs on the user's own server. A payment address is shown, and its burn signed, only while the two
// genesis nodes that settle the wallet's light node status both list `owner_bind_v2` (activation.ts paymentOpen): before
// the network's one-wallet-one-node gate the nodes refuse the payment key's owner bind, and the page says that payment
// activation is not open yet.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import { number, t, type MessageKey } from '@/lib/texts';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useNodeStatus } from '@/hooks/useNodeStatus';
import { useLinkSession } from '@/hooks/useLinkSession';
import { sameQuote, type PriceQuote } from '@/lib/activation-price';
import * as act from '@/lib/cabinet/activation';
import { verifyReserveAnswer } from '@/lib/cabinet/burn-record';
import { verifyConsent } from '@/lib/cabinet/consent-verify';
import {
  isExpired, isUnfinished, KEY_LIFETIME_MS, mayCancel, mayReturnLeftovers, pinnedWallet, receiptOf, refundDestination, type PaymentRecord, type Stage,
} from '@/lib/cabinet/flow';
import { createPaymentKey, paymentKeySupported } from '@/lib/cabinet/payment-key';
import { listRecords } from '@/lib/cabinet/payment-store';
import { OWNER_BIND_V2_FEATURE } from '@/lib/cabinet/registration';
import { GUIDE_HREF } from '@/lib/cabinet/tabs';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';
import type { LinkAnswer } from '@/lib/qnet-link';
import { installTarget, shortAddress } from '@/lib/qnet-provider';
import { AnswerCheck, Funding, Leftovers, LeftoversNow, Receipt, Registered } from './ActivateSteps';
import CabinetFrame from './CabinetFrame';
import { useCabinet } from './CabinetProvider';
import ConnectFirst from './ConnectFirst';
import ExtensionActivate, { requestedType } from './ExtensionActivate';
import LinkWaiting from './LinkWaiting';
import { NoNode, NodeNext } from './NextSteps';

// How often each stage that waits on the network is looked at again while the page is shown. Every activating page
// reads Solana through the site's one server, so the funding read is not polled faster than a transfer lands; the
// page reads at once when it is shown again.
const POLL_MS: Partial<Record<Stage, number>> = {
  funding: 6_000,
  funded: 15_000,
  burnSent: 4_000,
  burnUnknown: 8_000,
  consentVerified: 10_000,
  beneficiaryConfirmed: 10_000,
  submitted: 10_000,
  onChain: 10_000,
  leftovers: 10_000,
  closing: 10_000,
};
// The other unfinished stages are looked at this often for the key's lifetime.
const EXPIRY_POLL_MS = 60_000;
// The stages at which QNet Wallet's signed reservation is asked for, first or again.
const CONFIRM_STAGES: ReadonlySet<Stage> = new Set<Stage>(['walletConfirm', 'funding', 'funded']);

const BURN_NOTICE: Record<act.BurnResult['outcome'], MessageKey | null> = {
  sent: null,
  unknown: null,
  busy: 'act_burn_busy',
  refused: 'act_burn_refused',
  unavailable: 'act_burn_unavailable',
  price_unavailable: 'act_price_unavailable',
  price_changed: 'act_price_changed',
  has_node: 'act_wallet_has_node',
  found: null,
  checking: 'act_burn_checking',
  no_wallet: 'act_no_wallet',
  reconfirm: 'act_reconfirm',
  has_burn: 'act_has_activation',
  reserved: 'act_reserved',
  check_unavailable: 'act_check_unavailable',
  reservation: 'act_reservation',
  not_open: 'act_payment_not_open',
};

const STOPPED_TEXT: Partial<Record<Stage, MessageKey>> = {
  mismatch: 'act_mismatch',
  consentStale: 'act_stale',
  nodeExists: 'act_node_exists',
};

// What an answer that is no consent says, as the wallet's report (it came through the relay). A consent that ends the
// request was an answer to another request (act.takeAnswer): the page just opens a new one.
function endedNotice(answer: LinkAnswer): MessageKey | null {
  if (answer.status === 'ok') return null;
  if (answer.status === 'linked') return 'act_linked_answer';
  if (answer.status === 'error' && answer.error) return `link_error_${answer.error}` as MessageKey;
  return 'link_answer_rejected';
}

// What a `reserve` answer that confirmed nothing says: declined, an error of QNet Wallet, or another wallet's answer.
function reserveNotice(answer: LinkAnswer, outcome: act.HoldResult['outcome']): MessageKey | null {
  if (outcome === 'confirmed') return null;
  if (outcome === 'other_wallet') return 'act_reserve_other_wallet';
  if (answer.status === 'error' && answer.error) return `link_error_${answer.error}` as MessageKey;
  return 'act_reserve_rejected';
}

// What a `connect` answer that shares no address says, as the answer's report.
function refusedAnswerText(answer: LinkAnswer): MessageKey {
  if (answer.status === 'rejected') return 'link_answer_rejected';
  return answer.error === 'NO_WALLET' ? 'link_answer_no_wallet' : 'link_answer_internal';
}

type Setup = { phase: 'loading' } | { phase: 'ready'; quote: PriceQuote } | { phase: 'unavailable' };

export default function NodeActivate() {
  const { ready, choice, choose, viewOnly, view, refreshActivation, nodeId, phoneFlows } = useCabinet();
  // The wallet's light node status the cabinet reads anyway: a network that does not list the v2 owner bind on both
  // settling nodes takes no payment burn yet. Read again before an address is made and before a burn is signed.
  const lightStatus = useNodeStatus(nodeId);
  const paymentClosed = lightStatus.state.phase === 'ok' && !lightStatus.state.value.features.includes(OWNER_BIND_V2_FEATURE);
  const { providerStatus, providerChannel, accounts } = useWallet();
  const extension = providerStatus === 'available' && providerChannel === 'extension';
  // The extension burns for its own wallet only: its activation is offered when it holds the chosen wallet (the wallet the
  // cabinet took from it, or the one it answers with), never for a wallet the page learned elsewhere.
  const extensionHolds = extension && choice !== null && (choice.source === 'extension' || accounts?.qnet === choice.qnet);
  const device = useDeviceKind();
  const deps = useMemo(() => act.browserDeps(), []);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<Setup>({ phase: 'loading' });
  const [record, setRecord] = useState<PaymentRecord | null | undefined>(undefined);
  const [balance, setBalance] = useState<act.PaymentBalance | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);
  // ?type=super (the Overview's "Activate a super node"): the super node's card comes first.
  const [wantsSuper, setWantsSuper] = useState(false);
  // What is left cannot go back until the payment address gets this much more SOL (lamports), and where it then goes:
  // the wallet's address, or the one the user entered and pressed Send for, which the page then sends to by itself
  // (SITE-R2-02).
  const [short, setShort] = useState<{ dest: string; need: bigint } | null>(null);
  const typedDest = useRef<string | null>(null);
  // The record was an unfinished activation of this browser when the page opened.
  const [resumed, setResumed] = useState(false);
  const busy = useRef(false);
  // Each activation keeps its own request in the browser, so another tab's request for another activation never takes
  // this one's place, and its answer never reaches this record (SITE-R3-02).
  const button = useLinkSession({ slot: record ? `activate.${record.pub}` : undefined, consent24h: true, verify: verifyConsent });
  const qr = useLinkSession({ slot: record ? `activate-qr.${record.pub}` : undefined, consent24h: true, verify: verifyConsent });
  const session = record?.link?.qr ? qr : button;
  // QNet Wallet's confirmation of the wallet the activation is for (its signed reservation), first or again.
  const confirm = useLinkSession({ slot: record ? `reserve.${record.pub}` : undefined, verifyReservation: verifyReserveAnswer });
  const { start: confirmStart, cancel: confirmCancel } = confirm;
  const [confirmQr, setConfirmQr] = useState(false);
  // The confirmation answer, or the expiry, the page took already: a render never takes it twice.
  const confirmTaken = useRef<unknown>(null);
  // A new record asks QNet Wallet once the page follows it (its request is kept for that record).
  const [askFor, setAskFor] = useState<{ pub: string; qr: boolean } | null>(null);
  // What is left goes back to the wallet's own Solana address: on this phone or tablet the page may ask QNet Wallet
  // for it with a `connect` request (never a QR code, which anyone who saw it could answer).
  const refundAsk = useLinkSession({ slot: 'activate-connect' });
  // The time the page last looked, for what the key's lifetime allows (a minute is fine enough).
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadSetup = useCallback(async () => {
    setSetup({ phase: 'loading' });
    const quote = await act.readPrice(deps);
    setSetup(quote ? { phase: 'ready', quote } : { phase: 'unavailable' });
  }, [deps]);

  // The chosen wallet's state from every source: nothing new is offered unless it is `none`.
  const offer = view.state === 'none';
  // A funded payment address burns only for the chosen, connected wallet, and only while every source of it says it has
  // nothing or this browser holds its reservation already (R6): a known burn, a source that is loading, locked or did
  // not answer, or another browser's reservation shows the state instead, and nothing is signed.
  const mayBurn = choice !== null && !viewOnly && (offer || (view.state === 'reserved' && view.here));
  const [extensionAnswered, setExtensionAnswered] = useState(false);

  // The record this page follows: the one it showed, else the unfinished one of this browser.
  const loadRecord = useCallback(async (followed?: string) => {
    const all = await listRecords(deps.area);
    const found = all.find((r) => r.pub === followed) ?? all.find(isUnfinished) ?? null;
    setRecord(found);
    setResumed(followed === undefined && found !== null);
  }, [deps]);

  useEffect(() => {
    void paymentKeySupported().then(setSupported);
    void loadSetup();
    void loadRecord();
    setWantsSuper(requestedType(window.location.search) === 'super');
  }, [loadSetup, loadRecord]);

  // The price is read again whenever the page is shown again (SITE-R2-05): it steps down as supply is burned, and a
  // tab may wait hours for a transfer. The burn reads it once more before it signs (act.burn).
  const priceKnown = setup.phase === 'ready';
  useEffect(() => {
    if (!priceKnown) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void act.readPrice(deps).then((quote) => {
        if (quote) setSetup((s) => (s.phase === 'ready' && !sameQuote(s.quote, quote) ? { ...s, quote } : s));
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [priceKnown, deps]);

  // One network step at a time for the stages that wait on the network. A step that ends an activation deletes its
  // record (null): the page says it ended (or, after a burn, that what was left went back).
  const step = useCallback(async (from: PaymentRecord, run: (r: PaymentRecord) => Promise<PaymentRecord | null>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await run(from);
      if (next === null) setNotice(from.burn ? 'act_returned' : 'act_closed');
      setRecord((current) => (current?.pub !== from.pub ? current : next));
    } finally {
      busy.current = false;
    }
  }, []);

  // Where what is left goes back to: the chosen wallet's own Solana address, when the page knows it.
  const dest = record ? refundDestination(record, choice) : null;
  const price = setup.phase === 'ready' && setup.quote.phase === 1 ? setup.quote.cost : null;

  // A refund's outcome for the SOL notice: kept while it is short (a failed read changes nothing), cleared otherwise.
  const noteShort = useCallback((got: act.RefundResult, to: string | null) => {
    if (got.outcome === 'unavailable') return;
    const need = got.outcome === 'short' && to !== null ? got.need ?? null : null;
    setShort((cur) => (need === null ? null : cur && cur.need === need && cur.dest === to ? cur : { dest: to as string, need }));
  }, []);

  // Another record, or one past the refund, starts without an address typed for it or a shortfall.
  const shortFor = useRef<string | null>(null);
  useEffect(() => {
    const refunding = record?.stage === 'leftovers' || record?.stage === 'closing' ? record.pub : null;
    if (refunding !== null && shortFor.current === refunding) return;
    shortFor.current = refunding;
    typedDest.current = null;
    setShort(null);
  }, [record?.pub, record?.stage]);

  useEffect(() => {
    if (!record || !isUnfinished(record)) return;
    const every = POLL_MS[record.stage] ?? EXPIRY_POLL_MS;
    const run = () => {
      if (document.visibilityState === 'hidden') return;
      void step(record, async (r) => {
        if (isExpired(r, deps.now())) return act.expire(r, deps);
        switch (r.stage) {
          case 'funding':
          case 'funded': {
            if (price === null) return r;
            const got = await act.checkFunding(r, price, deps);
            if (got.balance) setBalance(got.balance);
            return got.record;
          }
          case 'burnSent':
          case 'burnUnknown':
            return act.settleBurn(r, deps);
          case 'consentVerified':
            return act.reviewConsent(r, deps);
          case 'beneficiaryConfirmed':
            return act.register(r, deps);
          case 'submitted':
            return act.followRegistration(r, deps);
          case 'onChain':
            return act.finish(r, dest, deps);
          case 'leftovers':
          case 'closing': {
            // Read each time: a transfer still on its way to an empty address shows here when it lands.
            const now = await act.readPayment(r.pub, deps);
            if (now) setBalance(now);
            const to = dest ?? typedDest.current;
            const got = await act.settleLeftovers(r, to, deps);
            if (got.outcome === 'refused') setNotice('act_refund_failed');
            noteShort(got, to);
            return got.record;
          }
          default:
            return r;
        }
      });
    };
    run();
    const timer = window.setInterval(run, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [record, price, dest, deps, step, noteShort]);

  // QNet Wallet answered the open request.
  useEffect(() => {
    if (!record || record.stage !== 'linkOpen' || session.state.phase !== 'done') return;
    const { answer, checkNumber, request } = session.state;
    void step(record, async (r) => {
      const next = await act.takeAnswer(r, answer, checkNumber, request, deps);
      if (next.stage === 'burnFinal') setNotice(endedNotice(answer));
      return next;
    });
  }, [record, session.state, deps, step]);

  // The request for the wallet's confirmation: a button on a phone, a QR code elsewhere (as the link request). A new
  // record asks once the page follows it, so its request is kept for it (useLinkSession's slot).
  const askWallet = useCallback((r: PaymentRecord, asQr: boolean) => {
    const request = act.reserveRequest(r);
    if (!request) return;
    setConfirmQr(asQr);
    void confirmStart('reserve', request);
  }, [confirmStart]);
  useEffect(() => {
    if (!askFor || !record || record.pub !== askFor.pub || record.stage !== 'walletConfirm') return;
    setAskFor(null);
    askWallet(record, askFor.qr);
  }, [askFor, record, askWallet]);

  // QNet Wallet answered the confirmation: its signed reservation is the record's hold (the address shows), or the record
  // that waited for it is deleted, its address never shown. A request that expired before any answer deletes it too. Each
  // is one storage step of its own (act.takeHold), whatever else the page is doing.
  const confirmState = confirm.state;
  useEffect(() => {
    if (!record || !CONFIRM_STAGES.has(record.stage)) return;
    const from = record;
    const follow = (next: PaymentRecord | null, said: MessageKey | null) => {
      setNotice(said);
      setRecord((current) => (current?.pub !== from.pub ? current : next));
    };
    if (confirmState.phase === 'done' && confirmTaken.current !== confirmState) {
      confirmTaken.current = confirmState;
      const { answer, request } = confirmState;
      void act.takeHold(from, answer, request, deps).then((got) => {
        follow(got.record, reserveNotice(answer, got.outcome));
        confirmCancel();
      });
    } else if (from.stage === 'walletConfirm' && confirmState.phase === 'failed' && confirmState.failure === 'expired' && confirmTaken.current !== confirmState) {
      confirmTaken.current = confirmState;
      void act.dropUnconfirmed(from, deps).then((next) => follow(next, 'link_expired'));
    }
  }, [record, confirmState, confirmCancel, deps]);

  // A request kept from before that this record no longer waits for is dropped.
  useEffect(() => {
    if (record === undefined) return;
    for (const s of [button, qr]) {
      const mine = record?.stage === 'linkOpen' && s === session;
      if (!mine && s.state.phase === 'waiting') s.cancel();
    }
    if ((!record || !CONFIRM_STAGES.has(record.stage)) && confirmState.phase === 'waiting') confirmCancel();
    const refunding = record?.stage === 'leftovers' || record?.stage === 'closing';
    if (!refunding && refundAsk.state.phase === 'waiting') refundAsk.cancel();
  }, [record, session, button, qr, confirmState, confirmCancel, refundAsk]);

  // QNet Wallet on this device shared its addresses: that wallet becomes the cabinet's, and its Solana address is
  // where what is left goes when it is the wallet the burn is for (refundDestination).
  const refundAnswer = refundAsk.state.phase === 'done' ? refundAsk.state.answer : null;
  useEffect(() => {
    if (refundAnswer?.status === 'ok' && refundAnswer.qnet && refundAnswer.solana) {
      choose({ qnet: refundAnswer.qnet, source: 'app', solana: refundAnswer.solana });
    }
  }, [refundAnswer, choose]);

  // What is left is read once when the page reaches it.
  useEffect(() => {
    if (record?.stage === 'leftovers' || record?.stage === 'closing') void act.readPayment(record.pub, deps).then((b) => b && setBalance(b));
  }, [record?.stage, record?.pub, deps]);

  // A registered wallet becomes the cabinet's wallet when none was chosen: the page confirmed it before it signed.
  const registered = record ? receiptOf(record) : null;
  const registeredWallet = registered?.qnet ?? null;
  useEffect(() => {
    if (ready && !choice && registeredWallet) choose({ qnet: registeredWallet, source: 'app' });
  }, [ready, choice, registeredWallet, choose]);

  // A button's step; `undefined` leaves the record as it is, null means the step deleted it.
  const withRecord = async (run: (r: PaymentRecord) => Promise<PaymentRecord | null | undefined>) => {
    if (!record || working) return;
    setWorking(true);
    setNotice(null);
    try {
      const next = await run(record);
      if (next === null) setNotice(record.burn ? 'act_returned' : 'act_closed');
      if (next !== undefined) setRecord(next);
    } finally {
      setWorking(false);
    }
  };

  // A payment address for the chosen wallet, which QNet Wallet confirms before the address shows.
  const start = async () => {
    if (setup.phase !== 'ready' || working || !choice || viewOnly) return;
    setNotice(null);
    // Only while every source of the chosen wallet says it has nothing (the burn reserves the wallet again, R6).
    if (!offer) return;
    setWorking(true);
    // No address before the network takes the payment key's owner bind: nothing could be registered with its burn.
    const open = await act.paymentOpen(choice.qnet, deps);
    if (open !== true) {
      setWorking(false);
      setNotice(open === null ? 'act_check_unavailable' : 'act_payment_not_open');
      return;
    }
    const created = await createPaymentKey({ wallet: choice.qnet });
    setWorking(false);
    if (!created) {
      setNotice('act_start_failed');
      return;
    }
    setRecord(created);
    setAskFor({ pub: created.pub, qr: !device?.phone });
  };

  const burn = () => withRecord(async (r) => {
    if (price === null || !mayBurn || choice === null) return undefined;
    // For the chosen wallet, whose every source the page has read (a reservation of this record for another wallet goes
    // first, act.burn), with its Solana address for the server's search of it.
    const result = await act.burn(r, price, deps, choice.qnet, choice.solana ?? null);
    refreshActivation();
    // The network asks another amount now: the page shows it, and the user presses Burn again.
    const quote = result.quote;
    if (result.outcome === 'price_changed' && quote) setSetup((s) => (s.phase === 'ready' ? { ...s, quote } : s));
    // The wallet's signed reservation is missing or too old for the server: QNet Wallet is asked again, the address stays.
    if (result.outcome === 'reconfirm') {
      setNotice(r.hold ? 'act_reserve_stale' : 'act_reconfirm');
      askWallet(result.record, !device?.phone);
    } else {
      setNotice(BURN_NOTICE[result.outcome]);
    }
    if (result.outcome === 'busy') await loadRecord(r.pub);
    return result.outcome === 'busy' ? undefined : result.record;
  });

  const openRequest = (asQr: boolean) => withRecord(async (r) => {
    const from = r.stage === 'linkOpen' ? await act.closeLink(r, deps) : r;
    const opened = await act.openLink(from, asQr, choice, deps);
    if (opened?.link) void (asQr ? qr : button).start('link', opened.link.request);
    return opened ?? from;
  });

  // A consent too old for the network (owner, 29.09): QNet Wallet is asked again at once, for the same burn, which keeps
  // its code; the request opens as the first one would (a button on a phone, a QR code elsewhere).
  const askAgain = () => withRecord(async (r) => {
    const back = await act.relink(r, deps);
    if (back.stage !== 'burnFinal') return back;
    const asQr = !device?.phone;
    const opened = await act.openLink(back, asQr, choice, deps);
    if (opened?.link) void (asQr ? qr : button).start('link', opened.link.request);
    return opened ?? back;
  });

  const retryRequest = () => {
    if (record?.link) void session.start('link', record.link.request);
  };

  const cancelRequest = () => withRecord(async (r) => {
    session.cancel();
    return act.closeLink(r, deps);
  });

  // Before a burn: what arrived goes back to the wallet, then the record goes (the `closing` step); a record still
  // waiting for QNet Wallet's confirmation is deleted at once. Not while a burn the page dropped may still have landed
  // (act.cancel): the page says it is still checking.
  const cancel = () => withRecord(async (r) => {
    if (r.stage === 'walletConfirm') confirmCancel();
    const next = await act.cancel(r, deps);
    if (next !== null && next.stage === r.stage && (next.dropped ?? []).length > 0) setNotice('act_burn_checking');
    return next;
  });

  const refund = (to: string) => withRecord(async (r) => {
    const result = await act.refund(r, to, deps);
    if (result.outcome === 'refused' || result.outcome === 'unavailable') setNotice('act_refund_failed');
    // Short of SOL: the page sends to this address by itself once the SOL arrives.
    if (result.outcome !== 'unavailable') typedDest.current = result.outcome === 'short' ? to : null;
    noteShort(result, to);
    return result.record;
  });

  // Asking QNet Wallet on this device for its Solana address, where what is left goes (phones and tablets only). An
  // answer for another wallet than the one the burn is for is refused by refundDestination.
  const pinned = record ? pinnedWallet(record) : null;
  const askedOther = refundAnswer?.status === 'ok' && !!refundAnswer.qnet && pinned !== null && refundAnswer.qnet !== pinned;
  const refundAskView = refundAsk.state.phase === 'idle' || refundAsk.state.phase === 'done' ? (
    <div className="cabinet-choice">
      {askedOther && <p className="activate-error" role="alert">{t('act_refund_other_wallet')}</p>}
      {refundAnswer && refundAnswer.status !== 'ok' && <p className="activate-note" role="status">{t(refusedAnswerText(refundAnswer))}</p>}
      <button type="button" className="qnet-button activate-primary" onClick={() => void refundAsk.start('connect')} disabled={working}>{t('wallet_ask_app')}</button>
    </div>
  ) : (
    <LinkWaiting
      state={refundAsk.state}
      qr={false}
      android={device?.android === true}
      onCancel={refundAsk.cancel}
      onRetry={() => void refundAsk.start('connect')}
    />
  );

  // The wallet's confirmation in QNet Wallet: the buttons that open the request, or the request while it is shown.
  // `onCancel`: ends what waits for it (the record at walletConfirm, else only the request).
  const confirmView = (r: PaymentRecord, onCancel: () => void) => (confirmState.phase === 'idle' || confirmState.phase === 'done' ? (
    <div className="cabinet-actions">
      <button type="button" className="qnet-button activate-primary" onClick={() => askWallet(r, !device?.phone)} disabled={!device || working}>
        {t(device?.phone ? 'act_link_open' : 'act_link_show_qr')}
      </button>
      {device?.phone && (
        <button type="button" className="activate-link-button" onClick={() => askWallet(r, true)} disabled={working}>{t('wallet_other_device')}</button>
      )}
    </div>
  ) : (
    <LinkWaiting
      state={confirmState}
      qr={confirmQr}
      android={device?.android === true}
      onShowQr={confirmQr ? undefined : () => askWallet(r, true)}
      onCancel={onCancel}
      onRetry={() => askWallet(r, confirmQr)}
    />
  ));

  let body: ReactNode;
  // Nothing is offered before every source of the wallet answered: a wallet with an activation never sees a new one for
  // a moment (the state card says what is being checked).
  if (!ready || record === undefined || supported === null) {
    body = null;
  } else if (!record && viewOnly) {
    // A typed address is only viewed: the wallet itself connects before an activation for it starts.
    body = <div className="activate-card"><ConnectFirst /></div>;
  } else if (!record && !offer) {
    // The wallet has a node, a burn, something on its way, or a source that did not answer: its state and next step;
    // nothing new starts here. The extension's answer given on this page stays in view instead of the state card.
    body = (
      <>
        {/* First in both branches, so the extension's answer stays when the wallet's state moves on. */}
        {extension && <ExtensionActivate key={choice?.qnet ?? ''} offer={false} onAnswered={() => setExtensionAnswered(true)} />}
        {/* Once the network lists the node, the step it is on (Link your phone, for a light node without one). */}
        {!extensionAnswered && (view.state === 'node' ? <NodeNext /> : <NoNode pending={view.state === 'recording'} overview />)}
      </>
    );
  } else if (!record) {
    const install = device && !device.phone && !extension ? installTarget(window.navigator) : null;
    // A super node: only the QNet extension on a computer activates it, and it runs on the user's own server.
    const superCard = !extensionHolds && (
      <div className="activate-card">
        <h3 className="activate-step">{t('act_super_title')}</h3>
        <p>{t('super_note')}</p>
        {install ? (
          <a href={install.href} className="qnet-button secondary" target={install.kind === 'store' ? '_blank' : undefined} rel="noopener noreferrer">{t('super_note_install')}</a>
        ) : (
          <Link href={`${GUIDE_HREF}?way=super`} className="qnet-button secondary">{t('super_note_guide')}</Link>
        )}
      </div>
    );
    // A light node from a one-time payment address, run in QNet Wallet.
    const paymentCard = phoneFlows ? (
      <div className="activate-card">
        <h3 className="activate-step">{t('act_payment_title')}</h3>
        <p className="cabinet-lead">{t('act_lead')}</p>
        <ol className="activate-facts">
          <li>{t('act_way_1')}</li>
          <li>{t('act_way_2')}</li>
          <li>{t(ACTIVATION_NETWORK === 'testnet' ? 'act_way_3_testnet' : 'act_way_3_mainnet')}</li>
          <li>{t('act_way_4')}</li>
          <li>{t('act_way_5')}</li>
        </ol>
        {!supported ? (
          <p className="activate-error" role="alert">{t('act_unsupported')}</p>
        ) : setup.phase === 'loading' ? (
          <p className="activate-status" aria-live="polite">{t('checking')}</p>
        ) : setup.phase === 'unavailable' ? (
          <div role="alert">
            <p className="activate-error">{t('act_price_unavailable')}</p>
            <button type="button" className="qnet-button secondary" onClick={() => void loadSetup()}>{t('try_again')}</button>
          </div>
        ) : setup.quote.phase !== 1 ? (
          <p>{t('act_no_burn_phase')}</p>
        ) : paymentClosed ? (
          <p className="activate-status">{t('act_payment_not_open')}</p>
        ) : (
          <>
            <p>{t('act_price', { price: number(setup.quote.cost) })}</p>
            <button type="button" className="qnet-button activate-primary" onClick={() => void start()} disabled={working || !device}>{t('act_start')}</button>
          </>
        )}
      </div>
    ) : !extensionHolds && (
      <div className="activate-card">
        <p>{t('act_phone_closed')}</p>
        {install && (
          <p className="activate-note">
            {t('act_get_extension')}{' '}
            <a href={install.href} target={install.kind === 'store' ? '_blank' : undefined} rel="noopener noreferrer">{t('act_get_extension_link')}</a>
          </p>
        )}
        {device?.phone && <Link href={`${GUIDE_HREF}?way=computer`} className="qnet-button secondary">{t('guide_show_computer')}</Link>}
      </div>
    );
    body = (
      <>
        {extensionHolds && <ExtensionActivate key={choice?.qnet ?? ''} offer onAnswered={() => setExtensionAnswered(true)} />}
        {/* An extension with another wallet: said, never offered for this one. */}
        {extension && !extensionHolds && <div className="activate-card"><p>{t('act_extension_other_wallet')}</p></div>}
        {/* The extension's card says it among its facts. */}
        {!extensionHolds && <p className="activate-note">{t('one_code')}</p>}
        {wantsSuper ? <>{superCard}{paymentCard}</> : <>{paymentCard}{superCard}</>}
      </>
    );
  } else {
    const stage = record.stage;
    const stopped = STOPPED_TEXT[stage];
    // The wallet the activation is for: the one QNet Wallet confirmed (or is asked to confirm), else the chosen one.
    const named = pinned ?? choice?.qnet ?? null;
    const confirming = (stage === 'funding' || stage === 'funded') && confirmState.phase !== 'idle' && confirmState.phase !== 'done';
    body = (
      <>
        {resumed && isUnfinished(record) && <p className="activate-note">{t('act_resume')}</p>}
        {stage === 'walletConfirm' && (
          <div className="activate-card">
            <h3 className="activate-step">{t('act_reserve_title')}</h3>
            {named && <p>{t('act_reserve_lead', { wallet: shortAddress(named) })}</p>}
            {confirmView(record, () => void cancel())}
          </div>
        )}
        {(stage === 'funding' || stage === 'funded') && price === null && (
          setup.phase === 'unavailable' ? (
            <div role="alert">
              <p className="activate-error">{t('act_price_unavailable')}</p>
              <button type="button" className="qnet-button secondary" onClick={() => void loadSetup()}>{t('try_again')}</button>
            </div>
          ) : (
            <p className="activate-status" aria-live="polite">{t(setup.phase === 'loading' ? 'checking' : 'act_no_burn_phase')}</p>
          )
        )}
        {(stage === 'funding' || stage === 'funded') && price !== null && (
          <Funding record={record} price={price} balance={balance} wallet={named} walletSolana={choice?.solana ?? null} phone={device?.phone === true} />
        )}
        {confirming && (
          <div className="activate-card">
            <h3 className="activate-step">{t('act_reserve_title')}</h3>
            {named && <p>{t('act_reserve_lead', { wallet: shortAddress(named) })}</p>}
            {confirmView(record, confirmCancel)}
          </div>
        )}
        {stage === 'funded' && price !== null && !confirming && (mayBurn ? (
          <div className="activate-card">
            <p>{t('act_burn_lead', { price: number(price) })}</p>
            {paymentClosed && <p className="activate-status">{t('act_payment_not_open')}</p>}
            <button type="button" className="qnet-button activate-primary" onClick={() => void burn()} disabled={working || paymentClosed}>{t('act_burn')}</button>
          </div>
        ) : choice === null || viewOnly ? (
          <div className="activate-card"><p>{t('act_no_wallet')}</p>{viewOnly && <ConnectFirst />}</div>
        ) : view.state === 'node' ? (
          <div className="activate-card"><p>{t('act_wallet_has_node')}</p></div>
        ) : <NoNode pending={view.state === 'recording'} />)}
        {(stage === 'burnSent' || stage === 'burnUnknown') && (
          <p className="activate-status" aria-live="polite">{t(stage === 'burnSent' ? 'act_burning' : 'act_burn_unknown')}</p>
        )}
        {stage === 'burnFailed' && (
          <div className="activate-card" role="alert">
            <p className="activate-error">{t('act_burn_failed')}</p>
            <button type="button" className="qnet-button secondary" onClick={() => void withRecord((r) => act.retryBurn(r, deps))}>{t('act_try_again')}</button>
          </div>
        )}
        {/* The burn stays in view to the end, with its code; none for a burn whose wallet's node came from another burn. */}
        {record.burn && !['burnSent', 'burnUnknown', 'burnFailed'].includes(stage) && <Receipt record={record} unused={stage === 'otherBurn'} />}
        {(stage === 'burnFinal' || stage === 'linkOpen') && (
          <div className="activate-card">
            <h3 className="activate-step">{t('act_link_title')}</h3>
            <p>{t('act_link_lead')}</p>
            {named && <p className="activate-note">{t('act_link_named', { wallet: shortAddress(named) })}</p>}
            {stage === 'burnFinal' || session.state.phase === 'idle' ? (
              <div className="cabinet-actions">
                <button type="button" className="qnet-button activate-primary" onClick={() => void openRequest(!device?.phone)} disabled={!device || working}>
                  {t(device?.phone ? 'act_link_open' : 'act_link_show_qr')}
                </button>
                {device?.phone && (
                  <button type="button" className="activate-link-button" onClick={() => void openRequest(true)} disabled={working}>{t('wallet_other_device')}</button>
                )}
                {stage === 'linkOpen' && <button type="button" className="qnet-button secondary" onClick={() => void cancelRequest()}>{t('cancel')}</button>}
              </div>
            ) : session.state.phase !== 'done' && (
              <LinkWaiting
                state={session.state}
                qr={record.link?.qr === true}
                android={device?.android === true}
                onShowQr={record.link?.qr ? undefined : () => void openRequest(true)}
                onCancel={() => void cancelRequest()}
                onRetry={retryRequest}
              />
            )}
          </div>
        )}
        {stage === 'consentVerified' && <AnswerCheck record={record} onAnswer={(matches) => void withRecord((r) => act.answerCheck(r, matches, deps))} />}
        {stopped && (
          <div className="activate-card" role="alert">
            <p className="activate-error">{t(stopped, { wallet: named ? shortAddress(named) : '' })}</p>
            {stage === 'consentStale' ? (
              <button type="button" className="qnet-button activate-primary" onClick={() => void askAgain()} disabled={!device || working}>{t('act_ask_again')}</button>
            ) : stage === 'mismatch' && (
              <button type="button" className="qnet-button secondary" onClick={() => void withRecord((r) => act.relink(r, deps))}>{t('act_relink')}</button>
            )}
          </div>
        )}
        {(stage === 'beneficiaryConfirmed' || stage === 'submitted' || stage === 'onChain') && (
          <p className="activate-status" aria-live="polite">{t('act_recording')}</p>
        )}
        {stage === 'submitted' && record.submit?.lastCode === 'bind_v2_pending' && <p className="activate-note">{t('act_bind_v2_pending')}</p>}
        {stage === 'refused' && (
          <div className="activate-card" role="alert">
            {record.submit?.lastCode === 'wallet_has_node' ? (
              <p className="activate-error">{t('act_refused_wallet_has_node')}</p>
            ) : (
              <>
                <p className="activate-error">{t('act_refused', { code: record.submit?.lastCode ?? 'refused' })}</p>
                <button type="button" className="qnet-button secondary" onClick={() => void withRecord((r) => act.resubmit(r, deps))}>{t('act_try_again')}</button>
              </>
            )}
          </div>
        )}
        {stage === 'otherBurn' && (
          <div className="activate-card" role="alert">
            <p className="activate-error">{t('act_other_burn')}</p>
          </div>
        )}
        {mayReturnLeftovers(record) && <LeftoversNow busy={working} onSend={() => void withRecord((r) => act.returnLeftovers(r, deps))} />}
        {(stage === 'leftovers' || stage === 'closing') && (
          <Leftovers
            pub={record.pub}
            short={short?.need ?? null}
            balance={balance}
            dest={record.refund?.dest ?? dest}
            expired={stage === 'closing' && record.burn === null && clock - record.createdAt >= KEY_LIFETIME_MS}
            empty={stage === 'closing' && record.network === 'mainnet' && balance !== null && act.leftoverPlan(balance, true) === null}
            ask={device?.phone ? refundAskView : null}
            busy={working}
            failed={notice === 'act_refund_failed'}
            onSend={(to) => void refund(to)}
            onLeave={() => void withRecord((r) => act.done(r, deps))}
          />
        )}
        {stage === 'done' && registered && <Registered nodeId={registered.nodeId} />}
        {mayCancel(record) && (
          <button type="button" className="activate-link-button" onClick={() => void cancel()} disabled={working}>{t('act_discard')}</button>
        )}
      </>
    );
  }

  // An ended activation of a wallet that has its node or its activation: the page offers no new payment address then.
  const shown: MessageKey | null = notice === 'act_closed' && !record && !offer ? 'act_closed_has_node' : notice;

  return (
    // Without a wallet the page shows only an unfinished activation of this browser; else My node asks for one first.
    <CabinetFrame tab="activate" open={record === undefined ? null : record !== null && isUnfinished(record)}>
      {body}
      {shown && shown !== 'act_refund_failed' && <p className="activate-note" aria-live="polite">{t(shown)}</p>}
    </CabinetFrame>
  );
}
