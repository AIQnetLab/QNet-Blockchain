#!/usr/bin/env bash
# Rolling update of the genesis fleet, one node at a time.
#
# The workflow summary has always pointed here, but the file did not exist, and unlike
# install-super-node.sh the genesis installer never sets up Watchtower — so a pushed image sat in the
# registry while the fleet kept running the old binary with nothing to say so. This is that missing
# step, done deliberately rather than by an unattended poller: five consensus nodes updating
# themselves at once on a bad build is not a risk worth taking for convenience.
#
# Each container is recreated from its OWN inspect output, so seeds and API keys never leave the
# server and no option can be silently dropped. One node is taken down at a time and the next is not
# touched until the previous one answers.
#
#   ./deploy-genesis.sh                                  # all five, in order
#   ./deploy-genesis.sh 001 003                          # only these
#   QNET_ROLLBACK_TO_LAST_SEALED=1 ./deploy-genesis.sh   # recover to each node's certified floor
#   QNET_ROLLBACK_TO_HEIGHT=627483 ./deploy-genesis.sh   # or to an exact height, refused below that floor
#   QNET_RECOVERY_HALTED=1 ./deploy-genesis.sh           # chain stopped: M3/M4 not measurable
#   QNET_SET_ENV=QNET_ARCHIVE=1 ./deploy-genesis.sh 002  # set or replace env entries on these nodes
#   SKIP_GATE_CHECK=1 ./deploy-genesis.sh                # image without a build stamp: gates checked by hand
#   QNET_IMAGE=ghcr.io/aiqnetlab/qnet-production:<40-hex commit> ./deploy-genesis.sh   # one pinned build
#   REENTRY_EXPECT_NEXT_WINDOW=<w> ./deploy-genesis.sh 005  # stop unless the node reboots at checkpoint window w
#   REENTRY_MIN_NEXT_WINDOW=<w> ./deploy-genesis.sh 005     # stop if it reboots below window w (certificates moved on)
#   QNET_EXPECT_PK_HASH=<16-hex> ./deploy-genesis.sh 005    # identity baseline for one node whose key changed
#   QNET_FLEET_GATE_ONLY=1 RECOVERY_RESTART_H=<h> ./deploy-genesis.sh   # only the fleet M3/M4 of a halted chain, reads only
#   QNET_ARCHIVE_SINCE=2026-10-07T10:00:00Z ./deploy-genesis.sh  # archive the old log from then (default 48h)
#   QNET_UNSET_ENV=KEY[,KEY] ./deploy-genesis.sh         # drop env entries
#   QNET_ADD_BIND=/abs/host:/abs/ctr:ro[,...] ./deploy-genesis.sh  # add a read-only bind of a root-owned 600/400 file
#
# The old container is kept, stopped, until the new one passes its per-node checks; any stop before
# that prints the commands that bring it back.
#
# A gate added or moved in the build must sit GATE_MARGIN blocks above the tip when the roll starts (the
# check below). Its height is set at push time: ./gate-height.sh prints the first epoch boundary at least
# 604,800 blocks above the fleet tip. Host checks before a roll: docs/operators/genesis-host-checks.md.
set -uo pipefail

# A commit tag rolls, or rolls back, one exact build without moving :latest, which community nodes follow.
IMAGE="${QNET_IMAGE:-ghcr.io/aiqnetlab/qnet-production:latest}"
if ! [[ "$IMAGE" =~ ^ghcr\.io/aiqnetlab/qnet-production:(latest|[0-9a-f]{40})$ ]]; then
  echo "[ERR] QNET_IMAGE must be ghcr.io/aiqnetlab/qnet-production:latest or :<40-hex commit>"; exit 1
fi
PIN="${IMAGE##*:}"; [ "$PIN" = latest ] && PIN=""
LOCAL_TAG="qnet-production"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
SSH_PORT="${SSH_PORT:-2222}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
# Per-milestone budget for the re-entry gate below. The procedure allows 5-15 min per node against a
# live chain; a milestone that has not been met by then is a fault, not slowness, so the roll stops.
REENTRY_TIMEOUT="${REENTRY_TIMEOUT:-600}"
# Signer count a healthy seal carries. MEASURED from the fleet before the roll, never guessed: it is
# n-f over the committee, so it changes with committee size (6 members => 5, 5 => 4) and a hardcoded
# number would either hang the gate on a healthy node or accept a seal that is short of quorum.
QUORUM="${QUORUM:-}"
# KEY=VALUE[,KEY=VALUE] added to the recreated containers, replacing an entry with the same key. No spaces
# or quotes: the list travels as one ssh argument.
SET_ENV="${QNET_SET_ENV:-}"
if [ -n "$SET_ENV" ] && ! [[ "$SET_ENV" =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:-]*(,[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:-]*)*$ ]]; then
  echo "[ERR] QNET_SET_ENV must be KEY=VALUE[,KEY=VALUE] with no spaces"; exit 1
fi
# KEY[,KEY] dropped from the carried env: a secret moved into a file must not stay in the env as well.
UNSET_ENV="${QNET_UNSET_ENV:-}"
if [ -n "$UNSET_ENV" ] && ! [[ "$UNSET_ENV" =~ ^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$ ]]; then
  echo "[ERR] QNET_UNSET_ENV must be KEY[,KEY]"; exit 1
fi
for k in ${UNSET_ENV//,/ }; do
  case ",$SET_ENV" in *",$k="*) echo "[ERR] $k is in both QNET_SET_ENV and QNET_UNSET_ENV"; exit 1;; esac
done
# /abs/host:/abs/container:ro[,...] added with -v, so it lands in HostConfig.Binds and the next roll carries
# it. Read-only: this is for a file the node reads (a seed), never for data it writes.
ADD_BIND="${QNET_ADD_BIND:-}"
if [ -n "$ADD_BIND" ]; then
  re='^/[A-Za-z0-9_./-]+:/[A-Za-z0-9_./-]+:ro(,/[A-Za-z0-9_./-]+:/[A-Za-z0-9_./-]+:ro)*$'
  if ! [[ "$ADD_BIND" =~ $re ]] || [[ "$ADD_BIND" == *..* ]]; then
    echo "[ERR] QNET_ADD_BIND must be /abs/host:/abs/container:ro[,...], with no '..'"; exit 1
  fi
fi
# Where the archive of the old log starts: a duration, or an RFC 3339 UTC time, so a roll days after an
# incident still keeps the incident.
ARCHIVE_SINCE="${QNET_ARCHIVE_SINCE:-48h}"
re='^[0-9]+[smh]$|^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'
if ! [[ "$ARCHIVE_SINCE" =~ $re ]]; then
  echo "[ERR] QNET_ARCHIVE_SINCE must be a duration like 48h or an RFC 3339 UTC time like 2026-10-07T10:00:00Z"; exit 1
