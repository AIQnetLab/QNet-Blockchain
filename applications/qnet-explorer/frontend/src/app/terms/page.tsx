'use client';

// Terms of use for QNet Wallet and aiqnet.io. Plain statements of what the software is and is not:
// non-custodial, experimental, and run by a network the publisher does not control. The QNet app links it,
// so it states what activation is without pointing the reader to a page that performs it: the places that
// activate are named only outside the app's view. "Device rules" covers the device check of a light node
// (docs/protocols/light-node-messages.md sections 1, 5 and 8: no operating-system minimum, only the hardware's proof).

import Link from 'next/link';
import DocToc, { type TocItem } from '@/components/DocToc';
import PageHead from '@/components/ui/PageHead';
import { useActivationContent } from '@/contexts/AppContext';

export default function TermsPage() {
  const full = useActivationContent();
  return (
    <div className="pg">
      <PageHead title="Terms of Use" lead="QNet Wallet for iOS and Android, the QNet Wallet browser extension, and aiqnet.io" />
      <div className="wrap pg-body doc-grid">
        <div className="doc-main">

          <section className="doc-sec prose" id="publisher">
            <h2>Who you are dealing with</h2>
            <p>
              QNet Wallet and aiqnet.io are published by Orrery Group LLC, 30 N Gould St Ste R, Sheridan, WY 82801, United
              States. By installing or using the software you accept these terms. If you do not accept them, do not use it.
            </p>
          </section>

          <section className="doc-sec prose" id="software">
            <h2>What the software is</h2>
            <ul>
              <li>A non-custodial wallet: keys are generated and held on your device. Orrery Group LLC never holds, moves or has access to your funds and cannot reverse, cancel or recover a transaction.</li>
              <li>An optional light node on a phone or tablet: the device answers signed status requests from the nodes of QNet Blockchain, and the wallet can move the node balance the protocol assigns to the node into the wallet.</li>
              <li>Free software with public source: the apps are open source under Apache-2.0, and the node is source-available under the Business Source License 1.1. You may read the source and build it yourself.</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="recovery-phrase">
            <h2>Your recovery phrase</h2>
            <p>
              The recovery phrase is the only way to restore a wallet. It is never transmitted anywhere. If you lose it, or
              someone else obtains it, your funds are lost or taken and nobody can help — not the publisher, not QNet Blockchain.
              Keeping it safe is entirely your responsibility.
            </p>
          </section>

          <section className="doc-sec prose" id="experimental">
            <h2>QNet Blockchain is experimental</h2>
            <p>
              QNet Blockchain is an experimental network at the testnet stage. Its rules can change, it can halt, and it can be restarted
              from a new genesis. Tokens on it may have no monetary value, and no value is promised or implied. A node
              balance is emission decided by the network protocol from what is recorded on chain; it is not a payment or a
              promise by Orrery Group LLC, and its existence, amount and value are not guaranteed.
            </p>
          </section>

          <section className="doc-sec prose" id="activation">
            <h2>Node activation</h2>
            <p>
              Activating a node is an on-chain action you start yourself
              {full && <> on <Link href="/node">aiqnet.io/node</Link> or in the QNet Wallet browser extension</>}{!full && ' outside the mobile app'}. In Phase 1 it
              burns 1DEV tokens on the Solana blockchain, from a one-time payment address the web page makes in your
              browser or from the extension&apos;s own address; burned tokens are destroyed and go to no one, including
              Orrery Group LLC. The action is irreversible. One light node per wallet. The mobile app burns nothing, sells
              nothing and uses no activation codes: for a node it signs only a request that you confirm on its own
              screen, to register its own wallet&apos;s light node and run it on that device, or to move the node balance
              into the wallet; its SOL and 1DEV sends are ordinary transfers that you review and confirm, to an address
              you choose. Whether a node is counted in an epoch depends on the device answering the requests of QNet Blockchain,
              which in turn depends on your device, its settings and its connectivity.
            </p>
          </section>

          <section className="doc-sec prose" id="device-rules">
            <h2>Device rules</h2>
            <p>
              A light node runs on one phone or tablet at a time, and one device runs one node. Linking a node to a device
              includes a device check by the device&apos;s operating system. Computers, emulators, modified devices and
              devices whose security hardware cannot prove the device cannot run a node; on such a device the wallet
              works as before. If QNet Blockchain sees signs that one device
              ran two nodes at the same time, the node on that device can be paused for up to 30 days; the wallet and the
              balance already assigned to the node are not affected, and the balance can still be moved into the wallet.
              The node can run on another phone or tablet at any time
              (see <Link href="/support#device-check">Support</Link>). Whether a device can run a
              node may change when Apple, Google or the network change their
              checks.
            </p>
          </section>

          <section className="doc-sec prose" id="responsibilities">
            <h2>Your responsibilities</h2>
            <ul>
              <li>You must be at least 18 years old to use the software.</li>
              <li>Use the software only where and how it is lawful for you, and comply with the laws that apply to you, including tax law.</li>
              <li>Keep your device, password and recovery phrase secure.</li>
              <li>Do not use the software to attack, overload or defraud QNet Blockchain or other users, or to break any law.</li>
              <li>Verify addresses and amounts before signing. A signed transaction cannot be taken back.</li>
            </ul>
          </section>

          <section className="doc-sec prose" id="no-advice">
            <h2>No advice, no fiduciary relationship</h2>
            <p>
              Nothing in the software, on this website or in any community channel is financial, investment, legal or tax
              advice. Orrery Group LLC is not your broker, adviser, custodian or fiduciary.
            </p>
          </section>

          <section className="doc-sec prose" id="third-party">
            <h2>Third-party services</h2>
            <p>
              The software relies on services run by others: the nodes of QNet Blockchain, public Solana RPC endpoints, Google
              Firebase Cloud Messaging for push delivery, Apple&apos;s App Attest and DeviceCheck and Google&apos;s key
              attestation and Play Integrity for a node&apos;s device check, GitHub for the token logos of the mobile
              app&apos;s Solana tab, the web servers that token creators name for their tokens&apos; logos (the aiqnet.io
              server fetches those logos itself), and the app stores that distribute it. Those services are governed by
              their own terms, and their availability is not something Orrery Group LLC controls. Apple and Google are not
              parties to these terms and have no obligation to provide support for the software.
            </p>
          </section>

          <section className="doc-sec prose" id="liability">
            <h2>Warranty and liability</h2>
            <p>
              The software and the website are provided as is, without warranty of any kind, express or implied, including
              merchantability, fitness for a particular purpose and non-infringement. To the fullest extent permitted by law,
              Orrery Group LLC and its members are not liable for any loss — of funds, tokens, node balances, data, profit or
              otherwise — arising from the software, QNet Blockchain, third-party services or your use of them. Where liability
              cannot be excluded, it is limited to the amount you paid for the software, which is nothing.
            </p>
          </section>

          <section className="doc-sec prose" id="law">
            <h2>Governing law</h2>
            <p>
              These terms are governed by the laws of the State of Wyoming, United States, without regard to conflict-of-law
              rules. Disputes are resolved in the state or federal courts located in Wyoming, unless the law where you live
              gives you a right that cannot be waived.
            </p>
          </section>

          <section className="doc-sec prose" id="changes">
            <h2>Changes and contact</h2>
            <p>
              These terms change when the software or QNet Blockchain changes in a way that matters to them; the current version
              is the one published here, with its date. Questions: <a href="mailto:support@aiqnet.io">support@aiqnet.io</a>.
              Privacy is covered separately in the <Link href="/privacy">Privacy Policy</Link>.
            </p>
          </section>

          <p className="doc-date">Effective: September 29, 2026</p>

        </div>
        <DocToc items={TOC} />
      </div>
    </div>
  );
}

// The sections, in the order the page shows them (src/lib/__tests__/site-pages.test.mjs checks they match).
const TOC: readonly TocItem[] = [
  ['publisher', 'Who you are dealing with'],
  ['software', 'What the software is'],
  ['recovery-phrase', 'Your recovery phrase'],
  ['experimental', 'QNet Blockchain is experimental'],
  ['activation', 'Node activation'],
  ['device-rules', 'Device rules'],
  ['responsibilities', 'Your responsibilities'],
  ['no-advice', 'No advice, no fiduciary relationship'],
  ['third-party', 'Third-party services'],
  ['liability', 'Warranty and liability'],
  ['law', 'Governing law'],
  ['changes', 'Changes and contact'],
];
