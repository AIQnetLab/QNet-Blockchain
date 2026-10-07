'use client';

// Where a wallet without a node on the network stands, and the one thing to do next, in plain words (owner, 29.09;
// unified plan R1, R3 and R6): the state every source agrees on (src/lib/cabinet/wallet-activation.ts), never a fresh
// activation while any source knows of one or could not answer. A known burn shows its code first, then its next step
// (src/lib/cabinet/burn-next.ts): for a light node, its record on the QNet network, registered with QNet Wallet's fresh
// consent from any browser where the wallet is connected, a phone included (owner, 06.10), whichever way the burn was
// made (shared contract C4: a payment address's burn completed from the site's record, a burn from the wallet's own
// Solana address with that address's owner bind, which QNet Wallet signs; docs/protocols/qnet-link-v1.md section 14);
// a burn the QNet extension in this browser just made it records itself ("Record on the network" asks it again: its
// qnet_activateNode answers a wallet that has its activation without burning and queues the record, sections 10 and
// 14.10), with the phone's first steps while it waits, and the moment the network lists the node (owner, 30.09: the page
// moves on by itself; CabinetProvider reads the network every few seconds meanwhile) "Link your phone" in numbered steps
// with Link a device; for a super node, which only the QNet extension activates, its server with the node software
// (docs/operators/running-a-node.md), never a phone. A wallet with nothing anywhere is offered both node types, the
// super node through the extension only.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import { number, t, type MessageKey } from '@/lib/texts';
import { burnNext } from '@/lib/cabinet/burn-next';
import { consentBodyOf, ownBurnBodyOf, postConsent } from '@/lib/cabinet/consent-submit';
import { verifyConsent } from '@/lib/cabinet/consent-verify';
import { errorKey, failureKey } from '@/lib/cabinet/extension-view';
import { isUnfinished } from '@/lib/cabinet/flow';
import { RUNNING_A_NODE } from '@/lib/cabinet/guide';
import type { ConsentBody, SubmitBody, SubmitOutcome } from '@/lib/cabinet/registration';
import { TAB_HREF } from '@/lib/cabinet/tabs';
import { nextStep, type Check, type KnownBurn } from '@/lib/cabinet/wallet-activation';
import { walletHash, type ActivationErrorCode, type LinkAnswer, type LinkDeviceRequest } from '@/lib/qnet-link';
import { shortAddress } from '@/lib/qnet-provider';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import { useCabinet } from './CabinetProvider';
import ConnectFirst from './ConnectFirst';
import CopyButton from './CopyButton';
import LinkDevice from './LinkDevice';
import LinkWaiting from './LinkWaiting';
import { shownTime } from './NodeStatus';

// How long the page waits for the record before it offers to ask the extension again.
export const RECORD_AGAIN_MS = 3 * 60_000;
const TICK_MS = 15_000;
// A state that could not be read is read again this often by itself.
const UNKNOWN_RETRY_MS = 30_000;

type Ask = { phase: 'idle' } | { phase: 'waiting' } | { phase: 'asked'; at: number } | { phase: 'failed'; key: MessageKey };

const CHECK_TEXT: Record<Check, MessageKey> = {
  network: 'check_network',
  server: 'check_server',
  extension: 'check_extension',
  solana: 'check_solana',
};

function Step({ at, children }: { at: 'done' | 'now' | 'ahead'; children: ReactNode }) {
  return (
    <li className={`cabinet-check ${at}`} aria-current={at === 'now' ? 'step' : undefined}>
      {children}
      {at !== 'ahead' && <span className="cabinet-hidden-text">{t(at === 'done' ? 'progress_done' : 'progress_now')}</span>}
    </li>
  );
}

