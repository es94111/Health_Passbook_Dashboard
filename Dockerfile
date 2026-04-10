# ── Stage 1: Build dashboard (Vite SPA) ──────────────────────────────────────
FROM node:22-alpine AS dashboard-build
# VITE_GOOGLE_CLIENT_ID is a build-time arg — Vite bakes it into the JS bundle.
# Pass it via: docker build --build-arg VITE_GOOGLE_CLIENT_ID=xxx ...
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
WORKDIR /app
COPY dashboard/package*.json dashboard/
# Use npm install (not ci) — lock file generated on Windows/npm-11 omits some
# Linux-only optional deps (@emnapi/core, @emnapi/runtime) that npm-10 on Alpine
# would reject. ci is only needed for the lean production runtime stage.
RUN npm install --prefix dashboard
COPY dashboard/ dashboard/
RUN npm run build --prefix dashboard

# ── Stage 2: Compile server TypeScript ───────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /app
COPY server/package*.json server/
RUN npm install --prefix server
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
