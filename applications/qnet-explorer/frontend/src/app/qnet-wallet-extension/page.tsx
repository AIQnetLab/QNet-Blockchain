// The browser extension's page: what it does, where it installs from and the steps after. The provider sends a browser
// without a usable extension here (src/lib/qnet-provider.ts). A server component: nothing on it changes in the browser.

import Link from 'next/link';
import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import Section from '@/components/ui/Section';
import { EXTENSION_STORE_URL } from '@/lib/qnet-provider';

// The manifest's minimum_chrome_version (applications/qnet-wallet/dist/manifest.json).
const MIN_BROWSER_VERSION = 111;

const STEPS: [string, string][] = [
  ['Open the listing', 'Install from the Chrome Web Store above opens the QNet Wallet listing in a new tab.'],
  ['Add it to the browser', 'Add the extension from the listing and confirm in the browser’s window.'],
  ['Pin it to the toolbar', 'Pin QNet Wallet so its window is one click away.'],
  ['Create or import a wallet', 'Create a new wallet, or import one with its recovery phrase.'],
];

export default function QNetWalletExtensionPage() {
  return (
    <div className="pg">
      <PageHead
        title="QNet Wallet extension"
        lead="The browser wallet for QNet Blockchain: hold and send QNC, SOL and 1DEV, with keys that never leave your browser."
      >
        <div className="pg-act desk-only" data-field-clear>
          <Action kind="solid" href={EXTENSION_STORE_URL} external>Install from the Chrome Web Store</Action>
          <p className="note">For browsers that install extensions from the Chrome Web Store, version {MIN_BROWSER_VERSION} or later.</p>
        </div>
        <p className="body phone-only" data-field-dim="0.1">
          The extension runs in a computer&apos;s browser. On a phone or tablet, <Link href="/wallet#get">install the QNet Wallet app</Link>.
        </p>
      </PageHead>

      <Section id="what" title="What it does" variant="tool" className="topics">
        <div className="spec">
          <h3 className="h3">Secure storage</h3>
          <div className="body">
            <p>Your private keys are encrypted and stored locally. Only you have access to your funds.</p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">Verified balances</h3>
          <div className="body">
            <p>
              A balance counts as verified only when the node&apos;s account proof folds to a state root that the validator
              committee of QNet Blockchain signed, which the extension checks itself.
            </p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">Site connection</h3>
          <div className="body">
            <p>
              Sites can ask the extension to connect and to sign; every request is shown to you first, with the requesting
              site, and the key stays where it is. Approved sites can be removed in the settings.
            </p>
          </div>
        </div>
        <div className="spec">
          <h3 className="h3">Node activation</h3>
          <div className="body">
            <p>
              Its Activate tab, or <Link href="/node">aiqnet.io/node</Link>, burns 1DEV on Solana and issues the activation code of the wallet&apos;s
              one node: a light node, which it also records on QNet Blockchain, or a super node, which only the extension
              activates and which runs on your own server. It recovers the code of an earlier burn, and its &quot;Record on QNet
              Blockchain&quot; button records an earlier burn&apos;s light node.
            </p>
          </div>
        </div>
      </Section>

      <Section id="install" title="Installation" variant="tool">
        {/* The site's numbered steps (styles/cabinet.css, the activation's too): the order is the information. */}
        <ol className="cab-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="cab-step">
              <span className="cab-step-n" aria-hidden="true">{i + 1}</span>
              <div className="cab-step-body">
                <h3 className="cab-step-t">{title}</h3>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="requirements" title="System requirements" variant="tool">
        <dl className="kv">
          <div>
            <dt>Browser</dt>
            <dd>One that installs extensions from the Chrome Web Store, version {MIN_BROWSER_VERSION} or later</dd>
          </div>
          <div>
            <dt>Device</dt>
            <dd>A computer; phones and tablets use the QNet Wallet app</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}
