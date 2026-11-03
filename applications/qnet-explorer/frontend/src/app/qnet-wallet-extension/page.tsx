// The browser extension's page: what it does, where it installs from and the steps after. The provider sends a browser
// without a usable extension here (src/lib/qnet-provider.ts). A server component: nothing on it changes in the browser.

import { Link } from '@/i18n/client';
import { getI18n } from '@/i18n/server';
import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import Section from '@/components/ui/Section';
import { EXTENSION_STORE_URL } from '@/lib/qnet-provider';
import type { MessageKey } from '@/lib/texts';

// The manifest's minimum_chrome_version (applications/qnet-wallet/dist/manifest.json).
const MIN_BROWSER_VERSION = 111;

// Each installation step's title and what to do.
const STEPS: [MessageKey, MessageKey][] = [
  ['xp_step1_t', 'xp_step1'],
  ['xp_step2_t', 'xp_step2'],
  ['xp_step3_t', 'xp_step3'],
  ['xp_step4_t', 'xp_step4'],
];

export default async function QNetWalletExtensionPage() {
  const { t, say, rich } = await getI18n();
  return (
    <div className="pg">
      <PageHead title={say('xp_title')} lead={say('xp_lead')}>
        <div className="pg-act desk-only" data-field-clear>
          <Action kind="solid" href={EXTENSION_STORE_URL} external>{t('get_install_extension')}</Action>
          <p className="note">{t('xp_browsers', { version: MIN_BROWSER_VERSION })}</p>
        </div>
        <p className="body phone-only" data-field-dim="0.1">
          {rich('xp_phone', { app: <Link href="/wallet#get">{say('xp_phone_link')}</Link> })}
        </p>
      </PageHead>

      <Section id="what" title={t('xp_what_title')} variant="tool" className="topics">
        <div className="spec">
          <h3 className="h3">{t('xp_storage_title')}</h3>
          <div className="body">
            <p>{t('xp_storage_p')}</p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">{t('xp_verified_title')}</h3>
          <div className="body">
            <p>{say('xp_verified_p')}</p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">{t('xp_sites_title')}</h3>
          <div className="body">
            <p>{t('xp_sites_p')}</p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">{t('xp_activation_title')}</h3>
          <div className="body">
            <p>{rich('xp_activation_p', { node: <Link href="/node" translate="no">aiqnet.io/node</Link> })}</p>
          </div>
        </div>
      </Section>

      <Section id="install" title={t('xp_install_title')} variant="tool">
        {/* The site's numbered steps (styles/cabinet.css, the activation's too): the order is the information. */}
        <ol className="cab-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="cab-step">
              <span className="cab-step-n" aria-hidden="true">{i + 1}</span>
              <div className="cab-step-body">
                <h3 className="cab-step-t">{say(title)}</h3>
                <p>{say(text)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="requirements" title={t('xp_req_title')} variant="tool">
        <dl className="kv">
          <div>
            <dt>{t('xp_req_browser')}</dt>
            <dd>{t('xp_req_browser_v', { version: MIN_BROWSER_VERSION })}</dd>
          </div>
          <div>
            <dt>{t('xp_req_device')}</dt>
            <dd>{say('xp_req_device_v')}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}
