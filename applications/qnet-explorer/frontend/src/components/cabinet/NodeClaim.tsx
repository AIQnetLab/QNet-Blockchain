'use client';

// Move to wallet, in the Overview's node balance, for a light and for a super node (unified plan SITE-5 and SITE-7;
// owner, 29.09: it was a page of its own; owner, 12.10: through this site too, whichever way the wallet is connected
// here). The wallet signs the move of the node it is asked for (docs/protocols/light-node-messages.md section 4): the
// QNet extension of this computer when it holds the chosen wallet (qnet_claimNodeBalance with the node,
// docs/protocols/qnet-link-v1.md section 14.10), whose own window confirms it, otherwise QNet Wallet through a QNet Link
// `claim` request that names the wallet and the node (section 14.4), its button on this phone or tablet or its QR code
// for another device. Each way says what the wallet will show; its answer takes the way's place. An answer is the
// wallet's report; the balance the page shows comes from the QNet network.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWallet } from '@/contexts/AppContext';
import Action from '@/components/ui/Action';
import { EpochNumber } from '@/components/ui/EntityLink';
import { Answered, Failed, Waiting } from '@/components/ui/RequestState';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { rich } from '@/lib/rich';
import { t } from '@/lib/texts';
import { claimReport, failureKey, type ClaimVia } from '@/lib/cabinet/extension-view';
import { formatQnc } from '@/lib/cabinet/node-view';
import { walletHash, type ClaimFailure, type ClaimRequest, type LinkAnswer } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

type ExtClaim =
  | { phase: 'idle' }
  | { phase: 'waiting' }
  | { phase: 'done'; answer: LinkAnswer }
  | { phase: 'failed'; failure: ClaimFailure };

// The wallet's report in words; the epoch it moved up to is a link.
function reportText(answer: LinkAnswer, via: ClaimVia): ReactNode {
  const report = claimReport(answer, via);
  return rich(report.key, {
    amount: report.amountNano ? formatQnc(report.amountNano) : '',
    epoch: report.epoch ? <EpochNumber epoch={Number(report.epoch)} /> : '',
  });
}

// Which ways can move the balance of wallet `qnet` from this page: the extension when it holds that wallet, QNet Wallet
// while the site sends its requests.
export function useMoveWays(qnet: string | null): { extension: boolean; app: boolean } {
  const { choice, phoneFlows } = useCabinet();
  const { providerStatus, providerChannel, accounts } = useWallet();
  // The extension moves its own wallet's balance only: offered when it is the wallet this page shows.
  const extension = qnet !== null && providerStatus === 'available' && providerChannel === 'extension'
    && (choice?.source === 'extension' || accounts?.qnet === qnet);
  return { extension, app: phoneFlows };
}

// The ways to move the balance of `nodeId`, the wallet's light or super node; kept mounted when the balance falls below
// 1 QNC, so a report stays on screen.
export function Move({ qnet, nodeId, movable, onAnswer }: { qnet: string; nodeId: string; movable: boolean; onAnswer: () => void }) {
  const { viewOnly, phoneFlows } = useCabinet();
  const { claimNodeBalance } = useWallet();
  const { extension } = useMoveWays(qnet);
  const device = useDeviceKind();
  // One session per node: a wallet with both node types shows two balances.
  const button = useLinkSession({ slot: `claim.${nodeId}` });
  const qr = useLinkSession({ slot: `claim-qr.${nodeId}` });
  const [ext, setExt] = useState<ExtClaim>({ phase: 'idle' });
  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const answered = active?.state.phase === 'done' || ext.phase === 'done';
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;

  useEffect(() => {
    if (answered) onAnswerRef.current();
  }, [answered]);

  const withExtension = async () => {
    setExt({ phase: 'waiting' });
    const result = await claimNodeBalance(qnet, nodeId);
    setExt(result.ok ? { phase: 'done', answer: result.answer } : { phase: 'failed', failure: result.failure });
  };

  // The request names the wallet the page shows and the node: QNet Wallet signs for that node of that wallet only.
  const request: ClaimRequest = { walletHash: walletHash(qnet), nodeId };
  const ask = () => {
    if (!device) return;
    if (device.phone) void button.start('claim', request);
    else void qr.start('claim', request);
  };
  const showQr = () => {
    button.cancel();
    void qr.start('claim', request);
  };
  const idle = () => setExt({ phase: 'idle' });

  // An address only viewed is never offered a move.
  if (viewOnly) return null;
  return (
    <div className="cab-ways-move">
      {extension && (
        <div className="cab-move-way">
          {ext.phase === 'idle' && movable && (
            <>
              <Action kind="solid" onClick={() => void withExtension()}>{t('claim_with_extension')}</Action>
              <p className="note">{t('claim_extension_note')}</p>
            </>
          )}
          {ext.phase === 'waiting' && <Waiting>{t('wallet_extension_waiting')}</Waiting>}
          {ext.phase === 'done' && <Answered action={{ label: t('start_again'), onClick: idle }}>{reportText(ext.answer, 'extension')}</Answered>}
          {ext.phase === 'failed' && <Failed action={{ label: t('start_again'), onClick: idle }}>{t(failureKey(ext.failure, 'claim'))}</Failed>}
        </div>
      )}
      {!phoneFlows ? (
        <p className="note">{t('claim_closed')}</p>
      ) : (
        <div className="cab-move-way">
          {!active || active.state.phase === 'idle' ? movable && (
            <>
              <Action kind={extension ? 'text' : 'solid'} onClick={ask} disabled={!device}>{t('claim_with_app')}</Action>
              <p className="note">{t('claim_app_note')}</p>
            </>
          ) : active.state.phase === 'done' ? (
            <Answered action={{ label: t('start_again'), onClick: active.cancel }}>{reportText(active.state.answer, 'app')}</Answered>
          ) : (
            <LinkWaiting
              state={active.state}
              qr={active === qr}
              android={device?.android === true}
              onShowQr={active === button ? showQr : undefined}
              onCancel={active.cancel}
              onRetry={active === qr ? () => void qr.start('claim', request) : () => void button.start('claim', request)}
            />
          )}
        </div>
      )}
    </div>
  );
}
