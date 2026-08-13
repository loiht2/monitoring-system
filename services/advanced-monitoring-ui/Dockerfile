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
# public/ must be writable: the entrypoint writes env.js into it as the unprivileged user.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 3002
ENTRYPOINT ["./docker-entrypoint.sh"]