fi
# The checkpoint window the driver must reboot at (S2): exactly, while no new certificate exists; at least,
# once certificates have moved past it and a rebooted node restores newer ones. Empty = not checked.
REENTRY_EXPECT_NEXT_WINDOW="${REENTRY_EXPECT_NEXT_WINDOW:-}"
REENTRY_MIN_NEXT_WINDOW="${REENTRY_MIN_NEXT_WINDOW:-}"
# Fleet gate of a halted chain: the height it was parked at, and the budget for sealing to resume.
FLEET_GATE_ONLY="${QNET_FLEET_GATE_ONLY:-}"
RECOVERY_RESTART_H="${RECOVERY_RESTART_H:-}"
RECOVERY_TIMEOUT="${RECOVERY_TIMEOUT:-2700}"
for v in REENTRY_EXPECT_NEXT_WINDOW REENTRY_MIN_NEXT_WINDOW RECOVERY_RESTART_H RECOVERY_TIMEOUT; do
  case "${!v}" in *[!0-9]*) echo "[ERR] $v must be a number"; exit 1;; esac
done
if [ -n "$REENTRY_EXPECT_NEXT_WINDOW" ] && [ -n "$REENTRY_MIN_NEXT_WINDOW" ]; then
  echo "[ERR] set REENTRY_EXPECT_NEXT_WINDOW or REENTRY_MIN_NEXT_WINDOW, not both"; exit 1
fi
S2_WINDOW="$REENTRY_EXPECT_NEXT_WINDOW$REENTRY_MIN_NEXT_WINDOW"

