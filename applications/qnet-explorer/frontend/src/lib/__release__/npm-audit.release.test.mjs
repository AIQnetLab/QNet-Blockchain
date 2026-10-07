// Release check (npm run check:release, not part of npm run test:wallet: it needs the npm registry): every
// advisory `npm audit` reports for the explorer workspace, with and without --omit=dev, is explained in
// npm-audit-allowlist.json by an entry whose date has not passed, and the pinned Next.js and Node.js lines are
// within their security support (release-support.json), today (scripts/audit-check.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../../../scripts/audit-check.mjs';

test('npm audit reports nothing the allowlist does not explain, and the release lines are supported', (t) => {
  const { problems, warnings, stale } = check();
  for (const line of warnings) t.diagnostic(`warning: ${line}`);
  assert.deepEqual(problems, []);
  assert.deepEqual(stale, [], 'allowlist entries npm no longer reports');
});
