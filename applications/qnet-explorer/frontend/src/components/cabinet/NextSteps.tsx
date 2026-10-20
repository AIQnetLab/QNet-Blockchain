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
import Action from '@/components/ui/Action';
import Copy from '@/components/ui/Copy';
import { Answered, Failed, Waiting } from '@/components/ui/RequestState';
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
import { superNodeId, walletHash, type ActivationErrorCode, type LinkAnswer, type LinkDeviceRequest } from '@/lib/qnet-link';
import { shortAddress } from '@/lib/qnet-provider';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import { useCabinet } from './CabinetProvider';
import LinkDevice from './LinkDevice';
import LinkWaiting from './LinkWaiting';
import { shownTime } from './NodeStatus';
import { Group, Next, Notes } from './parts';

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

// The node of wallet `qnet` on its way to the QNet network. `since`: when the extension answered (the kept
// activation), else the page counts from when it first showed this; `burnFinal`: false while the burn is not final on
// Solana; `pending`: the network holds the registration and is recording it; `askAgain`: false for a registration the
// page did not see the extension make (a payment address, QNet Wallet), which the extension could not record again.
export function Recording({ qnet, since, burnFinal = true, pending = false, askAgain = true }: {
  qnet: string; since: number | null; burnFinal?: boolean; pending?: boolean; askAgain?: boolean;
}) {
  const { choice, viewOnly, view, keepActivation, refreshActivation } = useCabinet();
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
    <Group title={t('next_record_title')}>
      {/* The extension's own record, or a registration the network holds (a payment address's too). */}
      <Waiting>{t(pending || !askAgain ? 'registration_pending' : burnFinal ? 'next_recording' : 'ext_lead_pending')}</Waiting>
      <p className="note">{minutes < 1 ? t('next_waited_now') : t('next_waited', { minutes: number(minutes) })}</p>
      {view.networkDown && choice?.qnet === qnet && <p className="note" role="status">{t('next_network_down')}</p>}
      {/* Asking again is the extension's own way: a browser without it waits for the network, and a burn that does not
          end up registered comes back with Continue in QNet Wallet. */}
      {late && askAgain && extension && !viewOnly && (
        <Next>
          {holds ? (
            <>
              {/* Nothing is burned again only for a burn that is final; for one that is not, the extension checks it. */}
              <p>{t(burnFinal ? 'next_record_again_lead' : 'next_record_again_lead_pending')}</p>
              {ask.phase === 'waiting' ? (
                <Waiting>{t('wallet_extension_waiting')}</Waiting>
              ) : (
                <div className="cab-next-act"><Action kind="solid" onClick={() => void again()}>{t('next_record_again')}</Action></div>
              )}
            </>
          ) : (
            <p className="note">{t('next_record_other_wallet')}</p>
          )}
          {ask.phase === 'failed' && <Failed>{t(ask.key)}</Failed>}
        </Next>
      )}
      {ask.phase === 'asked' && <Answered>{t('next_record_asked')}</Answered>}
      {/* What needs no record goes on meanwhile; a payment address's registration runs on the phone that consented. */}
      {askAgain && (
        <>
          <p>{t('next_phone_ready')}</p>
          <ol className="cab-list">
            <PhoneReady />
          </ol>
        </>
      )}
    </Group>
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
      <Group title={t('next_link_title')}>
        <p>{t('next_link_lead')}</p>
        <ol className="cab-list">
          <PhoneReady />
          <li>{t(phoneFlows ? 'next_link_3_qr' : 'next_link_3_app')}</li>
        </ol>
        {!onLinked && phoneFlows && !viewOnly && <div className="cab-next-act"><Action kind="solid" href={TAB_HREF.device}>{t('action_link_device')}</Action></div>}
        <p className="note">{t('next_link_done')}</p>
      </Group>
      {onLinked && phoneFlows && !viewOnly && <LinkDevice onLinked={onLinked} />}
    </>
  );
}

// A wallet with a node, on a page that is not the Overview (Activate): the step it is on, right here (nextStep): Link your
// phone with one tap to the Device tab; otherwise the Overview, where an Offline device's phone runs the node again, with
// the words of the step (a new device waiting for its first answer, a running node, a super node's server, or a node
// whose status is not read yet).
export function NodeNext() {
  const { view } = useCabinet();
  const step = nextStep(view);
  if (step === 'link') return <LinkPhone />;
  const text: MessageKey = step === 'offline' ? 'next_offline' : step === 'answer' ? 'next_device_pending' : step === 'running' ? 'next_running'
    : step === 'server' ? 'next_super' : 'act_wallet_has_node';
  return <Next action={<Action kind="solid" href={TAB_HREF.overview}>{t('next_open_overview')}</Action>}><p>{t(text)}</p></Next>;
}

