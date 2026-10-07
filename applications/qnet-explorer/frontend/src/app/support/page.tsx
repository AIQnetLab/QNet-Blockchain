'use client';

// Support page for QNet Wallet: how to reach a person, and the answers most questions come down to. The
// QNet app links it and its in-app browser lists it, so in the app's view it links no page about
// activation (the documentation) and keeps that view on its own links (src/lib/activate-view.ts). There it
// links no place off this site either, only the support address: the repository (its issues are one tap
// from its front page, which describes activation and its cost, and its Releases hold the APK) and the
// Telegram channel (where the site says Android builds are shared) are shown only outside it (R4-XPD-06).
// The app is the same on every phone and tablet, so the app's view names no platform: the settings of each
// system are listed only outside it, as is the move from the older Android app installed from a file (owner
// decision 26.09: one Android package). A node that does not run on a device is the user's to move: another phone or
// tablet takes it over (owner, 04.10: self-service only, no review step). Its texts are the support_ keys
// (src/lib/texts.ts).

import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { keepFromApp } from '@/lib/activate-view';
import { rich } from '@/lib/rich';
import { t } from '@/lib/texts';

export default function SupportPage() {
  const full = useActivationContent();
  const { fromApp } = useWallet();
  const here = (href: string) => keepFromApp(href, fromApp);
  return (
    <div className="page-support">
      <section className="explorer-section" data-section="support">
        <div className="explorer-header">
          <h2 className="section-title">{t('support_title')}</h2>
          <p className="section-subtitle">{t('support_subtitle')}</p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>

          <div className="privacy-section">
            <h3>{t('support_contact_title')}</h3>
            <ul>
              <li>{rich('support_contact_email', { address: <a href="mailto:support@aiqnet.io">support@aiqnet.io</a> })}</li>
              {full && <li>{rich('support_contact_bugs', { link: <a href="https://github.com/AIQnetLab/QNet-Blockchain/issues" target="_blank" rel="noopener noreferrer">{t('support_contact_bugs_link')}</a> })}</li>}
              {full && <li>{rich('support_contact_community', { link: <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer">Telegram</a> })}</li>}
              {full && <li>{rich('support_contact_docs', { link: <a href="/docs">aiqnet.io/docs</a> })}</li>}
            </ul>
            <p>{t('support_never_share')}</p>
          </div>

          <div className="privacy-section">
            <h3>{t('support_lost_title')}</h3>
            <p>{t('support_lost')}</p>
          </div>

          <div className="privacy-section">
            <h3>{t('support_pending_title')}</h3>
            <p>{t('support_pending_lead')}</p>
            <ul>
              <li>{t('support_pending_app')}</li>
              <li>{t('support_pending_extension')}</li>
            </ul>
            <p>{t('support_pending_once')}</p>
          </div>

          <div className="privacy-section">
            <h3>{t('support_epochs_title')}</h3>
            <p>{t('support_epochs_lead')}</p>
            <ul>
              <li>{t('support_epochs_closed')}</li>
              <li>{t('support_epochs_battery')}</li>
              <li>{t('support_epochs_offline')}</li>
              {full && <li>{t('support_epochs_apple')}</li>}
              {full && <li>{t('support_epochs_android')}</li>}
            </ul>
            <p>{t('support_epochs_sleep')}</p>
            {full && <p>{rich('support_epochs_wake', { nodePage: <a href="/node?tab=overview">{t('support_epochs_wake_link')}</a> })}</p>}
          </div>

          <div className="privacy-section" id="device-check">
            <h3>{t('support_device_title')}</h3>
            <p>{rich('support_device_lead', { rules: <a href={`${here('/terms')}#device-rules`}>{t('support_device_rules_link')}</a> })}</p>
          </div>

          {full && (
            <div className="privacy-section" id="new-app">
              <h3>{t('support_move_title')}</h3>
              <p>{rich('support_move', { walletPage: <a href="/wallet">{t('support_move_wallet_link')}</a> })}</p>
            </div>
          )}

          <div className="privacy-section">
            <h3>{t('support_history_title')}</h3>
            <p>{rich('support_history', { explorer: <a href={here('/explorer')}>{t('support_history_explorer_link')}</a> })}</p>
          </div>

          <div className="privacy-section">
            <h3>{t('support_legal_title')}</h3>
            <p>
              {rich('support_legal', {
                privacy: <a href={here('/privacy')}>{t('support_legal_privacy')}</a>,
                terms: <a href={here('/terms')}>{t('support_legal_terms')}</a>,
              })}
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
