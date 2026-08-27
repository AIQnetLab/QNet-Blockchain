# qnet-loadtest — real-path confirmed-TPS & finality-latency harness

External load-test harness that measures QNet capacity over the **production
transaction path** — every transaction is a real ML-DSA-65-signed `Transfer`
submitted via `POST /api/v1/transaction` between real key-derived accounts.
No benchmark bypass, no unsigned throughput.

## What it measures
- **Included TPS (soft)** — txs included in a microblock; and **Finalized TPS (hard)** —
  those reached by a macroblock 2f+1 QC. Reported separately (soft ≠ finalized).
- **Inclusion (soft) latency** p50/p95/p99 — submit → included in a microblock.
- **Hard-finality latency** p50/p95/p99 (upper bound) — submit → macroblock 2f+1 QC.
- **Success rate**, errors, and **dropped** (accepted-but-mempool-evicted, auto-reclaimed).
- **P3b** — cryptographic logs-inclusion merkle proof verification for a sample of
  confirmed txs (byte-identical to the node/mobile light-client verify).

## Why it is credible (methodology)
- Real path: identical to what a wallet uses; the node enforces `from ==
  eon(dilithium_public_key)` + a valid ML-DSA-65 signature. No special mode.
- Real n-f Checkpoint-BFT finality: hard finality is read from the macroblock
  `qc.signers >= 2f+1` over its committee — not a heuristic.
- Load is generated **off the validators**.
- Accounts are pre-funded at genesis (standard for a benchmark), deterministically
  derived; the harness holds each signing key.

## Key constraints (shape the run)
- **Nonce is checked against committed state → 1 in-flight tx per account per
  committed block.** So included/finalized TPS ≈ `funded_accounts × blocks_per_second`.
  To target X TPS, pre-fund ≳ X accounts.
- Gas floor `gas_price >= 10`; Dilithium transactions pay a ×1.5 fee.
- `/transaction` per-IP rate limit is 100/60s, **but `127.0.0.1` bypasses it** —
  run the client ON a node (localhost), or whitelist its IP via
  `QNET_WHITELIST_IPS`, or raise `QNET_API_RATE_LIMIT`.

## Setup (all edits; deploy only on explicit command)
1. **Genesis pre-fund** — set on every node before a fresh-genesis relaunch
   (funding only applies at height 0):
   - `QNET_LOADTEST_ACCOUNTS=<N>`         e.g. `5000`
   - `QNET_LOADTEST_BALANCE_QNC=<QNC>`    default `1000`
   - `QNET_LOADTEST_ALLOW=1`              REQUIRED second opt-in — the prefund is
     refused (loud WARN, genesis stays empty) without it. These accounts' keys are
     public, so their balances are drainable: never set this on a value-bearing genesis.
2. **Build**: `cargo build --release -p qnet-loadtest` → `target/release/qnet-loadtest`
3. **P3b proofs** additionally require the `logs_root` / `/logs/proof` code deployed.

## Run
```
qnet-loadtest \
  --nodes http://127.0.0.1:8001[,http://<peer-ip>:8001,...] \
  --accounts 5000 \          # MUST equal QNET_LOADTEST_ACCOUNTS
  --target-tps 0 \           # 0 = as fast as free accounts allow
  --duration 120 \
  --amount 1 --gas-price 10 --gas-limit 10000 \
  --concurrency 256 \        # max in-flight submits; bounds node-side sockets
  --stale-secs 30 \          # un-included this long => treat as dropped, reclaim
  --proof-sample 20 \        # P3b (needs logs_root deployed); 0 to skip
  --out loadtest_report.json
```
For distributed ingress, pass all node RPCs to `--nodes` (submissions round-robin).
Run on a genesis node so localhost bypasses the rate limit; for a fully
off-validator ceiling, run on a separate box and whitelist its IP.

**Raise the node's file-descriptor limit before loading it.** Docker defaults to
`nofile=1024`; under submit load RocksDB runs out of descriptors, block writes fail
(`put_batch failed: Too many open files`) and the node forks off the chain. Set it
once per host in `/etc/docker/daemon.json` so it survives restarts:
```json
{ "default-ulimits": { "nofile": { "Name": "nofile", "Soft": 524288, "Hard": 524288 } } }
```
then `systemctl restart docker`. Verify: `grep "Max open files" /proc/$(docker inspect -f '{{.State.Pid}}' <container>)/limits`.

## Output
A human summary plus `loadtest_report.json`: throughput (submitted / confirmed /
TPS / success%), inclusion & hard-finality latency percentiles, and P3b proof results.

## P3a — validator resource telemetry (capture during the run)
Resource utilisation proves whether the ceiling is CPU/IO/network bound. Run this on
each node (or over SSH) for the duration of the test and keep the CSV alongside the report:
```
# per-node: sample container CPU/mem every 2s while the load runs
CID=$(docker ps --format '{{.Names}}' | grep -i qnet | head -1)
while true; do echo "$(date -u +%H:%M:%S),$(docker stats --no-stream --format '{{.CPUPerc}},{{.MemPerc}}' "$CID")"; sleep 2; done > telemetry_$(hostname).csv
```
Report peak/mean CPU% next to the confirmed-TPS number: if CPU is saturated the ceiling
is CPU-bound; if not, it is consensus/network-bound.

## Honest caveats (disclose in any published result)
- Hard-finality latency is an **upper bound** (sampled at first-observed-final;
  includes tracker poll lag). A run whose `finalized` count is 0 means the chain
  was not sealing macroblocks — report it as a failed run, never as a TPS result.
- Confirmed TPS is capped by `funded_accounts × block_rate` — fund enough accounts.
- If the client runs on the validators, signing shares node CPU (state where it ran).
- Network is single-shard in the current configuration.
