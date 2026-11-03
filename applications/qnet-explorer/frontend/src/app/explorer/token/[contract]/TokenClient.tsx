'use client';

// A token: its name and icon as the title, the contract spaced at its structure with Copy; readouts for its
// supply, holders, issued total and decimals; then Transfers, Holders and Contract. The server renders the first
// answers into the page (page.tsx), so its head and tables are final from the first paint. Transfers follow the chain
// (read again as the head moves, at most every 10 s, only while the tab is shown); holders are a heavier read, made once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import TokenIcon from '@/components/TokenIcon';
import OnHead from '@/components/explorer/OnHead';
import { Row, Rows, Whole } from '@/components/explorer/Detail';
import { Party } from '@/components/explorer/cells';
import { amountCol, blockCol, fromToCol, hashCol, holderCols, textCol, timeCol, useSteadyWidth } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { AddressParts } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import ViewTabs from '@/components/ui/ViewTabs';
import { useActivationContent } from '@/contexts/AppContext';
import { useT } from '@/i18n/client';
import { isAddressShape } from '@/lib/entity';
import { TOKEN_HOLDERS_FIRST, TOKEN_TRANSFERS_FIRST, readRecord, tokenHoldersPath, tokenPath } from '@/lib/explorer-reads';
import { int, short } from '@/lib/format';
import { amountWidth, wordsWidth } from '@/lib/geometry';
import { siteRequest } from '@/lib/site-request';
import type { MessageKey } from '@/lib/texts';
import type { FirstAnswer } from '@/server/first-answer';

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  std: string;        // qrc20 | qrc721
  token_id: string;   // NFT id (qrc721); '' for qrc20
  amount: string;     // qrc20: decimal amount; qrc721: "#<token_id>"
  amountRaw: string;
  method: string;
  block: number;
  timestamp: number;
  status: string;
}

interface TokenHolder {
  address: string;
  balance: string;
  balance_raw: string;
  percent: string;
}

interface TokenData {
  contract_address: string;
  standard?: string;   // 'qrc20' | 'qrc721' — authoritative token standard from node state
  name: string;
  symbol: string;
  logo?: string;
  decimals: number;
  total_supply: string;
  total_supply_raw: string;
  total_minted: string;
  total_burned: string;
  deployer: string;
  deployed_at: string;
  transfers: TokenTransfer[];
}

type Tab = 'transfers' | 'holders' | 'contract';
type Phase = 'loading' | 'ready' | 'missing' | 'failed';

const REFRESH_MS = 10_000;
const MAX_ROWS = 500;

// The standard method surface of a token: the protocol's own token logic, the same for every token of a standard. The
// signature is code; what it does is in the page's language.
interface Method { kind: 'read' | 'write'; sig: string; desc: MessageKey }
const QRC20_INTERFACE: Method[] = [
  { kind: 'read', sig: 'balanceOf(address)', desc: 'tok_m_balance' },
  { kind: 'read', sig: 'totalSupply()', desc: 'tok_m_supply' },
  { kind: 'read', sig: 'allowance(owner, spender)', desc: 'tok_m_allowance' },
  { kind: 'write', sig: 'transfer(to, amount)', desc: 'tok_m_transfer' },
  { kind: 'write', sig: 'approve(spender, amount)', desc: 'tok_m_approve' },
  { kind: 'write', sig: 'transferFrom(from, to, amount)', desc: 'tok_m_transfer_from' },
  { kind: 'write', sig: 'mint(to, amount)', desc: 'tok_m_mint' },
  { kind: 'write', sig: 'burn(amount)', desc: 'tok_m_burn' },
];
const QRC721_INTERFACE: Method[] = [
  { kind: 'read', sig: 'ownerOf(tokenId)', desc: 'tok_m_owner_of' },
  { kind: 'read', sig: 'balanceOf(address)', desc: 'tok_m_nft_balance' },
  { kind: 'write', sig: 'transfer(to, tokenId)', desc: 'tok_m_nft_transfer' },
  { kind: 'write', sig: 'approve(spender, tokenId)', desc: 'tok_m_nft_approve' },
  { kind: 'write', sig: 'transferFrom(from, to, tokenId)', desc: 'tok_m_nft_transfer_from' },
  { kind: 'write', sig: 'mint(to, tokenId)', desc: 'tok_m_nft_mint' },
];

