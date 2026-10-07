#!/usr/bin/env bash
# Deploys the device oracle: a primary and a warm standby, each in its own container on its own host,
# reachable only from the five genesis hosts (and the standby) over mutual TLS. The oracle terminates
# TLS itself, so no proxy sits in front of it and no layer can log a request body.
#
# The oracle hosts are configuration, not code:
#   ORACLE_PRIMARY=<ip> ORACLE_STANDBY=<ip> NETWORK=testnet ./deploy-oracle.sh <step>
#
# Steps, in order for a first deploy:
#   pki           local: private CA, a server certificate per oracle host, client certificates for the five
#                 genesis nodes, the support operator and the standby. Kept in ORACLE_PKI_DIR, never the repo.
#   install       hosts: directories, firewall, certificates, config
#   keys          primary: the oracle signing key and the evidence key, copied to the standby; prints the
#                 public key the node binary pins
#   secrets-check hosts: every vendor secret the owner placed is present, owned by the oracle user, mode 0400
#   up            hosts: (re)create the containers, primary first; health through mutual TLS
#   client-certs  genesis hosts: the client certificate each genesis node presents to the oracle
#   status        health of both oracles, asked from a genesis host with its own client certificate
#   check-logs    fail if an oracle log line carries anything token-shaped
#   promote       make the standby the primary and stop the old primary
#
# Platforms (the app identities, signing digests and the Apple receipt root live in qnet-device-attest):
#   APPLE_KEY_ID=<id>   switch iOS on: the key id of the DeviceCheck key the owner places as devicecheck.p8
#   ANDROID=1           switch Android on: the owner places the Play Integrity keys and the service account
#   ALERT_COMMAND       optional: executable called on every alert; it must live under /etc/qnet-oracle,
#                       the only host directory the container sees
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STEP="${1:-}"
IMAGE="${ORACLE_IMAGE:-ghcr.io/aiqnetlab/qnet-device-oracle:latest}"
CONTAINER="qnet-device-oracle"
PORT="${ORACLE_PORT:-8740}"
NETWORK="${NETWORK:-testnet}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
ORACLE_SSH_PORT="${ORACLE_SSH_PORT:-22}"
PKI="${ORACLE_PKI_DIR:-$HOME/.qnet-oracle-pki}"
ETC=/etc/qnet-oracle
DATA=/var/lib/qnet-oracle
UID_ORACLE=10001
# IMAGE is what .github/workflows/oracle-image.yml publishes (ORACLE_IMAGE=...:<commit> pins one).
# BUILD_LOCAL=1 builds it from this checkout and ships it with docker save/load instead of pulling.
BUILD_LOCAL="${BUILD_LOCAL:-}"

case "$NETWORK" in testnet|mainnet) ;; *) echo "[ERR] NETWORK must be testnet or mainnet"; exit 1;; esac
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "[ERR] ORACLE_PORT must be a number"; exit 1; }

# The genesis hosts come from the genesis roll script, so there is one list of them.
eval "$(sed -n '/^declare -A NODE_IP=(/,/^)/p' "$REPO/scripts/deploy-genesis.sh")"
eval "$(sed -n '/^declare -A NODE_PORT=/p' "$REPO/scripts/deploy-genesis.sh")"
GENESIS=(001 002 003 004 005)
GENESIS_SSH_PORT="${SSH_PORT:-2222}"
gport() { echo "${NODE_PORT[$1]:-$GENESIS_SSH_PORT}"; }
for g in "${GENESIS[@]}"; do [ -n "${NODE_IP[$g]:-}" ] || { echo "[ERR] genesis $g missing from deploy-genesis.sh"; exit 1; }; done