// The node of wallet `qnet` on its way to the QNet network. `since`: when the extension answered (the kept
// activation), else the page counts from when it first showed this; `burnFinal`: false while the burn is not final on
// Solana; `pending`: the network holds the registration and is recording it; `askAgain`: false for a registration the
// page did not see the extension make (a payment address, QNet Wallet), which the extension could not record again.
export function Recording({ qnet, since, burnFinal = true, pending = false, askAgain = true }: {
  qnet: string; since: number | null; burnFinal?: boolean; pending?: boolean; askAgain?: boolean;
}) {
  const { choice, view, keepActivation, refreshActivation } = useCabinet();
  const { providerStatus, providerChannel, accounts, activateNode } = useWallet();
  const [shown] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [ask, setAsk] = useState<Ask>({ phase: 'idle' });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const from = Math.max(since ?? shown, ask.phase === 'asked' ? ask.at : 0);
  const minutes = Math.floor(Math.max(0, now - from) / 60_000);
  const late = now - from >= RECORD_AGAIN_MS;
  const extension = providerStatus === 'available' && providerChannel === 'extension';
  // The extension records its own wallet's node only; a locked extension answers no accounts, and the wallet the page
  // took from it stands for it.
  const holds = extension && (accounts ? accounts.qnet === qnet : choice?.source === 'extension' && choice.qnet === qnet);

  const again = async () => {
    setAsk({ phase: 'waiting' });
    const result = await activateNode('light');
    refreshActivation();
    if (!result.ok) {
      setAsk({ phase: 'failed', key: failureKey(result.failure, 'activate') });
      return;
    }
    const answer = result.answer;
    keepActivation(answer);
    if (answer.status === 'error') setAsk({ phase: 'failed', key: errorKey(answer.error as ActivationErrorCode) });
    else if (answer.status === 'rejected') setAsk({ phase: 'failed', key: 'ext_failure_rejected' });
    else if (answer.qnet !== qnet) setAsk({ phase: 'failed', key: 'next_record_other_wallet' });
    else setAsk({ phase: 'asked', at: Date.now() });
  };

  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('next_record_title')}</h3>
      <ol className="cabinet-checks" aria-label={t('progress_label')}>
        <Step at={burnFinal ? 'done' : 'now'}>{t(burnFinal ? 'next_step_burn' : 'next_step_burn_pending')}</Step>
        <Step at={burnFinal ? 'now' : 'ahead'}>{t('next_step_record')}</Step>
        <Step at="ahead">{t('next_step_link')}</Step>
      </ol>
      {/* The extension's own record, or a registration the network holds (a payment address's too). */}
      <p className="activate-status" aria-live="polite">{t(pending || !askAgain ? 'registration_pending' : burnFinal ? 'next_recording' : 'ext_lead_pending')}</p>
      <p className="activate-note">{minutes < 1 ? t('next_waited_now') : t('next_waited', { minutes: number(minutes) })}</p>
      {view.networkDown && choice?.qnet === qnet && <p className="activate-note" role="status">{t('next_network_down')}</p>}
      {/* Asking again is the extension's own way: a browser without it waits for the network, and a burn that does not
          end up registered comes back with Continue in QNet Wallet. */}
      {late && askAgain && extension && (
        <div className="cabinet-choice">
          {holds ? (
            <>
              {/* Nothing is burned again only for a burn that is final; for one that is not, the extension checks it. */}
              <p>{t(burnFinal ? 'next_record_again_lead' : 'next_record_again_lead_pending')}</p>
              {ask.phase === 'waiting' ? (
                <p className="activate-status" aria-live="polite">{t('wallet_extension_waiting')}</p>
              ) : (
                <button type="button" className="qnet-button activate-primary" onClick={() => void again()}>{t('next_record_again')}</button>
              )}
            </>
          ) : (
            <p className="activate-note">{t('next_record_other_wallet')}</p>
          )}
          {ask.phase === 'failed' && <p className="activate-error" role="alert">{t(ask.key)}</p>}
        </div>
      )}
      {ask.phase === 'asked' && <p className="activate-result" role="status">{t('next_record_asked')}</p>}
      {/* What needs no record goes on meanwhile; a payment address's registration runs on the phone that consented. */}
      {askAgain && (
        <>
          <p>{t('next_phone_ready')}</p>
          <ol className="activate-facts">
            <PhoneReady />
          </ol>
        </>
      )}
    </div>
  );
}

// The phone's first steps, which need no record: QNet Wallet on it, with this wallet's recovery phrase.
function PhoneReady() {
  return (
    <>
      <li>
        {t('next_link_1')} <Link href="/wallet">{t('guide_link_wallet')}</Link>
      </li>
      <li>{t('next_link_2')}</li>
    </>
  );
}

