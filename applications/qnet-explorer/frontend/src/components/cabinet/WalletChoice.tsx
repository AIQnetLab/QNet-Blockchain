'use client';

// My node's connect card before a wallet (owner, 20.10): one main action by device, the header's Connect wallet too
// (useConnectWallet). On a computer it asks the QNet extension (qnet_requestAccounts), or without the extension opens
// its store page; on a phone or tablet it asks QNet Wallet with a QNet Link `connect` request
// (docs/protocols/qnet-link-v1.md section 14), whose button then opens the app. Under it the other ways as text
// actions: QNet Wallet on a phone by QR code (a computer); where to get QNet Wallet, and the extension when this browser
// has it (a phone or tablet). A request in progress takes the main action's place. An address from a QR request is
// marked as such (src/lib/cabinet/wallet-choice.ts). View by address, only to look, sits apart (ViewByAddress).

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Action from '@/components/ui/Action';
import { Answered, Failed, Waiting } from '@/components/ui/RequestState';
import { useConnectWallet } from '@/components/wallet/useConnectWallet';
import { useWallet } from '@/contexts/AppContext';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { APP_CONNECT_EVENT, takeAppConnect } from '@/lib/cabinet/connect-card';
import { t, type MessageKey } from '@/lib/texts';
import type { LinkAnswer } from '@/lib/qnet-link';
import { isEonAddress, type ConnectWay } from '@/lib/qnet-provider';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

// What a `connect` answer that names no wallet says, as the answer's report (it came through the relay).
function answerText(answer: LinkAnswer): MessageKey {
  if (answer.status === 'rejected') return 'link_answer_rejected';
  return answer.error === 'NO_WALLET' ? 'link_answer_no_wallet' : 'link_answer_internal';
}

// The main action's label and the line under it, by the way of this device.
function mainWords(way: Exclude<ConnectWay, { kind: 'wait' }>): [MessageKey, MessageKey] {
  if (way.kind === 'app') return ['connect_app_here', 'connect_app_here_note'];
  if (way.kind === 'extension') return ['connect_ext', 'connect_ext_note'];
  return ['connect_get_ext_link', way.store ? 'connect_get_ext' : 'connect_get_ext_other'];
}

export default function WalletChoice() {
  const { choose } = useCabinet();
  const { providerStatus, providerChannel } = useWallet();
  const device = useDeviceKind();
  const { way, waiting, failed, run, askExtension } = useConnectWallet();
  // The request on this device, and a request shown as a QR code: two sessions, never one.
  const button = useLinkSession({ slot: 'connect' });
  const qr = useLinkSession({ slot: 'connect-qr' });
  const extension = providerStatus === 'available' && providerChannel === 'extension';

  // A `connect` answer that names a wallet chooses it, with the Solana address it shares.
  const buttonState = button.state;
  const qrState = qr.state;
  useEffect(() => {
    if (buttonState.phase === 'done' && buttonState.answer.status === 'ok' && buttonState.answer.qnet && buttonState.answer.solana) {
      choose({ qnet: buttonState.answer.qnet, source: 'app', solana: buttonState.answer.solana });
    }
  }, [buttonState, choose]);
  useEffect(() => {
    if (qrState.phase === 'done' && qrState.answer.status === 'ok' && qrState.answer.qnet && qrState.answer.solana) {
      choose({ qnet: qrState.answer.qnet, source: 'app-qr', solana: qrState.answer.solana });
    }
  }, [qrState, choose]);

  // QNet Wallet's request on this device, asked by Connect wallet here or in the header (askAppConnect): started now, or
  // once this card shows.
  const startHere = button.start;
  const stopQr = qr.cancel;
  useEffect(() => {
    const take = () => {
      if (!takeAppConnect()) return;
      stopQr();
      void startHere('connect');
    };
    take();
    window.addEventListener(APP_CONNECT_EVENT, take);
    return () => window.removeEventListener(APP_CONNECT_EVENT, take);
  }, [startHere, stopQr]);

  const showQr = () => {
    button.cancel();
    void qr.start('connect');
  };

  // Known once the page runs in the browser and the wallet is detected.
  if (!device || way.kind === 'wait') return null;

  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const finished = active?.state.phase === 'done' && active.state.answer.status !== 'ok' ? active.state.answer : null;

  let main: ReactNode;
  if (active) {
    main = finished ? (
      <Answered action={{ label: t('start_again'), onClick: active.cancel }}>{t(answerText(finished))}</Answered>
    ) : active.state.phase !== 'done' && (
      <LinkWaiting
        state={active.state}
        qr={active === qr}
        android={device.android}
        onShowQr={active === button ? showQr : undefined}
        onCancel={active.cancel}
        onRetry={active === qr ? () => void qr.start('connect') : () => void button.start('connect')}
      />
    );
  } else if (waiting) {
    main = <Waiting>{t('wallet_extension_waiting')}</Waiting>;
  } else {
    const [label, note] = mainWords(way);
    main = (
      <>
        {way.kind === 'install'
          ? <Action kind="solid" href={way.href} external={way.store}>{t(label)}</Action>
          : <Action kind="solid" onClick={run}>{t(label)}</Action>}
        <p className="note">{t(note)}</p>
      </>
    );
  }

  // The other ways, while nothing is asked: never an extension offer on a phone or tablet.
  let others: ReactNode = null;
  if (!active && !waiting) {
    others = device.phone ? (
      <>
        <Action href="/wallet">{t('connect_get_app_link')}</Action>
        {extension && <Action onClick={askExtension}>{t('connect_ext')}</Action>}
      </>
    ) : (
      <Action onClick={showQr}>{t('connect_app_qr')}</Action>
    );
  }

  return (
    <>
      <div className="cab-connect-main">
        {main}
        {failed && <Failed>{t('wallet_extension_failed')}</Failed>}
      </div>
      {others && <div className="cab-connect-alt">{others}</div>}
    </>
  );
}

// View by address: an address typed only to look, a view, never a connected wallet (CabinetProvider viewAddress).
export function ViewByAddress() {
  const { viewAddress } = useCabinet();
  const [address, setAddress] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (!isEonAddress(value)) {
      setInvalid(true);
      return;
    }
    viewAddress(value);
  };

  return (
    <form className="cab-view-by" onSubmit={submit} noValidate>
      <label className="label" htmlFor="cabinet-address">{t('connect_view_title')}</label>
      <p className="note" id="cabinet-address-note">{t('connect_view_note')}</p>
      <div className="cab-field-row">
        <input
          id="cabinet-address"
          className="field mono"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setInvalid(false);
          }}
          placeholder={t('wallet_enter_label')}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'cabinet-address-note cabinet-address-error' : 'cabinet-address-note'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="text"
        />
        <button type="submit" className="btn btn-text">{t('wallet_enter_submit')}</button>
      </div>
      {invalid && <p className="cab-field-error" id="cabinet-address-error" role="alert">{t('wallet_enter_invalid')}</p>}
    </form>
  );
}
