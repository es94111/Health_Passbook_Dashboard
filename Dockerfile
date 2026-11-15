# ── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Optional private packages (@voho0000 via GitHub Packages) are skipped when no
# token is available; scripts/optional-build-config.mjs wires local fallbacks
# so the build works without registry credentials.
RUN npm ci --no-audit --no-fund

# ── Stage 2: Build Next.js app (standalone output) ───────────────────────────
FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Stage 3: Production runtime ──────────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Minimal standalone server traced by Next (node server.js)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Version history for release tooling / ops inspection (secrets-free)
COPY changelog.json ./changelog.json

# Opt in to Watchtower's label filter; Watchtower still needs to be running
# with WATCHTOWER_LABEL_ENABLE=true to update this container.
LABEL com.centurylinklabs.watchtower.enable="true"

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app

USER app

EXPOSE 3001

CMD ["node", "server.js"]