// Once the node is recorded: the steps so far with the phone's now, then the phone or tablet that runs it, in numbered
// steps. `onLinked`: Link a device right here (the Overview); otherwise, while the site sends link requests, a button to
// the Device tab, where it is.
export function LinkPhone({ onLinked }: { onLinked?: () => void }) {
  const { phoneFlows, viewOnly } = useCabinet();
  return (
    <>
      <div className="activate-card">
        <h3 className="activate-step">{t('next_link_title')}</h3>
        <ol className="cabinet-checks" aria-label={t('progress_label')}>
          <Step at="done">{t('next_step_burn')}</Step>
          <Step at="done">{t('next_step_record')}</Step>
          <Step at="now">{t('next_step_link')}</Step>
        </ol>
        <p className="activate-result" role="status">{t('next_link_lead')}</p>
        <ol className="activate-facts">
          <PhoneReady />
          <li>{t(phoneFlows ? 'next_link_3_qr' : 'next_link_3_app')}</li>
        </ol>
        {!onLinked && phoneFlows && !viewOnly && <Link href={TAB_HREF.device} className="qnet-button activate-primary">{t('action_link_device')}</Link>}
        <p className="activate-note">{t('next_link_done')}</p>
      </div>
      {onLinked && phoneFlows && (viewOnly ? <div className="activate-card"><ConnectFirst /></div> : <LinkDevice onLinked={onLinked} />)}
    </>
  );
}

// A wallet with a node, on a page that is not the Overview (Activate): the step it is on, right here (nextStep): Link your
// phone with one tap to the Device tab; otherwise the Overview, where I'm back is for an Offline device, with the words
// of the step (a new device waiting for its first answer, a running node, a super node's server, or a node whose status
// is not read yet).
export function NodeNext() {
  const { view } = useCabinet();
  const step = nextStep(view);
  if (step === 'link') return <LinkPhone />;
  const text: MessageKey = step === 'wake' ? 'next_offline' : step === 'answer' ? 'next_device_pending' : step === 'running' ? 'next_running'
    : step === 'server' ? 'next_super' : 'act_wallet_has_node';
  return (
    <div className="activate-card">
      <p>{t(text)}</p>
      <Link href={TAB_HREF.overview} className="qnet-button activate-primary">{t('next_open_overview')}</Link>
    </div>
  );
}

// A command to type on the server, with Copy.
function Command({ text }: { text: string }) {
  return (
    <>
      <pre className="activate-env">{text}</pre>
      <CopyButton value={text} />
    </>
  );
}

// The node software's repository and the branch its image is built from (docs/operators/running-a-node.md).
const NODE_REPOSITORY = 'https://github.com/AIQnetLab/QNet-Blockchain.git';
const NODE_BRANCH = 'testnet';

// A super node's server, after its burn (R3): every step, each with its commands (docs/operators/running-a-node.md: the
// ports, the image, the recovery phrase in a file, the settings with the code and the burn, the start and its check).
// Never a phone.
export function SuperNext({ code, burnTx, burnAmount }: { code: string; burnTx: string; burnAmount: number }) {
  const ports = 'sudo ufw allow 9876,9877,8001/tcp\nsudo ufw allow 10876/udp';
  const build = [
    `git clone ${NODE_REPOSITORY}`,
    'cd QNet-Blockchain',
    `git checkout ${NODE_BRANCH}`,
    'docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .',
  ].join('\n');
  const seed = 'printf %s "your recovery phrase words" > ./qnet_seed\nchmod 600 ./qnet_seed';
  const settings = `QNET_ACTIVATION_CODE=${code}\nQNET_BURN_TX_HASH=${burnTx}\nQNET_BURN_AMOUNT=${burnAmount}\nQNET_WALLET_SEED_FILE=/run/secrets/qnet_seed`;
  const command = [
    'docker run -d --name qnet-super --restart=always \\',
    '  --log-opt max-size=200m --log-opt max-file=50 \\',
    '  -e QNET_PRODUCTION=1 -e DOCKER_ENV=1 \\',
    `  -e QNET_ACTIVATION_CODE="${code}" \\`,
    `  -e QNET_BURN_TX_HASH="${burnTx}" \\`,
    `  -e QNET_BURN_AMOUNT="${burnAmount}" \\`,
    '  -v $(pwd)/qnet_seed:/run/secrets/qnet_seed:ro -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed \\',
    '  -p 8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876/udp \\',
    '  -v $(pwd)/qnet_data:/app/data qnet-production',
  ].join('\n');
  const check = 'curl -s http://localhost:8001/healthz';
  return (
    <div className="activate-next">
      <h4>{t('super_steps_title')}</h4>
      <ol className="activate-facts">
        <li>
          <p>{t('super_step_server')}</p>
          <Command text={ports} />
        </li>
        <li>
          <p>{t('super_step_build')}</p>
          <Command text={build} />
        </li>
        <li>
          <p>{t('super_step_seed')}</p>
          <Command text={seed} />
          <p className="activate-note">{t('ext_super_spelling')}</p>
        </li>
        <li>
          <p>{t('super_step_start')}</p>
          <Command text={settings} />
          <Command text={command} />
        </li>
        <li>
          <p>{t('super_step_check')}</p>
          <Command text={check} />
        </li>
      </ol>
      <p className="activate-note">{t('super_step_joined')}</p>
      <p>
        {t('ext_super_seed')}{' '}
        <a href={RUNNING_A_NODE} target="_blank" rel="noopener noreferrer">{t('ext_super_running')}</a>.
      </p>
    </div>
  );
}

