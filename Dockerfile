# Production image: Node backend + built SPA (SERVE_FRONTEND=1, same-origin /api + /ws).
# Build: docker build -t trading-app .
# Run with compose (recommended): see docker-compose.yml
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN npm ci
COPY frontend ./frontend
COPY public ./public
# Same host as UI: empty = relative /api (see frontend/src/api/client.ts)
ENV VITE_BACKEND_HTTP=
ENV VITE_BACKEND_WS=
RUN npm run build --workspace frontend

FROM node:22-bookworm-slim AS runner
WORKDIR /app/backend
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Backend has no workspace-local lockfile; install from package.json only.
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
ENV SERVE_FRONTEND=1
EXPOSE 8000
CMD ["node", "src/index.js"]
