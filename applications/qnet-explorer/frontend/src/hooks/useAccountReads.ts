'use client';

// The reads of a wallet's node that the header's account menu and My node's sections show (src/lib/account-menu.ts): the
// network's listing, the light node's status, the super node's status and the newest epochs. They are the shared reads My
// node makes (useNodeStatus.ts), so none is asked twice; with `wallet` null nothing is asked and nothing polls. `view`: an
// address only viewed, read without the device's details, as My node reads it.

import { useNodeHistory, useNodeStatus, useSuperStatus, useWalletNode } from '@/hooks/useNodeStatus';
import type { AccountReads } from '@/lib/account-menu';
import { lightNodeId, superNodeId } from '@/lib/qnet-link';

export function useAccountReads(wallet: string | null, view = false): AccountReads {
  const network = useWalletNode(wallet);
  const listed = network.state.phase === 'ok' && network.state.value.state === 'registered' ? network.state.value : null;
  const light = useNodeStatus(wallet ? lightNodeId(wallet) : null, view);
  const superId = wallet ? (listed?.nodeType === 'super' ? listed.nodeId : superNodeId(wallet)) : null;
  const superRead = useSuperStatus(superId);
  const lightListed = light.state.phase === 'ok' && light.state.value.registered;
  const superListed = superRead.state.phase === 'ok' && superRead.state.value.registered;
  const history = useNodeHistory(wallet && lightListed ? lightNodeId(wallet) : superListed ? superId : null, view);
  return { network: network.state, light: light.state, superNode: superRead.state, history: history.state };
}