// The code of a known burn, shown first (R1), with the burn it comes from.
function CodeCard({ burn }: { burn: KnownBurn }) {
  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('burned_title')}</h3>
      {burn.code ? (
        <p>
          <span className="activate-code">{burn.code}</span> <CopyButton value={burn.code} />
        </p>
      ) : (
        <p className="activate-note">{t('code_code_later')}</p>
      )}
      <p>{t(burn.nodeType === 'super' ? 'super_code_lead' : 'burned_light_lead')}</p>
      <p className="activate-note">{t(burn.nodeType === 'super' ? 'ext_type_super' : 'ext_type_light')} · {t('ext_amount', { amount: number(burn.burnAmount) })}</p>
    </div>
  );
}

// What an answer to the finishing request that is no usable consent says, as the wallet's report.
function answerNotice(answer: LinkAnswer, qnet: string): string {
  if (answer.status === 'linked') return t('act_linked_answer');
  if (answer.status === 'error' && answer.error) return t(`link_error_${answer.error}` as MessageKey);
  if (answer.status === 'ok') return t('act_mismatch', { wallet: shortAddress(qnet) });
  return t('link_answer_rejected');
}

// What the register route's answer says, unless it recorded the node (admitted or registered).
function outcomeNotice(outcome: SubmitOutcome): string | null {
  if (outcome.result === 'admitted' || outcome.result === 'registered') return null;
  if (outcome.result === 'stale') return t('act_stale');
  // The network takes the burn's owner bind only from its one-wallet-one-node gate on: no refusal, a calm note instead.
  if (outcome.code === 'bind_v2_pending') return null;
  if (outcome.code === 'wallet_has_node') return t('act_refused_wallet_has_node');
  return t('act_refused', { code: outcome.code });
}

