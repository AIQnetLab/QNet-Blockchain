#!/usr/bin/env bash
# Public HTTPS for a genesis node's RPC: a Caddy terminator on 443 in front of the node's :8001, with a
# Let's Encrypt certificate for the node's name that Caddy obtains and renews by itself. The node
# container is untouched; the app and the explorer reach the node by name instead of by address.
#
#   ./node-tls.sh                # all five
#   ./node-tls.sh 002 005        # only these
#
# Idempotent: rerunning replaces the terminator with the same configuration. The node's A record
# (node1.aiqnet.io → its address) must already be live — ACME validates over ports 80/443 of that name,
# and the check below refuses to start a terminator the name does not point at.
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
declare -A NODE_IP=(
  [001]=154.38.160.39 [002]=62.171.157.44 [003]=161.97.86.81
  [004]=5.189.130.160 [005]=162.244.25.114
)
declare -A NODE_HOST=(
  [001]=node1.aiqnet.io [002]=node2.aiqnet.io [003]=node3.aiqnet.io
  [004]=node4.aiqnet.io [005]=node5.aiqnet.io
)
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(001 002 003 004 005)

failed=0
for id in "${TARGETS[@]}"; do
  ip="${NODE_IP[$id]:-}"; host="${NODE_HOST[$id]:-}"
  [ -n "$ip" ] || { echo "unknown node $id"; failed=1; continue; }
  echo "== $id  $host  ($ip)"
  ssh -i "$SSH_KEY" -p 2222 -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$ip" \
      "bash -s -- '$host' '$ip'" <<'REMOTE' || failed=1
set -euo pipefail
HOST="$1"; IP="$2"

# The name has to resolve here, or ACME fails and the terminator answers nothing.
resolved=$(getent ahostsv4 "$HOST" | awk '{print $1}' | head -1 || true)
if [ "$resolved" != "$IP" ]; then
  echo "   $HOST resolves to '${resolved:-nothing}', expected $IP — fix DNS first"; exit 1
fi

mkdir -p /root/qnet-tls
cat > /root/qnet-tls/Caddyfile <<EOF
$HOST {
    reverse_proxy 127.0.0.1:8001
}
EOF

ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
docker pull -q caddy:2 >/dev/null
docker rm -f qnet-tls >/dev/null 2>&1 || true
docker run -d --name qnet-tls --network host --restart unless-stopped \
  -v /root/qnet-tls/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v qnet_tls_data:/data -v qnet_tls_config:/config \
  caddy:2 >/dev/null

# Certificate issuance takes a few seconds; the node behind it must answer through the name.
for _ in $(seq 1 45); do
  if h=$(curl -fsS -m 5 "https://$HOST/api/v1/height" 2>/dev/null); then
    echo "   https://$HOST  OK  $h"; exit 0
  fi
  sleep 2
done
echo "   https://$HOST did not come up; Caddy says:"; docker logs --tail 20 qnet-tls 2>&1 | sed 's/^/   /'
exit 1
REMOTE
done
exit $failed
