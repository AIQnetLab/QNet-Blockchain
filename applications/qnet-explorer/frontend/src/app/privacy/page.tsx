'use client';

// The one privacy policy for QNet Wallet on every platform and for this website. It describes what the
// software actually does with data — nothing more, nothing less — so a reader can check every sentence
// against the open-source code (src/lib/__tests__/privacy-claims.test.mjs checks several). The QNet app
// links it, so it describes each data flow without pointing the reader to a page that activates a node: the
// addresses of the node pages and the testnet faucet are named only outside the app's view (`full`, as on the
// Terms page; src/lib/__tests__/in-app-pages.test.mjs). The device check of a light node follows
// docs/protocols/light-node-messages.md sections 5 to 9.

import DocToc from '@/components/DocToc';
import PageHead from '@/components/ui/PageHead';
import { useActivationContent } from '@/contexts/AppContext';
import { Link, useI18n } from '@/i18n/client';
import { dayUtc } from '@/lib/format';
import type { MessageKey } from '@/lib/texts';

// The date of this version of the policy.
const EFFECTIVE = Date.UTC(2026, 10, 3);

export default function PrivacyPage() {
  const { t, say, rich } = useI18n();
  const full = useActivationContent();
  return (
    <div className="pg">
      <PageHead title={t('support_legal_privacy')} lead={say('privacy_lead')} />
      <div className="wrap pg-body doc-grid">
        <div className="doc-main">

          <section className="doc-sec prose" id="responsible">
            <h2>{t('privacy_responsible_title')}</h2>
            <p>{rich('privacy_responsible_1', { email: <a href="mailto:support@aiqnet.io" translate="no">support@aiqnet.io</a> })}</p>
          </section>

          <section className="doc-sec prose" id="in-short">
            <h2>{t('privacy_in_short_title')}</h2>
            <ul>
              <li>{t('privacy_in_short_1')}</li>
              <li>{t('privacy_in_short_2')}</li>
              <li>{t('privacy_in_short_3')}</li>
              <li>{say('privacy_in_short_4')}</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="on-device">
            <h2>{t('privacy_on_device_title')}</h2>
            <p>{t('privacy_on_device_1')}</p>
            <p>{say('privacy_on_device_2')}</p>
            <p>{t('privacy_on_device_3')}</p>
          </section>

          <section className="doc-sec prose" id="sent">
            <h2>{t('privacy_sent_title')}</h2>
            <ul>
              <li>{rich('privacy_sent_1', { b: <strong>{t('privacy_sent_1_b')}</strong> })}</li>
              <li>{rich('privacy_sent_2', { b: <strong>{t('privacy_sent_2_b')}</strong> })}</li>
              <li>{rich('privacy_sent_3', { b: <strong>{t('privacy_sent_3_b')}</strong> })}</li>
              <li>{rich('privacy_sent_4', { b: <strong>{t('privacy_sent_4_b')}</strong> })}</li>
              <li>{rich('privacy_sent_5', { b: <strong>{t('privacy_sent_5_b')}</strong> })}</li>
              <li>{rich('privacy_sent_6', { b: <strong>{t('privacy_sent_6_b')}</strong> })}</li>
              <li>{rich('privacy_sent_7', { b: <strong>{t('privacy_sent_7_b')}</strong> })}</li>
              <li>{rich('privacy_sent_8', { b: <strong>{t('privacy_sent_8_b')}</strong> })}</li>
              <li>{rich('privacy_sent_9', { b: <strong>{t('privacy_sent_9_b')}</strong> })}</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="device-check">
            <h2>{t('privacy_device_check_title')}</h2>
            <p>{say('privacy_device_check_1')}</p>
            <p>{rich('privacy_device_check_2', { b: <strong>{t('privacy_device_check_2_b')}</strong> })}</p>
            <p>{rich('privacy_device_check_3', { b: <strong>{t('privacy_device_check_3_b')}</strong> })}</p>
            <p>{rich('privacy_device_check_4', { b: <strong>{t('privacy_device_check_4_b')}</strong> })}</p>
          </section>

          <section className="doc-sec prose" id="permissions">
            <h2>{t('privacy_permissions_title')}</h2>
            <p>{say('privacy_permissions_1')}</p>
          </section>

          <section className="doc-sec prose" id="website">
            <h2>{t('privacy_website_title')}</h2>
            <p>
              {rich('privacy_website_intro', { nodePage: full ? <> (<Link href="/node" translate="no">aiqnet.io/node</Link>)</> : null })}
            </p>
            <p>{rich('privacy_website_1', { b: <strong>{t('privacy_website_1_b')}</strong> })}</p>
            <p>{rich('privacy_website_2', { b: <strong>{t('privacy_website_2_b')}</strong> })}</p>
            <p>
              {rich('privacy_website_faucet', {
                b: <strong>{t('privacy_website_faucet_b')}</strong>,
                faucetPage: full ? rich('privacy_website_faucet_on', { page: <Link href="/testnet" translate="no">aiqnet.io/testnet</Link> }) : null,
              })}
            </p>
          </section>

          <section className="doc-sec prose" id="retention">
            <h2>{t('privacy_retention_title')}</h2>
            <ul>
              <li>{t('privacy_retention_1')}</li>
              <li>{say('privacy_retention_2')}</li>
              <li>{t('privacy_retention_3')}</li>
              <li>{t('privacy_retention_4')}</li>
              <li>{t('privacy_retention_5')}</li>
              <li>{t('privacy_retention_6')}</li>
              <li>{t('privacy_retention_relay')}</li>
              <li>{t('privacy_retention_7')}</li>
              <li>{say('privacy_retention_8')}</li>
              <li>{t('privacy_retention_9')}</li>
              <li>{t('privacy_retention_10')}</li>
              <li>{t('privacy_retention_11')}</li>
              <li>{t('privacy_retention_12')}</li>
              <li>{t('privacy_retention_13')}</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="sharing">
            <h2>{t('privacy_sharing_title')}</h2>
            <p>{t('privacy_sharing_1')}</p>
          </section>

          <section className="doc-sec prose" id="rights">
            <h2>{t('privacy_rights_title')}</h2>
            <p>{rich('privacy_rights_1', { email: <a href="mailto:support@aiqnet.io" translate="no">support@aiqnet.io</a> })}</p>
          </section>

          <section className="doc-sec prose" id="children">
            <h2>{t('privacy_children_title')}</h2>
            <p>{t('privacy_children_1')}</p>
          </section>

          <section className="doc-sec prose" id="security">
            <h2>{t('privacy_security_title')}</h2>
            <p>{say('privacy_security_1')}</p>
          </section>

          <section className="doc-sec prose" id="changes">
            <h2>{t('privacy_changes_title')}</h2>
            <p>{t('privacy_changes_1')}</p>
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
  ['responsible', 'privacy_responsible_title'],
  ['in-short', 'privacy_in_short_title'],
  ['on-device', 'privacy_on_device_title'],
  ['sent', 'privacy_sent_title'],
  ['device-check', 'privacy_device_check_title'],
  ['permissions', 'privacy_permissions_title'],
  ['website', 'privacy_website_title'],
  ['retention', 'privacy_retention_title'],
  ['sharing', 'privacy_sharing_title'],
  ['rights', 'privacy_rights_title'],
  ['children', 'privacy_children_title'],
  ['security', 'privacy_security_title'],
  ['changes', 'privacy_changes_title'],
];
