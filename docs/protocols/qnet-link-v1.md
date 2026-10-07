# QNet Link v1

Status: normative, version 1, in two revisions that share the link host, the relay and the cryptography.

**Revision 1** (sections 1 to 13) defines what revision 2 builds on and what the QNet browser extension
answers:

- the link `https://link.aiqnet.io/l#…`, opened on a phone or scanned as a QR code, the relay on aiqnet.io that
  carries a wallet's answer end-to-end encrypted to the page that asked ("link"), and their cryptography, with the
  intent `connect`;
- the extension's provider method `qnet_activateNode` (section 10): the 1DEV burn the extension makes for it
  (section 8) and its result, which has the answer format of section 7;
- the provider announcement field `channel` (section 11).

`activate` is the extension's method only. No relay session and no app takes it: the relay refuses an `activate`
session (section 14.5), and QNet Wallet parses revision 2 links only and refuses an `activate` link before it
fetches anything (section 14.3). The app makes no burn and takes no activation code.

**Revision 2** (section 14) defines how the web cabinet at aiqnet.io/node asks the QNet app to share its
addresses, to sign this wallet's reservation of a light node paid from a one-time payment address, to give its
consent and link this wallet's light node to the device, or to move the node balance into the wallet; and the
extension's methods for the cabinet on a desktop. The two revisions' links carry
different intents, so an app refuses a request of the revision it does not implement before it fetches
anything (section 14.3). The messages the app signs are defined in
[Light node messages](light-node-messages.md).

Parties: the **site** (a page of aiqnet.io in a browser tab), the **relay** (API routes of the same
site), the **app** (QNet Wallet on a phone or tablet, `io.aiqnet.wallet`), the **extension** (the QNet browser
wallet).
Test vectors: [`qnet-link-v1.vectors.json`](qnet-link-v1.vectors.json), produced by
[`tools/qnet-link-vectors.mjs`](tools/qnet-link-vectors.mjs) (section 13). MUST, MUST NOT, SHOULD and
MAY are used as in RFC 2119.

## 1. Model

The site never sends a transaction to sign. A request carries only an **intent**:

| Intent | Carried by | Meaning |
| --- | --- | --- |
| `connect` | the relay, from a link or QR code | share this wallet's QNet and Solana addresses |
| `activate` | the extension's `qnet_activateNode` only (section 10) | activate a node of type `light` or `super`: the extension builds, signs and sends the 1DEV burn itself, then returns the activation code |

```
site                                relay (aiqnet.io)                    app
 | X25519 key pair, session id         |                                   |
 | POST /api/link/sessions ----------> |                                   |
 | link as button (phone) or QR        |                                   |
 |                                     | <-- GET /api/link/sessions/:id --- |  opened by the verified link
 |                                     |                                   |  confirm, authenticate, perform
 |                                     | <-- POST .../:id/response -------- |  {appPub, iv, ct}
 | GET .../:id/response every 2 s ---> |                                   |
 | decrypt, validate, show             |                                   |
```

The relay sees the session id, both ephemeral public keys, the intent and ciphertext. It never sees an
address or any secret, and it cannot make a wallet do anything other than the intent the user confirms on
the wallet's own screen. Section 12 lists what it and others can do.

## 2. Constants

| Name | Value |
| --- | --- |
| Link prefix | `https://link.aiqnet.io/l#v1.` |
| Link host | `link.aiqnet.io`: the link page and the app-association files only; the site and the relay stay on `aiqnet.io` |
| Relay base URL (app) | `https://aiqnet.io` (constant, never taken from a link) |
| Android package | `io.aiqnet.wallet` (section 14.2) |
| HKDF info | UTF-8 `qnet-link-v1` |
| AAD | UTF-8 `qnet-link-v1\|<id>\|<intent>` |
| Session TTL | 600 s from creation |
| Answer read grace | 120 s after the creating IP first reads the answer: the session then ends, if its TTL has not ended it first |
| Site poll interval | 2000 ms |
| Session request body | at most 1024 bytes |
| Response request body | at most 4096 bytes |
| Response plaintext | at most 1024 bytes UTF-8 |
| Ciphertext (`ct` decoded) | 17 to 1040 bytes (plaintext + 16-byte tag) |
| `burnAmount` | integer 1 to 1 000 000 000 (whole 1DEV), in an `activate` answer |
| Relay store | at most 100 000 live sessions, at most 60 of them created by one IP |

## 3. Encodings

- **id**: 16 random bytes as 32 lowercase hex characters, `^[0-9a-f]{32}$`.
- **b64url**: RFC 4648 section 5 base64url without padding. A decoder MUST refuse any other character,
  `=`, a length of 1 mod 4, and non-zero padding bits: decode, re-encode, and require the same text.
  Keys are 32 bytes (43 characters), the IV 12 bytes (16 characters).
- **Solana address**: base58 decoding to exactly 32 bytes. **Burn signature** (`burnTx`): base58 decoding
  to exactly 64 bytes.
- **QNet address** (EON): `^([0-9a-f]{19})eon([0-9a-f]{15})([0-9a-f]{8})$` where the last group equals the
  first 8 hex characters of SHA3-256 over the first 37 characters.
- **Activation code**: `^QNET-[LS][0-9A-F]{5}-[0-9A-F]{6}-[0-9A-F]{6}$`, a deterministic function of
  `(nodeType, address, burnTx, burnAmount)`: `core.generateActivationCode` in the extension bundle,
  `activationCode` on the site, the node's `generate_quantum_activation_code`. `address` is the wallet the code
  names: the burner's own Solana address, or, for a light burn made by aiqnet.io's one-time payment key, the
  wallet's QNet address (`core.walletActivationCode`); such a burn is found through the node's registration record
  (burn → wallet), never through the payment key's address. KAT: `light`,
  `FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR`,
  `nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx`, `1500` →
  `QNET-LFEFD9-706058-537636`; the same burn named by the KAT wallet's QNet address → `QNET-LFEFD9-520F5F-5307ED`.
- JSON is the UTF-8 text of one object; wherever a key set is given, a missing or extra key is an error.
- **Burn order**: a wallet's burns are ordered oldest first by slot; two burns in one slot by their place
  in `getSignaturesForAddress` of the wallet's 1DEV associated token account, which lists newest first, so
  of two entries of one slot the one listed later executed earlier and is the older. The place counts over
  the whole listing, across pages. A wallet's activation is its oldest valid burn in this order: the extension
  elects it so, and every client that looks up a wallet's activation MUST elect the same one. Vector:
  `burnOrder` (section 13).

## 4. Link

```
https://link.aiqnet.io/l#v1.<id>.<sitePub>.connect
```

- `sitePub`: the site's ephemeral X25519 public key, b64url. Revision 2 adds the intents `link`, `claim` and
  `reserve`, each with a request hash (section 14.3). The form `<sitePub>.activate.<nodeType>` that this revision
  once defined is not a link any more: no relay session carries it and no app opens it.
- Parsers MUST match the whole string, without trimming, case folding or percent-decoding, against the pattern of
  section 14.3 (for `connect` alone, `^https://link\.aiqnet\.io/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.connect$`)
  and then require a canonical 32-byte `sitePub`. Anything else (another scheme, host (`aiqnet.io` included), port,
  userinfo, path, a query, the data in the path or the query, an `intent:` URL, `v2`, `activate`, a trailing
  character) is not a link.
- The data sits in the fragment, so it never reaches a server log or a `Referer`. All its characters are
  unreserved, so no layer re-encodes it. Length: 112 characters for `connect`.
- The link has a host of its own. Safari opens a Universal Link tapped on a page of the same domain in
  the browser, and Chrome on Android may keep a same-host navigation too; the site's pages are on
  `aiqnet.io`, so a tap on its button always crosses to another host.
- The site draws the link as a QR code on a desktop (encoded in the page, no remote service). On a
  phone its "Open QNet Wallet" button is the link, except on Android, where it is the `intent:` URL of
  4.1. The site never puts the link, the id or a result in its own URL, in storage or in a log.
- The link host is verified for the app: Android App Links (`https`, host `link.aiqnet.io`, path exactly
  `/l`, `android:autoVerify="true"`, `https://link.aiqnet.io/.well-known/assetlinks.json`) and iOS
  Universal Links (`applinks:link.aiqnet.io`, `https://link.aiqnet.io/.well-known/apple-app-site-association`
  with the component `"/": "/l"`), both served as `application/json` without redirects. The app takes a
  link only from the system, through that filter (Android) or as a Universal Link (iOS), and parses it
  as above: no other host, path or scheme reaches its confirmation screen.
- `https://link.aiqnet.io/l` is a page for a visitor who reached it in a browser (app not installed, an app too
  old for the request, the browser kept the link, or the fallback of 4.1). It MAY read its own URL, and only as a
  whole through the parser above; it MUST NOT send it or any part of it anywhere (no request, storage or log). On
  Android, for a URL that parses, it offers one button that opens QNet Wallet (4.1, falling back to
  `https://aiqnet.io/wallet`); everywhere it says why a browser shows it and links to `https://aiqnet.io/wallet` and
  `https://aiqnet.io/node`. Apart from the files that page loads, every other path on the link host redirects to
  the same path on `aiqnet.io`.

### 4.1 Android launch

A browser that keeps the link as a page would leave the phone button dead, so on Android the site names
the app explicitly with an `intent:` URL, which Chrome and the other Android browsers hand to the system:

```
intent://link.aiqnet.io/l#v1.<id>.<sitePub>.<intent>[.<reqHash>]#Intent;scheme=https;package=io.aiqnet.wallet;S.browser_fallback_url=<fallback>;end
```

- The fragment reaches the app intact. Chrome passes the URL as it canonicalizes it (a second `#` inside
  a fragment is kept as is: `url/url_canon_etc.cc`, `kShouldEscapeCharInFragment`) to Android's
  `Intent.parseUri(url, URI_INTENT_SCHEME)` (`ExternalNavigationHandler.shouldOverrideUrlLoading`).
  `parseUri` takes the intent's fields from the last `#` (`lastIndexOf("#")`, which must start
  `#Intent;`) and makes the text before it, with `intent:` replaced by the `scheme=` value, the intent's
  data: exactly the link. A Chromium page reads such an `href` back unchanged (`a.href` equals the
  attribute). So the link keeps its one form; there is no second, path- or query-based form.
