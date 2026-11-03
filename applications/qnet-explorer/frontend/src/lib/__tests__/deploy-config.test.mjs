// How the site is deployed (deployment/deploy-aiqnet.sh, package.json): a supported Node.js line, in the CI too, the web
// tier as a systemd service of an unprivileged user and the indexer as one that runs releases of its own, each release
// built in a folder of its own and switched to at once, the app reachable only through nginx on the same host, the
// relay's and the cabinet's requests kept out of the access log and limited per address, and no other script of the
// repository (scripts/security_hardening.sh included) writing a site for those hosts. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSiteAllowed, activationOriginAllowed } from '../../server/request-guard.ts';
import { LIMITS } from '../../server/link-relay.ts';
import { CABINET_LIMITS } from '../../server/cabinet/limits.ts';
import { POLL_INTERVAL_MS } from '../qnet-link.ts';

const FRONTEND = new URL('../../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read(FRONTEND, 'package.json'));
const SCRIPT = read(REPO, 'deployment/deploy-aiqnet.sh');
const MIN_NODE = 22;

// The nginx site file the script writes: the heredoc after `cat > /etc/nginx/sites-available/`.
function nginxSite(text) {
  const at = text.indexOf('cat > /etc/nginx/sites-available/');
  assert.ok(at > -1, 'the nginx site file');
  const body = text.indexOf('\n', at) + 1;
  return text.slice(body, text.indexOf('\nEOF\n', body));
}

// The file the script writes to `target` with `cat > target << 'MARK'`.
function heredoc(target, mark = 'EOF') {
  const head = `cat > ${target} << '${mark}'\n`;
  const at = SCRIPT.indexOf(head);
  assert.ok(at > -1, target);
  const body = at + head.length;
  return SCRIPT.slice(body, SCRIPT.indexOf(`\n${mark}\n`, body) + 1);
}

// The systemd unit the update script writes for `name` once the release it names is built, and /root/update-aiqnet.sh:
// the one path that builds both trees, installs both units and restarts both services.
const unit = (name) => heredoc(`$UNIT_DIR/${name}.service.new`, 'UNIT');
const updateScript = () => heredoc('/root/update-aiqnet.sh');

// The test of the site file both nginx steps run: the text of NGINX_TEST as the script writes it.
function nginxTest() {
  const head = 'NGINX_TEST="';
  const at = SCRIPT.indexOf(head);
  assert.ok(at > -1, 'NGINX_TEST');
  return SCRIPT.slice(at + head.length, SCRIPT.indexOf('.previous"\n', at) + '.previous'.length);
}

// The remote text of step `n`: the `run_remote "` block after the step's banner.
function step(n) {
  const banner = SCRIPT.indexOf(`Step ${n}: `);
  assert.ok(banner > -1, `step ${n}`);
  const open = SCRIPT.indexOf('run_remote "\n', banner);
  return SCRIPT.slice(open, SCRIPT.indexOf('\n"\n', open) + 1);
}

// Each `sudo -u $USER -H bash -c '…' [args]` block of `text`: the user's variable, where it starts, its lines and the
// arguments it is given.
const sudoBlocks = (text) => [...text.matchAll(/^[ \t]*sudo -u \$(\w+) -H bash -c '\n([\s\S]*?)\n[ \t]*'( [^\n]*)?\n/gm)]
  .map((m) => ({ user: m[1], at: m.index, body: m[2], args: (m[3] ?? '').trim() }));

// Every `<keyword> … {` block of `text` at any depth whose opening line matches `opening`, braces matched.
function blocks(text, opening) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`^[ \\t]*${opening}[^\\n{]*\\{`, 'gm'))) {
    let depth = 0;
    let end = m.index;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    out.push(text.slice(m.index, end + 1));
  }
  return out;
}

const serversOf = (site) => blocks(site, 'server').map((block) => ({
  block,
  names: /\n\s*server_name ([^;]+);/.exec(block)[1].trim().split(/\s+/),
  tls: /\n\s*listen 443 ssl/.test(block),
  locations: blocks(block, 'location'),
}));
const servers = (text) => serversOf(nginxSite(text));
const aiqnetBlock = () => servers(SCRIPT).find((s) => s.tls && s.names.join() === 'aiqnet.io');
const REFUSE = (variable) => new RegExp(`\\n\\s+if \\(\\\\\\$${variable}\\) \\{\\n\\s+return 403;\\n\\s+\\}\\n`);

// A Fetch Metadata map of the site file as a function: is a request with this Sec-Fetch-Site (null: absent) refused?
function fetchMap(variable) {
  const m = new RegExp(`\\nmap \\\\\\$http_sec_fetch_site \\\\\\$${variable} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(nginxSite(SCRIPT));
  assert.ok(m, `the map ${variable}`);
  const entries = Object.fromEntries([...m[1].matchAll(/^\s+(\S+) ([01]);$/gm)].map((e) => [e[1], e[2]]));
  return (value) => (entries[value === null ? "''" : value] ?? entries.default) === '1';
}

test('a supported Node.js line everywhere: package.json engines, the deploy script and its update script, the CI\'s site job', () => {
  assert.equal(pkg.engines?.node, `>=${MIN_NODE}`);
  // The CI builds and checks the site on a Node.js its engines take.
  const ci = read(REPO, '.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  frontend-build:'), ci.indexOf('\n  security-audit:'));
  const ciNode = /\n\s*node-version: '?(\d+)/.exec(job)?.[1];
  assert.ok(Number(ciNode) >= MIN_NODE, `the CI's site job runs Node.js ${ciNode}`);
  // CONTRIBUTING.md names the version that job sets up.
  assert.ok(read(REPO, 'CONTRIBUTING.md').includes(`CI's front-end job sets up Node ${ciNode}.`), 'CONTRIBUTING.md');
  const major = Number(/^NODE_MAJOR=(\d+)$/m.exec(SCRIPT)?.[1]);
  assert.ok(major >= MIN_NODE, `NODE_MAJOR ${major}`);
  assert.match(SCRIPT, /deb\.nodesource\.com\/setup_\$NODE_MAJOR\.x/);
  assert.doesNotMatch(SCRIPT, /setup_1\d\.x|setup_20\.x|Node\.js 18/);
  // The distribution's own (older) nodejs is not installed next to it.
  assert.doesNotMatch(SCRIPT, /apt install -y [^\n]*\bnodejs npm\b/);
  // Installation and every update refuse an older node before building; step 1 installs it only when one is missing.
  assert.equal(SCRIPT.match(/-lt \$NODE_MAJOR \]; then/g)?.length, 3, 'the install when missing, and two version checks');
  for (const file of ['Dockerfile', 'docker-compose.yml']) {
    if (!existsSync(new URL(file, FRONTEND))) continue;
    const text = read(FRONTEND, file);
    for (const m of text.matchAll(/FROM node:(\d+)/g)) assert.ok(Number(m[1]) >= MIN_NODE, `${file}: node:${m[1]}`);
  }
});

test('the app listens on 127.0.0.1 only, and nginx on the host is the one way in', () => {
  assert.equal(pkg.scripts.start, 'next start -H 127.0.0.1');
  const passes = [...SCRIPT.matchAll(/proxy_pass ([^;]+);/g)].map((m) => m[1]);
  assert.ok(passes.length >= 3);
  for (const target of passes) assert.equal(target, 'http://127.0.0.1:3000');
  // The site's unit runs package.json's start command itself, with its release's next, so the binding holds for it.
  const exec = /\nExecStart=\/usr\/bin\/node \$SITE_CURRENT\/applications\/qnet-explorer\/node_modules\/next\/dist\/bin\/(next [^\n]+)\n/.exec(unit('qnet-explorer'));
  assert.ok(exec, 'the site unit runs next with node');
  assert.equal(exec[1], pkg.scripts.start);
  const compose = new URL('docker-compose.yml', FRONTEND);
  if (existsSync(compose)) {
    for (const m of read(FRONTEND, 'docker-compose.yml').matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)) {
      if (/:\d+$/.test(m[1])) assert.match(m[1], /^127\.0\.0\.1:/, `docker-compose publishes ${m[1]}`);
    }
  }
});

// A host built from the script is the host that runs: the site and the indexer as the systemd units the script writes,
// nothing of pm2.
test('the site and the indexer run as systemd services, the site as the unprivileged user, logging to the journal; no pm2', () => {
  assert.match(SCRIPT, /^APP_USER="aiqnet"$/m);
  assert.match(SCRIPT, /useradd --system [^\n]*--shell \/usr\/sbin\/nologin \$APP_USER/);
  assert.match(SCRIPT, /^FRONTEND_DIR="\$APP_DIR\/applications\/qnet-explorer\/frontend"$/m);
  // Each unit runs the release its folder's current link names, resolved at every start.
  assert.match(SCRIPT, /^SITE_RELEASES="\/var\/www\/qnet-releases"$/m);
  assert.match(SCRIPT, /^SITE_CURRENT="\$SITE_RELEASES\/current"$/m);
  assert.match(SCRIPT, /^SITE_FRONTEND="\$SITE_CURRENT\/applications\/qnet-explorer\/frontend"$/m);
  for (const [name, dir] of [['qnet-explorer', '$SITE_FRONTEND'], ['qnet-indexer', '$INDEXER_FRONTEND']]) {
    const u = unit(name);
    for (const line of [`WorkingDirectory=${dir}`, 'Type=exec', 'Restart=always', 'NoNewPrivileges=true',
      'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'Environment=NODE_ENV=production', 'WantedBy=multi-user.target']) {
      assert.ok(u.includes(`\n${line}\n`), `${name}: ${line}`);
    }
    // No secret and no setting of the operator's in a unit's text, which every user of the host can read: they are in
    // the root-only file the unit names.
    for (const m of u.matchAll(/^Environment=([A-Z_]+)=/gm)) assert.ok(['NODE_ENV', 'NODE_OPTIONS', 'NEXT_TELEMETRY_DISABLED'].includes(m[1]), `${name}: ${m[1]}`);
    assert.match(updateScript(), new RegExp(`^(?:if !? ?)?systemctl restart ${name}\\.service(?:; then)?$`, 'm'), `${name}: restarted by the update script`);
  }
  const web = unit('qnet-explorer');
  assert.ok(web.includes('\nUser=$APP_USER\n'));
  assert.ok(web.includes('\nStandardOutput=journal\nStandardError=journal\n'));
  // The only paths the site writes: its release's build cache and the balance check's checkpoints, which stay in the
  // checkout's untracked data/ for every release; the update makes that folder.
  assert.match(SCRIPT, /^SITE_DATA="\$FRONTEND_DIR\/data"$/m);
  assert.ok(web.includes('\nReadWritePaths=$SITE_FRONTEND/.next $SITE_DATA\n'));
  assert.match(SCRIPT, /\n\s+install -d -m 700 \$SITE_DATA\n/);
  // The command lines of other users' processes (root's included) are out of the site's view.
  assert.ok(web.includes('\nProtectProc=invisible\n'));
  const indexer = unit('qnet-indexer');
  assert.ok(indexer.includes('\nExecStart=/usr/bin/node $INDEXER_FRONTEND/dist-indexer/main.js\n'));
  // The writer runs as an identity of its own, never the site's: a process of the site's user could read the
  // environment of another process of that user, the writer's DATABASE_URL included.
  assert.ok(indexer.includes('\nDynamicUser=yes\n'));
  assert.doesNotMatch(indexer, /^User=/m);
  // Each unit's settings and secrets: a root file of mode 600, which systemd reads before it starts the process.
  for (const [u, file, path] of [[web, 'SITE_ENV', '/root/qnet-explorer.env'], [indexer, 'INDEXER_ENV', '/root/qnet-indexer.env']]) {
    assert.ok(u.includes(`\nEnvironmentFile=$${file}\n`), file);
    assert.match(SCRIPT, new RegExp(`^${file}="${path.replace(/[./]/g, '\\$&')}"$`, 'm'));
    assert.match(SCRIPT, new RegExp(`\\[ -f \\$${file} \\] \\|\\| install -m 600 -o root -g root /dev/null \\$${file}\\n\\s+chmod 600 \\$${file}\\n`), file);
  }
  // The update script, run by every deploy too, builds what each unit runs, once.
  const update = updateScript();
  assert.equal(SCRIPT.match(/^\s*npm run build:indexer$/gm)?.length, 1);
  assert.equal(SCRIPT.match(/^\s*npm run build$/gm)?.length, 1);
  assert.match(update, /\n\s+npm run build:indexer\n/);
  assert.match(update, /\n\s+npm run build\n/);
  // The journal keeps at most 300 MB.
  assert.match(SCRIPT, /printf '\[Journal\]\\nSystemMaxUse=300M\\n' > \/etc\/systemd\/journald\.conf\.d\/qnet\.conf/);
  assert.doesNotMatch(SCRIPT, /User=root|sudo -u root/);
  // Nothing of pm2 anywhere in the deploy, its document or the indexer, and no second layout or deploy script.
  for (const path of ['deployment/deploy-aiqnet.sh', 'docs/applications/explorer.md', 'applications/qnet-explorer/frontend/src/indexer/main.ts']) {
    assert.doesNotMatch(read(REPO, path), /\bpm2\b/i, path);
  }
  assert.equal(existsSync(new URL('ecosystem.config.example.js', FRONTEND)), false);
  assert.equal(existsSync(new URL('deployment/deploy-to-1984.sh', REPO)), false);
});

// A deploy run over a host that already runs both services leaves neither on its old release or unit: `systemctl enable
// --now` starts only a stopped unit, so the deploy ends with the update script, which restarts each. Step 2 writes no
// unit: the update writes each one only once current names a built release of its service, and it loads there
// (daemon-reload, then enable with --no-reload) right before its restart, so a host that runs either service another way
// runs it on until its own release is ready, whatever stops the update before.
test('every deploy builds and restarts both services through the update script, each unit installed only once its release is built', () => {
  const provision = step(2);
  assert.doesNotMatch(SCRIPT, /enable --now/);
  assert.doesNotMatch(provision.slice(0, provision.indexOf("cat > /root/update-aiqnet.sh << 'EOF'")), /daemon-reload|systemctl|\/etc\/systemd/);
  const writes = provision.indexOf("\n    cat > /root/update-aiqnet.sh << 'EOF'\n");
  const written = provision.indexOf('\nEOF\n    chmod +x /root/update-aiqnet.sh\n');
  const runs = provision.search(/\n    \/root\/update-aiqnet\.sh\n/);
  assert.ok(writes > -1 && writes < written && written < runs, 'the update script written, then run');
  assert.equal(provision.slice(written).match(/systemctl/g), null, 'nothing enabled or loaded beside the update');
  // Both releases are built while the services run on; then the indexer's unit goes in and it restarts (its migrations
  // committed when it returns), and only then is the site switched, its unit put in and it restarted.
  const update = updateScript();
  const at = (text) => update.indexOf(text);
  const order = [
    '\n    npm run build\n', '\n        npm run build:indexer\n', '\nif [ -n \\"\\$INDEXER_RELEASE\\" ]; then point $INDEXER_BUILDER $INDEXER_RELEASES ',
    "\ncat > $UNIT_DIR/qnet-indexer.service.new << 'UNIT'\n", '\nunit_in qnet-indexer.service\n', '\nif ! systemctl restart qnet-indexer.service; then\n',
    '\npoint $APP_USER $SITE_RELEASES \\$RELEASE ', "\ncat > $UNIT_DIR/qnet-explorer.service.new << 'UNIT'\n", '\nunit_in qnet-explorer.service\n',
    '\nsystemctl restart qnet-explorer.service\n', '\nif ! site_answers; then\n', '\nprune $APP_USER $SITE_RELEASES\nprune $INDEXER_BUILDER $INDEXER_RELEASES\necho ',
  ].map(at);
  assert.ok(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1])), order.join(' '));
  // A unit loads where it goes in: daemon-reload, then enable without a second reload.
  const unitIn = update.slice(at('\nunit_in() {\n'), update.indexOf('\n}\n', at('\nunit_in() {\n')));
  assert.match(unitIn, /\n    mv \$UNIT_DIR\/\\\$1\.new \$UNIT_DIR\/\\\$1\n    systemctl daemon-reload\n    systemctl enable --no-reload \\\$1$/);
  assert.match(SCRIPT, /^UNIT_DIR="\/etc\/systemd\/system"$/m);
  assert.deepEqual(SCRIPT.match(/^[ \t]*(?:if !? ?|elif )?systemctl (?:start|restart|enable)\b[^\n]*qnet-(?:indexer|explorer)[^\n]*$/gm).map((l) => l.trim()),
    ['if ! systemctl restart qnet-indexer.service; then', 'elif systemctl restart qnet-indexer.service; then', 'systemctl restart qnet-explorer.service']);
});