need_hosts() {
  [ -n "${ORACLE_PRIMARY:-}" ] && [ -n "${ORACLE_STANDBY:-}" ] || { echo "[ERR] set ORACLE_PRIMARY and ORACLE_STANDBY"; exit 1; }
  for h in "$ORACLE_PRIMARY" "$ORACLE_STANDBY"; do
    [[ "$h" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "[ERR] oracle hosts are IPv4 addresses: $h"; exit 1; }
  done
  [ "$ORACLE_PRIMARY" != "$ORACLE_STANDBY" ] || { echo "[ERR] primary and standby must be different hosts"; exit 1; }
}
osh() { ssh -i "$SSH_KEY" -p "$ORACLE_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$1" "$2"; }
gsh() { ssh -i "$SSH_KEY" -p "$(gport "$1")" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@${NODE_IP[$1]}" "$2"; }
# Copies a local file to a host path with an owner and mode, without the content ever touching argv.
put() { # host src dst mode owner
  osh "$1" "install -d -m 0750 \"\$(dirname $3)\" && umask 077 && cat > $3.tmp && chmod $4 $3.tmp && chown $5 $3.tmp && mv $3.tmp $3" < "$2"
}
cert_sha() { openssl x509 -in "$1" -outform der | sha256sum | cut -d' ' -f1; }

step_pki() {
  need_hosts
  command -v openssl >/dev/null || { echo "[ERR] openssl is required"; exit 1; }
  install -d -m 0700 "$PKI"
  if [ ! -f "$PKI/ca.key" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$PKI/ca.key"
    openssl req -x509 -new -key "$PKI/ca.key" -sha256 -days 3650 -subj "/CN=QNet oracle CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$PKI/ca.crt"
    chmod 0400 "$PKI/ca.key"
    echo "  CA created in $PKI"
  fi
  issue() { # name eku san
    local n="$1"
    [ -f "$PKI/$n.crt" ] && return 0
    openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$PKI/$n.key"
    chmod 0400 "$PKI/$n.key"
    openssl req -new -key "$PKI/$n.key" -subj "/CN=$n" -out "$PKI/$n.csr"
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\n%s\n' "$2" "$3" > "$PKI/$n.ext"
    openssl x509 -req -in "$PKI/$n.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" -CAcreateserial -days 825 -sha256 \
      -extfile "$PKI/$n.ext" -out "$PKI/$n.crt" 2>/dev/null
    rm -f "$PKI/$n.csr" "$PKI/$n.ext"
    echo "  issued $n"
  }
  # Named by address, not by role: after a promotion each host keeps the certificate that names its own address.
  issue "oracle-$ORACLE_PRIMARY" serverAuth "subjectAltName=IP:$ORACLE_PRIMARY,DNS:qnet-oracle"
  issue "oracle-$ORACLE_STANDBY" serverAuth "subjectAltName=IP:$ORACLE_STANDBY,DNS:qnet-oracle"
  for g in "${GENESIS[@]}"; do issue "genesis-$g" clientAuth ""; done
  issue support clientAuth ""
  issue standby-replica clientAuth ""
  echo "=== client certificate digests (the oracle config lists these) ==="
  for n in "${GENESIS[@]/#/genesis-}" support standby-replica; do echo "  $n $(cert_sha "$PKI/$n.crt")"; done
}

# The oracle config for one host; only platforms whose owner values are set are switched on.
render_config() { # role self_ip
  local role="$1" clients="" first=1 apple="" google="" replica="" alerts=""
  for g in "${GENESIS[@]}"; do
    clients+="$([ $first = 1 ] || echo ,){\"name\":\"genesis-$g\",\"role\":\"genesis\",\"sha256\":\"$(cert_sha "$PKI/genesis-$g.crt")\"}"
    first=0
  done
  clients+=",{\"name\":\"support\",\"role\":\"support\",\"sha256\":\"$(cert_sha "$PKI/support.crt")\"}"
  clients+=",{\"name\":\"standby\",\"role\":\"replica\",\"sha256\":\"$(cert_sha "$PKI/standby-replica.crt")\"}"
  if [ -n "${APPLE_KEY_ID:-}" ]; then
    [[ "$APPLE_KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "[ERR] APPLE_KEY_ID is a 10-character key id" >&2; exit 1; }
    apple=",\"apple\":{\"key\":\"$ETC/secrets/devicecheck.p8\",\"key_id\":\"$APPLE_KEY_ID\"}"
  fi
  if [ -n "${ANDROID:-}" ]; then
    google=",\"google\":{\"decryption_key\":\"$ETC/secrets/play_decryption.key\",\"verification_key\":\"$ETC/secrets/play_verification.key\",\"service_account\":\"$ETC/secrets/service_account.json\"}"
  fi
  if [ "$role" = standby ]; then
    replica=",\"replica\":{\"primary_url\":\"https://$ORACLE_PRIMARY:$PORT\",\"cert\":\"$ETC/tls/replica.crt\",\"key\":\"$ETC/tls/replica.key\",\"server_ca\":\"$ETC/tls/ca.crt\"}"
  fi
  if [ -n "${ALERT_COMMAND:-}" ]; then
    [[ "$ALERT_COMMAND" =~ ^$ETC/[A-Za-z0-9_./-]+$ ]] || { echo "[ERR] ALERT_COMMAND must be a path under $ETC" >&2; exit 1; }
    alerts=",\"alerts\":{\"command\":\"$ALERT_COMMAND\"}"
  fi
  cat <<EOF
{"network":"$NETWORK","role":"$role","listen":"0.0.0.0:$PORT","data_dir":"$DATA",
 "tls":{"cert":"$ETC/tls/server.crt","key":"$ETC/tls/server.key","client_ca":"$ETC/tls/ca.crt"},
 "clients":[$clients],
 "secrets":{"oracle_key":"$ETC/secrets/oracle.key","evidence_key":"$ETC/secrets/evidence.key","alert_webhook":ALERT_WEBHOOK}$apple$google$replica$alerts}
EOF
}

install_host() { # ip role
  local ip="$1" role="$2" tmp
  echo "=== install $role ($ip) ==="
  [ -f "$PKI/oracle-$ip.crt" ] || { echo "[ERR] no server certificate for $ip: run the pki step"; return 1; }
  osh "$ip" "id -u $UID_ORACLE >/dev/null 2>&1 || useradd -u $UID_ORACLE -M -s /usr/sbin/nologin qnet-oracle
    install -d -m 0750 -o $UID_ORACLE -g $UID_ORACLE $ETC $ETC/tls $DATA
    install -d -m 0500 -o $UID_ORACLE -g $UID_ORACLE $ETC/secrets" || return 1
  put "$ip" "$PKI/ca.crt" "$ETC/tls/ca.crt" 0444 "$UID_ORACLE:$UID_ORACLE"
  put "$ip" "$PKI/oracle-$ip.crt" "$ETC/tls/server.crt" 0444 "$UID_ORACLE:$UID_ORACLE"
  put "$ip" "$PKI/oracle-$ip.key" "$ETC/tls/server.key" 0400 "$UID_ORACLE:$UID_ORACLE"
  if [ "$role" = standby ]; then
    put "$ip" "$PKI/standby-replica.crt" "$ETC/tls/replica.crt" 0444 "$UID_ORACLE:$UID_ORACLE"
    put "$ip" "$PKI/standby-replica.key" "$ETC/tls/replica.key" 0400 "$UID_ORACLE:$UID_ORACLE"
  fi
  tmp=$(mktemp); render_config "$role" > "$tmp"
  put "$ip" "$tmp" "$ETC/oracle.json.template" 0440 "$UID_ORACLE:$UID_ORACLE"; rm -f "$tmp"
  # The webhook entry is filled on the host: present only when the owner placed the file.
  osh "$ip" "if [ -f $ETC/secrets/alert_webhook.url ]; then w='\"$ETC/secrets/alert_webhook.url\"'; else w=null; fi
    sed \"s|ALERT_WEBHOOK|\$w|\" $ETC/oracle.json.template > $ETC/oracle.json && chown $UID_ORACLE:$UID_ORACLE $ETC/oracle.json && chmod 0440 $ETC/oracle.json"
  # Firewall: the oracle port is open to the five genesis hosts (and the standby, for replication) only.
  # The container uses the host network, so these INPUT rules apply to it directly. ufw takes the first rule
  # that matches: each allow goes to the top (re-added, so one an earlier run left under the deny moves up), an
  # allow on the port from an address no longer listed goes, and the deny stays once below them.
  local allow="${NODE_IP[001]} ${NODE_IP[002]} ${NODE_IP[003]} ${NODE_IP[004]} ${NODE_IP[005]}"
  [ "$role" = primary ] && allow="$allow $ORACLE_STANDBY"
  osh "$ip" "command -v ufw >/dev/null || { echo '[ERR] ufw is required on the oracle host'; exit 1; }
    for a in $allow; do
      ufw --force delete allow from \$a to any port $PORT proto tcp >/dev/null 2>&1
      if ufw status numbered | grep -q '^\[ *1\]'; then ufw insert 1 allow from \$a to any port $PORT proto tcp >/dev/null
      else ufw allow from \$a to any port $PORT proto tcp >/dev/null; fi
    done
    for n in \$(ufw status numbered | awk -v p='$PORT/tcp' -v keep=' $allow ' '{ gsub(/[][]/, \" \") }
        \$2 == p && \$3 == \"ALLOW\" && \$4 == \"IN\" && index(keep, \" \" \$5 \" \") == 0 { print \$1 }' | sort -rn); do
      ufw --force delete \$n >/dev/null
    done
    ufw deny $PORT/tcp >/dev/null
    ufw status | grep -q 'Status: active' || echo '[WARN] ufw is installed but not active: the oracle port is not restricted'" || return 1
  echo "  installed"
}

step_install() {
  need_hosts
  [ -f "$PKI/ca.crt" ] || { echo "[ERR] run the pki step first"; exit 1; }
  install_host "$ORACLE_PRIMARY" primary || exit 1
  install_host "$ORACLE_STANDBY" standby || exit 1
}

run_image() { # ip args...
  local ip="$1"; shift
  osh "$ip" "docker run --rm --network none --user $UID_ORACLE:$UID_ORACLE -v $ETC/secrets:$ETC/secrets $IMAGE $*"
}

step_keys() {
  need_hosts
  ship_image "$ORACLE_PRIMARY"
  if osh "$ORACLE_PRIMARY" "test -f $ETC/secrets/oracle.key"; then
    echo "  oracle key already present on the primary: kept"
  else
    osh "$ORACLE_PRIMARY" "chmod 0700 $ETC/secrets" && run_image "$ORACLE_PRIMARY" keygen --out "$ETC/secrets/oracle.key" \
      && osh "$ORACLE_PRIMARY" "chmod 0500 $ETC/secrets" || { echo "[ERR] keygen failed"; exit 1; }
  fi
  if ! osh "$ORACLE_PRIMARY" "test -f $ETC/secrets/evidence.key"; then
    osh "$ORACLE_PRIMARY" "chmod 0700 $ETC/secrets" && run_image "$ORACLE_PRIMARY" evidence-key --out "$ETC/secrets/evidence.key" \
      && osh "$ORACLE_PRIMARY" "chmod 0500 $ETC/secrets" || { echo "[ERR] evidence key failed"; exit 1; }
  fi
  # The standby signs with the same key after a promotion and opens the evidence it replicated, so both
  # keys are copied host to host through this pipe; they are never written on this machine.
  for f in oracle.key evidence.key; do
    osh "$ORACLE_PRIMARY" "cat $ETC/secrets/$f" | osh "$ORACLE_STANDBY" "chmod 0700 $ETC/secrets && umask 077 && cat > $ETC/secrets/$f.tmp &&
      chown $UID_ORACLE:$UID_ORACLE $ETC/secrets/$f.tmp && chmod 0400 $ETC/secrets/$f.tmp && mv $ETC/secrets/$f.tmp $ETC/secrets/$f && chmod 0500 $ETC/secrets" \
      || { echo "[ERR] copying $f to the standby failed"; exit 1; }
  done
  echo "=== the public key the node binary pins ==="
  run_image "$ORACLE_PRIMARY" pubkey --key "$ETC/secrets/oracle.key"
}

step_secrets_check() {
  need_hosts
  local wanted="oracle.key evidence.key"
  [ -n "${APPLE_KEY_ID:-}" ] && wanted="$wanted devicecheck.p8"
  [ -n "${ANDROID:-}" ] && wanted="$wanted play_decryption.key play_verification.key service_account.json"
  local bad=0
  for ip in "$ORACLE_PRIMARY" "$ORACLE_STANDBY"; do
    for f in $wanted; do
      # Only the name, owner and mode are read; the content is never printed.
      r=$(osh "$ip" "stat -c '%U:%a' $ETC/secrets/$f 2>/dev/null || echo missing")
      case "$r" in
        "qnet-oracle:400"|"$UID_ORACLE:400") echo "  $ip $f ok" ;;
        missing) echo "  [ERR] $ip $f is missing"; bad=1 ;;
        *) echo "  [ERR] $ip $f is $r (want qnet-oracle:400)"; bad=1 ;;
      esac
    done
  done
  [ $bad = 0 ] || exit 1
}

ship_image() { # ip
  if [ -n "$BUILD_LOCAL" ]; then
    if [ -z "${SHIPPED_BUILT:-}" ]; then
      docker build -f "$REPO/development/qnet-device-oracle/Dockerfile" \
        --build-arg QNET_BUILD_ID="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unstamped)" -t "$IMAGE" "$REPO" || exit 1
      SHIPPED_BUILT=1
    fi
    docker save "$IMAGE" | osh "$1" "docker load -q" >/dev/null || { echo "[ERR] image transfer to $1 failed"; exit 1; }
  else
    osh "$1" "docker pull -q $IMAGE >/dev/null" || { echo "[ERR] pull failed on $1"; exit 1; }
  fi
}

up_host() { # ip name
  local ip="$1" name="$2"
  echo "=== up $name ($ip) ==="
  ship_image "$ip"
  osh "$ip" "docker rm -f $CONTAINER >/dev/null 2>&1; chown -R $UID_ORACLE:$UID_ORACLE $DATA
    docker run -d --name $CONTAINER --restart unless-stopped --network host --read-only --tmpfs /tmp \
      --cap-drop ALL --security-opt no-new-privileges --user $UID_ORACLE:$UID_ORACLE \
      -v $DATA:$DATA -v $ETC:$ETC:ro -e QNET_LOG_LEVEL=3 -e HOSTNAME=$name \
      --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
      $IMAGE run --config $ETC/oracle.json >/dev/null" || return 1
  sleep 3
  osh "$ip" "docker logs --tail 20 $CONTAINER 2>&1 | grep -E '\\[(WARN|ERROR)\\]\\[BOOT\\]|^[a-z].*: ' | tail -5"
  osh "$ip" "docker inspect -f '{{.State.Running}}' $CONTAINER" | grep -q true || { echo "  [ERR] $name is not running"; return 1; }
}

step_up() {
  need_hosts
  up_host "$ORACLE_PRIMARY" oracle-primary || exit 1
  up_host "$ORACLE_STANDBY" oracle-standby || exit 1
  step_status
}

step_client_certs() {
  [ -f "$PKI/ca.crt" ] || { echo "[ERR] run the pki step first"; exit 1; }
  for g in "${GENESIS[@]}"; do
    echo "=== genesis $g ==="
    gsh "$g" "install -d -m 0700 /opt/qnet-oracle-client" || exit 1
    for f in ca.crt "genesis-$g.crt" "genesis-$g.key"; do
      dst="/opt/qnet-oracle-client/${f/genesis-$g/client}"
      gsh "$g" "umask 077 && cat > $dst && chmod 0400 $dst" < "$PKI/$f" || exit 1
    done
    echo "  /opt/qnet-oracle-client/{ca.crt,client.crt,client.key}"
  done
}

step_status() {
  need_hosts
  for ip in "$ORACLE_PRIMARY" "$ORACLE_STANDBY"; do
    r=$(gsh 005 "curl -sS -m 10 --cacert /opt/qnet-oracle-client/ca.crt --cert /opt/qnet-oracle-client/client.crt \
      --key /opt/qnet-oracle-client/client.key https://$ip:$PORT/v1/health" 2>&1)
    echo "  $ip $r"
  done
}

step_check_logs() {
  need_hosts
  # Tokens and receipts are long base64 runs or five-part envelopes; a log line never carries either.
  local pattern='[A-Za-z0-9_-]{120,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'
  local bad=0
  for ip in "$ORACLE_PRIMARY" "$ORACLE_STANDBY"; do
    n=$(osh "$ip" "docker logs $CONTAINER 2>&1 | grep -cE '$pattern'")
    if [ "${n:-0}" != 0 ]; then echo "  [ERR] $ip: $n log lines look like they carry a token"; bad=1; else echo "  $ip clean"; fi
  done
  [ $bad = 0 ] || exit 1
}

step_promote() {
  need_hosts
  echo "=== stopping the old primary ($ORACLE_PRIMARY) if it answers ==="
  osh "$ORACLE_PRIMARY" "docker stop $CONTAINER >/dev/null 2>&1; docker update --restart no $CONTAINER >/dev/null 2>&1" \
    || echo "  [WARN] old primary unreachable: make sure it cannot come back as a primary"
  echo "=== promoting the standby ($ORACLE_STANDBY) ==="
  osh "$ORACLE_STANDBY" "sed -i 's/\"role\":\"standby\"/\"role\":\"primary\"/' $ETC/oracle.json $ETC/oracle.json.template && docker restart $CONTAINER >/dev/null" \
    || { echo "[ERR] promotion failed"; exit 1; }
  echo "  done: rerun with ORACLE_PRIMARY=$ORACLE_STANDBY ORACLE_STANDBY=<new standby> for pki/install/up"
}

case "$STEP" in
  pki) step_pki ;;
  install) step_install ;;
  keys) step_keys ;;
  secrets-check) step_secrets_check ;;
  up) step_up ;;
  client-certs) step_client_certs ;;
  status) step_status ;;
  check-logs) step_check_logs ;;
  promote) step_promote ;;
  *) sed -n '2,/^set -uo/{/^#/p}' "$0"; exit 1 ;;
esac
