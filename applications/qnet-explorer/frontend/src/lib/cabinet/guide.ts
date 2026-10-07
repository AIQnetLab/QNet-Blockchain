// How it works (/docs/how-it-works): every step of the ways to a running node, each with the screen it happens on: a light
// node from a phone (QNet Wallet makes or imports the wallet, the payment address burns, QNet Wallet registers and runs
// the node, and moves its balance) or from a computer (the QNet extension makes or imports the wallet and burns, the same
// wallet in QNet Wallet runs the node), and a super node, which only the QNet extension on a computer activates (the
// burn in the extension, its code and the server steps on the page, the server with the node software, then My node
// follows it and QNet Wallet's Node tab moves its balance).
// A picture is described here as parts of a screen; src/components/cabinet/GuideArt.tsx draws it. Every label a
// picture shows is a key of src/lib/texts.ts, and every one is the label of the screen it draws: the app's and the
// extension's labels there are their own words, and this site's are the ones its pages show (cabinet-guide.test.mjs).
// Which steps exist follows the release's network and the site's phone flows.

import type { MessageKey } from '../texts.ts';
import { TAB_HREF } from './tabs.ts';

export type Label = MessageKey | { key: MessageKey; vars: Record<string, string> } | { raw: string };

export interface ButtonPart {
  kind: 'button';
  label: Label;
  // secondary: outlined; done: the button pressed just before.
  tone?: 'primary' | 'secondary' | 'done';
  // The one the step presses, drawn with a ring.
  hot?: boolean;
  // A button of this site: written in capitals, as the site shows it.
  site?: boolean;
}

// One node type card of the Activate tab: its name, where it runs and its price.
export interface ChoiceItem {
  label: Label;
  note: Label;
  price: Label;
}

export type Part =
  | { kind: 'title'; label: Label }
  | { kind: 'small'; label: Label }
  | { kind: 'lines'; count: number }
  | ButtonPart
  | { kind: 'pair'; left: ButtonPart; right: ButtonPart }
  | { kind: 'field'; label?: Label; value?: Label; secret?: boolean; hot?: boolean }
  // A label with its value on the same line, as QNet Wallet's Node tab shows its rows.
  | { kind: 'row'; label: Label; value: Label }
  | { kind: 'check'; label: Label }
  | { kind: 'words' }
  // One word to pick among `count` buttons, the one at `chosen` picked.
  | { kind: 'picks'; label: Label; count: number; chosen: number }
  | { kind: 'qr' }
  | { kind: 'code'; label: Label }
  | { kind: 'status'; label: Label }
  | { kind: 'tabs'; items: Label[]; current: number }
  // The node type cards side by side (one under the other where they do not fit), the one at `current` selected.
  | { kind: 'choice'; items: ChoiceItem[]; current: number };

export type Scene =
  // A phone or tablet: QNet Wallet, or its own web browser with the address it shows.
  | { frame: 'phone'; screen: 'app' | 'web'; url?: string; urlHot?: boolean; parts: Part[] }
  // A computer's browser; `popup` is the extension's window over the page, `pin` its toolbar icon to pin.
  | { frame: 'browser'; url?: string; tab?: Label; pin?: boolean; parts: Part[]; popup?: Part[] }
  // The computer shows a QR code and the phone that scanned it shows QNet Wallet.
  | { frame: 'scan'; parts: Part[]; phone: Part[] };

export interface GuideStep {
  id: string;
  text: MessageKey;
  // Another way to do the same step.
  also?: MessageKey;
  // The page of this site the step sends the reader to, as a link under its words.
  link?: { href: string; label: MessageKey };
  scene: Scene;
}

export interface GuideOptions {
  network: 'testnet' | 'mainnet';
  // CABINET_PHONE_FLOWS: this site pays from a phone and sends QNet Wallet link and claim requests.
  phoneFlows: boolean;
}

// Example values a picture shows, shortened as the site shortens addresses: a public test wallet's addresses, a code
// shaped like the real ones, a light node ID as QNet Wallet shows it, a small node balance.
const QNET = { raw: 'd9fa37…73823e' };
const SOLANA = { raw: 'HAgk14…3DKpqk' };
const CODE = { raw: 'QNET-LFEFD9-706058-537636' };
const NODE_ID = { raw: 'light_mobile_3f9a0c1d2e4b5a69' };
const BALANCE: Label = { key: 'balance', vars: { amount: '2.5' } };
const APP_BALANCE = { raw: '2.5 QNC' };
const SOME: Record<string, string> = { amount: '…' };