// At boot as in each update the indexer starts first: it applies the migrations the site reads (src/indexer/main.ts),
// and it needs the database. Its unit counts as started only once they are committed: ExecStartPre runs main.js in its
// migrate-only mode, which exits after the migrations, and no start timeout cuts a long one short (each attempt would
// roll it back). With Type=exec, the start job ends once ExecStart's program runs, after every ExecStartPre.
test('the indexer is ordered after the database and before the site, and commits its migrations before it counts as started', () => {
  const indexer = unit('qnet-indexer');
  assert.match(indexer, /\nAfter=network-online\.target postgresql\.service\n/);
  assert.match(indexer, /\nBefore=qnet-explorer\.service\n/);
  assert.doesNotMatch(indexer, /^After=[^\n]*qnet-explorer/m);
  assert.doesNotMatch(unit('qnet-explorer'), /^Before=[^\n]*qnet-indexer/m);
  const pre = /\nExecStartPre=\/usr\/bin\/node \$INDEXER_FRONTEND\/dist-indexer\/main\.js (--[a-z-]+)\n/.exec(indexer);
  assert.ok(pre, 'the migrations before the start');
  assert.equal(indexer.match(/^ExecStartPre=/gm).length, 1);
  assert.ok(indexer.includes('\nTimeoutStartSec=infinity\n'));
  assert.ok(indexer.includes('\nType=exec\n'));
  // main.ts stops for exactly that flag after the migrations, before anything of the chain, and frees the writer lock.
  const main = read(FRONTEND, 'src/indexer/main.ts');
  const stop = main.indexOf(`if (process.argv.includes('${pre[1]}')) {`);
  assert.ok(stop > main.indexOf('await runMigrations(') && stop < main.indexOf('await rebuildStatsIfNeeded(') && stop < main.indexOf('new Chain('), 'the migrate-only stop');
  assert.match(main.slice(stop), /^[^\n]*\{\n\s+await db\.end\(\);\n\s+await lock\.end\(\);\n\s+log\.info\([^\n]*\);\n\s+process\.exit\(0\);\n\s+\}/);
});

// The `if … fi` block of `text` that opens at `indent` before `at` and closes after it: its condition and its span.
function enclosingIf(text, at, indent = '') {
  for (const m of [...text.slice(0, at).matchAll(new RegExp(`\\n${indent}if ([^\\n]*); then\\n`, 'g'))].reverse()) {
    const end = text.indexOf(`\n${indent}fi\n`, m.index + 1);
    if (end > at) return { condition: m[1], start: m.index, end };
  }
  return null;
}

