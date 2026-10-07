'use client';

// /docs/how-it-works, How it works (owner, 29.09: in the header's Docs menu, no longer a tab of My node; /node/guide
// leads here): the ways to a running node (R5): a light node from a phone or from a computer, and a super node, every
// step with its picture, then the questions people ask. Readable without a wallet. The way shown follows the device (a
// phone: Phone only) until the visitor picks one; ?way= keeps the pick (phone, computer or super). The page renders per
// request with the server's CABINET_PHONE_FLOWS (src/server/phone-flows.ts).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { t, type MessageKey } from '@/lib/texts';
import { computerGuide, phoneGuide, superGuide, type GuideStep } from '@/lib/cabinet/guide';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';
import { useHeldWallet } from './CabinetProvider';
import GuideArt from './GuideArt';

type Way = 'phone' | 'computer' | 'super';
const WAYS: Way[] = ['phone', 'computer', 'super'];
const WAY_LABEL: Record<Way, MessageKey> = { phone: 'guide_path_phone', computer: 'guide_path_computer', super: 'guide_path_super' };
const WAY_INTRO: Record<Way, MessageKey> = { phone: 'guide_phone_intro', computer: 'guide_computer_intro', super: 'guide_super_intro' };

const FAQ: [MessageKey, MessageKey][] = [
  ['faq_one_q', 'faq_one_a'],
  ['faq_move_q', 'faq_move_a'],
  ['faq_code_q', 'faq_code_a'],
  ['faq_back_q', 'faq_back_a'],
  ['faq_words_q', 'faq_words_a'],
];

function Steps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="guide-steps">
      {steps.map((step, i) => (
        <li key={step.id} className="guide-step">
          <div className="guide-step-text">
            <span className="guide-number" aria-hidden="true">{i + 1}</span>
            <div className="guide-step-words">
              <p>{t(step.text)}</p>
              {step.also && <p className="activate-note">{t(step.also)}</p>}
              {step.link && <Link href={step.link.href} className="guide-step-link">{t(step.link.label)}</Link>}
            </div>
          </div>
          <GuideArt scene={step.scene} />
        </li>
      ))}
    </ol>
  );
}

function Guide({ phoneFlows }: { phoneFlows: boolean }) {
  // The wallet My node shows, if any: without one the page ends with the way to connect it.
  const held = useHeldWallet();
  const device = useDeviceKind();
  const [picked, setPicked] = useState<Way | null>(null);
  useEffect(() => {
    const way = new URLSearchParams(window.location.search).get('way');
    if (way === 'phone' || way === 'computer' || way === 'super') setPicked(way);
  }, []);
  if (!device) return null;
  const way: Way = picked ?? (device.phone ? 'phone' : 'computer');
  const pick = (next: Way) => {
    setPicked(next);
    window.history.replaceState(null, '', `?way=${next}`);
  };
  const options = { network: ACTIVATION_NETWORK, phoneFlows };
  const steps = way === 'phone' ? phoneGuide(options) : way === 'super' ? superGuide(options) : computerGuide(options);
  return (
    <>
      <div className="activate-card guide-head">
        <p className="cabinet-lead">{t('guide_lead')}</p>
        <div className="guide-switch" role="group" aria-label={t('guide_path_label')}>
          {WAYS.map((option) => (
            <button key={option} type="button" className="guide-switch-option" aria-pressed={way === option} onClick={() => pick(option)}>
              {t(WAY_LABEL[option])}
            </button>
          ))}
        </div>
        <p className="activate-note">{t(WAY_INTRO[way])}</p>
      </div>
      {steps ? (
        <Steps steps={steps} />
      ) : (
        <div className="activate-card">
          <p>{t('guide_phone_closed')}</p>
          <button type="button" className="qnet-button activate-primary" onClick={() => pick('computer')}>{t('guide_show_computer')}</button>
        </div>
      )}
      <section className="activate-card guide-faq" aria-labelledby="guide-faq-title">
        <h3 className="activate-step" id="guide-faq-title">{t('faq_title')}</h3>
        <dl className="guide-faq-list">
          {FAQ.map(([question, answer]) => (
            <div key={question} className="guide-faq-item">
              <dt>{t(question)}</dt>
              <dd>{t(answer)}</dd>
            </div>
          ))}
        </dl>
      </section>
      {!held && (
        <div className="guide-connect">
          <Link href="/node" className="qnet-button activate-primary">{t('connect_first_button')}</Link>
        </div>
      )}
    </>
  );
}

export default function NodeGuide({ phoneFlows }: { phoneFlows: boolean }) {
  return (
    <div className="page-activate">
      <section className="explorer-section activate-page cabinet" data-section="guide">
        <div className="explorer-header">
          <h2 className="section-title">{t('guide_title')}</h2>
          <p className="section-subtitle">{t('eligibility')}</p>
        </div>
        <Guide phoneFlows={phoneFlows} />
      </section>
    </div>
  );
}
