'use client';

// The parts of the activation page (src/components/cabinet/NodeActivate.tsx) that only show what the record holds:
// the payment address and what to send to it, the receipt, QNet Wallet's answer and its check number, sending what is
// left back after the burn, what is left going back to the wallet, and the node once it is registered. Every text is the
// cabinet's own (src/lib/texts.ts).

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import Action from '@/components/ui/Action';
import Copy from '@/components/ui/Copy';
import EntityLink from '@/components/ui/EntityLink';
import TokenIcon from '@/components/TokenIcon';
import { Answered, Failed, Waiting } from '@/components/ui/RequestState';
import ViewTabs from '@/components/ui/ViewTabs';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { number, t } from '@/lib/texts';
import { useNodeStatus } from '@/hooks/useNodeStatus';
import type { PaymentBalance } from '@/lib/cabinet/activation';
import { FUNDING_SOL_LAMPORTS } from '@/lib/cabinet/burn-tx';
import { transferKey, transferMayArrive } from '@/lib/cabinet/extension-view';
import { receiptCode, type PaymentRecord } from '@/lib/cabinet/flow';
import { formatUnits } from '@/lib/cabinet/node-view';
import {
  FUNDING_DECIMALS, PHONE_LINK, fundingButtons, fundingLeft, fundingReceived, fundingSol, fundingTransfer, requestLink, type FundingToken,
} from '@/lib/cabinet/payment-request';
import { handOver, handOverPass, requestFaucetPass } from '@/lib/faucet-handover';
import { ACTIVATION_NETWORK, ONE_DEV_DECIMALS, ONE_DEV_UNIT, SOL_DECIMALS } from '@/lib/one-dev';
import { formatCheckNumber } from '@/lib/qnet-link';
import type { SolanaTransfer, SolanaTransferResult } from '@/lib/qnet-provider';
import { rich } from '@/lib/rich';
import { decodeKey } from '@/lib/solana-message';
import { useCabinet } from './CabinetProvider';
import { QrCode, openHref } from './LinkWaiting';
import { DeviceRows, StatusGate } from './NodeStatus';
import { Fact, Facts } from './parts';

type Mode = 'wallet' | 'manual';

