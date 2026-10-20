'use client';

// A token (B-SPEC 6.6): its name and icon as the title, the contract spaced at its structure with Copy; readouts for its
// supply, holders, issued total and decimals; then Transfers, Holders and Contract. The server renders the first
// answers into the page (page.tsx), so its head and tables are final from the first paint. Transfers follow the chain
// (read again as the head moves, at most every 10 s, only while the tab is shown); holders are a heavier read, made once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import TokenIcon from '@/components/TokenIcon';
import OnHead from '@/components/explorer/OnHead';
import { Row, Rows, Whole } from '@/components/explorer/Detail';
import { Party } from '@/components/explorer/cells';
import { amountCol, blockCol, fromToCol, hashCol, holderCols, textCol, timeCol } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { AddressParts } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import ViewTabs from '@/components/ui/ViewTabs';
import { useActivationContent } from '@/contexts/AppContext';
import { isAddressShape } from '@/lib/entity';
import { TOKEN_HOLDERS_FIRST, TOKEN_TRANSFERS_FIRST, readRecord, tokenHoldersPath, tokenPath } from '@/lib/explorer-reads';
import { int, short } from '@/lib/format';
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

// The standard method surface of a token: the protocol's own token logic, the same for every token of a standard.
const QRC20_INTERFACE = [
  { kind: 'read', sig: 'balanceOf(address)', desc: 'Token balance of an address' },
  { kind: 'read', sig: 'totalSupply()', desc: 'Total tokens in circulation' },
  { kind: 'read', sig: 'allowance(owner, spender)', desc: 'Remaining approved amount' },
  { kind: 'write', sig: 'transfer(to, amount)', desc: 'Send tokens' },
  { kind: 'write', sig: 'approve(spender, amount)', desc: 'Authorize a spender' },
  { kind: 'write', sig: 'transferFrom(from, to, amount)', desc: 'Move approved tokens' },
  { kind: 'write', sig: 'mint(to, amount)', desc: 'Issue tokens (if mintable, owner)' },
  { kind: 'write', sig: 'burn(amount)', desc: 'Destroy tokens (if burnable)' },
];
const QRC721_INTERFACE = [
  { kind: 'read', sig: 'ownerOf(tokenId)', desc: 'Owner of an NFT id' },
  { kind: 'read', sig: 'balanceOf(address)', desc: 'Number of NFTs held' },
  { kind: 'write', sig: 'transfer(to, tokenId)', desc: 'Send an NFT' },
  { kind: 'write', sig: 'approve(spender, tokenId)', desc: 'Authorize a spender for one NFT' },
  { kind: 'write', sig: 'transferFrom(from, to, tokenId)', desc: 'Move an approved NFT' },
  { kind: 'write', sig: 'mint(to, tokenId)', desc: 'Issue a new NFT (owner)' },
];
type Method = (typeof QRC20_INTERFACE)[number];

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
      const res = await fetch(tokenPath(contract, txLimit));
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
        const res = await fetch(path);
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
        const res = await fetch(`/api/tokens?search=${encodeURIComponent(contract)}&perPage=5`);
        const result = await res.json();
        const hit = (result?.data?.tokens ?? []).find((t: { contract_address: string }) => t.contract_address === contract);
        setDeployTx(hit?.deploy_hash || '');
      } catch {
        setDeployTx('');
      }
    })();
  }, [tab, deployTx, contract]);

  const d = data;
  // The standard from node state; a transfer of an NFT id marks a collection on an older node.
  const nft = d ? d.standard === 'qrc721' || d.transfers.some((t) => t.std === 'qrc721') : false;
  const std = nft ? 'QRC-721' : 'QRC-20';
  const symbol = d?.symbol ?? '';
  const units = (value: string) => <span className="amount-v num">{value} <span className="fog">{symbol}</span></span>;

  const transferColumns = useMemo(() => [
    hashCol<TokenTransfer>((t) => t.hash),
    textCol<TokenTransfer>('method', 'Method', (t) => <span className="ent">{t.method}</span>, 104),
    fromToCol<TokenTransfer>((t) => t.from, (t) => t.to, full, () => ({ toWord: 'burned' })),
    amountCol<TokenTransfer>((t) => units(t.amount)),
    blockCol<TokenTransfer>((t) => t.block),
    timeCol<TokenTransfer>((t) => t.timestamp),
  ], [full, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const holderColumns = useMemo(() => holderCols<TokenHolder & { rank: number }>((h) => units(h.balance), full), [full, symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const rankedHolders = useMemo(() => (holders ? holders.map((h, i) => ({ ...h, rank: i + 1 })) : null), [holders]);

  const methodColumns = useMemo(() => [
    textCol<Method>('kind', 'Kind', (m) => <span className={m.kind === 'read' ? 'fog' : undefined}>{m.kind}</span>, 88),
    textCol<Method>('sig', 'Method', (m) => <span className="ent">{m.sig}</span>, 280),
    textCol<Method>('desc', 'What it does', (m) => m.desc, undefined, undefined, 280),
  ], []);

  const title = d ? d.name || d.symbol || short('address', contract) : isAddressShape(contract) ? short('address', contract) : contract;
  // No such token: a plain title, the value asked for as one whole line, and no readouts or rows that would never fill.
  const absent = phase === 'missing' && !d;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={absent ? undefined : `${std} token`}
        title={absent ? 'Token' : <span className="ex-title-icon"><TokenIcon logo={d?.logo} symbol={d?.symbol} address={contract} size={44} />{title}</span>}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label="This token">
              <Readout label="Circulating supply" value={d && !nft ? d.total_supply : null} amount={{ token: contract, symbol, logo: d?.logo, link: false }} sub={nft ? 'A collection keeps no supply count' : 'Issued less destroyed'} />
              <Readout label="Holders" value={holderCount !== null ? `${int(holderCount)}${holdersTruncated ? '+' : ''}` : null} sub="Addresses with a balance" />
              <Readout label="Total issued" value={d && !nft ? d.total_minted : null} amount={{ token: contract, symbol, logo: d?.logo, link: false }} sub={d && !nft ? `${d.total_burned} ${symbol} burned` : 'Since it was deployed'} />
              <Readout label="Decimals" value={d ? int(d.decimals) : null} sub="Places after the point" />
            </Readouts>
          </div>
        )}
      >
        {absent
          ? <Whole value={contract} name="contract address" />
          : <Whole value={isAddressShape(contract) ? contract : null} name="contract address" length={46}>{isAddressShape(contract) ? <AddressParts value={contract} /> : undefined}</Whole>}
        {phase === 'missing' && <p className="ex-error" role="status">No token has this contract address.</p>}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">Could not read this token. <Action kind="act" onClick={() => void fetchToken()}>Try again</Action></p>
        )}
      </PageHead>

      {!absent && <div className="wrap ex-body">
        {first && <OnHead every={REFRESH_MS} onHead={() => void fetchToken()} />}
        <ViewTabs
          label="Token views"
          value={tab}
          onChange={setTab}
          items={[
            { key: 'transfers', label: 'Transfers' },
            // The count is the Holders readout's; a tab label that grew with it would push the next tab.
            { key: 'holders', label: 'Holders' },
            { key: 'contract', label: 'Contract' },
          ]}
        >
          <div className="ex-tabpanel">
            {tab === 'transfers' && (
              <>
                <DataTable caption="Recent transfers of this token" columns={transferColumns} rows={d ? d.transfers : null} rowKey={(t) => `${t.hash}:${t.token_id}:${t.to}`} empty="No transfers indexed yet." />
                {d && d.transfers.length >= txLimit && txLimit < MAX_ROWS && (
                  <div className="actions"><Action kind="text" onClick={() => setTxLimit((l) => Math.min(l + 50, MAX_ROWS))}>Show more</Action></div>
                )}
              </>
            )}
            {tab === 'holders' && (
              <>
                {holdersTruncated && <p className="note">Balances come from the most recent transfers only, so for a very busy token they can be approximate.</p>}
                <DataTable stack="holders" caption="Holders of this token" columns={holderColumns} rows={rankedHolders} rowKey={(h) => h.address} empty="No holders indexed yet." />
                {holders && holders.length >= holderLimit && holderLimit < MAX_ROWS && (
                  <div className="actions"><Action kind="text" onClick={() => setHolderLimit((l) => Math.min(l + 100, MAX_ROWS))}>Show more</Action></div>
                )}
              </>
            )}
            {tab === 'contract' && (
              <>
                <Rows label="Contract">
                  <Row label="Standard">{std}: the protocol&apos;s own token logic, not custom bytecode, so no per-contract source check is needed</Row>
                  <Row label="Deployer">{d ? <Party value={d.deployer} full={full} whole copyName="deployer address" /> : null}</Row>
                  <Row label="Deploy transaction">{deployTx ? <EntityLink kind="tx" value={deployTx} copy /> : null}</Row>
                  <Row label="Deployed">{d?.deployed_at || null}</Row>
                </Rows>
                <DataTable title="Standard interface" caption={`The ${std} methods`} columns={methodColumns} rows={nft ? QRC721_INTERFACE : QRC20_INTERFACE} rowKey={(m) => m.sig} />
              </>
            )}
          </div>
        </ViewTabs>
      </div>}
    </div>
  );
}
