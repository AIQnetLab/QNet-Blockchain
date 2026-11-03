// The documentation is kept in the repository next to the code it describes; every row opens the current version of
// one document there. A server component: the list never changes in the browser.

import type { ReactNode } from 'react';
import PageHead from '@/components/ui/PageHead';
import { getI18n } from '@/i18n/server';
import type { MessageKey } from '@/lib/texts';

const DOCS = 'https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/docs';

const SECTIONS: { title: MessageKey; items: { key: MessageKey; what: MessageKey; path: string }[] }[] = [
  {
    title: 'docs_sec_architecture',
    items: [
      { key: 'docs_architecture_overview', what: 'docs_architecture_overview_what', path: 'architecture/overview.md' },
      { key: 'docs_architecture_consensus', what: 'docs_architecture_consensus_what', path: 'architecture/consensus.md' },
      { key: 'docs_architecture_cryptography', what: 'docs_architecture_cryptography_what', path: 'architecture/cryptography.md' },
      { key: 'docs_architecture_networking', what: 'docs_architecture_networking_what', path: 'architecture/networking.md' },
      { key: 'docs_architecture_state', what: 'docs_architecture_state_what', path: 'architecture/state.md' },
    ],
  },
  {
    title: 'docs_sec_developers',
    items: [
      { key: 'docs_developers_overview', what: 'docs_developers_overview_what', path: 'developers/overview.md' },
      { key: 'docs_developers_dapp_integration', what: 'docs_developers_dapp_integration_what', path: 'developers/dapp-integration.md' },
      { key: 'docs_developers_sign_in', what: 'docs_developers_sign_in_what', path: 'developers/sign-in.md' },
      { key: 'docs_developers_transactions', what: 'docs_developers_transactions_what', path: 'developers/transactions.md' },
      { key: 'docs_developers_smart_contracts', what: 'docs_developers_smart_contracts_what', path: 'developers/smart-contracts.md' },
      { key: 'docs_developers_sdk', what: 'docs_developers_sdk_what', path: 'developers/sdk.md' },
      { key: 'docs_developers_cli', what: 'docs_developers_cli_what', path: 'developers/cli.md' },
      { key: 'docs_developers_rpc_api', what: 'docs_developers_rpc_api_what', path: 'developers/rpc-api.md' },
      { key: 'docs_developers_security', what: 'docs_developers_security_what', path: 'developers/security.md' },
      { key: 'docs_developers_1dev_burn_contract', what: 'docs_developers_1dev_burn_contract_what', path: 'developers/1dev-burn-contract.md' },
      { key: 'docs_protocols_qnet_link_v1', what: 'docs_protocols_qnet_link_v1_what', path: 'protocols/qnet-link-v1.md' },
      { key: 'docs_protocols_light_node_messages', what: 'docs_protocols_light_node_messages_what', path: 'protocols/light-node-messages.md' },
    ],
  },
  {
    title: 'docs_sec_economics',
    items: [
      { key: 'docs_economics_overview', what: 'docs_economics_overview_what', path: 'economics/overview.md' },
      { key: 'docs_economics_node_activation', what: 'docs_economics_node_activation_what', path: 'economics/node-activation.md' },
      { key: 'docs_economics_tokenomics_1dev', what: 'docs_economics_tokenomics_1dev_what', path: 'economics/tokenomics-1dev.md' },
    ],
  },
  {
    title: 'docs_sec_operators',
    items: [
      { key: 'docs_operators_running_a_node', what: 'docs_operators_running_a_node_what', path: 'operators/running-a-node.md' },
      { key: 'docs_operators_configuration', what: 'docs_operators_configuration_what', path: 'operators/configuration.md' },
      { key: 'docs_operators_maintenance', what: 'docs_operators_maintenance_what', path: 'operators/maintenance.md' },
    ],
  },
  {
    title: 'docs_sec_applications',
    items: [
      { key: 'docs_applications_mobile_wallet', what: 'docs_applications_mobile_wallet_what', path: 'applications/mobile-wallet.md' },
      { key: 'docs_applications_browser_wallet', what: 'docs_applications_browser_wallet_what', path: 'applications/browser-wallet.md' },
      { key: 'docs_applications_explorer', what: 'docs_applications_explorer_what', path: 'applications/explorer.md' },
      { key: 'docs_applications_cli', what: 'docs_applications_cli_what', path: 'applications/cli.md' },
    ],
  },
];

const WHITEPAPER = 'https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/QNet_Whitepaper.md';

function DocRow({ href, name, what }: { href: string; name: ReactNode; what: ReactNode }) {
  return (
    <li>
      <a className="rowlink" href={href} target="_blank" rel="noopener noreferrer">
        <span className="rowlink-n">{name}</span>
        <span className="rowlink-d">{what}</span>
      </a>
    </li>
  );
}

export default async function DocsPage() {
  const { t, say } = await getI18n();
  return (
    <div className="pg">
      <PageHead title={t('docs_title')} lead={t('docs_lead')} />
      <div className="wrap pg-body">
        {SECTIONS.map((s) => (
          <section key={s.title} className="doc-sec">
            <h2>{say(s.title)}</h2>
            <ul className="rowlinks">
              {s.items.map((d) => <DocRow key={d.path} href={`${DOCS}/${d.path}`} name={say(d.key)} what={say(d.what)} />)}
            </ul>
          </section>
        ))}
        <section className="doc-sec">
          <h2>{t('docs_whitepaper')}</h2>
          <ul className="rowlinks">
            <DocRow href={WHITEPAPER} name="QNet_Whitepaper.md" what={t('docs_whitepaper_what')} />
          </ul>
        </section>
      </div>
    </div>
  );
}
