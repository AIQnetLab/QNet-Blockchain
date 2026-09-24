'use client';

// The one privacy policy for QNet Wallet on every platform and for this website. It describes what the
// software actually does with data — nothing more, nothing less — so a reader can check every sentence
// against the open-source code.

export default function PrivacyPage() {
  return (
    <div className="page-privacy">
      <section className="explorer-section" data-section="privacy">
        <div className="explorer-header">
          <h2 className="section-title">Privacy Policy</h2>
          <p className="section-subtitle">
            QNet Wallet for iOS and Android, the QNet Wallet browser extension, and aiqnet.io
          </p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>

          <div className="privacy-section">
            <h3>Who is responsible</h3>
            <p>
              Orrery Group LLC, 30 N Gould St Ste R, Sheridan, WY 82801, United States, publishes QNet Wallet and
              operates this website. Questions about this policy go to <a href="mailto:support@aiqnet.io">support@aiqnet.io</a>.
            </p>
          </div>

          <div className="privacy-section">
            <h3>In short</h3>
            <ul>
              <li>The wallet is non-custodial. Your seed phrase and private keys are created on your device and never leave it.</li>
              <li>There is no account, no sign-up, no analytics, no advertising SDK and no tracking of any kind.</li>
              <li>Transactions you sign are public on the blockchain, as on every public chain.</li>
              <li>If you run a light node, the network needs a way to reach your phone: a push token, your node identity and the details below are registered with the network nodes. That registration is the only data the software stores anywhere other than your device and the public blockchain.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>What stays on your device</h3>
            <p>
              Seed phrase, private keys, the node signing key, node activation codes, language and display settings.
              They are encrypted at rest and protected by the operating system keystore (Android Keystore, iOS Keychain)
              and by your password or biometrics. Deleting the wallet in the app, or uninstalling it, removes them.
              Nobody, including Orrery Group LLC, can recover a lost seed phrase.
            </p>
          </div>

          <div className="privacy-section">
            <h3>What is sent to the network, and why</h3>
            <ul>
              <li>
                <strong>Transactions.</strong> A transfer, a token call, a reward claim or a node registration you sign is broadcast to
                network nodes and recorded on the public blockchain permanently. A blockchain address is pseudonymous; it is
                not linked to your name by the software.
              </li>
              <li>
                <strong>Public reads.</strong> To show balances and history the app asks network nodes and the aiqnet.io explorer
                about your addresses, automatically while it is open. Like any web server, those services see the requesting IP
                address and the request in ordinary technical logs kept for a short time for operation and abuse prevention. They
                are not used to profile you. For dollar values the app also fetches SOL and 1DEV prices from CoinGecko, and the
                Solana tab loads token logos from GitHub; those requests carry no address, but the services see your IP address.
              </li>
              <li>
                <strong>Light node.</strong> When you activate a light node, the app registers with the network&apos;s genesis nodes
                the node identity, the wallet address that receives its rewards, the activation transaction, a random device
                identifier the app generates, the node&apos;s signing keys (public part) and a push channel: a Firebase Cloud
                Messaging token on Android and iOS, or a UnifiedPush endpoint. The nodes store that token, copy it to each other,
                and use it for one purpose — sending the periodic status request the node answers. Answers are recorded on chain as per-epoch eligibility
                bitmaps, by node index, and are the basis of rewards.
              </li>
              <li>
                <strong>Solana.</strong> The app reads the SOL and 1DEV balances of your Solana address, and looks for a node
                activation made from it, through public Solana RPC endpoints. It does so automatically while it is open, so those
                endpoints see your IP address and your Solana address under their own terms. Activating a node in Phase 1 burns
                1DEV tokens on the Solana blockchain, and that transaction is public on Solana; a node registration links the Solana
                address that made the burn to your QNet address on chain. The Google Play version of the app does not start an
                activation.
              </li>
              <li>
                <strong>Push delivery.</strong> Status requests reach your phone through Google Firebase Cloud Messaging. When the app
                starts, Firebase issues it an installation identifier and a push token, whether or not a node is active. The
                message carries a challenge string and a node identifier, no personal data. Google processes the delivery under
                its own terms.
              </li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Device permissions</h3>
            <p>
              Biometrics: unlocking the wallet. Push messages: the status requests a light node answers arrive as silent data
              messages, and the app shows no notifications for them. Background execution: answering them while the app is not
              open. No camera, photos, location, contacts, microphone or file access.
            </p>
          </div>

          <div className="privacy-section">
            <h3>This website</h3>
            <p>
              aiqnet.io shows public blockchain data. It sets no tracking cookies and runs no analytics or advertising scripts.
              The web server keeps ordinary access logs (IP address, requested page, time) for a short time.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Retention</h3>
            <ul>
              <li>Data on your device: until you delete the wallet or the app.</li>
              <li>Push token and node registration on network nodes: kept, as there is no way yet to remove a registration; a replaced token supersedes the old one, and a token that no longer accepts deliveries — for example after the app is uninstalled — stops being used.</li>
              <li>Blockchain records: permanent by design and outside anyone&apos;s control, including ours.</li>
              <li>Server access logs: a short, fixed period.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Sharing and selling</h3>
            <p>
              No data is sold, rented or shared for advertising. The only third parties that process data are the ones named
              above — push delivery (Google Firebase Cloud Messaging), public Solana RPC endpoints, CoinGecko and GitHub for token
              prices and logos, and the app stores that distribute the software — each for the single purpose described.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your rights</h3>
            <p>
              Under the GDPR, the CCPA and similar laws you can ask what is held about you, ask for it to be corrected or
              deleted, and object to processing. For everything on your device you already have full control. For the push
              token and node registration held by network nodes, write to <a href="mailto:support@aiqnet.io">support@aiqnet.io</a>
              with your node identifier; the software cannot yet delete a registration, so the answer will say what is held and
              that it stays until that becomes possible. Records on a public blockchain cannot be altered or deleted by anyone.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Children</h3>
            <p>The software is not directed at anyone under 18, and no data is knowingly collected from children.</p>
          </div>

          <div className="privacy-section">
            <h3>Security</h3>
            <p>
              Keys live in operating-system-backed secure storage and never leave the device. Transactions are authorised by
              ML-DSA-65 signatures made on the device; a connection to a node carries only public chain data and already-signed
              transactions, so the signature, not the connection, is what protects funds. Connections to aiqnet.io use HTTPS.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Changes</h3>
            <p>
              This policy changes when the software changes what it does with data. The date below is the date of the current
              version; the history is in the public repository.
            </p>
          </div>

          <div className="privacy-section" style={{
            textAlign: 'center',
            marginTop: '3rem',
            paddingTop: '2rem',
            borderTop: '1px solid rgba(0, 255, 136, 0.2)'
          }}>
            <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>
              Effective: September 21, 2026
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
