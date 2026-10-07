#!/usr/bin/env node
// The dependency gate of the explorer (npm run audit:check; npm run check:release runs it too):
// - runs `npm audit --json` in the workspace root, where the lockfile is, with and without --omit=dev, and
//   fails on every advisory that npm-audit-allowlist.json does not name with a reason and an `until` date that
//   has not passed;
// - fails when the Next.js major that package.json pins, or the Node.js major its `engines` names, is past the
//   end of its security support in release-support.json, or has no entry there, and warns ahead of that date.
//   npm audit never reports a release line that is out of support: its unfixed advisories simply have no fixed
//   version on that line (SITE-R5-CSP-01).
//
// An entry npm lists only because a dependency of it is vulnerable (its `via` names another package) is
// judged by that package's own advisories, so an allow-listed advisory does not fail its dependents.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = join(FRONTEND, '..');

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The end of a YYYY-MM-DD day in UTC, or NaN for anything else.
function endOfDay(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return Number.NaN;
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== date ? Number.NaN : start + DAY_MS - 1;
}

export function loadAllowlist(path = join(FRONTEND, 'npm-audit-allowlist.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).advisories;
}

export function loadSupport(path = join(FRONTEND, 'release-support.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const advisoryId = (via) => (String(via.url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i) || [null])[0];

// Whether an allowlist entry still explains an advisory at `now`: a reason, and an `until` day not yet over.
export function entryLive(entry, now = Date.now()) {
  return typeof entry?.why === 'string' && entry.why.trim().length > 0 && endOfDay(entry.until) >= now;
}

// The advisories of an `npm audit --json` report that the allowlist does not explain, one line each.
export function unexplained(report, allow, now = Date.now()) {
  const out = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of Array.isArray(v.via) ? v.via : []) {
      if (typeof via !== 'object' || via === null) continue; // "via another package": judged under that package
      const id = advisoryId(via);
      const entry = id === null ? undefined
        : allow.find((a) => a.id.toLowerCase() === id.toLowerCase() && a.package === (via.name || name));
      if (entry === undefined || !entryLive(entry, now)) {
        const expired = entry !== undefined && endOfDay(entry.until) < now ? ` [allowlist entry expired ${entry.until}]` : '';
        out.push(`${via.name || name} ${id || via.source || '?'} (${via.severity || v.severity}): ${via.title || ''}${expired}`);
      }
    }
  }
  return out;
}

// Allowlist entries no report mentions any more: to be removed.
export function stale(reports, allow) {
  const seen = new Set();
  for (const report of reports) {
    for (const v of Object.values(report?.vulnerabilities ?? {})) {
      for (const via of Array.isArray(v.via) ? v.via : []) {
        if (typeof via === 'object' && via !== null && advisoryId(via)) seen.add(advisoryId(via).toLowerCase());
      }
    }
  }
  return allow.filter((a) => !seen.has(a.id.toLowerCase())).map((a) => a.id);
}

// The release lines the site runs on, as its package.json pins them: the major of the exact `next` version,
// and the Node.js major of `engines` (">=N": the deploy scripts install NODE_MAJOR N, deploy-config.test.mjs).
export function pinnedLines(pkg) {
  const next = /^(\d+)\.\d+\.\d+$/.exec(pkg?.dependencies?.next ?? '');
  const node = /^>=(\d+)$/.exec(pkg?.engines?.node ?? '');
  return [
    { name: 'next', major: next ? Number(next[1]) : null, pinned: pkg?.dependencies?.next ?? null },
    { name: 'node', major: node ? Number(node[1]) : null, pinned: pkg?.engines?.node ?? null },
  ];
}

// Each pinned line against its security support at `now`: problems (past its end, no entry, or no exact
// pin) and warnings (its end within `support.warnDays`).
export function supportStatus(lines, support, now = Date.now()) {
  const problems = [];
  const warnings = [];
  const warnMs = (Number.isSafeInteger(support?.warnDays) && support.warnDays > 0 ? support.warnDays : 90) * DAY_MS;
  for (const line of lines) {
    if (line.major === null) {
      problems.push(`${line.name}: the pin ${JSON.stringify(line.pinned)} names no single major release line`);
      continue;
    }
    const entry = (support?.lines ?? []).find((l) => l.name === line.name && l.major === line.major);
    const end = endOfDay(entry?.securityUntil);
    if (entry === undefined || Number.isNaN(end)) {
      problems.push(`${line.name} ${line.major}.x: no security support date in release-support.json`);
    } else if (now > end) {
      problems.push(`${line.name} ${line.major}.x: security support ended ${entry.securityUntil} (${entry.source}); upgrade to a supported line`);
    } else if (end - now <= warnMs) {
      warnings.push(`${line.name} ${line.major}.x: security support ends ${entry.securityUntil} (${entry.source}); plan the upgrade`);
    }
  }
  return { problems, warnings };
}

export function audit(args = [], cwd = WORKSPACE) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    return JSON.parse(execFileSync(npm, ['audit', '--json', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }));
  } catch (e) {
    // npm exits non-zero whenever it found something; its report is still on stdout.
    if (e && typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) return JSON.parse(e.stdout);
    throw e;
  }
}

export function check(now = Date.now()) {
  const allow = loadAllowlist();
  const full = audit();
  const prod = audit(['--omit=dev']);
  if (full.error || prod.error) throw new Error(`npm audit failed: ${JSON.stringify(full.error || prod.error)}`);
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'));
  const support = supportStatus(pinnedLines(pkg), loadSupport(), now);
  const problems = [...new Set([...unexplained(full, allow, now), ...unexplained(prod, allow, now)]), ...support.problems];
  return { problems, warnings: support.warnings, stale: stale([full, prod], allow), flagged: Object.keys(full.vulnerabilities ?? {}).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { problems, warnings, stale: old, flagged } = check();
  for (const line of warnings) console.warn(`warning: ${line}`);
  if (old.length) console.warn(`npm-audit-allowlist.json names advisories npm no longer reports (remove them): ${old.join(', ')}`);
  if (problems.length) {
    console.error('The dependency gate failed:');
    for (const line of problems) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`npm audit: ${flagged ? `${flagged} package(s) flagged, every advisory explained in npm-audit-allowlist.json` : 'clean'}; release lines within security support.`);
}