// The payment address and what to send to it from the user's own wallet (owner, 19.10): one sentence with both amounts,
// then the two ways as tabs. "Send from your wallet": one row per transfer, with the button for what the address still
// lacks of it, opening a wallet with it filled in (the QNet extension once it takes qnet_sendSolanaTransfer, on any
// device; else on a phone the release's link, PHONE_LINK), done once the balance read holds its amount. "Send it
// yourself": the address with Copy, the amounts and one QR code of it (on a phone the address and amounts come first).
// Without a way to send from the wallet, only the address, without tabs. Under both, what has arrived, per amount. The
// node is for the QNet wallet that confirmed it, never this address. On testnet the faucet link hands over the wallet's
// Solana address and the faucet pass without a URL (src/lib/faucet-handover.ts, SITE M-13); test tokens are named as
// such (SITE-R3-01).
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
  const tokens: Record<FundingToken, string> = { oneDev: '1DEV', sol: 'SOL' };
  const tokenName = (token: FundingToken) => (ACTIVATION_NETWORK === 'testnet' ? t('act_test_token', { token: tokens[token] }) : tokens[token]);
  const full: Record<FundingToken, string> = { oneDev: number(price), sol };
  const left = fundingLeft(balance, price);
  const received = fundingReceived(balance, price);
  const { providerStatus, providerChannel, takesSolanaTransfer, sendSolanaTransfer } = useWallet();
  const extension = providerStatus === 'available' && providerChannel === 'extension';
  // The extension's buttons wait until it says it takes the transfer.
  const [extensionSends, setExtensionSends] = useState(false);
  useEffect(() => {
    if (!extension) {
      setExtensionSends(false);
      return undefined;
    }
    let live = true;
    void takesSolanaTransfer().then((takes) => {
      if (live) setExtensionSends(takes);
    });
    return () => {
      live = false;
    };
  }, [extension, takesSolanaTransfer]);
  const [sending, setSending] = useState<FundingToken | null>(null);
  const [outcome, setOutcome] = useState<{ token: FundingToken; result: SolanaTransferResult } | null>(null);
  // A transfer that may still arrive, by token, with the amount it carries: its button waits for the balance until the
  // page is reloaded, so one tap never asks for the same tokens twice.
  const [arriving, setArriving] = useState<Partial<Record<FundingToken, string>>>({});
  const [mode, setMode] = useState<Mode>('wallet');
  const send = async (token: FundingToken, transfer: SolanaTransfer, amount: string) => {
    setSending(token);
    setOutcome(null);
    const result = await sendSolanaTransfer(transfer);
    setSending(null);
    if (!result.ok && result.failure === 'unsupported') setExtensionSends(false);
    if (transferMayArrive(result)) setArriving((was) => ({ ...was, [token]: amount }));
    setOutcome({ token, result });
  };
  const buttons = fundingButtons(phone, extensionSends);
  const android = useDeviceKind()?.android === true;
  // A row's right side: received, waiting for a transfer that may still arrive, or the button that sends what is lacking.
  const fundButton = (token: FundingToken) => {
    const transfer = fundingTransfer(record.pub, token, left[token]);
    if (!transfer) {
      return <span key={token} className="cab-send-st">{t('act_fund_done')}</span>;
    }
    const waiting = arriving[token];
    if (waiting !== undefined) {
      return <span key={token} className="cab-send-st wait">{t('act_fund_waiting', { amount: waiting, token: tokenName(token) })}</span>;
    }
    const amount = formatUnits(left[token], FUNDING_DECIMALS[token]);
    const label = t('act_fund_send', { amount, token: tokenName(token) });
    // The 1DEV first; the SOL's button turns solid once the 1DEV arrived or is on its way.
    const className = token === 'oneDev' || received.oneDev || arriving.oneDev !== undefined ? 'btn btn-solid btn-sm' : 'btn btn-text';
    if (buttons === 'links') {
      return <a key={token} href={openHref(requestLink(transfer), android)} className={className}>{label}</a>;
    }
    return (
      <button key={token} type="button" className={className} onClick={() => void send(token, transfer, amount)} disabled={sending !== null}>{label}</button>
    );
  };
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
  const row = (token: FundingToken) => (
    <div className="cab-send" data-done={received[token] || undefined}>
      <span className="cab-send-k">{tokens[token]}</span>
      <span className="cab-send-amt">{full[token]} {tokenName(token)}</span>
      {fundButton(token)}
    </div>
  );
  const fromWallet = buttons && (
    <>
      {row('oneDev')}
      {row('sol')}
      <p className="note">
        {t(buttons === 'extension' ? 'act_fund_auto_extension' : PHONE_LINK === 'transfer' ? 'act_fund_auto_phone_transfer' : 'act_fund_auto_phone')}
      </p>
      {sending !== null && <Waiting>{t('wallet_extension_waiting')}</Waiting>}
      {outcome && !received[outcome.token] && (outcome.result.ok
        ? <Answered>{t(transferKey(outcome.result))}</Answered>
        : <Failed>{t(transferKey(outcome.result))}</Failed>)}
    </>
  );
  const yourself = (
    <div className="cab-manual">
      <figure className="cab-pay-qr">
        <QrCode text={record.pub} label={t('act_address_qr')} size={196} />
      </figure>
      <div className="cab-manual-t">
        <p className="label">{t('act_address_title')}</p>
        <p className="ent-copy">
          <span className="ent ent-full">{record.pub}</span>
          <Copy value={record.pub} />
        </p>
        <dl className="cab-amts">
          <div><dt>1DEV</dt><dd className="amount"><span className="amount-v num">{full.oneDev}</span> <span className="ent ent-unit"><TokenIcon solana="1DEV" size="text" />{tokenName('oneDev')}</span></dd></div>
          <div><dt>SOL</dt><dd className="amount"><span className="amount-v num">{full.sol}</span> <span className="ent ent-unit"><TokenIcon solana="SOL" size="text" />{tokenName('sol')}</span></dd></div>
        </dl>
      </div>
    </div>
  );
  // What has arrived on the address, per amount, from the balance read (dashes before the first read).
  const meter = (token: FundingToken, need: bigint, decimals: number, of: string) => {
    const has = balance === null ? null : token === 'oneDev' ? balance.oneDev : balance.sol;
    const share = has === null ? 0 : Number(need - left[token]) / Number(need);
    return (
      <div className="cab-meter">
        <span className="label">{t('act_meter_label', { token: tokens[token] })}</span>
        <span className="cab-meter-v">{has === null ? <span className="dash">—</span> : t('act_meter', { received: formatUnits(has, decimals), need: of })}</span>
        <span className="ro-bar" aria-hidden="true"><i style={{ transform: `scaleX(${share.toFixed(4)})` }} /></span>
      </div>
    );
  };
  return (
    <div className="cab-pay">
      {wallet && <p className="cab-step-s">{rich('act_owner', { wallet: <EntityLink kind="address" value={wallet} /> })}</p>}
      <p className="cab-pay-h">{t(ACTIVATION_NETWORK === 'mainnet' ? 'act_mainnet_send' : 'act_testnet_send', { price: number(price), sol })}</p>
      {ACTIVATION_NETWORK === 'testnet' && (
        <p>
          {rich('act_no_tokens', {
            link: (
              <Link href="/testnet#faucet" onClick={toFaucet}>{t('act_no_tokens_link')}</Link>
            ),
          })}
        </p>
      )}
      {fromWallet ? (
        <ViewTabs
          className="cab-modes"
          items={[{ key: 'wallet', label: t('act_fund_auto_title') }, { key: 'manual', label: t('act_fund_manual_title') }]}
          value={mode}
          onChange={setMode}
          label={t('act_address_title')}
        >
          {mode === 'wallet' ? fromWallet : yourself}
        </ViewTabs>
      ) : yourself}
      <div className="cab-meters" aria-live="polite">
        {meter('oneDev', BigInt(price) * ONE_DEV_UNIT, ONE_DEV_DECIMALS, number(price))}
        {meter('sol', FUNDING_SOL_LAMPORTS, SOL_DECIMALS, sol)}
      </div>
    </div>
  );
}

