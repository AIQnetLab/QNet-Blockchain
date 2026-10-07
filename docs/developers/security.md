# Security for developers

What a site, a game server or a tool must do so that building on QNet does not put users, their
funds or the server at risk. The rules follow from how the wallets, the SDK and the nodes behave
([dApp integration](dapp-integration.md), [Transactions](transactions.md), [Smart contracts](smart-contracts.md)).
To report a vulnerability in QNet itself, follow [SECURITY.md](../../SECURITY.md).

## Keys and recovery phrases

- **Never ask a user for a recovery phrase, a private key or a wallet password**, in a form, a chat, a
  support ticket or a file upload. A page needs none of them: the wallet signs, and the wallet shows
  the user what it signs. A site that asks for a phrase is indistinguishable from a theft.
- A page asks the wallet; it does not build or sign transactions itself, and no provider method signs
  arbitrary bytes as a transaction. `qnet_signMessage` signs text only, bound to the page's origin and
  under a context the node never accepts for a transaction.
- **A server's own key** lives in a `qnet` key file ([CLI](cli.md#keys)): encrypted with AES-256-GCM under
  an Argon2id key of its password, `0600` where the system has file modes. Keep the password out of
  the command line, shell history, environment dumps and logs; the command reads it without echo or
  from standard input. Wipe a key after use (`secretKey.fill(0)`, as `@aiqnet/sdk` does) and never
  commit a key file.
- A key made with `qnet keys new` has no phrase anywhere: back up the file and its password, or create
  the key in a wallet and import it.

## Signing users in

- **Verify on the server.** The address a page reports proves nothing; a verified sign-in does
  ([Sign-in](sign-in.md)). `verifySignIn` checks that the text names your site and the network, the
  time window, that the public key is the named account's, the signature for your origin, and that
  the nonce is used for the first time.
- **Pass your origin from configuration**, exactly as a browser writes it (`https://games.aiqnet.io`),
  never from the request. The wallet signs for the origin it reads itself, so a signature collected on
  another site does not verify for yours.
- **Issue each nonce on the server, to the session that asked for it, and accept it once, from that
  session only** (`issue(sessionId)`, `consume(nonce, sessionId)`). Otherwise a sign-in someone made
  with his own wallet for your site can be posted from another person's browser (a cross-site form),
  which is then signed in to his account and pays or deposits into it. Keep sign-in texts
  short-lived (the default is 10 minutes). Several servers need one shared nonce store.