- `<fallback>` is percent-encoded (`encodeURIComponent`), so it holds no `#` or `;`; `parseUri` decodes it.
  Chrome loads it when the named package is not installed.
- The site's button names `io.aiqnet.wallet` with the link itself as `<fallback>`: without the app the browser
  opens the link page, whose button names the same package with `https://aiqnet.io/wallet` as `<fallback>`.
- The intent reaches the app through the same intent filter as an App Link (`VIEW`, `BROWSABLE`, `https`,
  `link.aiqnet.io`, `/l`) with the link as its data, and the app parses it the same way. Any page can
  build such a URL, just as any page can link the https link; section 12 covers a link someone else
  created.

## 5. Relay API

Routes of the site (Next.js, Node.js runtime, dynamic, one process: the store is in memory).

Common rules:

- Requests and answers are `application/json` (UTF-8). A POST without `Content-Type: application/json`
  (parameters allowed) gets 415. Bodies are read up to the cap plus one byte; over the cap → 413.
- A request whose `Origin` header is present and is not `https://aiqnet.io` (development builds also
  `http://localhost:<port>` and `http://127.0.0.1:<port>`) gets 403. So does a request whose `Sec-Fetch-Site`
  header is present and is not `same-origin`: a browser request that another site's page made (also a GET
  by `<img>`, `<script>` or a frame, which carries no `Origin`), or another host of the site, or a typed
  address. Both checks come before any limit counts the request, so another page cannot spend a visitor's
  limits. The site's pages send `same-origin`; native app requests carry neither header. No CORS headers
  are sent.
- Every answer carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; no route redirects.
- `:id` MUST match the id pattern, else 400. An unknown or expired id gets 404; the two are not told apart.
- The relay never logs a body, an id, a key, a ciphertext or a client IP; a log line may name the route
  and the status only. The web server does not log these routes either: the deployment gives
  `/api/link/` its own nginx location with `access_log off` and only critical errors in the error log
  (`deployment/deploy-aiqnet.sh`), because an access log would pair the computer's and the phone's
  addresses under one session id.
- Per-IP limits (fixed windows, one bucket per route), the IP from `getRateLimitKey` of the frontend's
  `lib/rate-limit.ts`: the app listens on `127.0.0.1` behind nginx on the same host, so the IP is
  `X-Real-IP` (nginx sets it to `$remote_addr`, replacing any a client sent); a client's
  `X-Forwarded-For` is never read. Without `X-Real-IP` (a request that did not pass nginx) it is the
  socket address. An IPv6 address counts as its /64. A failed resolution → 503. Over the limit → 429
  with `Retry-After` in seconds. The limits allow for many phones or computers behind one carrier or
  office NAT address. nginx separately caps each address at 10 requests a second on `/api/link/`, in a
  zone of the relay's own apart from the rest of `/api`, and refuses the requests above by
  `Sec-Fetch-Site` before that limit counts them.

  | Route | Limit per IP |
  | --- | --- |
  | `POST /api/link/sessions` | 120 per 10 min, and at most 60 live sessions created by one IP |
  | `GET /api/link/sessions/:id` | 120 per min |
  | `POST /api/link/sessions/:id/response` | 60 per min |
  | `GET /api/link/sessions/:id/response` | 600 per min (a page polls 30 times a minute) |
  | `DELETE /api/link/sessions/:id` | 120 per min |

- The relay has a limiter store of its own (100,000 keys), apart from the explorer routes'. A full store
  evicts the key whose window started first and never refuses a new one, so a crowd of addresses cannot
  lock out the next visitor.
- Store: `id → {sitePub, intent, request, reqHash, createdAt, owner, response: {appPub, iv, ct} | null, readAt}`
  (`request` and `reqHash` for a `link`, `claim` or `reserve` session, section 14.5), where
  `owner` is the limiter key of the creating IP and `readAt` the time that IP first read the answer (both memory
  only, never sent). The store is kept on `globalThis`, so every route bundle of the process shares one instance.
- **A session ends** at the first of: its TTL (600 s after creation); 120 s after its creating IP first read the
  answer (section 5.4), which leaves room for the app's retry of a lost reply (section 5.3) and then gives the
  IP's place back; or its release by the creating IP (section 5.5). Reads of the answer from another IP start no
  grace. An ended session is gone: every route answers it as an unknown id (404). Ended sessions are purged on
  access and by an unref'd timer.
- At most 100,000 live sessions (under 2 KB each with an answer); one IP may hold at most 60 of them (a create
  beyond that → 429, `Retry-After: 60`), so filling the store takes over 1,600 addresses at once; a create beyond
  the total → 503. `link` and `reserve` sessions have caps of their own besides (section 14.5).
- Error answers: `{"error": "<code>"}` with `invalid_request` (400), `forbidden_origin` (403),
  `not_found` (404), `conflict` (409), `payload_too_large` (413), `unsupported_media_type` (415),
  `rate_limited` (429), `unavailable` (503).

### 5.1 `POST /api/link/sessions` (site)

Body, exactly these keys (section 14.5 adds the `request` of a `link`, `claim` or `reserve` session):

```json
{"id": "<id>", "sitePub": "<b64url 32 bytes>", "intent": "connect"}
```

Answers: 201 `{"expiresIn": 600}`; 400 for any schema violation, an `activate` session among them; 409 when the id
exists (the site then makes a new key pair and id).

### 5.2 `GET /api/link/sessions/:id` (app)

200:

```json
{"id": "<id>", "sitePub": "<b64url>", "intent": "connect", "answered": false, "expiresIn": 512}
```

`expiresIn` is whole seconds left until the session ends (section 5): its TTL, or the read grace once the site read
the answer (never below 0). 404 otherwise.

### 5.3 `POST /api/link/sessions/:id/response` (app)

Body, exactly these keys: `{"appPub": "<b64url 32 bytes>", "iv": "<b64url 12 bytes>", "ct": "<b64url>"}`
with `ct` decoding to 17..1040 bytes. First write wins: 201 `{"ok": true}` stores it; a later body equal
to the stored one (all three strings) gets 200 `{"ok": true}` (a retry after a lost answer); any other
body gets 409. 404 for an unknown or ended session, 400 for a schema violation. A retry reaches the stored
answer only while the session lives: once the site has read the answer, 120 s more (section 5). The app waits 2, 4,
8 and 16 s between its first tries and 30 s after that, so a retry after a lost reply lands within that grace unless
the app stays offline longer; a later retry gets 404, although the site may already hold the answer.

### 5.4 `GET /api/link/sessions/:id/response` (site)

204 (no body) while unanswered; 200 `{"appPub", "iv", "ct"}` once answered, until the session ends: its TTL, or
120 s after the creating IP's first read of the answer, whichever comes first (section 5); 404 unknown or ended.
The first 200 to the creating IP starts that grace; a page reads the answer once and keeps it in memory.

### 5.5 `DELETE /api/link/sessions/:id` (site)

The page that created a session gives it up before its end (the user cancelled, or a new request replaces it), so
it stops holding a place of its IP. No body. 204 (no body): the session is dropped at once and every route answers
it as an unknown id. 404 for an unknown or ended session and for a session another IP created, all answered alike,
so no one learns that an id exists; 400 for an id off the pattern. Limit: 120 per min per IP (section 5).
A page that cannot release (closed, offline) leaves the session to end by itself (section 5).

## 6. Cryptography

Libraries: X25519 from `@noble/curves` (`x25519` of `@noble/curves/ed25519.js`; 1.x also
`@noble/curves/ed25519`); HKDF-SHA256 from `@noble/hashes` (`hkdf`, `sha256`) or WebCrypto; AES-256-GCM
from `@noble/ciphers` (`gcm` of `@noble/ciphers/aes.js`) or WebCrypto. Random bytes come from the
platform CSPRNG (`crypto.getRandomValues`); never `Math.random`.

Site, per session:

1. `sitePriv` = 32 random bytes (`x25519.utils.randomSecretKey()`), `sitePub = x25519.getPublicKey(sitePriv)`.
2. `id` = 16 random bytes, hex.
3. `POST /api/link/sessions`, then show the link.

App, answering:

1. `appPriv` = 32 random bytes, `appPub = x25519.getPublicKey(appPriv)`, fresh for every answer.
2. `shared = x25519.getSharedSecret(appPriv, sitePub)`. A throw (noble refuses the low-order points) or
   an all-zero result MUST abort.
3. `key = HKDF-SHA256(ikm = shared, salt = the 16 bytes of id, info = "qnet-link-v1", length = 32)`.
4. `iv` = 12 random bytes. `aad = "qnet-link-v1|" + id + "|" + intent`.
5. `ct = AES-256-GCM(key, iv, aad, UTF-8 plaintext)`, the ciphertext followed by the 16-byte tag (the
   output of both WebCrypto and noble `gcm`).
6. `POST {appPub, iv, ct}` as b64url.

Site, reading: `shared = x25519.getSharedSecret(sitePriv, appPub)` with the same abort rule, the same
`key`, then decrypt with the same `aad`. Any failure (encoding, low-order key, tag) means "the answer
could not be read": the site shows that, stops polling, and offers a new session.

Both sides zeroize (`fill(0)`) private keys, `shared` and `key` once done. `sitePriv` lives only in the
page's memory: never storage, never a URL; a reload ends the session. The wallet's own keys take no
part in this exchange.

## 7. Response plaintext

