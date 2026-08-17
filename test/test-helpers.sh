#!/usr/bin/env bash
# Smoke test for the helper scripts. Checks they exist, are executable and parse.
set -euo pipefail
fail=0
for s in scripts/promq.sh scripts/prof-baseline.sh; do
  [ -x "$s" ]  || { echo "NOT EXECUTABLE: $s"; fail=1; }
  bash -n "$s" || { echo "SYNTAX ERROR: $s";   fail=1; }
done
python3 -c "import ast,sys; ast.parse(open('scripts/_promq_fmt.py').read())" \
  || { echo "SYNTAX ERROR: scripts/_promq_fmt.py"; fail=1; }
[ "$fail" -eq 0 ] && echo "helper scripts OK"
exit "$fail"
