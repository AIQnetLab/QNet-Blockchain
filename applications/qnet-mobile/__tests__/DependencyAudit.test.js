// MOBNET-R1-09: `npm audit --omit=dev` must be clean or every remaining advisory explained (npm-audit-allowlist.json,
// enforced by scripts/audit-check.js, `npm run audit:prod`). This keeps the explanations true: who depends on each
// allow-listed package, and that nothing the app ships can load it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm-audit-allowlist.json'), 'utf8')).advisories;
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const dependentsOf = (name) => Object.entries(lock.packages)
  .filter(([, v]) => ({ ...(v.dependencies || {}), ...(v.optionalDependencies || {}) })[name])
  .map(([k]) => k);

it('every allow-listed advisory has an id, a package and a reason, and the gate runs from package.json', () => {
  expect(allow.length).toBeGreaterThan(0);
  for (const a of allow) {
    expect(a.id).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    expect(typeof a.package).toBe('string');
    expect(a.why.length).toBeGreaterThan(80);
  }
  expect(pkg.scripts['audit:prod']).toBe('node scripts/audit-check.js');
  expect(fs.existsSync(path.join(ROOT, 'scripts', 'audit-check.js'))).toBe(true);
});

it('image-size is only the bundler\'s (Metro), and no app code requires it', () => {
  expect(dependentsOf('image-size')).toEqual(['node_modules/metro']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'App.tsx'), path.join(ROOT, 'index.js')]) {
    expect([f, /image-size/.test(fs.readFileSync(f, 'utf8'))]).toEqual([f, false]);
  }
});

it('stream-json is only jayson\'s, and the jayson client the app bundles cannot reach it', () => {
  expect(dependentsOf('stream-json')).toEqual(['node_modules/jayson']);
  const web3 = fs.readFileSync(path.join(ROOT, 'node_modules', '@solana', 'web3.js', 'lib', 'index.native.js'), 'utf8');
  const jaysonImports = [...web3.matchAll(/require\('(jayson[^']*)'\)/g)].map((m) => m[1]);
  expect([...new Set(jaysonImports)]).toEqual(['jayson/lib/client/browser']);
  // Walk jayson's relative requires from that entry: stream-json must not be among them.
  const base = path.join(ROOT, 'node_modules', 'jayson', 'lib');
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/require\('([^']+)'\)/g)) {
      if (spec.startsWith('.')) {
        let next = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(`${next}.js`)) next = `${next}.js`;
        else if (fs.existsSync(path.join(next, 'index.js'))) next = path.join(next, 'index.js');
        visit(next);
      } else {
        external.add(spec.split('/')[0]);
      }
    }
  };
  visit(path.join(base, 'client', 'browser', 'index.js'));
  expect(external.has('stream-json')).toBe(false);
  expect([...seen].some((f) => f.endsWith(`${path.sep}utils.js`))).toBe(false);
});
