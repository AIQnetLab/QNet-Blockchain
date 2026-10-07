'use client';

// A QNet Link request while it is made, shown and waited for (docs/protocols/qnet-link-v1.md section 14.9): the
// button that opens QNet Wallet on this phone or tablet (on Android the intent: URL naming the app), or the QR code
// for another device. A request shown as a QR code is its own session: anyone who saw the code could answer it,
// so the page never treats its answer like the answer to its button, also when it is opened on this device with the
// link under the code (a tablet the page took for a computer, SITE-5). When QNet Wallet did not open (another app's
// browser keeps the link), the page says what to do (SITE-14). Every text is the cabinet's own.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LinkState } from '@/hooks/useLinkSession';
import { t } from '@/lib/texts';
import { androidIntentUrl } from '@/lib/qnet-link';
import { qrMatrix, qrPath } from '@/lib/qr';

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return <>{t('link_waiting', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</>;
}

// `small`: a second code beside a main one (the SOL of a payment address).
export function QrCode({ text, label, small = false }: { text: string; label: string; small?: boolean }) {
  const quiet = 4;
  const { d, size } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { d: qrPath(matrix, quiet), size: matrix.size + quiet * 2 };
  }, [text]);
  return (
    <svg className={small ? 'activate-qr activate-qr-small' : 'activate-qr'} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

// What the phone button opens: on Android the app by name, falling back to the link page; elsewhere the link itself,
// on its own host.
export function openHref(link: string, android: boolean): string {
  return (android && androidIntentUrl(link, link)) || link;
}

// After the button, the page is still shown this long: QNet Wallet did not open.
export const NOT_OPENED_MS = 2_500;

// The button that opens QNet Wallet, and the hint when it did not open: the page went on being shown, as in another
// app's browser that keeps the link to itself.
function OpenApp({ href }: { href: string }) {
  const [notOpened, setNotOpened] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const left = () => {
      if (document.visibilityState === 'hidden') window.clearTimeout(timer.current);
    };
    document.addEventListener('visibilitychange', left);
    window.addEventListener('pagehide', left);
    return () => {
      document.removeEventListener('visibilitychange', left);
      window.removeEventListener('pagehide', left);
      window.clearTimeout(timer.current);
    };
  }, []);
  const opened = () => {
    setNotOpened(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (document.visibilityState === 'visible') setNotOpened(true);
    }, NOT_OPENED_MS);
  };
  return (
    <>
      {/* A plain link (an intent: URL on Android), so the browser hands it to the system and the app. */}
      <a className="qnet-button activate-primary" href={href} onClick={opened}>{t('link_open_app')}</a>
      {notOpened && <p className="activate-error" role="status">{t('link_not_opened')}</p>}
    </>
  );
}

export default function LinkWaiting({
  state,
  qr,
  android,
  onShowQr,
  onCancel,
  onRetry,
}: {
  state: LinkState;
  // The request is shown as a QR code (a computer, or another device chosen on a phone).
  qr: boolean;
  android: boolean;
  // On a phone: leave the button for a new request shown as a QR code.
  onShowQr?: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (state.phase === 'starting') return <p className="activate-status" aria-live="polite">{t('link_preparing')}</p>;
  if (state.phase === 'failed') {
    const text = state.failure === 'rate_limited'
      ? t('link_rate_limited', { minutes: Math.max(1, Math.ceil((state.retryAfterS ?? 60) / 60)) })
      : t(`link_${state.failure}`);
    // An expired request is asked again with one tap, a new request with the same content (owner, 29.09).
    return (
      <>
        <p className="activate-error" role="alert">{text}</p>
        {state.failure === 'expired' ? (
          <button type="button" className="qnet-button activate-primary" onClick={onRetry}>{t('link_ask_again')}</button>
        ) : (
          <button type="button" className="qnet-button secondary" onClick={onRetry}>{t('start_again')}</button>
        )}
      </>
    );
  }
  if (state.phase !== 'waiting') return null;
  return (
    <div className="activate-waiting">
      {qr ? (
        <>
          <QrCode text={state.link} label={t('link_qr_label')} />
          <p>{t('link_scan')}</p>
          <p className="activate-note">{t('link_qr_private')}</p>
          {/* The same QR session on this device: its answer still needs what a QR answer needs (the check number). */}
          <a className="activate-link-button" href={openHref(state.link, android)}>{t('link_open_here')}</a>
        </>
      ) : (
        <>
          <OpenApp href={openHref(state.link, android)} />
          <p className="activate-note">{t('link_open_note')}</p>
          {onShowQr && (
            <button type="button" className="activate-link-button" onClick={onShowQr}>{t('wallet_other_device')}</button>
          )}
        </>
      )}
      <p className="activate-status" aria-live="polite"><Countdown until={state.expiresAt} /></p>
      <button type="button" className="qnet-button secondary" onClick={onCancel}>{t('cancel')}</button>
    </div>
  );
}
