'use client';

// "Unlink the device" (owner, 30.09 and 04.10; docs/protocols/qnet-link-v1.md section 14, light-node-messages section 4).
// Once both genesis nodes take the wallet's own unbind (`unbind_wallet`) and a device runs the node, the wallet signs it:
// the QNet extension of this computer when it holds the chosen wallet (qnet_unlinkNodeDevice, as Move does), otherwise
// QNet Wallet with this wallet on any device through a QNet Link `unlink` request, its button on this phone or tablet or
// its QR code for another device; so a lost device is unlinked from here too. Before that, today's card: the `unlink`
// request that QNet Wallet on the device that runs the node confirms and signs with that device's key, and a lost device
// leaves when the node moves to another device. The network takes no unlink from this page alone. An answer is the
// wallet's report; the device rows follow the chain.

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/contexts/AppContext';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { t, type MessageKey } from '@/lib/texts';
import { failureKey, unlinkReport } from '@/lib/cabinet/extension-view';
import type { NodeStatusView } from '@/lib/cabinet/node-view';
import type { ClaimFailure, LinkAnswer, UnlinkRequest } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

// What QNet Wallet's answer says, as its report.
export function unlinkAnswerKey(answer: LinkAnswer): MessageKey {
  return unlinkReport(answer, 'app');
}

type ExtUnlink =
  | { phase: 'idle' }
  | { phase: 'waiting' }
  | { phase: 'done'; answer: LinkAnswer }
  | { phase: 'failed'; failure: ClaimFailure };

// Whether the wallet's own unbind is the way: both genesis nodes take it and the node names a device that runs it.
export function walletUnlink(status: NodeStatusView): boolean {
  const device = status.device ?? null;
  return status.features.includes('unbind_wallet') && device !== null && device.state !== 'unlinked';
}

export default function UnlinkDevice({ status, onUnlinked }: { status: NodeStatusView; onUnlinked: () => void }) {
  const { choice, walletHash, phoneFlows } = useCabinet();
  const { providerStatus, providerChannel, accounts, unlinkNodeDevice } = useWallet();
  const device = useDeviceKind();
  // The button on this device, and a request shown as a QR code: two sessions, never one.
  const button = useLinkSession({ slot: 'unlink' });
  const qr = useLinkSession({ slot: 'unlink-qr' });
  const [ext, setExt] = useState<ExtUnlink>({ phase: 'idle' });
  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const answered = (active?.state.phase === 'done' && active.state.answer.status === 'ok') || (ext.phase === 'done' && ext.answer.status === 'ok');
  const onUnlinkedRef = useRef(onUnlinked);
  onUnlinkedRef.current = onUnlinked;

  useEffect(() => {
    if (answered) onUnlinkedRef.current();
  }, [answered]);

  const wallet = walletUnlink(status);
  // The extension unlinks its own wallet's node only: offered when it is the wallet this page shows.
  const extension = wallet && choice !== null && providerStatus === 'available' && providerChannel === 'extension'
    && (choice.source === 'extension' || accounts?.qnet === choice.qnet);

  if (!phoneFlows && !extension) {
    return (
      <div className="activate-card">
        <h3 className="activate-step">{t(wallet ? 'unlink_title_wallet' : 'unlink_title')}</h3>
        <p>{t('unlink_closed')}</p>
      </div>
    );
  }
  if (!walletHash || !choice) return null;

  const withExtension = async () => {
    setExt({ phase: 'waiting' });
    const result = await unlinkNodeDevice(choice.qnet);
    setExt(result.ok ? { phase: 'done', answer: result.answer } : { phase: 'failed', failure: result.failure });
  };

  const request: UnlinkRequest = { walletHash };
  const ask = () => {
    if (!device) return;
    if (device.phone) void button.start('unlink', request);
    else void qr.start('unlink', request);
  };
  const showQr = () => {
    button.cancel();
    void qr.start('unlink', request);
  };

  const app = phoneFlows && (
    <div className="cabinet-choice">
      {!active || active.state.phase === 'idle' ? (
        <>
          <button type="button" className={`qnet-button ${extension ? 'secondary' : 'activate-primary'}`} onClick={ask} disabled={!device}>
            {t(wallet ? 'unlink_title_wallet' : 'unlink_button')}
          </button>
          {wallet && <p className="activate-note">{t('unlink_app_note')}</p>}
        </>
      ) : active.state.phase === 'done' ? (
        <>
          <p className={active.state.answer.status === 'ok' ? 'activate-result' : 'activate-note'} role="status">{t(unlinkAnswerKey(active.state.answer))}</p>
          <button type="button" className="qnet-button secondary" onClick={active.cancel}>{t('start_again')}</button>
        </>
      ) : (
        <LinkWaiting
          state={active.state}
          qr={active === qr}
          android={device?.android === true}
          onShowQr={active === button ? showQr : undefined}
          onCancel={active.cancel}
          onRetry={active === qr ? () => void qr.start('unlink', request) : () => void button.start('unlink', request)}
        />
      )}
    </div>
  );

  return (
    <div className="activate-card">
      <h3 className="activate-step">{t(wallet ? 'unlink_title_wallet' : 'unlink_title')}</h3>
      <p className="activate-note">{t(wallet ? 'unlink_lead_wallet' : 'unlink_lead')}</p>
      {extension && (
        <div className="cabinet-choice">
          {ext.phase === 'idle' && (
            <>
              <button type="button" className="qnet-button activate-primary" onClick={() => void withExtension()}>{t('unlink_with_extension')}</button>
              <p className="activate-note">{t('unlink_extension_note')}</p>
            </>
          )}
          {ext.phase === 'waiting' && <p className="activate-status" aria-live="polite">{t('wallet_extension_waiting')}</p>}
          {ext.phase === 'done' && (
            <p className={ext.answer.status === 'ok' ? 'activate-result' : 'activate-note'} role="status">{t(unlinkReport(ext.answer, 'extension'))}</p>
          )}
          {ext.phase === 'failed' && <p className="activate-error" role="alert">{t(failureKey(ext.failure, 'unlink'))}</p>}
          {(ext.phase === 'done' || ext.phase === 'failed') && (
            <button type="button" className="qnet-button secondary" onClick={() => setExt({ phase: 'idle' })}>{t('start_again')}</button>
          )}
        </div>
      )}
      {app}
      <p className="activate-note">{t(wallet ? 'unlink_lost_wallet' : 'unlink_lost')}</p>
    </div>
  );
}