const appButton = (label: Label, hot = false, tone: ButtonPart['tone'] = 'primary'): ButtonPart => ({ kind: 'button', label, hot, tone });
const siteButton = (label: Label, hot = false, tone: ButtonPart['tone'] = 'primary'): ButtonPart => ({ kind: 'button', label, hot, tone, site: true });
const confirmPair = (reject: MessageKey, confirm: MessageKey): Part => ({
  kind: 'pair', left: appButton(reject, false, 'secondary'), right: appButton(confirm, true),
});
// My node's sections: with Activate while the wallet has no node, without it once the node exists.
const cabinetTabs = (current: number): Part => ({ kind: 'tabs', items: ['nav_overview', 'nav_activate', 'nav_device', 'nav_history'], current });
const nodeTabs: Part = { kind: 'tabs', items: ['nav_overview', 'nav_device', 'nav_history'], current: 0 };
// The Activate tab's two node type cards, `current` selected.
const typeCards = (current: number): Part => ({
  kind: 'choice',
  current,
  items: [
    { label: 'ext_type_light', note: 'ext_type_light_where', price: { key: 'ext_price', vars: { price: '…' } } },
    { label: 'ext_type_super', note: 'ext_type_super_where', price: { key: 'ext_price', vars: { price: '…' } } },
  ],
});
// The node software's own guide (docs/operators/running-a-node.md).
export const RUNNING_A_NODE = 'https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/docs/operators/running-a-node.md';
// The extension's window: its six tabs.
const EXT_TABS: Label[] = ['ui_ext_assets', 'ui_ext_send', 'ui_ext_receive', 'ui_ext_history', 'ui_ext_activate', 'ui_ext_settings'];

// QNet Wallet's Node tab: the node balance and its move into the wallet, the same for a light and a server node.
const APP_NODE_TAB: Scene = {
  frame: 'phone', screen: 'app', parts: [
    { kind: 'title', label: 'ui_app_node_tab' },
    { kind: 'lines', count: 3 },
    { kind: 'row', label: 'ui_app_node_balance', value: APP_BALANCE },
    appButton('action_move', true),
  ],
};

// Creating a wallet in QNet Wallet: the same four screens on every phone and tablet. A phone with a screen lock locks
// the wallet with it and shows no password fields.
const APP_WALLET: GuideStep[] = [
  {
    id: 'install',
    text: 'guide_phone_install',
    link: { href: '/wallet', label: 'guide_link_wallet' },
    scene: {
      frame: 'phone', screen: 'app', parts: [
        { kind: 'title', label: 'ui_app_name' },
        { kind: 'small', label: 'ui_app_welcome' },
        { kind: 'lines', count: 2 },
        appButton('ui_app_create_new', true),
        appButton('ui_app_import', false, 'secondary'),
      ],
    },
  },
  {
    id: 'protect',
    text: 'guide_phone_protect',
    scene: {
      frame: 'phone', screen: 'app', parts: [
        { kind: 'title', label: 'ui_app_create' },
        { kind: 'lines', count: 3 },
        { kind: 'check', label: 'ui_app_terms' },
        appButton('ui_app_create', true),
      ],
    },
  },
  {
    id: 'words',
    text: 'guide_phone_words',
    scene: {
      frame: 'phone', screen: 'app', parts: [
        { kind: 'title', label: 'ui_app_seed_title' },
        { kind: 'words' },
        appButton('copy', false, 'secondary'),
        appButton('ui_app_wrote', true),
      ],
    },
  },
  {
    id: 'words-check',
    text: 'guide_phone_words_check',
    scene: {
      frame: 'phone', screen: 'app', parts: [
        { kind: 'title', label: 'ui_app_confirm_title' },
        { kind: 'picks', label: { key: 'ui_app_select_word', vars: { n: '3' } }, count: 4, chosen: 2 },
        { kind: 'picks', label: { key: 'ui_app_select_word', vars: { n: '7' } }, count: 4, chosen: 0 },
        { kind: 'picks', label: { key: 'ui_app_select_word', vars: { n: '11' } }, count: 4, chosen: 3 },
        appButton('ui_app_confirm_create', true),
      ],
    },
  },
];

