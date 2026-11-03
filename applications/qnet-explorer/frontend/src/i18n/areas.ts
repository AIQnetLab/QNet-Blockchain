// What the browser gets of its catalog: the shell's texts on every page, a part of the site's own on its pages
// (src/i18n/area.tsx), so the legal texts reach only theirs. An entry ending in "_" takes every key it starts; the
// coverage of every page's client lookups is checked in i18n-catalogs.test.mjs.

import type { MessageKey, Texts } from '../lib/texts.ts';

export const AREAS = {
  shell: [
    'about_', 'account_', 'ago_', 'badge_', 'col_token', 'connect_error_', 'copy_', 'date_', 'delivery_',
    'device_model_platform', 'device_platform_', 'docs_title', 'ends_', 'epoch_from', 'epoch_n', 'error_',
    'ext_failure_cooldown', 'ftr_', 'guide_title', 'hdr_', 'held_', 'lang_', 'list_', 'miss_', 'nav_', 'no_device',
    'search_', 'store_', 'sugg_', 'support_title', 'token_', 'try_', 'tx_confirmed', 'tx_in_block', 'tx_pending',
    'tx_waiting_block', 'txs_', 'wallet_disconnect', 'wallet_disconnect_unconfirmed', 'wallet_label', 'wallet_source_',
    'balance', 'cancel', 'copied', 'copy', 'genesis', 'live',
  ],
  home: ['ex_latest_blocks', 'get_', 'home_', 'langs_', 'ro_', 'wallet_page_lead'],
  explorer: [
    'addr_', 'balance_title', 'blk_', 'blocks_', 'col_', 'ex_', 'history_more', 'link_rate_limited', 'not_', 'pager_',
    'party_', 'proof_', 'qnc_', 'ro_', 'table_', 'tok_', 'tokens_', 'tx_', 'wallet_enter_invalid', 'details',
  ],
  node: [
    'act_', 'action_', 'activate_', 'balance_', 'burned_', 'cabinet_title', 'check_', 'claim_', 'code_', 'connect_',
    'details_', 'device_', 'devices_', 'earned_', 'epoch_note', 'ext_', 'genesis_', 'guide_', 'history_', 'link_', 'next_', 'no_',
    'not_', 'one_', 'overview_', 'per_', 'progress_', 'registration_', 'relink_', 'ro_', 'start_', 'state_', 'strip_',
    'super_', 'table_', 'transfer_', 'ui_', 'unlink_', 'view_', 'wallet_', 'checking', 'unreachable',
  ],
  // How it works (/docs/how-it-works): the guide, its pictures in the app's and the extension's words, and the FAQ.
  guide: [
    'act_address_title', 'act_burn', 'act_burning', 'act_code', 'act_done', 'act_go_cabinet', 'act_no_tokens_link',
    'act_payment_title', 'act_receipt_title', 'act_start', 'action_', 'burned_title', 'cabinet_title',
    'claim_extension_waiting', 'connect_app_here', 'connect_ext', 'connect_first_button', 'connect_title',
    'devices_link_closed', 'ext_price', 'ext_start',
    'ext_super_running', 'ext_type_', 'faq_', 'guide_', 'link_open_app', 'link_waiting', 'next_open_overview',
    'ro_heartbeats_sub', 'super_heartbeats_of', 'super_step_', 'super_steps_title', 'super_title', 'ui_',
    'wallet_extension_waiting',
  ],
  privacy: ['legal_', 'privacy_', 'support_legal_privacy', 'toc_'],
  terms: ['legal_', 'privacy_lead', 'support_legal_privacy', 'support_legal_terms', 'terms_', 'toc_'],
  support: ['support_'],
  testnet: ['act_refund_invalid', 'act_refund_label', 'faucet_', 'testnet_', 'tx_to', 'ui_faucet_button', 'ui_faucet_title'],
  wallet: ['get_', 'langs_', 'wallet_page_lead'],
} as const satisfies Record<string, readonly (MessageKey | `${string}_`)[]>;

export type Area = keyof typeof AREAS;

export const inArea = (key: string, area: Area): boolean => (AREAS[area] as readonly string[]).some((entry) => (entry.endsWith('_') ? key.startsWith(entry) : key === entry));

// A catalog never changes while the server runs: each language's texts of an area are picked once.
const picked = new WeakMap<Texts, Map<Area, Texts>>();

export function areaTexts(catalog: Texts, area: Area): Texts {
  const byArea = picked.get(catalog) ?? new Map<Area, Texts>();
  picked.set(catalog, byArea);
  const texts = byArea.get(area) ?? Object.fromEntries(Object.entries(catalog).filter(([key]) => inArea(key, area)));
  byArea.set(area, texts);
  return texts;
}
