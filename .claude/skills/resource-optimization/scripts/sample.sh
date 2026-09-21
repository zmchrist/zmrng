#!/usr/bin/env bash
# sample.sh — fixed-interval system resource sampler for the resource-optimization loop.
#
# Usage: sample.sh [OUT_DIR] [SAMPLES] [INTERVAL_SECS]
# Default: /tmp/zmrng-perf 60 5   (== 5 minutes)
#
# Writes one append-only log per dimension, each line prefixed with a unix
# timestamp so the analyze step can join them. Run it in the BACKGROUND and let
# the real workload proceed — a sampler that changes the workload is measuring
# itself.
set -uo pipefail

OUT="${1:-/tmp/zmrng-perf}"
SAMPLES="${2:-60}"
INTERVAL="${3:-5}"

mkdir -p "$OUT"
rm -f "$OUT"/{load,mem,ps,agg,counts,psi}.log "$OUT/done"

# Record the machine's capacity up front — every later ratio depends on it.
{
  echo "cores=$(nproc)"
  echo "samples=$SAMPLES interval=${INTERVAL}s"
  free -m | awk '/^Mem:/{print "mem_total_mb="$2}'
} > "$OUT/meta.txt"

for _ in $(seq 1 "$SAMPLES"); do
  TS=$(date +%s)

  echo "$TS $(cat /proc/loadavg)" >> "$OUT/load.log"

  free -m | awk -v t=$TS '/^Mem:/{print t,"mem",$2,$3,$4,$6,$7} /^Swap:/{print t,"swap",$2,$3}' >> "$OUT/mem.log"

  ps -eo pid,ppid,pcpu,pmem,rss,etimes,comm --sort=-pcpu --no-headers \
    | head -30 | sed "s/^/$TS /" >> "$OUT/ps.log"

  # Aggregate CPU% and RSS by command family — this is the attribution step that
  # turns "the box is busy" into "X is what is busy".
  ps -eo pcpu,rss,comm --no-headers | awk -v t=$TS '
    {c=$3; for(i=4;i<=NF;i++) c=c" "$i; cpu[c]+=$1; rss[c]+=$2; n[c]++}
    END{for(k in cpu) print t,"agg",n[k],cpu[k],rss[k],k}' >> "$OUT/agg.log"

  # Per-family process counts. Edit this line for the fleet you are profiling.
  echo "$TS claude=$(pgrep -c -x claude) node=$(pgrep -c -x node) vitest=$(pgrep -fc vitest) esbuild=$(pgrep -c -x esbuild) tsc=$(pgrep -fc tsc) git=$(pgrep -c -x git)" >> "$OUT/counts.log"

  # Pressure Stall Information — the single best signal for "is this CPU, IO or
  # memory?". Load average alone cannot tell those apart.
  for r in cpu io memory; do
    sed "s/^/$TS $r /" "/proc/pressure/$r" >> "$OUT/psi.log" 2>/dev/null
  done

  sleep "$INTERVAL"
done

echo DONE > "$OUT/done"
