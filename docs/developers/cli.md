# The `qnet` command

`qnet` is the command line of `@aiqnet/sdk` (`development/qnet-sdk/src/cli.ts`). It keeps keys in
encrypted files on the computer it runs on, reads the chain, and builds, shows, signs and sends
transfers, token transfers, contract calls and contract deploys with the same builders the wallets use.
Nothing secret is ever printed.

It is a developer tool for the testnet. The Python tool in `applications/qnet-cli` (installed as
`qnet-cli`) is a different, read-only program, described in [CLI](../applications/cli.md).

## Install

Node 20 or later.

```
cd development/qnet-sdk
npm ci
npm run build              # dist/cli.js
node dist/cli.js --help    # or: npm pack, then npm install --global ./aiqnet-sdk-2.0.0.tgz, then: qnet --help
```

The package is not on the npm registry: never install a `qnet` command or the SDK from it by name ([SDK,
Install](sdk.md#install)).

## Commands

```
Keys (encrypted files in ~/.qnet/keys, or $QNET_HOME/keys):
  keys new [--name NAME] [--words 12|24]  create a key; its recovery phrase is never shown, so back up the key file
  keys import [--name NAME]               store the key of a 12- or 24-word recovery phrase
  keys list                               every key and its address
  keys address [NAME]                     the address of a key
  keys export-public [NAME]               the address and public key of a key

Reading:
  balance [ADDRESS] [--key NAME] [--verified]
  token info CONTRACT
  token balance CONTRACT [ADDRESS] [--key NAME]
  logs CONTRACT [--from HEIGHT] [--to HEIGHT]
  tx HASH

Sending (each shows what it will sign and asks before sending):
  transfer --to ADDRESS --amount QNC
  token transfer CONTRACT --to ADDRESS --amount AMOUNT
  call CONTRACT METHOD [--args HEX | --args-utf8 TEXT] [--fuel N | --gas-limit N]
  deploy FILE.wasm
  check FILE.wasm                         only the local module check
```

This is the command's own help text (`qnet --help`), which also lists the options below.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--key NAME` | reading and sending | the key to use (default: `default`, or the only key) |
| `--gas-price N` | sending | nano-QNC per gas, at least 10 (the default) |
| `--nonce N` | sending | the nonce to use instead of reading it from a node |
| `--dry-run` | sending | print the exact text that would be signed and send nothing |
| `--yes` | sending | do not ask; required when there is no terminal |
| `--no-wait` | sending | do not wait for the transaction to reach a block |
| `--burn` | `transfer`, `token transfer` | allow sending to the burn address, which destroys what is sent |
| `--network testnet` | all | the network; the testnet is the default and only one |
| `--node URL` | all | a node to use instead of the public ones (repeatable; HTTPS, or plain HTTP on this machine) |
| `--home DIR` | all | the QNet directory (default `$QNET_HOME`, else `~/.qnet`) |
| `--timeout SECONDS` | all | how long each node request may take (default 10, at most 600) |
| `--json` | all | machine-readable output on standard output; a send that asks first prints its review (and a deploy its module report) on standard error |

There is no faucet command: no public QNC faucet exists. Test QNC comes from a funded wallet.

## Keys

- `keys import` asks for a 12- or 24-word recovery phrase, then a new password; the key is the one the
  wallets derive from that phrase. `keys new` makes a fresh key whose phrase is never shown: the key
  file and its password are its only backup, so a key that must also live in a wallet is created in the
  wallet and imported here.
- The file is encrypted with AES-256-GCM under an Argon2id key of the password (the browser
  extension's vault parameters) and is readable by the user only where the system has file modes.
  The password must be at least 8 characters, the wallets' new-password rule.
- Without a terminal, secrets are read from standard input, one per line: the recovery phrase
  (`keys import`), then the password. With a terminal they are read without echo.

```
qnet keys import
qnet keys list
qnet keys export-public
```

## Reading

- `balance` shows one node's answer. `balance --verified` checks the node's proof against a checkpoint
  the committee signed, starting from the trust anchor in the release, and keeps the checkpoints it
  verified in `~/.qnet/anchors-testnet.json`; it exits with 1 when the answer cannot be verified. The
  balance is the one as of the proof's height, which the command prints with how far that is below the
  chain's tip as the other nodes report it; a proof more than 270 blocks (three macroblocks) below the tip,
  or one whose age no node can tell, is not verified. Give several `--node` options: with one, the tip comes
  from that node too. That
  file is a trust root: the next run takes its checkpoints as verified. Where the system has file modes
  the command ignores it (and says so on standard error) when other users can change it or the directory
  it is in, and it writes the file only while that directory is the user's alone, into a new file renamed
  over the name, never through a link planted under it.
- `balance --verified` walks the committee-signed checkpoints from the release's trust anchor up to the one
  the proof names, one proof per step of two macroblocks, so its first run takes longer the older the
  release is (about 480 steps a day). It prints how far it got on standard error every few seconds, keeps
  checkpoints of what it verified after every 64 steps, and walks for at most 30 minutes. Even and odd
  macroblocks form two chains of checkpoints, each walked on its own, and a proof is checked on the chain of
  its macroblock. A run that stops early (the time ran out, no node served the next proof, the checkpoint is
  not signed yet, the command was interrupted) says so: the next run whose proof is on the same chain goes on
  from the kept checkpoints, and the message says whether the other chain has any kept yet, or starts from
  the release's anchor.
- `token info` and `token balance` show one node's answer: the chain offers no proof of a token's name,
  symbol or decimals.
- Text a node, a token's deployer or a module's author chose (a token's name and symbol, a transaction's
  fields, a node's refusal, a module's export and import names in `check` and `deploy`) is printed with
  control and formatting characters escaped and cut to a bounded length, so it cannot move the cursor or
  hide a line of a review.
- `logs` reads a contract's events window by window (501 heights per request), at most 10,020 heights
  per command; without `--from` it reads the last 501 heights. Each line is `height  tx_hash  data`,
  with the data also as text when it is readable.
- `tx` looks a hash up on the nodes and, for a transaction older than the nodes keep, in the site
  archive. A hash names one node's copy; the command says so when it finds nothing.

Output of the built command against a local node that serves answers recorded from the testnet
(`development/qnet-sdk/test/fixtures/`, `--node` option not shown):

```
$ qnet balance 4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d
Address:  4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d
Balance:  2909459.67465 QNC
Nonce:    2
One node's answer; add --verified to check it against the chain.

$ qnet tx f7d6c1ea3936b29b399cdfcc3eaae2b68d78c54127ea775db430ece2f5ee2bea
Status:   in block 2208291 (FullyFinalized)
Type:     RewardDistribution
From:     system_rewards_pool
To:       3ea41975abd7681e7e1eon5257cf41fa26cbf9bbd32ad
Nonce:    0
A block holds it; whether it applied shows in the sender's nonce and balance.
```

For a transaction still in a node's pool the status reads `waiting for a block` and the last line
`No block holds it yet: it waits in a node's pool and has not applied.`

## Sending

Every send reads the account's nonce from a node (unless `--nonce` is given), builds the transaction,
checks that the balance covers the maximum fee (and the amount or token deposit), prints what it will
sign, asks for confirmation, asks for the key's password, signs, reads the account again (a nonce used
in the meantime stops the send, and nothing is sent), submits and waits for a block. The public key goes
along until the chain holds it; a deploy always carries it. A node that cannot resolve the left-out key yet
(`pk_unresolved`, a node a block behind) gets the same transaction once more with the key, and a node that
refuses for a reason of its own (busy, behind, the recipient's account unreadable) passes it to the next node.

- `transfer --to ADDRESS --amount QNC`: the amount in QNC, at most 9 fraction digits.
- `transfer` and `token transfer` read the recipient's account first and refuse a contract address: no
  contract can send QNC or a built-in token on, so what is sent would stay in the contract for good. A
  node's submit route refuses such a transfer too (`recipient_is_contract`), but a block that carries one
  applies it. An account answer too large to read counts as a contract.
- `token transfer CONTRACT --to ADDRESS --amount AMOUNT`: the amount in the token's units; the command
  takes the token's decimals only when two nodes give the same standard, decimals, symbol and name (the
  one node, when a single `--node` is given) and refuses otherwise (`NODES_DISAGREE`), refuses a token
  that is not `qrc20`, and adds the refundable 0.01 QNC deposit when the recipient holds none of the
  token. A send to the burn address (with `--burn`) destroys the tokens and creates no entry, so it
  takes no deposit, and the review names the address as the burn address. The review and the question
  name the decimals and the amount in base units.
- `call CONTRACT METHOD`: the input as `--args` (hex) or `--args-utf8` (text); fuel 200,000 by
  default, or `--fuel N` (at least 10,000), or an explicit `--gas-limit N`. The command refuses an
  address that holds no contract or a built-in token. A contract whose account answer (it carries the
  whole storage) is larger than the 8 MiB the command reads is called without that check, and the
  review says so. A client that reads the node itself gets `is_contract` and `contract_type` without the
  storage from `GET /api/v1/account/{address}?fields=basic` ([RPC API](rpc-api.md#rest-accounts)).
- `deploy FILE.wasm`: runs the local module check first ([below](#checking-a-module)), prints the
  module's size, code hash, entries, imports, memory and deploy gas, sends it to
  `POST /api/v1/contract/deploy` with the gas limit set to the deploy's intrinsic gas, and waits until
  the contract exists at its address. Modules above 24,949 bytes are refused.

`--dry-run` prints the transaction and the exact signed text and sends nothing; with `--nonce` a
transfer, call or deploy contacts no node at all (a token transfer still reads the token's decimals). With the test wallet's key, for the transfer and call vectors of
[Transactions](transactions.md):

```
$ qnet transfer --to 4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d --amount 1.5 --nonce 1 --dry-run
Network:      testnet (q1337)
From:         d9fa370374e24333242eon847d1d354dcd87fe873823e (key "default")
To:           4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d
Amount:       1.5 QNC
Total at most: 1.50015 QNC
Nonce:        1
Gas:          10000 at 10 nano-QNC (the network charges 1.5 times the price)
Fee at most:  0.00015 QNC
Route:        POST /api/v1/transaction
Text to sign:
q1337|transfer:d9fa370374e24333242eon847d1d354dcd87fe873823e:4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d:1500000000:1:10:10000

$ qnet call 83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3 run --args 01020304 --fuel 50000 --nonce 4 --dry-run
Network:      testnet (q1337)
From:         d9fa370374e24333242eon847d1d354dcd87fe873823e (key "default")
Contract:     83485d2591342b03b8aeonc9ca2211bc1b2aad43bbad3
Method:       run
Arguments:    4 bytes: 01020304
Fuel:         50000 for the contract's code; what it does not use is refunded
Nonce:        4
Gas:          150465 at 10 nano-QNC (the network charges 1.5 times the price)
Fee at most:  0.002256975 QNC
Route:        POST /api/v1/contract/call
Text to sign:
q1337|contract_call:d9fa370374e24333242eon847d1d354dcd87fe873823e:62c362278e533e99c54b2fddb6bf534ec6a8092588126a66151f76c78815b597:4:10:150465
```

After a send the command reports what it can know:

| Output | Meaning |
| --- | --- |
| `Done: nonce N is applied.` | a transfer or token transfer took place |
| `Deployed. Contract address: …` | the contract exists at the derived address |
| `In a block: nonce N is used. The network records no call result: …` | a call was applied or stopped by the contract; check its events (`qnet logs`) or state |
| `A block holds it (height H), but the network did not apply it: …` | two nodes (the one node given) each hold it in a settled block and report the nonce unused (exit code 1); never for an account's first transaction (nonce 1), since a node of an earlier release answers nonce 0 for a failed read too |
| `A block holds it (height H), but no node has shown nonce N used yet. …` | the wait ended with the transaction in a block and the nonce not yet seen used (always so for a first transaction that did not apply); check later with `qnet balance` |
| `Not in a block yet. …` | the wait ended first; check later with `qnet tx` or `qnet balance` |
| `Not confirmed by any node, and one that gave no answer may have taken it …` | no node confirmed the send, but one timed out or failed after the request could have reached it; the command then waits by nonce, and exits with 1 unless the nonce shows it applied |

The command also prints `Its identity is (from, nonce N); another node may name its copy with another
hash.`: track a transaction by sender and nonce. Whenever the outcome is not `applied`, it adds
`To send it again safely, reuse the nonce: add --nonce N`: at most one transaction of an address applies
at a nonce, so a second send at the same nonce can never pay twice, while a new command without
`--nonce` reads the next nonce and would.

## Checking a module

`qnet check FILE.wasm` runs locally what a deploy needs: the size and deploy gas within the limits,
the node's feature, memory and function rules, imports only of the host functions of module `env` with
their exact types, a `memory` export, and entries of type `() -> ()`. It prints the module's size, code
hash, entries, imports, memory and deploy gas, or every problem it found (exit code 1). For the
counter template built in `contracts/`:

```
$ qnet check contracts/target/wasm32-unknown-unknown/release/counter.wasm
Module:       2,382 bytes, code hash 86b0f71a31a7a2465eb9c56ad66de497d5d8d7ec526d801854ab2b7f3ce3f3ec
Entries:      reset, run
Imports:      storage_write, get_caller, emit_log, storage_read, revert
Memory:       2 to 2 pages of 64 KiB
Deploy gas:   548,660
The module passes the local check of the deploy rules.
```

The contract
templates' own build (`cargo build-contracts` in `contracts/`) runs the node's validator as well
([Smart contracts](smart-contracts.md#building-contracts-in-rust)).

## Exit codes

| Code | When |
| --- | --- |
| 0 | done |
| 1 | an error (printed as `qnet: <message> [<CODE>]`), a declined confirmation, a transaction a block holds but the network did not apply, a send no node confirmed that has not applied by the end of the wait, a `balance --verified` that could not be verified, a `check` that found problems |
| 2 | a usage error: unknown command or option, a wrong argument, a send without a terminal and without `--yes` |

## Related documents

- [SDK](sdk.md): the library behind the command
- [Transactions](transactions.md): the formats it signs
- [Smart contracts](smart-contracts.md): building and deploying contracts
- [Security](security.md): key files and passwords
