#!/usr/bin/env node
// The lockfile gate of the explorer workspace (SITE-R4-DEP-01): every package that the workspace lockfile
// installs pins its tarball, a registry.npmjs.org URL and a sha512 integrity, so `npm ci` refuses any other
// bytes for it, whatever registry or proxy the host is configured with. The deploy scripts run it before
// every `npm ci`; src/lib/__tests__/dependency-audit.test.mjs runs the same function.
//
// An entry without `integrity` is installed by version alone and checked only against the configured
// registry's own metadata, so a substituted tarball would not be noticed.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCKFILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package-lock.json');

const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

// The installed entries of a lockfile (v3 `packages`) whose tarball is not pinned, one line each.
export function unpinned(lock) {
  if (!lock || lock.lockfileVersion !== 3 || typeof lock.packages !== 'object' || lock.packages === null) {
    return ['the lockfile is not an npm lockfile of version 3'];
  }
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes('node_modules/') || entry?.link === true) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const base = name.startsWith('@') ? name.split('/')[1] : name;
    if (!INTEGRITY_RE.test(entry.integrity ?? '')) out.push(`${key}: no sha512 integrity`);
    else if (entry.resolved !== `https://registry.npmjs.org/${name}/-/${base}-${entry.version}.tgz`) out.push(`${key}: resolved ${entry.resolved}`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = unpinned(JSON.parse(readFileSync(LOCKFILE, 'utf8')));
  if (problems.length) {
    console.error(`package-lock.json installs ${problems.length} package(s) without a pinned tarball; regenerate it with npm before installing:`);
    for (const line of problems.slice(0, 50)) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('package-lock.json: every installed package pins its tarball (registry.npmjs.org, sha512).');
}