declare -A NODE_IP=(
  [001]=154.38.160.39 [002]=62.171.157.44 [003]=161.97.86.81
  [004]=5.189.130.160 [005]=162.244.25.114 [006]=62.171.138.98
)
# 006 is a user-run super node: different container name and the default SSH port. It is in the
# consensus committee like the rest, so a fleet roll that skips it leaves the committee mixed-version.
declare -A NODE_CONTAINER=([006]=qnet-super-node)
declare -A NODE_PORT=([006]=22)
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(001 002 003 004 005 006)
# The pk_hash each node logs at boot (keypair_derived_deterministic); public, fixed by its seed. The identity
# baseline once that line has rotated out of a container's log (the log is capped at 10 GB, a few weeks), and
# a cross-check while it is still there. QNET_EXPECT_PK_HASH replaces it for a single target.
declare -A NODE_PK=(
  [001]=91786dc978a06614 [002]=75cf122fe0e3a617 [003]=ab5f2f79d15815d1
  [004]=049157c7ca0705c3 [005]=16435647102ce812 [006]=71555cd806a5af99
)
EXPECT_PK_OVERRIDE="${QNET_EXPECT_PK_HASH:-}"
if [ -n "$EXPECT_PK_OVERRIDE" ]; then
  if ! [[ "$EXPECT_PK_OVERRIDE" =~ ^[0-9a-f]{16}$ ]]; then echo "[ERR] QNET_EXPECT_PK_HASH must be 16 hex digits"; exit 1; fi
  if [ ${#TARGETS[@]} -ne 1 ]; then echo "[ERR] QNET_EXPECT_PK_HASH names one node's key: give exactly one target"; exit 1; fi
fi

port_of() { echo "${NODE_PORT[$1]:-$SSH_PORT}"; }
container_of() { echo "${NODE_CONTAINER[$1]:-qnet-genesis-$1}"; }
rsh()  { ssh -i "$SSH_KEY" -p "$2" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "$3"; }
# The recreate runs from a script fed on stdin, not from a quoted argument: nesting docker templates,
# grep patterns and shell quoting inside an ssh argument is how the first version of this broke.
# Its arguments travel as one ssh word list: none may be empty or hold a space ('-' stands for empty).
rsh_script() { local ip="$1" port="$2"; shift 2; ssh -i "$SSH_KEY" -p "$port" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$ip" "bash -s -- $*"; }

# ── Fleet gate for a halted chain: M3 and M4 measured on every node once all of them run the build. A
# parked chain seals nothing until the last node of the roll is back, so per node these milestones would
# gate the roll on its own outcome. Reads only: /healthz, the consensus position and the node logs.
#   M3 — the node logged a seal with head_h above the parked height $1 and >= QUORUM signers, at or above
#        a macroblock it took part in (validator=true), exactly as the per-node M3 below;
#   M4 — then +30 blocks counted from the node's height when its M3 passed (counted from $1 they would
#        already be behind it) with a clean failover window, as the per-node M4.
# One progress line a minute; stops when no node's last_sealed_mb_index rose for 600 s, or at RECOVERY_TIMEOUT.
fleet_gate() {
  local R="$1"; shift
  local n ip port cont a b h lsm fin out line part pmb hh sg sw m tag prog builds pend sealed
  local start now t0 last_rise first=1
  declare -A MAXLS=() M3H=() M4OK=()
  start=$(date +%s); last_rise=$start
  echo "=== fleet gate ($*): M3 = a seal above h=$R with >= $QUORUM signers that the node took part in;"
  echo "    M4 = then +30 blocks with no failover. Budget ${RECOVERY_TIMEOUT}s; stopped if no node seals for 600s ==="
  while :; do
    t0=$(date +%s); prog=""; builds=""
    for n in "$@"; do
      ip="${NODE_IP[$n]}"; port="$(port_of "$n")"; cont="$(container_of "$n")"
      a=$(rsh "$ip" "$port" "curl -s -m 8 http://localhost:8001/healthz; echo; curl -s -m 8 http://localhost:8001/api/v1/debug/consensus-position" 2>/dev/null | tr -d '\r')
      b=$(echo "$a" | sed -n 's/^ok .*build=\([^ ]*\).*/\1/p' | head -1)
      a=$(echo "$a" | tr ',{}' '\n\n\n')
      h=$(echo "$a" | sed -n 's/^"height":\([0-9]*\).*/\1/p' | head -1)
      lsm=$(echo "$a" | sed -n 's/^"last_sealed_mb_index":\([0-9]*\).*/\1/p' | head -1)
      fin=$(echo "$a" | sed -n 's/^"finalized_height":\([0-9]*\).*/\1/p' | head -1)
      builds="$builds $n=${b:0:7}"; [ -n "$b" ] || builds="$builds?"
      if [ -n "$lsm" ]; then
        if [ -z "${MAXLS[$n]:-}" ]; then MAXLS[$n]=$lsm
        elif [ "$lsm" -gt "${MAXLS[$n]}" ]; then MAXLS[$n]=$lsm; last_rise=$(date +%s); fi
      fi
      # The position says whether a seal above R exists at all before any log is read: a parked node's
      # log is gigabytes, and nothing in it can pass. Macroblock M seals at head M*90.
      if [ -z "${M3H[$n]:-}" ] && [ -n "$lsm" ] && [ -n "$h" ] && [ $((lsm * 90)) -gt "$R" ]; then
        out=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep -E 'macroblock_sealed|validator=true' | tail -n 2000" 2>/dev/null | tr -d '\r')
        line=$(echo "$out" | grep macroblock_sealed | tail -1)
        part=$(echo "$out" | grep 'validator=true' | tail -1)
        pmb=$(echo "$part" | sed -n 's/.*mb=\([0-9]*\).*/\1/p')
        hh=$(echo "$line" | sed -n 's/.*head_h=\([0-9]*\).*/\1/p')
        sg=$(echo "$line" | sed -n 's/.* signers=\([0-9]*\).*/\1/p')
        sw=$(echo "$line" | sed -n 's/.*window=\([0-9]*\).*/\1/p')
        if [ -n "$hh" ] && [ -n "$sg" ] && [ -n "$sw" ] && [ "$hh" -gt "$R" ] && [ "$sg" -ge "$QUORUM" ] \
           && { [ -n "${REENTRY_SKIP_PARTICIPATION:-}" ] || { [ -n "$pmb" ] && [ "$sw" -ge "$pmb" ]; }; }; then
          M3H[$n]=$h
          echo "  $n M3 finality:  window=$sw head_h=$hh signers=$sg participated_mb=${pmb:-skipped}"
        fi
      fi
      if [ -n "${M3H[$n]:-}" ] && [ -z "${M4OK[$n]:-}" ] && [ -n "$h" ] && [ $((h - ${M3H[$n]})) -ge 30 ]; then
        m=$(rsh "$ip" "$port" "docker logs $cont --since 6m 2>&1 | grep '\[METRICS\]\[FAILOVER\]' | tail -1" 2>/dev/null || true)
        case "$m" in
          *failover_events=0*max_timeout_round=0*|*max_timeout_round=0*failover_events=0*)
            M4OK[$n]=1; echo "  $n M4 production: no failover, +$((h - ${M3H[$n]})) blocks since its M3";;
        esac
      fi
      tag=""; [ -n "${M3H[$n]:-}" ] && tag=" M3"; [ -n "${M4OK[$n]:-}" ] && tag=" M3+M4"
      if [ -n "$h$lsm$fin" ]; then prog="$prog  $n h=${h:-?} sealed=${lsm:-?} fin=${fin:-?}$tag"
      else prog="$prog  $n <no answer>"; fi
    done
    now=$(date +%s)
    [ -n "$first" ] && echo "  builds:$builds"; first=""
    echo "  [$((now - start))s]$prog"
    pend=""; sealed=""
    for n in "$@"; do [ -n "${M4OK[$n]:-}" ] || pend="$pend $n"; sealed="$sealed $n=${MAXLS[$n]:-?}"; done
    if [ -z "$pend" ]; then
      echo "=== fleet gate passed: every node saw a full-quorum seal above h=$R, then a clean rotation ==="; return 0
    fi
    # Over a budget shorter than the stall window, "no rise for the whole budget" is the same verdict.
    if [ $((now - last_rise)) -ge 600 ] || { [ $((now - start)) -ge "$RECOVERY_TIMEOUT" ] && [ "$last_rise" -eq "$start" ]; }; then
      echo "[ERR] fleet gate: no node's last_sealed_mb_index rose for $((now - last_rise))s (last_sealed:$sealed),"
      echo "      nothing sealed above h=$R — diagnose before any restart"
      return 1
    fi
    if [ $((now - start)) -ge "$RECOVERY_TIMEOUT" ]; then
      echo "[ERR] fleet gate not passed within ${RECOVERY_TIMEOUT}s: M3/M4 pending on$pend (last_sealed:$sealed)"
      return 1
    fi
    [ $((t0 + 60 - now)) -gt 0 ] && sleep $((t0 + 60 - now))
  done
}

# Measure the healthy signer count once, from the first reachable node, unless it was given.
#
# Anchored to the SEAL line, and to " signers=" with the leading space. `signers=` is not unique:
# a rejected certificate logs `qc_rejected ... signers=3 committee=6 quorum=5` and `catchup_rejected
# ... signers=5 ... foreign_signers=0`, and `foreign_signers=0` CONTAINS the substring `signers=0`.
# An unanchored `grep -o` returns that last, so one rejected QC in the window measured the quorum as
# 0 - a non-empty string, so the emptiness guard passed - and every later `signers >= QUORUM` test
# was then vacuously true. The gate would have reported "measured" while checking nothing.
QSRC=given; [ -z "$QUORUM" ] && QSRC=measured
if [ -z "$QUORUM" ]; then
  for probe in "${TARGETS[@]}"; do
    pip="${NODE_IP[$probe]:-}"; [ -z "$pip" ] && continue
    QUORUM=$(rsh "$pip" "$(port_of "$probe")" \
      "docker logs $(container_of "$probe") --since 30m 2>&1 | grep macroblock_sealed | tail -1" 2>/dev/null \
      | sed -n 's/.* signers=\([0-9]*\).*/\1/p')
    [ -n "$QUORUM" ] && break
  done
fi
# A measurement that is not a plausible quorum is a broken measurement, not a small committee: n-f is
# at least 2 for any committee that can seal at all. Refuse to roll on it rather than disarm the gate.
case "$QUORUM" in
  ''|*[!0-9]*) echo "[ERR] could not measure the signer count of a healthy seal — pass QUORUM=<n> explicitly"; exit 1;;
esac
if [ "$QUORUM" -lt 2 ]; then
  echo "[ERR] measured signer count $QUORUM is below any real quorum — pass QUORUM=<n> explicitly"; exit 1
fi
echo "=== signer count for a healthy seal: $QUORUM ($QSRC) ==="

# Standalone fleet gate: no pull, no recreate, no gate check. It only reads, so it can be rerun at will.
if [ -n "$FLEET_GATE_ONLY" ]; then
  if [ -z "$RECOVERY_RESTART_H" ]; then
    echo "[ERR] QNET_FLEET_GATE_ONLY needs RECOVERY_RESTART_H=<height the chain was parked at>"; exit 1
  fi
  for id in "${TARGETS[@]}"; do
    [ -n "${NODE_IP[$id]:-}" ] || { echo "[ERR] unknown node id: $id"; exit 1; }
  done
  echo "=== QNET_FLEET_GATE_ONLY: fleet M3/M4 only — nothing is pulled, stopped or recreated ==="
  fleet_gate "$RECOVERY_RESTART_H" "${TARGETS[@]}"; exit $?
fi

# ── Gate check, before any node is touched. A consensus rule ships dormant behind an activation height
# (core/qnet-state/src/feature_gates.rs), and "a mixed fleet cannot fork before the gate" holds only if
# the roll finishes BEFORE that height. Rolled after it, upgraded nodes enforce the rule while the rest
# do not, and a node that later replays a block the old binaries applied above the gate computes other
# state. So every gate the new build adds or moves, compared with the build each node runs now, must sit
# at least GATE_MARGIN blocks above the fleet tip. Two epochs at one block a second: more than twice the
# worst case of the timeouts above over six nodes, with time left to finish a roll that stopped half
# way. The heights come from the source of the commits the build stamps name, so both commits must be in
# the local repository. SKIP_GATE_CHECK=1 is for an image without a stamp, or a recovery roll whose
# heights were checked by hand; never a fallback.
GATE_MARGIN="${GATE_MARGIN:-28800}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "$GATE_MARGIN" in ''|*[!0-9]*) echo "[ERR] GATE_MARGIN must be a block count"; exit 1;; esac

image_build() {
  rsh "$1" "$2" "docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $IMAGE" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^QNET_BUILD_ID=//p'
}

# `gate height` for every ACTIVATIONS entry of the node source at commit $1, each height resolved through
# the constants it names (the gas-metering one lives in transaction.rs). `?` = a height it cannot read.
gate_table() {
  local f
  # A commit id only: an empty one would make `git show :path` read the index instead.
  [[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || return 1
  for f in transaction.rs feature_gates.rs; do
    git -C "$REPO" cat-file -e "$1:core/qnet-state/src/$f" 2>/dev/null || return 1
  done
  { git -C "$REPO" show "$1:core/qnet-state/src/transaction.rs"; echo '@@FEATURE_GATES@@'
    git -C "$REPO" show "$1:core/qnet-state/src/feature_gates.rs"; } | awk '
    function res(e, n) {
      gsub(/^[ \t]+|[ \t]+$/, "", e)
      if (e ~ /^[0-9][0-9_]*(u64)?$/) { sub(/u64$/, "", e); gsub(/_/, "", e); return e }
      if (n < 8 && (e in d)) return res(d[e], n + 1)
      return "?"
    }
    { sub(/\r$/, "") }
    /^@@FEATURE_GATES@@$/ { fg = 1; next }
    /^ *(pub )?const [A-Z0-9_]+: u64 = [^;]+;/ {
      l = $0; sub(/^ *(pub )?const /, "", l); n = l; sub(/:.*/, "", n)
      e = l; sub(/^[^=]*= */, "", e); sub(/;.*/, "", e); d[n] = e; next
    }
    /^ *(pub )?const fn [a-z0-9_]+\(\) -> u64 \{ *crate::transaction::[A-Z0-9_]+ *\}/ {
      l = $0; sub(/^ *(pub )?const fn /, "", l); n = l; sub(/\(.*/, "", n)
      e = l; sub(/.*crate::transaction::/, "", e); sub(/[^A-Z0-9_].*/, "", e); d[n "()"] = e; next
    }
    fg && /^const ACTIVATIONS/ { act = 1; next }
    act && /^\];/ { act = 0; next }
    act && /^ *\(id::[A-Z0-9_]+,/ {
      l = $0; sub(/^ *\(id::/, "", l); g = l; sub(/,.*/, "", g)
      e = l; sub(/^[^,]*, */, "", e); sub(/\)[ \t]*,?[ \t]*(\/\/.*)?$/, "", e); ids[++k] = g; ex[g] = e
    }
    END { for (i = 1; i <= k; i++) print ids[i], res(ex[ids[i]], 0) }'
}

# The image is pulled on the first target to read its stamp; a pull touches no running container.
first="${TARGETS[0]}"; fip="${NODE_IP[$first]:-}"
if [ -z "$fip" ]; then echo "[ERR] unknown node id: $first"; exit 1; fi
if ! rsh "$fip" "$(port_of "$first")" "docker pull -q $IMAGE >/dev/null"; then
  echo "[ERR] pull failed on $first — nothing touched"; exit 1
fi
NEW_BUILD=$(image_build "$fip" "$(port_of "$first")")
echo "=== image to roll: $IMAGE build=${NEW_BUILD:-<unstamped>} ==="
# A commit tag must carry that commit's stamp: anything else is not the build that was reviewed.
if [ -n "$PIN" ] && [ "$NEW_BUILD" != "$PIN" ]; then
  echo "[ERR] $IMAGE carries build=${NEW_BUILD:-<unstamped>}, not the commit its tag names — nothing touched"; exit 1
fi

if [ -n "${SKIP_GATE_CHECK:-}" ]; then
  echo "=== gate check SKIPPED (SKIP_GATE_CHECK set): every added or moved activation height must be"
  echo "    checked by hand to sit above the tip by more than the whole roll ==="
else
  tip=0; declare -A LIVE=()
  for n in $(printf '%s\n' "${!NODE_IP[@]}" | sort); do
    a=$(rsh "${NODE_IP[$n]}" "$(port_of "$n")" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null | tr -d '\r')
    nh=$(echo "$a" | sed -n 's/.*h=\([0-9]*\).*/\1/p'); nb=$(echo "$a" | sed -n 's/.*build=\([^ ]*\).*/\1/p')
    if [ -z "$nh" ]; then echo "  [WARN] $n did not answer /healthz: the build it runs is not compared"; continue; fi
    if [ -z "$nb" ]; then
      echo "[ERR] $n reports no build stamp, so the gates it runs are unknown — check by hand, then SKIP_GATE_CHECK=1"; exit 1
    fi
    [ "$nh" -gt "$tip" ] && tip=$nh
    LIVE[$nb]="${LIVE[$nb]:+${LIVE[$nb]} }$n"
  done
  if [ ${#LIVE[@]} -eq 0 ]; then echo "[ERR] no node answered /healthz — the tip is unknown, nothing touched"; exit 1; fi
  if ! new_tab=$(gate_table "$NEW_BUILD"); then
    echo "[ERR] the image's build=${NEW_BUILD:-<unstamped>} is not a commit in the local repository — git fetch and"
    echo "      rerun; an unstamped image needs its gates checked by hand, then SKIP_GATE_CHECK=1"; exit 1
  fi
  declare -A NEWG=()
  while read -r g v; do [ -n "$g" ] && NEWG[$g]=$v; done <<< "$new_tab"
  refused=""
  for b in "${!LIVE[@]}"; do
    if ! old_tab=$(gate_table "$b"); then
      echo "[ERR] build=$b (nodes ${LIVE[$b]}) is not a commit in the local repository — git fetch and rerun;"
      echo "      an unstamped node needs its gates checked by hand, then SKIP_GATE_CHECK=1"; exit 1
    fi
    unset OLDG; declare -A OLDG=()
    while read -r g v; do [ -n "$g" ] && OLDG[$g]=$v; done <<< "$old_tab"
    for g in "${!NEWG[@]}"; do
      nv=${NEWG[$g]}; ov=${OLDG[$g]:-}
      if [ "$nv" = "?" ]; then echo "  [ERR] gate $g: height not readable from the source"; refused=1; continue; fi
      [ "$ov" = "$nv" ] && continue
      # A gate a node may already have crossed never moves: blocks between its old and new height would
      # replay under the other rule, and a node syncing them would accept what the fleet refused.
      if [ -n "$ov" ] && [ "$ov" != "?" ] && [ "$ov" -le $((tip + GATE_MARGIN)) ]; then
        echo "  [ERR] gate $g: $ov -> $nv, but $ov is not $GATE_MARGIN blocks above the tip $tip: gate already crossed,"
        echo "        its height is frozen (nodes ${LIVE[$b]} run ${b:0:7})"
        refused=1; continue
      fi
      if [ "$nv" -gt $((tip + GATE_MARGIN)) ]; then
        echo "  gate $g: ${ov:-new} -> $nv, $((nv - tip)) blocks above the tip (nodes ${LIVE[$b]} run ${b:0:7})"
      else
        echo "  [ERR] gate $g: ${ov:-new} -> $nv, not $GATE_MARGIN blocks above the tip $tip (nodes ${LIVE[$b]} run ${b:0:7})"
        refused=1
      fi
    done
    for g in "${!OLDG[@]}"; do
      if [ -n "${NEWG[$g]:-}" ] || [ "${OLDG[$g]}" = "0" ]; then continue; fi
      echo "  [ERR] gate $g (${OLDG[$g]} in ${b:0:7}) is gone from the new build, so its rule is active from genesis"
      refused=1
    done
  done
  if [ -n "$refused" ]; then
    echo "[ERR] roll refused, nothing touched: move each gate above to a later epoch boundary (./gate-height.sh"
    echo "      prints one), rebuild, rerun"; exit 1
  fi
  echo "=== gate check: tip $tip, margin $GATE_MARGIN, every added or moved gate is ahead ==="
fi

RECOVER="${QNET_ROLLBACK_TO_LAST_SEALED:-}${QNET_ROLLBACK_TO_HEIGHT:+H$QNET_ROLLBACK_TO_HEIGHT}"
INNER_OUT=$(mktemp) || { echo "[ERR] mktemp failed — nothing touched"; exit 1; }
trap 'rm -f "$INNER_OUT"' EXIT
ROLL_MAX_H=0
declare -A ROLLED_FROM=()   # build each target ran before this run, from its /healthz

# Any stop after the recreate leaves the previous container in place, stopped, and prints how to bring
# it back: the fastest way out of a build that does not boot or boots as somebody else.
fail_node() {
  echo "  [ERR] $1"
  echo "        the previous container is kept, stopped, as $OLD; to bring it back:"
  echo "        ssh -i $SSH_KEY -p $port root@$ip 'docker rm -f $cont; docker rename $OLD $cont; docker update --restart=$REST $cont; docker start $cont'"
  exit 1
}

# S2 window test: exact while no certificate formed since the halt; at least, once newer ones exist.
win_ok() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  if [ -n "$REENTRY_EXPECT_NEXT_WINDOW" ]; then [ "$1" -eq "$REENTRY_EXPECT_NEXT_WINDOW" ]
  else [ "$1" -ge "$REENTRY_MIN_NEXT_WINDOW" ]; fi
}

# Archive the old container's log and remove it, in the background on the host, once the new one has
# passed its per-node checks. The newest five archives of this node are kept.
archive_old() {
  if rsh_script "$ip" "$port" "$cont" "$OLD" "$ARCHIVE_SINCE" <<'ARCH'
N="$1"; OLD="$2"; SINCE="$3"; LOGDIR=/root/qnet-logs
mkdir -p "$LOGDIR"
setsid nohup nice -n 19 sh -c "docker logs --since '$SINCE' --timestamps '$OLD' 2>&1 | gzip -1 > '$LOGDIR/$OLD.log.gz'; docker rm '$OLD' >/dev/null 2>&1; ls -1t '$LOGDIR/$N'-pre-*.log.gz 2>/dev/null | tail -n +6 | xargs -r rm -f" >/dev/null 2>&1 &
ARCH
  then
    echo "  archive:      $OLD -> /root/qnet-logs/$OLD.log.gz (since $ARCHIVE_SINCE), then removed"
  else
    echo "  [WARN] archive not started on $id: $OLD stays, stopped — archive and remove it by hand"
  fi
}

for id in "${TARGETS[@]}"; do
  ip="${NODE_IP[$id]:-}"
  if [ -z "$ip" ]; then echo "[ERR] unknown node id: $id"; exit 1; fi
  port="$(port_of "$id")"; cont="$(container_of "$id")"
  echo "=== $id ($ip:$port $cont) ==="
  before=$(rsh "$ip" "$port" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null | tr -d '\r')
  echo "  before: ${before:-<no answer>}"
  ROLLED_FROM[$id]=$(echo "$before" | sed -n 's/^ok .*build=\([^ ]*\).*/\1/p')

  # Pull first: a registry that cannot be reached must not cost us a running node.
  if ! rsh "$ip" "$port" "docker pull -q $IMAGE >/dev/null && docker tag $IMAGE $LOCAL_TAG"; then
    echo "  [ERR] pull failed — node left untouched, roll stopped"; exit 1
  fi
  # Every node gets the build the roll started with: a push during the roll would otherwise put a second
  # build, whose gates nobody checked, on part of the fleet.
  got=$(image_build "$ip" "$port")
  if [ "$got" != "$NEW_BUILD" ]; then
    echo "  [ERR] pulled build=${got:-<unstamped>}, the roll started with build=${NEW_BUILD:-<unstamped>} — node left untouched, roll stopped"
    exit 1
  fi

  # Output lines starting with @@ carry values back (old container name, restart policy, the identity
  # before the stop); exit 3 means refused before the stop, node untouched.
  expect_pk="${EXPECT_PK_OVERRIDE:-${NODE_PK[$id]:-}}"
  rsh_script "$ip" "$port" "$cont" "$LOCAL_TAG" "${SET_ENV:--}" "${RECOVER:--}" "${UNSET_ENV:--}" "${ADD_BIND:--}" "${expect_pk:--}" >"$INNER_OUT" <<'INNER'
set -e
N="$1"; TAG="$2"; SETENV="${3:--}"; RECOVER="${4:--}"; UNSET="${5:--}"; ADDBIND="${6:--}"; EXPECT_PK="${7:--}"
if [ "$RECOVER" = "-" ]; then RECOVER=""; fi
if [ "$EXPECT_PK" = "-" ]; then EXPECT_PK=""; fi
refuse() { echo "refused before the stop: $*"; exit 3; }
docker inspect "$N" >/dev/null 2>&1 || refuse "no such container: $N"

# Carry the container's env MINUS two kinds of entry that must not survive a roll:
#   QNET_ROLLBACK_*  one-shot recovery flags; carried forward they silently re-truncate every restart.
#   QNET_BUILD_ID    belongs to the IMAGE, not the container. Carried over it pins the OLD stamp on
#                    the new binary, so /healthz reports the build we just replaced — the stamp lies
#                    exactly where it is needed, and a roll cannot be told from a no-op.
# QNET_SET_ENV keys are replaced, QNET_UNSET_ENV keys dropped.
SETS=(); SET_KEYS=" "; UNSETS=(); UNSET_KEYS=" "
if [ "$SETENV" != "-" ]; then
  IFS=',' read -ra SETS <<< "$SETENV"
  for kv in "${SETS[@]}"; do SET_KEYS="$SET_KEYS${kv%%=*} "; done
fi
if [ "$UNSET" != "-" ]; then
  IFS=',' read -ra UNSETS <<< "$UNSET"
  for k in "${UNSETS[@]}"; do UNSET_KEYS="$UNSET_KEYS$k "; done
fi
FINAL=(); OLD_SEED=""
while IFS= read -r e; do
  case "$e" in QNET_WALLET_SEED=*|QNET_WALLET_SEED_FILE=*) OLD_SEED=1 ;; esac
  case "$e" in ''|QNET_ROLLBACK_*|QNET_RECOVERY_HALTED*|QNET_BUILD_ID=*) continue;; esac
  case "$SET_KEYS$UNSET_KEYS" in *" ${e%%=*} "*) continue;; esac
  FINAL+=("$e")
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$N")
FINAL+=("${SETS[@]}")
ENVS=""
for e in "${FINAL[@]}"; do ENVS="$ENVS -e $(printf '%q' "$e")"; done

case "$RECOVER" in
  H*) ENVS="$ENVS -e QNET_ROLLBACK_TO_HEIGHT=${RECOVER#H}" ;;
  ?*) ENVS="$ENVS -e QNET_ROLLBACK_TO_LAST_SEALED=$RECOVER" ;;
