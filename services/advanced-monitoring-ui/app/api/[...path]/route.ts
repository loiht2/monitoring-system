/** Same-origin proxy to advanced-monitoring-api.
 *
 * The browser calls /api/* on the UI's own origin and this handler forwards it server-side,
 * so no API address is baked into the page — that is what made the manifest cluster-specific.
 *
 * This is a route handler rather than a next.config.js rewrite because Next serializes
 * rewrite destinations into the build output: the upstream would be frozen at image-build
 * time and the deployment's MONITORING_API_UPSTREAM would be silently ignored.
 */
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

function upstream(): string {
  return process.env.MONITORING_API_UPSTREAM || 'http://127.0.0.1:8000';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${upstream()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const r = await fetch(target, { cache: 'no-store' });
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
  });
}
