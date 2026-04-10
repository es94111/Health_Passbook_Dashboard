# ── Stage 1: Build dashboard (Vite SPA) ──────────────────────────────────────
FROM node:22-alpine AS dashboard-build
WORKDIR /app
COPY dashboard/package*.json dashboard/
RUN npm ci --prefix dashboard
COPY dashboard/ dashboard/
RUN npm run build --prefix dashboard

# ── Stage 2: Compile server TypeScript ───────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /app
COPY server/package*.json server/
RUN npm ci --prefix server
COPY server/ server/
RUN npm run build --prefix server

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Production dependencies only
COPY --from=server-build /app/server/package*.json ./
RUN npm ci --omit=dev

# Compiled server
COPY --from=server-build /app/server/dist ./dist/

# Dashboard static files served by Express at /public
COPY --from=dashboard-build /app/dashboard/dist ./public/

# Persist health data and encryption key across restarts
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/index.js"]
