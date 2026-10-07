'use client';

// Move to wallet, beside the node balance on the Overview (unified plan SITE-5 and SITE-7; owner, 29.09: it was a page of
// its own). The wallet signs the move (docs/protocols/light-node-messages.md section 4): the QNet extension of this
// computer when it holds the chosen wallet (qnet_claimNodeBalance, docs/protocols/qnet-link-v1.md section 14.10),
// otherwise QNet Wallet through a QNet Link `claim` request, its button on this phone or tablet or its QR code for
// another device. An answer is the wallet's report; the balance the page shows comes from the QNet network.

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/contexts/AppContext';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { useLinkSession } from '@/hooks/useLinkSession';
import { number, t } from '@/lib/texts';
import { claimReport, failureKey, type ClaimVia } from '@/lib/cabinet/extension-view';
import { formatQnc } from '@/lib/cabinet/node-view';
import type { ClaimFailure, LinkAnswer } from '@/lib/qnet-link';
import { useCabinet } from './CabinetProvider';
import LinkWaiting from './LinkWaiting';

type ExtClaim =
  | { phase: 'idle' }
  | { phase: 'waiting' }
  | { phase: 'done'; answer: LinkAnswer }
  | { phase: 'failed'; failure: ClaimFailure };

function Report({ answer, via }: { answer: LinkAnswer; via: ClaimVia }) {
  const report = claimReport(answer, via);
  const vars = {
    amount: report.amountNano ? formatQnc(report.amountNano) : '',
    epoch: report.epoch ? number(BigInt(report.epoch)) : '',
  };
  return <p className={answer.status === 'ok' ? 'activate-result' : 'activate-note'} role="status">{t(report.key, vars)}</p>;
}

// The ways to move it; kept mounted when the balance falls below 1 QNC, so a report stays on screen.
export function Move({ qnet, movable, onAnswer }: { qnet: string; movable: boolean; onAnswer: () => void }) {
  const { walletHash, choice, phoneFlows } = useCabinet();
  const { providerStatus, providerChannel, accounts, claimNodeBalance } = useWallet();
  const device = useDeviceKind();
  const button = useLinkSession({ slot: 'claim' });
  const qr = useLinkSession({ slot: 'claim-qr' });
  const [ext, setExt] = useState<ExtClaim>({ phase: 'idle' });
  // The extension moves its own wallet's balance only: offered when it is the wallet this page shows.
  const extension = providerStatus === 'available' && providerChannel === 'extension'
    && (choice?.source === 'extension' || accounts?.qnet === qnet);
  const active = qr.state.phase !== 'idle' ? qr : button.state.phase !== 'idle' ? button : null;
  const answered = active?.state.phase === 'done' || ext.phase === 'done';
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;

  useEffect(() => {
    if (answered) onAnswerRef.current();
  }, [answered]);

  const withExtension = async () => {
    setExt({ phase: 'waiting' });
    const result = await claimNodeBalance(qnet);
    setExt(result.ok ? { phase: 'done', answer: result.answer } : { phase: 'failed', failure: result.failure });
  };

  const request = { walletHash };
  const ask = () => {
    if (!device) return;
    if (device.phone) void button.start('claim', request);
    else void qr.start('claim', request);
  };
  const showQr = () => {
    button.cancel();
    void qr.start('claim', request);
  };

  return (
    <>
      {extension && (
        <div className="cabinet-choice">
          {ext.phase === 'idle' && movable && (
            <>
              <button type="button" className="qnet-button activate-primary" onClick={() => void withExtension()}>{t('claim_with_extension')}</button>
              <p className="activate-note">{t('claim_extension_note')}</p>
            </>
          )}
          {ext.phase === 'waiting' && <p className="activate-status" aria-live="polite">{t('wallet_extension_waiting')}</p>}
          {ext.phase === 'done' && <Report answer={ext.answer} via="extension" />}
          {ext.phase === 'failed' && <p className="activate-error" role="alert">{t(failureKey(ext.failure, 'claim'))}</p>}
          {(ext.phase === 'done' || ext.phase === 'failed') && (
            <button type="button" className="qnet-button secondary" onClick={() => setExt({ phase: 'idle' })}>{t('start_again')}</button>
          )}
        </div>
      )}
      {!phoneFlows ? (
        <p className="activate-note">{t('claim_closed')}</p>
      ) : (
        <div className="cabinet-choice">
          {!active || active.state.phase === 'idle' ? movable && (
            <>
              <button type="button" className={`qnet-button ${extension ? 'secondary' : 'activate-primary'}`} onClick={ask} disabled={!device}>
                {t('claim_with_app')}
              </button>
              <p className="activate-note">{t('claim_app_note')}</p>
            </>
          ) : active.state.phase === 'done' ? (
            <>
              <Report answer={active.state.answer} via="app" />
              <button type="button" className="qnet-button secondary" onClick={active.cancel}>{t('start_again')}</button>
            </>
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
    </>
  );
}
