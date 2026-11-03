'use client';

// The home page: the hero with the decoding headline over the field and the live blocks,
// the readouts, Get QNet Wallet, the security model, the mobile-first statement, the economic model and the open
// source section. Every live value sits in a box whose size does not depend on it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Field, { type FieldApi } from '@/components/field/Field';
import Ago from '@/components/explorer/Ago';
import { EpochReadout, NodeCountReadouts } from '@/components/explorer/ChainReadouts';
import { useLiveBlocks } from '@/components/explorer/useRecentBlocks';
import GetTheApp from '@/components/GetTheApp';
import Action from '@/components/ui/Action';
import EntityLink from '@/components/ui/EntityLink';
import LanguageList from '@/components/ui/LanguageList';
import { Readout, Readouts } from '@/components/ui/Readouts';
import Section from '@/components/ui/Section';
import { HoldLabel } from '@/components/ui/Status';
import { useActivationContent } from '@/contexts/AppContext';
import { useChainHead } from '@/hooks/useChainHead';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import { useNodeCounts, type NodeCounts } from '@/hooks/useNodeCounts';
import { useI18n } from '@/i18n/client';
import { ANDROID_PLAY_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL } from '@/lib/app-links';
import { RECENT_BLOCKS, ageForms, txCountText, type RecentBlock } from '@/lib/explorer-view';
import { GLYPHS, zonesFrom, type DimZone } from '@/lib/field/rain';
import { int } from '@/lib/format';
import { wordsLength } from '@/lib/geometry';
import type { MessageKey } from '@/lib/texts';
import { formatQncTruncated } from '@/lib/token-format';

interface HomeStats {
  height: number;
  emissionNano: string;
}

const NAME = 'QNet Blockchain';
const NAME_LINES = NAME.split(' ');

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

