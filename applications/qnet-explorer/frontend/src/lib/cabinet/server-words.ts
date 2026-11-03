// The words My node names a wallet's server node with: a super node's, and a genesis node's for one of the network's
// genesis nodes (qnet-link.ts isGenesisNodeId). The header's account menu names it with its own words
// (account-menu.ts nodeLines), so these reach only My node's pages.

import { isGenesisNodeId } from '../qnet-link.ts';
import type { MessageKey } from '../texts.ts';

const SERVER_WORDS = {
  title: ['super_title', 'genesis_title'],
  type: ['ext_type_super', 'genesis_title'],
  id: ['super_id', 'genesis_node_id'],
  device: ['super_device', 'genesis_device'],
  checking: ['super_status_checking', 'genesis_status_checking'],
} as const satisfies Record<string, readonly [MessageKey, MessageKey]>;

export const serverWord = (nodeId: string | null, word: keyof typeof SERVER_WORDS): MessageKey => SERVER_WORDS[word][isGenesisNodeId(nodeId) ? 1 : 0];
