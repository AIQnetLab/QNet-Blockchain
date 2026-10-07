'use client';

// The parts of the activation page (src/components/cabinet/NodeActivate.tsx) that only show what the record holds:
// the payment address and what to send to it, the receipt, QNet Wallet's answer and its check number, sending what is
// left back after the burn, what is left going back to the wallet, and the node once it is registered. Every text is the
// cabinet's own (src/lib/texts.ts).

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { number, t } from '@/lib/texts';
import { useNodeStatus } from '@/hooks/useNodeStatus';
import type { PaymentBalance } from '@/lib/cabinet/activation';
import { receiptCode, type PaymentRecord } from '@/lib/cabinet/flow';
import { formatUnits } from '@/lib/cabinet/node-view';
import { fundingSol, oneDevRequest, solRequest } from '@/lib/cabinet/payment-request';
import { handOver, handOverPass, requestFaucetPass } from '@/lib/faucet-handover';
import { ACTIVATION_NETWORK, ONE_DEV_DECIMALS, SOL_DECIMALS, solanaTxUrl } from '@/lib/one-dev';
import { formatCheckNumber } from '@/lib/qnet-link';
import { shortAddress } from '@/lib/qnet-provider';
import { rich } from '@/lib/rich';
import { decodeKey } from '@/lib/solana-message';
import CopyButton from './CopyButton';
import { QrCode } from './LinkWaiting';
import { DeviceRows, StatusGate } from './NodeStatus';

// The payment address and what to send to it, as on mainnet (owner, 29.09): the user sends the activation price in 1DEV
// and the SOL the burn needs from their own wallet. A QR code of a standard payment request fills in the address, 1DEV
// and the amount in the wallet that scans it; one request carries one token, so the SOL has a small code of its own.
// Who the node is for: the QNet wallet that confirmed it in QNet Wallet, never this address. On testnet, a link to the Testnet
// page's faucet for test tokens to the wallet, with the wallet's Solana address handed over without a URL
// (src/lib/faucet-handover.ts), with the faucet pass the site gives for the wallet's signed reservation the record holds,
// so the claim takes a place of the hour's share kept for activations (SITE M-13). Test tokens are named as such, never
// "from any wallet or exchange" (SITE-R3-01). On a phone, where QNet Wallet on the same phone cannot scan the page, the
// address is copied instead (SITE-F8); each request can be copied too, for a wallet that reads a pasted one (XC-11).
export function Funding({
  record,
  price,
  balance,
  wallet,
  walletSolana,
  phone = false,
}: {
  record: PaymentRecord;
  price: number;
  balance: PaymentBalance | null;
  // The QNet wallet the node is registered to (the one that signed the reservation).
  wallet: string | null;
  // The connected wallet's Solana address, for the Testnet page's faucet.
  walletSolana: string | null;
  // The page is open on a phone or tablet.
  phone?: boolean;
}) {
  const sol = fundingSol();
  const oneDev = oneDevRequest(record.pub, price);
  const solOnly = solRequest(record.pub);
  // The faucet pass for the wallet the record holds; none without its signed reservation or off testnet.
  const [pass, setPass] = useState<string | null>(null);
  const hold = ACTIVATION_NETWORK === 'testnet' ? record.hold ?? null : null;
  const [holdWallet, holdPk, holdSig, holdTime] = hold ? [hold.wallet, hold.pk, hold.sig, hold.time] : [null, null, null, null];
  useEffect(() => {
    if (holdWallet === null || holdPk === null || holdSig === null || holdTime === null) return undefined;
    let live = true;
    void requestFaucetPass({ wallet: holdWallet, pk: holdPk, sig: holdSig, time: holdTime }, record.pub).then((got) => {
      if (live) setPass(got);
    });
    return () => {
      live = false;
    };
  }, [holdWallet, holdPk, holdSig, holdTime, record.pub]);
  const toFaucet = () => {
    if (walletSolana) handOver(walletSolana);
    if (pass) handOverPass(pass);
  };
  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('act_address_title')}</h3>
      {wallet && <p>{t('act_owner', { wallet: shortAddress(wallet) })}</p>}
      <p className="cabinet-lead">{t(ACTIVATION_NETWORK === 'mainnet' ? 'act_mainnet_send' : 'act_testnet_send', { price: number(price), sol })}</p>
      <QrCode text={oneDev} label={t('act_request_qr', { price: number(price) })} />
      <p className="activate-note">{phone ? t('act_request_note_phone', { price: number(price), sol }) : t('act_request_note')}</p>
      <p className="activate-mono">{record.pub}</p>
      <CopyButton value={record.pub} />
      <CopyButton value={oneDev} label={t('act_copy_request')} />
      <div className="cabinet-sol-request">
        <QrCode text={solOnly} label={t('act_sol_qr', { sol })} small />
        <p>{t('act_sol_line', { sol })}</p>
        <CopyButton value={solOnly} label={t('act_copy_request')} />
      </div>
      {ACTIVATION_NETWORK === 'testnet' && (
        <p>
          {rich('act_no_tokens', {
            link: (
              <Link href="/testnet#faucet" onClick={toFaucet}>{t('act_no_tokens_link')}</Link>
            ),
          })}
        </p>
      )}
      <p className="activate-note">{t('act_address_note')}</p>
      <p className="activate-note">{t('act_keep_browser')}</p>
      {balance && (
        <p className="activate-status" aria-live="polite">
          {t('act_received', {
            oneDev: formatUnits(balance.oneDev, ONE_DEV_DECIMALS),
            price: number(price),
            sol: formatUnits(balance.sol, SOL_DECIMALS),
            solNeed: sol,
          })}
        </p>
      )}
    </div>
  );
}

