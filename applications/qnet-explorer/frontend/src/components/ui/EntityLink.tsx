'use client';

// One look for every entity the site names: blocks, transactions, addresses, node ids, tokens, QNC,
// epochs and Solana transactions. A kind with a page is a Signal link; a kind without one is the same mono text in Paper.
// The full value is in the title and the accessible name. Routes and short forms: src/lib/entity.ts.

import type { CSSProperties, ReactNode } from 'react';
import TokenIcon from '@/components/TokenIcon';
import Copy from './Copy';
import IntentLink from './IntentLink';
import { useT } from '@/i18n/client';
import { entity, isAddressShape, type EntityKind } from '@/lib/entity';
import { int } from '@/lib/format';
import type { MessageKey } from '@/lib/texts';

interface EntityLinkProps {
  kind: EntityKind;
  value: string | number;
  // The whole value (detail pages, the account menu); an address is spaced at its own structure.
  full?: boolean;
  // A node's own address (its link), a token's symbol.
  address?: string | null;
  symbol?: string | null;
  // The 4…4 form of an address.
  compact?: boolean;
  // A Copy act after the value; `copyName` says what it copies where the kind alone repeats on the page.
  copy?: boolean;
  copyName?: string;
  // The text in place of the entity's own, where the column already names the kind (an epoch's number).
  label?: string;
  // false: a second view of an entity its row already links (a block's hash beside its height), in Fog, not a link.
  link?: boolean;
  className?: string;
}

// Kinds whose short form stands for a longer value: where the page sizes the room (a table's flexible column, a side of
// From / To), the value shows as much as fits, whole when it does, cut in the middle (styles/base.css .ent-cut).
const CUTS: ReadonlySet<EntityKind> = new Set(['block', 'tx', 'address', 'node']);

// What a Copy after the value copies, for its accessible name.
const COPIES: Record<EntityKind, MessageKey> = {
  block: 'copy_block', tx: 'copy_tx', address: 'account_copy', node: 'copy_node', token: 'copy_contract', qnc: 'copy_qnc', epoch: 'copy_epoch', 'solana-tx': 'copy_solana_tx',
};

// An address spaced as 19 hex · eon · 15 hex · the 8-hex check, by margins between spans: a selection copies it exactly.
export function AddressParts({ value }: { value: string }) {
  if (!isAddressShape(value)) return <>{value}</>;
  return (
    <span className="addr" translate="no">
      <span className="addr-part">{value.slice(0, 19)}</span>
      <span className="addr-part addr-eon">eon</span>
      <span className="addr-part">{value.slice(22, 37)}</span>
      <span className="addr-part">{value.slice(37)}</span>
    </span>
  );
}

export default function EntityLink({ kind, value, full = false, address, symbol, compact, copy = false, copyName, label, link = true, className }: EntityLinkProps) {
  const t = useT();
  const e = entity(kind, value, t, { full, address, symbol, compact });
  const raw = String(value);
  // Only a shortened value has more to show (a block height is never shortened, only grouped): the head of the whole
  // value and the tail of its short form, at the narrowest four characters of the head, "…" and the tail.
  const at = !full && !compact && label === undefined && CUTS.has(kind) ? e.text.indexOf('…') : -1;
  const tail = at > 0 ? e.text.slice(at + 1) : '';
  const cut = at > 0 ? ({ '--ent-min': `${Math.min(e.text.length, tail.length + 5)}ch` } as CSSProperties) : undefined;
  const cls = `ent${full ? ' ent-full' : ''}${at > 0 ? ' ent-cut' : ''}${link ? '' : ' fog'}${className ? ` ${className}` : ''}`;
  let text: ReactNode = label ?? e.text;
  if (full && (kind === 'address' || kind === 'token') && isAddressShape(raw)) text = <AddressParts value={raw} />;
  else if (at > 0) {
    text = (
      <>
        <span className="ent-short">{e.text}</span>
        <span className="ent-mid">
          <span className="ent-mid-h">{raw.slice(0, raw.length - tail.length)}</span>
          <span className="ent-mid-t">{tail}</span>
        </span>
      </>
    );
  }
  const content = kind === 'token' && !full ? (
    <span className="ent-unit"><TokenIcon address={raw} symbol={symbol} size="text" />{text}</span>
  ) : text;
  // translate="no": a browser's page translation would rewrite the value and the text nodes the page updates.
  let shown;
  if (!e.href || !link) {
    shown = <span className={cls} title={e.title} style={cut} translate="no">{content}</span>;
  } else if (e.external) {
    shown = <a className={cls} href={e.href} target="_blank" rel="noopener noreferrer" title={e.title} aria-label={e.title} translate="no">{content}</a>;
  } else {
    shown = <IntentLink className={cls} href={e.href} title={e.title} aria-label={e.title} style={cut} translate="no">{content}</IntentLink>;
  }
  if (!copy) return shown;
  return <span className="ent-copy">{shown}<Copy value={raw} ariaLabel={copyName ? t('copy_named', { name: copyName }) : t(COPIES[kind])} /></span>;
}

// An epoch named by its number where the words around it say "epoch" (a sentence, a column, a label): the number is the
// link to the epoch's first block.
export function EpochNumber({ epoch }: { epoch: number }) {
  return <EntityLink kind="epoch" value={epoch} label={int(epoch)} />;
}

export interface AmountToken {
  token?: string | null;
  symbol?: string | null;
  logo?: string | null;
  // A Solana asset (the activation's payment, the faucet): its own icon, named by `symbol` when the page words it
  // ("test 1DEV"); no page of this site is its, so it is never a link.
  solana?: 'SOL' | '1DEV' | null;
}

// An amount's unit: the token's icon and its symbol at the size of the number beside it, the link to the token's page
// or QNC's (`link` false on that very page). One unit for every amount: lists, readouts and figures.
export function AmountUnit({ token, symbol, logo, solana, link = true }: AmountToken & { link?: boolean }) {
  const t = useT();
  if (solana) return <span className="ent ent-unit" translate="no"><TokenIcon solana={solana} size="text" />{symbol || solana}</span>;
  const isToken = Boolean(token && isAddressShape(token));
  const content = isToken
    ? <><TokenIcon address={token} symbol={symbol} logo={logo} size="text" />{symbol || t('token_unnamed')}</>
    : <><TokenIcon native size="text" />QNC</>;
  if (!link) return <span className="ent ent-unit" translate="no">{content}</span>;
  return (
    <IntentLink className="ent ent-unit" href={isToken ? `/explorer/token/${token}` : '/explorer/qnc'} title={isToken ? token! : 'QNC'} translate="no">
      {content}
    </IntentLink>
  );
}

// The text an amount's unit reads as (a Solana asset's name, a token's symbol, Token, or QNC); `unnamed` is the word for
// a token without a symbol.
export const unitText = ({ token, symbol, solana }: AmountToken, unnamed: string) => (solana ? symbol || solana
  : token && isAddressShape(token) ? symbol || unnamed : 'QNC');

// An amount: the number is Paper text, the unit with its icon is the link to the token or QNC page; number, icon and
// unit stand on one baseline at one size (styles/base.css .amount).
export function Amount({ value, token, symbol, logo, solana }: { value: string } & AmountToken) {
  const t = useT();
  return (
    <span className="amount" title={`${value} ${unitText({ token, symbol, solana }, t('token_unnamed'))}`}>
      <span className="amount-v num" translate="no">{value}</span> <AmountUnit token={token} symbol={symbol} logo={logo} solana={solana} />
    </span>
  );
}
