# Genesis host checks before a roll

Checks for the five genesis hosts (001 to 005) and the super-node host 006, to run before the roll that carries
the light-node binding, push, unbind and "I'm back" routes. Every command in sections 1 to 3 only reads. Where
a check fails, the change to make is written out and left to the operator; section 4 prints a number and
changes nothing either.

| Host | Address | SSH | Node container | TLS terminator |
| --- | --- | --- | --- | --- |
| 001 | 154.38.160.39 | `-p 2222` | `qnet-genesis-001` | `qnet-tls`, `node1.aiqnet.io` |
| 002 | 62.171.157.44 | `-p 2222` | `qnet-genesis-002` | `qnet-tls`, `node2.aiqnet.io` |
| 003 | 161.97.86.81 | `-p 2222` | `qnet-genesis-003` | `qnet-tls`, `node3.aiqnet.io` |
| 004 | 5.189.130.160 | `-p 2222` | `qnet-genesis-004` | `qnet-tls`, `node4.aiqnet.io` |
| 005 | 162.244.25.114 | `-p 2222` | `qnet-genesis-005` | `qnet-tls`, `node5.aiqnet.io` |
| 006 | 62.171.138.98 | `-p 22` | `qnet-super-node` | none (no public name) |

`ssh -i ~/.ssh/qnet_server -p <port> root@<address>`. Below, `N` is the host's number (1 to 5) and `00N` its id.

## 1. The TLS terminator passes the client on

The node takes the client of an HTTPS request from the last `X-Forwarded-For` entry, which the terminator
(`scripts/node-tls.sh`) appends, but only when the request reaches it from 127.0.0.1; from any other peer it
takes the socket address. Three things depend on that:

- the per-address limits: without it every HTTPS client is 127.0.0.1, which the limiter never limits;
- the burn attestor (`node_attestBurn`): a committee member's address gets that member's share of the
  committee quota. The node asks its own attestor in-process, so loopback earns nothing there;
- the internal genesis routes (push tokens, bindings, unbinds, device records): they answer the genesis
  addresses only and refuse loopback. Genesis nodes call them over TLS at the genesis HTTPS names; a call
  retries on the plain port only after the connection to 443 could not be made or timed out, or after a 403
  over TLS (a terminator that passed no client), never after a TLS or certificate error, and logs
  `[WARN][LIGHT] genesis_internal_downgrade`. The device-layer routes (`/internal/light-device-attest`,
  `-sync`, `-get`) and the pulls whose answer the caller applies (`/internal/fcm-token-get`,
  `/internal/light-ping-keys-get`) never retry in plain HTTP: while a genesis's terminator is down or passes
  no client, device sync and heals to that genesis stop and retry until it is back. A pulled push record
  stamped more than 300 s in the future is refused.

The terminator must write the entry itself. One that passes the client's own `X-Forwarded-For` through lets
any caller name its address: a genesis address opens the internal routes (reading and redirecting push
tokens) and the attestor's committee quota. The node takes an entry that names this host (127.0.0.1, ::1,
0.0.0.0) or is no address as nobody in particular, but it cannot tell a forged genesis address from a real
one, so the forged-header probe below decides.

On each genesis host:

```
# The terminator's configuration: exactly the block node-tls.sh writes, a bare reverse_proxy with no
# header_up that removes or rewrites X-Forwarded-For and no trusted_proxies.
docker exec qnet-tls cat /etc/caddy/Caddyfile

# How the terminator reaches the node. The terminator runs on the host network and dials 127.0.0.1:8001;
# the node container publishes :8001 from its own network. Which peer address the node then sees depends on
# the Docker proxy path, so the end-to-end check below decides.
docker inspect -f '{{.Name}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' qnet-tls qnet-genesis-00N
```

End to end, from a machine that is not a genesis host and not the explorer server:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://nodeN.aiqnet.io/api/v1/internal/fcm-token-sync" \
  -H 'Content-Type: application/json' -d '{"pseudonym":"x","token":"x","push_type":"fcm","origin_ip":"x"}'
```

It must answer `403`. Then on the host:

```
docker logs --since 5m qnet-genesis-00N 2>&1 | grep fcm_sync_rejected_unauthorized | tail -1
```

The line must name `caller=` your own public address.

- `caller=127.0.0.1`: the terminator appends no header. Rewrite its configuration to the plain block by
  rerunning `./scripts/node-tls.sh 00N` from the repository (it recreates only the `qnet-tls` container).
- `caller=172.…` (the Docker bridge gateway) or another private address: the node does not see the terminator
  as loopback, so it ignores the header. Every HTTPS client then shares that one address in every per-address
  limit (device answers included), and a private address passes the node's internal-caller checks. Do not roll;
  report the host: the fix (the node trusting the header from its own bridge gateway, or the terminator sharing
  the node container's network) is a decision, not a host edit.

Then the same request with a forged header, naming another genesis and then this host:

```
G=154.38.160.39   # 62.171.157.44 when probing node1
for forged in "$G" 127.0.0.1; do
  curl -s -o /dev/null -w "$forged %{http_code}\n" -X POST "https://nodeN.aiqnet.io/api/v1/internal/fcm-token-sync" \
    -H 'Content-Type: application/json' -H "X-Forwarded-For: $forged" \
    -d '{"pseudonym":"x","token":"x","push_type":"fcm","origin_ip":"x"}'
