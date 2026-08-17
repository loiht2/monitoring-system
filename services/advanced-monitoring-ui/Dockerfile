FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next's standalone server.js defaults to :3000; the manifest and EXPOSE below use 3002.
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3002
# No entrypoint script: nothing cluster-specific is injected at start. The UI reaches
# the API through a same-origin /api proxy (app/api/[...path]/route.ts) resolved from
# MONITORING_API_UPSTREAM server-side, so no address ever reaches the browser.
CMD ["node", "server.js"]