esac

# Added binds are checked here, before the stop, so a missing or loose secret file costs nothing. A
# carried bind with the same destination is replaced, so a rerun does not mount it twice.
ADDS=(); ADD_DSTS=" "
if [ "$ADDBIND" != "-" ]; then IFS=',' read -ra ADDS <<< "$ADDBIND"; fi
for b in "${ADDS[@]}"; do
  src="${b%%:*}"; dst="${b#*:}"; dst="${dst%%:*}"
  if [ ! -f "$src" ] || [ -L "$src" ]; then refuse "bind source $src is not a regular file"; fi
  mode=$(stat -c %a "$src"); owner=$(stat -c %u "$src")
  case "$mode" in 600|400) ;; *) refuse "bind source $src has mode $mode, not 600 or 400";; esac
  if [ "$owner" != 0 ]; then refuse "bind source $src is owned by uid $owner, not root"; fi
  ADD_DSTS="$ADD_DSTS$dst "
done
BIND_LIST=()
while IFS= read -r b; do
  if [ -z "$b" ]; then continue; fi
  d="${b#*:}"; d="${d%%:*}"
  case "$ADD_DSTS" in *" $d "*) continue;; esac
  BIND_LIST+=("$b")
done < <(docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$N")
BIND_LIST+=("${ADDS[@]}")
BINDS=""
for b in "${BIND_LIST[@]}"; do BINDS="$BINDS -v $(printf '%q' "$b")"; done

# One seed source, and a seed file that exists inside the container: with both, the node may read the
# one that was meant to go; with a file path and nothing mounted there, it has no seed. Values are
# never printed.
SEED_ENV=""; SEED_FILE_SET=""; SEED_FILE=""
for e in "${FINAL[@]}"; do
  case "$e" in
    QNET_WALLET_SEED=*) SEED_ENV=1 ;;
    QNET_WALLET_SEED_FILE=*) SEED_FILE_SET=1; SEED_FILE="${e#*=}" ;;
  esac
