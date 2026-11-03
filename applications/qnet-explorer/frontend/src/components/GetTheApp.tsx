'use client';

// "Get QNet Wallet": on a computer one QR code of /get (each phone scanning it lands in its own
// store) beside the three stores, the list exactly as tall as the code; on a phone or tablet one large button for its
// own store and a sentence with the other phone store, since a code is of no use on the device that shows it and a
// phone cannot install the browser extension. The device comes from the request (<html data-device>, set by the root
// layout), so the right variant shows from the first paint and nothing swaps after load.

import { useMemo } from 'react';
import Action from '@/components/ui/Action';
import Section from '@/components/ui/Section';
import { useI18n } from '@/i18n/client';
import { ANDROID_PLAY_URL, GET_APP_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL } from '@/lib/app-links';
import { EXTENSION_STORE_URL } from '@/lib/qnet-provider';
import { qrMatrix, qrPath } from '@/lib/qr';
import type { MessageKey } from '@/lib/texts';

const QUIET = 4;
// The logo covers this many modules square in the middle; the code's error correction restores what it hides.
const LOGO_MODULES = 5;

// Each store's name, the button that installs from it and the devices it serves; a phone store also the sentence that
// names it as the other phone store.
interface Store { key: string; label: string; install: MessageKey; note: MessageKey; href: string }
interface PhoneStore extends Store { also: MessageKey }

const IOS: PhoneStore = {
  key: 'ios', label: IOS_APP_STORE_URL ? 'App Store' : 'TestFlight', install: IOS_APP_STORE_URL ? 'get_install_app_store' : 'get_install_testflight',
  note: 'get_note_ios', also: 'get_also_ios', href: IOS_INSTALL_URL,
};
const ANDROID: PhoneStore = { key: 'android', label: 'Google Play', install: 'get_install_play', note: 'get_note_android', also: 'get_also_android', href: ANDROID_PLAY_URL };
const STORES: readonly Store[] = [
  IOS,
  ANDROID,
  { key: 'extension', label: 'Chrome Web Store', install: 'get_install_extension', note: 'get_note_extension', href: EXTENSION_STORE_URL },
];

const host = (href: string) => new URL(href).host;

function GetQr() {
  const { t } = useI18n();
  const { size, path } = useMemo(() => {
    const matrix = qrMatrix(GET_APP_URL);
    return { size: matrix.size, path: qrPath(matrix, QUIET) };
  }, []);
  const box = size + 2 * QUIET;
  const logo = (box - LOGO_MODULES) / 2;
  return (
    <svg className="qr-code" viewBox={`0 0 ${box} ${box}`} width={264} height={264} role="img" aria-label={t('get_qr_label')} shapeRendering="crispEdges">
      <rect width={box} height={box} fill="#ffffff" />
      <path d={path} fill="#05080A" />
      <rect x={logo - 0.5} y={logo - 0.5} width={LOGO_MODULES + 1} height={LOGO_MODULES + 1} rx={1.2} fill="#ffffff" />
      <image href="/icon-192.png" x={logo} y={logo} width={LOGO_MODULES} height={LOGO_MODULES} clipPath="inset(0 round 1px)" />
    </svg>
  );
}

// The device's own store first, the other phone store in a sentence.
function OwnStore({ store, other }: { store: PhoneStore; other: PhoneStore }) {
  const { say, rich } = useI18n();
  return (
    <div className={`own own-${store.key}`}>
      <Action kind="solid" href={store.href} external>{say(store.install)}</Action>
      <p className="own-note">{say(store.note)}</p>
      <p className="own-others body">
        {rich(other.also, { store: <a href={other.href} target="_blank" rel="noopener noreferrer" translate="no">{other.label}</a> })}
      </p>
    </div>
  );
}

// `lead`: false where the page's own title band already says it (the wallet page); `variant`: the section's rhythm.
export default function GetTheApp({ lead = true, variant = 'home' }: { lead?: boolean; variant?: 'home' | 'tool' }) {
  const { t, say } = useI18n();
  return (
    <Section id="get" title={say('get_title')} lead={lead ? say('wallet_page_lead') : undefined} variant={variant} className="get">
      <div className="get-body">
        <figure className="qr">
          <GetQr />
          <figcaption className="note">{t('get_qr_caption')}</figcaption>
        </figure>
        <ul className="stores">
          {STORES.map((store) => (
            <li key={store.key}>
              <a className="store" href={store.href} target="_blank" rel="noopener noreferrer">
                <span className="store-n" translate="no">{store.label}</span>
                <span className="store-d">{say(store.note)}</span>
                <span className="store-u">{host(store.href)}</span>
              </a>
            </li>
          ))}
        </ul>
        <OwnStore store={IOS} other={ANDROID} />
        <OwnStore store={ANDROID} other={IOS} />
      </div>
    </Section>
  );
}