// A command to type on the server, with Copy.
function Command({ text }: { text: string }) {
  return (
    <div className="cab-cmd">
      <pre>{text}</pre>
      <Copy value={text} label={t('copy')} />
    </div>
  );
}

// The node software's image, public and built for every release of the testnet branch (.github/workflows/deploy.yml):
// the server downloads it, no build there. Its own folder on the server holds the recovery phrase and the chain data.
const NODE_IMAGE = 'ghcr.io/aiqnetlab/qnet-production:latest';
const NODE_DIR = '/opt/qnet';
const NODE_CONTAINER = 'qnet-super';
// One IPv4 octet, 0 to 255, and the ranges that are not a public address, as bash regular expressions.
const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const PRIVATE_IPV4 = '^(0|10|127)\\.|^169\\.254\\.|^172\\.(1[6-9]|2[0-9]|3[01])\\.|^192\\.168\\.|^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|^(22[4-9]|2[3-5][0-9])\\.';

// A super node's server, after its burn (R3): every step with its commands, as the node and its image do them today
// (owner, 11.10; docs/operators/running-a-node.md): the server and its provider's firewall (the node's pre-flight cannot
// see a closed inbound port, and published ports bypass the host's own firewall), the recovery phrase in a root-only
// file typed with no shell history, the server's public IPv4 (written on the network at registration; peers then take
// this node's connections from that address only), the image pulled and started with absolute paths, the check (its
// height, its catching up, its activation and registration in the log, and what each failure means), a new release, and
// the timeline. Never a phone. `nodeId`: the super node's id the log names, when known.
export function SuperNext({ code, burnTx, burnAmount, nodeId = null }: { code: string; burnTx: string; burnAmount: number; nodeId?: string | null }) {
  const server = 'free -m\ntimedatectl show -p NTPSynchronized --value';
  const seed = [
    `install -d -m 700 ${NODE_DIR}`,
    `(umask 077; read -rs -p 'Recovery phrase: ' P; echo; printf %s "$P" > ${NODE_DIR}/qnet_seed; unset P)`,
  ].join('\n');
  // The address is committed at registration with no later change, so the step lists the server's own addresses and
  // takes only a dotted public IPv4 (no private, loopback, link-local, shared or multicast range), asked again until it
  // is one.
  const address = [
    "ip -4 -o addr show scope global | awk '{print $4}'",
    "while read -r -p 'Public IPv4 address of this server: ' QNET_IP; do",
    `  [[ $QNET_IP =~ ^(${OCTET}\\.){3}${OCTET}$ ]] && ! [[ $QNET_IP =~ ${PRIVATE_IPV4} ]] && break`,
    "  echo 'Not a public IPv4 address. Type it again.'; unset QNET_IP",
    'done',
  ].join('\n');
  // The limit counts the chain data already in /opt/qnet/data with the free space, so a start after an update keeps the
  // first one's limit (free space alone shrinks it by the data, and the node refuses new blocks at 95% of it).
  const start = [
    `docker pull ${NODE_IMAGE}`,
    `FREE_GB=$(df -BG --output=avail ${NODE_DIR} | tail -n 1 | tr -dc 0-9)`,
    `DATA_GB=$(du -s -BG ${NODE_DIR}/data 2>/dev/null | cut -f 1 | tr -dc 0-9)`,
    'QNET_GB=$(( (FREE_GB + ${DATA_GB:-0}) * 8 / 10 ))',
    `docker run -d --name ${NODE_CONTAINER} --restart=always \\`,
    '  --log-opt max-size=100m --log-opt max-file=10 \\',
    '  -e QNET_PRODUCTION=1 -e DOCKER_ENV=1 \\',
    '  -e QNET_PUBLIC_IP="${QNET_IP:?run the address step first}" \\',
    `  -e QNET_ACTIVATION_CODE="${code}" \\`,
    `  -e QNET_BURN_TX_HASH="${burnTx}" \\`,
    `  -e QNET_BURN_AMOUNT="${burnAmount}" \\`,
    '  -e QNET_MAX_STORAGE_GB="$QNET_GB" \\',
    `  -v ${NODE_DIR}/qnet_seed:/run/secrets/qnet_seed:ro -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed \\`,
    // The API on IPv4 only, as docs/operators/running-a-node.md and scripts/install-super-node.sh publish it: over IPv6
    // the container runtime's proxy hides the client's address, and the node would take a header that client wrote.
    '  -p 0.0.0.0:8001:8001 -p 9876:9876 -p 9877:9877 -p 10876:10876/udp \\',
    `  -v ${NODE_DIR}/data:/app/data ${NODE_IMAGE}`,
  ].join('\n');
  const check = [
    'curl -s http://localhost:8001/healthz',
    'curl -s http://localhost:8001/api/v1/sync/status',
    // A burn the network does not find and a refused start are logged untagged (activation_code_save_failed, and
    // blockchain_node_failed or start_failed with "Insufficient RAM"), so the filter names them too.
    `docker logs ${NODE_CONTAINER} 2>&1 | grep -E '\\[ACTIVATION\\]|\\[REG\\]|activation_code_save_failed|blockchain_node_failed|start_failed'`,
  ].join('\n');
  const update = `docker pull ${NODE_IMAGE}\ndocker stop -t 60 ${NODE_CONTAINER} && docker rm ${NODE_CONTAINER}`;
  return (
    <Group title={t('super_steps_title')}>
      <ol className="cab-cmds">
        <li>
          <p>{t('super_step_server')}</p>
          <Command text={server} />
          <p className="note">{t('super_step_firewall')}</p>
        </li>
        <li>
          <p>{t('super_step_seed')}</p>
          <Command text={seed} />
          <p className="note">{t('ext_super_spelling')}</p>
          <p className="note">{t('super_step_dedicated')}</p>
        </li>
        <li>
          <p>{t('super_step_ip')}</p>
          <Command text={address} />
        </li>
        <li>
          <p>{t('super_step_start')}</p>
          <Command text={start} />
        </li>
        <li>
          <p>{t('super_step_check')}</p>
          <Command text={check} />
          {nodeId && <p className="note">{t('super_step_node_id', { id: nodeId })}</p>}
          <p className="note">{t('super_step_errors')}</p>
        </li>
        <li>
          <p>{t('super_step_update')}</p>
          <Command text={update} />
        </li>
      </ol>
      <Notes>
        <p className="note">{t('super_step_joined')}</p>
        <p className="note">
          {t('ext_super_seed')}{' '}
          <a href={RUNNING_A_NODE} target="_blank" rel="noopener noreferrer">{t('ext_super_running')}</a>.
        </p>
      </Notes>
    </Group>
  );
}

