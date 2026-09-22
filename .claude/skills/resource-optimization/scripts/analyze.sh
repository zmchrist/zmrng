#!/usr/bin/env bash
# analyze.sh — reduce a sample.sh run to the numbers a plan can be argued from.
#
# Usage: analyze.sh [OUT_DIR]   (default /tmp/zmrng-perf)
#
# Prints: capacity, load distribution, CPU/IO/memory pressure, per-family CPU
# attribution, and total demand vs capacity. Percentiles, not means — a mean
# hides the saturation spikes that actually cause failures.
set -uo pipefail
OUT="${1:-/tmp/zmrng-perf}"
CORES=$(nproc)
N=$(wc -l < "$OUT/counts.log")
CAP=$((CORES * 100))

echo "=== capacity ==="
cat "$OUT/meta.txt" 2>/dev/null
echo "cores=$CORES  capacity=${CAP}%  samples=$N"

echo
echo "=== load average (1m) ==="
awk '{print $2}' "$OUT/load.log" | sort -n | awk '{a[NR]=$1}
  END{print "min",a[1]; print "p50",a[int(NR*0.5)]; print "p90",a[int(NR*0.9)]; print "max",a[NR]}'

echo
echo "=== total CPU demand across all procs (capacity ${CAP}%) ==="
awk '$2=="agg"{t[$1]+=$4} END{for(k in t) print t[k]}' "$OUT/agg.log" | sort -n | awk -v cap="$CAP" '{a[NR]=$1}
  END{printf "p50 %.0f%%  p90 %.0f%%  max %.0f%%  (capacity %d%%)\n", a[int(NR*0.5)], a[int(NR*0.9)], a[NR], cap}'

echo
echo "=== pressure (PSI 'some avg10' — which resource is actually stalling) ==="
for r in cpu io memory; do
  grep " $r some" "$OUT/psi.log" 2>/dev/null | sed 's/.*avg10=\([0-9.]*\).*/\1/' | sort -n | awk -v r="$r" '{a[NR]=$1}
    END{if(NR) printf "%-7s p50 %6.2f  p90 %6.2f  max %6.2f\n", r, a[int(NR*0.5)], a[int(NR*0.9)], a[NR]}'
done

echo
echo "=== memory ==="
awk '$2=="mem"{u+=$4;n++; if($4>mx)mx=$4} END{printf "used mean=%.0f MB  max=%.0f MB\n", u/n, mx}' "$OUT/mem.log"
awk '$2=="swap"{if($4>mx)mx=$4} END{printf "swap max used=%d MB\n", mx+0}' "$OUT/mem.log"

echo
echo "=== CPU attribution by command family (mean over $N samples) ==="
printf "%8s %9s %7s  %s\n" "CPU%" "RSS_MB" "COUNT" "COMMAND"
awk -v ns="$N" '$2=="agg"{c=$6; for(i=7;i<=NF;i++)c=c" "$i; cpu[c]+=$4; rss[c]+=$5; cnt[c]+=$3}
  END{for(k in cpu) printf "%8.1f %9.0f %7.1f  %s\n", cpu[k]/ns, rss[k]/ns/1024, cnt[k]/ns, k}' "$OUT/agg.log" \
  | sort -rn | head -18

echo
echo "=== process counts (min/mean/max) ==="
awk '{for(i=2;i<=NF;i++){split($i,kv,"=");k=kv[1];v=kv[2];s[k]+=v;n[k]++;
      if(!(k in mx)||v>mx[k])mx[k]=v; if(!(k in mn)||v<mn[k])mn[k]=v}}
  END{for(k in s) printf "%-8s min=%-4d mean=%-6.1f max=%d\n", k, mn[k], s[k]/n[k], mx[k]}' "$OUT/counts.log"
