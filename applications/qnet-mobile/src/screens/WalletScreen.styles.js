import { StyleSheet } from 'react-native';
import { color, radius, sheet, size, space, themed } from '../theme';

// One centred column of at most 640 on every screen, so a tablet or a wide window shows the phone layout, not lines
// stretched across the screen. Flex only: nothing reads the window width. Its content is start-aligned and vertically
// centred (fieldColumn sets it at the foot).
const COLUMN = {
  width: '100%',
  maxWidth: size.column,
  alignSelf: 'center',
  justifyContent: 'center',
  alignItems: 'stretch',
  padding: space.gut,
};

// Every entry is drawn in the theme's tokens and type roles (theme.js); one sheet per script group (themed).
const styles = themed((type) => ({
  // Runs that stay left to right in any language: addresses, hashes, amounts (the layout's direction follows the
  // language as a whole, i18n/direction).
  ltr: {
    writingDirection: 'ltr',
  },
  container: {
    flex: 1,
    backgroundColor: color.ink, // the splash screen's background, so the first frame follows it seamlessly
  },
  centerContent: {
    flex: 1,
    ...COLUMN,
  },
  // The welcome and lock screens' column: the mark, the name and the actions at its foot, under the live field of the
  // top half. The lock screen's scrolls when a very large system font makes it taller than the screen.
  fieldColumn: {
    flexGrow: 1,
    ...COLUMN,
    justifyContent: 'flex-end',
  },
  formContent: {
    flexGrow: 1,
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    padding: space.gut,
    paddingTop: space.s24,
  },
  // The recovery phrase shown once: room under the last action for a large system font.
  seedContent: {
    paddingBottom: space.s48,
  },
  // Wraps a form's ScrollView so an open keyboard shrinks the form instead of covering it.
  keyboardAvoid: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: space.gut,
  },
  scrollContentContainer: {
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    paddingBottom: space.s24,
  },
  // A form's title (the storage problem, create, import, the phrase): the title face a little smaller than a tab's, so
  // the longest word of every language (a German compound) fits a 320 dp screen.
  title: {
    ...type('title', 26),
    color: color.paper,
    marginBottom: space.s12,
  },
  // The app's name on the screens that hold no data (welcome, lock, loading), at the start edge in either direction.
  display: {
    ...type('display'),
    color: color.paper,
    marginBottom: space.s12,
    alignSelf: 'flex-start',
  },
  subtitle: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s32,
  },
  // A quiet line of a form (a storage problem's reassurance, the phrase's clipboard rule).
  formNote: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s16,
  },
  // The solid action of a form, with the next action under it.
  formAction: {
    marginBottom: space.s12,
  },
  // A form's live lines, tucked under the field above them (components/ui/Field keeps 16 under itself).
  passwordHint: {
    ...type('note'),
    color: color.fog,
    marginTop: -space.s8,
    marginBottom: space.s16,
    alignSelf: 'flex-start',
  },
  passwordSuccess: {
    ...type('note'),
    color: color.paper,
    marginTop: -space.s8,
    marginBottom: space.s16,
    alignSelf: 'flex-start',
  },
  errorText: {
    ...type('note'),
    color: color.ember,
    marginTop: -space.s8,
    marginBottom: space.s16,
    alignSelf: 'flex-start',
  },
  // An error under a feedback line, which already ends 16 below its field: 8 between the two lines, not 0.
  errorAfterLine: {
    marginTop: 0,
  },
  header: {
    backgroundColor: color.ink,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  // The app's mark and name at the start, More at the end.
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s8,
    minHeight: size.header,
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    paddingHorizontal: space.gut,
  },
  headerMark: {
    width: 22,
    height: 22,
  },
  // Its own width at the start, next to the mark (a line of Latin letters would otherwise keep to the left in a
  // right-to-left layout); More goes to the end.
  wordmark: {
    ...type('wordmark'),
    flexShrink: 1,
    marginEnd: 'auto',
    color: color.paper,
  },
  // Between the header and the bottom bar (components/BottomBar, which keeps clear of the system bars itself).
  tabContentContainer: {
    flex: 1,
  },
  // The in-app browser pane: placed over the tab content area (its top and height are measured), under
  // everything else; invisible and untouchable while another tab is open or the wallet is locked.
  browserPane: {
    position: 'absolute',
    start: 0,
    end: 0,
    top: 0,
    height: 0,
  },
  browserPaneHidden: {
    opacity: 0,
  },
  seedConfirmContent: {
    flexGrow: 1,
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    padding: space.gut,
    paddingTop: space.s24,
    backgroundColor: color.ink,
  },
  seedConfirmGroup: {
    marginBottom: space.s24,
    width: '100%',
  },
  label: {
    ...type('label'),
    color: color.fog,
    marginBottom: space.s8,
  },
  // A camera reads the code off white: the code carries its own quiet zone, at the column's start.
  qrWrapper: {
    alignSelf: 'flex-start',
    borderRadius: radius.box,
    overflow: 'hidden',
    marginBottom: space.s16,
  },
  settingGroup: {
    marginBottom: space.s32,
  },
  // A group's kicker over its rows, a strong rule under it.
  settingGroupTitle: {
    ...type('label'),
    color: color.fog,
    paddingBottom: space.s8,
    marginBottom: space.s4,
    borderBottomWidth: 1,
    borderBottomColor: color.ruleStrong,
  },
  // A line of Settings that is not a setting's row (components/InfoRow SettingRow): a warning, no sites yet.
  settingSubtitle: {
    ...type('note'),
    color: color.fog,
  },
  settingWarning: {
    color: color.ember,
  },
  // Under the language's row while the layout still has the other direction: the line and its Restart.
  layoutNote: {
    alignItems: 'flex-start',
    paddingTop: space.s8,
  },
  // A sheet's sentence (components/ui/Sheet keeps the gutter).
  modalContent: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s16,
  },
  modalWarning: {
    ...type('body'),
    color: color.ember,
    marginBottom: space.s16,
  },
  // A send's recipient on its password prompt: whole, in groups of four, left to right in every language.
  freshRecipient: {
    ...type('address'),
    color: color.paper,
    writingDirection: 'ltr',
    backgroundColor: color.fillField,
    borderWidth: 1,
    borderColor: color.edge,
    borderRadius: radius.box,
    padding: space.s12,
    marginBottom: space.s16,
  },
  // What a field in a dialog is for: above the field, wrapping, so the placeholder stays one short word.
  modalLabel: {
    ...type('label'),
    color: color.fog,
    marginBottom: space.s8,
  },
  modalSubtitle: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s12,
  },
  // A recovery phrase: two columns of words, each with its number in a column of its own, hairlines between lines.
  seedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    marginVertical: space.s16,
  },
  seedWordContainer: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: size.rowMin,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  // The number's column: the number against the word after it, in either direction.
  seedWordNumberBox: {
    width: 24,
    marginEnd: space.s8,
    alignItems: 'flex-end',
  },
  seedWordNumber: {
    ...type('data'),
    color: color.fog,
  },
  seedWordText: {
    ...type('address'),
    color: color.paper,
    flex: 1,
  },
  seedWarningText: {
    ...type('body'),
    color: color.ember,
    marginBottom: space.s16,
  },
  // An address in one rounded element a tap copies: the address (one line on Assets, whole on Receive), the copy glyph.
  addressPill: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s12,
    minHeight: size.rowMin,
    paddingVertical: space.s12,
    paddingHorizontal: space.s16,
    marginBottom: space.s16,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.ruleStrong,
    backgroundColor: color.surface,
  },
  addressPillDone: {
    borderColor: color.signalLine,
  },
  addressPillText: {
    ...type('address', 14),
    color: color.paper,
    writingDirection: 'ltr',
    flex: 1,
  },
  addressPillCopied: {
    color: color.signal,
  },
  subjectAddress: {
    flex: 1,
  },
  subjectLine: {
    ...type('address'),
    color: color.paper,
    writingDirection: 'ltr',
  },
  subjectQuiet: {
    color: color.fog,
  },
  // Receive: the network's icon and what the address takes, between the code and the address.
  receiveHead: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s8,
    marginBottom: space.s8,
  },
  receiveLine: {
    ...type('note'),
    color: color.fog,
    flexShrink: 1,
  },
  // The quiet line under Send and Receive when the figures could not be updated for a while, or the network stopped.
  balanceStatusLine: {
    ...type('note', 12),
    color: color.fog,
    textAlign: 'center',
    marginTop: space.s8,
  },
  // Settings, Export private key: one block per key, the key shown in a box.
  keyRevealBlock: {
    marginBottom: space.s16,
  },
  keyRevealFormat: {
    ...type('note', 12),
    color: color.fog,
    marginBottom: 6,
  },
  keyRevealBox: {
    backgroundColor: color.fillField,
    borderRadius: radius.box,
    borderWidth: 1,
    borderColor: color.edge,
    padding: space.s12,
    minHeight: 64,
    justifyContent: 'center',
    marginBottom: space.s8,
  },
  keyRevealKey: {
    ...type('data'),
    color: color.paper,
    writingDirection: 'ltr',
  },
  // Receive and Send under the address on Assets.
  assetActions: {
    marginBottom: space.s16,
  },
  tokenList: {
    marginBottom: space.s24,
  },
  // A list's kicker (the transactions not settled yet), a strong rule under it.
  listKicker: {
    ...type('label'),
    color: color.fog,
    paddingBottom: space.s8,
    borderBottomWidth: 1,
    borderBottomColor: color.ruleStrong,
  },
  keptLine: {
    ...type('data'),
    color: color.paper,
  },
  // A row under the finger.
  rowPressed: {
    backgroundColor: color.fillPress,
  },
  // A line that opens what it names (the tokens sent unasked), start-aligned.
  inlineLink: {
    ...type('note'),
    color: color.signal,
    textDecorationLine: 'underline',
    textDecorationColor: color.signalLine,
    alignSelf: 'flex-start',
    paddingVertical: space.s12,
  },
  // The unsettled transactions' rows wrap: "Stop sending" takes its own line when it does not fit.
  tokenItem: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  tokenInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    maxWidth: '100%',
    marginEnd: space.s12,
  },
  tokenDetails: {
    justifyContent: 'center',
    flexShrink: 1,
  },
  tokenName: {
    ...type('row'),
    color: color.paper,
  },
  tokenPrice: {
    ...type('note', 12),
    color: color.fog,
  },
  // A warning or a refusal on a token's line (a reserved name, a stop).
  tokenWarn: {
    color: color.ember,
  },
  // A balance beside its token in up to two fifths of the row, shrinking to fit; one that would not fit there even at
  // half its size goes under the token, whole (screens/WalletScreen TokenBalance).
  tokenBalance: {
    alignItems: 'flex-end',
    flexShrink: 0,
    maxWidth: '40%',
    marginStart: 'auto',
  },
  tokenBalanceUnder: {
    width: '100%',
    alignItems: 'flex-end',
    marginTop: space.s8,
  },
  tokenAmount: {
    ...type('amount', 16),
    color: color.paper,
  },
  // A token on Assets, a rounded tile of its own: its icon and name, and its balance on the same line (tokenBalance), or
  // under them (tokenItemWrap).
  tokenItemClickable: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.s12,
    paddingHorizontal: space.s16,
    marginBottom: space.s8,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.rule,
    backgroundColor: color.surface,
  },
  tokenIcon: {
    marginEnd: space.s12,
  },
  tokenItemWrap: {
    flexWrap: 'wrap',
  },
  mgrSearch: {
    marginBottom: space.s8,
  },
  // The token manager's body fills its sheet, so the list scrolls inside it.
  mgrBody: {
    flex: 1,
  },
  mgrList: {
    flex: 1,
  },
  mgrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  mgrRowInfo: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  mgrRowSym: {
    ...type('row', 15),
    color: color.paper,
  },
  mgrRowBal: {
    ...type('amount', 13),
    color: color.paper,
    marginTop: 2,
  },
  mgrRowNote: {
    ...type('note', 12),
    color: color.fog,
    marginTop: 2,
  },
  mgrRowId: {
    ...type('data', 12),
    color: color.fog,
    marginTop: 2,
  },
  mgrEmpty: {
    ...type('note'),
    color: color.fog,
    paddingVertical: 30,
    paddingHorizontal: 10,
  },
  mgrHint: {
    ...type('note', 12),
    color: color.fog,
    paddingHorizontal: space.s4,
    marginBottom: space.s8,
  },
  mgrError: {
    ...type('note', 12),
    color: color.ember,
    paddingHorizontal: space.s4,
    marginBottom: space.s8,
  },
  // The Send forms' balance: its row (components/InfoRow), a token's contract under it.
  sendBalanceInfo: {
    marginBottom: space.s16,
  },
  sendBalanceNotes: {
    paddingBottom: 10,
  },
  // The line over a Send form a payment request from a link filled in (SolanaSend fromLink).
  sendFromLink: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s12,
  },
  // The amount field, with its share acts close under it.
  amountField: {
    marginBottom: space.s4,
  },
  percentageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.s24,
    marginBottom: space.s16,
  },
  // The Send forms' fee and total rows (components/InfoRow).
  sendFigures: {
    marginTop: space.s8,
    marginBottom: space.s16,
  },
  sendScreenContainer: {
    paddingTop: 0,
  },
  // A sub-screen (Send, Receive) starts right under the app header: its compact row takes the place of the top padding.
  subScreen: {
    paddingTop: space.s4,
  },
  // Transaction result: start-aligned over the tab.
  txResultContainer: {
    alignItems: 'stretch',
    paddingVertical: space.s24,
  },
  txResultOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: color.ink,
  },
  txResultTitle: {
    ...type('title'),
    color: color.paper,
    marginBottom: space.s16,
  },
  txResultTitleFailed: {
    color: color.ember,
  },
  txResultAmount: {
    ...type('figure'),
    color: color.paper,
    marginBottom: space.s16,
    alignSelf: 'flex-start',
  },
  // The recipient's field (components/InfoRow) across the column.
  txResultTo: {
    alignSelf: 'stretch',
    marginBottom: space.s8,
  },
  txHashContainer: {
    alignSelf: 'stretch',
    marginBottom: space.s16,
  },
  txResultNote: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s16,
  },
  histEmptyBox: {
    paddingVertical: 40,
  },
  histEmpty: {
    ...type('body'),
    color: color.fog,
  },
  histLoadingOlder: {
    ...type('note', 12),
    color: color.fog,
    paddingVertical: space.s16,
  },
  // Which Solana sends History lists, said once above them.
  histScope: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s12,
  },
  // History (screens/HistoryTab): a header per day, then one row per transaction, the amount never cut.
  histDay: {
    ...type('label'),
    color: color.fog,
    marginTop: space.s24,
    marginBottom: 0,
    paddingBottom: space.s8,
    borderBottomWidth: 1,
    borderBottomColor: color.ruleStrong,
  },
  histRow: {
    justifyContent: 'center',
    minHeight: 60,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  histRowPressed: {
    backgroundColor: color.fillPress,
  },
  histLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The token's icon at a row's start; a row with no amount keeps its room, so the titles stay aligned.
  histIcon: {
    marginEnd: space.s12,
  },
  // The detail screen's amount: the token's icon, then the figure and its symbol on one line.
  txDetailLeg: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s12,
    marginTop: space.s8,
  },
  txDetailLegText: {
    flex: 1,
    marginTop: 0,
    alignSelf: 'center',
  },
  histIconBlank: {
    width: 30,
    marginEnd: space.s12,
  },
  histMiddle: {
    flex: 1,
    minWidth: 0,
    marginEnd: space.s8,
  },
  histTitle: {
    ...type('row', 15),
    color: color.paper,
  },
  histSub: {
    ...type('data', 12),
    color: color.fog,
    marginTop: 2,
  },
  // The line under the title: whom with, then the status of a row not final, which wraps under it when both do not fit.
  histSubLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.s8,
  },
  histParty: {
    flexShrink: 1,
  },
  // The amounts take at most 45% of the row, so what happened and whom with keep the rest: a compact number (at most 11
  // characters) and a short symbol fit there whole at 320 dp, and a long symbol gives way first.
  histRight: {
    flexShrink: 1,
    maxWidth: '45%',
    alignItems: 'flex-end',
  },
  // Amounts too long to sit beside the title: on a line of their own under it, the whole width, at its end.
  histWide: {
    alignItems: 'flex-end',
    marginTop: space.s4,
  },
  histAmountWide: {
    flexShrink: 1,
  },
  // An amount reads left to right in every language: the sign, the number, the symbol.
  histAmountLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    maxWidth: '100%',
    direction: 'ltr',
  },
  // A single amount with a long symbol: the number, and the symbol under it at the line's end.
  histAmountStack: {
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  histAmountLineNext: {
    marginTop: 2,
  },
  // The number keeps its full width; only the symbol after it gives way.
  histAmount: {
    ...type('amount'),
    flexShrink: 0,
    writingDirection: 'ltr',
  },
  // A symbol longer than about six characters ends in an ellipsis (its detail screen and the row's label say it whole).
  histSymbol: {
    ...type('data'),
    flexShrink: 1,
    maxWidth: 64,
  },
  // Under its number, a symbol is no wider than the longest number (about ten characters) so it never widens the column.
  histSymbolStacked: {
    ...type('data'),
    maxWidth: 80,
    marginTop: 1,
    writingDirection: 'ltr',
  },
  // A row's status while it is not final, after whom it was with on the line under its title.
  histStatus: {
    ...type('note', 12),
  },
  histStatus_pending: { color: color.fog },
  histStatus_moving: { color: color.fog },
  histStatus_failed: { color: color.ember },
  histStatus_dropped: { color: color.ember },
  histStatus_unverified: { color: color.fog },
  histStatus_included: { color: color.fog },
  // The detail screen of one transaction: its fields' rows.
  txDetailCard: {
    marginBottom: space.s16,
  },
  txDetailAmount: {
    ...type('figure'),
    marginTop: space.s8,
    writingDirection: 'ltr',
    alignSelf: 'flex-start',
  },
  txDetailBadge: {
    marginTop: space.s8,
    marginBottom: space.s16,
  },
  txDetailWarning: {
    ...type('note', 12),
    color: color.ember,
    marginTop: space.s8,
  },
  txErrorMessage: {
    ...type('body'),
    color: color.ember,
    marginBottom: space.s24,
  },
  nodeMonitoringTitle: {
    ...type('h3'),
    color: color.paper,
  },
  nodeExplainer: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s8,
  },
  // A tile of the Node tab (the node, its balance, its status), the same rounded element as a token on Assets.
  nodeGroup: {
    padding: space.s16,
    marginBottom: space.s12,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.rule,
    backgroundColor: color.surface,
  },
  // The node tile's head: the status chip before the type on one row, the whole name under them.
  nodeHead: {
    rowGap: space.s8,
    marginBottom: space.s12,
  },
  nodeHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: space.s12,
    rowGap: space.s8,
  },
  nodeName: {
    ...type('data'),
    color: color.fog,
    writingDirection: 'ltr',
  },
  nodeChip: {
    alignSelf: 'flex-start',
    paddingVertical: space.s4,
    paddingHorizontal: space.s12,
    borderRadius: radius.tile,
    borderWidth: 1,
  },
  nodeChipLive: {
    borderColor: color.signalLine,
    backgroundColor: color.fillPress,
  },
  nodeChipNeeds: {
    borderColor: color.ember,
  },
  // The epoch so far (NodeTab EpochBar): a track, its filled part, and the mark where it stands now.
  epochBar: {
    height: 6,
    borderRadius: radius.dot,
    backgroundColor: color.rule,
    marginTop: space.s4,
    marginBottom: space.s12,
    justifyContent: 'center',
  },
  epochFill: {
    position: 'absolute',
    start: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.dot,
    backgroundColor: color.edge,
  },
  epochFillYes: {
    backgroundColor: color.signalLine,
  },
  epochMark: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: radius.tile,
    marginStart: -6,
    borderWidth: 2,
    borderColor: color.surface,
  },
  epochMarkYes: {
    backgroundColor: color.signal,
  },
  epochMarkNo: {
    backgroundColor: color.fog,
  },
  // The one action for what needs care (the background restriction), under the rows of its tile.
  nodeCare: {
    marginTop: space.s12,
  },
  // The Node tab's title, pinned over its scroll so the tiles pass under it and it is never cut.
  stickyHead: {
    backgroundColor: color.ink,
  },
  // The node balance: the one big figure of the tab, in Signal while it can move now.
  nodeFigure: {
    ...type('figure'),
    color: color.paper,
    writingDirection: 'ltr',
    marginBottom: space.s16,
    alignSelf: 'flex-start',
  },
  nodeFigureLive: {
    color: color.signal,
  },
  // A light node under its wallet's server node: its tiles after a wider gap.
  nodeSecond: {
    paddingTop: space.s12,
  },
  // Offline, or waiting for admission: a word that asks for something.
  statusNeeds: {
    color: color.ember,
  },
  // The Node tab's status tile: the epoch bar and its label and value rows (components/InfoRow).
  rewardsCard: {
    padding: space.s16,
    marginBottom: space.s12,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.rule,
    backgroundColor: color.surface,
  },
  // A group's kicker, a strong rule under it.
  rewardsTitle: {
    ...type('label'),
    color: color.fog,
    paddingBottom: space.s8,
    marginBottom: space.s8,
    borderBottomWidth: 1,
    borderBottomColor: color.ruleStrong,
  },
  // A quiet line in a Node tab group (a refusal's reason, the licence, a ban's reason).
  rewardHint: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s12,
  },
  // The phrase check's refusal: an Ember line, no box.
  verificationErrorText: {
    ...type('body'),
    color: color.ember,
    marginBottom: space.s16,
  },
  // The terms line: the box, then the sentence.
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s12,
    marginVertical: space.s16,
  },
  termsText: {
    ...type('note', 14),
    flex: 1,
    color: color.text,
  },
  termsLink: {
    ...type('note', 14),
    color: color.signal,
    textDecorationLine: 'underline',
    textDecorationColor: color.signalLine,
  },
  // The terms' window: its sheet (components/ui/Sheet) over the screen.
  termsModal: {
    flex: 1,
  },
  termsModalText: {
    ...type('body'),
    color: color.text,
  },
  termsModalLink: {
    color: color.signal,
    textDecorationLine: 'underline',
    textDecorationColor: color.signalLine,
    alignSelf: 'flex-start',
    marginTop: space.s12,
  },
  // The app's mark above its name on the screens that hold no data, and the lock screen's "forgot" act under the unlock.
  lockLogo: {
    width: 64,
    height: 64,
    alignSelf: 'flex-start',
    marginBottom: space.s8,
  },
  lockForgot: {
    marginTop: space.s16,
  },
  // A waiting request or the screen-reading apps, above the unlock.
  lockNote: {
    ...type('note'),
    color: color.ember,
    marginBottom: space.s16,
  },
  lockField: {
    marginTop: space.s16,
  },
  // What the lock screen says when an unlock did not open the wallet: under the field, wrapping at any text size.
  lockMessage: {
    ...type('note', 14),
    alignSelf: 'stretch',
    color: color.ember,
    marginTop: 0,
    marginBottom: space.s16,
  },
  lockoutText: {
    ...type('body'),
    color: color.ember,
    marginTop: space.s16,
  },
}));

export default styles;