// The code of a known burn, shown first (R1), with the burn it comes from.
function CodeCard({ burn }: { burn: KnownBurn }) {
  return (
    <Group title={t('burned_title')}>
      {burn.code ? (
        <p className="ent-copy cab-code-line">
          <span className="ent cab-code">{burn.code}</span>
          <Copy value={burn.code} />
        </p>
      ) : (
        <p className="note">{t('code_code_later')}</p>
      )}
      <p>{t(burn.nodeType === 'super' ? 'super_code_lead' : 'burned_light_lead')}</p>
      <p className="note">{t(burn.nodeType === 'super' ? 'ext_type_super' : 'ext_type_light')} · {t('ext_amount', { amount: number(burn.burnAmount) })}</p>
    </Group>
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

  if (viewOnly) return <Next><p>{t('burned_payment_lead')}</p></Next>;
  if (outcome && (outcome.result === 'admitted' || outcome.result === 'registered')) {
    return <Recording qnet={qnet} since={null} pending={outcome.result === 'registered'} askAgain={false} />;
  }
  const notice = answer && !usable ? answerNotice(answer, qnet) : outcome ? outcomeNotice(outcome) : null;
  const waiting = session.state.phase === 'starting' || session.state.phase === 'waiting' || session.state.phase === 'failed';
  return (
    <Group title={t('act_link_title')}>
      <p>{t('burned_payment_lead')}</p>
      {notice && <Failed>{notice}</Failed>}
      {outcome?.result === 'retry' && outcome.code === 'bind_v2_pending' && <p className="note">{t('act_bind_v2_pending')}</p>}
      {posting ? (
        <Waiting>{t('act_recording')}</Waiting>
      ) : outcome?.result === 'retry' && body ? (
        <div className="cab-next-act"><Action kind="solid" onClick={() => void post(body)}>{t('try_again')}</Action></div>
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
        <div className="actions cab-next-act">
          <Action kind="solid" onClick={() => open(!device?.phone)} disabled={!device}>{t(device?.phone ? 'act_link_open' : 'act_link_show_qr')}</Action>
          {device?.phone && <Action kind="text" onClick={() => open(true)}>{t('wallet_other_device')}</Action>}
        </div>
      )}
    </Group>
  );
}

// A burn the wallet has, with no node on the network yet: its code, then the next step of its node type and way
// (burnNext): a super node's server; a payment burn this browser holds goes on in the Activate tab; any other light burn
// is registered with QNet Wallet from this browser, whatever it is; only a burn the extension here just made and
// records itself waits for it.
function Burned({ burn, qnet }: { burn: KnownBurn; qnet: string }) {
  const { activation, choice, viewOnly, view } = useCabinet();
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
        burn.code && (
          <>
            {/* The network sees the server before its registration lands: it is catching up (best effort, never a no). */}
            {view.superConnected && <Answered>{t('super_connected')}</Answered>}
            <SuperNext code={burn.code} burnTx={burn.burnTx} burnAmount={burn.burnAmount} nodeId={superNodeId(qnet)} />
          </>
        )
      ) : next.step === 'resume' ? (
        <Next action={!viewOnly && <Action kind="solid" href={TAB_HREF.activate}>{t('code_continue')}</Action>}>
          <p>{t('next_resume')}</p>
        </Next>
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
    <Next alert action={<Action kind="text" onClick={refreshActivation}>{t('try_again')}</Action>}>
      {missing.map((check) => <p key={check} className="rq-failed">{t(CHECK_TEXT[check])}</p>)}
      {update && <p>{t('state_update_extension')}</p>}
      <p>{t('state_unknown')}</p>
      <p className="note">{t('state_retry_note')}</p>
    </Next>
  );
}

