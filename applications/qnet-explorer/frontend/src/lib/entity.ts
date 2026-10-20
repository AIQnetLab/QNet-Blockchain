// Where each entity the site names leads, and how it is written (B-SPEC 5.7, owner 19.10): blocks, transactions,
// addresses, node ids, tokens, QNC, epochs and Solana transactions. One rule set for every table, readout, detail row
// and menu; only a node id without a known address and a name without a page are text. components/ui/EntityLink.tsx
// renders it.

import { EPOCH_BLOCKS } from './cabinet/epochs.ts';
import { int, short } from './format.ts';
import { solanaTxUrl } from './one-dev.ts';

export type EntityKind = 'block' | 'tx' | 'address' | 'node' | 'token' | 'qnc' | 'epoch' | 'solana-tx';

export interface EntityOptions {
  // A node's own QNet Blockchain address, when known (a block's producer_address, a heartbeat's node_address).
  address?: string | null;
  // A token's symbol, shown in place of its contract.
  symbol?: string | null;
  // The whole value instead of its short form.
  full?: boolean;
  // The 4…4 form of an address (the phone header).
  compact?: boolean;
}

export interface Entity {
  href: string | null;
  text: string;
  // The whole value, for the title and the accessible name.
  title: string;
  external: boolean;
}

// A QNet Blockchain address or contract by its shape: 19 hex, "eon", 15 hex and the 8-hex check. The address page checks
// the rest; a value of another shape (a system account, a node id) has no page.
const EON_SHAPE = /^[0-9a-f]{19}eon[0-9a-f]{23}$/;
const HEIGHT = /^(0|[1-9][0-9]{0,15})$/;
const HASH = /^[0-9a-fA-F]{16,128}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

export const isAddressShape = (value: unknown): value is string => typeof value === 'string' && EON_SHAPE.test(value);
export const isHeight = (value: unknown): boolean => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && HEIGHT.test(value));

// An epoch has no page of its own: it leads to its first block (epoch N holds blocks N × 14,400 to (N + 1) × 14,400 - 1).
export const epochHref = (epoch: number): string => `/explorer/block/${epoch * EPOCH_BLOCKS}`;

export function entity(kind: EntityKind, value: string | number, options: EntityOptions = {}): Entity {
  const raw = String(value);
  const plain = (text: string): Entity => ({ href: null, text, title: raw, external: false });
  const page = (href: string, text: string): Entity => ({ href, text, title: raw, external: false });
  switch (kind) {
    case 'block':
      if (isHeight(value)) return page(`/explorer/block/${Number(raw)}`, int(Number(raw)));
      return HASH.test(raw) ? page(`/explorer/block/${raw}`, options.full ? raw : short('hash', raw)) : plain(raw);
    case 'tx':
      return HASH.test(raw) ? page(`/explorer/tx/${raw}`, options.full ? raw : short('hash', raw)) : plain(raw);
    case 'address': {
      const text = options.full ? raw : short(options.compact ? 'address-compact' : 'address', raw);
      return isAddressShape(raw) ? page(`/explorer/address/${raw}`, text) : plain(raw);
    }
    case 'node': {
      const text = options.full ? raw : short('node', raw);
      return isAddressShape(options.address) ? { ...page(`/explorer/address/${options.address}`, text), title: `${raw} · ${options.address}` } : plain(text);
    }
    case 'token':
      return isAddressShape(raw) ? page(`/explorer/token/${raw}`, options.symbol || short('address', raw)) : plain(options.symbol || raw);
    case 'qnc':
      return { href: '/explorer/qnc', text: 'QNC', title: 'QNC', external: false };
    case 'epoch': {
      if (!isHeight(value)) return plain(raw);
      const n = Number(raw);
      return { href: epochHref(n), text: `Epoch ${int(n)}`, title: `Epoch ${int(n)}, from block ${int(n * EPOCH_BLOCKS)}`, external: false };
    }
    case 'solana-tx':
      return SOLANA_SIGNATURE.test(raw)
        ? { href: solanaTxUrl(raw), text: options.full ? raw : short('solana', raw), title: raw, external: true }
        : plain(raw);
  }
}
