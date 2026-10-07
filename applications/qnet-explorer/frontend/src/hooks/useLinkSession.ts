'use client';

// One QNet Link session at a time for a cabinet page: create it with its request, poll every 2 s (and at once
// when the page is shown again), stop on the answer, on expiry or when the page leaves. The link stays in this
// hook's memory. With a `slot`, a session whose key is a non-extractable WebCrypto key is also kept in this
// browser until it ends (src/lib/link-store.ts), so the page reads the answer after the phone browser discarded
// the tab while QNet Wallet was in front. A session belongs to the slot it was started for: when the page's slot
// changes (the activation page follows another activation), the hook lets go of it, keeps it for its slot, and
// follows the new slot's session instead (SITE-R3-02).

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVAL_MS, type ConsentVerifier, type LinkAnswer, type LinkIntent, type LinkRequest, type ReservationVerifier } from '@/lib/qnet-link';
import { closeSiteSession, type SiteSession } from '@/lib/qnet-link-crypto';
import { pollAnswer, readAnswer, releaseLinkSession, startLinkSession, type StartFailure } from '@/lib/link-client';
import { clearSession, loadSession, saveSession } from '@/lib/link-store';

export type LinkFailure = StartFailure | 'expired' | 'unreadable' | 'insecure';

interface RequestShape {
  intent: LinkIntent;
  request: LinkRequest | null;
}

export type LinkState =
  | { phase: 'idle' }
  | ({ phase: 'starting' } & RequestShape)
  | ({ phase: 'waiting'; link: string; expiresAt: number } & RequestShape)
  | ({ phase: 'done'; answer: LinkAnswer; checkNumber: number } & RequestShape)
  | ({ phase: 'failed'; failure: LinkFailure; retryAfterS?: number } & RequestShape);

export interface LinkSessionOptions {
  // Where this page keeps its unfinished session in the browser; none keeps it in memory only.
  slot?: string;
  // Two genesis nodes advertise consent_24h (the consent window of a `link` answer).
  consent24h?: boolean;
  // ML-DSA-65 verification of a `link` answer's consent.
  verify?: ConsentVerifier;
  // The check of a `reserve` answer's signed reservation.
  verifyReservation?: ReservationVerifier;
}

interface Run {
  session: SiteSession;
  // Where the session is kept in the browser, if anywhere.
  slot: string | undefined;
  expiresAt: number;
  timer: number | undefined;
  polling: boolean;
  stopped: boolean;
}

const shapeOf = (s: SiteSession): RequestShape => ({ intent: s.intent, request: s.request });