// The live column: the explorer's recent blocks (useLiveBlocks), each height a link to its block with its transaction
// count, under them the node that made it (a link to its address when known) and its age. A new head slides in
// at the top (a transform) and its height flashes Ember; a burst goes in without the slide. Pointer, focus or a touch
// holds new rows and the label says how many wait; out of view the column does no DOM work and shows its latest rows at
// once on return.
function LiveBlocks({ seed, active }: { seed: readonly RecentBlock[]; active: boolean }) {
  const { t } = useI18n();
  const box = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const { shown, hold, near, landed } = useLiveBlocks(seed, RECENT_BLOCKS, box, list);
  // The age holds the language's longest age in the row's characters, so the producer beside it stays put as "9 s ago"
  // becomes "10 s ago".
  const ageBox = useMemo(() => ({ minWidth: `${Math.ceil(wordsLength(ageForms(t)))}ch` }), [t]);

  return (
    <aside ref={box} className="stream" aria-label={t('ex_latest_blocks')} data-field-dim="0.08" {...hold.handlers}>
      <p className="label stream-head">
        <HoldLabel hold={hold} idle={t('home_live_blocks')} />
      </p>
      <div className="stream-view">
        {/* Each row keeps its place and takes the next block (its content keyed by height, so a block's flash plays as
            it lands): only the list's transform moves, as in the explorer's strip. */}
        <ol ref={list} className="stream-list">
          {shown.map((b, i) => (
            <li key={i} className="blk">
              <div key={b.height} className="blk-in" data-new={landed.has(String(b.height)) || undefined}>
                <span className="blk-h">
                  <span className="flash" data-v={int(b.height)}><EntityLink kind="block" value={b.height} /></span>
                  <span className="blk-txs">{txCountText(b.txCount, t)}</span>
                </span>
                <span className="blk-age" style={ageBox}>{b.timestamp ? <Ago ts={b.timestamp} on={near && active} /> : '—'}</span>
                <span className="blk-by">
                  {b.producer ? <EntityLink kind="node" value={b.producer} address={b.producerAddress} /> : <span>—</span>}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

// A letter cycles a few glyphs, then locks into the display face with a flash.
function lock(span: HTMLElement, done: () => void) {
  if (span.dataset.locked) return;
  span.dataset.locked = '1';
  span.classList.add('scr');
  let n = 0;
  const cycle = () => {
    if (n++ < 4) {
      span.dataset.g = glyph();
      window.setTimeout(cycle, 50);
      return;
    }
    span.classList.remove('scr');
    span.classList.add('lock');
    done();
  };
  cycle();
}

function rel(el: Element | null, c: DOMRect) {
  const r = el?.getBoundingClientRect();
  return r ? { l: r.left - c.left, r: r.right - c.left, t: r.top - c.top, b: r.bottom - c.top } : null;
}

// The hero: the rain pours over the headline and spells it, then settles: densest in the gap beside the
// copy, flowing into the live column, faint over every line of text. Under reduced motion or without JS the headline is
// plain text and the rain one still frame.
function Hero({ stats, nodes, blocks }: { stats: HomeStats | null; nodes: NodeCounts | null; blocks: readonly RecentBlock[] }) {
  const { t, say } = useI18n();
  const shown = useActivationContent();
  const hero = useRef<HTMLElement>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const api = useRef<FieldApi | null>(null);
  const [fieldReady, setFieldReady] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const started = useRef(false);

  // Letters wait transparent for the decode (before the page shows, so nothing is seen twice).
  useEffect(() => {
    if (!reducedMotion()) setDecoding(true);
  }, []);

  // A browser without a 2D canvas never starts the decode: the headline shows plain once the page does.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => {
      if (!started.current) setDecoding(false);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [shown]);

  const onField = useCallback((field: FieldApi) => {
    api.current = field;
    setFieldReady(true);
  }, []);

  // The text zones the rain keeps faint over, in the canvas's coordinates; the decode keeps the headline clear.
  const textZones = useCallback((during: boolean): DimZone[] => {
    const field = api.current;
    const root = hero.current;
    if (!field || !root) return [];
    // Every marked element over the canvas: the hero's text, the header's band and controls.
    const marked = [...document.querySelectorAll('[data-field-dim], [data-field-clear]')].filter((el) => !during || el !== h1.current);
    const zones = zonesFrom(field.canvas.getBoundingClientRect(), window.scrollY, marked, field.rain.cell / 2);
    return during ? zones.map((z) => ({ ...z, dim: z.dim === 0 ? 0 : Math.max(0.2, z.dim) })) : zones;
  }, []);

  const settle = useCallback(() => {
    const field = api.current;
    const root = hero.current;
    if (!field || !root) return;
    const c = field.canvas.getBoundingClientRect();
    const head = rel(h1.current, c);
    const list = rel(root.querySelector('.stream-view'), c);
    const copyBox = rel(copy.current, c);
    const beside = !!(list && copyBox && list.l > copyBox.r);
    if (beside && head && list) {
      const copyRight = Math.max(head.r, copyBox?.r ?? 0) + 24;
      field.settle(0.75, (x) => (x < copyRight ? 0.8 : x < list.l - 12 ? 1.5 : x < list.r + 12 ? 1.2 : 1), textZones(false));
    } else {
      field.settle(0.95, null, textZones(false));
    }
  }, [textZones]);

  useEffect(() => {
    if (!fieldReady || !shown || started.current) return;
    started.current = true;
    const field = api.current;
    const heading = h1.current;
    if (!field || !heading) return;
    let failsafe = 0;
    let finish = 0;
    const end = () => {
      settle();
      setDecoding(false);
    };
    if (reducedMotion()) {
      void (document.fonts ? document.fonts.ready : Promise.resolve()).then(end);
      return;
    }
    const go = () => {
      field.settle(0.85, null, textZones(true));
      const letters = [...heading.querySelectorAll<HTMLElement>('.ch')];
      const c = field.canvas.getBoundingClientRect();
      let left = letters.length;
      const done = () => {
        left -= 1;
        if (left === 0) finish = window.setTimeout(end, 250);
      };
      letters.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        const row = Math.floor((r.top - c.top + r.height * 0.2) / field.rain.cell);
        field.rain.decoder(r.left - c.left + r.width / 2 - field.rain.cell / 2, row, 260 + i * 80 + Math.random() * 160, () => lock(s, done));
      });
      // The headline resolves even if the frame loop never runs (a hidden tab, the hero off screen).
      failsafe = window.setTimeout(() => letters.forEach((s) => lock(s, done)), 2800);
    };
    void (document.fonts ? document.fonts.ready : Promise.resolve()).then(go);
    return () => {
      window.clearTimeout(failsafe);
      window.clearTimeout(finish);
    };
  }, [fieldReady, shown, settle, textZones]);

  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!decoding) settle();
      }, 200);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [decoding, settle]);

  const height = stats?.height ?? 0;

  return (
    <section ref={hero} className="hero" data-decoding={decoding || undefined} aria-labelledby="hero-title">
      <Field strength={0.85} kind="home" weighting="none" onReady={onField} />
      <div className="wrap hero-grid">
        <div className="hero-copy" ref={copy}>
          <h1 id="hero-title" ref={h1} className="display" aria-label={NAME} data-field-dim="0.5" translate="no">
            {NAME_LINES.map((line) => (
              <span key={line} className="line" aria-hidden="true">
                {[...line].map((ch, i) => <span key={i} className="ch" data-g="0">{ch}</span>)}
              </span>
            ))}
          </h1>
          <p className="deck" data-field-dim="0.1">{t('home_deck')}</p>
          <p className="body hero-p" data-field-dim="0.1">{t('home_hero_p')}</p>
          <div className="actions hero-acts" data-field-dim="0.1">
            <Action kind="solid" href="#get">{say('get_title')}</Action>
            <Action kind="text" href="/explorer">{t('home_open_explorer')}</Action>
          </div>
        </div>
        <LiveBlocks seed={blocks} active={!decoding} />
      </div>
      <div className="wrap hero-ro" data-field-dim="0.1">
        <Readouts cols={5} label={t('ro_now')}>
          <NodeCountReadouts nodes={nodes} />
          <EpochReadout height={height} />
          <Readout label={t('ro_supply')} value={stats ? formatQncTruncated(stats.emissionNano, 2) : null} amount={{}} href="/explorer/qnc" sub={t('ro_supply_sub')} />
          <Readout label={t('home_tps')} value="13,000" sub={t('home_tps_sub')} wide />
        </Readouts>
      </div>
    </section>
  );
}

