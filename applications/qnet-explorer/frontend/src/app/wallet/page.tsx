'use client';

// The wallet page says what exists today, per platform, and links the policies. Metrics that nobody can
// verify and statuses that are not true yet do not belong here.

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/qnet-wallet/pahnggomgmhhjjncgfnmmofmplfhkncg';

export default function WalletPage() {
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
            <h4>Browser extension — Chrome, Edge, Brave</h4>
            <p>
              Create or import a wallet, send and receive QNC, follow your history. Keys are generated in the browser and
              stored encrypted; they never leave it.
            </p>
            <a
              href={EXTENSION_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', marginTop: '0.75rem', padding: '8px 16px', border: '1px solid #00d4ff', borderRadius: '6px', color: '#00d4ff' }}
            >
              Install from the Chrome Web Store
            </a>
          </div>

          <div className="tool-card-large" style={{ border: '1px solid rgba(0, 212, 255, 0.3)', marginBottom: '1.5rem', position: 'relative' }}>
            <h4>Android</h4>
            <p>
              Wallet and light node in one app: Android Keystore for keys, biometric unlock, background answers to the
              network&apos;s status requests. The Google Play listing is in preparation; until it is live, builds are shared in the{' '}
              <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer">community channel</a>.
            </p>
          </div>

          <div className="tool-card-large" style={{ border: '1px solid rgba(0, 212, 255, 0.3)', marginBottom: '1.5rem', position: 'relative' }}>
            <h4>iOS</h4>
            <p>
              The same app for iPhone: Keychain for keys, Face ID or Touch ID, silent push wake-ups for status requests.
              The App Store listing is in preparation.
            </p>
          </div>
        </div>

        <div className="tools-grid-large">
          <div className="tool-card-large">
            <h4>Post-quantum keys</h4>
            <p>
              Every transaction is signed on the device with ML-DSA-65 (NIST FIPS 204). Between nodes, the network&apos;s
              transport negotiates ML-KEM-768 hybrid key exchange over QUIC and TLS 1.3.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Your keys, your device</h4>
            <p>
              A BIP39 seed phrase, generated locally, is the only backup. The publisher has no servers that hold keys, no
              accounts and no way to recover a lost phrase.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Light node</h4>
            <p>
              A few times per four-hour epoch the network sends the phone a status request; the phone signs it and answers.
              Between requests the app only wakes now and then to send one signed attestation per epoch; nothing is computed. Each epoch&apos;s answers are recorded on
              chain, and the emission for that epoch is shared by the nodes that answered: three quarters among light nodes,
              one quarter among super nodes. Rewards are claimed from the app as an ordinary transaction.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>Activation</h4>
            <p>
              Phase 1: a node is activated by burning 1DEV on Solana from the app; the tokens are destroyed, and the burn
              transaction is the proof. The Google Play version does not start an activation; it recovers and runs one the
              wallet already holds. Phase 2 moves activation to QNC. The <a href="/docs">documentation</a> has the details.
            </p>
          </div>

          <div className="tool-card-large">
            <h4>History that outlives pruning</h4>
            <p>
              Nodes keep about a day of transactions; the explorer keeps all of them. The wallet reads its history from the
              explorer archive and the freshest blocks from the nodes, and every entry opens in the explorer.
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
