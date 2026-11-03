'use client';

// Terms of use for QNet Wallet and aiqnet.io. Plain statements of what the software is and is not:
// non-custodial, experimental, and run by a network the publisher does not control. The QNet app links it,
// so it states what activation is without pointing the reader to a page that performs it: the places that
// activate are named only outside the app's view. "Device rules" covers the device check of a light node
// (docs/protocols/light-node-messages.md sections 1, 5 and 8: no operating-system minimum, only the hardware's proof).

import DocToc from '@/components/DocToc';
import PageHead from '@/components/ui/PageHead';
import { useActivationContent } from '@/contexts/AppContext';
import { Link, useI18n } from '@/i18n/client';
import { dayUtc } from '@/lib/format';
import type { MessageKey } from '@/lib/texts';

// The date of this version of the terms.
const EFFECTIVE = Date.UTC(2026, 10, 2);

export default function TermsPage() {
  const { t, say, rich } = useI18n();
  const full = useActivationContent();
  return (
    <div className="pg">
      <PageHead title={t('support_legal_terms')} lead={say('privacy_lead')} />
      <div className="wrap pg-body doc-grid">
        <div className="doc-main">

          <section className="doc-sec prose" id="publisher">
            <h2>{t('terms_publisher_title')}</h2>
            <p>{say('terms_publisher_1')}</p>
          </section>

          <section className="doc-sec prose" id="software">
            <h2>{t('terms_software_title')}</h2>
            <ul>
              <li>{t('terms_software_1')}</li>
              <li>{say('terms_software_2')}</li>
              <li>{t('terms_software_3')}</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="recovery-phrase">
            <h2>{t('terms_recovery_phrase_title')}</h2>
            <p>{say('terms_recovery_phrase_1')}</p>
          </section>

          <section className="doc-sec prose" id="experimental">
            <h2>{say('terms_experimental_title')}</h2>
            <p>{say('terms_experimental_1')}</p>
          </section>

          <section className="doc-sec prose" id="activation">
            <h2>{t('terms_activation_title')}</h2>
            <p>
              {rich('terms_activation_1', { where: full ? rich('terms_activation_where', { page: <Link href="/node" translate="no">aiqnet.io/node</Link> }) : t('terms_activation_where_app') })}
            </p>
          </section>

          <section className="doc-sec prose" id="device-rules">
            <h2>{t('terms_device_rules_title')}</h2>
            <p>
              {rich('terms_device_rules_1', { support: <Link href="/support#device-check">{t('support_title')}</Link> })}
            </p>
          </section>

          <section className="doc-sec prose" id="responsibilities">
            <h2>{t('terms_responsibilities_title')}</h2>
            <ul>
              <li>{t('terms_responsibilities_1')}</li>
              <li>{t('terms_responsibilities_2')}</li>
              <li>{t('terms_responsibilities_3')}</li>
              <li>{say('terms_responsibilities_4')}</li>
              <li>{t('terms_responsibilities_5')}</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="no-advice">
            <h2>{t('terms_no_advice_title')}</h2>
            <p>{t('terms_no_advice_1')}</p>
          </section>

          <section className="doc-sec prose" id="third-party">
            <h2>{t('terms_third_party_title')}</h2>
            <p>{say('terms_third_party_1')}</p>
          </section>

          <section className="doc-sec prose" id="liability">
            <h2>{t('terms_liability_title')}</h2>
            <p>{say('terms_liability_1')}</p>
          </section>

          <section className="doc-sec prose" id="law">
            <h2>{t('terms_law_title')}</h2>
            <p>{t('terms_law_1')}</p>
          </section>

          <section className="doc-sec prose" id="changes">
            <h2>{t('terms_changes_title')}</h2>
            <p>
              {rich('terms_changes_1', { email: <a href="mailto:support@aiqnet.io" translate="no">support@aiqnet.io</a>, privacy: <Link href="/privacy">{t('support_legal_privacy')}</Link> })}
            </p>
          </section>

          <p className="doc-date">{t('legal_effective', { date: dayUtc(EFFECTIVE, t) })}</p>

        </div>
        <DocToc items={TOC.map(([id, title]) => [id, t(title)] as const)} />
      </div>
    </div>
  );
}

// The sections, in the order the page shows them (src/lib/__tests__/site-pages.test.mjs checks they match).
const TOC: readonly (readonly [string, MessageKey])[] = [
  ['publisher', 'terms_publisher_title'],
  ['software', 'terms_software_title'],
  ['recovery-phrase', 'terms_recovery_phrase_title'],
  ['experimental', 'terms_experimental_title'],
  ['activation', 'terms_activation_title'],
  ['device-rules', 'terms_device_rules_title'],
  ['responsibilities', 'terms_responsibilities_title'],
  ['no-advice', 'terms_no_advice_title'],
  ['third-party', 'terms_third_party_title'],
  ['liability', 'terms_liability_title'],
  ['law', 'terms_law_title'],
  ['changes', 'terms_changes_title'],
];
