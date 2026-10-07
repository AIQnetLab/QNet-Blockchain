# Sign-in with a QNet wallet

A site proves that a visitor controls a QNet address by having the visitor's wallet sign a short text
and checking that signature on the site's server. Nothing is sent to the chain and nothing costs QNC.
The text format and the server check are implemented in `@aiqnet/sdk` (`development/qnet-sdk/src/signin.ts`,
tested in `development/qnet-sdk/test/signin.test.mjs`); the signature itself is the wallets'
`qnet_signMessage` ([dApp integration](dapp-integration.md)).

## Flow

1. The server issues a nonce to the visitor's session (the random cookie it set for that browser) and
   keeps it, with that session, until it is used or expires.
2. The page connects to the wallet, builds the sign-in text with that nonce and asks the wallet to
   sign it (`qnet_signMessage`). The wallet shows the exact text and the page's origin.
3. The page sends the text, the signature and the public key to the server as `application/json`, in
   the same session.
4. The server checks the request (below), checks everything in the table, marks the nonce used when it
   was issued to this session, and starts its own session for the address.

```js
// development/qnet-sdk/README.md
// Server: issue a nonce to the session that asks for it, and keep it until it is used.
import { createNonceStore, verifySignIn } from '@aiqnet/sdk';
const nonces = createNonceStore();
const nonce = nonces.issue(sessionId); // the id of this visitor's session: a random cookie your server set

// Page: the wallet signs the sign-in text for this page's origin.
const signed = await wallet.signIn({ nonce, statement: 'Sign in to play' });

// Server: the text names this site and network, is inside its validity window, the key is the account's own,
// the signature verifies for this origin, and the nonce was issued to this session and is used for the first time.
const { address } = await verifySignIn(signed, { origin: 'https://games.aiqnet.io', consumeNonce: (n) => nonces.consume(n, sessionId) });
```

## The text

`createSignInMessage` writes, and `parseSignInMessage` accepts, exactly this form (lines joined by a
single line feed, no trailing line feed):

```
Sign in to games.aiqnet.io
Sign in to play

Account: d9fa370374e24333242eon847d1d354dcd87fe873823e
Chain: q1337
Nonce: <nonce>
Issued at: 2026-09-26T10:00:00Z
Expires at: 2026-09-26T10:10:00Z
```

This is the text the SDK's test pins (`writes the text the wallet shows`), with the test wallet's
address.

| Line | Rule |
| --- | --- |
| `Sign in to {domain}` | the site's host as its origin writes it: `games.aiqnet.io`, or `localhost:3000` for a local page; lowercase |
| statement | optional, one line, 1 to 200 characters, no leading or trailing space, no hidden characters |
| blank line | always present |
| `Account:` | the EON address signing in |
| `Chain:` | the chain id the wallet reports (`qnet_chainId`): `q1337` |
| `Nonce:` | 16 to 64 letters and digits; `createSignInNonce` gives 32 hex characters |
| `Issued at:`, `Expires at:` | UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`; the default validity is 10 minutes, at most 24 hours |

Any other spelling (another line break, extra spaces, milliseconds, a trailing line feed, text before
the first line) is refused as `SIGNIN_MALFORMED`: the server parses the text and writes it back, and
the two must be equal.

## What the wallet signs

`qnet_signMessage({message})` returns `{signature, publicKey, address}`: the ML-DSA-65 signature
(3,309 bytes) and public key (1,952 bytes) as hex, and the address. The signature covers these bytes
(`applications/qnet-mobile/src/crypto/OffchainMessage.js`, `buildOffchainMessage`):

```
"QNet Signed Message:\n" + origin + "\n" + utf8ByteLength(message) + "\n" + message
```

It is made with the FIPS 204 context string `QNET_OFFCHAIN_MSG_v1`. The origin is the page's origin as
the wallet reads it (`https://games.aiqnet.io`), never a value the page passes. So:

- a signature a wallet made on one site never verifies for another origin;
- a signature can never pass as a transaction: the node verifies transactions with an empty context,
  and the wallet refuses any message that starts like a protocol message such as `q1337|`.

## What the server checks

`verifySignIn(signed, {origin, consumeNonce, chainId?, now?, maxValidityMs?, clockSkewMs?})` checks, in
this order, and throws a `QNetError` with the code shown:

