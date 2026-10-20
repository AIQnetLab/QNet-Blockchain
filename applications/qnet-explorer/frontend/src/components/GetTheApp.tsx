// "Get QNet Wallet" (B-SPEC 5.17, 6.1): on a computer one QR code of /get (each phone scanning it lands in its own
// store) beside the three stores, the list exactly as tall as the code; on a phone or tablet one large button for its
// own store and a sentence with the other phone store, since a code is of no use on the device that shows it and a
// phone cannot install the browser extension. The device comes from the request (<html data-device>, set by the root
// layout), so the right variant shows from the first paint and nothing swaps after load.

import { useMemo } from 'react';
import Action from '@/components/ui/Action';
import Section from '@/components/ui/Section';
import { ANDROID_PLAY_URL, GET_APP_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL } from '@/lib/app-links';
import { EXTENSION_STORE_URL } from '@/lib/qnet-provider';
import { qrMatrix, qrPath } from '@/lib/qr';

const QUIET = 4;
// The logo covers this many modules square in the middle; the code's error correction restores what it hides.
const LOGO_MODULES = 5;

const STORES = [
  { key: 'ios', label: IOS_APP_STORE_URL ? 'App Store' : 'TestFlight', from: IOS_APP_STORE_URL ? 'the App Store' : 'TestFlight', note: 'iPhone and iPad', href: IOS_INSTALL_URL },
  { key: 'android', label: 'Google Play', from: 'Google Play', note: 'Android phones and tablets', href: ANDROID_PLAY_URL },
  { key: 'extension', label: 'Chrome Web Store', from: 'the Chrome Web Store', note: 'Browser extension', href: EXTENSION_STORE_URL },
] as const;

const host = (href: string) => new URL(href).host;

function GetQr() {
  const { size, path } = useMemo(() => {
    const matrix = qrMatrix(GET_APP_URL);
    return { size: matrix.size, path: qrPath(matrix, QUIET) };
  }, []);
  const box = size + 2 * QUIET;
  const logo = (box - LOGO_MODULES) / 2;
  return (
    <svg className="qr-code" viewBox={`0 0 ${box} ${box}`} width={264} height={264} role="img" aria-label="QR code that opens QNet Wallet in your phone's store" shapeRendering="crispEdges">
      <rect width={box} height={box} fill="#ffffff" />
      <path d={path} fill="#05080A" />
      <rect x={logo - 0.5} y={logo - 0.5} width={LOGO_MODULES + 1} height={LOGO_MODULES + 1} rx={1.2} fill="#ffffff" />
      <image href="/icon-192.png" x={logo} y={logo} width={LOGO_MODULES} height={LOGO_MODULES} clipPath="inset(0 round 1px)" />
    </svg>
  );
}

// The device's own store first, the other phone store in a sentence.
function OwnStore({ store, other }: { store: (typeof STORES)[number]; other: (typeof STORES)[number] }) {
  return (
    <div className={`own own-${store.key}`}>
      <Action kind="solid" href={store.href} external>Install from {store.from}</Action>
      <p className="own-note">{store.note}</p>
      <p className="own-others body">
        Also on <a href={other.href} target="_blank" rel="noopener noreferrer">{other.label}</a> for {other.note}.
      </p>
    </div>
  );
}

const LEAD = 'A non-custodial wallet for QNet Blockchain, with an optional light node.';

// `lead`: null where the page's own title band already says it (the wallet page); `variant`: the section's rhythm.
export default function GetTheApp({ lead = LEAD, variant = 'home' }: { lead?: string | null; variant?: 'home' | 'tool' }) {
  const [ios, android] = STORES;
  return (
    <Section id="get" title="Get QNet Wallet" lead={lead ?? undefined} variant={variant} className="get">
      <div className="get-body">
        <figure className="qr">
          <GetQr />
          <figcaption className="note">Point your phone&apos;s camera at the code</figcaption>
        </figure>
        <ul className="stores">
          {STORES.map((store) => (
            <li key={store.key}>
              <a className="store" href={store.href} target="_blank" rel="noopener noreferrer">
                <span className="store-n">{store.label}</span>
                <span className="store-d">{store.note}</span>
                <span className="store-u">{host(store.href)}</span>
              </a>
            </li>
          ))}
        </ul>
        <OwnStore store={ios} other={android} />
        <OwnStore store={android} other={ios} />
      </div>
    </Section>
  );
}
