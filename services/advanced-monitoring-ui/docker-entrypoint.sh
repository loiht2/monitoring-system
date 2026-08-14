#!/bin/sh
# No runtime config is injected: the UI reaches the API through a same-origin /api proxy
# (app/api/[...path]/route.ts), read from MONITORING_API_UPSTREAM server-side, so nothing
# cluster-specific ever reaches the browser.
exec node server.js
