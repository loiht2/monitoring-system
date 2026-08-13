#!/bin/sh
# Write window.__ENV at container start. Baking NEXT_PUBLIC_* at build time would mean
# rebuilding the image per cluster, which is the trap the ML Platform's entrypoint avoids.
cat > /app/public/env.js <<EOF
window.__ENV = { MONITORING_API: "${MONITORING_API:-}" };
EOF
exec node server.js
