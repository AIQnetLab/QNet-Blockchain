'use client';

// Terms of use for QNet Wallet and aiqnet.io. Plain statements of what the software is and is not:
// non-custodial, experimental, and run by a network the publisher does not control. The QNet app links it,
// so it states what activation is without pointing the reader to a page that performs it: the places that
// activate are named only outside the app's view. "Device rules" covers the device check of a light node
// (docs/protocols/light-node-messages.md sections 1, 5 and 8: no operating-system minimum, only the hardware's proof).

import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { keepFromApp } from '@/lib/activate-view';

export default function TermsPage() {
  const full = useActivationContent();
  const { fromApp } = useWallet();
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
              <li>An optional light node on a phone or tablet: the device answers signed status requests from the QNet network, and the wallet can move the node balance the network protocol assigns to the node into the wallet.</li>
              <li>Free software with public source: the apps are open source under Apache-2.0, and the node is source-available under the Business Source License 1.1. You may read the source and build it yourself.</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Your recovery phrase</h3>
            <p>
              The recovery phrase is the only way to restore a wallet. It is never transmitted anywhere. If you lose it, or
              someone else obtains it, your funds are lost or taken and nobody can help — not the publisher, not the network.
              Keeping it safe is entirely your responsibility.
            </p>
          </div>

          <div className="privacy-section">
            <h3>The network is experimental</h3>
            <p>
              QNet is an experimental network at the testnet stage. Its rules can change, it can halt, and it can be restarted
              from a new genesis. Tokens on it may have no monetary value, and no value is promised or implied. A node
              balance is emission decided by the network protocol from what is recorded on chain; it is not a payment or a
              promise by Orrery Group LLC, and its existence, amount and value are not guaranteed.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Node activation</h3>
            <p>
              Activating a node is an on-chain action you start yourself
              {full && ' on aiqnet.io/node or in the QNet browser extension'}{!full && ' outside the mobile app'}. In Phase 1 it
              burns 1DEV tokens on the Solana blockchain, from a one-time payment address the web page makes in your
              browser or from the extension&apos;s own address; burned tokens are destroyed and go to no one, including
              Orrery Group LLC. The action is irreversible. One light node per wallet. The mobile app burns nothing, sells
              nothing and uses no activation codes: for a node it signs only a request that you confirm on its own
              screen, to register its own wallet&apos;s light node and run it on that device, or to move the node balance
              into the wallet; its SOL and 1DEV sends are ordinary transfers that you review and confirm, to an address
              you choose. Whether a node is counted in an epoch depends on the device answering the network&apos;s requests,
              which in turn depends on your device, its settings and its connectivity.
            </p>
          </div>

          <div className="privacy-section" id="device-rules">
            <h3>Device rules</h3>
            <p>
              A light node runs on one phone or tablet at a time, and one device runs one node. Linking a node to a device
              includes a device check by the device&apos;s operating system. Computers, emulators, modified devices and
              devices whose security hardware cannot prove the device cannot run a node; on such a device the wallet
              works as before. If the network sees signs that one device
              ran two nodes at the same time, the node on that device can be paused for up to 30 days; the wallet and the
              balance already assigned to the node are not affected, and the balance can still be moved into the wallet.
              The node can run on another phone or tablet at any time
              (see <a href={`${keepFromApp('/support', fromApp)}#device-check`}>Support</a>). Whether a device can run a
              node may change when Apple, Google or the network change their
              checks.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your responsibilities</h3>
            <ul>
              <li>You must be at least 18 years old to use the software.</li>
              <li>Use the software only where and how it is lawful for you, and comply with the laws that apply to you, including tax law.</li>
              <li>Keep your device, password and recovery phrase secure.</li>
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
              Firebase Cloud Messaging for push delivery, Apple&apos;s App Attest and DeviceCheck and Google&apos;s key
              attestation and Play Integrity for a node&apos;s device check, GitHub for the token logos of the mobile
              app&apos;s Solana tab, the web servers that token creators name for their tokens&apos; logos (the aiqnet.io
              server fetches those logos itself), and the app stores that distribute it. Those services are governed by
              their own terms, and their availability is not something Orrery Group LLC controls. Apple and Google are not
              parties to these terms and have no obligation to provide support for the software.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Warranty and liability</h3>
            <p>
              The software and the website are provided as is, without warranty of any kind, express or implied, including
              merchantability, fitness for a particular purpose and non-infringement. To the fullest extent permitted by law,
              Orrery Group LLC and its members are not liable for any loss — of funds, tokens, node balances, data, profit or
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
              Privacy is covered separately in the <a href={keepFromApp('/privacy', fromApp)}>Privacy Policy</a>.
            </p>
          </div>

          <div className="privacy-section" style={{
            textAlign: 'center',
            marginTop: '3rem',
            paddingTop: '2rem',
            borderTop: '1px solid rgba(0, 255, 136, 0.2)'
          }}>
            <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>
              Effective: September 29, 2026
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}
