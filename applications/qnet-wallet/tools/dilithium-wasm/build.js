#!/usr/bin/env node
/**
 * Build script: bundles @noble/post-quantum ml_dsa65 into a standalone
 * browser IIFE at dist/lib/noble-pq-ml-dsa.js.
 *
 * Usage:
 *   node tools/dilithium-wasm/build.js          # from qnet-wallet root
 *   npm run build:dilithium                       # via npm script
 *
 * Output: dist/lib/noble-pq-ml-dsa.js (~17 KB minified)
 *   Sets window.QNetDilithiumLib = { QNetDilithium: { keygen, sign, verify, ... } }
 *
 * Algorithm: ML-DSA-65 (NIST FIPS 204)
 *   PK=1952 SK=4032 SIG=3309 (CTILDEBYTES=48)
 *   Byte-compatible with Android/iOS PQClean and Rust pqcrypto_mldsa.
 */

const { build } = require('esbuild');
const path = require('path');
const fs   = require('fs');

const ROOT    = path.resolve(__dirname, '../..');
const ENTRY   = path.join(__dirname, 'entry.js');
const OUTFILE = path.join(ROOT, 'dist/lib/noble-pq-ml-dsa.js');

fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });

build({
  entryPoints:  [ENTRY],
  bundle:       true,
  format:       'iife',
  globalName:   'QNetDilithiumLib',
  platform:     'browser',
  outfile:      OUTFILE,
  minify:       true,
  target:       ['chrome89', 'firefox89', 'safari15'],
  logLevel:     'info',
}).then(() => {
  const size = (fs.statSync(OUTFILE).size / 1024).toFixed(1);
  console.log(`[INFO][BUILD] noble-pq-ml-dsa.js → ${OUTFILE} (${size} KB)`);
  console.log('[INFO][BUILD] Sets window.QNetDilithiumLib.QNetDilithium: { keygen, sign, verify }');
  console.log('[INFO][BUILD] ML-DSA-65 PK=1952 SK=4032 SIG=3309 — FIPS 204 / PQClean compatible');
}).catch((err) => {
  console.error('[ERR][BUILD] esbuild failed:', err.message);
  process.exit(1);
});