// A feature's datum decodes again on hover, left to right over about half a second.
function scramble(el: HTMLElement | null) {
  if (!el || el.dataset.scr || reducedMotion()) return;
  const final = el.textContent ?? '';
  const start = performance.now();
  el.dataset.scr = '1';
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / 480);
    let out = '';
    for (let i = 0; i < final.length; i++) out += final[i] === ' ' || i < p * final.length ? final[i] : glyph();
    el.textContent = out;
    if (p < 1) requestAnimationFrame(step);
    else {
      el.textContent = final;
      delete el.dataset.scr;
    }
  };
  requestAnimationFrame(step);
}

function Feature({ datum, title, children, code = false }: { datum: string; title: string; children: ReactNode; code?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  return (
    <article className="feat rv" onMouseEnter={() => scramble(ref.current)}>
      <p className="feat-k" ref={ref} translate={code ? 'no' : undefined}>{datum}</p>
      <div className="feat-t">
        <h3 className="h3">{title}</h3>
        <p className="body">{children}</p>
      </div>
    </article>
  );
}

// One four-hour epoch of a light node: three status requests and one attestation, a marker walking the axis.
function EpochDiagram() {
  const { t, say } = useI18n();
  return (
    // Time runs left to right in every language: the marks are placed along it.
    <figure className="epoch rv" dir="ltr" aria-label={t('home_epoch_label')}>
      <p className="label" dir="auto">{t('home_epoch_title')}</p>
      <div className="ep-track" aria-hidden="true">
        <span className="ep-tick" style={{ left: '13%', ['--p' as string]: '.13' }} />
        <span className="ep-tick" style={{ left: '42%', ['--p' as string]: '.42' }} />
        <span className="ep-att" style={{ left: '59%' }} />
        <span className="ep-tick" style={{ left: '81%', ['--p' as string]: '.81' }} />
        <span className="ep-runner"><span className="ep-run" /></span>
      </div>
      <div className="ep-scale" aria-hidden="true"><span>{t('home_hours', { h: 0 })}</span><span>{t('home_hours', { h: 2 })}</span><span>{t('home_hours', { h: 4 })}</span></div>
      <figcaption dir="auto">
        <span className="ep-key"><i className="k-tick" />{say('home_epoch_key_request')}</span>
        <span className="ep-key"><i className="k-att" />{t('home_epoch_key_attestation')}</span>
      </figcaption>
    </figure>
  );
}

const HALVING_OPS: [string, number, number, boolean][] = [
  ['÷2', 12.5, 13.16, false], ['÷2', 25, 21.93, false], ['÷2', 37.5, 30.7, false], ['÷2', 50, 39.47, false],
  ['÷10', 62.5, 58.42, true], ['÷2', 75, 77.37, false], ['÷2', 87.5, 86.14, false],
];
const HALVING_YEARS = [0, 4, 8, 12, 16, 20, 24, 28, 32];
// The node counts of each multiplier range (the words around them are the page's language), its bar and its factor.
const MULTIPLIERS: [MessageKey, string, string][] = [
  ['home_mult_1', '16.667%', '0.5×'],
  ['home_mult_2', '33.333%', '1.0×'],
  ['home_mult_3', '66.667%', '2.0×'],
  ['home_mult_4', '100%', '3.0×'],
];

function Economics() {
  const { t, say } = useI18n();
  return (
    <Section id="economics" title={t('home_eco_title')} lead={t('home_eco_lead')}>
      <div className="phases rv">
        <article className="phase">
          <p className="label"><span className="em">{t('home_phase_current')}</span> · {t('home_phase', { n: 1 })}</p>
          <h3 className="phase-t">{t('home_phase1_title')}</h3>
          <p className="body">{say('home_phase1_body')}</p>
        </article>
        <article className="phase">
          <p className="label">{t('home_phase_future')} · {t('home_phase', { n: 2 })}</p>
          <h3 className="phase-t">{t('home_phase2_title')}</h3>
          <p className="note phase-when">{t('home_phase2_when')}</p>
          <p className="body">{t('home_phase2_body')}</p>
        </article>
      </div>
      <div className="eco-charts">
        <figure className="halving rv">
          <h3 className="h3">{t('home_halving_title')}</h3>
          {/* Years run left to right in every language: the plot and its marks are placed along them. */}
          <div className="hv" role="img" dir="ltr" aria-label={t('home_halving_label')}>
            <p className="hv-unit" aria-hidden="true" dir="auto">{t('home_halving_unit')}</p>
            <div className="hv-plot" aria-hidden="true">
              <svg viewBox="0 0 580 228" preserveAspectRatio="none">
                <g className="hv-grid">
                  {[20, 60, 100, 140, 180].map((y) => <line key={y} x1="0" y1={y} x2="580" y2={y} vectorEffect="non-scaling-stroke" />)}
                </g>
                <line className="hv-axis" x1="0" y1="228" x2="580" y2="228" vectorEffect="non-scaling-stroke" />
                <path className="hv-area" d="M0 20H72.5V40H145V60H217.5V80H290V100H362.5V166.4H435V186.4H507.5V206.4H580V228H0Z" />
                <path className="hv-line" d="M0 20H72.5V40H145V60H217.5V80H290V100H362.5" vectorEffect="non-scaling-stroke" />
                <path className="hv-drop" d="M362.5 100V166.4" vectorEffect="non-scaling-stroke" />
                <path className="hv-line" d="M362.5 166.4H435V186.4H507.5V206.4H580" vectorEffect="non-scaling-stroke" />
              </svg>
              {HALVING_OPS.map(([op, x, y, drop]) => (
                <span key={`${x}`} className={`hv-op${drop ? ' em' : ''}`} style={{ left: `${x}%`, top: `${y}%` }}>{op}</span>
              ))}
            </div>
            <div className="hv-x" aria-hidden="true">
              {HALVING_YEARS.map((year) => <span key={year} style={{ left: `${(year / 32) * 100}%` }}>{year}</span>)}
            </div>
            <p className="hv-years" aria-hidden="true" dir="auto">{t('home_halving_years')}</p>
          </div>
          <figcaption className="body">{t('home_halving_caption')}</figcaption>
        </figure>
        <figure className="mult rv">
          <h3 className="h3">{t('home_mult_title')}</h3>
          <dl className="mb">
            {MULTIPLIERS.map(([range, width, factor]) => (
              <div key={range}>
                <dt>{say(range)}</dt>
                <dd><span className="track"><i style={{ width }} /></span><b translate="no">{factor}</b></dd>
              </div>
            ))}
          </dl>
          <figcaption className="body">{t('home_mult_caption')}</figcaption>
        </figure>
      </div>
      <div className="specs">
        <article className="spec rv">
          <h3 className="h3">{t('home_pools_title')}</h3>
          <div className="body">
            <ol className="pools">
              <li>{t('home_pools_1')}</li>
              <li>{t('home_pools_2')}</li>
            </ol>
            <p>{t('home_pools_fees')}</p>
          </div>
        </article>
      </div>
    </Section>
  );
}

// The server's head snapshot gives the first values: the head, the emission so far and the newest blocks, so the live
// column is full from the first paint; the head stream keeps them live.
export default function HomeClient({ initialStats, blocks }: { initialStats: HomeStats | null; blocks: readonly RecentBlock[] }) {
  const { t, say, rich } = useI18n();
  const head = useChainHead();
  const stats: HomeStats | null = head.height > 0 ? { height: head.height, emissionNano: head.emissionTotal } : initialStats;
  const nodes = useNodeCounts(head.height);

  // Sections fade up as they enter (home only); without JS everything is simply there.
  const root = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || !('IntersectionObserver' in window)) return;
    setReveal(true);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    el.querySelectorAll('.rv').forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, []);

  // A part of the page out of view runs no animation (the epoch diagram, VERIFY).
  const mobile = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const mobileNear = useIntersectionObserver(mobile, { rootMargin: '160px 0px' });
  const sourceNear = useIntersectionObserver(source, { rootMargin: '160px 0px' });

  return (
    <div className="home" ref={root} data-reveal={reveal || undefined}>
      <Hero stats={stats} nodes={nodes} blocks={blocks} />

      <GetTheApp />

      <Section id="security" title={t('home_security_title')}>
        <div className="feats">
          <Feature datum="ML-DSA-65" title={t('home_pq_title')} code>{t('home_pq_body')}</Feature>
          <Feature datum={t('home_rep_datum')} title={t('home_rep_title')}>{t('home_rep_body')}</Feature>
          <Feature datum={t('home_rate_datum')} title={t('home_rate_title')}>{t('home_rate_body')}</Feature>
        </div>
      </Section>

      <section id="mobile" className={`sec${mobileNear ? '' : ' off'}`} aria-labelledby="mobile-h">
        <div className="wrap mf" ref={mobile}>
          <div className="mf-head">
            <h2 id="mobile-h" className="h2 rv">{t('home_mobile_title')}</h2>
            <p className="lead rv">{t('home_mobile_lead')}</p>
            <EpochDiagram />
          </div>
          <div className="mf-list">
            <article className="mf-item rv">
              <h3 className="h3">{t('home_presence_title')}</h3>
              <p className="body">{say('home_presence_body')}</p>
            </article>
            <article className="mf-item rv">
              <h3 className="h3">{t('home_app_title')}</h3>
              <p className="body">
                {t('home_app_body')}{' '}
                {rich(IOS_APP_STORE_URL ? 'home_app_stores' : 'home_app_stores_testflight', {
                  play: <a href={ANDROID_PLAY_URL} target="_blank" rel="noopener noreferrer" translate="no">Google Play</a>,
                  appStore: <a href={IOS_APP_STORE_URL ?? IOS_INSTALL_URL} target="_blank" rel="noopener noreferrer" translate="no">App Store</a>,
                  testflight: <a href={IOS_INSTALL_URL} target="_blank" rel="noopener noreferrer" translate="no">TestFlight</a>,
                })}{' '}
                {t('home_app_languages')}
              </p>
              <LanguageList />
            </article>
            <article className="mf-item rv">
              <h3 className="h3">{t('home_hw_title')}</h3>
              <p className="body">{t('home_hw_body')}</p>
            </article>
            <article className="mf-item rv">
              <h3 className="h3">{t('home_split_title')}</h3>
              <p className="body">{say('home_split_body')}</p>
              <div className="split" role="img" aria-label={t('home_split_label')}>
                <div style={{ flex: 3 }}><i /><span className="split-v" translate="no">3/4</span><span className="split-n">{t('ro_light_nodes')}</span></div>
                <div style={{ flex: 1 }}><i /><span className="split-v" translate="no">1/4</span><span className="split-n">{t('home_super_nodes')}</span></div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <Economics />

      <section id="source" className={`sec verify${sourceNear ? '' : ' off'}`} aria-labelledby="source-h">
        <div className="wrap" ref={source}>
          {/* A static class: the reveal adds "in" by hand, and a class React recomputes would drop it. */}
          <p className="verify-word rv" data-text="VERIFY" aria-hidden="true" translate="no">VERIFY</p>
          <div className="verify-grid">
            <h2 id="source-h" className="h2 rv">{t('home_source_title')}</h2>
            <div className="verify-copy rv">
              <p className="lead">{t('home_source_lead')}</p>
              <p className="body vlic">{t('home_source_licenses')}</p>
              <ul className="vlinks">
                <li>
                  <a className="vlink" href="https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet" target="_blank" rel="noopener noreferrer">
                    <span className="vlink-t">{t('home_source_check')}</span>
                    <span className="vlink-u" translate="no" dir="ltr">github.com/AIQnetLab/QNet-Blockchain</span>
                  </a>
                </li>
                <li>
                  <a className="vlink" href="https://github.com/AIQnetLab/QNet-Blockchain/actions" target="_blank" rel="noopener noreferrer">
                    <span className="vlink-t">{t('home_source_verify')}</span>
                    <span className="vlink-u" translate="no" dir="ltr">github.com/AIQnetLab/QNet-Blockchain/actions</span>
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
