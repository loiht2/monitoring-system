"""Format a Prometheus instant-query response as one line per series."""
import json
import sys

d = json.load(sys.stdin)

if d.get("status") != "success":
    print("QUERY FAILED:", d.get("error", "unknown"))
    sys.exit(1)

result = d["data"]["result"]
if not result:
    print("(empty result)")
    sys.exit(0)

for r in result:
    metric = r["metric"]
    name = metric.get("__name__", "")
    labels = ",".join(f"{k}={v}" for k, v in sorted(metric.items()) if k != "__name__")
    print(f'{r["value"][1]:>12}  {name}{{{labels}}}')
