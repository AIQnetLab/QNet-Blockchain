# The 1DEV token (Solana)

1DEV is an SPL token on Solana that QNet uses as the Phase 1 node-activation credit: an operator burns 1DEV on Solana, and a committee of QNet nodes attests that burn so it can be bound to a node identity on the QNet chain. 1DEV is not a QNet asset, it never enters QNet state, and it is unrelated to the native QNC token described in [overview.md](overview.md).

## External references

The following values describe an asset on Solana and are external references.

| Property | Value |
| --- | --- |
| Name / symbol | 1DEV |
| Chain | Solana (SPL token) |
| Mint address | `4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump` |
| Decimals | 6 |
| Maximum supply | 1,000,000,000 1DEV, fixed — no further minting |

Initial allocation, as published by the project: 750,000,000 1DEV (75%) distributed publicly at launch with no vesting, and 250,000,000 1DEV (25%) held under vesting contracts on Streamflow Finance.

| Vesting contract | Amount | Schedule |
| --- | --- | --- |
| `AEfkhkpTeAgVz15f5avNoE1EnyPy86RUt7wtv3Xew2x2` | 150,000,000 1DEV | Quarterly releases over 24 months |
| `5cpMZt5xftxPoFLeoXehcoQNe2z9RKtZZ3mzrKnYn97L` | 90,000,000 1DEV | Daily linear vesting over 2 weeks |
| `BQZvm5cBWFnKBVHVYZf63wM96YqtQM6V5vMiCDFXUEvz` | 50,000,000 1DEV | Quarterly releases over 24 months |

## Addresses configured in this repository

| Setting | Value |
| --- | --- |
| Burn address (all environments) | `1nc1nerator11111111111111111111111111111111` |
| 1DEV mint, devnet/testnet | `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ` |
| 1DEV mint, mainnet | `4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump` |
| Burn contract, all clusters | `CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw` |

All four are compile-time constants in `development/qnet-integration/src/network_config.rs`, selected by the network profile, and the mainnet mint is the same literal the mobile and browser wallets compile in — one value across node, app and extension, so a burn is measured against the same mint everywhere. The devnet/testnet mint is a test token, distinct from the mainnet mint above. An environment override is accepted only when it is base58 of pubkey length, and a value that is not exits at startup. See [configuration.md](../operators/configuration.md).

The burn program in `development/qnet-contracts/1dev-burn-contract` pins the devnet mint as its `OFFICIAL_1DEV_MINT` constant and rejects any other mint, so a mainnet deployment requires rebuilding that program against the mainnet mint.

For the burn-percentage arithmetic the node treats the 1DEV genesis cap as 1,000,000,000 whole tokens with 6 decimals and derives `total_burned = cap - current_supply` from a live `getTokenSupply` read.

## Activation cost in Phase 1

The Phase 1 cost is **universal across node types** — Light and Super pay the same. Only Phase 2 pricing is type-dependent.

The on-chain formula is `Transaction::phase1_activation_cost`, computed in integer arithmetic so every node agrees:

```
original        = total_burned + current_supply
burn_pct_tenths = total_burned * 1000 / original
tiers           = burn_pct_tenths / 100          // each complete 10%, capped at 8
cost            = max(1500 - 150 * tiers, 300)   // whole 1DEV
```

| Supply burned | Activation cost |
| --- | --- |
| 0-10% | 1,500 1DEV |
| 10-20% | 1,350 1DEV |
| 20-30% | 1,200 1DEV |
| 30-40% | 1,050 1DEV |
| 40-50% | 900 1DEV |
| 50-60% | 750 1DEV |
| 60-70% | 600 1DEV |
| 70-80% | 450 1DEV |
| 80% and above | 300 1DEV (floor; `tiers` is capped at 8) |

The denominator is the **sum** of burned and remaining supply, reconstructing the original cap — using the remaining supply alone would read 50% burned as 100%. Bucketing to complete 10% steps means committee members reading Solana at slightly different moments still agree on the cost except exactly at a bucket boundary, where the registration simply retries.

On-chain, `burn_cost` must be at least 300 1DEV and the bound `burn_amount` must be at least `burn_cost`. Each attestor independently re-verifies the Solana burn and recomputes the cost from its own supply read rather than trusting the caller's figure, then signs the pair it observed.

## Phase transition

Phase 1 ends and Phase 2 begins on whichever comes first:

- 90% or more of the original 1DEV supply burned, or
- five years (`PHASE2_AGE_SECS`, 1825 days) since the genesis block timestamp.

`Transaction::is_phase2` is the single resolver, and it takes both halves. The clock is anchored to the committed genesis-block timestamp this node tracks; a genesis timestamp of 0 — block 0 not applied yet — keeps the age half shut and resolves to Phase 1, the phase that demands more proof. The burn half reads the live Solana 1DEV supply, and a supply-read outage is a retryable error rather than a defaulted phase.

## What Phase 2 changes

In Phase 2, activation is paid in native QNC on the QNet chain rather than by burning 1DEV. Phase 2 QNC is deducted from the payer on QNet and `total_supply` is unchanged.

| Node type | Phase 2 base cost | Chain-level floor |
| --- | --- | --- |
| Light | 10,000 QNC | `PHASE2_LIGHT_MIN_NANO` = 5,000 QNC |
| Super | 7,500 QNC | `PHASE2_SUPER_MIN_NANO` = 3,750 QNC |

A network-size multiplier of 0.5x / 1.0x / 2.0x / 3.0x applies to the quoted base cost at 100,000 / 300,000 / 1,000,000 registered nodes. Full details are in [node-activation.md](node-activation.md).

An existing operator is not re-charged at the transition: `NodeActivation` apply is a no-op when the account's `is_node` flag is already set. Activation is one-shot per wallet at the state level — that `is_node` guard is phase-agnostic, so a wallet that activated in Phase 1 does not activate again in Phase 2. The mempool additionally dedups activations on `(wallet, phase)`.

## Burn mechanics

- A burn is permanent: tokens sent to the Solana burn address leave the 1DEV supply and cannot be recovered or re-minted.
- One burn activates exactly one node. The binding is enforced from committed QNet state by a `burn_tx -> node_id` uniqueness index, keyed on `node_id` rather than wallet, precisely because one wallet owns two distinct pseudonyms (Super and Light) and a wallet-keyed bind would let a single burn activate both tiers for one fee.
- The burning Solana wallet must sign an authorization message binding the beneficiary wallet, node id and the node's attestation-root tag, so a burn can only ever activate the node its owner named, running the key its owner named.
- A quorum of committee members must independently sign an attestation over `(burn_tx, burner, beneficiary, amount, node_type, cost, attest_epoch)`. Attestation is committee-wide, not limited to the genesis nodes.

1DEV's only protocol role is the burn-to-activate credit described above.

## Risk disclaimer

QNet is an experimental blockchain project, and 1DEV is a utility token for node activation only. Nothing here is investment advice, an offer, or a solicitation. Activation is a one-way burn with no refund path. Verify every external address on Solana before sending anything to it.

## Related documents

- [Economics overview](overview.md) — native QNC emission, rewards, claims and fees
- [Node activation](node-activation.md) — activation phases, registration, burn-identity binding
- [Configuration](../operators/configuration.md) — environment variables including the mainnet mint and burn contract