// Phone only: QNet Wallet makes the wallet and confirms the light node is for it, this site pays from a payment address
// in the phone's browser, QNet Wallet's second confirmation registers the node and runs it on that phone, and its Node
// tab moves the node balance. Null while the site's phone flows are off.
export function phoneGuide({ network, phoneFlows }: GuideOptions): GuideStep[] | null {
  if (!phoneFlows) return null;
  return [
    ...APP_WALLET,
    {
      id: 'open-site',
      text: 'guide_phone_open_site',
      scene: {
        frame: 'phone', screen: 'web', url: 'aiqnet.io/node', urlHot: true, parts: [
          { kind: 'title', label: 'cabinet_title' },
          { kind: 'lines', count: 1 },
          { kind: 'title', label: 'connect_title' },
          siteButton('connect_app_here'),
          { kind: 'lines', count: 2 },
        ],
      },
    },
    {
      id: 'connect',
      text: 'guide_phone_connect',
      scene: {
        frame: 'phone', screen: 'web', url: 'aiqnet.io/node', parts: [
          { kind: 'title', label: 'connect_title' },
          siteButton('link_open_app', true),
          { kind: 'lines', count: 2 },
          { kind: 'status', label: { key: 'link_waiting', vars: { time: '9:58' } } },
          siteButton('cancel', false, 'secondary'),
        ],
      },
    },
    {
      id: 'share',
      text: 'guide_phone_share',
      scene: {
        frame: 'phone', screen: 'app', parts: [
          { kind: 'small', label: 'ui_app_origin' },
          { kind: 'title', label: 'ui_app_share_title' },
          { kind: 'field', label: 'ui_app_qnet_address', value: QNET },
          { kind: 'field', label: 'ui_app_solana_address', value: SOLANA },
          confirmPair('ui_app_reject', 'ui_app_confirm'),
        ],
      },
    },
    {
      id: 'start',
      text: 'guide_phone_start',
      scene: {
        frame: 'phone', screen: 'web', url: 'aiqnet.io/node/activate', parts: [
          cabinetTabs(1),
          { kind: 'title', label: 'act_payment_title' },
          { kind: 'lines', count: 3 },
          siteButton('act_start', true),
        ],
      },
    },
    {
      id: 'reserve',
      text: 'guide_phone_reserve',
      scene: {
        frame: 'phone', screen: 'app', parts: [
          { kind: 'small', label: 'ui_app_origin' },
          { kind: 'title', label: 'ui_app_reserve_title' },
          { kind: 'lines', count: 1 },
          { kind: 'field', label: 'ui_app_link_node', value: NODE_ID },
          { kind: 'field', label: 'ui_app_link_wallet', value: QNET },
          confirmPair('ui_app_reject', 'ui_app_confirm'),
        ],
      },
    },
    network === 'testnet'
      ? {
        id: 'fund',
        text: 'guide_phone_fund_testnet',
        scene: {
          frame: 'phone', screen: 'web', url: 'aiqnet.io/node/activate', parts: [
            { kind: 'title', label: 'act_address_title' },
            { kind: 'qr' },
            { kind: 'lines', count: 1 },
            siteButton('copy', true, 'secondary'),
            { kind: 'small', label: 'act_no_tokens_link' },
          ],
        },
      }
      : {
        id: 'fund',
        text: 'guide_phone_fund_mainnet',
        scene: {
          frame: 'phone', screen: 'web', url: 'aiqnet.io/node/activate', parts: [
            { kind: 'title', label: 'act_address_title' },
            { kind: 'qr' },
            { kind: 'lines', count: 2 },
            siteButton('copy', true, 'secondary'),
          ],
        },
      },
    {
      id: 'burn',
      text: 'guide_phone_burn',
      scene: {
        frame: 'phone', screen: 'web', url: 'aiqnet.io/node/activate', parts: [
          { kind: 'title', label: 'act_address_title' },
          { kind: 'lines', count: 3 },
          siteButton('act_burn', true),
          { kind: 'status', label: 'act_burning' },
        ],
      },
    },
    {
      id: 'link',
      text: 'guide_phone_link',
      scene: {
        frame: 'phone', screen: 'app', parts: [
          { kind: 'small', label: 'ui_app_origin' },
          { kind: 'title', label: 'ui_app_link_title' },
          { kind: 'lines', count: 3 },
          confirmPair('ui_app_reject', 'ui_app_confirm'),
        ],
      },
    },
    {
      id: 'done',
      text: 'guide_phone_done',
      scene: {
        // The Receipt card with the code, then the Registered card with its button.
        frame: 'phone', screen: 'web', url: 'aiqnet.io/node/activate', parts: [
          { kind: 'title', label: 'act_receipt_title' },
          { kind: 'small', label: 'act_code' },
          { kind: 'code', label: CODE },
          { kind: 'status', label: 'act_done' },
          { kind: 'lines', count: 1 },
          siteButton('act_go_cabinet', true),
        ],
      },
    },
    {
      id: 'move',
      text: 'guide_phone_move',
      also: 'guide_or_move_site',
      scene: APP_NODE_TAB,
    },
  ];
}

