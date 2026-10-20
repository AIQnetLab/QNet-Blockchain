// The wallet page says what exists today. Metrics that nobody can verify and statuses that are not true yet do not
// belong here. The QNet app's view never shows it (app/wallet/layout.tsx): it describes activation, the extension's store
// and the builds outside the stores. One app on every phone and tablet, so one row for it (unified plan section 0). The
// Android file it offers, once one is set, is the Play-signed build (src/server/wallet-apk.ts): it runs the whole wallet,
// and its light node only once Google Play licenses the install, which needs the Play listing to be live for that
// account, so the page says so next to the file (SD-R2-03). A server component, so the setting is read per request.

import Link from 'next/link';
import { walletApkUrl } from '@/server/wallet-apk';
import { ANDROID_PLAY_URL as PLAY_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL } from '@/lib/app-links';
import GetTheApp from '@/components/GetTheApp';
import Action from '@/components/ui/Action';
import LanguageList from '@/components/ui/LanguageList';
import PageHead from '@/components/ui/PageHead';
import Section from '@/components/ui/Section';

export default function WalletPage() {
  const apk = walletApkUrl();
  return (
    <div className="pg">
      <PageHead title="QNet Wallet" lead="A non-custodial wallet for QNet Blockchain, with an optional light node." />

      <GetTheApp lead={null} variant="tool" />

      <Section id="details" title="What QNet Wallet does" variant="tool" className="topics">
        <div className="spec">
          <h3 className="h3">The app — iPhone, iPad, Android phones and tablets</h3>
          <div className="body">
            <p>
              One app with the same screens and the same features on every phone and tablet: the wallet, and a Node tab
              that runs this wallet&apos;s light node on the device. Keys stay in the device&apos;s secure storage. The app
              opens with the device&apos;s own authentication — Face ID, Touch ID, a fingerprint or the device passcode —
              and, on a device without any of them, with an app password; a wallet set up with an app password can
              switch to the device&apos;s authentication.
            </p>
            <p>
              On Android it is one app, io.aiqnet.wallet:
              the file shared outside Google Play is the same signed build. It runs the whole wallet; its light node
              runs once Google Play licenses the install, which needs the Google Play listing to be live for your
              account, and until then its Node tab says to install QNet Wallet from Google Play. The app does not
              update itself: a newer version comes from the store, or as a newer file from the same place. On Android
              it is on{' '}
              <a href={PLAY_URL} target="_blank" rel="noopener noreferrer">Google Play</a>
              {IOS_APP_STORE_URL ? (<>, on iPhone and iPad on the{' '}
                <a href={IOS_APP_STORE_URL} target="_blank" rel="noopener noreferrer">App Store</a>.</>
              ) : (<>; on iPhone and iPad, until the App Store listing is live, it installs from{' '}
                <a href={IOS_INSTALL_URL} target="_blank" rel="noopener noreferrer">TestFlight</a>.</>)}
              {apk ? ' The Android file here also runs the wallet.' : ''}
            </p>
            {apk && (
              <a className="btn btn-text" href={apk} rel="noopener noreferrer">
                Download QNet Wallet for Android (APK)
              </a>
            )}
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">Browser extension — for desktop browsers</h3>
          <div className="body">
            <p>
              Create or import a wallet, send and receive QNC, SOL and 1DEV, follow your history. Keys are generated in the
              browser and stored encrypted; they never leave it. The Activate tab burns 1DEV on Solana for a light or a
              super node, one activation per wallet, issues the activation code and, for a light node, records it on
              QNet Blockchain in the same approval; a light node then runs on a phone or tablet, a super node on a server. A
              site such as aiqnet.io can read the wallet&apos;s addresses only after you approve it in the extension.
            </p>
            <Action href="/qnet-wallet-extension" className="desk-only">How to install the extension</Action>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">Your keys, your device</h3>
          <div className="body">
            <p>
              A recovery phrase, generated locally, is the only backup. The publisher has no servers that hold keys, no
              accounts and no way to recover a lost phrase.
            </p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">Light node</h3>
          <div className="body">
            <p>
              A light node runs on one phone or tablet at a time; computers and emulators cannot run one. Linking it to a
              device includes a device check by the device&apos;s operating system. A few times per four-hour epoch
              QNet Blockchain asks the device for a status answer; the device signs it and answers while QNet Wallet runs on it,
              open, in the background or behind the lock screen.
            </p>
            <p>
              No hashing and no proof-of-work: each answer is one signature, so the device does no sustained work. For
              each epoch the chain records which nodes answered, and the protocol adds a share of that epoch&apos;s
              emission to their node balance — three quarters among light nodes, one quarter among super nodes. The
              wallet moves the node balance into itself with an ordinary transaction.
            </p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">Activation</h3>
          <div className="body">
            <p>
              Nodes are activated at <Link href="/node">aiqnet.io/node</Link>. In Phase 1 a light node&apos;s 1DEV burn is made
              by the page from a one-time payment address in the browser, after QNet Wallet confirms the wallet, or by
              the QNet Wallet extension from its own address; a super node&apos;s burn only by the extension, and the super node
              runs on the user&apos;s own server with the QNet Blockchain node software. The tokens are destroyed, and the burn
              transaction is the proof. QNet Wallet then confirms the light node of its own wallet on its own screen and
              runs it on that device. One node per wallet, light or super. The app burns nothing, sells nothing and shows
              no price. Phase 2 moves activation to QNC. The <Link href="/docs">documentation</Link> has the details.
            </p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">History that outlives pruning</h3>
          <div className="body">
            <p>
              Nodes keep about a day of transactions; the explorer keeps all of them. The wallet reads its QNet Blockchain history
              from the explorer archive and the freshest blocks from the nodes, and each confirmed transaction in it opens
              in the explorer. The app also lists the SOL and 1DEV sends made on that device, and says so above its
              History.
            </p>
          </div>
        </div>

        <div className="spec">
          <h3 className="h3">Eleven languages</h3>
          <div className="body">
            <p>The app reads right to left where the language needs it.</p>
            <LanguageList />
          </div>
        </div>
      </Section>
    </div>
  );
}
