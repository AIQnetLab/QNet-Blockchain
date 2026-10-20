// How the explorer writes a transaction's sides and amounts, the same in every table and detail row (B-SPEC 5.7): an
// address is a link to its page (whole where its cell has room), a node id links to its address when that is known, a
// system account is its name, a batch's side is "batch recipients"; an amount's number is text and its unit, with the
// icon, is the link.

import EntityLink, { Amount } from '@/components/ui/EntityLink';
import { Dash } from '@/components/ui/Skeleton';
import { partyKind, type AmountParts } from '@/lib/explorer-view';
import { qnc } from '@/lib/format';
import { txPartyLabel } from '@/lib/tx-labels';

interface PartyProps {
  value: string | null | undefined;
  // The app's view (src/lib/tx-labels.ts) names a system account by what it changes.
  full: boolean;
  // A node's own address, when the record carries it.
  address?: string | null;
  // The whole value, an address with Copy (detail rows), the Copy named by its row.
  whole?: boolean;
  copyName?: string;
}

export function Party({ value, full, address, whole = false, copyName }: PartyProps) {
  switch (partyKind(value)) {
    case 'none':
      return <Dash />;
    case 'address':
      return <EntityLink kind="address" value={value as string} full={whole} copy={whole} copyName={copyName} />;
    case 'batch':
      return <span className="ent">batch recipients</span>;
    case 'system': {
      const name = txPartyLabel(value as string, full);
      return <span className="ent" title={name}>{name}</span>;
    }
    case 'node':
      return <EntityLink kind="node" value={value as string} address={address} full={whole} />;
  }
}

export interface FromToProps {
  from: string | null | undefined;
  to: string | null | undefined;
  full: boolean;
  // The page's own address (its address page): that side in Fog, not a link to the page it is on.
  self?: string;
  // Words for a side the record leaves empty: tokens issued ("Issued", in place of the sender), or burned ("burned",
  // after the sender).
  fromWord?: string;
  toWord?: string;
}

// The sender, "to" and the recipient on one line (owner 20.10); a record with no recipient (a heartbeat, a system
// record) shows its sender alone. Each side shows as much of itself as the cell allows, never less than its short form.
export function FromTo({ from, to, full, self, fromWord, toWord }: FromToProps) {
  const side = (value: string | null | undefined) => (value && value === self
    ? <EntityLink kind="address" value={value} link={false} />
    : <Party value={value} full={full} />);
  const noFrom = partyKind(from) === 'none';
  const noTo = partyKind(to) === 'none';
  return (
    <span className="ex-ft ent-fit">
      {noFrom && fromWord ? <span className="ex-ft-w">{fromWord}</span> : side(from)}
      {!noTo && <span className="ex-ft-to">to</span>}
      {!noTo && side(to)}
      {noTo && toWord && <span className="ex-ft-w">{toWord}</span>}
    </span>
  );
}

interface TxAmountProps {
  // The exact amount (explorer-view.ts rowAmount); null for a transaction that moves none.
  parts: AmountParts | null;
  logo?: string | null;
  // The side it moves to an address's own list: "+" in, "−" out.
  sign?: '+' | '−' | '';
}

export function TxAmount({ parts, logo, sign = '' }: TxAmountProps) {
  if (!parts) return <Dash />;
  // A unit with no page known here stays text with its number.
  if (!parts.token && parts.unit !== 'QNC') return <span className="amount"><span className="amount-v num">{sign}{parts.value} {parts.unit}</span></span>;
  return <Amount value={`${sign}${parts.value}`} token={parts.token} symbol={parts.token ? parts.unit : null} logo={logo} />;
}

// An exact QNC amount from nano QNC (detail pages); nothing moved reads "—".
export function QncAmount({ nano }: { nano: string | number | null | undefined }) {
  if (nano === null || nano === undefined || /^0*$/.test(String(nano))) return <Dash />;
  return <Amount value={qnc(nano)} />;
}
