'use client';

// "I'm back" (src/lib/cabinet/wake.ts): the site's wake route asks the owners of the node's light shard, in rank order,
// to send the node's linked device one silent push; the page then shows that it waits for the answer and has the
// node's status read again every 10 s for two minutes (the page's one shared read, the card above included), until it
// says the device answered this epoch: the card then shows Online. One place only: inside the Overview's status card,
// under the device rows (NodeHome.tsx; owner, 04.10), with no card or heading of its own. Shown only while the device
// is Offline and silent this epoch (canWake): once the status read again says it answered, or is Online, it goes,
// whatever it said before; only a wake still asking or watching stays until it ends.

import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/texts';
import type { NodeStatusView } from '@/lib/cabinet/node-view';
import { WAKE_POLL_MS, WAKE_WATCH_MS, canWake, parseWakeView, wakeText } from '@/lib/cabinet/wake';

const REQUEST: RequestInit = { cache: 'no-store', credentials: 'omit', redirect: 'error' };

type Phase =
  | { phase: 'idle' }
  | { phase: 'asking' }
  | { phase: 'watching'; until: number }
  | { phase: 'done'; text: string; answered: boolean };

// The push went out, or the words for why not.
type Asked = { sent: true } | { sent: false; text: string; answered: boolean };

async function askWake(nodeId: string): Promise<Asked> {
  try {
    const res = await fetch('/api/cabinet/wake', {
      ...REQUEST,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    });
    if (res.status === 429) return { sent: false, text: t('wake_cooldown'), answered: false };
    if (res.status !== 200) return { sent: false, text: t('unreachable'), answered: false };
    const answer = parseWakeView(await res.json());
    if (!answer) return { sent: false, text: t('unreachable'), answered: false };
    return answer.result === 'sent' ? { sent: true } : { sent: false, text: wakeText(answer), answered: answer.result === 'already_answered' };
  } catch {
    return { sent: false, text: t('unreachable'), answered: false };
  }
}

export default function WakePanel({ nodeId, status, refresh }: { nodeId: string; status: NodeStatusView; refresh: () => void }) {
  const [state, setState] = useState<Phase>({ phase: 'idle' });
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // While watching: the shared status read again every WAKE_POLL_MS, and the watch's end.
  useEffect(() => {
    if (state.phase !== 'watching') return;
    const timer = window.setInterval(() => refreshRef.current(), WAKE_POLL_MS);
    const end = window.setTimeout(() => setState({ phase: 'done', text: t('wake_no_answer'), answered: false }), Math.max(0, state.until - Date.now()));
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(end);
    };
  }, [state]);

  // The status read again says the device answered: the watch is over, and the card shows it.
  const answered = status.answeredThisEpoch;
  useEffect(() => {
    if (answered && state.phase === 'watching') setState({ phase: 'done', text: t('wake_answered'), answered: true });
  }, [answered, state.phase]);

  const offered = canWake(status);
  if (!offered && (state.phase === 'idle' || state.phase === 'done')) return null;

  const ask = async () => {
    setState({ phase: 'asking' });
    const outcome = await askWake(nodeId);
    setState(outcome.sent
      ? { phase: 'watching', until: Date.now() + WAKE_WATCH_MS }
      : { phase: 'done', text: outcome.text, answered: outcome.answered });
  };

  const idle = state.phase === 'idle' || (state.phase === 'done' && !state.answered);
  return (
    <div className="cabinet-choice">
      <p className="activate-note">{t('wake_lead')}</p>
      {offered && idle && (
        <button type="button" className="qnet-button activate-primary" onClick={() => void ask()}>{t('wake_button')}</button>
      )}
      {state.phase === 'asking' && <p className="activate-status" aria-live="polite">{t('checking')}</p>}
      {state.phase === 'watching' && <p className="activate-status" aria-live="polite">{t('wake_waiting')}</p>}
      {state.phase === 'done' && (
        <p className={state.answered ? 'activate-result' : 'activate-note'} role="status">{state.text}</p>
      )}
    </div>
  );
}