done
if [ -n "$SEED_FILE_SET" ]; then
  if [ -n "$SEED_ENV" ]; then
    refuse "both QNET_WALLET_SEED and QNET_WALLET_SEED_FILE would remain (QNET_UNSET_ENV=QNET_WALLET_SEED)"
  fi
  found=""
  for b in "${BIND_LIST[@]}"; do
    d="${b#*:}"; d="${d%%:*}"
    if [ "$d" = "$SEED_FILE" ]; then found=1; fi
  done
  if [ -z "$found" ]; then refuse "QNET_WALLET_SEED_FILE=$SEED_FILE but no bind has that destination (QNET_ADD_BIND)"; fi
fi
# A misspelt QNET_SET_ENV key next to QNET_UNSET_ENV=QNET_WALLET_SEED would leave the node with no seed at all.
if [ -n "$OLD_SEED" ] && [ -z "$SEED_ENV$SEED_FILE_SET" ]; then
  refuse "the container has a wallet seed source and none would remain (QNET_SET_ENV / QNET_UNSET_ENV)"
fi

# Identity continuity: the pk_hash the old container derived at boot, compared after the restart. A
# kept -pre- container is an earlier attempt that did not pass; the oldest one holds the identity from
# before it, and a current container that disagrees with it must be restored, not rolled again.
# Read only up to ten minutes past the container's last start, where the boot line is: a line rotated out
# then costs a short read instead of a scan of gigabytes on a consensus host.
pk_of() {
  local s u
  s=$(docker inspect --format '{{.State.StartedAt}}' "$1" 2>/dev/null) || s=""
  u=$(date -u -d "$s + 10 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || u=""
  docker logs ${u:+--until "$u"} "$1" 2>&1 | grep -m1 'keypair_derived_deterministic' | sed -n 's/.* pk_hash=\([0-9a-f]*\).*/\1/p'
}
PK=$(pk_of "$N"); PKSRC="$N"
KEPT=$(docker ps -a --format '{{.Names}}' | grep -E "^${N}-pre-[0-9]{8}T[0-9]{6}Z\$" | sort | head -1)
if [ -n "$KEPT" ]; then
  KPK=$(pk_of "$KEPT")
  if [ -n "$PK" ] && [ -n "$KPK" ] && [ "$PK" != "$KPK" ]; then
    refuse "$N derived pk_hash=$PK but the kept $KEPT derived $KPK: restore $KEPT first"
  fi
  if [ -z "$PK" ]; then PK="$KPK"; PKSRC="$KEPT"; fi
fi
# The node table (or QNET_EXPECT_PK_HASH): a cross-check while the boot line exists, the baseline once it is gone.
if [ -n "$EXPECT_PK" ]; then
  if [ -n "$PK" ] && [ "$PK" != "$EXPECT_PK" ]; then
    refuse "$PKSRC derived pk_hash=$PK, the node table expects $EXPECT_PK: find out why, or pass QNET_EXPECT_PK_HASH"
  fi
  if [ -z "$PK" ]; then PK="$EXPECT_PK"; PKSRC="node table"; fi
fi
if [ -z "$PK" ]; then
  refuse "no keypair_derived_deterministic line in the log of $N${KEPT:+ or $KEPT} and no expected pk_hash: identity continuity cannot be checked"
fi
LOGS=$(docker inspect --format '{{range $k, $v := .HostConfig.LogConfig.Config}}--log-opt {{$k}}={{$v}} {{end}}' "$N")
PORTS=$(docker inspect --format '{{range $p, $c := .HostConfig.PortBindings}}{{range $c}}-p {{.HostPort}}:{{$p}} {{end}}{{end}}' "$N")
REST=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$N")
echo "@@PK=$PK"; echo "@@PKSRC=$PKSRC"; echo "@@REST=${REST:-always}"

# Keep what the old container saw. `docker rm` takes its log with it, and an incident is then only as
# reconstructable as the window that survived the roll — twice now the hours that mattered were gone.
# The old container is renamed aside and kept, stopped, until the new one passes its per-node checks
# (archive_old); the new one starts as before (same stop/run gap). Its restart policy is cleared first:
# a daemon restart would otherwise bring a second node up on the same data directory.
OLD="${N}-pre-$(date -u +%Y%m%dT%H%M%SZ)"
docker stop "$N" >/dev/null
docker rename "$N" "$OLD"
docker update --restart=no "$OLD" >/dev/null 2>&1 || true
if ! eval docker run -d --name "$N" --restart="${REST:-always}" $LOGS $ENVS $PORTS $BINDS "$TAG" >/dev/null; then
  docker rm -f "$N" >/dev/null 2>&1 || true
  docker rename "$OLD" "$N"
  docker update --restart="${REST:-always}" "$N" >/dev/null 2>&1 || true
  docker start "$N" >/dev/null 2>&1 || true
  echo "run failed — the previous container is back up"
  exit 1
fi
echo "@@OLD=$OLD"
INNER
  rc=$?
  grep -v '^@@' "$INNER_OUT" | sed 's/^/  /'
  PK_OLD=$(sed -n 's/^@@PK=//p' "$INNER_OUT" | tr -d '\r')
  PK_SRC=$(sed -n 's/^@@PKSRC=//p' "$INNER_OUT" | tr -d '\r')
  REST=$(sed -n 's/^@@REST=//p' "$INNER_OUT" | tr -d '\r'); REST="${REST:-always}"
  OLD=$(sed -n 's/^@@OLD=//p' "$INNER_OUT" | tr -d '\r')
  if [ "$rc" -eq 3 ]; then echo "  [ERR] $id refused before the stop — node untouched, roll stopped"; exit 1; fi
  if [ "$rc" -ne 0 ] || [ -z "$OLD" ]; then
    echo "  [ERR] recreate failed on $id — roll stopped, fix this node before continuing"; exit 1
  fi

  # ── Re-entry gate. The next node is not touched until this one is BACK IN CONSENSUS, not merely
  # answering. An ungated roll takes nodes out faster than they re-enter and the quorum margin
  # evaporates: at six members the quorum is five, so one node down is the whole margin.
  #
  #   1 RPC up            — replay finished
  #   2 converged         — gap to the network tip < 10
  #   3 finality re-entry — a macroblock seals ABOVE the restart height with a full-quorum signer set
  #   4 production re-entry — a rotation window passes with zero failovers
  ok=""
  for _ in $(seq 1 $((HEALTH_TIMEOUT/5))); do
    sleep 5
    a=$(rsh "$ip" "$port" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null || true)
    case "$a" in ok*) ok="$a"; break;; esac
  done
  if [ -z "$ok" ]; then
    # A seed-file or identity failure exits the node at boot: show why next to the restore commands.
    rsh "$ip" "$port" "docker logs $cont 2>&1 | grep -E 'wallet_seed_file_(unreadable|empty)|genesis_wallet_identity_fatal|panicked|\[CRIT\]' | tail -5" 2>/dev/null \
      | tr -d '\r' | cut -c1-200 | sed 's/^/        /'
    fail_node "$id did not answer within ${HEALTH_TIMEOUT}s — roll stopped"
  fi
  echo "  M1 rpc:      $ok"
  case "$ok" in *build=*) ;; *) echo "  [WARN] no build= in the answer: this image predates the build stamp";; esac

  restart_h=$(echo "$ok" | sed -n 's/.*h=\([0-9]*\).*/\1/p')
  if [ -n "$restart_h" ] && [ "$restart_h" -gt "$ROLL_MAX_H" ]; then ROLL_MAX_H=$restart_h; fi

  # S7 identity continuity and S2 re-entry window, from the new container's boot lines (its log is
  # minutes old). S7: the same pk_hash as before the stop, and no seed-file failure. S2: the driver
  # rebooted at the expected checkpoint window (or at least at it), both from the certified WAL and,
  # when it ran, from the eager startup catch-up; no panic and no [CRIT]. The halt watchdog's
  # chain_halted [CRIT] repeats every 300 s while the chain is parked, so it is expected here.
  bl=""; wal=""; wal_seen=""; npk=""; s_ok=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/5))); do
    sleep 5
    bl=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep -E 'keypair_derived_deterministic|wallet_seed_file_(unreadable|empty)|genesis_wallet_identity_fatal|certified_wal_(restored|unreadable)|eager_startup_sync|panicked|\[CRIT\]' | grep -v '\[CRIT\]\[WATCHDOG\] chain_halted' | head -100" 2>/dev/null | tr -d '\r')
    bad=$(echo "$bl" | grep -E 'wallet_seed_file_(unreadable|empty)|genesis_wallet_identity_fatal' | head -3)
    if [ -n "$bad" ]; then
      echo "$bad" | cut -c1-200 | sed 's/^/        /'
      fail_node "$id: the wallet seed was not read as configured — roll stopped"
    fi
    if [ -n "$S2_WINDOW" ]; then
      bad=$(echo "$bl" | grep -E 'panicked|\[CRIT\]|certified_wal_unreadable' | head -3)
      if [ -n "$bad" ]; then
        echo "$bad" | cut -c1-200 | sed 's/^/        /'
        fail_node "$id: panic, [CRIT] or unreadable WAL after the restart — roll stopped"
      fi
    fi
    npk=$(echo "$bl" | grep -m1 keypair_derived_deterministic | sed -n 's/.* pk_hash=\([0-9a-f]*\).*/\1/p')
    if [ -n "$S2_WINDOW" ]; then
      wal=$(echo "$bl" | grep certified_wal_restored | tail -1)
      [ -z "$wal" ] && continue
      # The eager catch-up line follows the WAL line within milliseconds when it is logged at all.
      if [ -z "$wal_seen" ]; then wal_seen=1; continue; fi
    fi
    if [ -n "$npk" ]; then s_ok=1; break; fi
  done
  if [ -z "$s_ok" ]; then
    fail_node "$id: no keypair_derived_deterministic${S2_WINDOW:+ or certified_wal_restored} line within ${REENTRY_TIMEOUT}s — roll stopped"
  fi
  if [ "$npk" != "$PK_OLD" ]; then
    fail_node "$id: identity changed: pk_hash=$npk, before the stop $PK_OLD ($PK_SRC) — roll stopped"
  fi
  echo "  S7 identity:  pk_hash=$npk, as before the stop ($PK_SRC)"
  if [ -n "$S2_WINDOW" ]; then
    w=$(echo "$wal" | sed -n 's/.* next_window=\([0-9]*\).*/\1/p')
    p=$(echo "$wal" | sed -n 's/.* pairs=\([0-9]*\).*/\1/p')
    eg=$(echo "$bl" | grep eager_startup_sync | tail -1)
    w2=$(echo "$eg" | sed -n 's/.* next_window=\([0-9]*\).*/\1/p')
    want="${REENTRY_EXPECT_NEXT_WINDOW:+$REENTRY_EXPECT_NEXT_WINDOW}${REENTRY_MIN_NEXT_WINDOW:+at least $REENTRY_MIN_NEXT_WINDOW}"
    if ! win_ok "$w" || { [ -n "$eg" ] && ! win_ok "$w2"; }; then
      fail_node "$id: rebooted at next_window=${w:-?} pairs=${p:-?}${eg:+, eager_startup_sync next_window=${w2:-?}}; expected $want — roll stopped"
    fi
    echo "  S2 re-entry:  next_window=$w pairs=$p${eg:+, eager_startup_sync next_window=$w2} (expected $want)"
  fi

  # M2 — converged.
  conv=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    h=$(rsh "$ip" "$port" "curl -s -m 8 http://localhost:8001/api/v1/node/health" 2>/dev/null || true)
    local_h=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"height":\([0-9]*\).*/\1/p' | head -1)
    net_h=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"network_height":\([0-9]*\).*/\1/p' | head -1)
    # peers>0 as well: on an isolated node network_height falls back to the node's OWN height, so the
    # gap is 0 and "converged" would pass on a node that has not spoken to anyone.
    peers=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"validated_peers":\([0-9]*\).*/\1/p' | head -1)
    if [ -n "$local_h" ] && [ -n "$net_h" ] && [ -n "$peers" ] \
       && [ "$peers" -gt 0 ] && [ $((net_h - local_h)) -lt 10 ]; then
      conv="$local_h/$net_h peers=$peers"; break
    fi
    sleep 10
  done
  if [ -z "$conv" ]; then fail_node "$id did not converge within ${REENTRY_TIMEOUT}s — roll stopped"; fi
  echo "  M2 converged: gap<10 ($conv)"

  # A HALTED chain cannot satisfy M3/M4: nothing seals and no block advances until the roll that fixes
  # the halt has finished, so those milestones would gate the roll on the outcome of the roll itself.
  # M1 and M2 stay enforced — they are meaningful and passable while stopped (the tip is the same
  # everywhere, so the gap is real). Explicit flag ONLY, never a fallback on timeout: a genuine
  # liveness fault must never be able to read as "recovery". M3/M4 are measured fleet-level instead
  # (fleet_gate), after the loop, once every node runs the build.
  if [ -n "${QNET_RECOVERY_HALTED:-}" ]; then
    echo "  M3/M4 SKIPPED: QNET_RECOVERY_HALTED set — chain is not sealing, per-node re-entry is not"
    echo "        measurable; the fleet gate measures them once every node runs this build."
    archive_old
    continue
  fi

  # M3 — finality re-entry. TWO signals, because a seal alone does not name its signers: the node
  # must have re-entered a checkpoint as a participating validator, and a window at or above that one
  # must have sealed with a full quorum, above the restart height. `role=replica` on a seal line only
  # says the node watched it happen; at six members with a quorum of five, a seal can exclude us.
  # The container is recreated, so its log starts empty — no line here predates the restart.
  seal=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    part=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep 'validator=true' | tail -1" 2>/dev/null || true)
    pmb=$(echo "$part" | sed -n 's/.*mb=\([0-9]*\).*/\1/p')
    line=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep macroblock_sealed | tail -1" 2>/dev/null || true)
    hh=$(echo "$line" | sed -n 's/.*head_h=\([0-9]*\).*/\1/p')
    sg=$(echo "$line" | sed -n 's/.*signers=\([0-9]*\).*/\1/p')
    sw=$(echo "$line" | sed -n 's/.*window=\([0-9]*\).*/\1/p')
    if [ -n "$hh" ] && [ -n "$sg" ] && [ -n "$sw" ] \
       && [ "$hh" -gt "${restart_h:-0}" ] && [ "$sg" -ge "$QUORUM" ] \
       && { [ -n "${REENTRY_SKIP_PARTICIPATION:-}" ] || { [ -n "$pmb" ] && [ "$sw" -ge "$pmb" ]; }; }; then
      seal="window=$sw head_h=$hh signers=$sg participated_mb=${pmb:-skipped}"; break
    fi
    sleep 10
  done
  if [ -z "$seal" ]; then
    echo "  [ERR] $id: no full-quorum seal above h=${restart_h:-?} that this node took part in, within ${REENTRY_TIMEOUT}s"
    echo "        (a node outside the consensus committee never logs validator=true — rerun with REENTRY_SKIP_PARTICIPATION=1)"
    fail_node "$id: M3 not met — roll stopped"
  fi
  echo "  M3 finality:  $seal"

  # M4 — no failover in the last metrics window, and the node has advanced at least a rotation's worth
  # of blocks since it answered. That is what the metrics line proves; it does not single out this
  # node's own producer slot, so read it as "the fleet ran clean while this node was back", which is
  # the property the roll needs before taking the next node out.
  prod=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    m=$(rsh "$ip" "$port" "docker logs $cont --since 6m 2>&1 | grep '\[METRICS\]\[FAILOVER\]' | tail -1" 2>/dev/null || true)
    now_h=$(rsh "$ip" "$port" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null | sed -n 's/.*h=\([0-9]*\).*/\1/p')
    case "$m" in
      *failover_events=0*max_timeout_round=0*|*max_timeout_round=0*failover_events=0*)
        if [ -n "$now_h" ] && [ $((now_h - ${restart_h:-0})) -ge 30 ]; then prod="$m"; break; fi;;
    esac
    sleep 10
  done
  if [ -z "$prod" ]; then
    fail_node "$id did not pass a clean rotation window within ${REENTRY_TIMEOUT}s — roll stopped"
  fi
  echo "  M4 production: no failover, +$(( ${now_h:-0} - ${restart_h:-0} )) blocks since re-entry"
  archive_old
