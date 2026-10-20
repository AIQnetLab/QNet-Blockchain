// The site's 404 page, in the document layout: the explorer's search in the title band (a mistyped hash or address is
// the usual reason) and the explorer itself, a page of the QNet app's view too (the header's wordmark already leads
// home). It brings no part of the shell with it and reads no wallet state: the root layout decides the shell by host.

import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import ExplorerSearch from '@/components/explorer/ExplorerSearch';

export default function NotFound() {
  return (
    <div className="pg">
      <PageHead title="This page does not exist" lead="The address may be mistyped, or the page has moved. Search the explorer for what you were looking for.">
        <ExplorerSearch />
      </PageHead>
      <div className="wrap pg-body">
        <Action href="/explorer">Open the explorer</Action>
      </div>
    </div>
  );
}
