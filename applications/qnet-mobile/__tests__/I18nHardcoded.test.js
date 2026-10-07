// No user-visible string is written into the UI code: every sentence, label, placeholder, alert and accessibility
// label comes from the translation tables (spec: i18n.md). A static scan of the screens' syntax trees; what may stay
// as written is an allow-list of tokens that are never translated (brands, env names, formats, glyphs).
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const root = path.join(__dirname, '..');
const UI_FILES = [
  'src/screens/WalletScreen.js',
  'src/screens/QNetLinkScreen.js',
  'src/screens/SolanaSend.js',
  'src/components/BottomBar.js',
  'src/components/TxResultCard.js',
  'src/components/SendReview.js',
  'src/components/ErrorBoundary.js',
  'src/browser/BrowserScreen.js',
  'src/browser/DappSheet.js',
  'App.tsx',
];

// Never translated: brands and networks, token symbols, env names, the typed confirmation word, code formats.
const ALLOWED_WORDS = new Set([
  'QNet', 'Solana', 'QNC', 'SOL', '1DEV', 'USDC', 'Testnet', 'Mainnet', 'GitHub', 'ERASE', 'aiqnet.io', 'INTERNAL',
]);
const ALLOWED_PATTERNS = [
  /^QNET_[A-Z_]+[:=]?$/, // server environment names
  /^[A-Z0-9]+(_[A-Z0-9]+)+$/, // protocol and error codes (NO_WALLET)
  /^(GET|POST|HEAD|PUT|DELETE)$/, // HTTP methods
  /^QNET-[A-Z0-9]+(-[A-Z0-9]+)*$/, // an activation code's shape
];
// JSX attributes that carry code, not text.
const CODE_ATTRIBUTES = new Set([
  'testID', 'key', 'style', 'keyboardType', 'autoCapitalize', 'autoComplete', 'returnKeyType', 'textContentType',
  'importantForAutofill', 'importantForAccessibility', 'accessibilityRole', 'accessibilityLiveRegion', 'behavior',
  'animationType', 'resizeMode', 'ellipsizeMode', 'pointerEvents', 'submitBehavior', 'mixedContentMode',
  'mediaCapturePermissionGrantType', 'dataDetectorTypes', 'placeholderTextColor', 'tintColor', 'titleColor', 'color',
  'backgroundColor', 'edges', 'barStyle', 'originWhitelist', 'd', 'viewBox', 'fill', 'stroke', 'strokeLinecap',
  'strokeLinejoin', 'name',
]);
// Calls whose string arguments are keys, logs or developer messages, not text on screen.
const KEY_CALLS = new Set(['t', 'tr', 'tt', 'translate', 'makeT', 'hasKey', 'errorText', 'require']);
const LOG_OBJECTS = new Set(['logger', 'console']);
// String methods: their arguments are patterns and prefixes the code works with.
const STRING_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'split', 'replace', 'match', 'test']);

const allowedWord = (w) => ALLOWED_WORDS.has(w) || ALLOWED_PATTERNS.some((re) => re.test(w));

/** Whether a literal reads as words a person would see. Code tokens (lowercase ids, keys, urls, camelCase) do not. */
function looksLikeText(raw) {
  const v = String(raw).replace(/\$\{[^}]*\}/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(v)) return false;
  if (/^https?:\/\//.test(v) || /^[a-z0-9_.:/\-#@?=&%*,() ]+$/.test(v) && !/ [a-z]{2,} [a-z]{2,}/.test(v)) return false;
  const words = v.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  const open = words.filter((w) => !allowedWord(w.replace(/[.,;:!?()]+$/, '')) && !allowedWord(w));
  if (open.length === 0) return false;
  if (words.length >= 2) return true;
  const w = open[0].replace(/[^A-Za-z]/g, '');
  return /^[A-Z][a-z]{2,}$/.test(w) || /^[A-Z]{3,}$/.test(w);
}

function calleeName(call) {
  const c = call.callee;
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const obj = c.object.type === 'Identifier' ? c.object.name : (c.object.type === 'MemberExpression' && c.object.property.name) || '';
    return `${obj}.${c.property.name || ''}`;
  }
  return '';
}

