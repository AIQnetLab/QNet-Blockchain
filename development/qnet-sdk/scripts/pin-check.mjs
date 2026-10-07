#!/usr/bin/env node
// The SDK's release gate for the light-client pin it compiles in (DEVP-R1-02): `npm pack` runs it first
// (`npm run check:pin` alone). The pin is the mobile app's (applications/qnet-mobile/src/config/genesisConsensus.js,
// which only its scripts/ws-pin.js writes), judged by the app's own release rules (its scripts/release-check.js: a
// generated pin, proven from the previous one) with a shorter age limit, since a verified read of a fresh process walks
// from the pin, about 480 steps for every day of its age, before it can verify anything.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '../../../applications/qnet-mobile');
const { checkPin } = createRequire(import.meta.url)(path.join(MOBILE, 'scripts/release-check.js'));

/** How old the pin may be when the SDK is packed: 7 days, about 3,400 walk steps from a fresh process. */
export const SDK_PIN_MAX_AGE_DAYS = 7;

export const pinSource = () => readFileSync(path.join(MOBILE, 'src/config/genesisConsensus.js'), 'utf8');

/** The problems that stop packing the SDK, [] when its pin may ship. `today`: YYYY-MM-DD. */
export function checkSdkPin({ source = pinSource(), today }) {
  return checkPin({ source, today, maxAgeDays: SDK_PIN_MAX_AGE_DAYS })
    .map((p) => p.replace('run node scripts/ws-pin.js --write', 'run node scripts/ws-pin.js --write in applications/qnet-mobile'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const problems = checkSdkPin({ today: new Date().toISOString().slice(0, 10) });
  if (problems.length) {
    for (const p of problems) process.stderr.write(`pin-check: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write('pin-check: the light-client pin may ship\n');
}
