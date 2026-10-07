'use client';

// The ways to connect a wallet: QNet Wallet asked with a QNet Link `connect` request (docs/protocols/qnet-link-v1.md
// section 14): its button on this phone or tablet, or its QR code for another device; the QNet extension
// (qnet_requestAccounts), or where to get it on a computer without it; on a phone or tablet, where to get QNet Wallet
// when it is not installed yet; and an address typed here, only to look. An
// address from a QR request is marked as such (src/lib/cabinet/wallet-choice.ts). The first way offered is the one
// primary button.

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { t, type MessageKey } from '@/lib/texts';
import type { LinkAnswer } from '@/lib/qnet-link';
import { installTarget, isEonAddress } from '@/lib/qnet-provider';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

// What a `connect` answer that names no wallet says, as the answer's report (it came through the relay).
function answerText(answer: LinkAnswer): MessageKey {
  if (answer.status === 'rejected') return 'link_answer_rejected';
  return answer.error === 'NO_WALLET' ? 'link_answer_no_wallet' : 'link_answer_internal';
}

const buttonClass = (primary: boolean) => (primary ? 'qnet-button activate-primary' : 'qnet-button secondary');

export default function WalletChoice() {
  const { choose } = useCabinet();
  const { providerStatus, providerChannel, accounts, connect, connecting, error } = useWallet();
  const device = useDeviceKind();
  // The button on this device, and a request shown as a QR code: two sessions, never one.
  const button = useLinkSession({ slot: 'connect' });
  const qr = useLinkSession({ slot: 'connect-qr' });
  const [address, setAddress] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [askedExtension, setAskedExtension] = useState(false);
  const extension = providerStatus === 'available' && providerChannel === 'extension';

  // The extension's accounts once the visitor asked for them.
  useEffect(() => {
    if (askedExtension && accounts) choose({ qnet: accounts.qnet, source: 'extension', solana: accounts.solana });
  }, [askedExtension, accounts, choose]);

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

  const askExtension = () => {
    setAskedExtension(true);
    if (!accounts) void connect();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (!isEonAddress(value)) {
      setInvalid(true);
      return;
    }
    choose({ qnet: value, source: 'entered' });
  };

  const ask = () => {
    if (!device) return;
    if (device.phone) void button.start('connect');
    else void qr.start('connect');
  };

  const showQr = () => {
    button.cancel();
    void qr.start('connect');
  };

  // Known once the page runs in the browser.
  if (!device) return null;

  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const finished = active?.state.phase === 'done' && active.state.answer.status !== 'ok' ? active.state.answer : null;
  // A computer without the extension is told where to get it.
  const install = !extension && !device.phone ? installTarget(window.navigator) : null;

  const app = (
    <div className="cabinet-option">
      {!active || active.state.phase === 'idle' ? (
        <>
          <button type="button" className={buttonClass(!extension)} onClick={ask}>
            {t(device.phone ? 'connect_app_here' : 'connect_app_qr')}
          </button>
          <p className="activate-note">{t(device.phone ? 'connect_app_here_note' : 'connect_app_qr_note')}</p>
        </>
      ) : finished ? (
        <>
          <p className="activate-note" role="status">{t(answerText(finished))}</p>
          <button type="button" className="qnet-button secondary" onClick={active.cancel}>{t('start_again')}</button>
        </>
      ) : active.state.phase !== 'done' && (
        <LinkWaiting
          state={active.state}
          qr={active === qr}
          android={device.android}
          onShowQr={active === button ? showQr : undefined}
          onCancel={active.cancel}
          onRetry={active === qr ? () => void qr.start('connect') : () => void button.start('connect')}
        />
      )}
    </div>
  );

  const ext = extension ? (
    <div className="cabinet-option">
      <button type="button" className={buttonClass(true)} onClick={askExtension} disabled={connecting}>{t('connect_ext')}</button>
      <p className={connecting ? 'activate-status' : 'activate-note'} aria-live="polite">{t(connecting ? 'wallet_extension_waiting' : 'connect_ext_note')}</p>
      {askedExtension && error && <p className="activate-error" role="alert">{t('wallet_extension_failed')}</p>}
    </div>
  ) : install ? (
    <div className="cabinet-option">
      <p className="activate-note">{t('connect_get_ext')}</p>
      <a className="qnet-button secondary" href={install.href} target={install.kind === 'store' ? '_blank' : undefined} rel="noopener noreferrer">
        {t('act_get_extension_link')}
      </a>
    </div>
  ) : device.phone && (
    // A phone or tablet without QNet Wallet yet: the Wallet page says where to get it.
    <div className="cabinet-option">
      <p className="activate-note">{t('connect_get_app')}</p>
      <Link className="qnet-button secondary" href="/wallet">{t('connect_get_app_link')}</Link>
    </div>
  );

  return (
    <div className="cabinet-options">
      {extension ? ext : app}
      {extension ? app : ext}
      <form className="cabinet-option" onSubmit={submit} noValidate>
        <label className="cabinet-label" htmlFor="cabinet-address">{t('connect_view_title')}</label>
        <div className="cabinet-row">
          <input
            id="cabinet-address"
            className="cabinet-input activate-mono"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setInvalid(false);
            }}
            placeholder={t('wallet_enter_label')}
            aria-invalid={invalid}
            aria-describedby="cabinet-address-note"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="text"
          />
          <button type="submit" className="qnet-button secondary">{t('wallet_enter_submit')}</button>
        </div>
        <p className="activate-note" id="cabinet-address-note">{t('connect_view_note')}</p>
        {invalid && <p className="activate-error" role="alert">{t('wallet_enter_invalid')}</p>}
      </form>
    </div>
  );
}
