'use client';

// My node's sections: on a computer a rail beside the section, headed by the node it shows; on a phone the
// node's line over the section and the same list as a bar under the thumb (the stylesheet decides which). One list
// (tabs.ts navItems) feeds both and the header's account menu, from the same shared reads, so they never disagree. An
// address only viewed heads the rail with that it is viewed read only, and Stop viewing.

import type { CSSProperties } from 'react';
import Action from '@/components/ui/Action';
import EntityLink from '@/components/ui/EntityLink';
import { LiveDot, Ring } from '@/components/ui/Status';
import { useAccountReads } from '@/hooks/useAccountReads';
import { accountRows, nodeLines, type AccountReads } from '@/lib/account-menu';
import { journey, navItems, type Tab } from '@/lib/cabinet/tabs';
import { ARABIC_VALUE_EM, textLength } from '@/lib/geometry';
import { useCabinet } from './CabinetProvider';
import { Link, useI18n } from '@/i18n/client';

function Identity({ reads }: { reads: AccountReads }) {
  const { t, rich } = useI18n();
  const { choice, viewOnly, nodeId, superId, stopViewing } = useCabinet();
  const wallet = choice?.qnet ?? null;
  const lines = nodeLines(reads, t);
  if (viewOnly && wallet) {
    return (
      <div className="cab-id">
        <p className="cab-id-line" role="status">{rich('view_line', { wallet: <EntityLink kind="address" value={wallet} /> })}</p>
        <Action kind="quiet" onClick={stopViewing}>{t('view_stop')}</Action>
      </div>
    );
  }
  const none = reads.network.phase === 'ok' && reads.network.value.state === 'none' && lines.length === 0;
  return (
    <div className="cab-id">
      {lines.map((line) => {
        const id = line.nodeType === 'light' ? nodeId : superId;
        return (
          <p key={line.nodeType} className="cab-id-line">
            <span className="cab-id-w">{line.mark === 'live' ? <LiveDot /> : <Ring />}{line.words}</span>
            {id && <EntityLink kind="node" value={id} address={wallet} />}
          </p>
        );
      })}
      {lines.length === 0 && (
        <p className="cab-id-line">
          <span className="cab-id-w">{none ? <><Ring />{t('account_no_node')}</> : <span className="dash">—</span>}</span>
        </p>
      )}
    </div>
  );
}

// A section's datum, never cut: where it stands under the name (the narrow rail, the phone's bar) it is set smaller by
// its length to fit (styles/cabinet.css --d-len, .62 em a character); on the bar an amount leaves its unit out (--d-num).
function NavDatum({ datum, tone }: { datum: string | null; tone?: string | null }) {
  const amount = datum ? /^(.*\d) (QNC)$/.exec(datum) : null;
  const shown = amount ? amount[1] : datum;
  const fit = { '--d-len': datum ? textLength(datum, 0.62, ARABIC_VALUE_EM) : 1, '--d-num': shown ? textLength(shown, 0.62, ARABIC_VALUE_EM) : 1 } as CSSProperties;
  return (
    <span className="cab-nav-d" data-tone={tone ?? undefined} style={fit}>
      {datum === null ? <span className="dash">—</span> : amount ? <>{amount[1]}<span className="cab-nav-u"> {amount[2]}</span></> : datum}
    </span>
  );
}

// A section's name on the phone's bar: its longest word, which never breaks, sets it smaller where four sections share
// a narrow line (styles/cabinet.css --n-len, .58 em a character).
const nameFit = (label: string) => ({ '--n-len': Math.max(...label.split(' ').map((word) => textLength(word, 0.58))) }) as CSSProperties;

export default function CabinetNav({ tab, openActivation }: { tab: Tab; openActivation: boolean }) {
  const { t } = useI18n();
  const { choice, viewOnly, view } = useCabinet();
  const reads = useAccountReads(choice?.qnet ?? null, viewOnly);
  const items = navItems(view.state, openActivation, tab, viewOnly, accountRows(reads, t), journey(true, view).current, t);
  return (
    <aside className="cab-side">
      <Identity reads={reads} />
      <nav className="cab-nav" aria-label={t('nav_label')}>
        {items.map((item) => (
          <Link key={item.tab} href={item.href} className="cab-nav-a" aria-current={item.tab === tab ? 'page' : undefined}>
            <span className="cab-nav-n" style={nameFit(item.label)}>{item.label}</span>
            <NavDatum datum={item.datum} tone={item.tone} />
          </Link>
        ))}
      </nav>
    </aside>
  );
}
