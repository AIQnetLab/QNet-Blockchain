# 1DEV burn contract

The 1DEV burn contract is an Anchor program deployed on Solana, the external chain that hosts the 1DEV
SPL token. It serves Phase 1 of QNet node activation: an operator burns 1DEV to the Solana incinerator
address in an ordinary SPL token transaction, and the signature of that transaction — carried inside
an activation code — is what a QNet node checks before accepting an activation. The program itself
never moves tokens; it has no CPI into the token program and no instruction debits a balance. The burn
is a separate, prior transaction, and the program records that it happened, counts activations, tracks
the share of the 1DEV supply burned, and holds the one-way flag that ends Phase 1. Phase 2 replaces
the burn with a QNC payment on QNet itself; this program stores the Phase 2 amounts as constants but
performs no Phase 2 operation. Two node types exist here, `Light` and `Super`, alongside a deprecated
`full_nodes` counter that stays zero for layout compatibility.

Source: `development/qnet-contracts/1dev-burn-contract/`. Everything below is stated from that source
and from `development/qnet-integration/src/rpc.rs`, the path a running node uses. Where a comment in
the source contradicts the code, the code is what is documented here.

## Crate layout

The crate is `onedev_burn_contract` (Rust edition 2021, `crate-type = ["cdylib", "lib"]`), built on
`anchor-lang` and `anchor-spl` 0.30.1 with `blake3` and `bs58` as its only other dependencies. The
source is `src/lib.rs`, `src/state.rs`, `src/errors.rs` and `src/instructions/`. The crate sits at the
root of `1dev-burn-contract/`, not under `programs/<name>/`, which matters for the build.

## State accounts

`BurnTracker` is the single global account: `authority`, `admin`, `burn_address`, `one_dev_mint`,
`genesis_timestamp`, `total_1dev_burned`, `total_burn_transactions`, `total_nodes_activated`,
`light_nodes`, `full_nodes`, `super_nodes`, `burn_percentage` (`f64`), `phase_transitioned`, `paused`,
`last_update`, `bump`, `verification_authority`. `authority` and `admin` are recorded at
initialization and are read by no constraint in the program as it stands; `verification_authority` is
the key that gates the privileged instructions, pinned at initialization and immutable, since there is
no rotation instruction.

`BurnRecord` is one account per burn transaction signature: `solana_tx_signature`, `one_dev_amount`,
`burner_wallet`, `qnet_node_activated` (`Option<Pubkey>`), `burn_timestamp`, `solana_block_height`,
`verified`, `bump`. `solana_block_height` is populated from `Clock::slot`, a slot number rather than a
block height.

`NodeActivationRecord` is one account per activated node public key: `node_pubkey`, `node_type`,
`activated_at`, `one_dev_burned`, `qnc_used`, `activation_phase`, `activation_signature` (64 bytes),
`is_active`, `qnc_rewards_claimed`, `bump`. `BurnStatistics` is not an account; it is the return type
of the read instruction.

### Program-derived addresses

| Account | Seeds |
| --- | --- |
| `BurnTracker` | `b"burn_tracker"` |
| `BurnRecord` | `b"burn_record"`, burn transaction signature as UTF-8 bytes |
| `NodeActivationRecord` | `b"node_activation"`, node public key bytes |

Because both record accounts are created with `init`, replay is prevented structurally: a second
attempt with the same burn signature, or a second activation of the same node key, fails at account
creation.

## Instructions

The program exposes exactly five instructions.

**initialize** creates the `BurnTracker` PDA. Arguments: `authority`, `admin`, `burn_address`,
`one_dev_mint`, `network_genesis_timestamp`, `verification_authority`. Accounts: the tracker PDA
(`init`), the paying `authority` signer, and the system program. All counters start at zero, `paused`
and `phase_transitioned` start false. `network_genesis_timestamp` is supplied by the caller and
anchors the five-year Phase 2 deadline; it is not the deployment time.