- **Accept the verify request only as `application/json`, with an `Origin` header equal to your
  origin**; a cross-site form can post other types without asking the browser first
  ([Sign-in](sign-in.md#sessions-and-cross-site-requests)).
- After a sign-in, run your own session (a cookie your server sets). Do not keep the signed text as a
  bearer credential.

## Transactions

- **Identify a transaction by (`from`, `nonce`), not by its hash.** The hash is one node's name for its
  copy; the same signed transaction can land under another hash.
- **"Submitted" and "in a block" are not "succeeded".** The network records no outcome. Before you
  credit a user, check the effect: for a transfer the recipient's balance and the sender's nonce, for a
  token transfer the token-transfer feed or the token balance, for a contract call the contract's
  event or storage. A wallet's `qnet_getTransactionStatus` answers `in_block` for a call that
  reverted.
- **Wait for finality for anything valuable.** `GET /api/v1/transaction/{hash}` reports
  `finality_indicators.level`; `FullyFinalized` means the block is at or below the checkpoint the
  committee certified.
- **One transaction per account at a time.** A second send before the first is in a block is refused
  by the node or waits in the wallet; design flows (for example, several purchases in a row) around
  it.
- **Amounts are exact decimal text.** Convert with integers (`BigInt`, `parseUnits`), never with
  floating point. JSON numbers above 2^53 lose precision in JavaScript: the SDK reads balances exactly
  and writes request bodies from digits.
- **Check addresses before building.** An address is 45 lowercase characters with a SHA3-256 checksum
  (`isValidAddress`); a contract address has the same form. A built-in token transfer to
  `0000000000000000000eon00000000000000036877022` destroys the tokens; the wallets flag it in their
  approval, and `qnet` refuses it without `--burn`. No contract can send QNC or a built-in token on,
  so a node's submit routes refuse a transfer or a built-in token transfer to a contract address
  (`recipient_is_contract`). That check is not a block rule: a block that carries such a transfer
  applies it, and what it sends stays in the contract account for good. Read the recipient first and
  refuse one whose `isContract` is true (`NodeClient.getAccount`); treat an account answer too large to
  read as a contract. `qnet transfer` and `qnet token transfer` refuse a contract recipient.

## What a node tells you

- **Most reads are one node's word.** Balance, nonce, token details, token balances, events and
  transactions come back as the answering node reports them. Proofs exist for an account's balance and
  nonce (`/api/v1/account/{address}/balance/proof?mb=latest`), a holder's token balance
  (`/api/v1/token/{contract}/{holder}/balance/proof?mb=latest`) and one event (`/api/v1/logs/proof`).
  Ask for the certified form (`?mb=`), verify the quorum certificate of the macroblock it names
  (`macroblock_index`) yourself, and fold the proof to the `state_root` of that verified checkpoint, never
  to the root the node served ([certified state proofs](rpc-api.md#certified-state-proofs)). The form
  without `mb` proves against the answering node's live root, which folds to a certified root only while
  no account changed since the macroblock, so on a busy chain it rarely verifies (the SDK's
  `NodeClient.getVerifiedAccount` still reads that form); `verifyLog` checks the event against its
  checkpoint's `logs_root`. An answer without a proof that verifies (a legacy body, an
  error, a rate limit, a timeout) is no answer: ask another node, and never show it as a balance or a
  zero. For anything else, ask several nodes and require agreement, as the wallets do.
- `/api/v1/validators/proof` is a hash over a list the node builds itself, not a proof; treat it as a
  plain read.
- **Token names and symbols are the deployer's text.** Any token can call itself QNC or copy another
  token's name. Identify a token by its contract address, and show the address.

## Contracts

- **Fix the owner at build time.** No constructor runs at deploy, and the contract address is known
  before the deploy lands, so an `init` entry that stores its first caller can be called first by
  someone else. The `game-items` template compiles its owner in.
- **A call carries no QNC.** `get_value` is 0 in the entry call and only informational in a nested
  call; never treat it as a payment.
- **`get_caller` is the transaction's sender in the entry call** and the calling contract in a nested
  one. Authorize by comparing it with an address the contract trusts.
- **Emit an event from every entry that changes state.** Events are how clients learn that a call
  took effect; a reverted call keeps none.
- **Check the module before deploying.** `qnet check` (or `cargo check-contract`) catches what a node
  does not check at deploy: wrong imports, a missing `memory` export, entries of the wrong type. A
  module deployed with such a fault can never be called, and code cannot be replaced.
- **Keep contracts deterministic and small.** Floating point is refused; standard-library collections
  quickly pass the 24,949-byte deploy limit.

## Pages

- The extension gives its provider only to the top frame of `aiqnet.io` and `games.aiqnet.io`, and the
  app only to the top frame of the page it shows. Do not load your game in a frame of another site and
  expect a wallet there.
- Serve pages over HTTPS with a strict content security policy: a script injected into your page can
  call the provider too, and while the wallet shows the user every request, a trusted page is what
  makes a user approve.
- Handle a rejection (4001) as final. Repeating a request after the user said no makes the wallet
  pause the site ([dApp integration](dapp-integration.md#approvals-and-limits)).
- Never ask users to switch off a wallet warning, and never describe a contract call as something it
  is not: the wallet shows the method and input, and users compare.

## Servers

- **Respect the node limits.** Each IP may make about 300 reads and 100 submits a minute on a node by
  default, and 5 deploys an hour; a throttled request answers `{"success":false,"error":"Rate limit
  exceeded","retry_after_seconds":N}` with HTTP 200. Back off for `retry_after_seconds`, cache what
  changes slowly, and spread reads over the public nodes (`NodeClient` does).
- **Bound what you read.** `NodeClient` caps every answer (8 MiB by default); a raw client should too.
  `GET /api/v1/account/{contract}` returns a contract's whole storage and code.
- Talk to nodes over HTTPS (`https://node1.aiqnet.io` … `node5`), or over plain HTTP only on the same
  machine.

## Related documents

- [Sign-in](sign-in.md), [Transactions](transactions.md), [Smart contracts](smart-contracts.md)
- [SDK](sdk.md) and [CLI](cli.md)
- [RPC API](rpc-api.md#rate-limiting): rate limits and error shapes
