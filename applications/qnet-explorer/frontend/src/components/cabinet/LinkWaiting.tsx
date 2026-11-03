'use client';

// A QNet Link request while it is made, shown and waited for (docs/protocols/qnet-link-v1.md section 14.9): the
// button that opens QNet Wallet on this phone or tablet (on Android the intent: URL naming the app), or the QR code
// for another device. A request shown as a QR code is its own session: anyone who saw the code could answer it,
// so the page never treats its answer like the answer to its button, also when it is opened on this device with the
// link under the code (a tablet the page took for a computer). When QNet Wallet has not opened after a wait no normal
// hand-over reaches (another app's browser keeps the link), the page says what to do and keeps waiting. Every text is
// the cabinet's own.

import { useEffect, useMemo, useRef, useState } from 'react';
import Action from '@/components/ui/Action';
import { Failed, Waiting } from '@/components/ui/RequestState';
import type { LinkState } from '@/hooks/useLinkSession';
import { androidIntentUrl } from '@/lib/qnet-link';
import { qrMatrix, qrPath } from '@/lib/qr';
import { useI18n } from '@/i18n/client';

function Countdown({ until }: { until: number }) {
  const { rich } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  // The time in an element of its own, out of page translation: the words stay translated, the time keeps counting.
  return <>{rich('link_waiting', { time: <span className="num" translate="no">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</span> })}</>;
}

// A QR code: white with a 4-module quiet zone, drawn at `size` px so its box is reserved before it is drawn (the payment
// address 196, a request 168).
export function QrCode({ text, label, size = 168 }: { text: string; label: string; size?: number }) {
  const quiet = 4;
  const { d, modules } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { d: qrPath(matrix, quiet), modules: matrix.size + quiet * 2 };
  }, [text]);
  return (
    <svg className="cab-qr" width={size} height={size} viewBox={`0 0 ${modules} ${modules}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

// What the phone button opens: on Android the app by name, falling back to the link page; elsewhere the link itself,
// on its own host.
export function openHref(link: string, android: boolean): string {
  return (android && androidIntentUrl(link, link)) || link;
}

// After the button, the page is still shown this long before it says what to do if QNet Wallet has not opened: another
// app's built-in browser never hands the link on, so its visitor needs the way out soon. The hint is a condition, never a
// failure, and the request keeps waiting for the answer however long a slow phone's hand-over takes.
export const NOT_OPENED_MS = 6_000;

// The button that opens QNet Wallet, and the hint once the page went on being shown, as in another app's browser that
// keeps the link to itself. The request keeps waiting for the app's answer either way; the page leaving the screen
// means the app took the link, and the hint goes.
function OpenApp({ href }: { href: string }) {
  const { say } = useI18n();
  const [notOpened, setNotOpened] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const left = () => {
      if (document.visibilityState !== 'hidden') return;
      window.clearTimeout(timer.current);
      setNotOpened(false);
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
      <a className="btn btn-solid" href={href} onClick={opened}>{say('link_open_app')}</a>
      {notOpened && <p className="note" role="status">{say('link_not_opened')}</p>}
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
  const { t, say } = useI18n();
  if (state.phase === 'starting') return <Waiting>{t('link_preparing')}</Waiting>;
  if (state.phase === 'failed') {
    const text = state.failure === 'rate_limited'
      ? say('link_rate_limited', { minutes: Math.max(1, Math.ceil((state.retryAfterS ?? 60) / 60)) })
      : say(`link_${state.failure}`);
    // An expired request is asked again with one tap, a new request with the same content; its code's box
    // stays in place, empty.
    if (state.failure === 'expired') {
      return (
        <div className="cab-req">
          {qr && <div className="cab-req-gone" aria-hidden="true" />}
          <div className="cab-req-t">
            <p className="rq-failed" role="alert">{text}</p>
            <Action kind="solid" small onClick={onRetry}>{t('link_ask_again')}</Action>
          </div>
        </div>
      );
    }
    return <Failed action={{ label: t('start_again'), onClick: onRetry }}>{text}</Failed>;
  }
  if (state.phase !== 'waiting') return null;
  const wait = <Waiting action={{ label: t('cancel'), onClick: onCancel }}><Countdown until={state.expiresAt} /></Waiting>;
  if (qr) {
    return (
      <div className="cab-req">
        <figure className="cab-req-qr"><QrCode text={state.link} label={t('link_qr_label')} /></figure>
        <div className="cab-req-t">
          <p>{say('link_scan')}</p>
          <p className="note">{t('link_qr_private')}</p>
          {wait}
          {/* The same QR session on this device: its answer still needs what a QR answer needs (the check number). */}
          <a className="btn btn-text" href={openHref(state.link, android)}>{say('link_open_here')}</a>
        </div>
      </div>
    );
  }
  return (
    <div className="cab-req-phone">
      <OpenApp href={openHref(state.link, android)} />
      <p className="note">{say('link_open_note')}</p>
      {wait}
      {onShowQr && <button type="button" className="btn btn-text" onClick={onShowQr}>{t('wallet_other_device')}</button>}
    </div>
  );
}
