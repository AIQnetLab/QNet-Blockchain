'use client';

// The testnet faucet: 1,500 test 1DEV and 0.005 test SOL on Solana devnet to the address entered, enough for a wallet
// to send the activation's 1DEV and SOL to a payment address of My node, whose card links here ("Get them to your
// wallet"). The card hands over the connected wallet's Solana address without a URL (src/lib/faucet-handover.ts):
// the field is filled in once, and nothing is sent before the visitor presses the button. It also hands over the faucet
// pass the site gave for the QNet wallet being activated, sent with the claims (SITE M-13). A refused claim names the
// time to try again. Waiting and a failure take the line under the form (B-SPEC 5.22); a claim that went through shows a
// panel with a green check, the amounts, the address and the transactions until it is closed.

import { useEffect, useState, type FormEvent } from 'react';
import Action from '@/components/ui/Action';
import EntityLink from '@/components/ui/EntityLink';
import TokenIcon from '@/components/TokenIcon';
import PageHead from '@/components/ui/PageHead';
import { Failed, Waiting } from '@/components/ui/RequestState';
import Section from '@/components/ui/Section';
import { clockAt } from '@/lib/format';
import { retryAt, takeHandedOver, takeHandedPass } from '@/lib/faucet-handover';
import { t } from '@/lib/texts';

// Test SOL a claim asks for: the payment address's SOL and its 1DEV account's rent, with the wallet's network fees.
const FAUCET_SOL = 0.005;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// " Try again at 14:05." (the day too when it is not within the next twelve hours); empty when no time is known.
function tryAgain(at: number | null, now: number): string {
  if (at === null) return '';
  return ` Try again at ${clockAt(at, now)}.`;
}

interface Sent {
  amounts: string;
  address: string;
  devTx: string;
  solTx: string;
}

export default function TestnetPage() {
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
      setErrorMessage('Enter a Solana address first.');
      return;
    }

    const now = Date.now();
    if (lastFaucetClaim && (now - lastFaucetClaim) < COOLDOWN_MS) {
      setErrorMessage('Tokens go to an address once every 24 hours.' + tryAgain(lastFaucetClaim + COOLDOWN_MS, now));
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setSent(null);

    try {
      const address = faucetAddress.trim();
      const withPass = faucetPass ? { pass: faucetPass } : {};

      const [devResponse, solResponse] = await Promise.all([
        fetch('/api/faucet/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address, amount: 1500, tokenType: '1DEV', ...withPass }),
        }),
        fetch('/api/faucet/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address, amount: FAUCET_SOL, tokenType: 'SOL', ...withPass }),
        }),
      ]);

      const [devData, solData] = await Promise.all([devResponse.json(), solResponse.json()]);
      const answered = Date.now();
      const devRetry = devData.success ? null : retryAt(devData, answered);
      const solRetry = solData.success ? null : retryAt(solData, answered);

      if (devData.success || solData.success) {
        setLastFaucetClaim(now);
        // Name only what was sent: one of the two claims can fail while the other goes through.
        setSent({
          amounts: [devData.success && '1,500 1DEV', solData.success && `${FAUCET_SOL} SOL`].filter(Boolean).join(' + '),
          address,
          devTx: devData.txHash || '',
          solTx: solData.txHash || '',
        });
        setFaucetAddress('');
        if (!devData.success) setErrorMessage('1DEV: ' + (devData.error || 'failed') + tryAgain(devRetry, answered));
        if (!solData.success) setErrorMessage('SOL: ' + (solData.error || 'failed') + tryAgain(solRetry, answered));
      } else {
        // One reason once: both claims usually fail for the same one (an address of the wrong form).
        const err = [...new Set([devData.error, solData.error].filter(Boolean))].join(' | ') || 'The faucet sent nothing. Try again.';
        // Both refused: the time both may go again.
        const both = devRetry !== null && solRetry !== null ? Math.max(devRetry, solRetry) : devRetry ?? solRetry;
        setErrorMessage(err + tryAgain(both, answered));
      }
    } catch {
      setErrorMessage('The faucet could not be reached. Check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="pg">
      <PageHead title="QNet Blockchain testnet" lead="Test network for development and experimentation." />

      <Section id="faucet" title={t('ui_faucet_title')} lead={`Get 1,500 1DEV tokens + ${FAUCET_SOL} SOL to test node activation on QNet Blockchain testnet. They have no value.`} variant="tool">
        <form onSubmit={handleFaucetClaim}>
          <label className="label form-label" htmlFor="faucet-address">Your Solana testnet address</label>
          <div className="form-row">
            <input
              id="faucet-address"
              type="text"
              className="field"
              placeholder="Solana address"
              value={faucetAddress}
              onChange={(e) => setFaucetAddress(e.target.value)}
              disabled={isLoading}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errorMessage === 'Enter a Solana address first.' || undefined}
              aria-describedby="faucet-answer"
            />
            <button type="submit" className="btn btn-solid" disabled={isLoading} aria-busy={isLoading || undefined}>
              <span className="swap">
                <span data-on={!isLoading}>{t('ui_faucet_button')}</span>
                <span data-on={isLoading} aria-hidden={!isLoading}>Sending…</span>
              </span>
            </button>
          </div>
          {fromNode && (
            <p className="note form-note">Your wallet&apos;s Solana address from My node is filled in. Check it, then press {t('ui_faucet_button')}.</p>
          )}
        </form>

        <div className="req" id="faucet-answer">
          {isLoading && <Waiting>Sending the tokens on Solana devnet</Waiting>}
          {sent && (
            // Stays until closed or the next claim, so the confirmation is not missed (owner 20.10).
            <section className="faucet-sent" role="status" aria-labelledby="faucet-sent">
              <div className="faucet-sent-head">
                <svg className="faucet-sent-mark" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="11" />
                  <path d="M6.8 12.4l3.4 3.4 7-7.2" />
                </svg>
                <h3 className="faucet-sent-title" id="faucet-sent">Test tokens sent</h3>
                <Action kind="quiet" onClick={() => setSent(null)}>Close</Action>
              </div>
              <dl className="kv">
                <div>
                  <dt>Sent</dt>
                  <dd>{sent.amounts}</dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd className="mono">{sent.address}</dd>
                </div>
                {sent.devTx && (
                  <div>
                    <dt className="ent-unit"><TokenIcon solana="1DEV" size="text" />1DEV transaction</dt>
                    <dd><EntityLink kind="solana-tx" value={sent.devTx} /></dd>
                  </div>
                )}
                {sent.solTx && (
                  <div>
                    <dt className="ent-unit"><TokenIcon solana="SOL" size="text" />SOL transaction</dt>
                    <dd><EntityLink kind="solana-tx" value={sent.solTx} /></dd>
                  </div>
                )}
              </dl>
              {fromNode && <Action href="/node/activate">Back to your activation on My node</Action>}
            </section>
          )}
          {errorMessage && <Failed>{errorMessage}</Failed>}
        </div>
      </Section>
    </div>
  );
}