One JSON object, at most 1024 bytes UTF-8, with exactly the keys of its row (`v` is the number `1`,
`intent` equals the session's). It is the answer to a `connect` session of the relay, and, as
`{"v": 1, "intent": "activate", ...result}`, the result of the extension's `qnet_activateNode` (section 10), which
the site checks as below:

| Intent | Status | Keys besides `v`, `intent`, `status` |
| --- | --- | --- |
| `connect` | `ok` | `qnet`, `solana`; plus either none or all of `nodeType`, `burnTx`, `burnAmount`, `code` |
| `activate` | `ok` | `qnet`, `solana`, `nodeType`, `burnTx`, `burnAmount`, `code` |
| `activate` | `exists` | `qnet`, `solana`, `nodeType`, `burnTx`, `burnAmount`, `code`; plus `supersededBurnTx` (7.1) when it applies |
| `activate` | `pending` | `qnet`, `solana`, `nodeType`, `burnTx`, `burnAmount` |
| both | `rejected` | none |
| both | `error` | `error` |

- `ok` (activate): burned now. `nodeType` MUST equal the requested type.
- `exists`: the wallet already has its one activation, and the keys describe it; nothing was burned for
  this request, unless `supersededBurnTx` names a burn of this device that went through (7.1). `nodeType`
  is that activation's type and may differ from the request.
- `pending`: a valid burn of this wallet is on its way and not final yet: one this wallet sent (now, or
  earlier and still recorded), or one Solana reports as confirmed but not finalized, which another device
  of the same wallet sent. The keys describe that burn. No code yet; the extension's Recover finds it once
  final.
- `rejected`: the user declined. No address is revealed.
- `error`: nothing usable happened; `error` is one of the codes below. No address is revealed.
- The optional activation keys of a `connect` answer belong to this revision's format; no current wallet sends
  them: QNet Wallet answers `connect` with `qnet` and `solana` only (section 14.7).

| `error` | Meaning (nothing was burned unless stated) |
| --- | --- |
| `PRICE_UNAVAILABLE` | the node price endpoint was unreachable or its answer invalid |
| `PHASE_UNSUPPORTED` | the network reports phase 2; burn activation is unavailable |
| `PRICE_CHANGED` | the price changed after the user confirmed |
| `INSUFFICIENT_SOL` | not enough SOL for the fee |
| `INSUFFICIENT_TOKENS` | not enough 1DEV |
| `SIMULATION_FAILED` | the burn failed simulation and was not sent |
| `TX_FAILED` | the burn was sent and failed on chain (`meta.err`); no tokens were burned |
| `SOLANA_UNAVAILABLE` | Solana could not be read before sending |
| `HISTORY_TOO_LONG` | Solana was read, but this wallet's burn history could not be searched back to its start in one attempt (the wallet's time or size budget ran out); a wallet that keeps what it checked continues the search on the next request, so starting again makes progress |
| `NODE_EXISTS` | the QNet wallet already has a node, but no burn of this wallet was found to derive its code |
| `BURN_UNUSABLE` | the wallet already made a 1DEV burn of its own that yields no Light or Super code: a successful Token-program burn of the cluster's 1DEV mint that the wallet paid for, signed and authorized, with another memo (such as `QNET_NODE_TYPE:FULL`) or from a 1DEV token account other than the associated one. The node reads neither the memo nor the source account and counts such a burn for an activation, so it is the wallet's one activation and the wallet makes no new burn |
| `BURN_IN_PROGRESS` | another activation request is running in this wallet (its own one-at-a-time lock); a burn of this wallet seen on Solana and not final is `pending`, never this code |
| `NO_WALLET` | the wallet that answers (the app or the extension) holds no wallet yet |
| `INTERNAL` | anything else |

Once a burn has been sent, the answer is `ok`, `pending`, `exists` with `supersededBurnTx` (7.1) or
`TX_FAILED`, never another error. Codes are machine values; each side shows its own translated text for
them and never the other side's text. From the extension, a site takes only `rejected`, a checked `ok` or
`exists`, and an error other than `BURN_IN_PROGRESS` and `INTERNAL` as telling that no burn is on its way
(section 9, step 3).

### 7.1 A burn another device's older burn beat: `supersededBurnTx`

Two devices of one wallet can each send a burn before either burn is visible to the other (a burn is
invisible until Solana confirms it). Both burns stand, and the wallet's activation is the oldest (burn
order, section 3), which Recover shows. A device whose own burn is final but is not the oldest answers
`exists` with the oldest burn (`nodeType`, `burnTx`, `burnAmount`, `code`), whatever that burn's node
type, and names its own burn:

- `supersededBurnTx`: the signature (base58 of 64 bytes, not equal to `burnTx`) of a burn this device
  sent from the wallet's Solana address (`solana`) that is final and is not the wallet's activation. The
  burn went through and its 1DEV are destroyed; it yields no code of its own. A wallet MUST send it for the
  burn it sent for this request, and SHOULD for a burn it sent for an earlier request that was still on its
  way and turned out final while it answered this one.
- Never in an `ok`, `pending`, `connect` or `error` answer.
- The extension keeps the oldest burn as the wallet's one activation record and its own burn apart, as the
  vault's `supersededBurn`, and its own screen names both burns.
- The site shows such an answer as the older activation, with its code, and the burn of
  `supersededBurnTx` as one that went through and gives no code; it never states that nothing was burned.

Vector: `activate-super-exists-superseded` (a super burn beaten by an older light burn).

### 7.2 Site validation

In this order, all MUST pass or the answer is refused as unreadable: size; JSON object; `v`; `intent`;
`status` allowed for the intent; exact key set; `error` in the table; `qnet` a valid EON; `solana` a
32-byte address; `nodeType` `light`/`super` (equal to the request for `activate`/`ok`); `burnTx` a
64-byte signature; `burnAmount` an integer in range; `code` matching the pattern and equal to
`generateActivationCode(nodeType, solana, burnTx, burnAmount)`, or for `light` to the same function of `qnet`
(section 3); `supersededBurnTx` a 64-byte signature
other than `burnTx`.

Example (vector `activate-light-ok`):

```json
{"v":1,"intent":"activate","status":"ok","qnet":"d9fa370374e24333242eon847d1d354dcd87fe873823e","solana":"HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk","nodeType":"light","burnTx":"4gtqjWUNckdT7nXb5w44aCnFFqAMMBiYhaLy5TAxvQ5LkkvTRmNpHxYCWXqaHCU9pN4JeiARqhGoKg4H6m4pKdUG","burnAmount":1500,"code":"QNET-L1789D-797657-0E5715"}
```

## 8. The burn

The extension burns for `qnet_activateNode` (section 10), after the user confirmed the node type and the price
in its approval window (the armed button of the unlocked wallet, no password); it answers in this order, with the
same code as its Activate tab:

- The record holds the wallet's canonical (oldest) activation → `exists`; a burn this wallet recorded before
  sending it and Solana has not finalized → `pending`, answered before any search, so an unreadable Solana still
  gets `pending` for it. A recorded burn is dropped only when it can no longer land: it failed on chain (an error
  Solana reports at `confirmed` or `finalized`; an error seen only at `processed` comes from a fork and is not a
  failure), or Solana has no trace of it once the finalized block height has passed the `lastValidBlockHeight` of
  the blockhash it was built on (the status is read again after that height; a record kept without the height:
  one hour after it was sent). One now final is checked and stored → `exists`.
- Then the strict burn matcher, which reads the history of the wallet's 1DEV token account at `finalized` within
  a time budget and keeps its progress between requests: the oldest valid burn (burn order, section 3) → store it
  as the record → `exists`; else it pages the same history at `confirmed` from its newest entry down to the part
  the finalized search holds, at most 20 pages in 30 s (a check that cannot get that far fails closed:
  `SOLANA_UNAVAILABLE`, or `HISTORY_TOO_LONG` when its time ran out), and a valid burn found only there, confirmed
  but not finalized (another device's) or finalized after the search listed, → `pending`; else a history not
  searched to its start → `HISTORY_TOO_LONG` when the budget ran out, otherwise `SOLANA_UNAVAILABLE`; a burn of
  the wallet's own that yields no code (section 7, `BURN_UNUSABLE`), finalized or confirmed, among the candidates
  of that search or burned from any other of the wallet's 1DEV token accounts (every such burn is a transaction
  the wallet signed, so it lists in the history of the wallet's own address, a closed account's included) →
  `BURN_UNUSABLE`; a search for such burns that has not reached the start of that history fails closed as above;
  the QNet wallet already has a node → `NODE_EXISTS`;
- else re-fetch the price (phase 1, integer, equal to the confirmed price), check balances, build a legacy
  transaction with SPL Burn (instruction 8, raw = price × 10^6, from the wallet's ATA of the cluster mint,
  authority = wallet) and Memo `QNET_NODE_TYPE:LIGHT|SUPER`, fee payer = wallet, `simulateTransaction` with
  `sigVerify: true`, record the burn, send, wait for `finalized` (at most 90 s, then `pending`), elect the wallet's
  oldest valid burn, derive its code and store it as the single record → `ok` when that burn is this one; when
  another device's burn is older, `exists` with that burn and its code, and this burn in `supersededBurnTx`
  (section 7.1).

QNet Wallet on a phone or tablet makes no burn: it has no activation screen, and the site's cabinet burns for a
phone with its own one-time payment key (section 14).

## 9. Site behaviour

The site's node cabinet (aiqnet.io/node) asks the extension to activate, and opens relay sessions for the app
(section 14.9).

1. The cabinet never renders in the app's in-app browser (an announced provider with `channel` `mobile`, or a
   page the app opened in the system browser with its marker `?from=app`). With an announced provider of the
   extension it offers `qnet_activateNode` (section 10).
2. A relay session, whatever its intent: create it (sections 5.1, 6); on 409 retry once with a new key pair and
   id. Poll `GET …/response` every 2 s; poll at once when the page becomes visible again; stop on 200, on 404, or
   600 s after creation (then expired: the page offers Ask again, a new request with the same content). A session the page gives up before that (the user cancelled,
   or a new request replaces it) it releases (section 5.5), best effort.
