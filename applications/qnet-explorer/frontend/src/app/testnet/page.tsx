'use client';

// The testnet faucet: 1,500 test 1DEV and 0.005 test SOL on Solana devnet to the address entered, enough for a wallet
// to send the activation's 1DEV and SOL to a payment address of My node, whose card links here ("Get them to your
// wallet"). The card hands over the connected wallet's Solana address without a URL (src/lib/faucet-handover.ts):
// the field is filled in once, and nothing is sent before the visitor presses the button. It also hands over the faucet
// pass the site gave for the QNet wallet being activated, sent with the claims. A refused claim names the
// time to try again. Waiting and a failure take the line under the form; a claim that went through shows a
// panel with a green check, the amounts, the address and the transactions until it is closed.

import { useEffect, useState, type FormEvent } from 'react';
import Action from '@/components/ui/Action';
import EntityLink, { Amount } from '@/components/ui/EntityLink';
import TokenIcon from '@/components/TokenIcon';
import PageHead from '@/components/ui/PageHead';
import { Failed, Waiting } from '@/components/ui/RequestState';
import Section from '@/components/ui/Section';
import { clockAt } from '@/lib/format';
import { FAUCET_CLAIM_REQUEST_MS, retryAt, takeHandedOver, takeHandedPass } from '@/lib/faucet-handover';
import { siteRequest } from '@/lib/site-request';
import { number, type MessageKey, type T } from '@/lib/texts';
import { useI18n } from '@/i18n/client';

// The test tokens a claim asks for: 1DEV, and SOL for the payment address's SOL and its 1DEV account's rent with the
// wallet's network fees.
const FAUCET_DEV = 1500;
const FAUCET_SOL = 0.005;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// " Try again at 14:05." (the day too when it is not within the next twelve hours); empty when no time is known.
function tryAgain(at: number | null, now: number, t: T): string {
  if (at === null) return '';
  return ` ${t('faucet_try_at', { time: clockAt(at, now, t) })}`;
}

// A refused claim in the page's words, by the faucet's answer: a claim already made today (429 with the time it may go
// again), the faucet busy or out of tokens this hour, an address of the wrong form (400), or a send that failed.
function refusal(status: number, body: { nextClaimTime?: unknown } | null): MessageKey {
  if (status === 429 && body?.nextClaimTime) return 'faucet_once_a_day';
  if (status === 429 || status === 503) return 'faucet_busy';
  if (status === 400) return 'act_refund_invalid';
  return 'faucet_send_failed';
}

// A claim that went through: which of the two tokens were sent, where, and their transactions.
interface Sent {
  dev: boolean;
  sol: boolean;
  address: string;
  devTx: string;
  solTx: string;
}

