# Command-line tool

This document describes the small Python tool in `applications/qnet-cli`: a thin HTTP client that
prints node, wallet, reward and network information fetched from a QNet node. For client development
use the [SDK](../developers/sdk.md) or the [RPC API](../developers/rpc-api.md) directly.

## Layout

| File | Description |
| --- | --- |
| `qnet_cli.py` | The main tool, built on `click` |
| `qnet_cli_simple.py` | A standalone variant using only the standard library (`urllib`), no dependencies |
| `setup.py` | Packaging metadata and the `qnet-cli` console-script entry point |
| `README.md` | The tool's own usage notes |

Requirements are Python 3.8 or newer plus `click >= 8.0.0` and `requests >= 2.25.0` for the main
tool. The simple variant needs neither.

## Configuration

`qnet_cli.py` keeps state in `~/.qnet/cli_config.json`, holding the node URL and the path to the
wallet file. The default node URL is `http://localhost:5000`. A node serves its unified API on TCP
port 8001, so pass `--node-url` on the top-level command; the value is persisted:

```bash
python qnet_cli.py --node-url http://127.0.0.1:8001 node status
```

`qnet_cli_simple.py` carries the same default node URL in the script itself; edit it there, or use
the main tool.

## Commands

Invoke as `python qnet_cli.py <group> <command>`, or as `qnet-cli <group> <command>` if the console
script is installed. Each read command issues one request against the configured node URL and prints
the response.

| Command | Request | Output |
| --- | --- | --- |
| `node status` | `GET /api/node/status` | Node id, type, address, height, peer count and any regional information |
| `wallet balance` | `GET /api/balance/{address}` | Balance for the address in the configured wallet file |
| `network peers` | `GET /api/peers` | Peer id, address and region |
| `network stats` | `GET /api/network/stats` | The network summary the node returns, including per-region node counts |
| `version` | — | The tool version |

`qnet_cli_simple.py` covers the same `node`, `wallet` and `network` reads plus `version` and `help`,
over `urllib` instead of `requests`.

Operations that need a key — sending QNC, claiming rewards — are authorised by ML-DSA-65 signatures
from the wallet key: one over `claim_rewards:{node_id}:{wallet_address}` and one over the payload the
node quotes back. Perform them in the [mobile wallet](mobile-wallet.md) or through the SDK with a
signer.

## Running it

```bash
cd applications/qnet-cli
pip install click requests
python qnet_cli.py --node-url http://<node-host>:8001 node status
```

Or, with no dependencies at all:

```bash
python qnet_cli_simple.py node status
```

Substitute an operator-supplied node host; nothing here ships with a node address baked in beyond the
localhost default.

## Related documents

- [RPC API](../developers/rpc-api.md) — the node's HTTP and JSON-RPC surface.
- [SDK](../developers/sdk.md) — the maintained client library.
- [Running a node](../operators/running-a-node.md) — node lifecycle.
- [Mobile wallet](mobile-wallet.md) — where key-holding operations such as reward claims are done.