// The first answers of the token and holders routes, read by the server (null: it had none, the client reads it).
export interface TokenFirst {
  token: FirstAnswer | null;
  holders: FirstAnswer | null;
}

interface HoldersRead {
  holders: TokenHolder[];
  count: number | null;
  truncated: boolean;
}

// The token route says no such token by 404 or 400.
const NO_TOKEN = [404, 400];

// One reading of a holders answer, for the server's first answer and the client's later reads alike.
function readHolders(body: unknown): HoldersRead | null {
  const result = body as { success?: boolean; data?: { holders?: TokenHolder[]; holder_count?: unknown; truncated?: unknown } } | null;
  if (!result?.success || !result.data) return null;
  return { holders: result.data.holders || [], count: typeof result.data.holder_count === 'number' ? result.data.holder_count : null, truncated: result.data.truncated === true };
}

// `first` is absent while the route loads (loading.tsx): the page's final shape with nothing in it, and no reads.
export default function TokenClient({ first }: { first?: TokenFirst }) {
  const t = useT();
  const params = useParams();
  const contract = params.contract as string;
  // A system account shown by name reads without its reward word in the app's view (src/lib/tx-labels.ts).
  const full = useActivationContent();
  const [initial] = useState(() => ({
    token: first?.token ? readRecord<TokenData>(first.token.status, first.token.body, NO_TOKEN) : null,
    holders: first?.holders ? readHolders(first.holders.body) ?? { holders: [], count: null, truncated: false } : null,
  }));
  const [data, setData] = useState<TokenData | null>(initial.token?.record ?? null);
  const [phase, setPhase] = useState<Phase>(initial.token?.phase ?? 'loading');
  const [holders, setHolders] = useState<TokenHolder[] | null>(initial.holders?.holders ?? null);
  const [holderCount, setHolderCount] = useState<number | null>(initial.holders?.count ?? null);
  const [holdersTruncated, setHoldersTruncated] = useState(initial.holders?.truncated ?? false);
  const [txLimit, setTxLimit] = useState(TOKEN_TRANSFERS_FIRST);
  const [holderLimit, setHolderLimit] = useState(TOKEN_HOLDERS_FIRST);
  const [tab, setTab] = useState<Tab>('transfers');
  const [deployTx, setDeployTx] = useState<string | null>(null);
  // The reads whose answers are on screen: the server's, when it read them.
  const shownToken = useRef(first?.token ? tokenPath(contract, TOKEN_TRANSFERS_FIRST) : null);
  const shownHolders = useRef(first?.holders ? tokenHoldersPath(contract, TOKEN_HOLDERS_FIRST) : null);

  const fetchToken = useCallback(async () => {
    if (!contract) return;
    try {
      const res = await fetch(tokenPath(contract, txLimit), siteRequest());
      const read = readRecord<TokenData>(res.status, await res.json(), NO_TOKEN);
      if (read.record) {
        setData(read.record);
        setPhase('ready');
      } else {
        // A refresh that fails keeps what is shown.
        setPhase((p) => (p === 'ready' ? p : read.phase));
      }
    } catch {
      setPhase((p) => (p === 'ready' ? p : 'failed'));
    }
  }, [contract, txLimit]);

  // The loading state reads nothing, and an answer already shown is not read again.
  useEffect(() => {
    const path = tokenPath(contract, txLimit);
    if (!contract || first === undefined || path === shownToken.current) return;
    shownToken.current = path;
    void fetchToken();
  }, [fetchToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Holders (from the explorer's index): a heavier replay than transfers, read once and when more are asked for.
  useEffect(() => {
    const path = tokenHoldersPath(contract, holderLimit);
    if (!contract || first === undefined || path === shownHolders.current) return;
    shownHolders.current = path;
    (async () => {
      try {
        const res = await fetch(path, siteRequest());
        const read = readHolders(await res.json());
        if (read) {
          setHolders(read.holders);
          setHolderCount(read.count);
          setHoldersTruncated(read.truncated);
        } else setHolders((h) => h ?? []);
      } catch {
        setHolders((h) => h ?? []);
      }
    })();
  }, [contract, holderLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  // The deploy transaction, from the token directory, once the Contract tab is opened.
  useEffect(() => {
    if (tab !== 'contract' || deployTx !== null || !contract) return;
    (async () => {
      try {
        const res = await fetch(`/api/tokens?search=${encodeURIComponent(contract)}&perPage=5`, siteRequest());
        const result = await res.json();
        const hit = (result?.data?.tokens ?? []).find((x: { contract_address: string }) => x.contract_address === contract);
        setDeployTx(hit?.deploy_hash || '');
      } catch {
        setDeployTx('');
      }
    })();
  }, [tab, deployTx, contract]);

  const d = data;
  // The standard from node state; a transfer of an NFT id marks a collection on an older node.
  const nft = d ? d.standard === 'qrc721' || d.transfers.some((x) => x.std === 'qrc721') : false;
  const std = nft ? 'QRC-721' : 'QRC-20';
  const symbol = d?.symbol ?? '';
  const units = (value: string) => <span className="amount-v num">{value} <span className="fog">{symbol}</span></span>;

  // Each amount column as wide as its longest value with the symbol, so an amount to 18 decimals never runs into the
  // next column; the transfers' keep their widest width for the token while the list refreshes.
  const transferAmountW = useSteadyWidth(useMemo(() => amountWidth((d?.transfers ?? []).map((x) => ({ value: x.amount, unit: symbol }))), [d?.transfers, symbol]), contract);
  const transferColumns = useMemo(() => [
    hashCol<TokenTransfer>(t, (x) => x.hash),
    textCol<TokenTransfer>('method', t('tx_method'), (x) => <span className="ent">{x.method}</span>, 104),
    fromToCol<TokenTransfer>(t, (x) => x.from, (x) => x.to, full, () => ({ toWord: t('tok_burned') })),
    amountCol<TokenTransfer>(t, (x) => units(x.amount), t('col_amount'), transferAmountW),
    blockCol<TokenTransfer>(t, (x) => x.block),
    timeCol<TokenTransfer>(t, (x) => x.timestamp),
  ], [t, full, symbol, transferAmountW]); // eslint-disable-line react-hooks/exhaustive-deps

  const holderColumns = useMemo(
    () => holderCols<TokenHolder & { rank: number }>(t, (h) => units(h.balance), full, (holders ?? []).map((h) => ({ value: h.balance, unit: symbol }))),
    [t, full, symbol, holders], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rankedHolders = useMemo(() => (holders ? holders.map((h, i) => ({ ...h, rank: i + 1 })) : null), [holders]);

  const methodColumns = useMemo(() => [
    textCol<Method>('kind', t('tok_kind'), (m) => <span className={m.kind === 'read' ? 'fog' : undefined}>{t(m.kind === 'read' ? 'tok_kind_read' : 'tok_kind_write')}</span>, 88),
    textCol<Method>('sig', t('tx_method'), (m) => <span className="ent">{m.sig}</span>, 280),
    // What a method does is one line, its column as wide as the longest in the page's language.
    textCol<Method>('desc', t('tok_what'), (m) => t(m.desc), undefined, undefined, Math.max(280, wordsWidth([...QRC20_INTERFACE, ...QRC721_INTERFACE].map((m) => t(m.desc))))),
  ], [t]);

  const title = d ? d.name || d.symbol || short('address', contract) : isAddressShape(contract) ? short('address', contract) : contract;
  // No such token: a plain title, the value asked for as one whole line, and no readouts or rows that would never fill.
  const absent = phase === 'missing' && !d;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={absent ? undefined : t('tok_kicker', { standard: std })}
        title={absent ? t('col_token') : <span className="ex-title-icon"><TokenIcon logo={d?.logo} symbol={d?.symbol} address={contract} size={44} />{title}</span>}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label={t('tok_this')}>
              <Readout label={t('tok_circulating')} value={d && !nft ? d.total_supply : null} amount={{ token: contract, symbol, logo: d?.logo, link: false }} sub={nft ? t('tok_no_supply') : t('tok_circulating_sub')} />
              <Readout label={t('tok_holders')} value={holderCount !== null ? `${int(holderCount)}${holdersTruncated ? '+' : ''}` : null} sub={t('tok_holders_sub')} />
              <Readout label={t('tok_issued')} value={d && !nft ? d.total_minted : null} amount={{ token: contract, symbol, logo: d?.logo, link: false }} sub={d && !nft ? t('tok_burned_sub', { amount: d.total_burned, symbol }) : t('tok_issued_sub')} />
              <Readout label={t('tok_decimals')} value={d ? int(d.decimals) : null} sub={t('tok_decimals_sub')} />
            </Readouts>
          </div>
        )}
      >
        {absent
          ? <Whole value={contract} name={t('tok_contract_address')} />
          : <Whole value={isAddressShape(contract) ? contract : null} name={t('tok_contract_address')} length={46}>{isAddressShape(contract) ? <AddressParts value={contract} /> : undefined}</Whole>}
        {phase === 'missing' && <p className="ex-error" role="status">{t('tok_missing')}</p>}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">{t('tok_unreadable')} <Action kind="act" onClick={() => void fetchToken()}>{t('try_again')}</Action></p>
        )}
      </PageHead>

      {!absent && <div className="wrap ex-body">
        {first && <OnHead every={REFRESH_MS} onHead={() => void fetchToken()} />}
        <ViewTabs
          label={t('tok_views')}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'transfers', label: t('tok_transfers') },
            // The count is the Holders readout's; a tab label that grew with it would push the next tab.
            { key: 'holders', label: t('tok_holders') },
            { key: 'contract', label: t('tx_contract') },
          ]}
        >
          <div className="ex-tabpanel">
            {tab === 'transfers' && (
              <>
                <DataTable caption={t('tok_transfers_caption')} columns={transferColumns} rows={d ? d.transfers : null} rowKey={(x) => `${x.hash}:${x.token_id}:${x.to}`} empty={t('tok_no_transfers')} />
                {d && d.transfers.length >= txLimit && txLimit < MAX_ROWS && (
                  <div className="actions"><Action kind="text" onClick={() => setTxLimit((l) => Math.min(l + 50, MAX_ROWS))}>{t('history_more')}</Action></div>
                )}
              </>
            )}
            {tab === 'holders' && (
              <>
                {holdersTruncated && <p className="note">{t('tok_holders_approx')}</p>}
                <DataTable stack="holders" caption={t('tok_holders_caption')} columns={holderColumns} rows={rankedHolders} rowKey={(h) => h.address} empty={t('tok_no_holders')} />
                {holders && holders.length >= holderLimit && holderLimit < MAX_ROWS && (
                  <div className="actions"><Action kind="text" onClick={() => setHolderLimit((l) => Math.min(l + 100, MAX_ROWS))}>{t('history_more')}</Action></div>
                )}
              </>
            )}
            {tab === 'contract' && (
              <>
                <Rows label={t('tx_contract')}>
                  <Row label={t('tok_standard')}>{t('tok_standard_value', { standard: std })}</Row>
                  <Row label={t('tok_deployer')}>{d ? <Party value={d.deployer} full={full} whole copyName={t('tok_deployer_address')} /> : null}</Row>
                  <Row label={t('tok_deploy_tx')}>{deployTx ? <EntityLink kind="tx" value={deployTx} copy /> : null}</Row>
                  <Row label={t('tok_deployed')}>{d?.deployed_at || null}</Row>
                </Rows>
                <DataTable title={t('tok_interface')} caption={t('tok_interface_caption', { standard: std })} columns={methodColumns} rows={nft ? QRC721_INTERFACE : QRC20_INTERFACE} rowKey={(m) => m.sig} />
              </>
            )}
          </div>
        </ViewTabs>
      </div>}
    </div>
  );
}
