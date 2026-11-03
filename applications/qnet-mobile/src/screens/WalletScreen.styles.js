import { StyleSheet } from 'react-native';
import { card, color, radius, sheet, size, space, systemFace, themed } from '../theme';

// One centred column of at most 640 on every screen, so a tablet or a wide window shows the phone layout, not lines
// stretched across the screen. Flex only: nothing reads the window width. Its content is start-aligned and vertically
// centred.
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
  subtitle: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s32,
  },
  // The app's name on the welcome screen in the system face, bold, at 28, in every script; in Signal, centred under the
  // mark. Its line is the title role's at 28, so a 568 dp screen holds it.
  welcomeTitle: {
    ...systemFace('title'),
    fontSize: 28,
    lineHeight: type('title', 28).lineHeight,
    includeFontPadding: false,
    color: color.signal,
    textAlign: 'center',
    marginBottom: space.s8,
  },
  // The line under the app's mark on the screens that hold no data, centred under it as the mark is; the column's gap
  // keeps the actions at the foot, so a 568 dp screen holds the welcome screen whole.
  markLine: {
    textAlign: 'center',
    marginBottom: space.s16,
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
  // A group of Settings (WalletScreen SettingGroup): its kicker over its rows, a strong rule under it.
  settingGroup: {
    marginBottom: space.s32,
  },
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
  // A new wallet's phrase: its Copy button between the words and the warnings.
  seedCopy: {
    marginBottom: space.s16,
  },
  // An address in one rounded element a tap copies: the address (one line on Assets, whole on Receive) and the copy
  // glyph on its line (components/ui/Copyable), centred in the element's height.
  addressPill: {
    ...card,
    justifyContent: 'center',
    minHeight: size.rowMin,
    paddingVertical: space.s12,
    paddingHorizontal: space.s16,
    marginBottom: space.s16,
  },
  addressPillDone: {
    borderColor: color.signalLine,
  },
  addressPillText: {
    ...type('address', 14),
    color: color.paper,
    writingDirection: 'ltr',
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
  // half its size goes under the token, whole (screens/TokenScreens AssetRow).
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
    ...card,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.s12,
    paddingHorizontal: space.s16,
    marginBottom: space.s8,
  },
  tokenIcon: {
    marginEnd: space.s12,
  },
  tokenItemWrap: {
    flexWrap: 'wrap',
  },
  // A token's own screen (screens/TokenScreens): its icon beside its name and symbol under Back, the warning about a
  // token the wallet does not know, its balance, and the head of its transfers with Show all at its end.
  tokenHead: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s12,
  },
  tokenHeadText: {
    flex: 1,
    minWidth: 0,
  },
  tokenHeadSymbol: {
    ...type('data'),
    color: color.fog,
    marginTop: space.s4,
  },
  tokenWarning: {
    ...type('body'),
    color: color.ember,
    paddingVertical: space.s12,
  },
  tokenBalanceRow: {
    paddingVertical: space.s12,
  },
  tokenBalanceFigure: {
    ...type('amount', 18),
    color: color.paper,
    writingDirection: 'ltr',
  },
  tokenActivityHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space.s12,
  },
  tokenActivityTitle: {
    flexShrink: 1,
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
  txResultOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: color.ink,
  },
  // Transaction result (components/TxResultCard): what happened, the details' card under it, start-aligned in the
  // column; the actions at the foot, out of the scroll.
  txResultScreen: {
    flex: 1,
  },
  txResultScroll: {
    flex: 1,
  },
  txResultBody: {
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    paddingHorizontal: space.gut,
    paddingTop: space.s24,
    paddingBottom: space.s16,
  },
  txResultHead: {
    alignItems: 'stretch',
    marginBottom: space.s24,
  },
  txResultStatus: {
    alignSelf: 'flex-start',
    marginBottom: space.s12,
  },
  txResultTitle: {
    ...type('title'),
    color: color.paper,
  },
  txResultTitleFailed: {
    color: color.ember,
  },
  txResultAmount: {
    ...type('figure'),
    color: color.paper,
    marginTop: space.s16,
    alignSelf: 'flex-start',
  },
  txResultNote: {
    ...type('body'),
    color: color.text,
    marginTop: space.s12,
  },
  txResultError: {
    ...type('body'),
    color: color.ember,
    marginTop: space.s12,
  },
  // The foot: a hairline over it, so what scrolls ends there and does not run under the actions.
  txResultFoot: {
    borderTopWidth: 1,
    borderTopColor: color.rule,
    backgroundColor: color.ink,
  },
  txResultActions: {
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    rowGap: space.s12,
    paddingHorizontal: space.gut,
    paddingTop: space.s16,
    paddingBottom: space.s16,
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
  // History (screens/HistoryTab): a header per day over its cards, one card per transaction, the amount never cut.
  histDay: {
    ...type('label'),
    color: color.fog,
    marginTop: space.s16,
    marginBottom: space.s8,
  },
  histRow: {
    ...card,
    justifyContent: 'center',
    minHeight: 64,
    paddingVertical: space.s12,
    paddingHorizontal: space.s12,
    marginBottom: space.s8,
  },
  histLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The token's icon at a row's start; a row with no amount keeps its room, so the titles stay aligned.
  histIcon: {
    width: size.histIcon,
    height: size.histIcon,
    marginEnd: space.s12,
  },
  // A swap's two tokens in the icon's room: the one paid at the upper start, the one received in front at the lower end,
  // ringed in the card's colour where they overlap.
  histSwapBack: {
    position: 'absolute',
    top: 0,
    start: 0,
  },
  histSwapFront: {
    position: 'absolute',
    bottom: 0,
    end: 0,
    borderRadius: size.swapIcon / 2 + 2,
    borderWidth: 2,
    borderColor: color.surface,
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
  // A row's two lines beside its icon: what happened with the amount at its end, then whom with (a swap's second amount
  // at its end).
  histText: {
    flex: 1,
    minWidth: 0,
  },
  histTop: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s8,
  },
  histBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.s8,
    marginTop: 2,
  },
  histTitle: {
    ...type('row', 15),
    color: color.paper,
    flex: 1,
    minWidth: 0,
  },
  histSub: {
    ...type('data', 12),
    color: color.fog,
  },
  // The line under the title: whom with, then the status of a row not final, which wraps under it when both do not fit.
  histSubLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.s8,
  },
  histParty: {
    flexShrink: 1,
  },
  // An amount beside its line's words takes at most 60% of the row's text (HistoryTab AMOUNT_SHARE), so what happened
  // keeps the rest; within it the symbol keeps its room and the number shrinks to fit.
  histBeside: {
    flexShrink: 0,
    maxWidth: '60%',
  },
  // Amounts too long to sit beside the title: on a line of their own under the row, the whole width, at its end.
  histWide: {
    alignItems: 'flex-end',
    marginTop: space.s4,
  },
  // An amount reads left to right in every language: the sign, the number, the symbol.
  histAmountLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    maxWidth: '100%',
    direction: 'ltr',
  },
  histAmountLineNext: {
    marginTop: 2,
  },
  histAmount: {
    ...type('amount'),
    flexShrink: 1,
    writingDirection: 'ltr',
  },
  // A symbol longer than about six characters ends in an ellipsis (its detail screen and the row's label say it whole);
  // HistoryTab SYMBOL_ROOM.
  histSymbol: {
    ...type('data'),
    flexShrink: 0,
    maxWidth: 64,
  },
  // A row's status while it is not final, after whom it was with on the line under its title.
  histStatus: {
    ...type('note', 12),
  },
  histStatus_pending: { color: color.fog },
  histStatus_moving: { color: color.fog },
  histStatus_failed: { color: color.ember },
  histStatus_expired: { color: color.ember },
  histStatus_unverified: { color: color.fog },
  histStatus_included: { color: color.fog },
  // The detail screen of one transaction: the section of its fields' rows under the amount, its action under it.
  txDetailCard: {
    marginTop: space.s16,
    marginBottom: space.s16,
  },
  txDetailAmount: {
    ...type('figure'),
    marginTop: space.s8,
    writingDirection: 'ltr',
    alignSelf: 'flex-start',
  },
  txDetailWarning: {
    ...type('note', 12),
    color: color.ember,
    paddingVertical: space.s12,
  },
  nodeMonitoringTitle: {
    ...type('h3'),
    color: color.paper,
  },
  // A sentence of the Node tab: what a state means, alone in its section or over the rows.
  nodeExplainer: {
    ...type('body'),
    color: color.text,
    paddingVertical: space.s12,
  },
  // The node's identity section: the status chip before the type on one row, the whole name under them.
  nodeHead: {
    rowGap: space.s8,
    paddingVertical: space.s16,
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
    borderRadius: radius.pill,
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
    borderRadius: radius.pill,
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
  // The one action for what needs care (the background restriction, Use this device), between the status rows.
  nodeCare: {
    marginVertical: space.s12,
  },
  // What the node's state asks for or waits for, under the status rows it follows.
  nodeNote: {
    ...type('note'),
    color: color.text,
    paddingBottom: space.s12,
  },
  // Move to wallet: the status section's last element, under the node balance's row.
  nodeMove: {
    marginTop: space.s4,
    marginBottom: space.s16,
  },
  // The Node tab's title, pinned over its scroll so the sections pass under it and it is never cut: its ink band starts
  // at the scroll view's edge (nodeScroll pads no top), so no section shows above it; at rest it sits as every tab's
  // title does.
  stickyHead: {
    backgroundColor: color.ink,
    paddingTop: space.gut,
  },
  nodeScroll: {
    paddingTop: 0,
  },
  // A light node under its wallet's server node: its sections after a wider gap.
  nodeSecond: {
    paddingTop: space.s12,
  },
  // Offline, or waiting for admission: a word that asks for something.
  statusNeeds: {
    color: color.ember,
  },
  // A quiet line in a Node tab section (a refusal's reason, the licence, a ban's reason).
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
  // The lock screen's "forgot" act under the unlock.
  lockForgot: {
    marginTop: space.s8,
  },
  // A waiting request or the screen-reading apps, above the unlock.
  lockNote: {
    ...type('note'),
    color: color.ember,
    marginBottom: space.s16,
  },
  // An answer to aiqnet.io still on its way (components/AnswerAway): above what the lock and welcome screens offer, and
  // under the header's row, in its column, on every tab.
  awayNote: {
    ...type('note'),
    color: color.fog,
    marginBottom: space.s16,
  },
  headerAway: {
    ...type('note'),
    color: color.fog,
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    paddingHorizontal: space.gut,
    paddingBottom: space.s8,
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