3. The extension's result, checked as section 7.2, is shown as the wallet's report: the code with a copy button,
   node type, burn transaction (Solana explorer link on the burn cluster), amount, and next steps (`light`: the
   page reads the chain until the node is listed, section 14.9; `super`: `QNET_ACTIVATION_CODE`,
   `QNET_BURN_TX_HASH`, `QNET_BURN_AMOUNT`, `QNET_WALLET_SEED_FILE`). `pending`: the burn transaction and "not final yet;
   the extension's Recover shows the code once it is". `exists` with `supersededBurnTx`: also that burn
   transaction, as a burn that went through and gives no code (section 7.1). `rejected` and `error`: a fixed text
   per status and code.
   A burn is invisible until Solana confirms it, and the page sees none. So once a burn may be on its way (a
   `pending` answer, an `error` answer `BURN_IN_PROGRESS` or `INTERNAL`, or a call that timed out, failed, was
   disconnected or answered unverifiably), the page says for the rest of its life not to start another activation
   of this wallet until the burn is final, and to use Recover in the extension.
4. Keep every result in memory only; clear `sitePriv` when a relay session ends.

## 10. Extension method `qnet_activateNode`

Added to the extension's provider allow-list (applications/qnet-wallet CONTRACTS.md section 4).

| | |
| --- | --- |
| Params | exactly `{"nodeType": "light" \| "super"}`; anything else → -32602 |
| Origins | store build: exactly `https://aiqnet.io`; development build also `http://localhost:<port>` and `http://127.0.0.1:<port>`; any other origin → 4100, even one allowed to connect |
| Grant | neither required nor created; the call emits no `accountsChanged` |
| Result `ok` | `{status, qnet, solana, nodeType, burnTx, burnAmount, code}` |
| Result `exists` | the same, plus `supersededBurnTx` (section 7.1) when it applies |
| Result `pending` | `{status, qnet, solana, nodeType, burnTx, burnAmount}` |
| Result `error` | `{status: "error", error}` with a code of section 7 |
| Errors | 4001 rejected, window closed, approval timeout, queue full, cooldown (its own text); 4100 origin not allowed; 4200 a wallet without the method; -32602 invalid params; -32603 internal |

- Order of checks: origin → params → approval cooldown and per-origin queue (CONTRACTS.md 4.8) → the
  approval window (unlock first when locked: the only password it asks for) → the user confirms with the
  armed button → the activation path of `activation.js` (the same code as the Activate tab, one single-flight
  lock with it) → result.
- The window shows "Activate a Light node?" (or Super) with the price, where the node runs (a Light node in QNet
  Wallet on a phone or tablet, a Super node on the user's own server with the QNet node software), the exact amount
  burned, the token and cluster, the mint, the SPL Token program, the Solana address that burns and its balances, and
  one confirmation line: the acknowledgement that the amount is destroyed and that the wallet gets exactly one code.
  When the wallet already has an activation it shows that instead ("Share your activation code?"), and a burn not
  final yet likewise ("Share your pending burn?"). The burn amount is the price the window showed,
  fixed for the approval and re-checked by the worker; it never comes from the page. When the worker
  finds another price (`PRICE_CHANGED`) the window shows the new one and asks again, so the extension
  does not answer `PRICE_CHANGED` itself.
- One wallet, one code (applications/qnet-wallet CONTRACTS.md decision 35): the window offers a burn only when the
  wallet's vault holds no activation and no pending burn, the kept search of the wallet's own Solana address finished
  with no burn (one in flight and one no code derives from counted), aiqnet.io's record of the wallet's burns
  (`GET /api/cabinet/activation/{wallet}`) says none, and the network vouches that the wallet has no node. A burn the
  search finds is stored and shown as `exists` or `pending`; while the search runs the window says it is checking and
  offers nothing to confirm. Before it signs, the extension takes aiqnet.io's reservation for the wallet (one client at a
  time) with the wallet's signed reservation (section 14.7, `reserve`: `way` `extension`, the burner the wallet's own
  Solana address), which it signs itself with the wallet's own keys, through the signer it keeps for aiqnet.io's
  records (a page's `signMessage` refuses those messages); aiqnet.io takes such a reservation at most 10 minutes old
  and refuses an unsigned, forged or stale one. It then announces the signed burn there with the wallet's proof, and
  sends it only once that announce is taken; a failure before the send gives the reservation back and sends nothing.
  The extension checks all of it again at the confirm.
- When the window cannot offer the action (price unavailable, phase 2, `NODE_EXISTS`,
  `BURN_IN_PROGRESS`, a burn aiqnet.io's record holds for the wallet, an activation of the wallet starting in another
  browser, on another device or through a one-time payment address on aiqnet.io, aiqnet.io, Solana or the network not
  answering, not enough 1DEV or SOL, signing disabled
  by a failed self-test), it shows the reason and its only button resolves the call with that `error` result: a burn
  aiqnet.io holds as `NODE_EXISTS`, one starting elsewhere as `BURN_IN_PROGRESS`, no answer from aiqnet.io and the
  self-test as `INTERNAL`.
  Ending the origin's first such window within a minute, by that button or by closing it, is not a
  rejection; a second window of the origin within that minute that ends unused (that button, closing it,
  or its page gone) counts as one. Every approval window counts against its origin's budget from the
  moment it opens until an approved action clears it: at most 5 within a minute and 20 within 10 minutes,
  after which the origin's requests fail at once with the cooldown 4001 (CONTRACTS.md 4.8).
- No password is asked for the confirm, also when nothing is burned: while the wallet is unlocked the press of
  the armed button is the confirmation, and the worker takes it only from the approval window it opened for this
  request (CONTRACTS.md 4.8). The site gets nothing until the user confirms or rejects.
- `exists`: the vault's record, or the burn Recover finds (the oldest of the wallet's Solana address), without
  burning.
- A burn this request sent that another device's older burn beat is answered `exists` with that older
  burn, whatever its node type, and names the burn sent in `supersededBurnTx` (section 7.1); once a burn is
  sent the answer is never an error other than `TX_FAILED`.
- A burn of the wallet's own that yields no code, found as in section 8, is answered `BURN_UNUSABLE`
  without burning.
- A valid burn of this wallet that Solana has confirmed but not finalized, sent by another device, is
  answered `pending` with that burn's data (section 8); `BURN_IN_PROGRESS` is only for an activation already
  running in the extension.
- The router's result guard lets `code` through for this method only (CONTRACTS.md section 1, "Results").
- The site checks the result as the plaintext `{v: 1, intent: "activate", ...result}` of section 7,
  including the code recomputation, as an answer of the extension (section 7.2).
