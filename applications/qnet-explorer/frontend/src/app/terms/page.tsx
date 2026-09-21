'use client';

// Terms of use for QNet Wallet and aiqnet.io. Plain statements of what the software is and is not:
// non-custodial, experimental, and run by a network the publisher does not control.

export default function TermsPage() {
  return (
    <div className="page-terms">
      <section className="explorer-section" data-section="terms">
        <div className="explorer-header">
          <h2 className="section-title">Terms of Use</h2>
          <p className="section-subtitle">
            QNet Wallet for iOS and Android, the QNet Wallet browser extension, and aiqnet.io
          </p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>

          <div className="privacy-section">
            <h3>Who you are dealing with</h3>
            <p>
              QNet Wallet and aiqnet.io are published by Orrery Group LLC, 30 N Gould St Ste R, Sheridan, WY 82801, United
              States. By installing or using the software you accept these terms. If you do not accept them, do not use it.
            </p>
          </div>

          <div className="privacy-section">
            <h3>What the software is</h3>
            <ul>
              <li>A non-custodial wallet: keys are generated and held on your device. Orrery Group LLC never holds, moves or has access to your funds and cannot reverse, cancel or recover a transaction.</li>
              <li>An optional light node: your device answers signed status requests from the QNet network and can claim the rewards the network protocol assigns to it.</li>
              <li>Free, open-source software under the MIT license. The source is public and you may build it yourself.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Your seed phrase</h3>
            <p>
              The seed phrase is the only way to restore a wallet. It is never transmitted anywhere. If you lose it, or
              someone else obtains it, your funds are lost or taken and nobody can help — not the publisher, not the network.
              Keeping it safe is entirely your responsibility.
            </p>
          </div>

          <div className="privacy-section">
            <h3>The network is experimental</h3>
            <p>
              QNet is an experimental network at the testnet stage. Its rules can change, it can halt, and it can be restarted
              from a new genesis. Tokens on it may have no monetary value, and no value is promised or implied. Node rewards
              are emission decided by the network protocol from what is recorded on chain; they are not a payment or a promise
              by Orrery Group LLC, and their existence, amount and value are not guaranteed.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Node activation</h3>
            <p>
              Activating a node is an on-chain action you initiate and sign yourself. In Phase 1 it burns 1DEV tokens on the
              Solana blockchain; burned tokens are destroyed and go to no one, including Orrery Group LLC. The action is
              irreversible. Whether a node stays eligible depends on the device answering the network&apos;s requests, which in
              turn depends on your device, its settings and its connectivity.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your responsibilities</h3>
            <ul>
              <li>Use the software only where and how it is lawful for you, and comply with the laws that apply to you, including tax law.</li>
              <li>Keep your device, password and seed phrase secure.</li>
              <li>Do not use the software to attack, overload or defraud the network or other users, or to break any law.</li>
              <li>Verify addresses and amounts before signing. A signed transaction cannot be taken back.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>No advice, no fiduciary relationship</h3>
            <p>
              Nothing in the software, on this website or in any community channel is financial, investment, legal or tax
              advice. Orrery Group LLC is not your broker, adviser, custodian or fiduciary.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Third-party services</h3>
            <p>
              The software relies on services run by others: the QNet network nodes, public Solana RPC endpoints, Google
              Firebase Cloud Messaging for push delivery, and the app stores that distribute it. Those services are governed by
              their own terms, and their availability is not something Orrery Group LLC controls. Apple and Google are not
              parties to these terms and have no obligation to provide support for the software.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Warranty and liability</h3>
            <p>
              The software and the website are provided as is, without warranty of any kind, express or implied, including
              merchantability, fitness for a particular purpose and non-infringement. To the fullest extent permitted by law,
              Orrery Group LLC and its members are not liable for any loss — of funds, tokens, rewards, data, profit or
              otherwise — arising from the software, the network, third-party services or your use of them. Where liability
              cannot be excluded, it is limited to the amount you paid for the software, which is nothing.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Governing law</h3>
            <p>
              These terms are governed by the laws of the State of Wyoming, United States, without regard to conflict-of-law
              rules. Disputes are resolved in the state or federal courts located in Wyoming, unless the law where you live
              gives you a right that cannot be waived.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Changes and contact</h3>
            <p>
              These terms change when the software or the network changes in a way that matters to them; the current version
              is the one published here, with its date. Questions: <a href="mailto:support@aiqnet.io">support@aiqnet.io</a>.
              Privacy is covered separately in the <a href="/privacy">Privacy Policy</a>.
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