// The burn, and its activation code: the code encodes the wallet that signed the reservation, so it shows once the burn is
// final. A burn whose wallet's node came from another burn (`unused`) shows no code.
export function Receipt({ record, unused = false }: { record: PaymentRecord; unused?: boolean }) {
  const code = unused ? null : receiptCode(record);
  if (!record.burn) return null;
  return (
    <div className="activate-card">
      <h3 className="activate-step">{t('act_receipt_title')}</h3>
      <p>{t('act_burned', { amount: number(record.burn.amount) })}</p>
      <dl className="activate-fields">
        <div className="activate-field">
          <dt>{t('act_burn_tx')}</dt>
          <dd>
            <a href={solanaTxUrl(record.burn.tx)} target="_blank" rel="noopener noreferrer" className="activate-mono">{record.burn.tx}</a>
          </dd>
        </div>
        {code && (
          <div className="activate-field">
            <dt>{t('act_code')}</dt>
            <dd>
              <span className="activate-code">{code}</span> <CopyButton value={code} />
            </dd>
          </div>
        )}
      </dl>
      {code && <p className="activate-note">{t('act_code_note')}</p>}
    </div>
  );
}

// A step that deletes the payment key and loses something with it: the page names what is lost, and nothing happens
// before the user confirms (SITE-1, SITE-3).
function ConfirmLoss({ warning, confirm, busy, onConfirm, onBack }: { warning: string; confirm: string; busy: boolean; onConfirm: () => void; onBack: () => void }) {
  return (
    <div className="activate-card" role="alert">
      <p className="activate-error">{warning}</p>
      <div className="cabinet-actions">
        <button type="button" className="qnet-button activate-primary" onClick={onBack} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="qnet-button secondary" onClick={onConfirm} disabled={busy}>{confirm}</button>
      </div>
    </div>
  );
}

// After the burn (flow.ts mayReturnLeftovers): what is left goes back to the wallet now and the key goes; the burn stays
// the wallet's activation, registered later from any browser where the wallet is connected.
export function LeftoversNow({ busy, onSend }: { busy: boolean; onSend: () => void }) {
  return (
    <div className="activate-card">
      <p className="activate-note">{t('act_leftovers_now_note')}</p>
      <button type="button" className="qnet-button secondary" onClick={onSend} disabled={busy}>{t('act_leftovers_now')}</button>
    </div>
  );
}

// QNet Wallet's answer, and the check number when the request asked for it.
export function AnswerCheck({ record, onAnswer }: { record: PaymentRecord; onAnswer: (matches: boolean) => void }) {
  if (!record.answer || !record.link) return null;
  const asks = record.link.request.check && !record.answer.checkConfirmed;
  return (
    <div className="activate-card">
      <p>{t('act_answer_for', { node: record.answer.nodeId, wallet: shortAddress(record.answer.qnet) })}</p>
      {asks ? (
        <>
          <p className="activate-code">{t('act_check', { number: formatCheckNumber(record.answer.checkNumber) })}</p>
          <div className="cabinet-actions">
            <button type="button" className="qnet-button activate-primary" onClick={() => onAnswer(true)}>{t('act_check_yes')}</button>
            <button type="button" className="qnet-button secondary" onClick={() => onAnswer(false)}>{t('act_check_no')}</button>
          </div>
        </>
      ) : (
        <p className="activate-status" aria-live="polite">{t('act_checking_node')}</p>
      )}
    </div>
  );
}