function scanText(file, text) {
  const lines = text.split(/\r?\n/);
  const ast = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript', 'classProperties'] });
  const found = [];
  const ignored = (line) => /i18n-ignore/.test(lines[line - 1] || '') || /i18n-ignore/.test(lines[line - 2] || '');

  const report = (node, value) => {
    const line = node.loc.start.line;
    if (!ignored(line)) found.push(`${file}:${line}: ${JSON.stringify(String(value).trim().slice(0, 80))}`);
  };

  const skipByContext = (stack) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i];
      const child = stack[i + 1];
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'TSTypeAnnotation') return true;
      if (n.type === 'ObjectProperty' && n.key === child && !n.computed) return true;
      if (n.type === 'JSXAttribute' && CODE_ATTRIBUTES.has(n.name.name)) return true;
      if (n.type === 'NewExpression' && /Error$/.test(n.callee.name || '')) return true;
      if (n.type === 'ThrowStatement') return true;
      if (n.type === 'CallExpression') {
        const name = calleeName(n);
        const base = name.split('.')[0];
        if (n.arguments.includes(child) || n.arguments.some((a) => a === child)) {
          if (KEY_CALLS.has(name) || name === 'tRef.current' || LOG_OBJECTS.has(base) || name === 'StyleSheet.create') return true;
        }
        if (name === 'StyleSheet.create' || LOG_OBJECTS.has(base)) return true;
        if (n.callee.type === 'MemberExpression' && STRING_METHODS.has(n.callee.property.name) && n.arguments.includes(child)) return true;
      }
      // `x === 'Literal'`: a comparison with a value, not text.
      if (n.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(n.operator)) return true;
      if (n.type === 'SwitchCase' && n.test === child) return true;
    }
    return false;
  };

  const visit = (node, stack) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'JSXText') {
      const v = node.value.trim();
      if (v && looksLikeText(v)) report(node, v);
    } else if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      const v = node.type === 'StringLiteral' ? node.value : node.quasis.map((q) => q.value.cooked).join('${x}');
      if (looksLikeText(v) && !skipByContext([...stack, node])) report(node, v);
    }
    stack.push(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c, stack));
      else if (v && typeof v.type === 'string') visit(v, stack);
    }
    stack.pop();
  };
  visit(ast.program, []);
  return found;
}

const scan = (file) => scanText(file, fs.readFileSync(path.join(root, file), 'utf8'));

describe('no hard-coded user-visible strings', () => {
  it('the scanner sees the kinds of text it must catch', () => {
    const probe = [
      "const a = () => <Text>Hello there</Text>;",
      "showAlert('Error', 'Something failed');",
      "const b = <TextInput placeholder=\"Enter address\" accessibilityLabel=\"Close\" />;",
      "const c = { text: 'Cancel', style: 'cancel' };",
      "const d = <Text>{loading ? 'Loading...' : t('x')}</Text>;",
      "const e = <Text>{t('ok')}</Text>;",
      "const f = <Text>QNet {net}</Text>;",
      "logger.log('Plain log line');",
      "if (x.type === 'NewBlock') {}",
      "throw new Error('Developer message');",
    ].join('\n');
    const found = scanText('probe.js', probe).map((s) => s.replace(/^.*?:(\d+): /, '$1 '));
    expect(found).toEqual(['1 "Hello there"', '2 "Error"', '2 "Something failed"', '3 "Enter address"', '3 "Close"',
      '4 "Cancel"', '5 "Loading..."']);
  });

  it.each(UI_FILES)('%s', (file) => {
    expect(scan(file)).toEqual([]);
  });

  // Arabic sets `direction: 'rtl'` on the screen; the renderer mirrors start/end then, but swaps physical left/right
  // only when the phone itself is right to left. Spacing is written as start/end so both cases mirror.
  it('spacing in the screens is start/end, never left/right', () => {
    for (const file of [...UI_FILES, 'src/screens/WalletScreen.styles.js']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      const found = text.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /\b(margin|padding)(Left|Right)\s*:/.test(l));
      expect([file, found]).toEqual([file, []]);
    }
  });

  it('native prompts get their titles from the tables, not from literals', () => {
    const wm = fs.readFileSync(path.join(root, 'src/components/WalletManager.js'), 'utf8');
    expect(wm).not.toMatch(/authenticationPrompt:\s*\{\s*title:\s*'/);
    expect(wm).not.toMatch(/biometricSealer\(\{\s*title:\s*'/);
    expect(wm).not.toMatch(/deviceAuthSecret\(title = '/);
    expect(wm).toMatch(/cancel: tr\('bio_use_password'\)/);
  });
});