**burn_1dev_for_node_activation** takes `node_type`, `one_dev_amount`, `solana_burn_tx` and a node
public key. Accounts: the tracker (must be neither paused nor phase-transitioned), a new
`NodeActivationRecord`, a new `BurnRecord`, the paying `user` signer, the node public key as an
unchecked account, the 1DEV mint (constrained to equal `burn_tracker.one_dev_mint`), and the system,
token and rent programs. The token program and mint accounts are required by the account struct but no
token instruction is invoked. The handler checks that the signature string is 64 to 88 characters and
base58-decodes to exactly 64 bytes; that `one_dev_amount` is at least the current required amount from
the pricing curve; that the burn address on the tracker equals the Solana incinerator constant
compiled into the program; and that the mint equals the 1DEV mint constant compiled into the program.
There is no RPC lookup of the burn transaction — the program validates format and addresses only, and
the substantive check is left to the QNet node. It then writes an `activation_signature`: a 64-byte
value formed from two chained Blake3 digests over the node key, burner key, burn transaction string,
node type and amount. All of those inputs are public, so the value is a deterministic digest
reproducible by anyone holding them; it is not a signature and does not prove control of the burner
wallet. Finally the handler increments the tracker counters, recomputes `burn_percentage`, and emits
`NodeActivatedEvent`.

**record_burn** takes `tx_signature` and `one_dev_amount`. Accounts: the tracker, a new `BurnRecord`,
the paying `burner` signer, a `verification_authority` signer constrained to equal
`burn_tracker.verification_authority`, and the system program. Checks: amount at least the minimum
activation price; signature string 64 to 88 characters decoding to exactly 64 bytes; the tracker has
not phase-transitioned. The record is bound to `burner.key()`, and `verified` is set true on the
strength of the authority's signature — the authority attests that it performed the off-chain check of
the transaction against the incinerator and the mint. This instruction does not check the `paused`
flag; only the activation instruction does.

**get_burn_stats** reads the tracker and returns a `BurnStatistics` value: totals, burn percentage,
days since the recorded genesis timestamp, per-type node counts, the current 1DEV price,
`phase_transitioned` and `should_transition`, the Phase 2 QNC constants, the paused flag and
`last_update`. The Full-node cost field is returned as zero.

**execute_phase_transition** takes the tracker (must not already be transitioned) and a `caller`
signer constrained to equal `burn_tracker.verification_authority`; the handler additionally requires
`should_transition()` to hold. It sets `phase_transitioned` to true. No instruction clears the flag,
so the effect is permanent for that tracker account.

## Activation pricing and phase transition

Pricing is a function of the burn percentage only; it does not vary by node type. The base amount is
1500 1DEV, reduced by 150 1DEV for each completed ten percent of supply burned, with a floor of 300
1DEV, all at six decimals. `burn_percentage` is `total_1dev_burned` over `ONE_DEV_TOTAL_SUPPLY` (one
billion tokens), as a percentage.

`should_transition()` returns true when `burn_percentage` reaches 90, or when 1825 days have elapsed
since `genesis_timestamp`. Phase 2 constants stored for reporting are 10,000 QNC for a Light node and
7,500 QNC for a Super node, at nine decimals. The economic reasoning behind these figures is in
[../economics/tokenomics-1dev.md](../economics/tokenomics-1dev.md).

## How a QNet node verifies a burn

Verification lives in `verify_burn_transaction_exists` in
`development/qnet-integration/src/rpc.rs`. For Phase 1 the node:

1. Issues a `getTransaction` JSON-RPC call for the burn signature against the Solana endpoint of the
   active network profile, with `encoding` `jsonParsed`, `commitment` `finalized` and
   `maxSupportedTransactionVersion` 0. A signature Solana has not indexed yet is retried up to three
   times, six seconds apart; the attestation path passes a budget of one so an unauthenticated caller
   cannot multiply one request into several upstream round trips.
2. Rejects the burn when `meta.err` is non-null.
3. Requires `accountKeys[0]`, the fee payer that signed the Solana transaction, to equal the
   registering wallet. A mismatch fails verification, so one burn cannot be presented by a second
   wallet.
4. Requires a burn indicator: a parsed `burn` or `burnChecked` instruction among the outer or the
   inner instructions, or the Solana incinerator address among the account keys. A transfer to any
   other destination is refused.
5. Derives the amount from `preTokenBalances` and `postTokenBalances`, summing `pre - post` over the
   entries whose `mint` equals the canonical 1DEV mint and pairing pre to post by `accountIndex` and
   mint. A balance entry for any other mint contributes nothing, and a missing post entry counts as
   zero, which is the closed-account case.
6. Requires that total to reach the quoted price converted to base units at six decimals. A larger
   burn is accepted, and the actual burned amount in whole 1DEV is what the node reports.

The result is what a genesis attestor signs; the quorum of those attestations is what block
validation re-verifies deterministically, so the Solana read itself stays on the admission side. See
[../economics/node-activation.md](../economics/node-activation.md).

