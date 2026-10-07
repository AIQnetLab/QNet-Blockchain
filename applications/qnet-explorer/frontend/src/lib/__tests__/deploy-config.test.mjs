// How the site is deployed (deployment/deploy-aiqnet.sh, deploy-to-1984.sh, package.json): a supported
// Node.js line, the app reachable only through nginx on the same host, the relay's requests kept out of
// the access log, no other script of the repository (scripts/security_hardening.sh included) writing a site
// for those hosts, and the process running as an unprivileged user. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const FRONTEND = new URL('../../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read(FRONTEND, 'package.json'));
const SCRIPTS = ['deployment/deploy-aiqnet.sh', 'deployment/deploy-to-1984.sh'].map((p) => ({ path: p, text: read(REPO, p) }));
const MIN_NODE = 22;

// The nginx site file a script writes: the heredoc after `cat > /etc/nginx/sites-available/`.
function nginxSite(text) {
  const at = text.indexOf('cat > /etc/nginx/sites-available/');
  assert.ok(at > -1, 'the nginx site file');
  const body = text.indexOf('\n', at) + 1;
  return text.slice(body, text.indexOf('\nEOF\n', body));
}

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

const servers = (text) => blocks(nginxSite(text), 'server').map((block) => ({
  block,
  names: /\n\s*server_name ([^;]+);/.exec(block)[1].trim().split(/\s+/),
  tls: /\n\s*listen 443 ssl/.test(block),
  locations: blocks(block, 'location'),
}));

test('a supported Node.js line everywhere: package.json engines, the deploy scripts and their update scripts', () => {
  assert.equal(pkg.engines?.node, `>=${MIN_NODE}`);
  for (const { path, text } of SCRIPTS) {
    const major = Number(/^NODE_MAJOR=(\d+)$/m.exec(text)?.[1]);
    assert.ok(major >= MIN_NODE, `${path}: NODE_MAJOR ${major}`);
    assert.match(text, /deb\.nodesource\.com\/setup_\$NODE_MAJOR\.x/, path);
    assert.doesNotMatch(text, /setup_1\d\.x|setup_20\.x|Node\.js 18/, path);
    // The distribution's own (older) nodejs is not installed next to it.
    assert.doesNotMatch(text, /apt install -y [^\n]*\bnodejs npm\b/, path);
    // Installation and every update refuse an older node before building.
    assert.equal(text.match(/-lt \$NODE_MAJOR \]; then/g)?.length, 2, `${path}: version checks`);
  }
  for (const file of ['Dockerfile', 'docker-compose.yml']) {
    if (!existsSync(new URL(file, FRONTEND))) continue;
    const text = read(FRONTEND, file);
    for (const m of text.matchAll(/FROM node:(\d+)/g)) assert.ok(Number(m[1]) >= MIN_NODE, `${file}: node:${m[1]}`);
  }
});

test('the app listens on 127.0.0.1 only, and nginx on the host is the one way in', () => {
  assert.equal(pkg.scripts.start, 'next start -H 127.0.0.1');
  for (const { path, text } of SCRIPTS) {
    const passes = [...text.matchAll(/proxy_pass ([^;]+);/g)].map((m) => m[1]);
    assert.ok(passes.length >= 3, path);
    for (const target of passes) assert.equal(target, 'http://127.0.0.1:3000', path);
    // pm2 runs 'npm start', so the binding in package.json holds for it too.
    assert.match(text, /script: 'npm',[\s\S]*?args: 'start',/, path);
  }
  const compose = new URL('docker-compose.yml', FRONTEND);
  if (existsSync(compose)) {
    for (const m of read(FRONTEND, 'docker-compose.yml').matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)) {
      if (/:\d+$/.test(m[1])) assert.match(m[1], /^127\.0\.0\.1:/, `docker-compose publishes ${m[1]}`);
    }
  }
  const example = read(FRONTEND, 'ecosystem.config.example.js');
  assert.match(example, /args: 'run start'/);
});

