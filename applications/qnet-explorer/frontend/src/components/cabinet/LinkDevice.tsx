'use client';

// "Link a device" (unified plan flow C and the device switch, docs/protocols/qnet-link-v1.md section 14): a QNet Link
// `link` request without a burn, for the chosen wallet's node already on the chain. The device that confirms it runs
// the node; the one linked before it stops. Its button on this phone or tablet, or its QR code for another device; a
// QR request for a wallet the page learned from a QR answer carries the check number (section 14.4). The answer is
// QNet Wallet's report: the device rows follow the chain. `move`: a device is linked, and the card reads as moving the
// node to another device (the Device tab, beside Unlink the device); the request is the same.

import { useEffect, useRef } from 'react';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { t, type MessageKey } from '@/lib/texts';
import { isHeldWallet } from '@/lib/cabinet/wallet-choice';
import { formatCheckNumber, type LinkAnswer, type LinkDeviceRequest } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

// What an answer says, as QNet Wallet's report.
function answerKey(answer: LinkAnswer): MessageKey {
  if (answer.status === 'linked') return 'devices_linked_answer';
  if (answer.status === 'error' && answer.error) return `link_error_${answer.error}` as MessageKey;
  return 'link_answer_rejected';
}

export default function LinkDevice({ onLinked, move = false }: { onLinked: () => void; move?: boolean }) {
  const { choice, walletHash, phoneFlows } = useCabinet();
  const device = useDeviceKind();
  // The button on this device, and a request shown as a QR code: two sessions, never one.
  const button = useLinkSession({ slot: 'devices' });
  const qr = useLinkSession({ slot: 'devices-qr' });
  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const linked = active?.state.phase === 'done' && active.state.answer.status === 'linked';
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (linked) onLinkedRef.current();
  }, [linked]);

  // Until the site sends link requests, the way is the app's own Node tab: said in the card's own words, not as a note.
  if (!phoneFlows) {
    return (
      <div className="activate-card">
        <h3 className="activate-step">{t('action_link_device')}</h3>
        <p>{t('devices_link_closed')}</p>
      </div>
    );
  }
  if (!choice || !walletHash) return null;

  const request = (asQr: boolean): LinkDeviceRequest => ({ burnTx: null, walletHash, check: asQr && !isHeldWallet(choice) });
  const ask = () => {
    if (!device) return;
    if (device.phone) void button.start('link', request(false));
    else void qr.start('link', request(true));
  };
  const showQr = () => {
    button.cancel();
    void qr.start('link', request(true));
  };

  const done = active?.state.phase === 'done' ? active.state : null;
  const title: MessageKey = move ? 'devices_move_title' : 'action_link_device';
  const checked = done !== null && (done.request as LinkDeviceRequest | null)?.check === true && done.answer.status === 'linked';

  return (
    <div className="activate-card">
      <h3 className="activate-step">{t(title)}</h3>
      <p className="activate-note">{t(move ? 'devices_move_lead' : 'devices_link_lead')}</p>
      {!active || active.state.phase === 'idle' ? (
        <button type="button" className="qnet-button activate-primary" onClick={ask} disabled={!device}>{t(title)}</button>
      ) : done ? (
        <>
          <p className="activate-note" role="status">{t(answerKey(done.answer))}</p>
          {checked && <p className="activate-code">{t('devices_check', { number: formatCheckNumber(done.checkNumber) })}</p>}
          <button type="button" className="qnet-button secondary" onClick={active.cancel}>{t('start_again')}</button>
        </>
      ) : (
        <LinkWaiting
          state={active.state}
          qr={active === qr}
          android={device?.android === true}
          onShowQr={active === button ? showQr : undefined}
          onCancel={active.cancel}
          onRetry={active === qr ? () => void qr.start('link', request(true)) : () => void button.start('link', request(false))}
        />
      )}
    </div>
  );
}