- A 4001 whose message is exactly the cooldown text of CONTRACTS.md 4.5 ("Too many rejected requests from
  this site, try again later") is the approval cooldown, not a decline: the site says "Too many declined
  requests. Try again in a few minutes." Every other 4001 reads as declined. The site shows its own text,
  never the wallet's.
- The site asks `qnet_activateNode` only when its own sources (its record, the network, and `qnet_getActivation`
  below) all say the wallet has no burn and no node; it reads a code only through `qnet_getActivation`, never through a
  window.

### 10.1 Extension method `qnet_getActivation`

What the extension knows of the wallet's activation, read without an approval window and without a burn button, so the
site shows a code the wallet received in any browser and never offers a burn the extension knows of.

| | |
| --- | --- |
| Params | none (absent, `null`, `[]` or `{}`); anything else → -32602 |
| Origins | as section 10; any other origin → 4100 before the params |
| Grant | read, never created: an origin without a grant of the unlocked wallet gets `not_connected`; no `accountsChanged` |
| Window | never: no approval queue, budget or cooldown; nothing is signed for the page, burned or sent for it. A burn the search finds is stored as Recover stores it (a Light activation's record on the QNet network then starts), and a read may post the vault's own burn to the site's record with the wallet's proof, as an unlock does |
| Limit | 30 calls a minute per origin; more → 4001 |
| Result | exactly one of `{status: "no_wallet"}`, `{status: "locked"}`, `{status: "not_connected"}`, `{status: "searching", qnet, solana}`, `{status: "unknown", qnet, solana, reason}` (`SOLANA_UNAVAILABLE` or `HISTORY_TOO_LONG`), `{status: "unusable", qnet, solana}`, `{status: "none", qnet, solana}`, `{status: "pending", qnet, solana, nodeType, burnTx, burnAmount}`, `{status: "exists", qnet, solana, nodeType, burnTx, burnAmount, code, paidOnSite}` |
| Errors | 4001 over the limit; 4100 origin not allowed; 4200 a wallet without the method; -32602 invalid params; -32603 an answer that fails its check |

- `qnet` and `solana` are always the unlocked wallet's own. `exists` is the extension's activation: `code` =
  `generateActivationCode(nodeType, solana, burnTx, burnAmount)`, or with `paidOnSite` (a light burn the site's one-time
  payment address made) the same function of `qnet` (section 3). `pending` is a burn of the wallet on its way.
- Otherwise the kept search of the wallet's own Solana address answers: a burn it finds is stored and answered as
  above; `searching` while it runs or while an activation runs in the extension (ask again in 3 to 5 s); `unknown` when
  it could not decide; `unusable` for a burn no code derives from; `none` only for a search that finished with nothing
  within the last 60 s. One wallet's search starts at most every 20 s.
- The router's result guard lets `code` through for this method and `qnet_activateNode` only.
- `locked` and `not_connected` mean the extension is not a source now: the site offers no burn through it. 4200 means an
  extension without the method (an older build): the site knows no extension source and says to update the extension.

## 11. Provider announcement `channel`

The `qnet:announceProvider` detail `info` gains `channel`:

| `channel` | Announced by | `qnet_activateNode` |
| --- | --- | --- |
| `extension` | the QNet browser extension | yes, on the allowed origins |
| `mobile` | the QNet app's in-app browser | no (4200) |

`info = {uuid, name: "QNet Wallet", icon, rdns: "io.aiqnet.wallet", channel}`, frozen like the rest. A
site treats a missing or unknown `channel` as `extension` (older builds answer 4200, shown as "update
the wallet"). Like `rdns`, `channel` is self-asserted: it only picks what the site offers. The controls
are the extension's origin allow-list and approval, and the absence of the method in the app.

## 12. Security notes

- **Intent only.** The extension builds the burn itself from its own keys, the node's price and constants of
  its release; the user confirms the exact action in its approval window (its armed button). Nothing the site
  sends can change the amount, the mint, the program or the recipient (a burn has none). Through the relay a
  wallet only shares its addresses (`connect`) and, in revision 2, signs its own consent or moves its node balance.
- **Relay.** Untrusted for what the site displays. It can drop, delay or replace answers, so the worst
  case is a wrong message on the site. A relay able to forge answers is the aiqnet.io server itself,
  which already serves the page's code.
- **Someone who sees the QR or link** can create an answer first (first write wins). The link holds the
  session id and the site's public key, which is all it takes to seal an answer of any content that the
  page decrypts like the app's: nothing in the answer itself authenticates it to the user's phone. The real
  app then gets 409 and warns (section 14.8), or sees `answered: true` and refuses before doing anything. A
  forged `connect` answer could show someone else's addresses, so the site shows an app answer as the wallet's
  report, and the app's own screen is the record of what it did. Revision 2 adds the check number the user
  compares (sections 14.6 and 14.11) before the page acts on a wallet it did not already hold.
- **Phishing link** (a session created by someone else): the user sees exactly what will happen, marked
  "continue only if you started this on aiqnet.io yourself just now". The attacker receives at most the
  wallet's two public addresses, linked to each other; never a secret.
- **Replay and mix-up.** One answer per session, a 600 s TTL, a key bound to the session id (HKDF salt),
  the id and intent bound as AAD, a fresh app key and IV per answer, the site's key never reused, and
  the app refusing answered or already handled sessions.
- **Confidentiality.** Only public data is ever in a plaintext; seeds, keys and passwords never enter
  this protocol. The link data stays in the fragment; the relay logs nothing of it; answers are
  `no-store`.
- **Input handling.** Canonical encodings only; low-order X25519 keys refused; exact key sets; every
  address, signature and code re-checked by the site; wallet-supplied strings rendered as text.
- **Stores.** The app has no activation screen, no burn and no code; its sheets exist only behind a verified
  link; the in-app browser cannot activate (no method, `channel` `mobile`, and the site offers nothing there).
- **Denial of service.** Body caps, per-IP limits, a cap on live sessions per IP, a bounded store and
  TTL, and a limiter store of the relay's own that evicts instead of refusing. A full store or a blocked
  IP delays a request, never loses funds.
- **Privacy.** The app contacts the relay only when the user opens such a link; the relay learns the
  client IP for rate limiting and keeps it only in memory (the limiter, and a session's `owner` for the
  per-IP cap), for at most the length of a limit window or a session. nginx writes no access log line
  for `/api/link/` (section 5), so no log links a computer's address to a phone's.
- **Link host.** The link lives on `link.aiqnet.io`, apart from the site's pages, so a tap on the site's
  button is never a same-host navigation that the browser keeps (section 4). The host serves only the link
  page and the app-association files; the relay and the `Origin` the relay accepts stay `aiqnet.io`. The
  site answers on no other host: any other name that reaches it (`www.`, `explorer.`, an unknown `Host`),
  API routes included, is a redirect to the same path on `aiqnet.io`, so the site and its relay have one
  origin, the one the extension's activation origin and the app's relay base name.
- **Explicit Android launch.** An `intent:` URL (section 4.1) can name the app's package, but it reaches
  the app only through the link filter, with a link the app parses strictly; it adds nothing a page could
  not already do by linking the https link. The in-app browser opens no `intent:` URL.

## 13. Test vectors

`qnet-link-v1.vectors.json` holds:

| Key | Content |
| --- | --- |
| `constants` | the values of section 2, the link pattern, statuses and error codes |
| `activationCodeKat`, `wallet` | the activation-code KAT and the KAT wallet (`abandon` ×11 `about`) used in answers |
| `walletActivationCodeKat` | the KAT burn as a light burn of aiqnet.io's payment key for the KAT wallet: the code names the wallet's QNet address (section 3) |
| `cases` | ten full exchanges of section 6 under the revision 1 AAD (activate ok/ok/exists/pending/rejected/error, connect ok/ok-with-activation/rejected, activate exists with `supersededBurnTx`): session id, HKDF salt, site and app private and public keys, link, session request, shared secret, key, AAD, plaintext, IV, ciphertext, response request. Their `activate` plaintexts are the section 7 answers the site checks as the extension's results; no relay takes their sessions and a revision 2 parser refuses their links (section 14.3) |
| `cryptoMustFail` | decrypt inputs that MUST fail: flipped tag, ciphertext or IV bit, swapped intent, other id, other site key, another session's app key, low-order app keys |
| `lowOrderPublicKeys` | X25519 public keys an implementation MUST refuse |
| `invalidLinks` | strings a link parser MUST refuse, with the reason |
| `androidIntents` | section 4.1 `intent:` URLs for two cases, naming `io.aiqnet.wallet` with the link itself as the fallback (the site's button): the link, package, fallback and the exact URL, whose data per `Intent.parseUri` is the link |
| `invalidSessionRequests`, `invalidResponseRequests` | relay bodies that MUST get 400 (or 413 for size) |
| `invalidPlaintexts` | decrypted answers the site MUST refuse, with the session and the failing check; a session with `via: "extension"` is a result of the extension (section 10), one without `via` an answer through the relay |
| `burnOrder` | the burn order of section 3: `getSignaturesForAddress` listings (newest first, in pages) with the slots, and the burns oldest first; same-slot burns listed on one page and across a page boundary |

Keys, secrets, IVs and ciphertexts are lowercase hex; wire values are b64url; private keys are already
clamped. Private keys and IVs are derived from labels, so the file is reproducible:

```
node docs/protocols/tools/qnet-link-vectors.mjs           # regenerate
node docs/protocols/tools/qnet-link-vectors.mjs --check   # fail if the file is stale
```

The generator uses only `node:crypto` (Node 20 or later) and also recomputes every case with the
`@noble` libraries that the extension's crypto bundle, the site and the app each resolve (Node's module
resolution from each package's directory, so a hoisted install counts; `--noble <dir>` adds one): X25519
for all three, and HKDF-SHA256 and AES-256-GCM wherever the package resolves `@noble/hashes` and
`@noble/ciphers`. The site's own code takes HKDF and AES-GCM from WebCrypto (in Node.js that is
`node:crypto`, the generator's reference), and its tests run that code over the vectors. It holds a
reference parser, the `intent:` URL builder with a model of `Intent.parseUri`, the burn order, the
derivation of a phrase's Solana address from its exact text (PBKDF2-HMAC-SHA512 seed, hardened Ed25519
derivation along `m/44'/501'/0'/0'`), and validators that run over every vector; they are for tests, not
for import by product code.

## 14. Revision 2

Revision 2 serves the web cabinet at aiqnet.io/node. Payment, the activation code and the burn happen in the
browser (the cabinet's one-time payment key) or in the extension; the app signs its wallet's reservation of a light
node and its consent, runs the node on its device, ends it there and moves the node balance. A burn made earlier from
the wallet's own Solana address (by the extension, or by an older app) is registered the same way: with the consent, the
app also signs that burn's owner bind with the wallet's own Solana key, the same recovery phrase's. The app confirms no
amount, price or code. Sections 3, 5, 6 and 12 apply except where this section says otherwise.

### 14.1 Model

| Intent | Meaning |
| --- | --- |
| `connect` | share this wallet's QNet and Solana addresses |
| `link` | give this wallet's consent to register its light node with a burn made on aiqnet.io or from the wallet's own Solana address, and link the node to this device; or, when the node is already on the chain, link it to this device |
| `claim` | move this wallet's node balance into the wallet |
| `reserve` | sign this wallet's reservation of a light node paid from the page's one-time payment address, before the page shows that address |
| `unlink` | stop running this wallet's light node on the device that runs it: on that device its ping key signs the node's unbind, on any other device that holds the wallet the wallet key signs it ([Light node messages](light-node-messages.md) sections 4 and 5.7) |

A **request** travels with the session: the few fields of section 14.4, bound to the link by its hash. The app
builds every message it signs from its own keys, the request's fields and the network's answers
([Light node messages](light-node-messages.md) section 4). "I'm back" is no request: the cabinet asks the node's wake
route, which sends the linked device a silent push.

The node takes an unbind signed by the bound device's ping key at the binding's sequence, and, once two genesis nodes list
the feature `unbind_wallet`, one signed by the wallet key at that sequence ([Light node messages](light-node-messages.md)
sections 4 and 8). So the device that runs the node ends it there, and any device that holds the wallet ends it wherever it
runs: QNet Wallet on an `unlink` request it confirms, or the extension's `qnet_unlinkNodeDevice` (section 14.10). A device
that is lost or no longer opens QNet Wallet is unlinked that way, or replaced: a `link` request confirmed on another
device binds the node there with a newer sequence, and the node refuses the old device's key from then on.

### 14.2 Constants

| Name | Value |
| --- | --- |
| Link prefix, link host, relay base URL | as section 2 |
| Android package | `io.aiqnet.wallet`: the same Play-signed file from Google Play and from aiqnet.io |
| HKDF info | UTF-8 `qnet-link-v1` |
| Check-number info | UTF-8 `qnet-link-v1-sas` |
| AAD | `connect`: UTF-8 `qnet-link-v1\|<id>\|connect`; `link`, `claim`, `reserve`, `unlink`: UTF-8 `qnet-link-v1\|<id>\|<intent>\|<reqHash>` |
| Session TTL, site poll interval | 600 s, 2000 ms |
| Session request body | at most 2048 bytes |
| `link`, `reserve` answers | plaintext at most 8192 bytes UTF-8; `ct` decoded 17 to 8208 bytes; response request body at most 12 288 bytes |
| `connect`, `claim`, `unlink` answers | plaintext at most 1024 bytes UTF-8; `ct` decoded 17 to 1040 bytes; response request body at most 4096 bytes |
| Relay store | as section 2, and at most 5000 live `link` and `reserve` sessions together, at most 10 of them created by one IP |
| Consent window | `now − 86400 ≤ T ≤ now + 300` once two genesis nodes advertise `consent_24h`; `now − 300 ≤ T ≤ now + 300` before |
| Reservation window | the site takes a `reserve` answer with `now − 900 ≤ T ≤ now + 300`; the app signs with `T` = now and checks it within 300 s |
| Smallest claim | 1 QNC (`1000000000` nano) for a claim of the whole balance; any amount above zero for a part the node's quote stopped short of the whole (`stoppedAtEpoch` set, more epochs remain), so a balance spread over many small epochs always moves in several claims |

An ML-DSA-65 public key (1952 bytes) and signature (3309 bytes) in b64url with the JSON around them take about
7.1 KB, hence the `link` and `reserve` caps.

### 14.3 Link

```
https://link.aiqnet.io/l#v1.<id>.<sitePub>.<intent>[.<reqHash>]
```

- `intent` is `connect`, `link`, `claim`, `reserve` or `unlink`; `reqHash` (section 14.4) is present if and only if
  the intent is not `connect`. Parsers MUST match the whole string, as section 4 describes, against

  ```
  ^https://link\.aiqnet\.io/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.(connect|link|claim|reserve|unlink)(?:\.([A-Za-z0-9_-]{43}))?$
  ```

  and then require the `reqHash` rule above and canonical 32-byte `sitePub` and `reqHash`. `activate`, `link-device`
  or any other intent is not a revision 2 link. Length: 112 characters for `connect`, 153 for `link`, 154 for
  `claim`, 156 for `reserve`, 155 for `unlink`.
- A revision 1 app parses a `connect` link of either revision and refuses `link`, `claim`, `reserve` and `unlink`
  links as not a link; an app built before `unlink` refuses an `unlink` link the same way. The
  link page (`https://link.aiqnet.io/l`) tells a visitor whose app did not take the link to install or update QNet
  Wallet and tap the button again.
- The rest of section 4 applies: the data in the fragment, the verified link host, the QR on a desktop, the button on
  a phone.
- **Android launch** as section 4.1, naming the one package `io.aiqnet.wallet`: the site's button falls back to the
  link itself (the link page), whose button falls back to `https://aiqnet.io/wallet`.

### 14.4 Requests

| Intent | Request, exactly these keys |
| --- | --- |
| `link` | `{"burnTx": <base58 of a 64-byte signature> \| null, "walletHash": <16 lowercase hex> \| null, "check": true \| false}`, or for a burn made from the wallet's own Solana address `{"burnTx": <base58 of a 64-byte signature>, "walletHash": <16 lowercase hex>, "check": true \| false, "burner": <base58 Solana address of 32 bytes>}` |
| `claim` | `{"walletHash": <16 lowercase hex> \| null}` |
| `reserve` | `{"walletHash": <16 lowercase hex>, "burner": <base58 Solana address of 32 bytes>}` |
| `unlink` | `{"walletHash": <16 lowercase hex>}` |

- **Request bytes**: the JSON text of the request with its keys in the order above and no whitespace, for example
  `{"burnTx":null,"walletHash":"74940b0126365748","check":false}`. `reqHash` = b64url(SHA-256(request bytes)), 43
  characters.
- `burnTx`: the burn whose registration the app's consent completes; `null` links the node already on the chain.
- `walletHash`: first 16 hex of SHA3-256(`qnet-link-wallet:` ‖ EON address) of the wallet the page already knows
  (chosen earlier or from the extension); `null` when it knows none, and the app answers for the wallet open in it. A
  `reserve` request always names the wallet (never `null`): the page reserves for the wallet it holds. An `unlink`
  request always names it too: the page unlinks the node of the wallet it shows.
- `burner` (`link`): only for a burn made from the wallet's own Solana address, which it names; such a request always
  names the burn and the wallet. The app answers it only from the wallet whose own Solana address it is, and its consent
  then carries that address's owner bind (section 14.7). An app built before this key refuses such a request as one that
  does not match its link.
- `burner` (`reserve`): the page's one-time payment address, which the page makes for that wallet and shows only
  once the wallet signed the reservation of it.
- `check`: `true` when the page showed a QR and knows no wallet; the app then shows the check number (section 14.6)
  and the page asks for the match before it signs anything for the answer. `false` for a request the page opened
  with its button on the same device, whether or not it knows a wallet: that link goes from the page straight to
  the system and to QNet Wallet on this device (section 14.3), so no one else learns the session id and site key
  that an answer needs, and the page takes the answer's wallet without a check number (section 14.9, rule 4). A page
  that shows the QR for such a request ("Use another device") makes a new request with `check` as above.

### 14.5 Relay

Section 5 applies with these changes:

- `POST /api/link/sessions` body, exactly these keys: `{"id", "sitePub", "intent"}` for `connect`, and
  `{"id", "sitePub", "intent", "request"}` for `link`, `claim`, `reserve` and `unlink`, the request as section 14.4 requires
  (keys and value forms). The relay computes `reqHash` from the request bytes and stores the request and `reqHash`
  with the session. Any other intent (`activate` among them) or body → 400.
- `GET /api/link/sessions/:id` → 200 `{"id", "sitePub", "intent", "request", "reqHash", "answered", "expiresIn"}`,
  without `request` and `reqHash` for `connect`.
- `POST /api/link/sessions/:id/response`: the caps of section 14.2 for the session's intent.
- `link` sessions carry answers up to 12 KB, so they have caps of their own besides section 5's: at most 5,000 live
  `link` sessions in the store, and at most 10 live `link` sessions created by one IP. A create beyond the per-IP
  cap → 429 with `Retry-After: 60`; beyond the store's → 503. A `link` session counts toward both its own caps and
  section 5's. A `reserve` session carries an answer of that size too and counts toward the same caps.
- The end of a session (TTL, the 120 s read grace, the release of section 5.5) and the `DELETE` route apply to every
  intent as section 5 describes.

### 14.6 Cryptography

Section 6 applies with the AAD of section 14.2. Every answer's key, AAD and ciphertext bind the session id, the
intent and, for every intent but `connect`, the request.

**Check number**: `HKDF-SHA256(ikm = shared, salt = the 16 bytes of id, info = "qnet-link-v1-sas", length = 4)` read
as a big-endian unsigned integer, modulo 1 000 000, written with six digits and shown as two groups of three
(`482 913`). The app and the page derive it from the same shared secret; the app shows it only for `check: true`
and only after the relay accepted its answer (201 or 200).

The site MAY keep `sitePriv` as a non-extractable key in its origin's storage until the session ends, so a phone
browser that discards the tab while the app is in front can still read the answer.

### 14.7 Answers

One JSON object with `v` = `1`, `intent` equal to the session's, `status`, and exactly the keys of its row:

| Intent | Status | Keys besides `v`, `intent`, `status` |
| --- | --- | --- |
| `connect` | `ok` | `qnet`, `solana` |
| `link` | `ok` | `qnet`, `nodeId`, `consent` `{ts, pk, sig}` (`{ts, pk, sig, ownerSig}` for a request with `burner`), `bound` |
| `link` | `linked` | `qnet`, `nodeId`, `seq` |
| `claim` | `ok` | `qnet`, `nodeId`, `amountNano`, `txHash`, `stoppedAtEpoch` |
| `claim` | `empty` | `qnet`, `nodeId` |
| `reserve` | `ok` | `qnet`, `time`, `pk`, `sig` |
| `unlink` | `ok` | `qnet`, `nodeId`, `unbound` |
| all | `rejected` | none |
| all | `error` | `error` |

- `link` `ok`: the wallet gave its consent to the registration with the request's burn. `consent.ts` is `T` (decimal
  string), `consent.pk` the wallet's ML-DSA-65 public key (b64url, 1952 bytes), `consent.sig` its signature of the
  consent message (b64url, 3309 bytes). `bound`: the shard owner took the pending device binding. Only for a request
  with a `burnTx`. For a request with `burner`, `consent.ownerSig` (b64url, 64 bytes) is that Solana key's Ed25519
  signature of the owner bind v1 of the same registration, `qnet_onchain_reg:{nodeId}:{qnet}:{proof}:{ts}:{hex(sha3(pk))}:{burnTx}`
  ([Light node messages](light-node-messages.md) section 4), signed by QNet Wallet with the wallet's own Solana key at
  the consent's `T`.
- `link` `linked`: the node was on the chain and this device is linked now; `seq` is the binding's sequence (decimal
  string). A `burnTx` in the request was not used.
- `claim` `ok`: the claim was submitted. `txHash` is 64 lowercase hex. `stoppedAtEpoch` is `null` for a claim of
  the whole balance; for a part (the node's quote stopped before the whole balance, and more epochs remain to claim
  later), it is the first epoch the claim did not take, as a decimal string. `amountNano` (decimal string) is at
  least 1 QNC when `stoppedAtEpoch` is `null`, and above zero when it is set.
- `claim` `empty`: the node balance is below 1 QNC.
- `reserve` `ok`: the wallet signed its reservation of a light node paid from the request's `burner`. `time` is `T`
  (decimal string, Unix seconds), `pk` the wallet's ML-DSA-65 public key (b64url, 1952 bytes), `sig` (b64url, 3309
  bytes) its signature, with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, of the bytes the wallets sign for a site:
  UTF-8 `QNet Signed Message:\n` ‖ `https://aiqnet.io` ‖ `\n` ‖ the message's UTF-8 length in decimal ‖ `\n` ‖ the
  message, where the message is, with LF line breaks and no trailing one,

  ```
  QNet node reservation v1
  wallet: {qnet}
  node: light
  way: payment
  burner: {burner}
  time: {T}
  cluster: devnet
  ```

  aiqnet.io holds the wallet for that payment address's burn only with this signature (it takes it up to 24 hours and
  10 minutes old, the payment key's lifetime before a burn), and the page shows the payment address only after it.
  The extension signs the same message for its own burn, with its node type (`light` or `super`), `way: extension` and
  its own Solana address as the burner (section 10).
- `unlink` `ok`: the node stopped on the device that ran it. Answered by that device: it sent the ping key's unbind,
  with the device's release, and then forgot the binding, its ping key and its push token, whatever the network
  answered; `unbound`: the node took the unbind; `false` when it refused it or did not answer in time, and until
  another device is linked the network may still name this device's binding. Answered by another device of the wallet:
  the wallet key signed the unbind at the binding's sequence two genesis nodes report, and the answer is `ok` only with
  `unbound: true`; that device's own state is untouched.
- `rejected`: the user declined. `error`: nothing was done; the codes below.

| `error` | Intents | Meaning |
| --- | --- | --- |
| `NO_WALLET` | all | the app holds no wallet yet |
| `WALLET_MISMATCH` | `link`, `claim`, `reserve`, `unlink` | no wallet of the app matches `walletHash`, or a `link` request's `burner` is not that wallet's own Solana address |
| `NO_NODE` | `link`, `claim` | this wallet has no light node on the chain (and the request carries no burn) |
| `NODE_OTHER` | `link`, `reserve` | this wallet has a server node, or aiqnet.io's record names a super node's burn for it |
| `NETWORK` | `link`, `claim`, `reserve`, `unlink` | the QNet network, or aiqnet.io's record, could not be read |
| `BIND_REFUSED` | `link` | the shard owner refused the device binding |
| `CLAIM_REFUSED` | `claim` | the network refused the claim |
| `CLAIM_BUSY` | `claim` | a claim of this node is already running |
| `NOT_LINKED` | `unlink` | no device runs this wallet's light node |
| `UNLINK_REFUSED` | `unlink` | the network refused the wallet key's unbind |
| `INTERNAL` | all | anything else |

**Site validation**, in this order, all MUST pass or the answer is refused as unreadable: size (the intent's cap);
JSON object; `v`; `intent`; `status` allowed for the intent, and `link` `ok` only for a request with a `burnTx`;
exact key set (and `consent` exactly `ts`, `pk`, `sig`, with `ownerSig` too when the request has `burner`); `error` in the intent's list; `qnet` a valid EON address;
for `connect` `solana` a 32-byte address; `nodeId` equal to the light node id of `qnet`; `qnet` matching the
request's `walletHash` when it carried one; for `link` `ok`: `bound` a boolean, `ts` a decimal u64 inside the
consent window, `pk` 1952 bytes whose EON address is `qnet`, `sig` 3309 bytes that verify under `pk` (ML-DSA-65,
empty context) over `q1337|client_node_reg:{nodeId}:{qnet}:{proof}:{ts}` with
`proof` = first 32 hex of BLAKE3(`{burnTx}:{nodeId}:{qnet}`), and for a request with `burner` `ownerSig` 64 bytes that
verify under `burner` (Ed25519) over the owner bind v1 above; for `linked` `seq` a decimal u64; for `claim` `ok`
`amountNano` a decimal u64 of at least 1 QNC when `stoppedAtEpoch` is `null` and above zero otherwise, `txHash`
64 lowercase hex, `stoppedAtEpoch` `null` or a decimal u64; for `unlink` `ok` `unbound` a boolean. For `reserve` `ok`, after `qnet`: `qnet` matching the
request's `walletHash`, `time` a decimal u64 inside the reservation window, `pk` 1952 bytes whose EON address is
`qnet`, `sig` 3309 bytes that verify under `pk` with the context `QNET_OFFCHAIN_MSG_v1` over the envelope of the
reservation message above for the request's `burner`. A `reserve` answer carries no check number: the request names
the wallet and the wallet's own key signs the answer.

Example (vector `link-linked`):

```json
{"v":1,"intent":"link","status":"linked","qnet":"d9fa370374e24333242eon847d1d354dcd87fe873823e","nodeId":"light_mobile_6526ab8fd00ff8ca","seq":"1790086400"}
```

### 14.8 App behaviour

1. Accept a link only as delivered by the system through the link filter (an App Link, or an `intent:` URL naming
   the package, section 4.1) or as a Universal Link, and parse it as section 14.3. A link that does not parse is
   refused with a neutral message and nothing is fetched.
2. `GET /api/link/sessions/:id` from the relay base URL (HTTPS, system CAs, 10 s timeout, no cookies, a redirect is
   a failure). Refuse when: not 200; `sitePub`, `intent`, `request` or `reqHash` differ from the link; `reqHash` is
   not the hash of the request bytes the app builds from `request`; `answered` is true ("already answered on
   another device"); `expiresIn` < 30; or this id was already handled on this device (the app remembers handled ids
   for the TTL).
3. Pick the wallet: the one whose `walletHash` equals the request's (after unlock), `WALLET_MISMATCH` when none does;
   the open wallet when the request has none. A `link` request with `burner` for a node not on the chain:
   `WALLET_MISMATCH` unless `burner` is that wallet's own Solana address.
4. Compute `N` and, for a `burnTx`, `proof` itself. Read the node's status from two genesis nodes: on the chain → the
   device sheet, answered `linked`; not on the chain and no `burnTx` → `NO_NODE`; a server node → `NODE_OTHER`. For
   `reserve`: a server node on the chain, or aiqnet.io's record naming a super node's burn for the wallet →
   `NODE_OTHER`; either source not answering → `NETWORK` (the same checks as for a consent). For `unlink`: this device's
   binding of `N`, which the status signed with its ping key names (or gives no verdict on) → the unlink sheet for this
   device; otherwise the public status from two genesis nodes: no answer alike → `NETWORK`; not on the chain, no
   `unbind_wallet` feature, or no device bound → `NOT_LINKED`; else the unlink sheet for the wallet key, naming the device
   the status names.
5. Show the sheet; origin line fixed to `aiqnet.io`. `link`: title "Link this wallet's node to this device", the node
   id and the wallet, and the device-check block:

   > **Device check.** To run the node, this device proves to the QNet network that it is a genuine device running the
   > genuine QNet Wallet. The app creates a key in the device's secure hardware and sends only its public part, with
   > the system's own check of the device, which can say whether apps that can capture the screen, show themselves over
   > other apps or control the device are installed or running. The system provider keeps a small marker for this
   > device so that one device runs one node; the marker stays after the app is removed. While the node runs, each
   > answer is signed with that key, also when the app is closed. Unlinking the node from this device ends this.
   > *Privacy policy*

   Confirm is the consent to the device check; the unlink withdraws it. On a device that cannot run a node
   (light-node-messages section 1) the block reads "This device can't run a node. Confirm to add the node to this
   wallet. It can run on another device later." and Confirm gives only the consent. When this install runs another
   wallet's node, the sheet adds "The node of {wallet label} stops on this device." `claim`: title "Move node balance
   to this wallet" and the amount the app reads from its own quorum; the site sends no amount. `reserve`: title "Set
   up a light node for this wallet", with the text that the website prepares a light node for this wallet only, that
   no funds leave the wallet and that QNet Wallet asks once more when the node is added; it names no price, burn,
   payment or code. `unlink`: title "Unlink this wallet's node from this device", the text that the
   node stops running on this device (the app stops answering for it and deletes its answer key and push token here)
   while the node and its balance stay with the wallet and it can run on this or another device later, the node id,
   the wallet and the day this device was linked; for the wallet key, title "Unlink this wallet's node from its device",
   the text that the node stops running on the device it runs on now while the node and its balance stay with the wallet
   and it can run on any device later, the node id, the wallet and the day that device was linked (no text of the app
   names a platform). Reject
   answers `rejected` without authentication.
6. After Confirm, the device authentication (Face ID, Touch ID, fingerprint or the device passcode) when the device
   has it, otherwise the app password. The screens and texts are the same on every phone and tablet.
7. Perform the intent:
   - `link` with a `burnTx`, node not on the chain: `T` = now; the consent; the ping key; the delegation and the attach
     with `seq = ts = T`; the push token, taken only now; a device challenge and the enrolment
     (light-node-messages section 5.3); `POST /api/v1/light-node/bind` with the consent and the device block to the
     challenge's issuer and to the node's backup owner; a pending-link record `{nodeId, wallet, T, createdAt, bound,
     bindBlob}` that lives until the chain lists the node or `T` + 24 h + 10 min, and re-sends the same binding when a
     later status read shows the node on the chain but unbound; answer `ok`. The answer carries nothing about the
     device. The app shows "The node will run on this device once the QNet network records it." For a request with
     `burner`, the wallet's Solana key (its stored key, which must give that address) also signs the owner bind v1 of the
     same registration with the same `T`, checked against the key before it goes, as `consent.ownerSig`; the binding
     and the device block are the same, and the owner bind goes only into the answer.
   - `link`, node on the chain: the enrolment with `seq = max(now, binding_seq + 1)` on `/light-node/bind`; answer
     `linked`.
   - `claim`: the claim of light-node-messages section 4 (quote, then payload); `ok` or `empty`.
   - `unlink` on the device that runs the node: the ping key signs the unbind for the binding's sequence (`POST
     /api/v1/light-node/unbind`, with the device key's release when the node holds that key, light-node-messages section
     5.7), within 8 seconds; then the push token, the wakes, the ping key and the device schedule go, whatever the
     answer; answer `ok` with `unbound`. The Node tab has no button that does this.
   - `unlink` by the wallet key: the status signed with the wallet key gives the sequence S two genesis nodes report
     alike for a bound device; the wallet key signs `q1337|light_unbind_wallet:{N}:{S}:{ts}` and `POST
     /api/v1/light-node/unbind` carries `{node_id, seq, ts, signer: "wallet", sig, identity_pubkey}`; a node that took it
     → `ok` with `unbound: true`; `stale_seq` → the signed status is read again, no device bound at two nodes → `ok`, else
     `UNLINK_REFUSED`; any other refusal → `UNLINK_REFUSED`; no answer → `NETWORK`. This device's own state is untouched.
   - `reserve`: `T` = now; the wallet key signs the reservation message of section 14.7 for the request's `burner`;
     the app checks what it signed (its key gives the open wallet, the signature has 3309 bytes, `T` within 300 s of
     now) and answers `ok`, else `INTERNAL`.
8. Build the plaintext (section 14.7), encrypt (section 14.6), `POST` the answer. 201/200: done. 409: warn "another
   device answered this request first; do not trust what the website shows". Network failure: retry the identical
   body while the session lives. 404: the session expired. In every case the app shows the outcome itself, so
   nothing depends on the site receiving it. After 201 or 200 for a request with `check: true` the app shows "Check
   number: 482 913".
9. The app's screens name no price, burn, payment or activation code. The in-app browser refuses the pages of
   `link.aiqnet.io` and the site's `/node`, `/activate`, `/wallet` and `/l` pages, and opens no `intent:` URL. It
   also refuses the pages the site keeps out of the app's view (its home page, `/docs`, `/dao`, `/testnet` and
   `/qnet-wallet-extension`), and opens the explorer (`/explorer`) in place of any page it refuses.

### 14.9 Site behaviour

1. The cabinet never renders in the app's in-app browser (an announced provider with `channel` `mobile`, or the
   `?from=app` marker): there it renders nothing and replaces the route with `/explorer` (keeping the marker), with
   no text about where or how to activate, since a pointer to activation inside a store app is itself an activation
   link.
2. On a phone or tablet the page opens the link with its button (Android: the `intent:` URL of section 14.3), with
   "Use another device: show the QR"; on a desktop it shows the QR, or uses the extension's methods (section 14.10).
3. Create, poll and decrypt as section 9 step 2; validate as section 14.7.
4. **Beneficiary rule.** A payment address exists for one wallet: the page makes it for the wallet it holds, opens a
   `reserve` request naming that wallet and the address, and shows the address only once a `reserve` `ok` answer of
   that very wallet (by its full address, not only by the request's hash) verified; a decline, an error, another
   wallet's answer or a request that expired deletes the address's record, since nothing can have been sent to it.
   The burn is made only under that wallet's reservation at aiqnet.io, and right after the burn is signed, before it
   is sent, the payment key signs the owner bind v2 of that wallet's light node (`qnet_burn_owner_v2`, with no time;
   [Light node messages](light-node-messages.md) section 4), which aiqnet.io verifies against the key of the wallet's
   signed reservation and keeps with the wallet's record: the burn can register that wallet's node and no other, and
   the registration is finished with the wallet's consent alone, in any browser. The page takes a `link` `ok` answer as
   that wallet's consent only when its wallet is the one the burn is for, and only in one of three cases: the request
   was opened by the page's button on the same device (never shown as a QR), so only QNet Wallet on this device could
   answer it (section 14.4, `check`); the answer's wallet equals a wallet the page held or whose signed reservation it
   has (`walletHash`); or the user confirmed that QNet Wallet shows the same check number. An answer to a request that
   was shown as a QR, from a wallet the page did not hold, is never taken without the check number. The request that
   finishes, in any other browser, the registration of a burn whose owner bind aiqnet.io keeps names the wallet with
   `check: false` and takes that wallet's answer only, by its full address: the owner bind names that wallet's node, so
   no other wallet's consent can register it. Before it submits, the page reads the network and submits nothing for a
   wallet that has a node of either type.
   A burn made from the wallet's own Solana address (the site's record of the extension's burn, the extension's answer,
   or the search of that address, which the page reads with the address the extension or QNet Wallet shared) is
   registered the same way from any browser, a phone included: the page names the wallet with `check: false` and the
   burner, takes that wallet's answer only, by its full address, and only with an `ownerSig` that verifies, and posts the
   consent with the burner and that bind. The site checks the bind again, that the burner made this light burn of this
   amount (the wallet's record of it, else the first burn the search of the burner's address found), and that the wallet
   has no node of either type on the network, then submits it as it is. The extension is shown for a light burn only
   in the browser where it just made the burn and records the node itself.
5. "Registered", "linked" and "moved" are shown only after the page read them from the nodes; a relay answer is shown
   as the wallet's report until then. So is "unlinked": the page reads the node's status again after an `unlink`
   answer.
6. **Unlink.** The Device tab offers "Unlink the device" while the node's status names a device that runs it and both
   genesis nodes list `unbind_wallet`: the extension's `qnet_unlinkNodeDevice` when the extension holds the wallet the
   page shows and offers the method, else an `unlink` request naming that wallet, its button on a phone or tablet and its
   QR code on a computer. It needs no check number: the answer changes nothing by itself, and only keys of that wallet sign
   what the network takes. A lost device is unlinked the same way, from any device that holds the wallet. Beside it,
   "Move the node to another device" is the `link` request without a burn.

### 14.10 Extension methods

| Method | Params | Result |
| --- | --- | --- |
| `qnet_activateNode` | as section 10 | as section 10; after a light burn the extension also records the node on the chain, so the page reads the chain for "Registered" |
| `qnet_getActivation` | none | as section 10.1: what the extension knows of the wallet's activation, never a window |
| `qnet_claimNodeBalance` | none | the `claim` answer of section 14.7 without `v` and `intent`: `ok`, `empty` or `error`; a closed window is the provider error 4001 |
| `qnet_unlinkNodeDevice` | none | the `unlink` answer of section 14.7 without `v` and `intent`: `ok` with `unbound: true` (the wallet key's unbind, section 14.8), or `error` with `NO_WALLET`, `NOT_LINKED`, `NETWORK`, `UNLINK_REFUSED` or `INTERNAL`; a closed window is the provider error 4001; an extension without the method answers 4200 |

All four methods answer only the origins of section 10 (4100 for any other). `qnet_claimNodeBalance` and
`qnet_unlinkNodeDevice` act on the wallet's own light node only.

### 14.11 Security notes

Section 12 applies, with these additions:

- **Unlink.** The unbind is signed by the device's ping key, which never leaves that device, or by the wallet key, only
  on a request the user confirms in QNet Wallet or in the extension's own window; a forged `unlink` answer can make the
  page show a report, which the page replaces with what the nodes say. No page or relay holds a key the network takes an
  unbind from, and a page's `signMessage` cannot obtain one: both wallets refuse messages that start with the chain tag.
- **Request binding.** `reqHash` sits in the link, the relay recomputes it, the app checks it against the session,
  and the AAD binds every answer to it: a relay cannot swap the request of a session.
- **Signed reservation.** Only the wallet's own key holds a wallet at aiqnet.io: a stranger can neither reserve a
  wallet nor make a burn in its name, and a payment address shows only after its wallet signed for it. The signature
  is bound to aiqnet.io's origin and to the payment address; a page's `signMessage` cannot obtain it, since both
  wallets refuse messages of this form there and sign them only through the signer they keep for aiqnet.io's records.
- **Check number.** Someone who saw the QR can still answer first, but the page confirms the answer's wallet against
  the six digits the user reads on the phone, or against a wallet it already held, before it takes a consent; a forged
  `link` answer cannot direct a burn to another wallet, whose owner bind names the reserved wallet only. A request
  opened by the page's button on the same device needs neither: its session id and site key exist only in the page
  and in the link the system hands to QNet Wallet (an App Link or Universal Link verified for the app, or an
  `intent:` URL naming its package), so an answer can come only from that app or from the aiqnet.io server, which
  serves the page's code anyway.
- **Consent.** A consent only lets the burn's registration name the signer's own wallet and node; the owner bind
  names `sha3(K)` of that wallet, and one burn backs one node.
- **Own burn.** QNet Wallet signs an owner bind only with the wallet's own Solana key and only for its own node, key
  and `T`; the request's `burner` cannot name another key, since the app refuses any address but the wallet's own, and
  a bind is worth nothing for a burn that key did not pay for: the committee attests the burn's real payer.
- **Device evidence and push tokens** go from the app to the node directly; aiqnet.io never sees them.
- **Payment key.** The cabinet's one-time payment key lives in the browser as a non-extractable key and holds funds
  only between funding and the burn; the aiqnet.io server serves the page that uses it, so a user relies on that
  server for those minutes.

### 14.12 Test vectors

The `link` key of [`light-node.vectors.json`](light-node.vectors.json) ([Light node messages](light-node-messages.md)
section 10) holds:

| Key | Content |
| --- | --- |
| `cases` | twenty-three full exchanges (`connect` ok, rejected, error; `link` ok with `check: true`, ok for a known wallet, linked, rejected, error; `claim` ok, ok for part of the balance, ok for a part below 1 QNC, empty, rejected, error; `reserve` ok, with the wallet's signed reservation for the vectors' burner, rejected, error; `unlink` ok with the unbind taken, ok with it not confirmed, rejected, error, ok by the wallet key, refused by the network): the context the site validates in (`request`, `now`, `consent24h`), session id, site and app keys, request, request bytes, `reqHash`, link, session request and session view, shared secret, key, AAD, check number (and whether the app shows it), plaintext, IV, ciphertext, response request |
| `cryptoMustFail` | decrypt inputs that MUST fail: flipped tag or IV bit, another request's `reqHash`, the revision 1 AAD, another intent, a `connect` AAD with a `reqHash` |
| `invalidLinks` | strings a revision 2 parser MUST refuse, `activate` among them, and `reserve` and `unlink` links without their `reqHash` |
| `invalidSessionRequests`, `invalidResponseRequests` | relay bodies that MUST get 400 (or 413 for size), the latter per intent |
| `invalidPlaintexts` | answers the site MUST refuse, with the session, the context and the failing check |
| `androidIntent` | the `intent:` URL of the site's button for a `link` request |

[`light-node-own-burn.vectors.json`](light-node-own-burn.vectors.json) holds the `link` request with `burner` (its
bytes and `reqHash`), the answer with `consent.ownerSig` and the body the site submits, for each wallet of
`light-node.vectors.json` ([Light node messages](light-node-messages.md) section 10).