// What is left on the payment address, sent back to the wallet: by itself to the Solana address the wallet shared
// (`dest`), else, on mainnet, to the one QNet Wallet on this device shares (`ask`) or the user gives (test tokens are
// not asked for). Leaving it there deletes the key only after the page named what is lost (SITE-3). An unrecorded
// mainnet activation with nothing on its address (`empty`) keeps its key for a transfer still on its way, until the
// user deletes it (SITE-1). When the address lacks the SOL to send them back (`short`, in lamports), the page shows the
// payment address and what it lacks, and offers no "Leave it" while 1DEV would stay behind (SITE-R2-02).
export function Leftovers({
  pub,
  short,
  balance,
  dest,
  expired,
  empty,
  ask,
  busy,
  failed,
  onSend,
  onLeave,
}: {
  pub: string;
  short: bigint | null;
  balance: PaymentBalance | null;
  dest: string | null;
  expired: boolean;
  empty: boolean;
  ask: ReactNode | null;
  busy: boolean;
  failed: boolean;
  onSend: (dest: string) => void;
  onLeave: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = typed.trim();
    if (!decodeKey(value)) {
      setInvalid(true);
      return;
    }
    onSend(value);
  };
  const amounts = balance && { oneDev: formatUnits(balance.oneDev, ONE_DEV_DECIMALS), sol: formatUnits(balance.sol, SOL_DECIMALS) };
  const left = amounts && t('act_leftovers', amounts);
  const lacking = short !== null && short > 0n ? (
    <div className="cabinet-choice" role="alert">
      <p className="activate-error">{t(ACTIVATION_NETWORK === 'testnet' ? 'act_refund_short_testnet' : 'act_refund_short', { sol: formatUnits(short, SOL_DECIMALS) })}</p>
      <QrCode text={pub} label={t('act_address_qr')} />
      <p className="activate-mono">{pub}</p>
      <CopyButton value={pub} />
    </div>
  ) : null;
  // 1DEV stay behind for want of SOL: sending the SOL is the way, never deleting the key.
  const mayLeave = !(lacking && (balance === null || balance.oneDev > 0n));
  if (leaving && mayLeave) {
    const warning = empty || !amounts ? t('act_closing_delete_warn') : t('act_refund_leave_warn', amounts);
    return <ConfirmLoss warning={warning} confirm={t('act_delete_key')} busy={busy} onConfirm={onLeave} onBack={() => setLeaving(false)} />;
  }
  if (empty) {
    return (
      <div className="activate-card">
        {expired && <p>{t('act_expired')}</p>}
        <p className="activate-status" aria-live="polite">{t('act_closing_empty')}</p>
        <button type="button" className="activate-link-button" onClick={() => setLeaving(true)} disabled={busy}>{t('act_closing_delete')}</button>
      </div>
    );
  }
  if (dest) {
    return (
      <div className="activate-card">
        {expired && <p>{t('act_expired')}</p>}
        {left && <p>{left}</p>}
        <p className="activate-status" aria-live="polite">
          {t('act_refund_to')} <span className="activate-mono">{dest}</span>
        </p>
        {lacking}
        {failed && !lacking && <p className="activate-error" role="alert">{t('act_refund_failed')}</p>}
      </div>
    );
  }
  return (
    <div className="activate-card">
      {expired && <p>{t('act_expired')}</p>}
      {left && <p>{left}</p>}
      {lacking}
      <p className="activate-note">{t(ask ? 'act_refund_ask' : 'act_refund_enter')}</p>
      {ask}
      <form className="cabinet-choice" onSubmit={submit} noValidate>
        <label className="cabinet-label" htmlFor="cabinet-refund">{t('act_refund_label')}</label>
        <div className="cabinet-row">
          <input
            id="cabinet-refund"
            className="cabinet-input activate-mono"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setInvalid(false);
            }}
            aria-invalid={invalid}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button type="submit" className="qnet-button activate-primary" disabled={busy}>{t('act_refund_send')}</button>
        </div>
        {invalid && <p className="activate-error" role="alert">{t('act_refund_invalid')}</p>}
        {failed && !lacking && <p className="activate-error" role="alert">{t('act_refund_failed')}</p>}
      </form>
      {mayLeave && <button type="button" className="activate-link-button" onClick={() => setLeaving(true)} disabled={busy}>{t('act_refund_leave')}</button>}
    </div>
  );
}

// The registered node, as the nodes report it now. One wallet, one node: nothing else to activate for it (SITE-F12).
export function Registered({ nodeId }: { nodeId: string }) {
  const { state, retry } = useNodeStatus(nodeId);
  return (
    <div className="activate-card">
      <p className="activate-result">{t('act_done')}</p>
      <StatusGate state={state} retry={retry}>
        {(status) => (status.deviceBound ? <DeviceRows status={status} /> : <p className="activate-note">{t('act_done_device')}</p>)}
      </StatusGate>
      <div className="cabinet-actions">
        <Link href="/node?tab=overview" className="qnet-button activate-primary">{t('act_go_cabinet')}</Link>
      </div>
    </div>
  );
}
