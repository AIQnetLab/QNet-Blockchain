// The wallet page says what exists today and links the policies. Metrics that nobody can verify and statuses that
// are not true yet do not belong here. The QNet app's view never shows it (app/wallet/layout.tsx): it describes
// activation, the extension's store and the builds outside the stores. One app on every phone and tablet, so one
// card for it (unified plan section 0). The Android file it offers, once one is set, is the Play-signed build
// (src/server/wallet-apk.ts): it runs the whole wallet, and its light node only once Google Play licenses the install,
// which needs the Play listing to be live for that account, so the page says so next to the file (SD-R2-03). A server
// component, so the setting is read per request.

import { walletApkUrl } from '@/server/wallet-apk';
import { ANDROID_PLAY_URL as PLAY_URL } from '@/lib/app-links';

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/qnet-wallet/pahnggomgmhhjjncgfnmmofmplfhkncg';
const BUTTON: React.CSSProperties = { display: 'inline-block', marginTop: '0.75rem', padding: '8px 16px', border: '1px solid #00d4ff', borderRadius: '6px', color: '#00d4ff' };

export default function WalletPage() {
  const apk = walletApkUrl();
  return (
    <div className="page-wallet">
      <section className="explorer-section" data-section="wallet">
        <div className="explorer-header">
          <h2 className="section-title">QNet Wallet</h2>
          <p className="section-subtitle" style={{ marginBottom: '3rem' }}>
            A non-custodial wallet for the QNet network, with an optional light node
          </p>
        </div>

        {/* Platforms */}
        <div style={{ marginBottom: '3rem' }}>
          <div className="tool-card-large" style={{ border: '1px solid rgba(0, 212, 255, 0.3)', marginBottom: '1.5rem', position: 'relative' }}>
            <h4>The app — iPhone, iPad, Android phones and tablets</h4>
            <p>
              One app with the same screens and the same features on every phone and tablet: the wallet, and a Node tab
              that runs this wallet&apos;s light node on the device. Keys stay in the device&apos;s secure storage. The app
              opens with the device&apos;s own authentication — Face ID, Touch ID, a fingerprint or the device passcode —
              and, on a device without any of them, with an app password; a wallet set up with an app password can
              switch to the device&apos;s authentication. On Android it is one app, io.aiqnet.wallet:
              the file shared outside Google Play is the same signed build. It runs the whole wallet; its light node
              runs once Google Play licenses the install, which needs the Google Play listing to be live for your
              account, and until then its Node tab says to install QNet Wallet from Google Play. The app does not
              update itself: a newer version comes from the store, or as a newer file from the same place. On Android
              it is on{' '}
              <a href={PLAY_URL} target="_blank" rel="noopener noreferrer">Google Play</a>. The App Store listing is
              in preparation; until it is live,{' '}
              {apk ? 'the Android file here also runs the wallet, and iPhone builds are shared in the ' : 'iPhone builds are shared in the '}
              <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer">community channel</a>.
            </p>
            {apk && (
              <a href={apk} rel="noopener noreferrer" style={BUTTON}>
                Download QNet Wallet for Android (APK)
              </a>
            )}
            <p>
              An earlier Android build of QNet Wallet installed from a file is a separate, older app; its last update
              asks you to move. Install this one, restore the wallet in it with the recovery phrase — the funds are on
              the chain, not in the app — and remove the old app once the new one shows the wallet. The wallet&apos;s
              light node then runs in the new app after Use this device on its Node tab.
            </p>
          </div>

          <div className="tool-card-large" style={{ border: '1px solid rgba(0, 212, 255, 0.3)', marginBottom: '1.5rem', position: 'relative' }}>
            <h4>Browser extension — for desktop browsers</h4>
            <p>
              Create or import a wallet, send and receive QNC, SOL and 1DEV, follow your history. Keys are generated in the
              browser and stored encrypted; they never leave it. The Activate tab burns 1DEV on Solana for a light or a
              super node, one activation per wallet, issues the activation code and, for a light node, records it on the
              QNet network in the same approval; a light node then runs on a phone or tablet, a super node on a server. A
              site such as aiqnet.io can read the wallet&apos;s addresses only after you approve it in the extension.
            </p>
            <a href={EXTENSION_URL} target="_blank" rel="noopener noreferrer" style={BUTTON}>
              Install from the Chrome Web Store
            </a>
          </div>
        </div>

        <div className="tools-grid-large">
          <div className="tool-card-large">
            <h4>Post-quantum keys</h4>
            <p>
              Every QNet transaction is signed on the device with ML-DSA-65 (NIST FIPS 204); SOL and 1DEV transfers are
              signed with the wallet&apos;s Solana key, also on the device. Between nodes, the network&apos;s transport
              negotiates ML-KEM-768 hybrid key exchange over QUIC and TLS 1.3.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Your keys, your device</h4>
            <p>
              A recovery phrase, generated locally, is the only backup. The publisher has no servers that hold keys, no
              accounts and no way to recover a lost phrase.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Light node</h4>
            <p>
              A light node runs on one phone or tablet at a time; computers and emulators cannot run one. Linking it to a
              device includes a device check by the device&apos;s operating system. A few times per four-hour epoch the
              network asks the device for a status answer; the device signs it and answers while QNet Wallet runs on it,
              open, in the background or behind the lock screen.
              No hashing and no proof-of-work: each answer is one signature, so the device does no sustained work. For
              each epoch the chain records which nodes answered, and the protocol adds a share of that epoch&apos;s
              emission to their node balance — three quarters among light nodes, one quarter among super nodes. The
              wallet moves the node balance into itself with an ordinary transaction.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Activation</h4>
            <p>
              Nodes are activated at <a href="/node">aiqnet.io/node</a>. In Phase 1 a light node&apos;s 1DEV burn is made
              by the page from a one-time payment address in the browser, after QNet Wallet confirms the wallet, or by
              the QNet extension from its own address; a super node&apos;s burn only by the extension, and the super node
              runs on the user&apos;s own server with the QNet node software. The tokens are destroyed, and the burn
              transaction is the proof. QNet Wallet then confirms the light node of its own wallet on its own screen and
              runs it on that device. One node per wallet, light or super. The app burns nothing, sells nothing and shows
              no price. Phase 2 moves activation to QNC. The <a href="/docs">documentation</a> has the details.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>History that outlives pruning</h4>
            <p>
              Nodes keep about a day of transactions; the explorer keeps all of them. The wallet reads its QNet history
              from the explorer archive and the freshest blocks from the nodes, and every confirmed QNet transaction opens
              in the explorer. The app also lists the SOL and 1DEV sends made on that device, and says so above its
              History.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Eleven languages</h4>
            <p>
              English, Chinese, Russian, Spanish, Korean, Japanese, Portuguese, French, German, Arabic and Italian, with
              right-to-left layout where the language needs it.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Open source</h4>
            <p>
              The apps, the extension and the explorer are open source under Apache-2.0, and the node is source-available
              under the Business Source License 1.1 — all in one public repository:{' '}
              <a href="https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet" target="_blank" rel="noopener noreferrer">github.com/AIQnetLab/QNet-Blockchain</a>.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Policies and support</h4>
            <p>
              <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a> · <a href="/support">Support</a>.
              Published by Orrery Group LLC.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