// A section's card for a wallet without a node on the QNet network (R1): the state every source agrees on, with its
// next step; the two node types only when nothing is known anywhere (R2), the super node activated only in the QNet
// extension. `pending`: the light registration the network is recording (the state says so too). `overview`: the card
// is on the Overview, which shows the activation's details itself.
export function NoNode({ pending, overview = false }: { pending: boolean; overview?: boolean }) {
  const { choice, viewOnly, view } = useCabinet();
  if (!choice) return null;
  const card = (children: ReactNode, alert = false, action?: ReactNode) => <Next alert={alert} action={action}>{children}</Next>;
  switch (view.state) {
    case 'loading':
      return <Waiting>{t('state_loading')}</Waiting>;
    case 'locked':
      return card(<p>{t(view.lockedBy === 'not_connected' ? 'state_not_connected' : 'state_locked')}</p>);
    case 'unknown':
      return <Unknown missing={view.missing} update={view.extensionUpdate} />;
    case 'reserved':
      return view.here
        ? card(<p>{t('state_reserved_here')}</p>, false, !viewOnly && <Action kind="solid" href={TAB_HREF.activate}>{t('code_continue')}</Action>)
        : card(<p>{t('state_reserved', { time: shownTime(view.until) })}</p>);
    case 'sending':
      return <Waiting>{t('state_sending')}</Waiting>;
    case 'burned':
      if (!view.burn) return card(<p>{t('state_unusable')}</p>, true);
      // The code and its next step are the Overview's; the other sections point there.
      if (!overview) {
        return card(<p>{t(view.burn.nodeType === 'super' ? 'next_super' : 'act_has_activation')}</p>, false, <Action href={TAB_HREF.overview}>{t('next_open_overview')}</Action>);
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
      return (
        <>
          {/* An address only viewed is offered no activation: only the wallet itself starts one. */}
          <Next
            action={!viewOnly && (
              <div className="actions">
                <Action kind="solid" href={`${TAB_HREF.activate}?type=light`}>{t('action_activate_light')}</Action>
                <Action href={`${TAB_HREF.activate}?type=super`}>{t('action_activate_super')}</Action>
              </div>
            )}
          >
            <p className="lead">{t('no_node')}</p>
          </Next>
          <Notes>
            <p className="note">{t('one_code')}</p>
            <p className="note">{t('no_node_super_where')}</p>
          </Notes>
        </>
      );
    default:
      // A node on the network: its section shows it.
      return null;
  }
}