export function useLinkSession(options: LinkSessionOptions = {}) {
  const [state, setState] = useState<LinkState>({ phase: 'idle' });
  const run = useRef<Run | null>(null);
  // The latest start() call; an older one that returns late closes its session and changes nothing.
  const attempt = useRef(0);
  const opts = useRef(options);
  opts.current = options;

  // The hook stops following the session; a kept one stays in the browser for its slot (the page leaves, or follows
  // another slot).
  const detach = useCallback((): Run | null => {
    const r = run.current;
    run.current = null;
    if (!r) return null;
    r.stopped = true;
    window.clearTimeout(r.timer);
    closeSiteSession(r.session);
    return r;
  }, []);

  // The session ended. `release`: the page gives the session up before its end (cancelled, or replaced by a new
  // request), so the relay drops it at once instead of holding it against this address until its TTL (SITE-8).
  const stop = useCallback((release = false) => {
    const r = detach();
    if (!r) return;
    if (release) void releaseLinkSession(r.session.id);
    if (r.slot) void clearSession(r.slot);
  }, [detach]);

  const tick = useCallback(async (r: Run) => {
    if (r.stopped || r.polling) return;
    window.clearTimeout(r.timer);
    const shape = shapeOf(r.session);
    const finish = (next: LinkState) => {
      if (run.current === r) stop();
      setState(next);
    };
    if (Date.now() >= r.expiresAt) {
      finish({ phase: 'failed', failure: 'expired', ...shape });
      return;
    }
    // Set until the answer is read too, so a visibility tick in between cannot poll it twice.
    r.polling = true;
    const result = await pollAnswer(r.session);
    if (r.stopped) return;
    if (result.kind !== 'answered') r.polling = false;
    const again = (ms: number) => {
      r.timer = window.setTimeout(() => void tick(r), Math.max(0, Math.min(ms, r.expiresAt - Date.now())));
    };
    switch (result.kind) {
      case 'waiting':
        again(POLL_INTERVAL_MS);
        return;
      case 'retry':
        again(result.afterMs);
        return;
      case 'expired':
        finish({ phase: 'failed', failure: 'expired', ...shape });
        return;
      case 'unreadable':
        finish({ phase: 'failed', failure: 'unreadable', ...shape });
        return;
      case 'answered': {
        const { consent24h = false, verify, verifyReservation } = opts.current;
        const read = await readAnswer(r.session, result.body, { nowS: Math.floor(Date.now() / 1000), consent24h, verify, verifyReservation });
        if (r.stopped) return;
        finish(read.ok
          ? { phase: 'done', answer: read.answer, checkNumber: read.checkNumber, ...shape }
          : { phase: 'failed', failure: 'unreadable', ...shape });
      }
    }
  }, [stop]);

  const follow = useCallback((session: SiteSession, expiresAt: number, slot: string | undefined, delayMs: number) => {
    const r: Run = { session, slot, expiresAt, timer: undefined, polling: false, stopped: false };
    run.current = r;
    setState({ phase: 'waiting', link: session.link, expiresAt, ...shapeOf(session) });
    r.timer = window.setTimeout(() => void tick(r), delayMs);
  }, [tick]);

  const start = useCallback(async (intent: LinkIntent, request: LinkRequest | null = null) => {
    stop(true);
    const mine = ++attempt.current;
    // The slot of the page that asked, kept with the session even if the page follows another slot meanwhile.
    const { slot } = opts.current;
    const shape: RequestShape = { intent, request };
    if (!window.isSecureContext || !globalThis.crypto?.subtle) {
      setState({ phase: 'failed', failure: 'insecure', ...shape });
      return;
    }
    setState({ phase: 'starting', ...shape });
    const started = await startLinkSession(intent, request);
    if (mine !== attempt.current) {
      if (started.ok) closeSiteSession(started.session);
      return;
    }
    if (!started.ok) {
      setState({ phase: 'failed', failure: started.failure, retryAfterS: started.retryAfterS, ...shape });
      return;
    }
    if (slot) await saveSession(slot, started.session, started.expiresAt);
    if (mine !== attempt.current) {
      closeSiteSession(started.session);
      return;
    }
    follow(started.session, started.expiresAt, slot, POLL_INTERVAL_MS);
  }, [stop, follow]);

  const cancel = useCallback(() => {
    attempt.current += 1;
    stop(true);
    setState({ phase: 'idle' });
  }, [stop]);

  // A session this page kept in the browser: follow it again, and ask at once. When the slot changes, the session of
  // the old one is let go of (still kept for it) before the new one is read.
  const keptSlot = options.slot;
  useEffect(() => {
    if (!keptSlot) return;
    const mine = ++attempt.current;
    void loadSession(keptSlot, Date.now()).then((kept) => {
      if (!kept) return;
      if (mine !== attempt.current || run.current) {
        closeSiteSession(kept.session);
        return;
      }
      follow(kept.session, kept.expiresAt, keptSlot, 0);
    });
    return () => {
      attempt.current += 1;
      detach();
      setState({ phase: 'idle' });
    };
  }, [keptSlot, follow, detach]);

  // Back on the page (the phone returns from the app): ask at once instead of waiting for the timer.
  useEffect(() => {
    if (state.phase !== 'waiting') return;
    const onVisible = () => {
      const r = run.current;
      if (document.visibilityState === 'visible' && r) void tick(r);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [state, tick]);

  useEffect(() => () => {
    attempt.current += 1;
    // Leaving the page is not an end: a kept session stays for the next visit until it expires.
    detach();
  }, [detach]);

  return { state, start, cancel };
}
