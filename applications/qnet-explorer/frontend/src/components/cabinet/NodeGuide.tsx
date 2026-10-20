'use client';

// /docs/how-it-works, How it works (owner, 29.09: in the header's Docs menu, no longer a tab of My node; /node/guide
// leads here): the ways to a running node (R5): a light node from a phone or from a computer, and a super node, every
// step with its picture, then the questions people ask. Readable without a wallet. The way shown follows the device that
// asked (the page reads it from the request: a phone or tablet gets Phone only) until the visitor picks one; ?way= keeps
// the pick (phone, computer or super). Both are known on the server, so the steps never swap after load. The page
// renders per request with the server's CABINET_PHONE_FLOWS (src/server/phone-flows.ts).

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import ViewTabs from '@/components/ui/ViewTabs';
import { t, type MessageKey } from '@/lib/texts';
import { computerGuide, phoneGuide, superGuide, type GuideStep } from '@/lib/cabinet/guide';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';
import { endView, useHeldWallet } from './CabinetProvider';
import GuideArt from './GuideArt';

type Way = 'phone' | 'computer' | 'super';
const WAYS: Way[] = ['phone', 'computer', 'super'];
const WAY_LABEL: Record<Way, MessageKey> = { phone: 'guide_path_phone', computer: 'guide_path_computer', super: 'guide_path_super' };
const WAY_INTRO: Record<Way, MessageKey> = { phone: 'guide_phone_intro', computer: 'guide_computer_intro', super: 'guide_super_intro' };
const asWay = (value: string | null): Way | null => (WAYS as (string | null)[]).includes(value) ? value as Way : null;

const FAQ: [MessageKey, MessageKey][] = [
  ['faq_one_q', 'faq_one_a'],
  ['faq_move_q', 'faq_move_a'],
  ['faq_stop_q', 'faq_stop_a'],
  ['faq_code_q', 'faq_code_a'],
  ['faq_back_q', 'faq_back_a'],
  ['faq_server_q', 'faq_server_a'],
  ['faq_words_q', 'faq_words_a'],
];

function Steps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="cab-steps guide-list">
      {steps.map((step, i) => (
        <li key={step.id} className="cab-step">
          <span className="cab-step-n" aria-hidden="true">{i + 1}</span>
          <div className="cab-step-body">
            <p>{t(step.text)}</p>
            {step.also && <p className="note">{t(step.also)}</p>}
            {step.link && <Link href={step.link.href} className="guide-step-link">{t(step.link.label)}</Link>}
          </div>
          <GuideArt scene={step.scene} />
        </li>
      ))}
    </ol>
  );
}

function Guide({ phoneFlows, phone }: { phoneFlows: boolean; phone: boolean }) {
  // The wallet My node shows, if any: without one the page ends with the way to connect it (an address only viewed is
  // none, and the way ends the view, so the connect screen shows).
  const held = useHeldWallet();
  const search = useSearchParams();
  const [picked, setPicked] = useState<Way | null>(() => asWay(search.get('way')));
  const way: Way = picked ?? (phone ? 'phone' : 'computer');
  const pick = (next: Way) => {
    setPicked(next);
    window.history.replaceState(null, '', `?way=${next}`);
  };
  const options = { network: ACTIVATION_NETWORK, phoneFlows };
  const steps = way === 'phone' ? phoneGuide(options) : way === 'super' ? superGuide(options) : computerGuide(options);
  return (
    <>
      <ViewTabs items={WAYS.map((option) => ({ key: option, label: t(WAY_LABEL[option]) }))} value={way} onChange={pick} label={t('guide_path_label')}>
        <p className="lead guide-way">{t(WAY_INTRO[way])}</p>
        {steps ? (
          <Steps steps={steps} />
        ) : (
          <div className="pg-act">
            <p className="body">{t('guide_phone_closed')}</p>
            <Action onClick={() => pick('computer')}>{t('guide_show_computer')}</Action>
          </div>
        )}
      </ViewTabs>
      <section className="doc-sec guide-faq" aria-labelledby="guide-faq-title">
        <h2 id="guide-faq-title">{t('faq_title')}</h2>
        <dl className="faq">
          {FAQ.map(([question, answer]) => (
            <div key={question}>
              <dt>{t(question)}</dt>
              <dd>{t(answer)}</dd>
            </div>
          ))}
        </dl>
      </section>
      {!held && (
        <div className="pg-act">
          <Action kind="solid" href="/node" onClick={endView}>{t('connect_first_button')}</Action>
        </div>
      )}
    </>
  );
}

export default function NodeGuide({ phoneFlows, phone }: { phoneFlows: boolean; phone: boolean }) {
  return (
    <div className="pg">
      <PageHead title={t('guide_title')} lead={t('guide_lead')} />
      <div className="wrap pg-body">
        <Guide phoneFlows={phoneFlows} phone={phone} />
      </div>
    </div>
  );
}
