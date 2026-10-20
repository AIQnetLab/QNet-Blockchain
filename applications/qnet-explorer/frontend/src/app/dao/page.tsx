// The DAO page says what exists: no governance runs on QNet Blockchain yet, so there are no proposals to list and no
// votes to take (the vote route refuses every vote unless DAO_ENABLED is set). Protocol changes ship as node releases
// whose activation heights live in the node software. A server component: nothing on it changes in the browser.

import Link from 'next/link';
import PageHead from '@/components/ui/PageHead';

const REPO = 'https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet';

export default function DaoPage() {
  return (
    <div className="pg">
      <PageHead
        title="QNet Blockchain DAO"
        lead="No governance runs on QNet Blockchain yet, so this page lists no proposals and takes no votes."
      />
      <div className="wrap pg-body">
        <section className="doc-sec" id="changes">
          <h2>How the protocol changes today</h2>
          <div className="prose">
            <p>
              A change to the protocol ships in a release of the node software, with the block height at which it takes
              effect written into it. Every node that runs the release applies the change at that height, so no vote on
              chain is needed to agree on it.
            </p>
            <p>
              The <a href={`${REPO}/docs/operators/maintenance.md#upgrading-a-node`} target="_blank" rel="noopener noreferrer">maintenance
              guide</a> describes how a node takes a new release; the <Link href="/docs">documentation</Link> has the rest.
            </p>
          </div>
        </section>
        <section className="doc-sec" id="design">
          <h2>Design material</h2>
          <div className="prose">
            <p>
              The draft of the governance contract and its proposal tooling are kept in the repository&apos;s{' '}
              <a href={`${REPO}/governance`} target="_blank" rel="noopener noreferrer">governance folder</a>. None of it is
              deployed on QNet Blockchain.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
