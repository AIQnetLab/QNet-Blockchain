'use client';

// Support page for QNet Wallet: how to reach a person, and the answers most questions come down to. The
// QNet app links it and its in-app browser lists it, so in the app's view it links no page about
// activation (the documentation; src/lib/activate-view.ts). There it links no place off this site either,
// only the support address: the repository (its issues are one tap from its front page, which describes
// activation and its cost, and its Releases hold the APK) and the
// Telegram channel (where the site says Android builds are shared) are shown only outside it (R4-XPD-06).
// The app is the same on every phone and tablet, so the app's view names no platform: the settings of each
// system are listed only outside it, as is the move from the older Android app installed from a file (owner
// decision 26.09: one Android package). A node that does not run on a device is the user's to move: another phone or
// tablet takes it over (owner, 04.10: self-service only, no review step). Its texts are the support_ keys
// (src/lib/texts.ts). Contact stands beside the answers on a wide screen and after them on a narrow one, so the rows
// it shows once the wallet is detected move nothing above them.

import Link from 'next/link';
import PageHead from '@/components/ui/PageHead';
import { useActivationContent } from '@/contexts/AppContext';
import { rich } from '@/lib/rich';
import { t } from '@/lib/texts';

export default function SupportPage() {
  const full = useActivationContent();
  return (
    <div className="pg">
      <PageHead title={t('support_title')} lead={t('support_subtitle')} />
      <div className="wrap pg-body doc-grid">
        <div className="doc-main">

          <section className="doc-sec" id="lost-phrase">
            <h2>{t('support_lost_title')}</h2>
            <div className="prose">
              <p>{t('support_lost')}</p>
            </div>
          </section>

          <section className="doc-sec" id="pending">
            <h2>{t('support_pending_title')}</h2>
            <div className="prose">
              <p>{t('support_pending_lead')}</p>
              <ul>
                <li>{t('support_pending_app')}</li>
                <li>{t('support_pending_extension')}</li>
              </ul>
              <p>{t('support_pending_once')}</p>
            </div>
          </section>

          <section className="doc-sec" id="epochs">
            <h2>{t('support_epochs_title')}</h2>
            <div className="prose">
              <p>{t('support_epochs_lead')}</p>
              <ul>
                <li>{t('support_epochs_closed')}</li>
                <li>{t('support_epochs_battery')}</li>
                <li>{t('support_epochs_offline')}</li>
                {full && <li>{t('support_epochs_apple')}</li>}
                {full && <li>{t('support_epochs_android')}</li>}
              </ul>
              <p>{t('support_epochs_sleep')}</p>
            </div>
          </section>

          <section className="doc-sec" id="device-check">
            <h2>{t('support_device_title')}</h2>
            <div className="prose">
              <p>{rich('support_device_lead', { rules: <Link href="/terms#device-rules">{t('support_device_rules_link')}</Link> })}</p>
            </div>
          </section>

          {full && (
            <section className="doc-sec" id="new-app">
              <h2>{t('support_move_title')}</h2>
              <div className="prose">
                <p>{rich('support_move', { walletPage: <Link href="/wallet">{t('support_move_wallet_link')}</Link> })}</p>
              </div>
            </section>
          )}

          <section className="doc-sec" id="history">
            <h2>{t('support_history_title')}</h2>
            <div className="prose">
              <p>{rich('support_history', { explorer: <Link href="/explorer">{t('support_history_explorer_link')}</Link> })}</p>
            </div>
          </section>

          <section className="doc-sec" id="legal">
            <h2>{t('support_legal_title')}</h2>
            <div className="prose">
              <p>
                {rich('support_legal', {
                  privacy: <Link href="/privacy">{t('support_legal_privacy')}</Link>,
                  terms: <Link href="/terms">{t('support_legal_terms')}</Link>,
                })}
              </p>
            </div>
          </section>

        </div>

        <aside className="doc-aside">
          <section className="doc-sec" id="contact">
            <h2>{t('support_contact_title')}</h2>
            <div className="prose">
              {/* Above the rows that appear once the wallet check ends, so it never moves when they do. */}
              <p>{t('support_never_share')}</p>
              <ul>
                <li>{rich('support_contact_email', { address: <a href="mailto:support@aiqnet.io">support@aiqnet.io</a> })}</li>
                {full && <li>{rich('support_contact_bugs', { link: <a href="https://github.com/AIQnetLab/QNet-Blockchain/issues" target="_blank" rel="noopener noreferrer">{t('support_contact_bugs_link')}</a> })}</li>}
                {full && <li>{rich('support_contact_community', { link: <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer">Telegram</a> })}</li>}
                {full && <li>{rich('support_contact_docs', { link: <Link href="/docs">aiqnet.io/docs</Link> })}</li>}
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
