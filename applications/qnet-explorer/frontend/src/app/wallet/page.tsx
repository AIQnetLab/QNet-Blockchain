// The wallet page says what exists today. Metrics that nobody can verify and statuses that are not true yet do not
// belong here. The QNet app's view never shows it (app/wallet/layout.tsx): it describes activation, the extension's store
// and the builds outside the stores. One app on every phone and tablet, so one row for it. The
// Android file it offers, once one is set, is the Play-signed build (src/server/wallet-apk.ts): it runs the whole wallet,
// and its light node only once Google Play licenses the install, which needs the Play listing to be live for that
// account, so the page says so next to the file. A server component, so the setting is read per request.

import { Link } from '@/i18n/client';
import { getI18n } from '@/i18n/server';
import { walletApkUrl } from '@/server/wallet-apk';
import { ANDROID_PLAY_URL as PLAY_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL } from '@/lib/app-links';
import GetTheApp from '@/components/GetTheApp';
import Action from '@/components/ui/Action';
import LanguageList from '@/components/ui/LanguageList';
import PageHead from '@/components/ui/PageHead';
import Section from '@/components/ui/Section';

export default async function WalletPage() {
  const { t, say, rich } = await getI18n();
  const apk = walletApkUrl();
  const store = (href: string, name: string) => <a href={href} target="_blank" rel="noopener noreferrer" translate="no">{name}</a>;
  return (
    <div className="pg">
      <PageHead title="QNet Wallet" lead={say('wallet_page_lead')} />

      <GetTheApp lead={false} variant="tool" />

      <Section id="details" title={say('wp_title')} variant="tool" className="topics">
        <div className="spec">
          <h3 className="h3">{t('wp_app_title')}</h3>
          <div className="body">
            <p>{t('wp_app_p1')}</p>
            <p>
              {say('wp_app_p2')}{' '}
              {rich(IOS_APP_STORE_URL ? 'wp_app_stores' : 'wp_app_stores_testflight', {
                play: store(PLAY_URL, 'Google Play'),
                appStore: store(IOS_APP_STORE_URL ?? IOS_INSTALL_URL, 'App Store'),
                testflight: store(IOS_INSTALL_URL, 'TestFlight'),
              })}
              {apk ? ` ${t('wp_app_apk_note')}` : ''}
            </p>
            {apk && (
              <a className="btn btn-text" href={apk} rel="noopener noreferrer">
                {say('wp_app_apk')}
              </a>
            )}
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('wp_ext_title')}</h3>
          <div className="body">
            <p>{say('wp_ext_p')}</p>
            <Action href="/qnet-wallet-extension" className="desk-only">{t('wp_ext_install')}</Action>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('wp_keys_title')}</h3>
          <div className="body">
            <p>{t('wp_keys_p')}</p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('ext_type_light')}</h3>
          <div className="body">
            <p>{say('wp_light_p1')}</p>
            <p>{t('wp_light_p2')}</p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('wp_activation_title')}</h3>
          <div className="body">
            <p>
              {rich('wp_activation_p', {
                node: <Link href="/node" translate="no">aiqnet.io/node</Link>,
                docs: <Link href="/docs">{t('dao_docs_link')}</Link>,
              })}
            </p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('wp_history_title')}</h3>
          <div className="body">
            <p>{say('wp_history_p')}</p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">{t('wp_languages_title')}</h3>
          <div className="body">
            <p>{t('wp_languages_p')}</p>
            <LanguageList />
          </div>
        </div>
      </Section>
    </div>
  );
}