done

echo "=== rolled: ${TARGETS[*]} ==="

# The fleet gate of a halted chain runs here once all six report the build just rolled; until then the
# roll that brings the last of them runs it. Not after a rollback: a target moved back to an ancestor of the
# build it ran leaves the chain as parked as before, and the gate would only time out on it.
if [ -n "${QNET_RECOVERY_HALTED:-}" ]; then
  behind=""; back=""
  for n in $(printf '%s\n' "${!NODE_IP[@]}" | sort); do
    nb=$(rsh "${NODE_IP[$n]}" "$(port_of "$n")" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null | tr -d '\r' \
      | sed -n 's/^ok .*build=\([^ ]*\).*/\1/p')
    [ -n "$NEW_BUILD" ] && [ "$nb" = "$NEW_BUILD" ] || behind="$behind $n=${nb:0:7}"
  done
  for n in "${TARGETS[@]}"; do
    ob="${ROLLED_FROM[$n]:-}"
    if [ -n "$NEW_BUILD" ] && [ -n "$ob" ] && [ "$ob" != "$NEW_BUILD" ] \
       && git -C "$REPO" merge-base --is-ancestor "$NEW_BUILD" "$ob" 2>/dev/null; then
      back="$back $n=${ob:0:7}"
    fi
  done
  if [ -n "$back" ]; then
    echo "=== fleet gate not run: this run moved$back back to its ancestor ${NEW_BUILD:0:7}; the chain stays as it was ==="
  elif [ -z "$NEW_BUILD" ]; then
    echo "=== fleet gate not run: the image is unstamped, so which nodes run it cannot be told; run it with"
    echo "    QNET_FLEET_GATE_ONLY=1 RECOVERY_RESTART_H=${RECOVERY_RESTART_H:-$ROLL_MAX_H} once all six run it ==="
  elif [ -n "$behind" ]; then
    echo "=== fleet gate deferred: not on build ${NEW_BUILD:0:7}:$behind ==="
  elif [ "${RECOVERY_RESTART_H:-$ROLL_MAX_H}" -eq 0 ]; then
    echo "[ERR] the parked height is unknown (no h= at M1) — run the fleet gate with RECOVERY_RESTART_H=<h>"; exit 1
  else
    # The parked height defaults to the highest height a node of this roll answered with at M1.
    fleet_gate "${RECOVERY_RESTART_H:-$ROLL_MAX_H}" $(printf '%s\n' "${!NODE_IP[@]}" | sort) || exit 1
  fi
fi