// The extension's first steps, shared by the computer's light guide and the super guide: install it, create or import
// the wallet, copy its Solana address and put the activation price on it, then connect it on My node.
function extensionWallet(network: GuideOptions['network']): GuideStep[] {
  const setup = (parts: Part[], popup?: Part[]): Scene => ({ frame: 'browser', tab: 'ui_ext_setup_page', parts, popup });
  return [
    {
      id: 'install',
      text: 'guide_pc_install',
      link: { href: '/wallet', label: 'guide_link_wallet' },
      scene: {
        frame: 'browser', url: 'aiqnet.io/wallet', pin: true, parts: [
          { kind: 'title', label: 'ui_app_name' },
          { kind: 'lines', count: 4 },
        ],
      },
    },
    {
      id: 'setup',
      text: 'guide_pc_setup',
      // The extension's window with no wallet yet, and the setup tab its button opens.
      scene: setup(
        [
          { kind: 'title', label: 'ui_ext_setup_welcome' },
          appButton('ui_ext_create'),
          appButton('ui_ext_import', false, 'secondary'),
        ],
        [
          { kind: 'small', label: 'ui_ext_welcome_lead' },
          appButton('ui_ext_welcome_setup', true),
        ],
      ),
    },
    {
      id: 'words',
      text: 'guide_pc_words',
      scene: setup([
        { kind: 'title', label: 'ui_ext_setup_title' },
        { kind: 'words' },
        { kind: 'check', label: 'ui_ext_written' },
        appButton('ui_ext_continue', true),
      ]),
    },
    {
      id: 'check',
      text: 'guide_pc_check',
      scene: setup([
        { kind: 'title', label: 'ui_ext_verify_title' },
        { kind: 'field', label: { key: 'ui_ext_word', vars: { n: '2' } } },
        { kind: 'field', label: { key: 'ui_ext_word', vars: { n: '6' } } },
        { kind: 'field', label: { key: 'ui_ext_word', vars: { n: '10' } } },
        appButton('ui_ext_check', true),
      ]),
    },
    {
      id: 'password',
      text: 'guide_pc_password',
      scene: setup([
        { kind: 'title', label: 'ui_ext_password_title' },
        { kind: 'field', label: 'ui_ext_new_password', secret: true },
        { kind: 'field', label: 'ui_ext_repeat_password', secret: true },
        appButton('ui_ext_create_wallet', true),
      ]),
    },
    {
      id: 'solana',
      text: 'guide_pc_solana',
      scene: {
        frame: 'browser', parts: [{ kind: 'lines', count: 5 }], popup: [
          { kind: 'tabs', items: ['ui_ext_qnet', 'ui_ext_solana'], current: 1 },
          { kind: 'tabs', items: EXT_TABS, current: 2 },
          { kind: 'qr' },
          appButton('ui_ext_copy_address', true),
        ],
      },
    },
    network === 'testnet'
      ? {
        id: 'tokens',
        text: 'guide_pc_tokens_testnet',
        link: { href: '/testnet', label: 'guide_link_faucet' },
        scene: {
          frame: 'browser', url: 'aiqnet.io/testnet', parts: [
            { kind: 'title', label: 'ui_faucet_title' },
            { kind: 'lines', count: 1 },
            { kind: 'field', value: SOLANA },
            siteButton('ui_faucet_button', true),
          ],
        },
      }
      : {
        id: 'tokens',
        text: 'guide_pc_tokens_mainnet',
        scene: {
          frame: 'browser', parts: [{ kind: 'lines', count: 5 }], popup: [
            { kind: 'tabs', items: ['ui_ext_qnet', 'ui_ext_solana'], current: 1 },
            { kind: 'tabs', items: EXT_TABS, current: 0 },
            { kind: 'small', label: { raw: '1DEV' } },
            { kind: 'small', label: { raw: 'SOL' } },
            { kind: 'lines', count: 2 },
          ],
        },
      },
    {
      id: 'connect',
      text: 'guide_pc_connect',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node', parts: [
          { kind: 'title', label: 'connect_title' },
          siteButton('connect_ext', false, 'done'),
          { kind: 'status', label: 'wallet_extension_waiting' },
          { kind: 'lines', count: 2 },
        ],
        popup: [
          { kind: 'small', label: { raw: 'aiqnet.io' } },
          { kind: 'title', label: 'ui_ext_connect_title' },
          { kind: 'lines', count: 2 },
          confirmPair('ui_ext_reject', 'ui_ext_connect'),
        ],
      },
    },
  ];
}