test('nginx writes no access log for /api/link/ on any TLS host, so no log pairs a session id with the addresses of both devices', () => {
  for (const { path, text } of SCRIPTS) {
    const tls = servers(text).filter((s) => s.tls);
    assert.ok(tls.length >= 2, path);
    for (const server of tls) {
      const relay = server.locations.filter((l) => /^\s*location \^~ \/api\/link\/ \{/.test(l));
      assert.equal(relay.length, 1, `${path} ${server.names}: a location of its own for the relay`);
      assert.match(relay[0], /\n\s+access_log off;/, `${path} ${server.names}`);
      assert.match(relay[0], /\n\s+error_log \S+ crit;/, `${path} ${server.names}`);
    }
    // The one block that serves the relay passes it the client's address and the same nginx limit as /api.
    const serving = tls.filter((s) => s.locations.some((l) => /location \^~ \/api\/link\//.test(l) && /proxy_pass/.test(l)));
    assert.equal(serving.length, 1, `${path}: the relay is proxied by one server block`);
    const relay = serving[0].locations.find((l) => /location \^~ \/api\/link\//.test(l));
    assert.match(relay, /proxy_set_header X-Real-IP \\\$remote_addr;/, `${path}: the per-IP limits still see the client`);
    assert.match(relay, /proxy_pass http:\/\/127\.0\.0\.1:3000;/, path);
  }
});

// R4-SRA-01: any page can make a visitor's browser send GETs to /api (an <img> needs no permission). Such a
// request to the relay is refused in nginx's rewrite phase, before limit_req counts it, and the relay has a
// zone of its own, so explorer /api requests never use up the relay's budget of that address.
test('the relay refuses browser requests no page of the site made, before its own nginx limit', () => {
  const MAP = /\nmap \\\$http_sec_fetch_site \\\$aiqnet_cross_fetch \{\n\s+default 1;\n\s+'' 0;\n\s+same-origin 0;\n\}\n/;
  const REFUSE = /\n\s+if \(\\\$aiqnet_cross_fetch\) \{\n\s+return 403;\n\s+\}\n/;
  for (const { path, text } of SCRIPTS) {
    const site = nginxSite(text);
    assert.match(site, MAP, `${path}: the Fetch Metadata map`);
    const serving = servers(text).filter((s) => s.tls).flatMap((s) => s.locations)
      .filter((l) => /location \^~ \/api\/link\//.test(l) && /proxy_pass/.test(l));
    assert.equal(serving.length, 1, path);
    const relay = serving[0];
    assert.match(relay, REFUSE, `${path}: refused before the app`);
    if (/limit_req /.test(relay)) assert.ok(relay.search(REFUSE) < relay.indexOf('limit_req '), `${path}: before the limit`);
  }
  const { text } = SCRIPTS[0];
  const site = nginxSite(text);
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_api:10m rate=10r\/s;\n/);
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_link:10m rate=10r\/s;\n/);
  const aiqnet = servers(text).find((s) => s.tls && s.names.join() === 'aiqnet.io');
  const relay = aiqnet.locations.find((l) => /location \^~ \/api\/link\//.test(l));
  assert.match(relay, /\n\s+limit_req zone=aiqnet_link burst=20 nodelay;\n/, 'a zone of its own');
  const api = aiqnet.locations.find((l) => /^\s*location \/api \{/.test(l));
  assert.match(api, /\n\s+limit_req zone=aiqnet_api burst=20 nodelay;\n/);
  // Only the relay's location uses the relay's zone.
  assert.equal(site.match(/limit_req zone=aiqnet_link /g).length, 1);
});

// The node cabinet's routes name nodes, wallets and payment addresses (privacy policy: not logged). Like the relay:
// a location of its own on every TLS host, no access log, refused for another page's request before any limit, and on
// aiqnet.io a zone of its own. The phone flows start off (src/server/phone-flows.ts).
test('nginx logs nothing of /api/cabinet/, refuses other pages\' requests first, and gives it a zone of its own', () => {
  const REFUSE = /\n\s+if \(\\\$aiqnet_cross_fetch\) \{\n\s+return 403;\n\s+\}\n/;
  for (const { path, text } of SCRIPTS) {
    const tls = servers(text).filter((s) => s.tls);
    for (const server of tls) {
      const cabinet = server.locations.filter((l) => /^\s*location \^~ \/api\/cabinet\/ \{/.test(l));
      assert.equal(cabinet.length, 1, `${path} ${server.names}: a location of its own for the cabinet`);
      assert.match(cabinet[0], /\n\s+access_log off;/, `${path} ${server.names}`);
      assert.match(cabinet[0], /\n\s+error_log \S+ crit;/, `${path} ${server.names}`);
      if (!/proxy_pass/.test(cabinet[0])) assert.match(cabinet[0], /\n\s+return 308 https:\/\/[^\n]+\\\$request_uri;/, `${path} ${server.names}`);
    }
    const serving = tls.flatMap((s) => s.locations).filter((l) => /location \^~ \/api\/cabinet\//.test(l) && /proxy_pass/.test(l));
    assert.equal(serving.length, 1, `${path}: one block proxies the cabinet`);
    assert.match(serving[0], REFUSE, path);
    assert.match(serving[0], /proxy_set_header X-Real-IP \\\$remote_addr;/, path);
    if (/limit_req /.test(serving[0])) assert.ok(serving[0].search(REFUSE) < serving[0].indexOf('limit_req '), `${path}: before the limit`);
    assert.match(text, /CABINET_PHONE_FLOWS: '0'/, `${path}: the phone flows start off`);
  }
  const site = nginxSite(SCRIPTS[0].text);
  assert.match(site, /\nlimit_req_zone \\\$binary_remote_addr zone=aiqnet_cabinet:10m rate=10r\/s;\n/);
  assert.equal(site.match(/limit_req zone=aiqnet_cabinet burst=20 nodelay;/g).length, 1);
  assert.match(read(FRONTEND, 'ecosystem.config.example.js'), /CABINET_PHONE_FLOWS: '0',/);
});

// SITE-R4-CSP-01: `location /_next/static` was a prefix match without the slash and set no Host, so
// /_next/staticx on the link host reached the app as Host 127.0.0.1:3000, a "local run", and got the whole
// site's shell on the link origin. Every proxying location now passes the request's host.
test('every location that proxies to the app passes the Host; the build assets are exactly /_next/static/', () => {
  for (const { path, text } of SCRIPTS) {
    for (const s of servers(text)) {
      for (const l of s.locations.filter((x) => /proxy_pass /.test(x))) {
        assert.match(l, /\n\s+proxy_set_header Host \\\$host;/, `${path} ${s.names}: ${l.split('\n')[0].trim()}`);
      }
      const assets = s.locations.filter((l) => /_next\/static/.test(l.split('\n')[0]));
      for (const l of assets) assert.match(l.split('\n')[0], /^\s*location \^~ \/_next\/static\/ \{$/, `${path} ${s.names}`);
    }
    assert.doesNotMatch(nginxSite(text), /location \/_next\/static(?!\/)/, path);
  }
  // Both proxying hosts of deploy-aiqnet.sh serve the assets that way.
  const tls = servers(SCRIPTS[0].text).filter((s) => s.tls && /proxy_pass/.test(s.block));
  assert.deepEqual(tls.map((s) => s.names.join()).sort(), ['aiqnet.io', 'link.aiqnet.io']);
  for (const s of tls) assert.equal(s.locations.filter((l) => /^\s*location \^~ \/_next\/static\/ \{/.test(l)).length, 1, s.names.join());
});

// SITE-R3-02: the per-IP limits and the relay's no-log rule hold only if every location in front of the app
// overwrites X-Real-IP; nginx otherwise passes a client's own header through.
test('every location that proxies to the app sets X-Real-IP to the connecting address', () => {
  for (const { path, text } of SCRIPTS) {
    const site = nginxSite(text);
    const proxying = servers(text).flatMap((s) => s.locations.filter((l) => /proxy_pass /.test(l)).map((l) => ({ names: s.names, l })));
    assert.equal(proxying.length, site.match(/proxy_pass /g).length, `${path}: every proxy_pass sits in a location`);
    for (const { names, l } of proxying) {
      assert.match(l, /\n\s+proxy_set_header X-Real-IP \\\$remote_addr;/, `${path} ${names}: ${l.split('\n')[0].trim()}`);
    }
  }
});

// SITE-R3-CSP-01 / SITE-R3-02: one origin for the site. The proxying block names only aiqnet.io; www. and
// explorer. redirect there without reaching the app; every name has the certificate and the DNS check.
test('aiqnet.io alone proxies; www.aiqnet.io and explorer.aiqnet.io only redirect to it; all four names are certified', () => {
  const { text } = SCRIPTS[0];
  const tls = servers(text).filter((s) => s.tls);
  const byNames = Object.fromEntries(tls.map((s) => [s.names.join(' '), s]));
  assert.deepEqual(Object.keys(byNames).sort(), ['aiqnet.io', 'link.aiqnet.io', 'www.aiqnet.io explorer.aiqnet.io']);
  const others = byNames['www.aiqnet.io explorer.aiqnet.io'];
  assert.doesNotMatch(others.block, /proxy_pass/);
  assert.ok(others.locations.length >= 2);
  for (const l of others.locations) assert.match(l, /\n\s+return 308 https:\/\/aiqnet\.io\\\$request_uri;/, l.split('\n')[0]);
  const plain = servers(text).filter((s) => !s.tls);
  const site80 = plain.find((s) => s.names.includes('aiqnet.io'));
  assert.deepEqual(site80.names, ['aiqnet.io', 'www.aiqnet.io', 'explorer.aiqnet.io']);
  assert.match(site80.block, /return 301 https:\/\/aiqnet\.io\\\$request_uri;/);
  const names = tls.flatMap((s) => s.names).sort();
  const certified = [...(/certbot --nginx ((?:-d \S+ )+)/.exec(text)[1].matchAll(/-d (\S+)/g))].map((m) => m[1]).sort();
  assert.deepEqual(certified, names);
  const checked = /for HOST_NAME in ([^;]+); do/.exec(text)[1].replace(/\$DOMAIN_NAME/g, 'aiqnet.io').replace(/"/g, '').split(/\s+/).sort();
  assert.deepEqual(checked, names);
  // The generic script redirects its www. name the same way.
  const generic = servers(SCRIPTS[1].text).filter((s) => s.tls);
  const www = generic.find((s) => s.names.join() === 'www.$DOMAIN_NAME');
  assert.doesNotMatch(www.block, /proxy_pass/);
  assert.equal(generic.filter((s) => /proxy_pass/.test(s.block)).map((s) => s.names.join()).join(), '$DOMAIN_NAME');
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

// SRA-R5-02: scripts/security_hardening.sh replaced /etc/nginx/sites-available/aiqnet.io, the file of
// deploy-aiqnet.sh, with one that had no location of the relay's own: every relay request logged with its
// session id and both devices' addresses, no Fetch Metadata refusal, the explorer's `api` zone shared with the
// relay, no link host. Only the deploy scripts checked above write a site of the aiqnet.io hosts; the
// hardening script writes none, and refuses to run over a site file without the relay's rules.
test('only the checked deploy scripts write an nginx site for aiqnet.io; the hardening script writes none', () => {
  const scripts = shellScripts();
  assert.ok(scripts.includes('scripts/security_hardening.sh') && scripts.includes('deployment/deploy-aiqnet.sh'), scripts.join());
  const writers = scripts.filter((p) => read(REPO, p).match(SITE_WRITE)?.length > 0);
  assert.deepEqual(writers, ['deployment/deploy-aiqnet.sh', 'deployment/deploy-to-1984.sh', 'deployment/production-bridge/deploy.sh']);
  // The one writer that is not a deploy script of the site serves another name.
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
  const site = nginxSite(SCRIPTS[0].text).replace(/\\\$/g, '$');
  const needed = [...rules[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(needed, ['location ^~ /api/link/ {', 'access_log off;', 'if ($aiqnet_cross_fetch) {', 'zone=aiqnet_link', 'server_name link.aiqnet.io;']);
  for (const rule of needed) assert.ok(site.includes(rule), rule);
  assert.ok(hardening.indexOf('for rule in') < hardening.indexOf('cat > /etc/nginx/conf.d/'), 'checked before anything is written');
  assert.match(hardening, /if ! grep -qF -- "\$rule" "\$SITE_FILE"; then[\s\S]*?exit 1/);
  assert.match(hardening, /^SITE_FILE=\/etc\/nginx\/sites-available\/aiqnet\.io$/m);
});

test('the site runs as an unprivileged user that owns only the app, never as root', () => {
  for (const { path, text } of SCRIPTS) {
    assert.match(text, /^APP_USER="aiqnet"$/m, path);
    assert.match(text, /useradd --system [^\n]*--shell \/usr\/sbin\/nologin \$APP_USER/, path);
    assert.doesNotMatch(text, /pm2 startup \w+ -u root/, path);
    assert.match(text, /pm2 startup systemd -u \$APP_USER --hp \$APP_HOME/, path);
    // Every pm2 start, save, restart, install or set runs as the app user.
    for (const m of text.matchAll(/^.*\bpm2 (start|save|restart|install|set|status)\b.*$/gm)) {
      assert.match(m[0], /sudo -u \$APP_USER -H pm2 /, `${path}: ${m[0].trim()}`);
    }
    // npm ci and next build run as the app user too (install scripts never run as root); only pm2 itself is global.
    for (const m of text.matchAll(/^\s*npm (ci|install(?! -g pm2$)|run build)\b.*$/gm)) {
      // Inside a `sudo -u $APP_USER -H bash -c '` block: opened before the line, not closed (a lone ') since.
      const before = text.slice(0, m.index);
      const opened = before.lastIndexOf("sudo -u $APP_USER -H bash -c '\n");
      const closed = Math.max(-1, ...[...before.matchAll(/\n[ \t]*'\n/g)].map((c) => c.index));
      assert.ok(opened > -1 && opened > closed, `${path}: ${m[0].trim()}`);
    }
    assert.match(text, /install -m 600 -o \$APP_USER -g \$APP_USER \/dev\/null \.env\.local/, `${path}: secrets readable by the app user only`);
    assert.doesNotMatch(text, /npm ci --production/, `${path}: next build needs the full install`);
  }
  assert.doesNotMatch(read(FRONTEND, 'ecosystem.config.example.js'), /cwd: '\/root\//);
});

// SITE-R2-08: without SOLANA_RPC_URL the node pages share the public Solana endpoint's few requests a second. Each deploy
// and each update says so until it is set, and the server logs it once in production.
test('a deploy and an update say when SOLANA_RPC_URL is not set', () => {
  for (const { path, text } of SCRIPTS) {
    assert.match(text, /grep -q '\^SOLANA_RPC_URL=https:\/\/' \.env\.local \|\| echo 'SOLANA_RPC_URL is not set in \.env\.local: set a dedicated devnet endpoint before the node pages open\.' >&2/, path);
    assert.match(text, /grep -q '\^SOLANA_RPC_URL=https:\/\/' \$APP_DIR\/applications\/qnet-explorer\/frontend\/\.env\.local \|\| echo 'SOLANA_RPC_URL is not set in \.env\.local: the node pages share the public Solana endpoint\.' >&2\nsudo -u \$APP_USER -H pm2 restart/, path);
  }
  const endpoint = read(REPO, 'applications/qnet-explorer/frontend/src/server/solana-endpoint.ts');
  assert.match(endpoint, /if \(!warnedUrl && env\.NODE_ENV === 'production'\) \{\s*warnedUrl = true;\s*console\.warn\('\[WARN\]\[SOLANA\] rpc_url_unset fallback=public'\);/);
});

// SITE-R3-01: the node pages' read passes are HMACs under CABINET_READ_KEY; a key made per process would end every pass a
// page holds at each deploy's restart. Each deploy and each update makes the key once, in .env.local, and keeps it.
test('a deploy and an update make the read pass key once and keep it', () => {
  for (const { path, text } of SCRIPTS) {
    assert.match(text, /chmod 600 \.env\.local\n(?:\s*#[^\n]*\n)*\s*grep -Eq '\^CABINET_READ_KEY=\[0-9a-f\]\{64\}\\\$' \.env\.local \|\| \{ sed -i '\/\^CABINET_READ_KEY=\/d' \.env\.local; echo CABINET_READ_KEY=\\\$\(openssl rand -hex 32\) >> \.env\.local; \}/, path);
    const env = '\\$APP_DIR/applications/qnet-explorer/frontend/\\.env\\.local';
    assert.match(text, new RegExp(`grep -Eq '\\^CABINET_READ_KEY=\\[0-9a-f\\]\\{64\\}\\\\\\$' ${env} \\|\\| \\{ sed -i '/\\^CABINET_READ_KEY=/d' ${env}; echo CABINET_READ_KEY=\\\\\\$\\(openssl rand -hex 32\\) >> ${env}; \\}\\ngrep -q '\\^SOLANA_RPC_URL`), path);
  }
  const proxy = read(REPO, 'applications/qnet-explorer/frontend/src/server/cabinet/solana-proxy.ts');
  assert.match(proxy, /export function readPassKey\(configured: string \| undefined = process\.env\.CABINET_READ_KEY\): Buffer \{/);
  assert.match(read(FRONTEND, 'ecosystem.config.example.js'), /CABINET_READ_KEY \(32 random bytes in hex, which the deploy script makes once\)/);
});
