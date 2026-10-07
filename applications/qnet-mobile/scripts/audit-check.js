#!/usr/bin/env node
/**
 * The dependency audit gate for release and CI: runs `npm audit --omit=dev --json` and fails on every advisory that
 * npm-audit-allowlist.json does not name with a reason. Run it with `npm run audit:prod`.
 *
 * An entry npm lists only because a dependency of it is vulnerable (its `via` names another package) is judged by
 * that package's own advisories, so an allow-listed advisory does not fail its dependents.
 */
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const allow = require(path.join(root, 'npm-audit-allowlist.json')).advisories;

function audit() {
  try {
    return execSync('npm audit --omit=dev --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // npm exits non-zero whenever it found something; its report is still on stdout.
    if (e && typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) return e.stdout;
    throw e;
  }
}

const report = JSON.parse(audit());
const unexplained = [];
for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
  for (const via of Array.isArray(v.via) ? v.via : []) {
    if (typeof via !== 'object' || via === null) continue; // "via another package": judged under that package
    const id = (String(via.url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i) || [null])[0];
    const ok = id && allow.some((a) => a.id.toLowerCase() === id.toLowerCase() && a.package === (via.name || name)
      && typeof a.why === 'string' && a.why.trim().length > 0);
    if (!ok) unexplained.push(`${via.name || name} ${id || via.source || '?'} (${via.severity || v.severity}): ${via.title || ''}`);
  }
}

if (unexplained.length) {
  console.error('npm audit --omit=dev found advisories with no reason in npm-audit-allowlist.json:');
  for (const line of unexplained) console.error(`  - ${line}`);
  process.exit(1);
}
const total = Object.keys(report.vulnerabilities || {}).length;
console.log(`npm audit --omit=dev: ${total ? `${total} package(s) flagged, every advisory explained in npm-audit-allowlist.json` : 'clean'}.`);