// A light burn of the wallet with no node yet, in any browser where the wallet is connected, a phone included (C4): QNet
// Wallet's fresh consent to register the wallet's light node with this burn. For a payment address's burn (`burner`
// null) the site completes the registration from its record (the payment key's owner bind came with the burn); for a
// burn made from the wallet's own Solana address `burner`, the request names that address and QNet Wallet signs its
// owner bind with the same phrase's Solana key beside the consent, so the page posts the whole body. No key is needed
// here. The request names the wallet, and only that wallet's answer for this very burn (and burner) is taken.
export function FinishLight({ qnet, burn, burner = null }: { qnet: string; burn: KnownBurn; burner?: string | null }) {
  const { viewOnly, refreshActivation } = useCabinet();
  const device = useDeviceKind();
  const deps = useMemo(() => ({ fetchFn: (url: string, init?: RequestInit) => fetch(url, init) }), []);
  const session = useLinkSession({ slot: `finish.${burn.burnTx}`, consent24h: true, verify: verifyConsent });
  const [qr, setQr] = useState(false);
  const [posting, setPosting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [body, setBody] = useState<ConsentBody | SubmitBody | null>(null);
  // The answer already taken, so a render never posts it twice.
  const taken = useRef<LinkAnswer | null>(null);
  const named: LinkDeviceRequest = { burnTx: burn.burnTx, walletHash: walletHash(qnet), check: false };
  const request: LinkDeviceRequest = burner === null ? named : { ...named, burner };

  const post = useCallback(async (consent: ConsentBody | SubmitBody) => {
    setPosting(true);
    const got = await postConsent(consent, deps);
    setPosting(false);
    setOutcome(got);
    refreshActivation();
  }, [deps, refreshActivation]);

  const open = (asQr: boolean) => {
    setQr(asQr);
    setOutcome(null);
    setBody(null);
    void session.start('link', request);
  };

  const done = session.state.phase === 'done' ? session.state : null;
  const answer = done?.answer ?? null;
  const asked = (done?.request ?? null) as LinkDeviceRequest | null;
  const usable = answer?.status === 'ok' && answer.qnet === qnet && !!answer.consent && asked?.burnTx === burn.burnTx
    && (asked.burner ?? null) === burner;
  useEffect(() => {
    if (!answer || taken.current === answer || !usable || !answer.consent) return;
    taken.current = answer;
    let consent: ConsentBody | SubmitBody;
    try {
      consent = burner === null
        ? consentBodyOf(qnet, answer.consent, burn.burnTx, burn.burnAmount)
        : ownBurnBodyOf(qnet, answer.consent, burn.burnTx, burn.burnAmount, burner);
    } catch {
      setOutcome({ result: 'refused', code: 'bad_request' });
      return;
    }
    setBody(consent);
    void post(consent);
  }, [answer, usable, qnet, burn.burnTx, burn.burnAmount, burner, post]);

  if (viewOnly) return <div className="activate-card"><p>{t('burned_payment_lead')}</p><ConnectFirst /></div>;
  if (outcome && (outcome.result === 'admitted' || outcome.result === 'registered')) {
    return <Recording qnet={qnet} since={null} pending={outcome.result === 'registered'} askAgain={false} />;
  }
  const notice = answer && !usable ? answerNotice(answer, qnet) : outcome ? outcomeNotice(outcome) : null;
  const waiting = session.state.phase === 'starting' || session.state.phase === 'waiting' || session.state.phase === 'failed';
  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('act_link_title')}</h3>
      <p>{t('burned_payment_lead')}</p>
      {notice && <p className="activate-error" role="alert">{notice}</p>}
      {outcome?.result === 'retry' && outcome.code === 'bind_v2_pending' && <p className="activate-note">{t('act_bind_v2_pending')}</p>}
      {posting ? (
        <p className="activate-status" aria-live="polite">{t('act_recording')}</p>
      ) : outcome?.result === 'retry' && body ? (
        <button type="button" className="qnet-button activate-primary" onClick={() => void post(body)}>{t('try_again')}</button>
      ) : waiting ? (
        <LinkWaiting
          state={session.state}
          qr={qr}
          android={device?.android === true}
          onShowQr={qr ? undefined : () => open(true)}
          onCancel={session.cancel}
          onRetry={() => open(qr)}
        />
      ) : (
        <div className="cabinet-actions">
          <button type="button" className="qnet-button activate-primary" onClick={() => open(!device?.phone)} disabled={!device}>
            {t(device?.phone ? 'act_link_open' : 'act_link_show_qr')}
          </button>
          {device?.phone && <button type="button" className="activate-link-button" onClick={() => open(true)}>{t('wallet_other_device')}</button>}
        </div>
      )}
    </div>
  );
}

// A burn the wallet has, with no node on the network yet: its code, then the next step of its node type and way
// (burnNext): a super node's server; a payment burn this browser holds goes on in the Activate tab; any other light burn
// is registered with QNet Wallet from this browser, whatever it is; only a burn the extension here just made and
// records itself waits for it.
function Burned({ burn, qnet }: { burn: KnownBurn; qnet: string }) {
  const { activation, choice } = useCabinet();
  const { providerStatus, providerChannel, accounts } = useWallet();
  const records = usePaymentRecords();
  const here = (records ?? []).some((r) => isUnfinished(r) && r.burn?.tx === burn.burnTx && r.stage !== 'closing');
  const extension = providerStatus === 'available' && providerChannel === 'extension'
    && (accounts ? accounts.qnet === qnet : choice?.source === 'extension' && choice.qnet === qnet);
  const next = burnNext(burn, {
    here, solana: choice?.qnet === qnet ? choice.solana ?? null : null, extensionRecords: extension && activation?.burnTx === burn.burnTx,
  });
  return (
    <>
      <CodeCard burn={burn} />
      {next.step === 'server' ? (
        burn.code && <div className="activate-card"><SuperNext code={burn.code} burnTx={burn.burnTx} burnAmount={burn.burnAmount} /></div>
      ) : next.step === 'resume' ? (
        <div className="activate-card">
          <p>{t('next_resume')}</p>
          <Link href={TAB_HREF.activate} className="qnet-button activate-primary">{t('code_continue')}</Link>
        </div>
      ) : next.step === 'finish' ? (
        <FinishLight qnet={qnet} burn={burn} burner={next.burner} />
      ) : (
        <Recording qnet={qnet} since={activation?.burnTx === burn.burnTx ? activation.at : null} />
      )}
    </>
  );
}