export default function TestnetPage() {
  const { t, say, rich } = useI18n();
  const [lastFaucetClaim, setLastFaucetClaim] = useState<number | null>(null);
  const [faucetAddress, setFaucetAddress] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sent, setSent] = useState<Sent | null>(null);
  // The address came from My node's payment card: the answer leads back there.
  const [fromNode, setFromNode] = useState(false);
  // The faucet pass from My node, for the claims of the wallet being activated.
  const [faucetPass, setFaucetPass] = useState<string | null>(null);

  useEffect(() => {
    const handed = takeHandedOver();
    if (handed) {
      setFaucetAddress(handed);
      setFromNode(true);
    }
    setFaucetPass(takeHandedPass());
  }, []);

  const handleFaucetClaim = async (e: FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (!faucetAddress.trim()) {
      setErrorMessage(t('faucet_enter_address'));
      return;
    }

    const now = Date.now();
    if (lastFaucetClaim && (now - lastFaucetClaim) < COOLDOWN_MS) {
      setErrorMessage(t('faucet_once_a_day') + tryAgain(lastFaucetClaim + COOLDOWN_MS, now, t));
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setSent(null);

    try {
      const address = faucetAddress.trim();
      const withPass = faucetPass ? { pass: faucetPass } : {};

      const [devResponse, solResponse] = await Promise.all([
        fetch('/api/faucet/claim', siteRequest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address, amount: FAUCET_DEV, tokenType: '1DEV', ...withPass }),
        }, FAUCET_CLAIM_REQUEST_MS)),
        fetch('/api/faucet/claim', siteRequest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address, amount: FAUCET_SOL, tokenType: 'SOL', ...withPass }),
        }, FAUCET_CLAIM_REQUEST_MS)),
      ]);

      const [devData, solData] = await Promise.all([devResponse.json(), solResponse.json()]);
      const answered = Date.now();
      const devRetry = devData.success ? null : retryAt(devData, answered);
      const solRetry = solData.success ? null : retryAt(solData, answered);

      if (devData.success || solData.success) {
        setLastFaucetClaim(now);
        // Name only what was sent: one of the two claims can fail while the other goes through.
        setSent({
          dev: Boolean(devData.success),
          sol: Boolean(solData.success),
          address,
          devTx: devData.txHash || '',
          solTx: solData.txHash || '',
        });
        setFaucetAddress('');
        if (!devData.success) setErrorMessage(t('faucet_token_refused', { token: '1DEV', reason: t(refusal(devResponse.status, devData)) }) + tryAgain(devRetry, answered, t));
        if (!solData.success) setErrorMessage(t('faucet_token_refused', { token: 'SOL', reason: t(refusal(solResponse.status, solData)) }) + tryAgain(solRetry, answered, t));
      } else {
        // One reason once: both claims usually fail for the same one (an address of the wrong form).
        const reasons = [...new Set([refusal(devResponse.status, devData), refusal(solResponse.status, solData)])];
        const err = reasons.map((key) => t(key)).join(' ');
        // Both refused: the time both may go again.
        const both = devRetry !== null && solRetry !== null ? Math.max(devRetry, solRetry) : devRetry ?? solRetry;
        setErrorMessage(err + tryAgain(both, answered, t));
      }
    } catch {
      setErrorMessage(t('faucet_unreachable'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="pg">
      <PageHead title={say('testnet_title')} lead={t('testnet_lead')} />

      <Section id="faucet" title={t('ui_faucet_title')} lead={say('faucet_lead', { dev: number(FAUCET_DEV), sol: FAUCET_SOL })} variant="tool">
        <form onSubmit={handleFaucetClaim}>
          <label className="label form-label" htmlFor="faucet-address">{t('faucet_address_label')}</label>
          <div className="form-row">
            <input
              id="faucet-address"
              type="text"
              className="field"
              placeholder={t('act_refund_label')}
              value={faucetAddress}
              onChange={(e) => setFaucetAddress(e.target.value)}
              disabled={isLoading}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errorMessage === t('faucet_enter_address') || undefined}
              aria-describedby="faucet-answer"
            />
            <button type="submit" className="btn btn-solid" disabled={isLoading} aria-busy={isLoading || undefined}>
              <span className="swap">
                <span data-on={!isLoading}>{t('ui_faucet_button')}</span>
                <span data-on={isLoading} aria-hidden={!isLoading}>{t('faucet_sending_short')}</span>
              </span>
            </button>
          </div>
          {fromNode && (
            <p className="note form-note">{t('faucet_from_node', { button: t('ui_faucet_button') })}</p>
          )}
        </form>

        <div className="req" id="faucet-answer">
          {isLoading && <Waiting>{t('faucet_sending')}</Waiting>}
          {sent && (
            // Stays until closed or the next claim, so the confirmation is not missed.
            <section className="faucet-sent" role="status" aria-labelledby="faucet-sent">
              <div className="faucet-sent-head">
                <svg className="faucet-sent-mark" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="11" />
                  <path d="M6.8 12.4l3.4 3.4 7-7.2" />
                </svg>
                <h3 className="faucet-sent-title" id="faucet-sent">{t('faucet_sent_title')}</h3>
                <Action kind="quiet" onClick={() => setSent(null)}>{t('hdr_close')}</Action>
              </div>
              <dl className="kv">
                <div>
                  <dt>{t('faucet_sent')}</dt>
                  <dd className="faucet-amts">
                    {sent.dev && <Amount value={number(FAUCET_DEV)} solana="1DEV" />}
                    {sent.sol && <Amount value={number(FAUCET_SOL)} solana="SOL" />}
                  </dd>
                </div>
                <div>
                  <dt>{t('tx_to')}</dt>
                  <dd className="mono" translate="no">{sent.address}</dd>
                </div>
                {sent.devTx && (
                  <div>
                    <dt className="ent-unit"><TokenIcon solana="1DEV" size="text" />{rich('faucet_tx', { token: <span translate="no">1DEV</span> })}</dt>
                    <dd><EntityLink kind="solana-tx" value={sent.devTx} /></dd>
                  </div>
                )}
                {sent.solTx && (
                  <div>
                    <dt className="ent-unit"><TokenIcon solana="SOL" size="text" />{rich('faucet_tx', { token: <span translate="no">SOL</span> })}</dt>
                    <dd><EntityLink kind="solana-tx" value={sent.solTx} /></dd>
                  </div>
                )}
              </dl>
              {fromNode && <Action href="/node/activate">{t('faucet_back')}</Action>}
            </section>
          )}
          {errorMessage && <Failed>{errorMessage}</Failed>}
        </div>
      </Section>
    </div>
  );
}