done
docker logs --since 5m qnet-genesis-00N 2>&1 | grep fcm_sync_rejected_unauthorized | tail -2
```

Both must answer `403`, and both log lines must name `caller=` your own public address again.

- Any other status (`400`, `200`), or a line naming the forged genesis address: the terminator passes the
  client's header on, and anyone can pose as a genesis. Do not roll; rerun `./scripts/node-tls.sh 00N` and probe
  again.
- A line naming `caller=0.0.0.0` for the second request: the same fault; the node refused to believe the forged
  loopback entry, but the first request's line decides.

006 has no terminator: `docker ps --format '{{.Names}}' | grep -c qnet-tls` prints 0 there.

## 2. No request bodies or push tokens in logs

Bodies of `/light-node/bind`, the token refresh and the internal sync carry push tokens, and the device layer
will add device evidence. Neither the terminator nor the node may write them to a log.

```
# The terminator writes no access log unless its configuration has a `log` directive, and never logs bodies.
docker exec qnet-tls grep -n 'log' /etc/caddy/Caddyfile || echo "no log directive"

# The node prints no token. The previous binary printed the first 8 characters of each push token
# ("Sending FCM push ... (token: xxxxxxxx...)"); this build prints none, and the check below must stay empty
# for log lines written after the roll.
docker logs --since 1h qnet-genesis-00N 2>&1 | grep -E 'token: [A-Za-z0-9_:-]{6,}|"device_token"' | head -3
```

If a `log` directive was added by hand, restore the plain block (not run by this document):

```
./scripts/node-tls.sh 00N
```

The container log keeps older lines until it rotates (`--log-opt max-size=200m --log-opt max-file=50`).

## 3. The explorer server is exempt from the node's per-address limits

The cabinet on aiqnet.io calls the nodes through the explorer server (195.246.231.53), which meters its own
clients. Listed in `QNET_WHITELIST_IPS`, it skips the node's per-address limits; the per-node limits (bind,
unbind, token refresh, the submit door's node meter, the wake cap) apply to every caller.

```
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' qnet-genesis-00N | grep '^QNET_WHITELIST_IPS=' || echo "not set"
```

The value must contain `195.246.231.53`. If it is missing, set it at the roll (not run by this document):

```
QNET_SET_ENV=QNET_WHITELIST_IPS=195.246.231.53 ./scripts/deploy-genesis.sh 005 001 002 003 004
```

`QNET_SET_ENV` separates its entries with commas, so it carries a single address; a longer list needs the
container's environment edited by hand.

## 4. The gate height at push time

A consensus gate moved for the roll is the first epoch boundary at least 604,800 blocks (7 days) above the
fleet tip read at push time, and `deploy-genesis.sh` refuses a gate less than `GATE_MARGIN` (28,800 blocks)
above the tip when the roll starts. A gate the fleet has crossed never moves: the script also refuses to move a
gate whose old height is not `GATE_MARGIN` above the tip ("gate already crossed, its height is frozen").

```
./scripts/gate-height.sh           # reads the tip from node1..node5 over HTTPS
./scripts/gate-height.sh 2241840   # or from a tip read by hand
```

Put the printed value into `core/qnet-state/src/feature_gates.rs` (the constant and the sentence of its comment
that names the epoch and the tip), run `cargo test -p qnet-state`, build, push, and roll with
`scripts/deploy-genesis.sh`, whose gate check reads the tip again.

## 5. After the roll

```
# Every genesis lists the new forms; clients switch a form on only when two of them list it.
curl -s "https://nodeN.aiqnet.io/api/v1/light-node/status?node_id=light_mobile_0000000000000000" | jq -c .features

# Pushes go out with the new payload and find an anchor block.
docker logs --since 10m qnet-genesis-00N 2>&1 | grep -E 'push_sent|push_failed|push_anchor_unavailable' | tail -5
```

`features` includes `unbind_v2`, `unbind_wallet`, `push_v2` and `wake`. `push_anchor_unavailable` should not appear;
`push_failed` lines name the provider's reason. The public status of a registered node carries `device`.


## 6. The device layer (001 to 005)

A genesis lists `device_v1` and `hwping_v2` only when the binary pins the device oracle's public key
(`light_device::statement::ORACLE_KEYS`) and the oracle is configured on the host. Without either it lists
neither, takes a binding's device block as `check_pending` (never counted), and every installed app keeps
working as before. The client material is `/opt/qnet-oracle-client/{ca.crt,client.crt,client.key}` (or the
directory in `QNET_DEVICE_ORACLE_CLIENT_DIR`); the oracle hosts are `QNET_DEVICE_ORACLE_URLS`, `https://`,
the primary first.

```
# Configured or not, logged once at the first device request or status read.
docker logs qnet-genesis-00N 2>&1 | grep -E 'oracle_configured|oracle_not_configured' | tail -1

# The five list the same device forms: all of them both, or none of them either.
curl -s "https://nodeN.aiqnet.io/api/v1/light-node/status?node_id=light_mobile_0000000000000000" | jq -c .features

# The revocation snapshot (fetched hourly, checked every epoch) and the oracle's availability.
docker logs --since 6h qnet-genesis-00N 2>&1 | grep -E 'crl_taken|crl_refused|device_crl_stale|crl_check' | tail -5
docker logs --since 6h qnet-genesis-00N 2>&1 | grep -E 'device_oracle_unreachable|oracle_outage_over' | tail -5

# No vendor token in a log line, ever (section 2 covers the terminator).
docker logs --since 1h qnet-genesis-00N 2>&1 | grep -E 'dc_token|pi_token|attestation":|"chain":' | head -3

# The cross-owner bitmap monitor: bits one owner of a shard set alone, and the alert past the threshold.
docker logs --since 1d qnet-genesis-00N 2>&1 | grep -E 'bitmap_single_owner|light_bitmap_divergence' | tail -5
```

The token check must print nothing. `crl_refused` means a snapshot did not verify under the pinned key (a
rotated oracle key not yet in the binary, or a wrong host); `device_crl_stale` that the held snapshot is
older than seven days (it stays in use). `light_bitmap_divergence` names the owner and the epoch: compare
that owner's logs for the epoch before anything else.