| Check | Code |
| --- | --- |
| `consumeNonce` is given | `SIGNIN_REPLAYED` |
| the text is exactly the sign-in form | `SIGNIN_MALFORMED` |
| `origin` is an `http(s)` origin | `INVALID_ORIGIN` |
| the text names this site's host | `SIGNIN_WRONG_DOMAIN` |
| the text names the expected chain (default `q1337`) | `SIGNIN_WRONG_CHAIN` |
| the validity window is positive and at most `maxValidityMs` (default 24 hours) | `SIGNIN_TOO_LONG_LIVED` |
| `Issued at` is not later than now plus `clockSkewMs` (default 60 seconds) | `SIGNIN_NOT_YET_VALID` |
| now is before `Expires at` | `SIGNIN_EXPIRED` |
| the public key derives the named address (and the address the page reported, when given) | `SIGNIN_WRONG_ADDRESS` |
| the signature verifies over the wallet's bytes for this origin | `SIGNIN_BAD_SIGNATURE` |
| `consumeNonce(nonce)` returns `true`: the nonce was issued to the session this request came in, and not used before | `SIGNIN_REPLAYED` |

The nonce is consumed last, so a refused sign-in (expired, not yet valid, wrong key) does not use it
up. It returns the parsed fields: `{domain, address, chainId, nonce, issuedAt, expiresAt, statement}`.

`origin` must be the site's origin exactly as a browser writes it (`https://games.aiqnet.io`, no path,
no default port). Pass it from your configuration, never from the request.

## Sessions and cross-site requests

The origin binding stops a signature made on another site. It does not stop a valid sign-in for your
site from being replayed into someone else's browser: an attacker signs in with his own wallet, keeps
the signed text unsent, and makes a victim's browser post it to your verify route (a cross-site form,
for example). If that sign-in were accepted, the victim's browser would be signed in to the attacker's
account, and what the victim then deposits or pays would go to the attacker. So:

- **Tie each nonce to the session that asked for it**, and accept it only from that session:
  `issue(sessionId)` when the page asks for a nonce, `consume(nonce, sessionId)` in `consumeNonce`.
  The session id is a random value your server set in a cookie before sign-in, never a value the
  request names. A request that carries no session gets no nonce and no sign-in.
- **Accept the verify request only as `application/json`, with an `Origin` header equal to your
  origin.** Refuse any other type (a cross-site form can post `text/plain`,
  `application/x-www-form-urlencoded` or `multipart/form-data` without asking the browser first) and a
  missing or other `Origin`.
- After the sign-in, start a new session (a new cookie value) for the address, and drop the old one.

## Nonces

`createNonceStore({ttlMs, max, now})` keeps nonces in one process: `issue(binding)` returns a fresh
nonce and remembers it, with the session id `binding`, for `ttlMs` (default 10 minutes);
`consume(nonce, binding)` returns `true` once for a nonce it issued to that same binding that has not
expired, and `false` afterwards, for a nonce issued to another binding (which stays usable in its own
session), and for anything else. A binding is 16 to 512 characters (`NONCE_BINDING_MIN_CHARS`,
`NONCE_BINDING_MAX_CHARS`); `issue` refuses any other value with `INVALID_BINDING`. It holds at most `max`
nonces (default 100,000); when full, `issue` drops the oldest one to make room, so a flood of
requests cannot stop it issuing, and an issue takes the same time whether the store is full or not
(expired nonces are dropped from the front, never by a pass over the whole store). A flood can still
push out a nonce a visitor has not used yet: one that asks for `max` nonces within the time a visitor
takes to approve in the wallet stops that visitor's sign-in. Anyone can ask for a nonce before signing
in, so rate-limit the route that issues them per client (for example a few a minute per IP address). Several servers behind one site need a shared store with the same rule, for
example a database row per nonce, holding its session id, that is deleted when used.

## Checking without the SDK

A server in another language reproduces three steps:

1. **The address of the key.** `h = hex(SHA-512(publicKey))`, lowercase; `p1 = h[0..19]`,
   `p2 = h[19..34]`; the address is `p1 + "eon" + p2 + hex(SHA3-256(p1 + "eon" + p2))[0..8]`
   (`applications/qnet-mobile/src/crypto/WalletIdentity.js`, `eonFromPublicKeyBytes`). It must equal the
   `Account:` line.
2. **The signed bytes.** Build them as above from your own origin string and the exact text.
3. **The signature.** ML-DSA-65 verification (FIPS 204) of the 3,309-byte signature over those bytes,
   with the context `QNET_OFFCHAIN_MSG_v1`.

Then check the text's fields, the time window and the nonce (issued to this session, used once) as in
the table above, and the request as in [Sessions and cross-site requests](#sessions-and-cross-site-requests).

## Related documents

- [dApp integration](dapp-integration.md): `qnet_signMessage` and its limits
- [Security](security.md): sessions, origins and keys
- [SDK](sdk.md): `createSignInMessage`, `parseSignInMessage`, `verifySignIn`, `createNonceStore`
