#!/usr/bin/env bash
# Fleet health digest every 30 minutes: LOGS first, metrics second.
#
# Heights and failover_count=0 do not prove the fleet is healthy — on 07.09 they read clean through
# a real mini-fork and 28 [ERR][MB] lines. So this reads the logs of every node each cycle and
# reports what CHANGED: criticals and errors in full, warning subsystems that mean something, and
# any message kind that was not there last time.
set -uo pipefail
KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
INTERVAL="${INTERVAL:-1800}"
WINDOW="${WINDOW:-31m}"
STATE=/tmp/watch-fleet.kinds

NODES=(
  "001 154.38.160.39 2222 qnet-genesis-001"
  "002 62.171.157.44 2222 qnet-genesis-002"
  "003 161.97.86.81  2222 qnet-genesis-003"
  "004 5.189.130.160 2222 qnet-genesis-004"
  "005 162.244.25.114 2222 qnet-genesis-005"
  "006 62.171.138.98 22   qnet-super-node"
)
# Warnings that are symptoms, not weather.
SYMPTOM='FORK|PROD|PIPELINE|WATCHDOG|FAILOVER|BFT2|TIMEOUT|STALL|ROLLBACK|CONS|STATE|REWARD'

while true; do
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) fleet digest (last $WINDOW) ====="
  kinds_now=""
  for n in "${NODES[@]}"; do
    set -- $n; id=$1; ip=$2; port=$3; c=$4
    out=$(timeout 45 ssh -i "$KEY" -p "$port" -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@"$ip" "
      H=\$(curl -s -m 6 http://127.0.0.1:8001/api/v1/node/health 2>/dev/null)
      echo \"HEALTH \$H\"
      echo '---CRIT---'
      docker logs $c --since $WINDOW 2>&1 | grep -E '\[(CRIT|ERR)\]' | sed 's/[0-9]\{5,\}/N/g' | sort | uniq -c | sort -rn | head -6
      echo '---SYMPTOM---'
      docker logs $c --since $WINDOW 2>&1 | grep -oE '\[WARN\]\[($SYMPTOM)[A-Z0-9_-]*\]' | sort | uniq -c | sort -rn | head -8
      echo '---KINDS---'
      docker logs $c --since $WINDOW 2>&1 | grep -oE '\[(CRIT|ERR|WARN)\]\[[A-Z0-9_-]+\]' | sort -u
    " 2>/dev/null)

    if [ -z "$out" ]; then echo "  $id  UNREACHABLE"; continue; fi

    h=$(echo "$out" | grep '^HEALTH' | grep -o '"height":[0-9]*' | head -1 | cut -d: -f2)
    st=$(echo "$out" | grep '^HEALTH' | grep -o '"sync_status":"[a-z]*"' | head -1 | cut -d'"' -f4)
    fo=$(echo "$out" | grep '^HEALTH' | grep -o '"failover_count":[0-9]*' | head -1 | cut -d: -f2)
    rd=$(echo "$out" | grep '^HEALTH' | grep -o '"max_timeout_round_seen":[0-9]*' | head -1 | cut -d: -f2)
    sd=$(echo "$out" | grep '^HEALTH' | grep -o '"max_slot_delay_secs":[0-9]*' | head -1 | cut -d: -f2)
    printf "  %s h=%-8s %-13s fo=%-4s round=%-4s slot_delay=%s\n" "$id" "${h:-?}" "${st:-?}" "${fo:-?}" "${rd:-?}" "${sd:-?}"

    crit=$(echo "$out" | sed -n '/---CRIT---/,/---SYMPTOM---/p' | grep -vE '^---' | sed '/^\s*$/d')
    [ -n "$crit" ] && echo "$crit" | sed 's/^/      ERR\/CRIT: /'
    sym=$(echo "$out" | sed -n '/---SYMPTOM---/,/---KINDS---/p' | grep -vE '^---' | sed '/^\s*$/d' | tr -s ' ' | tr '\n' ' ')
    [ -n "$sym" ] && echo "      symptoms: $sym"
    kinds_now="$kinds_now$(echo "$out" | sed -n '/---KINDS---/,$p' | grep -vE '^---' | sed "s/^/$id /")
"
  done

  if [ -f "$STATE" ]; then
    new=$(comm -13 <(sort -u "$STATE") <(echo "$kinds_now" | sed '/^$/d' | sort -u) | head -10)
    [ -n "$new" ] && { echo "  NEW message kinds since last cycle:"; echo "$new" | sed 's/^/      /'; }
  fi
  echo "$kinds_now" | sed '/^$/d' | sort -u > "$STATE"

  sleep "$INTERVAL"
done
