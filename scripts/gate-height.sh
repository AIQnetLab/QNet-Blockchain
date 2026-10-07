#!/usr/bin/env bash
# The activation height to give a consensus gate at push time: the first epoch boundary at least LEAD
# blocks (7 days at one block a second) above the fleet tip. deploy-genesis.sh then refuses the roll
# unless every added or moved gate is still GATE_MARGIN blocks above the tip when the roll starts, so run
# this right before the push and set the value it prints (with its comment) in
# core/qnet-state/src/feature_gates.rs.
#
#   ./gate-height.sh            # tip read from the five genesis nodes over HTTPS
#   ./gate-height.sh 2241840    # from a tip read by hand
#
# Read-only: it changes nothing on any host or in the tree.
set -euo pipefail

EPOCH=14400
LEAD="${LEAD:-604800}"
GATE_MARGIN="${GATE_MARGIN:-28800}"
case "$LEAD$GATE_MARGIN" in *[!0-9]*) echo "[ERR] LEAD and GATE_MARGIN are block counts"; exit 1;; esac

tip="${1:-}"
if [ -z "$tip" ]; then
  tip=0
  for n in 1 2 3 4 5; do
    h=$(curl -fsS -m 8 "https://node$n.aiqnet.io/healthz" 2>/dev/null | sed -n 's/.*h=\([0-9]*\).*/\1/p' || true)
    if [ -z "$h" ]; then echo "  node$n: no answer"; continue; fi
    echo "  node$n: h=$h"
    [ "$h" -gt "$tip" ] && tip=$h
  done
  [ "$tip" -gt 0 ] || { echo "[ERR] no genesis answered; pass the tip by hand"; exit 1; }
fi
case "$tip" in ''|*[!0-9]*) echo "[ERR] the tip must be a block height"; exit 1;; esac

gate=$(( (tip + LEAD + EPOCH - 1) / EPOCH * EPOCH ))
[ "$gate" -gt $((tip + GATE_MARGIN)) ] || { echo "[ERR] LEAD must exceed GATE_MARGIN"; exit 1; }
s=$gate; underscored=""
while [ ${#s} -gt 3 ]; do underscored="_${s: -3}$underscored"; s=${s:0:${#s}-3}; done
underscored="$s$underscored"
echo "tip $tip -> gate $gate (epoch $((gate / EPOCH)), $((gate - tip)) blocks ahead)"
echo "feature_gates.rs: pub const <NAME>_GATE_HEIGHT: u64 = $underscored;"
