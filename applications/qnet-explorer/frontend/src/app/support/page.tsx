'use client';

// Support page for QNet Wallet: how to reach a person, and the answers most questions come down to.

export default function SupportPage() {
  return (
    <div className="page-support">
      <section className="explorer-section" data-section="support">
        <div className="explorer-header">
          <h2 className="section-title">Support</h2>
          <p className="section-subtitle">
            QNet Wallet for iOS and Android, and the browser extension
          </p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>

          <div className="privacy-section">
            <h3>Contact</h3>
            <ul>
              <li>Email: <a href="mailto:support@aiqnet.io">support@aiqnet.io</a></li>
              <li>Bugs and feature requests: <a href="https://github.com/AIQnetLab/QNet-Blockchain/issues" target="_blank" rel="noopener noreferrer">GitHub issues</a></li>
              <li>Community: <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer">Telegram</a></li>
              <li>Documentation: <a href="/docs">aiqnet.io/docs</a></li>
            </ul>
            <p>
              Never send your seed phrase or private key to anyone, including anyone claiming to be support. Nobody who works
              on QNet will ever ask for it, and nobody can restore a wallet without it.
            </p>
          </div>

          <div className="privacy-section">
            <h3>I lost my seed phrase</h3>
            <p>
              There is no recovery. The wallet is non-custodial: the seed phrase exists only where you wrote it down. If it is
              gone, the wallet cannot be restored on a new device. While you still have access to the wallet, open Settings and
              export the phrase to a safe offline place.
            </p>
          </div>

          <div className="privacy-section">
            <h3>My transaction shows &quot;Awaiting confirmation&quot;</h3>
            <p>
              The network did not answer the wallet in time, so the outcome is not known yet. The wallet keeps asking the chain
              and updates the screen when it knows. A new send from the same wallet takes the place of an unconfirmed one: only
              one of the two can ever apply, so this can never charge you twice.
            </p>
          </div>

          <div className="privacy-section">
            <h3>My light node misses epochs</h3>
            <p>
              A light node answers status requests from the background — the app does not have to be open. What stops it is
              the phone&apos;s own power management:
            </p>
            <ul>
              <li>Do not swipe the app away from the recent-apps list. After a force close the system stops waking it: on iPhone until you open it again, on Android until you launch it manually.</li>
              <li>Android: remove the battery restriction — Settings → Apps → QNet Wallet → Battery → Unrestricted. On Xiaomi, Huawei, Oppo, Vivo and Samsung also enable autostart and take the app out of &quot;sleeping apps&quot;.</li>
              <li>iPhone: Settings → General → Background App Refresh — on, and on for QNet Wallet. Low Power Mode turns it off; the node is then proven only while the app is open.</li>
              <li>The phone has to be online at least sometimes. With no connection for a whole four-hour epoch there is nothing to prove the epoch with.</li>
              <li>Simplest of all: open the wallet every few hours. Opening it proves the current epoch by itself, even if the push never arrived.</li>
            </ul>
            <p>An ordinary sleeping phone is not a problem: the requests are high priority, and if the phone was offline the answer goes out as soon as it is back online.</p>
          </div>

          <div className="privacy-section">
            <h3>Where is my history</h3>
            <p>
              The wallet shows history from the aiqnet.io explorer archive together with the freshest data from the nodes. A
              row opens the transaction in the explorer; a pending row copies its hash instead. If a transfer is missing, open
              the address in the <a href="/explorer">explorer</a> — the chain is the record.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Legal</h3>
            <p>
              <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a>. Publisher: Orrery Group LLC, 30 N
              Gould St Ste R, Sheridan, WY 82801, United States.
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
