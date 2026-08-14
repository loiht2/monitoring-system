/** @type {import('next').NextConfig} */
// The browser calls /api/* on the UI's own origin; app/api/[...path]/route.ts proxies to
// the API server-side, reading MONITORING_API_UPSTREAM per request. This removes the need
// for the browser to know any API address, which is what made the manifest
// cluster-specific, and removes cross-origin requests entirely. A rewrite is deliberately
// not used here: Next bakes rewrite destinations into the build, which would freeze the
// upstream at image-build time.
module.exports = { output: 'standalone' };