// A state that could not be read: which check did not answer, Try again, and a read again every half minute.
function Unknown({ missing, update }: { missing: Check[]; update: boolean }) {
  const { refreshActivation } = useCabinet();
  useEffect(() => {
    const timer = window.setInterval(refreshActivation, UNKNOWN_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [refreshActivation]);
  return (
    <div className="activate-card" role="alert">
      {missing.map((check) => <p key={check} className="activate-error">{t(CHECK_TEXT[check])}</p>)}
      {update && <p>{t('state_update_extension')}</p>}
      <p>{t('state_unknown')}</p>
      <button type="button" className="qnet-button secondary" onClick={refreshActivation}>{t('try_again')}</button>
      <p className="activate-note">{t('state_retry_note')}</p>
    </div>
  );
}

// A section's card for a wallet without a node on the QNet network (R1): the state every source agrees on, with its
// next step; the two node types only when nothing is known anywhere (R2), the super node activated only in the QNet
// extension. `pending`: the light registration the network is recording (the state says so too). `overview`: the card
// is on the Overview, which shows the activation's details itself.
export function NoNode({ pending, overview = false }: { pending: boolean; overview?: boolean }) {
  const { choice, viewOnly, view } = useCabinet();
  if (!choice) return null;
  const card = (children: ReactNode, alert = false) => <div className="activate-card" role={alert ? 'alert' : undefined}>{children}</div>;
  switch (view.state) {
    case 'loading':
      return <p className="activate-status" aria-live="polite">{t('state_loading')}</p>;
    case 'locked':
      return card(<p>{t(view.lockedBy === 'not_connected' ? 'state_not_connected' : 'state_locked')}</p>);
    case 'unknown':
      return <Unknown missing={view.missing} update={view.extensionUpdate} />;
    case 'reserved':
      return card(view.here ? (
        <>
          <p>{t('state_reserved_here')}</p>
          <Link href={TAB_HREF.activate} className="qnet-button activate-primary">{t('code_continue')}</Link>
        </>
      ) : <p>{t('state_reserved', { time: shownTime(view.until) })}</p>);
    case 'sending':
      return card(<p className="activate-status" aria-live="polite">{t('state_sending')}</p>);
    case 'burned':
      if (!view.burn) return card(<p>{t('state_unusable')}</p>, true);
      // The code and its next step are the Overview's; the other sections point there.
      if (!overview) {
        return card(
          <>
            <p>{t(view.burn.nodeType === 'super' ? 'next_super' : 'act_has_activation')}</p>
            <Link href={TAB_HREF.overview} className="qnet-button secondary">{t('next_open_overview')}</Link>
          </>,
        );
      }
      return <Burned burn={view.burn} qnet={choice.qnet} />;
    case 'recording':
      return (
        <>
          {overview && view.burn && <CodeCard burn={view.burn} />}
          <Recording qnet={choice.qnet} since={null} pending askAgain={view.burn?.way === 'extension'} />
        </>
      );
    case 'none':
      return card(
        <>
          <p>{t('no_node')}</p>
          {viewOnly ? <ConnectFirst /> : (
            <div className="cabinet-actions">
              <Link href={`${TAB_HREF.activate}?type=light`} className="qnet-button activate-primary">{t('action_activate_light')}</Link>
              <Link href={`${TAB_HREF.activate}?type=super`} className="qnet-button secondary">{t('action_activate_super')}</Link>
            </div>
          )}
          <p className="activate-note">{t('no_node_super_where')}</p>
          <p className="activate-note">{t('one_code')}</p>
        </>,
      );
    default:
      // A node on the network: its section shows it.
      return null;
  }
}