// From a computer: the QNet extension makes or imports the wallet, pays and records the node in one approval; the same
// wallet imported in QNet Wallet then runs the node on the phone.
export function computerGuide({ network, phoneFlows }: GuideOptions): GuideStep[] {
  return [
    ...extensionWallet(network),
    {
      id: 'activate',
      text: 'guide_pc_activate',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node/activate', parts: [
          cabinetTabs(1),
          typeCards(0),
          siteButton('ext_start', true),
        ],
      },
    },
    {
      id: 'burn',
      text: 'guide_pc_burn',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node/activate', parts: [
          cabinetTabs(1),
          { kind: 'lines', count: 4 },
        ],
        popup: [
          { kind: 'title', label: 'ui_ext_activate_title' },
          { kind: 'check', label: { key: 'ui_ext_ack', vars: SOME } },
          appButton({ key: 'ui_ext_burn', vars: SOME }, true),
        ],
      },
    },
    {
      id: 'phone',
      text: 'guide_pc_phone',
      scene: {
        frame: 'phone', screen: 'app', parts: [
          { kind: 'title', label: 'ui_app_import_title' },
          { kind: 'field', value: 'ui_app_phrase' },
          { kind: 'check', label: 'ui_app_terms' },
          appButton('ui_app_import_title', true),
        ],
      },
    },
    phoneFlows
      ? {
        id: 'link',
        text: 'guide_pc_link',
        also: 'guide_or_use_device',
        scene: {
          frame: 'scan',
          parts: [
            { kind: 'title', label: 'action_link_device' },
            { kind: 'qr' },
          ],
          phone: [
            { kind: 'small', label: 'ui_app_origin' },
            { kind: 'title', label: 'ui_app_link_title' },
            confirmPair('ui_app_reject', 'ui_app_confirm'),
          ],
        },
      }
      : {
        id: 'link',
        text: 'guide_pc_link_app',
        scene: {
          frame: 'phone', screen: 'app', parts: [
            { kind: 'title', label: 'ui_app_node_tab' },
            { kind: 'small', label: 'no_device' },
            appButton('ui_app_use', true),
            { kind: 'lines', count: 2 },
          ],
        },
      },
    {
      id: 'move',
      text: 'guide_pc_move',
      also: 'guide_or_move_app',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node', parts: [
          nodeTabs,
          { kind: 'small', label: BALANCE },
          { kind: 'status', label: 'wallet_extension_waiting' },
        ],
        popup: [
          { kind: 'title', label: 'ui_ext_claim_title' },
          { kind: 'lines', count: 2 },
          confirmPair('ui_ext_reject', 'ui_ext_move'),
        ],
      },
    },
  ];
}

