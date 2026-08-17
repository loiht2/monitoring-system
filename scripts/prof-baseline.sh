#!/usr/bin/env bash
# Sample every DCGM_FI_PROF_* field and print a stable, diffable table.
# Run this under an identical GPU load before and after a field-list change,
# then diff the two outputs. See specs/09 A-1.
# Usage: scripts/prof-baseline.sh <output-file> [sample-seconds]
set -euo pipefail

OUT="${1:?usage: prof-baseline.sh <output-file> [sample-seconds]}"
WINDOW="${2:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "sampling for ${WINDOW}s ..." >&2
sleep "$WINDOW"

: > "$OUT"
# promq.sh prints "<value>  <name>{labels}", so the NAME is field 2. Do not
# strip all spaces: that glues the value onto the name and every query built
# from it becomes invalid PromQL.
# Two steps on purpose. promq.sh failing must still abort loudly, but grep
# matching nothing must NOT: under `set -e` with pipefail, grep's exit 1 makes
# the whole assignment fail and the script dies BEFORE the guard below can
# report why. `|| true` on the second assignment only is what keeps both.
RAW=$("$HERE/promq.sh" 'group by (__name__) ({__name__=~"DCGM_FI_PROF_.*"})')
FIELDS=$(printf '%s\n' "$RAW" \
           | awk '{print $2}' | sed 's/{.*//' | grep -E '^DCGM_FI_PROF_' | sort || true)
if [ -z "$FIELDS" ]; then
  echo "no DCGM_FI_PROF_* metrics found — is the exporter scraped?" >&2
  exit 1
fi

for field in $FIELDS; do
  "$HERE/promq.sh" "avg_over_time(${field}[${WINDOW}s])" \
    | sed "s/^/${field} /" >> "$OUT"
done
sort -o "$OUT" "$OUT"
echo "wrote $OUT" >&2
cat "$OUT"