// The burn, and its activation code: the code encodes the wallet that signed the reservation, so it shows once the burn is
// final. A burn whose wallet's node came from another burn (`unused`) shows no code.
export function Receipt({ record, unused = false }: { record: PaymentRecord; unused?: boolean }) {
  const code = unused ? null : receiptCode(record);
  if (!record.burn) return null;
  return (
    <div className="cab-receipt">
      <h4 className="label">{t('act_receipt_title')}</h4>
      <p>{t('act_burned', { amount: number(record.burn.amount) })}</p>
      <Facts>
        <Fact label={t('act_burn_tx')}><EntityLink kind="solana-tx" value={record.burn.tx} /></Fact>
        {code && (
          <Fact label={t('act_code')}>
            <span className="ent-copy"><span className="ent cab-code">{code}</span><Copy value={code} /></span>
          </Fact>
        )}
      </Facts>
      {code && <p className="note">{t('act_code_note')}</p>}
    </div>
  );
}

// A step that deletes the payment key and loses something with it: the page names what is lost, and nothing happens
// before the user confirms (SITE-1, SITE-3).
function ConfirmLoss({ warning, confirm, busy, onConfirm, onBack }: { warning: string; confirm: string; busy: boolean; onConfirm: () => void; onBack: () => void }) {
  return (
    <div className="cab-next" role="alert">
      <p className="rq-failed">{warning}</p>
      <div className="actions cab-next-act">
        <Action kind="solid" onClick={onBack} disabled={busy}>{t('cancel')}</Action>
        <Action kind="text" onClick={onConfirm} disabled={busy}>{confirm}</Action>
      </div>
    </div>
  );
}

// After the burn (flow.ts mayReturnLeftovers): what is left goes back to the wallet now and the key goes; the burn stays
// the wallet's activation, registered later from any browser where the wallet is connected.
export function LeftoversNow({ busy, onSend }: { busy: boolean; onSend: () => void }) {
  return (
    <div className="cab-next">
      <p className="note">{t('act_leftovers_now_note')}</p>
      <div className="cab-next-act"><Action kind="text" onClick={onSend} disabled={busy}>{t('act_leftovers_now')}</Action></div>
    </div>
  );
}