// A super node (R3, R5): only the QNet extension on a computer activates it. The extension makes or imports the wallet
// and burns (the one-time payment address burns for light nodes only, and a phone activates none), the page shows the
// code and every server step right after the burn and the Overview later in any browser where the wallet is connected,
// the server runs the QNet node software with the same wallet, the Overview follows it, and QNet Wallet's Node tab
// moves its balance (the site moves a light node's only).
export function superGuide({ network }: GuideOptions): GuideStep[] {
  const SUPER_CODE = { raw: 'QNET-S2C4A1-806358-771140' };
  return [
    ...extensionWallet(network),
    {
      id: 'activate',
      text: 'guide_super_activate',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node/activate', parts: [
          cabinetTabs(1),
          typeCards(1),
          siteButton('ext_start', true),
        ],
      },
    },
    {
      id: 'burn',
      text: 'guide_super_burn',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node/activate', parts: [
          cabinetTabs(1),
          { kind: 'lines', count: 4 },
        ],
        popup: [
          { kind: 'title', label: 'ui_ext_activate_super_title' },
          { kind: 'check', label: { key: 'ui_ext_ack', vars: SOME } },
          appButton({ key: 'ui_ext_burn', vars: SOME }, true),
        ],
      },
    },
    {
      id: 'code',
      text: 'guide_super_code',
      // The Overview holds the code and every server command for good, in any browser where the wallet is connected.
      link: { href: TAB_HREF.overview, label: 'next_open_overview' },
      scene: {
        frame: 'browser', url: 'aiqnet.io/node', parts: [
          nodeTabs,
          { kind: 'small', label: 'burned_title' },
          { kind: 'code', label: SUPER_CODE },
          { kind: 'title', label: 'super_steps_title' },
          { kind: 'lines', count: 3 },
        ],
      },
    },
    {
      id: 'server',
      text: 'guide_super_server',
      link: { href: RUNNING_A_NODE, label: 'ext_super_running' },
      scene: {
        frame: 'browser', url: 'aiqnet.io/node', parts: [
          { kind: 'title', label: 'super_steps_title' },
          { kind: 'small', label: 'super_step_start' },
          { kind: 'lines', count: 4 },
          siteButton('copy', true, 'secondary'),
        ],
      },
    },
    {
      id: 'watch',
      text: 'guide_super_watch',
      scene: {
        frame: 'browser', url: 'aiqnet.io/node', parts: [
          nodeTabs,
          { kind: 'title', label: 'super_title' },
          { kind: 'status', label: 'badge_online' },
          { kind: 'small', label: { key: 'super_heartbeats', vars: { current: '7', required: '9' } } },
          { kind: 'small', label: BALANCE },
        ],
      },
    },
    {
      id: 'move',
      text: 'guide_super_move',
      scene: APP_NODE_TAB,
    },
  ];
}

// The compact version beside the connect screen: three big steps from a phone, four from a computer and for a super
// node.
export const SHORT_PHONE: MessageKey[] = ['guide_short_phone_1', 'guide_short_phone_2', 'guide_short_phone_3'];
export const SHORT_COMPUTER: MessageKey[] = ['guide_short_pc_1', 'guide_short_pc_2', 'guide_short_pc_3', 'guide_short_pc_4'];
export const SHORT_SUPER: MessageKey[] = ['guide_short_super_1', 'guide_short_super_2', 'guide_short_super_3', 'guide_short_super_4'];

// Every label a group of parts shows, for the tests.
export function partLabels(parts: Part[]): Label[] {
  const all: Label[] = [];
  for (const part of parts) {
    if (part.kind === 'pair') all.push(part.left.label, part.right.label);
    else if (part.kind === 'tabs') all.push(...part.items);
    else if (part.kind === 'choice') for (const item of part.items) all.push(item.label, item.note, item.price);
    else if (part.kind === 'field') {
      if (part.label) all.push(part.label);
      if (part.value) all.push(part.value);
    } else if (part.kind === 'row') all.push(part.label, part.value);
    else if ('label' in part) all.push(part.label);
  }
  return all;
}

// Every label a scene shows, for the tests.
export function sceneLabels(scene: Scene): Label[] {
  const all = partLabels(scene.parts);
  if (scene.frame === 'browser') {
    if (scene.tab) all.push(scene.tab);
    if (scene.popup) all.push(...partLabels(scene.popup));
  }
  if (scene.frame === 'scan') all.push(...partLabels(scene.phone));
  return all;
}