// The database writer's code is a release the site's user cannot write, so no install script or build step of the site
// can plant code that runs with the writer's settings: fetched, installed with no install script and compiled by a
// builder of its own, and run by systemd's per-run user, which writes nothing. A release holds only the indexer's inputs
// and is built only when they change, so an update of the site alone fetches, installs and builds nothing of the
// indexer; its packages are installed again only when what the install reads changed.
test('the indexer runs releases only its builder writes, holding its inputs only, built only when they change', () => {
  assert.match(SCRIPT, /^INDEXER_DIR="\/opt\/qnet-indexer"$/m);
  assert.match(SCRIPT, /^INDEXER_RELEASES="\/opt\/qnet-indexer-releases"$/m);
  assert.match(SCRIPT, /^INDEXER_CURRENT="\$INDEXER_RELEASES\/current"$/m);
  assert.match(SCRIPT, /^INDEXER_FRONTEND="\$INDEXER_CURRENT\/applications\/qnet-explorer\/frontend"$/m);
  // A static user named like the unit would stand in for the unit's per-run user.
  const builder = /^INDEXER_BUILDER="([a-z-]+)"$/m.exec(SCRIPT)?.[1];
  assert.ok(builder && !['qnet-indexer', /^APP_USER="([^"]+)"$/m.exec(SCRIPT)[1]].includes(builder), builder);
  assert.match(step(2), /\n\s+id -u \$INDEXER_BUILDER [^\n]*\|\| useradd --system [^\n]*--shell \/usr\/sbin\/nologin \$INDEXER_BUILDER\n\s+mkdir -p \$INDEXER_DIR \$INDEXER_RELEASES\n\s+chown \$INDEXER_BUILDER:\$INDEXER_BUILDER \$INDEXER_DIR \$INDEXER_RELEASES\n/);
  assert.match(step(2), /\n\s+mkdir -p \$APP_DIR \$SITE_RELEASES\n\s+chown \$APP_USER:\$APP_USER \$APP_DIR \$SITE_RELEASES\n/);
  const indexer = unit('qnet-indexer');
  assert.doesNotMatch(indexer, /\$APP_DIR|\$FRONTEND_DIR|\$SITE_/, 'nothing of the site\'s checkout or releases, its migrations included');

  // The inputs: what the install reads (the workspace's package files, its lockfile and the check run before npm ci),
  // then what the build and the run read besides (the build's config, the sources it includes, the migrations).
  const install = /^INDEXER_INSTALL_INPUTS="([^"$]+)"$/m.exec(SCRIPT)?.[1].split(' ');
  const rest = /^INDEXER_INPUTS="\$INDEXER_INSTALL_INPUTS ([^"$]+)"$/m.exec(SCRIPT)?.[1].split(' ');
  assert.deepEqual(install, ['applications/qnet-explorer/package.json', 'applications/qnet-explorer/package-lock.json',
    'applications/qnet-explorer/frontend/package.json', 'applications/qnet-explorer/frontend/scripts/lockfile-check.mjs']);
  assert.deepEqual(rest, ['applications/qnet-explorer/frontend/tsconfig.indexer.json', 'applications/qnet-explorer/frontend/src/indexer',
    'applications/qnet-explorer/frontend/migrations']);
  for (const path of [...install, ...rest]) assert.ok(existsSync(new URL(path, REPO)), path);
  assert.equal(pkg.scripts['build:indexer'], 'tsc -p tsconfig.indexer.json');
  assert.deepEqual(JSON.parse(read(FRONTEND, 'tsconfig.indexer.json')).include, ['src/indexer/**/*.ts']);
  // The sources read no file outside those inputs: their relative imports stay in src/indexer, and the one directory the
  // run reads is the migrations.
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dir = new URL('src/indexer/', FRONTEND);
  for (const entry of readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.ts'))) {
    const source = read(dir, entry.replace(/\\/g, '/'));
    assert.doesNotMatch(source, /\brequire\(|\bimport\(/, entry);
    for (const m of source.matchAll(/\bfrom '([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) assert.ok(new URL(spec, new URL(entry.replace(/\\/g, '/'), dir)).href.startsWith(dir.href), `${entry}: ${spec}`);
      else assert.ok(spec.startsWith('node:') || ['fs', 'path'].includes(spec) || spec in deps, `${entry}: ${spec}`);
    }
  }
  // The migrations are read from beside the code, so the release a run's code comes from is the one its schema does.
  assert.match(read(FRONTEND, 'src/indexer/main.ts'), /\n  await runMigrations\(db, migrationsDir\(\)\);\n/);
  assert.match(read(FRONTEND, 'src/indexer/migrate.ts'), /\nexport function migrationsDir\(\): string \{\n  return path\.join\(__dirname, '\.\.', 'migrations'\);\n\}\n/);

  const update = updateScript();
  assert.match(update, /^#!\/bin\/bash\nset -eo pipefail\n/);
  // One fingerprint of a checkout's commit (ls-tree reads the commit, not the working tree), read by its owner.
  assert.ok(update.includes('\ninputs() { local user=\\$1 dir=\\$2; shift 2; sudo -u \\"\\$user\\" -H git -C \\"\\$dir\\" ls-tree HEAD -- \\"\\$@\\" | sha256sum | cut -c1-64; }\n'));
  assert.equal(update.match(/ls-tree/g).length, 1);
  const sudo = sudoBlocks(update);
  assert.deepEqual(sudo.map((b) => b.user), ['APP_USER', 'INDEXER_BUILDER', 'APP_USER', 'INDEXER_BUILDER']);
  const [siteFetch, treeFetch, siteBuild, treeBuild] = sudo;
  for (const b of [siteFetch, siteBuild]) assert.doesNotMatch(b.body, /INDEXER|build:indexer/);
  const siteInputs = update.indexOf('\nSITE_INPUTS=\\$(inputs $APP_USER $APP_DIR $INDEXER_INPUTS)\n');
  assert.ok(siteFetch.at < siteInputs);

  // The checkout is fetched and a release built only when the site's commit holds other inputs than the running release
  // was built from. That record lives in each release, written by its builder once the build is done, so a fetch or a
  // build cut short records nothing and the next update builds again.
  const stale = enclosingIf(update, treeFetch.at);
  assert.equal(stale?.condition, '[ \\"\\$(sudo -u $INDEXER_BUILDER -H cat $INDEXER_BUILT 2>/dev/null)\\" != \\"\\$SITE_INPUTS\\" ]');
  assert.ok(siteInputs < stale.start);
  assert.match(SCRIPT, /^INDEXER_INSTALLED="\$INDEXER_CURRENT\/\.installed-inputs"$/m);
  assert.match(SCRIPT, /^INDEXER_BUILT="\$INDEXER_CURRENT\/\.built-inputs"$/m);
  // The fetch: the branch's tip, shallow, without the contents of any file but the inputs, which alone are checked out.
  assert.match(treeFetch.body, /\n\s+cd \$INDEXER_DIR\n(?:\s*#[^\n]*\n)*\s+\[ -d \.git \] \|\| git clone --depth 1 --filter=blob:none --no-checkout --branch \$APP_BRANCH \$GITHUB_REPO \.\n\s+git config core\.sparseCheckout true\n\s+printf \\"\/%s\\\\n\\" \$INDEXER_INPUTS > \.git\/info\/sparse-checkout\n\s+git fetch --depth 1 origin \$APP_BRANCH\n\s+git checkout -q --detach FETCH_HEAD\n\s+git read-tree -mu HEAD$/);
  // Both trees serve one commit's indexer: the inputs the release is about to be built from are the site commit's,
  // checked before anything is built.
  const compare = update.indexOf('\n    TREE_INPUTS=\\$(inputs $INDEXER_BUILDER $INDEXER_DIR $INDEXER_INPUTS)\n    if [ \\"\\$TREE_INPUTS\\" != \\"\\$SITE_INPUTS\\" ]; then\n');
  assert.ok(treeFetch.at < compare && compare < stale.end && stale.end < siteBuild.at);
  assert.match(update.slice(compare), /^\n[^\n]*\n[^\n]*\n        echo [^\n]* >&2\n        exit 1\n    fi\n    INDEXER_RELEASE=\\\$RELEASE\n/);
  // The install runs again only when what it reads changed; otherwise the new release links in the running one's
  // packages, which nothing writes after their install.
  const reuse = update.slice(compare, stale.end + 1);
  assert.ok(reuse.includes('\n    INSTALL_INPUTS=\\$(inputs $INDEXER_BUILDER $INDEXER_DIR $INDEXER_INSTALL_INPUTS)\n    RUNNING=\\$(link $INDEXER_BUILDER $INDEXER_CURRENT)\n'));
  assert.ok(reuse.includes('\n    if [ -n \\"\\$RUNNING\\" ] && [ \\"\\$(sudo -u $INDEXER_BUILDER -H cat $INDEXER_INSTALLED 2>/dev/null)\\" = \\"\\$INSTALL_INPUTS\\" ]; then\n        REUSE=$INDEXER_RELEASES/\\$RUNNING\n    fi\n'));
  // The build: a new folder of its own, the commit's inputs alone, its packages linked in or installed with no install
  // script and no optional package, then the records the next update reads through current.
  assert.equal(enclosingIf(update, treeBuild.at)?.condition, '[ -n \\"\\$INDEXER_RELEASE\\" ]');
  assert.match(treeBuild.body, /^\s+set -eo pipefail\n\s+mkdir \\"\\\$1\\"\n\s+git -C \$INDEXER_DIR archive HEAD -- \$INDEXER_INPUTS \| tar -x -C \\"\\\$1\\"\n/);
  assert.match(treeBuild.body, /\n\s+if \[ -n \\"\\\$2\\" \]; then\n\s+cp -al \\"\\\$2\/applications\/qnet-explorer\/node_modules\\" \.\.\n/);
  assert.match(treeBuild.body, /\n\s+else\n(?:\s*#[^\n]*\n)*\s+export npm_config_ignore_scripts=true npm_config_omit=optional\n\s+node scripts\/lockfile-check\.mjs\n\s+npm ci\n\s+fi\n\s+npm run build:indexer\n/);
  const records = [...treeBuild.body.matchAll(/\n\s+echo \\"\\\$(\d)\\" > \\"\\\$1\/(\.[a-z-]+)\\"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(records, [['3', '.installed-inputs'], ['4', '.built-inputs']]);
  assert.equal(treeBuild.args, '_ $INDEXER_RELEASES/\\$INDEXER_RELEASE \\"\\$REUSE\\" \\"\\$INSTALL_INPUTS\\" \\"\\$SITE_INPUTS\\"');
  assert.doesNotMatch(SCRIPT, />>? *\$INDEXER_(BUILT|INSTALLED)/);
});

test('the builds run as the unprivileged users, never as root, and the site\'s secrets are root\'s, in no file of the checkout', () => {
  // npm ci and the builds run as the app user or the indexer's builder (install scripts never run as root).
  for (const m of SCRIPT.matchAll(/^\s*npm (ci|install|run build)\b.*$/gm)) {
    // Inside a `sudo -u $APP_USER -H bash -c '` or `sudo -u $INDEXER_BUILDER …` block: opened before the line, not closed
    // (a line that starts with the closing ') since.
    const before = SCRIPT.slice(0, m.index);
    const opened = Math.max(...['APP_USER', 'INDEXER_BUILDER'].map((u) => before.lastIndexOf(`sudo -u $${u} -H bash -c '\n`)));
    const closed = Math.max(-1, ...[...before.matchAll(/\n[ \t]*'(?: [^\n]*)?\n/g)].map((c) => c.index));
    assert.ok(opened > -1 && opened > closed, m[0].trim());
  }
  // The user that builds the site (and runs every install script) owns no file with a secret.
  assert.doesNotMatch(SCRIPT, /-o \$APP_USER[^\n]*\.env|\.env\.local/, 'no secret in a file of the app user');
  assert.doesNotMatch(SCRIPT, /npm ci --production/, 'next build needs the full install');
  // Built from the branch the site runs on.
  assert.match(SCRIPT, /^APP_BRANCH="testnet"$/m);
  assert.match(SCRIPT, /git clone --branch \$APP_BRANCH \$GITHUB_REPO \./);
  assert.equal(SCRIPT.match(/git pull --ff-only origin \$APP_BRANCH/g)?.length, 1);
  assert.doesNotMatch(SCRIPT, /\bmaster\b/);
});

// next build and next start also read .env files of the site's folder, and a key $SITE_ENV lacks would come from one
// without a sign, out of a file the build user can read. The update script, the end of every deploy too, builds and
// switches nothing while the checkout holds one, a committed one included: it looks once the commit is pulled.
test('an update refuses to build while the site\'s checkout holds a .env file', () => {
  const update = updateScript();
  const loop = update.indexOf('\nfor f in $FRONTEND_DIR/.env*; do\n');
  assert.ok(loop > -1, 'the check');
  assert.match(update.slice(loop), /^\nfor f in \$FRONTEND_DIR\/\.env\*; do\n    if \[ -e \\"\\\$f\\" \]; then\n        echo \\"\\\$f exists: [^\n]*\$SITE_ENV[^\n]*explorer_reader[^\n]*Nothing was built or switched\.\\" >&2\n        exit 1\n    fi\ndone\n/);
  const [siteFetch, , siteBuild] = sudoBlocks(update);
  assert.ok(siteFetch.at < loop && loop < siteBuild.at, 'after the pull, before anything is built');
});

test('nginx writes no access log for /api/link/ on any TLS host, so no log pairs a session id with the addresses of both devices', () => {
  const tls = servers(SCRIPT).filter((s) => s.tls);
  assert.ok(tls.length >= 2);
  for (const server of tls) {
    const relay = server.locations.filter((l) => /^\s*location \^~ \/api\/link\/ \{/.test(l));
    assert.equal(relay.length, 1, `${server.names}: a location of its own for the relay`);
    assert.match(relay[0], /\n\s+access_log off;/, `${server.names}`);
    assert.match(relay[0], /\n\s+error_log \S+ crit;/, `${server.names}`);
  }
  // The one block that serves the relay passes it the client's address and the same nginx limit as /api.
  const serving = tls.filter((s) => s.locations.some((l) => /location \^~ \/api\/link\//.test(l) && /proxy_pass/.test(l)));
  assert.equal(serving.length, 1, 'the relay is proxied by one server block');
  const relay = serving[0].locations.find((l) => /location \^~ \/api\/link\//.test(l));
  assert.match(relay, /proxy_set_header X-Real-IP \\\$remote_addr;/, 'the per-IP limits still see the client');
  assert.match(relay, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
});

// Any page can make a visitor's browser send GETs to /api (an <img> needs no permission). Such a request to the
// relay is refused in nginx's rewrite phase, before limit_req counts it, and the relay has a zone of its own, so
// explorer /api requests never use up the relay's budget of that address.
test('the relay refuses browser requests no page of the site made, before its own nginx limit', () => {
  const MAP = /\nmap \\\$http_sec_fetch_site \\\$aiqnet_cross_fetch \{\n\s+default 1;\n\s+'' 0;\n\s+same-origin 0;\n\}\n/;
  const site = nginxSite(SCRIPT);
  assert.match(site, MAP, 'the Fetch Metadata map');
  const serving = servers(SCRIPT).filter((s) => s.tls).flatMap((s) => s.locations)
    .filter((l) => /location \^~ \/api\/link\//.test(l) && /proxy_pass/.test(l));
  assert.equal(serving.length, 1);
  const relay = serving[0];
  assert.match(relay, REFUSE('aiqnet_cross_fetch'), 'refused before the app');
  assert.ok(relay.search(REFUSE('aiqnet_cross_fetch')) < relay.indexOf('limit_req '), 'before the limit');
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_api:10m rate=10r\/s;\n/);
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_link:10m rate=10r\/s;\n/);
  const aiqnet = aiqnetBlock();
  assert.match(aiqnet.locations.find((l) => /location \^~ \/api\/link\//.test(l)), /\n\s+limit_req zone=aiqnet_link burst=20 nodelay;\n/, 'a zone of its own');
  assert.match(aiqnet.locations.find((l) => /^\s*location \/api \{/.test(l)), /\n\s+limit_req zone=aiqnet_api burst=20 nodelay;\n/);
  // Only the relay's location uses the relay's zone.
  assert.equal(site.match(/limit_req zone=aiqnet_link /g).length, 1);
});

// The node cabinet's routes name nodes, wallets and payment addresses (privacy policy: not logged). Like the relay:
// a location of its own on every TLS host, no access log, refused for another page's request before any limit, and on
// aiqnet.io a zone of its own. The phone flows start off (src/server/phone-flows.ts).
test('nginx logs nothing of /api/cabinet/, refuses other pages\' requests first, and gives it a zone of its own', () => {
  const tls = servers(SCRIPT).filter((s) => s.tls);
  for (const server of tls) {
    const cabinet = server.locations.filter((l) => /^\s*location \^~ \/api\/cabinet\/ \{/.test(l));
    assert.equal(cabinet.length, 1, `${server.names}: a location of its own for the cabinet`);
    assert.match(cabinet[0], /\n\s+access_log off;/, `${server.names}`);
    assert.match(cabinet[0], /\n\s+error_log \S+ crit;/, `${server.names}`);
    if (!/proxy_pass/.test(cabinet[0])) assert.match(cabinet[0], /\n\s+return 308 https:\/\/[^\n]+\\\$request_uri;/, `${server.names}`);
  }
  const serving = tls.flatMap((s) => s.locations).filter((l) => /^\s*location \^~ \/api\/cabinet\/ \{/.test(l) && /proxy_pass/.test(l));
  assert.equal(serving.length, 1, 'one block proxies the cabinet');
  assert.match(serving[0], REFUSE('aiqnet_cross_fetch'));
  assert.match(serving[0], /proxy_set_header X-Real-IP \\\$remote_addr;/);
  assert.ok(serving[0].search(REFUSE('aiqnet_cross_fetch')) < serving[0].indexOf('limit_req '), 'before the limit');
  assert.match(SCRIPT, /\n\s+grep -q '\^CABINET_PHONE_FLOWS=' \$SITE_ENV \|\| echo 'CABINET_PHONE_FLOWS=0' >> \$SITE_ENV\n/, 'the phone flows start off');
  const site = nginxSite(SCRIPT);
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_cabinet:10m rate=10r\/s;\n/);
  // The cabinet's location, its activation routes' and the wallets' Solana relay's, all on aiqnet.io, share the
  // cabinet's zone.
  assert.equal(site.match(/limit_req zone=aiqnet_cabinet burst=20 nodelay;/g).length, 3);
});

// The wallets' Solana relay takes the QNet extension's requests (Sec-Fetch-Site none) as the activation routes do, and
// its bodies carry the wallets' addresses and signed transfers: an exact location of its own (nginx prefers it to the
// cabinet's prefix), nothing logged, another page refused before the cabinet's zone counts it.
test('the wallets\' Solana relay has an exact location on aiqnet.io with the activation routes\' Fetch Metadata rule', async () => {
  const relay = aiqnetBlock().locations.filter((l) => /^\s*location = \/api\/cabinet\/solana \{/.test(l));
  assert.equal(relay.length, 1, 'one exact location on aiqnet.io');
  const loc = relay[0];
  assert.match(loc, /\n\s+access_log off;/);
  assert.match(loc, /\n\s+error_log \S+ crit;/);
  assert.match(loc, REFUSE('aiqnet_activation_cross_fetch'));
  assert.ok(loc.search(REFUSE('aiqnet_activation_cross_fetch')) < loc.indexOf('limit_req '), 'before the limit');
  assert.match(loc, /\n\s+limit_req zone=aiqnet_cabinet burst=20 nodelay;\n/);
  assert.match(loc, /proxy_set_header X-Real-IP \\\$remote_addr;/);
  assert.match(loc, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  // No other block proxies it: the other names send every /api/cabinet/ path to aiqnet.io.
  assert.equal(servers(SCRIPT).flatMap((s) => s.locations).filter((l) => /\/api\/cabinet\/solana/.test(l)).length, 1);
  // nginx refuses a Sec-Fetch-Site value exactly when the relay's own origin rule refuses it.
  const { createSolanaProxy } = await import('../../server/cabinet/solana-proxy.ts');
  const { unbudgeted } = await import('../../server/cabinet/upstream.ts');
  const proxy = createSolanaProxy({ rpc: async () => 7, scope: 'deploy-relay', devOrigins: false, clientKey: () => ({ ok: true, ip: '203.0.113.80' }), budget: unbudgeted });
  const refused = fetchMap('aiqnet_activation_cross_fetch');
  for (const value of [null, 'same-origin', 'same-site', 'cross-site', 'none']) {
    const res = await proxy.relay(new Request('https://aiqnet.io/api/cabinet/solana', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(value === null ? {} : { 'sec-fetch-site': value }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] }),
    }));
    assert.equal(res.status === 403, refused(value), `Sec-Fetch-Site ${value}`);
  }
  assert.ok(CABINET_LIMITS.solana.max * 1000 / CABINET_LIMITS.solana.windowMs <= 10, 'the zone\'s 10 a second takes the relay\'s per-client rate');
});

// The activation routes take the QNet extension's own requests, which carry Sec-Fetch-Site none (request-guard.ts
// activationOriginAllowed): under the cabinet's rule nginx would answer them 403 before the app sees them.
test('the activation routes let the extension\'s requests through; each nginx refusal is exactly the app\'s own', () => {
  const aiqnet = aiqnetBlock();
  const activation = aiqnet.locations.filter((l) => /^\s*location \^~ \/api\/cabinet\/activation\/ \{/.test(l));
  assert.equal(activation.length, 1, 'a location of its own on aiqnet.io');
  const loc = activation[0];
  assert.match(loc, /\n\s+access_log off;/);
  assert.match(loc, /\n\s+error_log \S+ crit;/);
  assert.match(loc, REFUSE('aiqnet_activation_cross_fetch'));
  assert.ok(loc.search(REFUSE('aiqnet_activation_cross_fetch')) < loc.indexOf('limit_req '), 'before the limit');
  assert.match(loc, /\n\s+limit_req zone=aiqnet_cabinet burst=20 nodelay;\n/);
  assert.match(loc, /proxy_set_header X-Real-IP \\\$remote_addr;/);
  assert.match(loc, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  // nginx refuses a Sec-Fetch-Site value exactly when the app's own check of that route refuses it.
  const crossRefused = fetchMap('aiqnet_cross_fetch');
  const activationRefused = fetchMap('aiqnet_activation_cross_fetch');
  for (const value of [null, 'same-origin', 'same-site', 'cross-site', 'none']) {
    const request = new Request('https://aiqnet.io/api/cabinet/x', { headers: value === null ? {} : { 'sec-fetch-site': value } });
    assert.equal(!crossRefused(value), fetchSiteAllowed(request), `relay and cabinet, Sec-Fetch-Site ${value}`);
    assert.equal(!activationRefused(value), activationOriginAllowed(request, false), `activation, Sec-Fetch-Site ${value}`);
  }
  assert.equal(activationRefused('none'), false);
  assert.equal(crossRefused('none'), true);
});

// Per address, nginx is the outer fence: never tighter than what the app itself lets one address do on a route, so
// every refusal a page meets in normal use is the app's own, with its Retry-After. A page polls the relay every 2 s.
test('the relay\'s and the cabinet\'s nginx rates leave the app\'s own per-address limits in charge', () => {
  const site = nginxSite(SCRIPT);
  const rate = (zone) => Number(new RegExp(`zone=${zone}:10m rate=(\\d+)r/s;`).exec(site)[1]);
  const perSecond = ({ max, windowMs }) => (max * 1000) / windowMs;
  assert.ok(rate('aiqnet_link') >= perSecond(LIMITS.poll), 'the relay: the app\'s poll budget of one address');
  assert.ok(rate('aiqnet_link') >= 20 * (1000 / POLL_INTERVAL_MS), 'twenty pages behind one address polling at once');
  const busiest = Math.max(...Object.values(CABINET_LIMITS).map(perSecond));
  assert.ok(rate('aiqnet_cabinet') >= busiest, 'the cabinet: its busiest route\'s budget of one address');
});

test('nginx: TLS 1.2 and 1.3 only, the event stream unbuffered, the most read answers cached a second, every /api path limited', () => {
  const site = nginxSite(SCRIPT);
  for (const s of servers(SCRIPT).filter((x) => x.tls)) {
    assert.match(s.block, /\n\s+ssl_protocols TLSv1\.2 TLSv1\.3;\n/, s.names.join());
    assert.match(s.block, /\n\s+ssl_certificate \/etc\/ssl\/certs\/ssl-cert-snakeoil\.pem;\n\s+ssl_certificate_key \/etc\/ssl\/private\/ssl-cert-snakeoil\.key;\n/, s.names.join());
  }
  const aiqnet = aiqnetBlock();
  const stream = aiqnet.locations.find((l) => /^\s*location = \/api\/stream \{/.test(l));
  assert.ok(stream, 'the event stream');
  for (const line of ['limit_req zone=aiqnet_api burst=20 nodelay;', 'proxy_http_version 1.1;', "proxy_set_header Connection '';", 'proxy_buffering off;', 'proxy_read_timeout 3600s;']) {
    assert.ok(stream.includes(`\n        ${line}\n`), line);
  }
  const hot = aiqnet.locations.find((l) => l.startsWith('    location ~ ^/api/(activity|head|network/stats)\\$ {'));
  assert.ok(hot, 'the cached reads');
  for (const line of ['limit_req zone=aiqnet_api burst=20 nodelay;', 'proxy_cache explorer_hot;', 'proxy_cache_valid 200 1s;', 'proxy_cache_lock on;']) {
    assert.ok(hot.includes(`\n        ${line}\n`), line);
  }
  assert.equal(site.match(/\nproxy_cache_path \/var\/cache\/nginx\/explorer_hot [^\n]*keys_zone=explorer_hot:10m /g)?.length, 1);
  assert.match(SCRIPT, /\n\s+mkdir -p \/var\/cache\/nginx\n/);
  // Every location of aiqnet.io that proxies an /api path counts against a zone.
  const api = aiqnet.locations.filter((l) => /proxy_pass/.test(l) && /^\s*location [^\n]*\/api/.test(l));
  assert.ok(api.length >= 6);
  for (const l of api) assert.match(l, /\n\s+limit_req zone=aiqnet_(api|link|cabinet) burst=20 nodelay;\n/, l.split('\n')[0].trim());
  // One certificate, proved through nginx and never installed into the site file by certbot: the script names its
  // paths, the package's timer renews it, the hook reloads nginx.
  assert.match(SCRIPT, /\n\s+certbot certonly --nginx --cert-name aiqnet\.io (?:-d \S+ )+--non-interactive [^\n]*--deploy-hook 'systemctl reload nginx'\n/);
  assert.doesNotMatch(SCRIPT, /crontab/);
});

// Re-run over a host that already has the certificate, step 3 must not hand every TLS name the self-signed one while
// step 4 waits for the operator: the app sends HSTS, so browsers would refuse the site. One sed expression, written
// once, names the certificate's paths in step 3 when it exists and in step 4 once certbot has it.
test('step 3 keeps the certificate a host already has, with the one sed that step 4 uses', () => {
  const sed = /^CERT_PATHS="([^"]+)"$/m.exec(SCRIPT)?.[1];
  assert.ok(sed, 'CERT_PATHS');
  assert.match(SCRIPT, /^LE_LIVE="\/etc\/letsencrypt\/live\/\$DOMAIN_NAME"$/m);
  const certName = /\n\s+certbot certonly --nginx --cert-name (\S+) /.exec(SCRIPT)[1];
  assert.equal(certName, /^DOMAIN_NAME="([^"]+)"$/m.exec(SCRIPT)[1], 'LE_LIVE is the certificate certbot makes');
  const live = `/etc/letsencrypt/live/${certName}`;
  // The expression applied to the site file: every TLS block names the certificate's chain and key.
  let site = nginxSite(SCRIPT);
  for (const m of sed.matchAll(/s#([^#]+)#([^#]+)#/g)) site = site.split(m[1]).join(m[2].replace('$LE_LIVE', live));
  const tls = serversOf(site).filter((s) => s.tls);
  assert.equal(tls.length, 3);
  for (const s of tls) {
    assert.ok(s.block.includes(`\n    ssl_certificate ${live}/fullchain.pem;\n    ssl_certificate_key ${live}/privkey.pem;\n`), s.names.join());
  }
  // Step 3: when the certificate exists, before nginx is tested and restarted.
  const nginx = step(3);
  const keep = nginx.search(/\n    if \[ -f \$LE_LIVE\/fullchain\.pem \]; then\n        sed -i '\$CERT_PATHS' \/etc\/nginx\/sites-available\/\$DOMAIN_NAME\n    fi\n/);
  assert.ok(keep > nginx.indexOf('\nEOF\n'), 'after the site file is written');
  assert.ok(keep < nginx.indexOf('\n    $NGINX_TEST\n'), 'before the file is tested');
  // Step 4: once certbot has it, the file before kept until nginx accepts the new paths.
  assert.match(step(4), /\n\s+certbot certonly [^\n]*\n\s+sed -i\.previous '\$CERT_PATHS' \/etc\/nginx\/sites-available\/\$DOMAIN_NAME\n\s+\$NGINX_TEST\n\s+systemctl reload nginx\n/);
  assert.equal(SCRIPT.match(/ssl-cert-snakeoil\.pem#/g).length, 1, 'the expression is written once');
});

// A faucet claim may take the route FAUCET_CLAIM_MS to answer and the page waits FAUCET_CLAIM_REQUEST_MS: nginx's read
// timeout of the route lies between the two, so the app's answer reaches the page, never nginx's 504 page.
test('nginx waits for a faucet claim longer than the route may take and less than the page waits', async () => {
  const { FAUCET_CLAIM_MS, FAUCET_CLAIM_REQUEST_MS } = await import('../faucet-handover.ts');
  const claim = aiqnetBlock().locations.filter((l) => /^\s*location = \/api\/faucet\/claim \{/.test(l));
  assert.equal(claim.length, 1, 'a location of its own on aiqnet.io');
  const timeoutMs = Number(/\n\s+proxy_read_timeout (\d+)s;\n/.exec(claim[0])?.[1]) * 1000;
  assert.ok(timeoutMs > FAUCET_CLAIM_MS, `${timeoutMs} ms > FAUCET_CLAIM_MS ${FAUCET_CLAIM_MS}`);
  assert.ok(timeoutMs < FAUCET_CLAIM_REQUEST_MS, `${timeoutMs} ms < FAUCET_CLAIM_REQUEST_MS ${FAUCET_CLAIM_REQUEST_MS}`);
  assert.match(claim[0], /\n\s+limit_req zone=aiqnet_api burst=20 nodelay;\n/);
});

// Step 3 runs under set -e and tests the new site file before nginx restarts. A file nginx refuses, or one whose names
// another enabled file of nginx also names, is taken back out (the one before comes back, or the site is left out on a
// new host), so neither this restart nor a later restart or boot meets it and no name goes down or is served by another
// file. Step 4 resolves the names on the host, whose dig step 1 installs, not on the operator's machine, which may lack it.
test('a site file nginx refuses, or whose names another file serves, never takes the names; the names are resolved on the host', () => {
  const nginx = step(3);
  assert.match(nginx, /^run_remote "\n    set -e\n/);
  const site = '/etc/nginx/sites-available/$DOMAIN_NAME';
  const kept = nginx.indexOf(`\n    if [ -f ${site} ]; then\n        cp -p ${site} ${site}.previous\n    fi\n    cat > ${site} << 'EOF'\n`);
  const tested = nginx.indexOf('\n    $NGINX_TEST\n');
  const restarted = nginx.indexOf('\n    systemctl restart nginx\n');
  assert.ok(kept > -1 && kept < tested && tested < restarted, 'kept, written, tested, then restarted');
  // The one test of the site file, which steps 3 and 4 both run (its cases run below): refused, the file before comes
  // back (the site is left out when there was none) and the step stops; accepted, the copy goes.
  const test = nginxTest();
  assert.match(test, /^NGINX_SAID=\\\$\(nginx -t 2>&1\) && NGINX_OK=1 \|\| NGINX_OK=\n/);
  assert.ok(test.includes(`\n        if [ -f ${site}.previous ]; then\n            mv ${site}.previous ${site}\n        else\n            rm -f /etc/nginx/sites-enabled/$DOMAIN_NAME ${site}\n        fi\n`));
  assert.match(test, /\n        exit 1\n    fi\n    rm -f \/etc\/nginx\/sites-available\/\$DOMAIN_NAME\.previous$/);
  assert.equal(SCRIPT.match(/^ {4}\$NGINX_TEST$/gm).length, 2);
  assert.doesNotMatch(SCRIPT, /^[ \t]*(?:if !?\s*)?nginx -t\b/m, 'no test of nginx outside it');
  // Step 4: each name is resolved inside the host's block, before certbot; an IPv6 address of any name stops it, since
  // the site file listens on IPv4 only; nothing resolves on the operator's side.
  const cert = step(4);
  const loop = cert.indexOf('\n    for HOST_NAME in $SITE_NAMES; do\n');
  assert.ok(loop > -1 && loop < cert.indexOf('certbot certonly'));
  assert.match(cert.slice(loop), /^\n[^\n]*\n        RESOLVED_V4=\\\$\(dig \+short A \\\$HOST_NAME \| grep -E '\^\[0-9\.\]\+\\\$' \| sort -u [^\n]*\)\n        if \[ \\"\\\$RESOLVED_V4\\" != \$SERVER_IP \]; then\n            echo [^\n]* >&2\n            exit 1\n        fi\n        RESOLVED_V6=\\\$\(dig \+short AAAA \\\$HOST_NAME [^\n]*\)\n        if \[ -n \\"\\\$RESOLVED_V6\\" \]; then\n            echo [^\n]* >&2\n            exit 1\n        fi\n    done\n/);
  assert.doesNotMatch(nginxSite(SCRIPT), /listen \[::\]/, 'the site file listens on IPv4 only');
  assert.match(step(1), /\n    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-upgrade [^\n]* bind9-dnsutils\n/);
  assert.doesNotMatch(SCRIPT, /\bgetent\b|ahostsv4|\bip -6\b/);
  assert.doesNotMatch(SCRIPT.replace(/run_remote "\n[\s\S]*?\n"\n/g, ''), /\bdig \+short\b/);
});

// Every figure the deploy's closing summary and the status script print is one the host measures as they run; the
// summary ends with the status script's own report, which every run writes first, so a run of any steps reports with
// this script's version of it. The monitoring it names is reached as the firewall leaves it: over SSH, not on a public
// port.
test('the deploy\'s closing summary and the status script print only what the host measures, the script written on every run', () => {
  const status = heredoc('/root/status-aiqnet.sh');
  const closing = SCRIPT.slice(SCRIPT.indexOf('\necho -e "${GREEN}Steps $STEPS completed${NC}"\n'));
  assert.ok(closing.length > 0 && closing.includes(status), 'the status script is the closing\'s own');
  assert.equal(SCRIPT.split("cat > /root/status-aiqnet.sh << 'EOF'").length, 2, 'one writer of it');
  assert.ok(!/^if runs \d; then$/m.test(closing), 'after every step, outside them');
  for (const text of [status, closing]) assert.doesNotMatch(text, /\d[\d,.]*\s*(?:MB|GB|\/sec)|transfers|Reykjavik|Location/i);
  assert.doesNotMatch(SCRIPT, /Reykjavik|Location: /);
  // Each line of the status script prints a heading or what one of its commands produces.
  for (const line of status.split('\n').filter((l) => /^echo /.test(l))) {
    assert.ok(line.includes('\\$(') || /^echo '[^'\d]*'$/.test(line), line);
  }
  assert.match(status, /\nsystemctl --no-pager status qnet-explorer\.service qnet-indexer\.service\n/);
  assert.match(status, /curl -s --max-time 10 https:\/\/\$DOMAIN_NAME\/api\/sync\/start/);
  assert.match(status, /openssl x509 -enddate -noout -in \$LE_LIVE\/fullchain\.pem/);
  assert.match(closing, /\nrun_remote "\n    cat > \/root\/status-aiqnet\.sh << 'EOF'\n[\s\S]*\nEOF\n    chmod \+x \/root\/status-aiqnet\.sh\n    \/root\/status-aiqnet\.sh\n"\n$/);
  assert.doesNotMatch(SCRIPT, /(?:aiqnet\.io|\$DOMAIN_NAME|\$SERVER_IP):19999/);
  assert.match(closing, /ssh -p \$SSH_PORT -L 19999:127\.0\.0\.1:19999 \$SSH_USER@\$SERVER_IP/);
  // Only SSH_PORT and nginx's ports are let in: the port-22 rule earlier versions of the script added by name goes.
  assert.match(step(1), /\n\s+ufw default deny incoming\n\s+ufw default allow outgoing\n\s+if \[ \$SSH_PORT != 22 \]; then ufw delete allow 'ssh' \|\| true; fi\n\s+ufw allow \$SSH_PORT\/tcp\n\s+ufw allow 'Nginx Full'\n/);
});

// A location that proxies without the request's Host hands the app nginx's upstream name, 127.0.0.1:3000, which
// it takes for a local run, and a prefix /_next/static without the slash also catches /_next/staticx: either
// would serve the whole site's shell on the link origin.
test('every location that proxies to the app passes the Host; the build assets are exactly /_next/static/', () => {
  for (const s of servers(SCRIPT)) {
    for (const l of s.locations.filter((x) => /proxy_pass /.test(x))) {
      assert.match(l, /\n\s+proxy_set_header Host \\\$host;/, `${s.names}: ${l.split('\n')[0].trim()}`);
    }
    const assets = s.locations.filter((l) => /_next\/static/.test(l.split('\n')[0]));
    for (const l of assets) assert.match(l.split('\n')[0], /^\s*location \^~ \/_next\/static\/ \{$/, `${s.names}`);
  }
  assert.doesNotMatch(nginxSite(SCRIPT), /location \/_next\/static(?!\/)/);
  // Both proxying hosts serve the assets that way.
  const tls = servers(SCRIPT).filter((s) => s.tls && /proxy_pass/.test(s.block));
  assert.deepEqual(tls.map((s) => s.names.join()).sort(), ['aiqnet.io', 'link.aiqnet.io']);
  for (const s of tls) assert.equal(s.locations.filter((l) => /^\s*location \^~ \/_next\/static\/ \{/.test(l)).length, 1, s.names.join());
});

// The per-IP limits and the relay's no-log rule hold only if every location in front of the app overwrites
// X-Real-IP; nginx otherwise passes a client's own header through.
test('every location that proxies to the app sets X-Real-IP to the connecting address', () => {
  const site = nginxSite(SCRIPT);
  const proxying = servers(SCRIPT).flatMap((s) => s.locations.filter((l) => /proxy_pass /.test(l)).map((l) => ({ names: s.names, l })));
  assert.equal(proxying.length, site.match(/proxy_pass /g).length, 'every proxy_pass sits in a location');
  for (const { names, l } of proxying) {
    assert.match(l, /\n\s+proxy_set_header X-Real-IP \\\$remote_addr;/, `${names}: ${l.split('\n')[0].trim()}`);
  }
});

// One origin for the site, so the relay's, the faucet's and the extension's origin checks hold: the proxying block
// names only aiqnet.io; www. and explorer. redirect there without reaching the app; every name has the certificate
// and the DNS check.
test('aiqnet.io alone proxies; www.aiqnet.io and explorer.aiqnet.io only redirect to it; all four names are certified', () => {
  const tls = servers(SCRIPT).filter((s) => s.tls);
  const byNames = Object.fromEntries(tls.map((s) => [s.names.join(' '), s]));
  assert.deepEqual(Object.keys(byNames).sort(), ['aiqnet.io', 'link.aiqnet.io', 'www.aiqnet.io explorer.aiqnet.io']);
  const others = byNames['www.aiqnet.io explorer.aiqnet.io'];
  assert.doesNotMatch(others.block, /proxy_pass/);
  assert.ok(others.locations.length >= 3);
  // Each location of a redirecting block returns the same path on aiqnet.io; its bare root, by the map below.
  const redirectsHome = (server, status) => {
    for (const l of server.locations) {
      const target = /^\s*location = \/ \{/.test(l) ? '\\$aiqnet_old_root\\$is_args\\$args' : '\\$request_uri';
      assert.ok(l.includes(`\n        return ${status} https://aiqnet.io${target};\n`), l.split('\n')[0]);
    }
  };
  redirectsHome(others, 308);
  // The bare root of explorer.aiqnet.io, the explorer's former host, keeps leading to the explorer.
  assert.match(nginxSite(SCRIPT), /\nmap \\\$host \\\$aiqnet_old_root \{\n\s+default \/;\n\s+explorer\.aiqnet\.io \/explorer;\n\}\n/);
  const plain = servers(SCRIPT).filter((s) => !s.tls);
  const site80 = plain.find((s) => s.names.includes('aiqnet.io'));
  assert.deepEqual(site80.names, ['aiqnet.io', 'www.aiqnet.io', 'explorer.aiqnet.io']);
  // Over http too: every return sits in a location, so the root's is reached.
  assert.equal(site80.locations.length, 2);
  redirectsHome(site80, 301);
  assert.equal(site80.block.match(/return 301 /g).length, 2);
  const names = tls.flatMap((s) => s.names).sort();
  const certified = [...(/certbot certonly --nginx --cert-name aiqnet\.io ((?:-d \S+ )+)/.exec(SCRIPT)[1].matchAll(/-d (\S+)/g))].map((m) => m[1]).sort();
  assert.deepEqual(certified, names);
  // The DNS check and nginx's own test take the names from SITE_NAMES, the four names of the site file.
  assert.equal(/for HOST_NAME in ([^;]+); do/.exec(SCRIPT)[1], '$SITE_NAMES');
  const listed = /^SITE_NAMES="([^"]+)"$/m.exec(SCRIPT)[1].replace(/\$DOMAIN_NAME/g, 'aiqnet.io').split(/\s+/).sort();
  assert.deepEqual(listed, names);
  assert.ok(nginxTest().includes("grep -qxF \\\"\\$(printf '%s\\n' $SITE_NAMES)\\\""));
});

// Every shell script under these folders of the repository (dependencies and build output skipped).
function shellScripts() {
  const out = [];
  const walk = (rel) => {
    const dir = new URL(rel, REPO);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', '.next', 'target', 'dist-indexer', '.git'].includes(entry.name)) walk(`${rel}${entry.name}/`);
      } else if (/\.(sh|bash)$/.test(entry.name)) {
        out.push(`${rel}${entry.name}`);
      }
    }
  };
  for (const rel of ['deployment/', 'scripts/', '.github/', 'infrastructure/', 'applications/qnet-explorer/']) walk(rel);
  return out.sort();
}

// A line that writes into nginx's site folders: a redirect, tee, cp, mv, install or ln whose line names one.
const SITE_WRITE = /^.*(?:>|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bln\b)[^\n]*\/etc\/nginx\/sites-(?:available|enabled)\/.*$/gm;

// A second script writing /etc/nginx/sites-available/aiqnet.io would replace the deploy script's file, and with it
// the relay's own location (no access log pairing a session id with both devices' addresses, the Fetch Metadata
// refusal, a zone of its own) and the link host. Only the deploy script checked above writes a site of the aiqnet.io
// hosts; the hardening script writes none, refuses to run over a site file without the relay's rules, and leaves no
// file nginx refuses in place.
test('only the checked deploy script writes an nginx site for aiqnet.io; the hardening script writes none', () => {
  const scripts = shellScripts();
  assert.ok(scripts.includes('scripts/security_hardening.sh') && scripts.includes('deployment/deploy-aiqnet.sh'), scripts.join());
  const writers = scripts.filter((p) => read(REPO, p).match(SITE_WRITE)?.length > 0);
  assert.deepEqual(writers, ['deployment/deploy-aiqnet.sh', 'deployment/production-bridge/deploy.sh']);
  // The one writer that is not the deploy script of the site serves another name.
  const bridge = read(REPO, 'deployment/production-bridge/deploy.sh');
  assert.match(bridge, /^DOMAIN="bridge\.qnet\.io"$/m);
  const bridgeNames = [...bridge.matchAll(/server_name ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(bridgeNames.length > 0);
  for (const name of bridgeNames) assert.equal(name, '$DOMAIN');

  const hardening = read(REPO, 'scripts/security_hardening.sh');
  assert.equal(hardening.match(SITE_WRITE), null);
  assert.doesNotMatch(hardening, /^\s*(server|location)\b[^\n]*\{/m, 'no server or location block anywhere');
  assert.doesNotMatch(hardening, /limit_req_zone|add_header|zone=api\b/);
  assert.match(hardening, /^set -euo pipefail$/m);
  // It writes only http-level options into conf.d.
  const writes = [...hardening.matchAll(/^cat > (\S+) << 'EOF'\n([\s\S]*?)\nEOF$/gm)];
  assert.deepEqual(writes.map((m) => m[1]), ['/etc/nginx/conf.d/security-hardening.conf']);
  assert.deepEqual(writes[0][2].split('\n').filter((l) => !l.startsWith('#')), ['server_tokens off;']);
  // It checks the site file for the relay's rules first, and each rule it looks for is in the deploy script's file.
  const rules = /^for rule in ((?:'[^']+' ?)+); do$/m.exec(hardening);
  assert.ok(rules, 'the rule check');
  const site = nginxSite(SCRIPT).replace(/\\\$/g, '$');
  const needed = [...rules[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(needed, ['location ^~ /api/link/ {', 'access_log off;', 'if ($aiqnet_cross_fetch) {', 'zone=aiqnet_link', 'server_name link.aiqnet.io;']);
  for (const rule of needed) assert.ok(site.includes(rule), rule);
  assert.ok(hardening.indexOf('for rule in') < hardening.indexOf('cat > /etc/nginx/conf.d/'), 'checked before anything is written');
  assert.match(hardening, /if ! grep -qF -- "\$rule" "\$SITE_FILE"; then[\s\S]*?exit 1/);
  assert.match(hardening, /^SITE_FILE=\/etc\/nginx\/sites-available\/aiqnet\.io$/m);
  // A file nginx refuses never stays where the next restart or boot would meet it: the one before comes back (none on a
  // host that had none), outside what conf.d includes until then, and nothing is reloaded.
  const conf = '/etc/nginx/conf.d/security-hardening.conf';
  assert.ok(hardening.includes(`\nif [ -f ${conf} ]; then\n    cp -p ${conf} ${conf}.previous\nfi\ncat > ${conf} << 'EOF'\n`), 'kept first');
  assert.ok(hardening.includes(`\nif nginx -t; then\n    rm -f ${conf}.previous\n    systemctl reload nginx\n`), 'dropped once accepted');
  const c = conf.replace(/[./]/g, '\\$&');
  assert.match(hardening, new RegExp(`\\nelse\\n    if \\[ -f ${c}\\.previous \\]; then\\n        mv ${c}\\.previous ${c}\\n    else\\n        rm -f ${c}\\n    fi\\n    echo [^\\n]* >&2\\n    exit 1\\nfi\\n`), 'put back when refused');
});

// Without SOLANA_RPC_URL the node pages share the public Solana endpoint's few requests a second. Each deploy and each
// update says so until it is set, and the server logs it once in production.
test('a deploy and an update say when SOLANA_RPC_URL is not set', () => {
  // One warning, in the update script, which every deploy runs too.
  assert.equal(SCRIPT.match(/SOLANA_RPC_URL is not set/g)?.length, 1);
  const update = updateScript();
  const warned = update.indexOf("\ngrep -q '^SOLANA_RPC_URL=https://' $SITE_ENV || echo 'SOLANA_RPC_URL is not set in $SITE_ENV: the node pages share the public Solana endpoint.' >&2\n");
  assert.ok(warned > -1 && warned < update.indexOf('\nif ! systemctl restart qnet-indexer.service; then\n'), 'before the services restart');
  const endpoint = read(REPO, 'applications/qnet-explorer/frontend/src/server/solana-endpoint.ts');
  assert.match(endpoint, /if \(!warnedUrl && env\.NODE_ENV === 'production'\) \{\s*warnedUrl = true;\s*console\.warn\('\[WARN\]\[SOLANA\] rpc_url_unset fallback=public'\);/);
});

// The node pages' read passes are HMACs under CABINET_READ_KEY; a key made per process would end every pass a page
// holds at each deploy's restart. Each deploy and each update makes the key once, in the site's settings file, and
// keeps it.
test('a deploy and an update make the read pass key once and keep it', () => {
  const made = `\ngrep -Eq '^CABINET_READ_KEY=[0-9a-f]{64}\\$' $SITE_ENV || { sed -i '/^CABINET_READ_KEY=/d' $SITE_ENV; echo CABINET_READ_KEY=\\$(openssl rand -hex 32) >> $SITE_ENV; }\n`;
  // In one place: the update script, which every deploy runs too, before it restarts the site.
  assert.equal(SCRIPT.split(made).length, 2);
  const update = updateScript();
  assert.ok(update.includes(made) && update.indexOf(made) < update.indexOf('\nsystemctl restart qnet-explorer.service\n'));
  const proxy = read(REPO, 'applications/qnet-explorer/frontend/src/server/cabinet/solana-proxy.ts');
  assert.match(proxy, /export function readPassKey\(configured: string \| undefined = process\.env\.CABINET_READ_KEY\): Buffer \{/);
});

// Two roles reach the explorer's database: the site's (explorer_reader, the DATABASE_URL of $SITE_ENV, which migration
// 005 grants the activation registry) and the indexer's (qnet_user, the writer). The pg_hba.conf that both security
// scripts of postgres-security/ write admits each with one method, locally and, in production, from the allowed server.
test('the pg_hba.conf of postgres-security/ admits the site\'s role as it admits the indexer\'s', () => {
  const dir = 'applications/qnet-explorer/frontend/postgres-security/';
  const template = read(REPO, `${dir}pg_hba.security.conf`);
  const sh = read(REPO, `${dir}apply-security.sh`);
  const ps1 = read(REPO, `${dir}apply-security.ps1`);
  // Both scripts write that one file, and turn its commented application server rules into live ones with one pattern.
  assert.match(sh, /^HBA_TEMPLATE="\$\(dirname "\$0"\)\/pg_hba\.security\.conf"$/m);
  assert.match(sh, /\n\s+cp "\$HBA_TEMPLATE" "\$PG_CONFIG_DIR\/pg_hba\.conf"\n/);
  assert.doesNotMatch(sh, /cat > "\$PG_CONFIG_DIR\/pg_hba\.conf"/, 'no rules of its own');
  assert.match(ps1, /\$pgHbaConf = Join-Path \$PSScriptRoot "pg_hba\.security\.conf"/);
  const shRule = /\n\s+sed -E "s\|([^|]+)\|hostssl qnet_explorer {3}\\1 \$ALLOWED_IP\/32 scram-sha-256\|" "\$HBA_TEMPLATE" > "\$PG_CONFIG_DIR\/pg_hba\.conf"\n/.exec(sh);
  const psRule = /\n\s+\$securityHba = \$securityHba -replace '([^']+)', "hostssl qnet_explorer {3}`\$1 \$AllowedIP\/32 scram-sha-256"\n/.exec(ps1);
  assert.ok(shRule && psRule, 'the rule of each script');
  assert.equal(shRule[1].replace(/\\\$$/, '$'), psRule[1], 'one pattern');
  const pattern = new RegExp(psRule[1]);
  const live = (text) => text.split('\n').filter((l) => /^(local|host|hostssl)\s/.test(l)).map((l) => l.trim().split(/\s+/));
  const production = template.split('\n').map((l) => l.replace(pattern, 'hostssl qnet_explorer   $1 203.0.113.7/32 scram-sha-256')).join('\n');
  for (const [rules, addresses] of [[live(template), ['127.0.0.1/32', '::1/128']], [live(production), ['127.0.0.1/32', '::1/128', '203.0.113.7/32']]]) {
    const reject = rules.findIndex((f) => f.at(-1) === 'reject');
    assert.ok(reject > -1, 'everything else refused');
    for (const role of ['qnet_user', 'explorer_reader']) {
      for (const address of [null, ...addresses]) {
        const rule = rules.find((f, i) => i < reject && f[1] === 'qnet_explorer' && f[2] === role && (address === null ? f[0] === 'local' : f[3] === address));
        assert.ok(rule, `${role} ${address ?? 'local'}`);
        assert.deepEqual(rule.slice(-1), ['scram-sha-256']);
        assert.equal(rule.length, address === null ? 4 : 5, rule.join(' '));
        if (address === '203.0.113.7/32') assert.equal(rule[0], 'hostssl');
      }
    }
  }
  assert.match(SCRIPT, /DATABASE_URL of the role explorer_reader/);
  assert.match(read(REPO, 'applications/qnet-explorer/frontend/migrations/005_cabinet_activations.sql'), /TO explorer_reader;/);
});

// The database scripts leave every setting outside the checkout, whose files the site's tools read and, on the host,
// the site's user owns: no .env file, the writer's password in the operator's home (root's on the host), made letters
// and digits only and checked before it goes into SQL. The site is told its own role, never the writer's, and no node
// address is written into either script.
test('the postgres security scripts write no setting into the checkout, give the site no writer credentials and name no node', () => {
  const dir = 'applications/qnet-explorer/frontend/postgres-security/';
  const sh = read(REPO, `${dir}apply-security.sh`);
  const ps1 = read(REPO, `${dir}apply-security.ps1`);
  for (const [name, text, secret] of [['sh', sh, 'NEW_PASSWORD'], ['ps1', ps1, 'newPassword']]) {
    assert.doesNotMatch(text, /\.env\.local|[\\/]\.env\b|\.postgres_password|DB_SSL=/, `${name}: no settings file`);
    assert.doesNotMatch(text, /\d{1,3}(?:\.\d{1,3}){3}:\d+|QNET_API_URLS?=http/, `${name}: no node address`);
    assert.doesNotMatch(text, new RegExp(`^\\s*(?:echo|Write-Host) [^\\n]*\\$${secret}`, 'm'), `${name}: the password is never printed`);
    assert.ok(text.indexOf('[A-Za-z0-9]+$') > -1 && text.indexOf('[A-Za-z0-9]+$') < text.indexOf('ALTER USER'), `${name}: checked before SQL`);
  }
  assert.match(sh, /^PASSWORD_FILE="\/root\/\.qnet-explorer-writer-password"$/m);
  assert.match(sh, /\n\s+\(umask 077; echo -n "\$NEW_PASSWORD" > "\$PASSWORD_FILE"\)\n/);
  assert.match(sh, /\n\s+if ! \[\[ "\$NEW_PASSWORD" =~ \^\[A-Za-z0-9\]\+\$ \]\]; then\n[^\n]*\n\s+exit 1\n/);
  // It reports the new password set only when it was.
  assert.match(sh, /\n\s+if sudo -u postgres psql -c "ALTER USER qnet_user WITH PASSWORD '\$NEW_PASSWORD';" 2>\/dev\/null; then\n\s+echo "   Password updated successfully"\n\s+else\n/);
  assert.equal(sh.match(/Password updated successfully/g).length, 1);
  assert.match(ps1, /^\$passwordFile = Join-Path \$HOME "\.qnet-explorer-writer-password"$/m);
  assert.match(ps1, /\n\s+if \(\$newPassword -notmatch '\^\[A-Za-z0-9\]\+\$'\) \{\n\s+throw /);
  assert.match(ps1, /\$chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"\n\s+\$bytes = New-Object byte\[\] 32\n\s+\[System\.Security\.Cryptography\.RandomNumberGenerator\]::Create\(\)\.GetBytes\(\$bytes\)\n/);
  assert.doesNotMatch(ps1, /Get-Random/);
  // The writer's DATABASE_URL is given to the indexer only, in the settings file its unit reads on the host.
  const indexerEnv = /^INDEXER_ENV="([^"]+)"$/m.exec(SCRIPT)[1];
  const siteEnv = /^SITE_ENV="([^"]+)"$/m.exec(SCRIPT)[1];
  assert.ok(sh.includes(`\necho "   The indexer, the one writer, as qnet_user, in ${indexerEnv}:"\necho "     DATABASE_URL=postgresql://qnet_user:`));
  assert.ok(sh.includes(`\necho "   The site as explorer_reader, never as qnet_user, in ${siteEnv}"\n`));
  assert.ok(ps1.includes('\nWrite-Host "   Indexer: DATABASE_URL=postgresql://qnet_user:'));
  assert.ok(ps1.includes('\nWrite-Host "   Site:    DATABASE_URL=postgresql://explorer_reader:'));
  for (const text of [sh, ps1]) assert.equal(text.match(/DATABASE_URL=postgresql:\/\/qnet_user:/g).length, 1);
});

// Operator output says what happens in words: no emoji, arrows or other decorative symbols in the scripts of the host.
test('the aiqnet.io host scripts print no emoji or decorative symbols', () => {
  for (const file of ['deployment/deploy-aiqnet.sh', 'scripts/security_hardening.sh', 'applications/qnet-explorer/frontend/postgres-security/apply-security.sh']) {
    assert.deepEqual([...read(REPO, file)].filter((c) => /\p{Extended_Pictographic}|[\u2190-\u21FF\u2700-\u27BF\uFE0F]/u.test(c)), [], file);
  }
});

// ---- The script's own text, run by bash against stand-ins for the host ----

// A POSIX bash with git beside it: the system's, or on Windows Git's own (the bash first on PATH there may be another
// system's); null when there is none.
function posixBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const found = gitExec ? path.join(gitExec, '..', '..', '..', 'bin', 'bash.exe') : '';
  return existsSync(found) ? found : null;
}
const BASH = posixBash();
// How bash names a path of this machine: Git's bash on Windows reads C:\x as /c/x.
const posix = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) : p);
// Links are made as the host makes them, native ones (Git's bash on Windows copies a folder instead unless told so).
const bash = (script, args = [], env = {}, input = '') => spawnSync(BASH, ['-c', script, '_', ...args],
  { encoding: 'utf8', input, env: { ...process.env, MSYS: 'winsymlinks:nativestrict', ...env } });
// Why the tests that run the script's own text cannot run here, or false (node:test reports any other value as a skip).
const SHELL_MISSING = (() => {
  if (!BASH) return 'no POSIX bash';
  const r = bash('d=$(mktemp -d) && ln -s x "$d/l" && [ -L "$d/l" ]; s=$?; rm -rf "$d"; exit $s');
  return r.status === 0 ? false : 'no symbolic links';
})();

// A folder of its own for one test, removed after it, and its path as bash names it.
function sandbox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qnet-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sh: posix(dir) };
}

// Executables in dir/bin that stand in for commands of the host.
function stubs(dir, scripts) {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) writeFileSync(path.join(dir, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

// The remote text of step `n` as run_remote sends it: this script's configuration (changed by `config`) and the step's
// run_remote call, expanded by bash.
function rendered(dir, n, config = (text) => text) {
  const end = SCRIPT.indexOf('\n', SCRIPT.search(/^NODE_MAJOR=\d+$/m)) + 1;
  writeFileSync(path.join(dir, 'config.sh'), config(SCRIPT.slice(SCRIPT.indexOf('# Configuration\n'), end)));
  writeFileSync(path.join(dir, 'step.sh'), `${step(n)}"\n`);
  const r = bash('set -e; source "$1"; run_remote() { printf "%s" "$1"; }; source "$2"', [posix(path.join(dir, 'config.sh')), posix(path.join(dir, 'step.sh'))]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// Every file of a folder with a digest of its content and its time, links with their targets.
function digest(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const file = path.join(dir, rel, e.name);
      if (e.isSymbolicLink()) out.push(`${rel}/${e.name} -> ${readlinkSync(file)}`);
      else if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else out.push(`${rel}/${e.name} ${createHash('sha256').update(readFileSync(file)).digest('hex')} ${statSync(file).mtimeMs}`);
    }
  };
  walk('.');
  return out.sort().join('\n');
}

// Stand-ins for what a test machine must not run. sudo runs the command as this user and records whom it ran for;
// systemctl records each call and fails the start of an indexer release built broken; curl answers for the site unless
// the release current names was built broken; npm and node record where they ran and make what an install and a build
// make; df reports STUB_FREE_KIB free; date counts up; sleep records how long it was asked to wait and returns at once.
const HOST_STUBS = {
  sudo: [
    '[ "$1" = -u ] || exit 2',
    'user=$2; shift 2; [ "$1" = -H ] && shift',
    '{ printf "%s:" "$user"; printf " %s" "${@//$\'\\n\'/ }"; echo; } >> "$LOG/sudo.log"',
    'exec "$@"',
  ].join('\n'),
  systemctl: [
    'printf "%s\\n" "$*" >> "$LOG/systemctl.log"',
    'if [ "$*" = "restart qnet-indexer.service" ] && [ -e "$STUB_INDEXER_RELEASES/current/applications/qnet-explorer/frontend/dist-indexer/broken" ]; then exit 1; fi',
  ].join('\n'),
  curl: [
    'printf "%s\\n" "$*" >> "$LOG/curl.log"',
    'if [ -e "$STUB_SITE_RELEASES/current/applications/qnet-explorer/frontend/.next/broken" ]; then exit 7; fi',
  ].join('\n'),
  sleep: 'printf "%s\\n" "$*" >> "$LOG/sleep.log"',
  npm: [
    'printf "%s: npm %s\\n" "$PWD" "$*" >> "$LOG/npm.log"',
    'case "$*" in',
    '  ci) mkdir -p ../node_modules && echo installed > ../node_modules/marker ;;',
    '  "run build") [ -z "$STUB_FAIL_SITE_BUILD" ] || exit 1; mkdir -p .next && echo built > .next/BUILD_ID; if [ -n "$STUB_BROKEN_SITE" ]; then touch .next/broken; fi ;;',
    '  "run build:indexer") mkdir -p dist-indexer && echo built > dist-indexer/main.js; if [ -n "$STUB_BROKEN_INDEXER" ]; then touch dist-indexer/broken; fi ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'),
  node: [
    'case "$1" in',
    '  --version) echo v22.13.1 ;;',
    '  scripts/lockfile-check.mjs) printf "%s: lockfile-check\\n" "$PWD" >> "$LOG/npm.log" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'),
  df: 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/stub 900000000 1 $STUB_FREE_KIB 1% /"',
  flock: 'exit 0',
  date: 'n=$(( $(cat "$LOG/date" 2>/dev/null || echo 0) + 1 )); echo $n > "$LOG/date"; printf "20261101T0000%02dZ\\n" "$n"',
  openssl: `echo ${'5a'.repeat(32)}`,
  // Git's install on Windows cannot set a folder's mode; its chmod can.
  ...(process.platform === 'win32' ? { install: [
    'mode=; dirs=()',
    'while [ $# -gt 0 ]; do case "$1" in -d) ;; -m) mode=$2; shift ;; *) dirs+=("$1") ;; esac; shift; done',
    'mkdir -p "${dirs[@]}" && { [ -z "$mode" ] || chmod "$mode" "${dirs[@]}"; }',
  ].join('\n') } : {}),
};

// The update script exactly as step 2 writes it, the host's folders moved under a sandbox of its own, run there against
// a repository of its own: every file it exports, builds, links or removes, and every git command, is real.
function updateHost(t) {
  const { dir, sh } = sandbox(t);
  const moved = (text) => text
    .replace(/^(APP_DIR|SITE_RELEASES|INDEXER_DIR|INDEXER_RELEASES|SITE_ENV|INDEXER_ENV|UNIT_DIR)="\//gm, `$1="${sh}/`)
    .replace(/^GITHUB_REPO="[^"]*"$/m, `GITHUB_REPO="${sh}/origin"`);
  const text = rendered(dir, 2, moved);
  const head = "cat > /root/update-aiqnet.sh << 'EOF'\n";
  const at = text.indexOf(head) + head.length;
  assert.ok(at >= head.length, 'the update script');
  writeFileSync(path.join(dir, 'update-aiqnet.sh'), text.slice(at, text.indexOf('\nEOF\n', at) + 1).replaceAll('/run/update-aiqnet.lock', `${sh}/run/update-aiqnet.lock`));
  for (const d of ['log', 'origin', 'run', 'root', 'var/www/qnet', 'var/www/qnet-releases', 'opt/qnet-indexer', 'opt/qnet-indexer-releases', 'etc/systemd/system']) {
    mkdirSync(path.join(dir, d), { recursive: true });
  }
  const unitDir = path.join(dir, 'etc', 'systemd', 'system');
  writeFileSync(path.join(dir, 'root', 'qnet-explorer.env'), 'SOLANA_RPC_URL=https://solana.invalid\n');
  writeFileSync(path.join(dir, 'gitconfig'), '');
  stubs(dir, HOST_STUBS);
  // Git without this machine's own configuration.
  const gitEnv = { GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'deploy-test',
    GIT_AUTHOR_EMAIL: 'deploy-test@localhost', GIT_COMMITTER_NAME: 'deploy-test', GIT_COMMITTER_EMAIL: 'deploy-test@localhost' };
  const git = (...args) => {
    const r = spawnSync('git', ['-C', path.join(dir, 'origin'), ...args], { encoding: 'utf8', env: { ...process.env, ...gitEnv } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/testnet');
  const folders = { site: path.join(dir, 'var', 'www', 'qnet-releases'), indexer: path.join(dir, 'opt', 'qnet-indexer-releases') };
  return {
    dir,
    folders,
    // The units in the host's unit folder, name -> text.
    units: () => Object.fromEntries(readdirSync(unitDir).sort().map((n) => [n, readFileSync(path.join(unitDir, n), 'utf8')])),
    // A unit the host already runs, written as another deploy left it.
    unitAs(name, text) {
      writeFileSync(path.join(unitDir, name), text);
    },
    // Commits the files given to the branch the host is built from; the commit's short name.
    commit(files) {
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, 'origin', rel)), { recursive: true });
        writeFileSync(path.join(dir, 'origin', rel), content);
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'change');
      return git('rev-parse', '--short=12', 'HEAD');
    },
    // One run of the update script, with what each stand-in recorded during it.
    run(args = [], env = {}) {
      for (const f of ['sudo.log', 'npm.log', 'systemctl.log', 'curl.log', 'sleep.log']) writeFileSync(path.join(dir, 'log', f), '');
      const r = bash('export PATH="$ROOT/bin:$PATH"; exec bash "$ROOT/update-aiqnet.sh" "$@"', args, {
        ...gitEnv, STUB_FREE_KIB: '800000000', ...env, ROOT: sh, LOG: `${sh}/log`, STUB_INDEXER_RELEASES: `${sh}/opt/qnet-indexer-releases`,
        STUB_SITE_RELEASES: `${sh}/var/www/qnet-releases`,
      });
      const log = (f) => readFileSync(path.join(dir, 'log', f), 'utf8').split('\n').filter(Boolean);
      return {
        status: r.status, stderr: r.stderr, sudo: log('sudo.log'), npm: log('npm.log'), systemctl: log('systemctl.log'), curl: log('curl.log'),
        sleep: log('sleep.log'),
      };
    },
    // A releases folder: its releases, and the ones current and previous name.
    releases(kind) {
      const link = (name) => { try { return readlinkSync(path.join(folders[kind], name)); } catch { return null; } };
      const names = readdirSync(folders[kind]).filter((n) => !n.startsWith('.') && n !== 'current' && n !== 'previous').sort();
      return { names, current: link('current'), previous: link('previous') };
    },
  };
}

// The commands npm and the lockfile check ran in one release's frontend, in their order.
const ranIn = (lines, folder, release) => lines.filter((l) => l.includes(`/${path.basename(folder)}/${release}/applications/qnet-explorer/frontend: `))
  .map((l) => l.slice(l.lastIndexOf(': ') + 2));

// An update builds the site's release, and the indexer's when its inputs changed, each in a new folder, from the
// commit's own files, while the services run on from theirs; it switches each service to its new release in one rename
// and restarts it, keeps the release before for a rollback and removes older ones, and builds nothing on a disk too full
// for its builds.
test('an update builds each release in a folder of its own and switches the services to it at once, keeping the one before', { skip: SHELL_MISSING }, async (t) => {
  const host = updateHost(t);
  let c = host.commit({
    'README.md': 'the repository\n',
    'applications/qnet-explorer/package.json': '{"workspaces":["frontend"]}\n',
    'applications/qnet-explorer/package-lock.json': '{"lockfileVersion":3}\n',
    'applications/qnet-explorer/frontend/package.json': '{}\n',
    'applications/qnet-explorer/frontend/scripts/lockfile-check.mjs': '\n',
    'applications/qnet-explorer/frontend/tsconfig.indexer.json': '{}\n',
    'applications/qnet-explorer/frontend/src/indexer/main.ts': 'export {};\n',
    'applications/qnet-explorer/frontend/migrations/001_init.sql': 'SELECT 1;\n',
    'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 1;\n',
  });
  const front = (kind, release) => path.join(host.folders[kind], release, 'applications', 'qnet-explorer', 'frontend');
  const record = (release, name) => readFileSync(path.join(host.folders.indexer, release, name), 'utf8');
  // The first update puts both units in, each loaded right before its restart; later ones find them unchanged.
  const FIRST = ['daemon-reload', 'enable --no-reload qnet-indexer.service', 'restart qnet-indexer.service',
    'daemon-reload', 'enable --no-reload qnet-explorer.service', 'restart qnet-explorer.service'];
  const RESTARTS = ['restart qnet-indexer.service', 'restart qnet-explorer.service'];
  let r;

  await t.test('a host with no release yet: nothing to roll back to, and no other command taken', () => {
    r = host.run(['rollback']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no previous release: nothing was changed\./);
    assert.equal(host.run(['now']).status, 2);
    assert.deepEqual(host.releases('site').names, []);
  });

  await t.test('the first update builds both releases from the commit and switches each service to its own', () => {
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const site = host.releases('site');
    const indexer = host.releases('indexer');
    assert.equal(site.names.length, 1);
    assert.ok(site.names[0].endsWith(`-${c}`), site.names[0]);
    assert.deepEqual([site.current, site.previous], [site.names[0], null]);
    assert.deepEqual(indexer, site, 'the indexer\'s release is named as the site\'s');
    // The site's release holds the commit's applications/qnet-explorer only, installed and built there, its data/ the
    // checkout's; the checkout itself is never installed or built in.
    const sf = front('site', site.current);
    assert.ok(existsSync(path.join(sf, 'src', 'app', 'page.tsx')));
    assert.equal(existsSync(path.join(host.folders.site, site.current, 'README.md')), false);
    assert.ok(existsSync(path.join(sf, '.next', 'BUILD_ID')) && existsSync(path.join(sf, '..', 'node_modules', 'marker')));
    const checkout = path.join(host.dir, 'var', 'www', 'qnet', 'applications', 'qnet-explorer');
    assert.equal(realpathSync(path.join(sf, 'data')), realpathSync(path.join(checkout, 'frontend', 'data')));
    assert.equal(existsSync(path.join(checkout, 'node_modules')) || existsSync(path.join(checkout, 'frontend', '.next')), false);
    // The indexer's release holds its inputs alone, built, with the records the next update compares.
    const xf = front('indexer', indexer.current);
    assert.ok(existsSync(path.join(xf, 'dist-indexer', 'main.js')) && existsSync(path.join(xf, 'migrations', '001_init.sql')));
    assert.equal(existsSync(path.join(xf, 'src', 'app')), false);
    for (const name of ['.built-inputs', '.installed-inputs']) assert.match(record(indexer.current, name), /^[0-9a-f]{64}\n$/);
    // Each install and build ran in its own release, the lockfile checked first, as its own user.
    assert.deepEqual(ranIn(r.npm, host.folders.site, site.current), ['lockfile-check', 'npm ci', 'npm run build']);
    assert.deepEqual(ranIn(r.npm, host.folders.indexer, indexer.current), ['lockfile-check', 'npm ci', 'npm run build:indexer']);
    assert.equal(r.npm.length, 6, r.npm.join('\n'));
    assert.ok(r.sudo.some((l) => l.startsWith('aiqnet: bash -c ') && l.includes(' npm run build ')), 'the site built by its user');
    assert.ok(r.sudo.some((l) => l.startsWith('qnet-indexer-build: bash -c ') && l.includes(' npm run build:indexer ')), 'the indexer by its builder');
    assert.deepEqual(r.systemctl, FIRST);
    // Both units are in place as the script writes them, nothing kept beside them on a host that had none.
    const units = host.units();
    assert.deepEqual(Object.keys(units), ['qnet-explorer.service', 'qnet-indexer.service']);
    for (const name of ['qnet-explorer', 'qnet-indexer']) assert.match(units[`${name}.service`], /\nType=exec\n[\s\S]*\nWantedBy=multi-user\.target\n$/, name);
    // The site counted as started once it served the home page of aiqnet.io on its port.
    assert.equal(r.curl.length, 1);
    assert.match(r.curl[0], /-H Host: aiqnet\.io http:\/\/127\.0\.0\.1:3000\/$/);
    assert.deepEqual(r.sleep, [], 'no wait once it answers');
  });

  await t.test('an update of the site alone builds a new site release beside the running one, nothing of the indexer', () => {
    const before = host.releases('site');
    const running = digest(path.join(host.folders.site, before.current));
    const indexer = host.releases('indexer');
    c = host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 2;\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const site = host.releases('site');
    assert.ok(site.current.endsWith(`-${c}`), site.current);
    assert.equal(site.previous, before.current);
    assert.deepEqual(site.names, [before.current, site.current]);
    assert.equal(digest(path.join(host.folders.site, before.current)), running, 'the release the site ran was not written while the next one was built');
    assert.deepEqual(host.releases('indexer'), indexer);
    assert.deepEqual(r.npm.filter((l) => l.includes('/qnet-indexer-releases/')), [], 'nothing of the indexer installed or built');
    assert.deepEqual(r.sudo.filter((l) => l.startsWith('qnet-indexer-build:') && l.includes('git fetch')), [], 'nor fetched');
    assert.deepEqual(r.systemctl, RESTARTS);
  });

  await t.test('each releases folder keeps the running release and the one before it, no older one', () => {
    const before = host.releases('site');
    c = host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 3;\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const site = host.releases('site');
    assert.deepEqual([site.previous, site.names.length], [before.current, 2]);
    assert.equal(existsSync(path.join(host.folders.site, before.previous)), false);
  });

  await t.test('a .env file in the checkout stops the update before anything is built or switched', () => {
    const env = path.join(host.dir, 'var', 'www', 'qnet', 'applications', 'qnet-explorer', 'frontend', '.env.local');
    writeFileSync(env, 'DATABASE_URL=postgresql://x\n');
    const before = host.releases('site');
    r = host.run();
    rmSync(env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\.env\.local exists: move each setting it holds into \S*qnet-explorer\.env .*Nothing was built or switched\./);
    assert.deepEqual(host.releases('site'), before);
    assert.deepEqual(r.systemctl, []);
  });

  await t.test('a site build that fails switches and restarts nothing', () => {
    const before = host.releases('site');
    c = host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 4;\n' });
    r = host.run([], { STUB_FAIL_SITE_BUILD: '1' });
    assert.notEqual(r.status, 0);
    const site = host.releases('site');
    assert.deepEqual([site.current, site.previous, site.names.length], [before.current, before.previous, 3]);
    assert.deepEqual(r.systemctl, []);
  });

  await t.test('a disk too full for the builds stops the update before any build, after the unused release is removed', () => {
    const before = host.releases('site');
    r = host.run([], { STUB_FREE_KIB: '1000' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The disk of \S+ has 0 MB free; this update needs \d+ MB, 1024 MB of them left free for the database and the logs\. Free space on it and run again\. Nothing was built or switched\./);
    const site = host.releases('site');
    assert.deepEqual([site.current, site.previous], [before.current, before.previous]);
    assert.deepEqual(site.names, [before.previous, before.current].sort());
    assert.deepEqual([r.npm, r.systemctl], [[], []]);
  });

  await t.test('a change of the indexer\'s sources builds an indexer release that links in the running one\'s packages', () => {
    const site0 = host.releases('site');
    const indexer0 = host.releases('indexer');
    c = host.commit({ 'applications/qnet-explorer/frontend/src/indexer/main.ts': 'export const v = 2;\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const indexer = host.releases('indexer');
    assert.ok(indexer.current.endsWith(`-${c}`), indexer.current);
    assert.equal(indexer.previous, indexer0.current);
    assert.deepEqual(ranIn(r.npm, host.folders.indexer, indexer.current), ['npm run build:indexer'], 'not installed again');
    assert.ok(existsSync(path.join(front('indexer', indexer.current), '..', 'node_modules', 'marker')));
    assert.equal(record(indexer.current, '.installed-inputs'), record(indexer0.current, '.installed-inputs'));
    assert.notEqual(record(indexer.current, '.built-inputs'), record(indexer0.current, '.built-inputs'));
    const site = host.releases('site');
    assert.deepEqual([site.current, site.previous], [indexer.current, site0.current]);
    assert.deepEqual(r.systemctl, RESTARTS);
  });

  await t.test('a change of what the indexer\'s install reads installs its packages again', () => {
    const indexer0 = host.releases('indexer');
    c = host.commit({ 'applications/qnet-explorer/package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const indexer = host.releases('indexer');
    assert.deepEqual(ranIn(r.npm, host.folders.indexer, indexer.current), ['lockfile-check', 'npm ci', 'npm run build:indexer']);
    assert.deepEqual([indexer.previous, indexer.names], [indexer0.current, [indexer0.current, indexer.current]]);
  });

  await t.test('an indexer release that does not start gives way to the one before it, and the site is not switched', () => {
    const site0 = host.releases('site');
    const indexer0 = host.releases('indexer');
    c = host.commit({ 'applications/qnet-explorer/frontend/migrations/002_next.sql': 'SELECT 2;\n' });
    r = host.run([], { STUB_BROKEN_INDEXER: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The indexer release \S+ did not start \(journalctl -u qnet-indexer\): \S+ runs again, and the site was not switched\./);
    const indexer = host.releases('indexer');
    assert.deepEqual([indexer.current, indexer.previous], [indexer0.current, indexer0.previous]);
    const site = host.releases('site');
    assert.deepEqual([site.current, site.previous], [site0.current, site0.previous]);
    assert.deepEqual(r.systemctl, ['restart qnet-indexer.service', 'restart qnet-indexer.service']);
  });

  // A start of the process is not a site that answers: the release counts as started once it serves the home page.
  await t.test('a site release that does not answer gives way to the one before it, and no release is removed', () => {
    const site0 = host.releases('site');
    c = host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 6;\n' });
    r = host.run([], { STUB_BROKEN_SITE: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The site release \S+ did not answer on 127\.0\.0\.1:3000 within 60 s \(journalctl -u qnet-explorer\): \S+ runs again, and no release was removed\./);
    const site = host.releases('site');
    assert.deepEqual([site.current, site.previous], [site0.current, site0.previous]);
    assert.equal(site.names.filter((n) => n.endsWith(`-${c}`)).length, 1, 'the release that did not answer stays until the next update');
    // A port still closed refuses each ask at once: the 5 s after each give the release the 60 s.
    assert.equal(r.curl.length, 12);
    assert.deepEqual(r.sleep, Array(12).fill('5'));
    assert.deepEqual(r.systemctl, ['restart qnet-indexer.service', 'restart qnet-explorer.service', 'restart qnet-explorer.service']);
  });

  await t.test('rollback and rollback-indexer put the previous release back, and the one they left becomes previous', () => {
    for (const [arg, kind, unitName] of [['rollback', 'site', 'qnet-explorer'], ['rollback-indexer', 'indexer', 'qnet-indexer']]) {
      const before = host.releases(kind);
      r = host.run([arg]);
      assert.equal(r.status, 0, r.stderr);
      const after = host.releases(kind);
      assert.deepEqual([after.current, after.previous], [before.previous, before.current], arg);
      assert.deepEqual(r.systemctl, [`restart ${unitName}.service`], arg);
    }
  });

  await t.test('a current link a person pointed at its release by full path still keeps that release', () => {
    const before = host.releases('site');
    const running = path.join(host.folders.site, before.current);
    const relinked = bash('ln -sfn "$1" "$2/.current" && mv -T "$2/.current" "$2/current"', [posix(running), posix(host.folders.site)]);
    assert.equal(relinked.status, 0, relinked.stderr);
    c = host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 5;\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    const site = host.releases('site');
    assert.ok(site.current.endsWith(`-${c}`), site.current);
    assert.equal(path.basename(site.previous), before.current);
    assert.ok(existsSync(path.join(running, 'applications', 'qnet-explorer', 'frontend', '.next', 'BUILD_ID')), 'the release it ran is kept, whole');
  });

  await t.test('a rollback to a previous link that names no release changes nothing', () => {
    const before = host.releases('site');
    const relinked = bash('ln -sfn gone "$1/.previous" && mv -T "$1/.previous" "$1/previous"', [posix(host.folders.site)]);
    assert.equal(relinked.status, 0, relinked.stderr);
    r = host.run(['rollback']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no previous release: nothing was changed\./);
    assert.equal(host.releases('site').current, before.current);
    assert.deepEqual(r.systemctl, []);
  });
});

// A host that runs both services another way (units of its own, the site from a checkout) runs them on until each new
// release starts under its new unit: a unit goes in only once its release is built, the one it replaced is kept beside
// it, and a first release that does not start puts that unit back and runs what ran before.
test('a host that runs both services another way runs each on until its first release starts', { skip: SHELL_MISSING }, async (t) => {
  const OLD_SITE = '[Service]\nExecStart=/usr/bin/npm start\nWorkingDirectory=/root/QNet-Blockchain/applications/qnet-explorer/frontend\n';
  const OLD_INDEXER = '[Service]\nExecStart=/usr/bin/node dist-indexer/main.js\nWorkingDirectory=/root/QNet-Blockchain/applications/qnet-explorer/frontend\n';
  const files = {
    'applications/qnet-explorer/package.json': '{"workspaces":["frontend"]}\n',
    'applications/qnet-explorer/package-lock.json': '{"lockfileVersion":3}\n',
    'applications/qnet-explorer/frontend/package.json': '{}\n',
    'applications/qnet-explorer/frontend/scripts/lockfile-check.mjs': '\n',
    'applications/qnet-explorer/frontend/tsconfig.indexer.json': '{}\n',
    'applications/qnet-explorer/frontend/src/indexer/main.ts': 'export {};\n',
    'applications/qnet-explorer/frontend/migrations/001_init.sql': 'SELECT 1;\n',
    'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 1;\n',
  };
  const ran = (host) => {
    host.unitAs('qnet-explorer.service', OLD_SITE);
    host.unitAs('qnet-indexer.service', OLD_INDEXER);
    host.commit(files);
  };

  await t.test('a first indexer release that does not start puts its unit back, and nothing of the site changes', () => {
    const host = updateHost(t);
    ran(host);
    const r = host.run([], { STUB_BROKEN_INDEXER: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The indexer release \S+ did not start \(journalctl -u qnet-indexer\): the indexer as it ran before runs again, and the site was not switched\./);
    assert.deepEqual(host.units(), { 'qnet-explorer.service': OLD_SITE, 'qnet-indexer.service': OLD_INDEXER });
    assert.deepEqual(r.systemctl, ['daemon-reload', 'enable --no-reload qnet-indexer.service', 'restart qnet-indexer.service', 'daemon-reload', 'restart qnet-indexer.service']);
    // No link names the release that did not start, so the next update builds the indexer again.
    assert.deepEqual([host.releases('indexer').current, host.releases('site').current], [null, null]);
  });

  await t.test('a first site release that does not answer puts the site\'s unit back; the indexer keeps its new one', () => {
    const host = updateHost(t);
    ran(host);
    let r = host.run([], { STUB_BROKEN_SITE: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The site release \S+ did not answer on 127\.0\.0\.1:3000 within 60 s \(journalctl -u qnet-explorer\): the site as it ran before runs again, and no release was removed\./);
    let units = host.units();
    assert.equal(units['qnet-explorer.service'], OLD_SITE, 'the site runs as it did');
    assert.match(units['qnet-indexer.service'], /\nType=exec\n/, 'the indexer started under its new unit');
    assert.equal(units['qnet-indexer.service.previous'], OLD_INDEXER, 'the unit it replaced, kept until the next update');
    assert.deepEqual(r.systemctl, ['daemon-reload', 'enable --no-reload qnet-indexer.service', 'restart qnet-indexer.service',
      'daemon-reload', 'enable --no-reload qnet-explorer.service', 'restart qnet-explorer.service', 'daemon-reload', 'restart qnet-explorer.service']);
    assert.equal(host.releases('site').current, null);
    assert.equal(host.releases('site').names.length, 1, 'nothing removed');
    // The next update, its site fixed: the site's unit goes in for good, and no unit is kept beside another any more.
    host.commit({ 'applications/qnet-explorer/frontend/src/app/page.tsx': 'export default 2;\n' });
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    units = host.units();
    assert.deepEqual(Object.keys(units), ['qnet-explorer.service', 'qnet-explorer.service.previous', 'qnet-indexer.service']);
    assert.equal(units['qnet-explorer.service.previous'], OLD_SITE);
    assert.deepEqual(r.systemctl, ['restart qnet-indexer.service', 'daemon-reload', 'enable --no-reload qnet-explorer.service', 'restart qnet-explorer.service']);
    assert.equal(host.releases('site').names.length, 1, 'the release that did not answer is gone, the new one runs');
    r = host.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(host.units()), ['qnet-explorer.service', 'qnet-indexer.service']);
  });
});

// The settings step 2 stops on: a first deploy with no database for either service builds nothing.
test('step 2 stops before anything is built while either service has no DATABASE_URL', { skip: SHELL_MISSING }, (t) => {
  const { dir, sh } = sandbox(t);
  const text = rendered(dir, 2, (config) => config.replace(/^(SITE_ENV|INDEXER_ENV)="\//gm, `$1="${sh}/`));
  const check = /\n    (for f in \S+ \S+; do\n        if ! grep -q '\^DATABASE_URL=' \$f; then\n[\s\S]*?\n    done)\n/.exec(text)?.[1];
  assert.ok(check && text.indexOf(check) < text.indexOf("cat > /root/update-aiqnet.sh << 'EOF'"), 'checked before the update script is written or run');
  mkdirSync(path.join(dir, 'root'));
  for (const [site, indexer, stops] of [['', 'DATABASE_URL=postgresql://w\n', true], ['DATABASE_URL=postgresql://r\n', '', true], ['DATABASE_URL=postgresql://r\n', 'DATABASE_URL=postgresql://w\n', false]]) {
    writeFileSync(path.join(dir, 'root', 'qnet-explorer.env'), site);
    writeFileSync(path.join(dir, 'root', 'qnet-indexer.env'), indexer);
    const r = bash(`set -e\n${check}\necho checked`);
    assert.equal(r.stdout.includes('checked'), !stops, r.stderr);
    if (stops) {
      assert.match(r.stderr, /^DATABASE_URL is not set in \S+qnet-(?:explorer|indexer)\.env: set it there \([^)]*explorer_reader[^)]*\), then run deploy-aiqnet\.sh 2 3 4 5 again\. Nothing was built or switched\.\n$/);
    }
  }
});

// nginx's own test of the site file, run on stand-ins: a refusal, a warning of a name served twice, or another enabled
// file that names one of the site's hosts each put the file before back; a file of another name passes.
test('the site file goes back when nginx refuses it, warns of a name served twice, or another file names one of its hosts', { skip: SHELL_MISSING }, (t) => {
  const { dir, sh } = sandbox(t);
  const nginx = path.join(dir, 'nginx');
  for (const d of ['sites-available', 'sites-enabled', 'conf.d']) mkdirSync(path.join(nginx, d), { recursive: true });
  // The configuration as step 3 reads it (rendered writes it beside the step), nginx's folders moved into the sandbox.
  rendered(dir, 3, (text) => text.replaceAll('/etc/nginx/', `${sh}/nginx/`));
  writeFileSync(path.join(dir, 'test.sh'), 'set -e\nsource "$1"\neval "$NGINX_TEST"\necho accepted\n');
  stubs(dir, { nginx: 'printf "%s\\n" "$STUB_NGINX_SAYS" >&2; exit ${STUB_NGINX_EXIT:-0}' });
  const siteFile = path.join(nginx, 'sites-available', 'aiqnet.io');
  const prepare = (others) => {
    for (const d of ['sites-enabled', 'conf.d']) for (const f of readdirSync(path.join(nginx, d))) rmSync(path.join(nginx, d, f));
    writeFileSync(siteFile, 'new site file\n');
    writeFileSync(`${siteFile}.previous`, 'site file before\n');
    const linked = bash('ln -s "$1" "$2"', [posix(siteFile), posix(path.join(nginx, 'sites-enabled', 'aiqnet.io'))]);
    assert.equal(linked.status, 0, linked.stderr);
    for (const [rel, body] of Object.entries(others)) writeFileSync(path.join(nginx, rel), body);
  };
  const run = (env = {}) => bash('export PATH="$ROOT/bin:$PATH"; bash "$ROOT/test.sh" "$ROOT/config.sh"', [], { ...env, ROOT: sh });
  for (const [name, others, env, accepted] of [
    ['nothing else names its hosts', { 'sites-enabled/sbx.aiqnet.io': 'server {\n    server_name sbx.aiqnet.io;\n}\n' }, {}, true],
    ['a commented line only', { 'conf.d/old.conf': '# server_name link.aiqnet.io;\n' }, {}, true],
    ['another site names link.aiqnet.io', { 'sites-enabled/link.aiqnet.io': 'server {\n    listen 443 ssl;\n    server_name link.aiqnet.io;\n}\n' }, {}, false],
    ['a conf.d file names www.aiqnet.io among others', { 'conf.d/redirects.conf': 'server {\n\tserver_name  example.org www.aiqnet.io;\n}\n' }, {}, false],
    ['nginx warns of a name served twice', {}, { STUB_NGINX_SAYS: 'nginx: [warn] conflicting server name "aiqnet.io" on 0.0.0.0:443, ignored' }, false],
    ['nginx refuses the file', {}, { STUB_NGINX_EXIT: '1', STUB_NGINX_SAYS: 'nginx: [emerg] unexpected "}"' }, false],
  ]) {
    prepare(others);
    const r = run(env);
    assert.equal(r.stdout.includes('accepted'), accepted, `${name}: ${r.stderr}`);
    assert.equal(readFileSync(siteFile, 'utf8'), accepted ? 'new site file\n' : 'site file before\n', name);
    assert.equal(existsSync(`${siteFile}.previous`), false, name);
    if (!accepted) assert.match(r.stderr, /the one before is back and nginx runs on as it was\. This site file serves aiqnet\.io www\.aiqnet\.io explorer\.aiqnet\.io link\.aiqnet\.io: take them out of any other file, then run again\./, name);
    if (Object.keys(others).length > 0 && !accepted) assert.ok(r.stderr.includes(`(${sh}/nginx/${Object.keys(others)[0]})`), `${name}: names the other file`);
  }
});

// An apt command that upgrades packages: `upgrade` itself, never `--no-upgrade`.
const UPGRADES = /\bapt(?:-get)?\b[^\n]*(?<!no-)\bupgrade\b/;

// The whole script run against a stand-in ssh that records the port and the remote text of each call.
function deployRun(t, args, env = {}) {
  const { dir, sh } = sandbox(t);
  mkdirSync(path.join(dir, 'calls'));
  stubs(dir, { ssh: [
    'port=',
    'while [ $# -gt 1 ]; do [ "$1" = -p ] && port=$2; shift; done',
    'n=$(ls "$CALLS" | wc -l)',
    'printf "%s\\n%s" "$port" "$1" > "$CALLS/$(printf %03d $n)"',
  ].join('\n') });
  const script = posix(fileURLToPath(new URL('deployment/deploy-aiqnet.sh', REPO)));
  const r = bash('export PATH="$ROOT/bin:$PATH"; exec bash "$SCRIPT" "$@"', args, { ...env, ROOT: sh, CALLS: `${sh}/calls`, SCRIPT: script }, '\n');
  const calls = readdirSync(path.join(dir, 'calls')).sort().map((f) => {
    const text = readFileSync(path.join(dir, 'calls', f), 'utf8');
    return { port: text.slice(0, text.indexOf('\n')), text: text.slice(text.indexOf('\n') + 1) };
  });
  return { status: r.status, stderr: r.stderr, calls };
}

// One SSH_PORT (2222, the host's, unless the operator sets another) for every connection, every command the script
// prints and the host's firewall and fail2ban rules: a firewall that allows another port than sshd's cuts every new
// session. The steps named run in the script's order; the host's packages are upgraded only by the step that says so.
test('every connection, printed command and SSH rule uses SSH_PORT, and the steps named run in the script\'s order', { skip: SHELL_MISSING }, (t) => {
  assert.match(SCRIPT, /^SSH_PORT="\$\{SSH_PORT:-2222\}"$/m);
  assert.match(SCRIPT, /\n    ssh -p "\$SSH_PORT" \$SSH_OPTS \$SSH_USER@\$SERVER_IP "\$1"\n/);
  // The script copies no file to the host: every remote step is a command of its own.
  assert.doesNotMatch(SCRIPT, /\bscp\b|copy_to_remote/);
  // Every ssh command outside the comments (the connection and each command the summary prints), and the key hint.
  const sshCommands = SCRIPT.replace(/^[ \t]*#.*$/gm, '').match(/\bssh(?:-keyscan)? [^\n]*/g);
  assert.ok(sshCommands.length >= 7, sshCommands.join('\n'));
  for (const command of sshCommands) assert.match(command, /^ssh -p "?\$SSH_PORT"? /, command);
  assert.match(SCRIPT, /\n# assurance, pre-provision the host key: ssh-keyscan -p \$SSH_PORT \$SERVER_IP >> ~\/\.ssh\/known_hosts\n/);
  assert.doesNotMatch(SCRIPT, /ufw allow ssh\b|\bport = (?!\$SSH_PORT)/);
  assert.match(step(1), /\n    ufw allow \$SSH_PORT\/tcp\n[\s\S]*\n    printf '\[sshd\]\\nport = \$SSH_PORT\\n' > \/etc\/fail2ban\/jail\.d\/qnet-sshd\.local\n    systemctl enable fail2ban\n    systemctl restart fail2ban\n/);
  assert.match(SCRIPT, /^STEPS="\$\{\*:-1 2 3 4 5\}"$/m);

  const all = deployRun(t, []);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.calls.length, 6, 'steps 1 to 5, then the status report');
  assert.deepEqual([...new Set(all.calls.map((c) => c.port))], ['2222']);
  assert.match(all.calls[0].text, /\n    ufw allow 2222\/tcp\n/);
  assert.ok(all.calls.every((c) => !UPGRADES.test(c.text)), 'no package upgrade unless named');
  const named = deployRun(t, ['3', 'upgrade', '1'], { SSH_PORT: '2201' });
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(named.calls.map((c) => c.port), ['2201', '2201', '2201', '2201']);
  assert.match(named.calls[0].text, /\n    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade\n/);
  assert.match(named.calls[1].text, /\n    ufw allow 2201\/tcp\n/);
  assert.match(named.calls[2].text, /\n    cat > \/etc\/nginx\/sites-available\/aiqnet\.io << 'EOF'\n/);
  // Every run ends with the status report, written first by the run itself, whatever steps it named.
  assert.match(named.calls[3].text, /^\n    cat > \/root\/status-aiqnet\.sh << 'EOF'\n#!\/bin\/bash\n[\s\S]*\n    \/root\/status-aiqnet\.sh\n$/);
  assert.equal(named.calls[3].text, all.calls[5].text.replaceAll('2222', '2201'));
  for (const [args, env] of [[['6'], {}], [['7'], {}], [['2'], { SSH_PORT: '22x' }], [['2'], { SSH_PORT: '70000' }]]) {
    const refused = deployRun(t, args, env);
    assert.deepEqual([refused.status, refused.calls], [2, []], `${args} ${JSON.stringify(env)}`);
  }
});

// Step 1 may run again on a running host: the host's name gets its line in /etc/hosts once, and the firewall is never
// enabled from a session that came in on another port than the one it allows.
test('step 1 can run again: the host name line is added once, and the firewall never closes the session\'s own port', { skip: SHELL_MISSING }, (t) => {
  const { dir } = sandbox(t);
  const text = rendered(dir, 1);
  assert.match(text, /^\n    set -e\n/);
  const hostsLine = text.split('\n').find((l) => l.includes('/etc/hosts')).trim().replaceAll('/etc/hosts', '"$1"');
  const hosts = path.join(dir, 'hosts');
  for (const [before, added] of [['127.0.0.1 localhost\n', 1], ['127.0.1.1 aiqnet\n', 0], ['# 127.0.0.1 aiqnet\n127.0.0.1 aiqnet.io\n', 1]]) {
    writeFileSync(hosts, before);
    for (let run = 0; run < 2; run++) assert.equal(bash(hostsLine, [posix(hosts)]).status, 0);
    assert.equal(readFileSync(hosts, 'utf8'), before + '127.0.0.1 aiqnet\n'.repeat(added), before);
  }
  const guard = /\n    (if \[ "\$\{SSH_CONNECTION##\* \}" != 2222 \]; then\n[\s\S]*?\n    fi)\n/.exec(text)?.[1];
  assert.ok(guard && text.indexOf(guard) < text.indexOf('\n    apt '), 'the session\'s port is checked before anything changes');
  for (const [connection, passes] of [['203.0.113.5 50000 195.246.231.53 2222', true], ['203.0.113.5 50000 195.246.231.53 22', false]]) {
    const r = bash(`${guard}\necho passed`, [], { SSH_CONNECTION: connection });
    assert.equal(r.stdout.includes('passed'), passes, connection);
    if (!passes) assert.match(r.stderr, /reached sshd on port 22, not SSH_PORT=2222.* Nothing was changed\./);
  }
  // The self-signed pair the site file names is the one ssl-cert makes, made again when it is missing.
  assert.ok(nginxSite(SCRIPT).includes('\n    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;\n    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;\n'));
  assert.match(text, /\n    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-upgrade nginx [^\n]*\bssl-cert\b[^\n]*\n    if \[ ! -f \/etc\/ssl\/certs\/ssl-cert-snakeoil\.pem \] \|\| \[ ! -f \/etc\/ssl\/private\/ssl-cert-snakeoil\.key \]; then\n        make-ssl-cert generate-default-snakeoil --force-overwrite\n    fi\n/);
  // A running host keeps what it has: no package it has is upgraded, and Node.js only comes in where none of its line
  // or a later one runs; needrestart restarts nothing.
  assert.doesNotMatch(text, UPGRADES);
  const node = /\n    (if ! command -v node > \/dev\/null \|\| \[ "\$\(node --version \| sed 's\/\^v\/\/; s\/\\\.\.\*\/\/'\)" -lt 22 \]; then\n[\s\S]*?\n    fi)\n/.exec(text)?.[1];
  assert.ok(node, 'Node.js installed only when missing or older');
  assert.match(node, /\n        curl -fsSL https:\/\/deb\.nodesource\.com\/setup_22\.x \| bash -\n        DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y nodejs\n/);
  assert.equal(text.match(/apt-get install /g).length, 2);
  assert.ok(text.match(/apt-get install [^\n]*/g).every((l) => text.includes(`NEEDRESTART_MODE=l ${l}`)), 'needrestart only lists');
  // The firewall: SSH_PORT, nginx's ports, and the port-22 rule of earlier versions gone (kept when SSH_PORT is 22).
  assert.match(text, /\n    if \[ 2222 != 22 \]; then ufw delete allow 'ssh' \|\| true; fi\n    ufw allow 2222\/tcp\n/);
});

// Step 4's own check, run on stand-ins for dig (and getent and ip): certbot is reached only when every IPv4 address of
// every name is the server's and no name has an IPv6 address, since every block of the site file listens on IPv4 only
// and a challenge also goes to an AAAA address.
test('step 4 stops at a name with another IPv4 address, or with any IPv6 address', { skip: SHELL_MISSING }, (t) => {
  const { dir, sh } = sandbox(t);
  const text = rendered(dir, 4);
  writeFileSync(path.join(dir, 'check.sh'), `${text.slice(0, text.lastIndexOf('\n', text.indexOf('Obtaining the certificate')))}\necho DNS-OK\n`);
  stubs(dir, {
    dig: 'echo aiqnet.io.; case "$2" in A) for a in $STUB_A; do echo "$a"; done ;; AAAA) for a in $STUB_AAAA; do echo "$a"; done ;; esac',
    ip: 'for a in $STUB_HOST_V6; do printf "2: eth0    inet6 %s/64 scope global\\n" "$a"; done',
    getent: 'for a in $STUB_A; do echo "$a      STREAM $2"; done',
  });
  const server = /^SERVER_IP="([^"]+)"$/m.exec(SCRIPT)[1];
  for (const [name, env, passes] of [
    ['the server alone, no IPv6', { STUB_A: server }, true],
    ['an AAAA record of another host', { STUB_A: server, STUB_AAAA: '2001:db8::1' }, false],
    ['an AAAA record of this host', { STUB_A: server, STUB_AAAA: '2001:db8::1', STUB_HOST_V6: '2001:db8::1' }, false],
    ['an AAAA record written in capitals', { STUB_A: server, STUB_AAAA: '2001:DB8::1', STUB_HOST_V6: '2001:db8::1' }, false],
    ['a second IPv4 address', { STUB_A: `${server} 203.0.113.9` }, false],
    ['another IPv4 address', { STUB_A: '203.0.113.9' }, false],
    ['no address at all', {}, false],
  ]) {
    const r = bash('export PATH="$ROOT/bin:$PATH"; exec bash "$ROOT/check.sh"', [], { STUB_A: '', STUB_AAAA: '', STUB_HOST_V6: '', ...env, ROOT: sh });
    assert.equal(r.stdout.includes('DNS-OK'), passes, `${name}: ${r.stderr}`);
    if (!passes) assert.match(r.stderr, /(?:Fix DNS|Remove the AAAA record) and run again\./, name);
    if (env.STUB_AAAA) assert.match(r.stderr, /resolves to 2001:(?:db8|DB8)::1 over IPv6, but the site listens on IPv4 only\./, name);
  }
});
