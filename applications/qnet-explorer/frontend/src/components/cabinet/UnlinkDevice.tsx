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
import Action from '@/components/ui/Action';
import { Answered, Failed, Waiting } from '@/components/ui/RequestState';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { t, type MessageKey } from '@/lib/texts';
import { failureKey, unlinkReport } from '@/lib/cabinet/extension-view';
import type { NodeStatusView } from '@/lib/cabinet/node-view';
import type { ClaimFailure, LinkAnswer, UnlinkRequest } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';
import { ActionBlock } from './parts';

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
  const { choice, walletHash, viewOnly, phoneFlows } = useCabinet();
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

  // An address only viewed is never offered an unlink.
  if (viewOnly) return null;
  if (!phoneFlows && !extension) return <ActionBlock title={t(wallet ? 'unlink_title_wallet' : 'unlink_title')}><p>{t('unlink_closed')}</p></ActionBlock>;
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

  // Unlinking is never the solid action: it is not the step to do now.
  const app = phoneFlows && (
    <div className="cab-move-way">
      {!active || active.state.phase === 'idle' ? (
        <>
          <Action kind="text" onClick={ask} disabled={!device}>{t(wallet ? 'unlink_title_wallet' : 'unlink_button')}</Action>
          {wallet && <p className="note">{t('unlink_app_note')}</p>}
        </>
      ) : active.state.phase === 'done' ? (
        <Answered action={{ label: t('start_again'), onClick: active.cancel }}>{t(unlinkAnswerKey(active.state.answer))}</Answered>
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

  const again = { label: t('start_again'), onClick: () => setExt({ phase: 'idle' }) };
  return (
    <ActionBlock title={t(wallet ? 'unlink_title_wallet' : 'unlink_title')}>
      <p>{t(wallet ? 'unlink_lead_wallet' : 'unlink_lead')}</p>
      {extension && (
        <div className="cab-move-way">
          {ext.phase === 'idle' && (
            <>
              <Action kind="text" onClick={() => void withExtension()}>{t('unlink_with_extension')}</Action>
              <p className="note">{t('unlink_extension_note')}</p>
            </>
          )}
          {ext.phase === 'waiting' && <Waiting>{t('wallet_extension_waiting')}</Waiting>}
          {ext.phase === 'done' && <Answered action={again}>{t(unlinkReport(ext.answer, 'extension'))}</Answered>}
          {ext.phase === 'failed' && <Failed action={again}>{t(failureKey(ext.failure, 'unlink'))}</Failed>}
        </div>
      )}
      {app}
      <p className="note">{t(wallet ? 'unlink_lost_wallet' : 'unlink_lost')}</p>
    </ActionBlock>
  );
}