// QNet Wallet's answer, and the check number when the request asked for it.
export function AnswerCheck({ record, onAnswer }: { record: PaymentRecord; onAnswer: (matches: boolean) => void }) {
  if (!record.answer || !record.link) return null;
  const asks = record.link.request.check && !record.answer.checkConfirmed;
  return (
    <div className="cab-sub">
      <p>{rich('act_answer_for', { node: record.answer.nodeId, wallet: <EntityLink kind="address" value={record.answer.qnet} /> })}</p>
      {asks ? (
        <>
          <p className="cab-check-number">{t('act_check', { number: formatCheckNumber(record.answer.checkNumber) })}</p>
          <div className="actions cab-next-act">
            <Action kind="solid" onClick={() => onAnswer(true)}>{t('act_check_yes')}</Action>
            <Action kind="text" onClick={() => onAnswer(false)}>{t('act_check_no')}</Action>
          </div>
        </>
      ) : (
        <Waiting>{t('act_checking_node')}</Waiting>
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
    <div className="cab-manual" role="alert">
      <figure className="cab-pay-qr"><QrCode text={pub} label={t('act_address_qr')} size={196} /></figure>
      <div className="cab-manual-t">
        <p className="rq-failed">{t(ACTIVATION_NETWORK === 'testnet' ? 'act_refund_short_testnet' : 'act_refund_short', { sol: formatUnits(short, SOL_DECIMALS) })}</p>
        <p className="ent-copy"><span className="ent ent-full">{pub}</span><Copy value={pub} /></p>
      </div>
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
      <div className="cab-next">
        {expired && <p>{t('act_expired')}</p>}
        <Waiting>{t('act_closing_empty')}</Waiting>
        <div className="cab-next-act"><Action kind="text" onClick={() => setLeaving(true)} disabled={busy}>{t('act_closing_delete')}</Action></div>
      </div>
    );
  }
  if (dest) {
    return (
      <div className="cab-next">
        {expired && <p>{t('act_expired')}</p>}
        {left && <p>{left}</p>}
        <Waiting>
          {t('act_refund_to')} <span className="ent">{dest}</span>
        </Waiting>
        {lacking}
        {failed && !lacking && <Failed>{t('act_refund_failed')}</Failed>}
      </div>
    );
  }
  return (
    <div className="cab-next">
      {expired && <p>{t('act_expired')}</p>}
      {left && <p>{left}</p>}
      {lacking}
      <p className="note">{t(ask ? 'act_refund_ask' : 'act_refund_enter')}</p>
      {ask}
      <form className="cab-form" onSubmit={submit} noValidate>
        <label className="label" htmlFor="cabinet-refund">{t('act_refund_label')}</label>
        <div className="cab-field-row">
          <input
            id="cabinet-refund"
            className="field mono"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setInvalid(false);
            }}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'cabinet-refund-error' : undefined}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-solid btn-sm" disabled={busy}>{t('act_refund_send')}</button>
        </div>
        {invalid && <p className="cab-field-error" id="cabinet-refund-error" role="alert">{t('act_refund_invalid')}</p>}
        {failed && !lacking && <Failed>{t('act_refund_failed')}</Failed>}
      </form>
      {mayLeave && <div className="cab-next-act"><Action kind="text" onClick={() => setLeaving(true)} disabled={busy}>{t('act_refund_leave')}</Action></div>}
    </div>
  );
}

// The registered node, as the nodes report it now. One wallet, one node: nothing else to activate for it (SITE-F12).
export function Registered({ nodeId }: { nodeId: string }) {
  const { viewOnly } = useCabinet();
  const { state, retry } = useNodeStatus(nodeId, viewOnly);
  return (
    <div className="cab-sub">
      <Answered>{t('act_done')}</Answered>
      <StatusGate state={state} retry={retry}>
        {(status) => (status.deviceBound ? <DeviceRows status={status} /> : <p className="note">{t('act_done_device')}</p>)}
      </StatusGate>
      <div className="cab-next-act">
        <Action kind="solid" href="/node?tab=overview">{t('act_go_cabinet')}</Action>
      </div>
    </div>
  );
}
