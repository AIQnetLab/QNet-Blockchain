// The dependency gate of the explorer workspace (scripts/audit-check.mjs, npm-audit-allowlist.json): the
// workspace root installs nothing of its own, so `npm ci` on the host installs only what the site uses, and
// the gate fails on any advisory without a reason. The live audit is in npm run check:release (it needs the
// registry). Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAllowlist, loadSupport, pinnedLines, stale, supportStatus, unexplained } from '../../../scripts/audit-check.mjs';
import { LOCKFILE, unpinned } from '../../../scripts/lockfile-check.mjs';

const WORKSPACE = new URL('../../../../', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, WORKSPACE), 'utf8'));

test('the workspace root has no dependencies of its own, and the lockfile none that the site does not use', () => {
  const root = json('package.json');
  assert.deepEqual(root.workspaces, ['frontend']);
  assert.equal(root.dependencies, undefined);
  assert.equal(root.devDependencies, undefined);
  const lock = json('package-lock.json');
  assert.deepEqual(Object.keys(lock.packages['']).filter((k) => /dependencies/i.test(k)), []);
  // react-simple-maps, never imported, pulled d3-color (GHSA-36jr-mh4h-2g58) onto the production host.
  for (const name of ['react-simple-maps', 'd3-color', 'd3-zoom', 'd3-geo']) {
    assert.equal(lock.packages[`node_modules/${name}`], undefined, name);
  }
});