The node reads the burn transaction from Solana directly, so the program's accounts are an
independent record rather than the oracle activation consults. The phase decision is
`Transaction::is_phase2`: 90% of the original 1DEV supply burned, or five years since the committed
QNet genesis-block timestamp. Burn progress comes from a `getTokenSupply` read on the mint, with the
shortfall against the one-billion genesis cap taken as the burned total.

## Configuration and addresses

Addresses are external references. Confirm each against the actual deployment before use; do not
treat the values in this repository as authoritative.

| Reference | Value carried in the source, to be confirmed before use |
| --- | --- |
| Program ID | `CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw` — `declare_id!` in `src/lib.rs`, all three cluster entries in `Anchor.toml`, `initialize_tracker.py`, and `BURN_CONTRACT_PROGRAM_ID` in `development/qnet-integration/src/network_config.rs` |
| 1DEV mint, devnet/testnet | `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ` — compiled into `burn_1dev_for_node_activation.rs`, `initialize_tracker.py`, and `DEVNET_1DEV_MINT` in the node |
| 1DEV mint, mainnet | `4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump` — `MAINNET_1DEV_MINT` in the node, and the same literal in the mobile and browser wallets |
| Burn address | `1nc1nerator11111111111111111111111111111111`, the Solana incinerator — compiled into the contract, required to equal `burn_tracker.burn_address`, and `SOLANA_INCINERATOR` in the node |

The mint constant is compared inside the program, so the mint passed to `initialize` must match it or
every activation call fails. On the node side all four addresses and the Solana RPC endpoint come
from the compiled network profile that `QNET_NETWORK` selects. Two environment variables can replace
a pinned mainnet address:

| Variable | Effect |
| --- | --- |
| `QNET_MAINNET_1DEV_MINT` | Replaces `MAINNET_1DEV_MINT`. Accepted only when the value is base58 of pubkey length; anything else exits at startup |
| `QNET_MAINNET_BURN_CONTRACT` | Replaces `BURN_CONTRACT_PROGRAM_ID` on mainnet, under the same check |

## Build and deployment

Toolchain, from the source tree: Anchor 0.30.1 matching the crate dependencies, a Solana toolchain in
the 1.18 series (the vendored `solana-release/version.yml` pins channel v1.18.26), Rust with the 2021
edition, and the JavaScript dependencies pinned in `package-lock.json` — `@coral-xyz/anchor` 0.30.1,
`@solana/web3.js` 1.95, mocha and chai.

Because the program crate is at the directory root rather than under `programs/<name>/`, `anchor build`
finds no program to compile in this layout. Build the SBF artifact directly:

```bash
cd development/qnet-contracts/1dev-burn-contract
cargo build-sbf
```

Configure the target cluster and the deploying keypair, then deploy. Use your own keypair path; never
commit a keypair to the repository.

```bash
solana config set --url <cluster-rpc-url>
solana config set --keypair <path-to-deployer-keypair.json>
solana balance

solana program deploy target/deploy/onedev_burn_contract.so \
  --program-id target/deploy/onedev_burn_contract-keypair.json
```

The program ID is fixed by the program keypair. If you deploy under a new keypair, update
`declare_id!` in `src/lib.rs` and the three entries in `Anchor.toml`, rebuild, and redeploy — a
mismatch between the declared ID and the deployed address makes every instruction fail.

After deployment the `BurnTracker` PDA must be created once. `initialize_tracker.py` builds the
`initialize` instruction with `solders`, deriving the Anchor discriminator as the first eight bytes of
`SHA256("global:initialize")` and the PDA from the `burn_tracker` seed:

```bash
python initialize_tracker.py <path-to-deployer-keypair.json>
```

Read the script before running it. Its RPC endpoint, mint, incinerator and program constants are
hard-coded, it assigns the deployer key to every authority slot including `verification_authority`,
and it passes the current wall-clock time as the network genesis timestamp. For anything beyond a
throwaway deployment, set the genesis timestamp to the real QNet genesis block time and give
`verification_authority` a key you intend to keep, since the program cannot rotate it. The script is
idempotent. Verify the result with `solana program show <program-id>` and by reading the tracker
account at the derived PDA.

## Verifying a deployment

Verification of a deployed program is a compile check with `cargo build-sbf`, an idempotent
`initialize_tracker.py` run against a development cluster, and reading the tracker account back with
`solana program show <program-id>`. `Anchor.toml` configures `ts-mocha` against `tests/` for any
suite you add there.

## Related documents

- [../economics/tokenomics-1dev.md](../economics/tokenomics-1dev.md) — 1DEV supply and burn economics.
- [../economics/node-activation.md](../economics/node-activation.md) — activation across both phases.