// SITE-R4-DEP-01: 380 of 500 entries had neither `resolved` nor `integrity`, @noble/hashes (the faucet
// signer's and the /activate key exchange's SHA-512) among them, so `npm ci` on the host took whatever tarball
// its configured registry served for that version. Every installed entry now pins its tarball by hash.
test('every package of the lockfile pins its tarball: a registry URL and a sha512 integrity', () => {
  const lock = json('package-lock.json');
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(fileURLToPath(new URL('package-lock.json', WORKSPACE)), LOCKFILE);
  const installed = Object.entries(lock.packages).filter(([key, entry]) => key.includes('node_modules/') && !entry.link);
  assert.ok(installed.length > 400, `${installed.length} installed packages`);
  assert.deepEqual(unpinned(lock), []);
  // Only the workspace link and the workspace folder itself carry no tarball.
  const rest = Object.entries(lock.packages).filter(([key, entry]) => !key.includes('node_modules/') || entry.link).map(([key]) => key);
  assert.deepEqual(rest.sort(), ['', 'frontend', 'node_modules/qnet-explorer-frontend']);
  assert.deepEqual(lock.packages['node_modules/qnet-explorer-frontend'], { resolved: 'frontend', link: true });
  // The two noble libraries the site's own crypto uses are among them.
  for (const key of ['node_modules/@noble/curves', 'node_modules/@noble/hashes']) assert.match(lock.packages[key]?.integrity ?? '', /^sha512-/, key);

  // The gate itself: an entry without integrity, or from another registry, is named.
  const entry = (extra) => ({ lockfileVersion: 3, packages: { '': {}, 'node_modules/x': { version: '1.0.0', ...extra } } });
  const pinned = { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==` };
  assert.deepEqual(unpinned(entry(pinned)), []);
  assert.deepEqual(unpinned(entry({})), ['node_modules/x: no sha512 integrity']);
  assert.deepEqual(unpinned(entry({ ...pinned, integrity: 'sha1-abc' })), ['node_modules/x: no sha512 integrity']);
  assert.deepEqual(unpinned(entry({ ...pinned, resolved: 'https://mirror.example/x-1.0.0.tgz' })), ['node_modules/x: resolved https://mirror.example/x-1.0.0.tgz']);
  assert.deepEqual(unpinned({ lockfileVersion: 1, dependencies: {} }), ['the lockfile is not an npm lockfile of version 3']);
  // The lockfile as HEAD had it (380 of 500 entries without either field) fails.
  const stripped = structuredClone(lock);
  delete stripped.packages['node_modules/@noble/hashes'].integrity;
  assert.deepEqual(unpinned(stripped), ['node_modules/@noble/hashes: no sha512 integrity']);
});

// The deploy scripts check the lockfile before every `npm ci`.
test('every npm ci of the deploy scripts runs after the lockfile gate', () => {
  const REPO = new URL('../../../../../../', import.meta.url);
  for (const path of ['deployment/deploy-aiqnet.sh', 'deployment/deploy-to-1984.sh']) {
    const text = readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n');
    const installs = [...text.matchAll(/^(\s*)npm ci$/gm)];
    assert.ok(installs.length >= 2, path);
    for (const m of installs) {
      const before = text.slice(0, m.index).trimEnd().split('\n').pop().trim();
      assert.equal(before, 'node scripts/lockfile-check.mjs', `${path}: the line before npm ci`);
    }
  }
});

const advisory = (name, id, severity = 'high') => ({ name, url: `https://github.com/advisories/${id}`, severity, title: 't' });
const day = (date) => Date.parse(`${date}T12:00:00Z`);

// The gate's logic, on an allowlist of its own (the site's is empty since Next.js 16).
const FIXTURE = [
  { id: 'GHSA-qx2v-qp2m-jg93', package: 'postcss', path: 'next > postcss', why: 'build time only', until: '2026-10-21' },
  { id: 'GHSA-6g55-p6wh-862q', package: 'postcss', path: 'next > postcss', why: 'build time only', until: '2026-10-21' },
];

test('the gate passes an allow-listed advisory and its dependents until the entry\'s date, and fails any other', () => {
  const allow = FIXTURE;
  const before = day('2026-10-21');
  const known = {
    vulnerabilities: {
      postcss: { severity: 'high', via: allow.map((a) => advisory('postcss', a.id)) },
      next: { severity: 'moderate', via: ['postcss'] },
    },
  };
  assert.deepEqual(unexplained(known, allow, before), []);
  assert.deepEqual(stale([known], allow), []);

  const fresh = {
    vulnerabilities: {
      ...known.vulnerabilities,
      'd3-color': { severity: 'high', via: [advisory('d3-color', 'GHSA-36jr-mh4h-2g58')] },
      'react-simple-maps': { severity: 'high', via: ['d3-zoom'] },
    },
  };
  assert.deepEqual(unexplained(fresh, allow, before), ['d3-color GHSA-36jr-mh4h-2g58 (high): t']);
  // The id alone is not enough: the package must match, and so must a reason.
  const wrongPackage = { vulnerabilities: { other: { severity: 'high', via: [advisory('other', allow[0].id)] } } };
  assert.equal(unexplained(wrongPackage, allow, before).length, 1);
  assert.equal(unexplained(known, allow.map((a) => ({ ...a, why: ' ' })), before).length, allow.length);
  assert.deepEqual(stale([{ vulnerabilities: {} }], allow), allow.map((a) => a.id));

  // SITE-R5-CSP-01: a reason that waits for an upgrade expires. The day after `until` the advisory fails again,
  // and so does an entry without a valid date.
  assert.deepEqual(unexplained(known, allow, day('2026-10-22')), [
    'postcss GHSA-qx2v-qp2m-jg93 (high): t [allowlist entry expired 2026-10-21]',
    'postcss GHSA-6g55-p6wh-862q (high): t [allowlist entry expired 2026-10-21]',
  ]);
  for (const until of [undefined, '', '2026-13-01', '2026-02-30', '21.10.2026', 20261021]) {
    assert.equal(unexplained(known, allow.map((a) => ({ ...a, until })), before).length, allow.length, String(until));
  }
});

// SITE-R5-CSP-01: npm audit never reports a framework line that is out of support (its unfixed advisories have
// no fixed version on that line), so the gate compares the pinned lines with their security support dates.
test('the gate fails on a release line past its security support or without a date, and warns ahead', () => {
  const support = {
    warnDays: 90,
    lines: [
      { name: 'next', major: 15, securityUntil: '2026-10-21', source: 's' },
      { name: 'next', major: 16, securityUntil: '2027-10-21', source: 's' },
      { name: 'node', major: 22, securityUntil: '2027-04-30', source: 's' },
    ],
  };
  const lines = (next, node) => pinnedLines({ dependencies: { next }, engines: { node } });
  assert.deepEqual(lines('16.3.6', '>=22'), [
    { name: 'next', major: 16, pinned: '16.3.6' }, { name: 'node', major: 22, pinned: '>=22' },
  ]);
  assert.deepEqual(supportStatus(lines('16.3.6', '>=22'), support, day('2026-09-25')), { problems: [], warnings: [] });
  // Next.js 15 as this site ran it: a warning from July 2026, a failure from 22 October 2026.
  assert.deepEqual(supportStatus(lines('15.5.26', '>=22'), support, day('2026-09-25')).warnings,
    ['next 15.x: security support ends 2026-10-21 (s); plan the upgrade']);
  assert.deepEqual(supportStatus(lines('15.5.26', '>=22'), support, day('2026-10-21')).problems, []);
  assert.deepEqual(supportStatus(lines('15.5.26', '>=22'), support, day('2026-10-22')).problems,
    ['next 15.x: security support ended 2026-10-21 (s); upgrade to a supported line']);
  assert.deepEqual(supportStatus(lines('16.3.6', '>=22'), support, day('2027-05-01')).problems,
    ['node 22.x: security support ended 2027-04-30 (s); upgrade to a supported line']);
  // A line without an entry, or a pin that names no single line, fails too.
  assert.deepEqual(supportStatus(lines('17.0.0', '>=24'), support, day('2026-09-25')).problems,
    ['next 17.x: no security support date in release-support.json', 'node 24.x: no security support date in release-support.json']);
  assert.equal(supportStatus(lines('^16.3.6', '>=22'), support, day('2026-09-25')).problems.length, 1);
  assert.equal(supportStatus(lines('16.3.6', '^22'), support, day('2026-09-25')).problems.length, 1);
});

test('the site pins a Next.js and a Node.js line that release-support.json dates, and the allowlist entries carry dates', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.next, '16.3.6');
  const support = loadSupport();
  for (const line of pinnedLines(pkg)) {
    const entry = support.lines.find((l) => l.name === line.name && l.major === line.major);
    assert.ok(entry, `${line.name} ${line.major}`);
    assert.match(entry.securityUntil, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.source, /^https:\/\//);
  }
  // Next.js 16: Maintenance LTS ends two years after its first release (nextjs.org/support-policy).
  assert.deepEqual(support.lines.find((l) => l.name === 'next' && l.major === 16), {
    name: 'next', major: 16, released: '2025-10-21', securityUntil: '2027-10-21', source: 'https://nextjs.org/support-policy',
    rule: 'Active LTS until the next major is released, then Maintenance LTS (critical and security fixes only) until two years after the major\'s first release.',
  });
  // The PostCSS entries that waited for Next.js 16 are gone with it: its bundled PostCSS has the fix.
  const lock = json('package-lock.json');
  assert.equal(lock.packages['node_modules/next'].version, '16.3.6');
  assert.equal(lock.packages['node_modules/next/node_modules/postcss'].version, '8.5.23');
  for (const a of loadAllowlist()) {
    assert.match(a.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/, a.id);
    assert.ok(typeof a.package === 'string' && a.package.length > 0, a.id);
    assert.ok(typeof a.path === 'string' && a.path.includes(a.package), a.id);
    assert.ok(typeof a.why === 'string' && a.why.length >= 80, a.id);
    assert.match(a.until, /^\d{4}-\d{2}-\d{2}$/, a.id);
  }
  // The release checklist runs the live audit and the support check.
  assert.equal(pkg.scripts['audit:check'], 'node scripts/audit-check.mjs');
  assert.match(readFileSync(new URL('../__release__/npm-audit.release.test.mjs', import.meta.url), 'utf8'), /check\(\)/);
});
