# Web app: Node API + WebSocket + Vite static UI (no Python).
# Pair with a separate Railway service running ai-service/Dockerfile; set AI_BASE_URL to that service HTTPS URL.
#
# Build: docker build -f Dockerfile.app -t cryptrade-app .
# Railway: Config as code → deploy/railway-app.toml (or RAILWAY_DOCKERFILE_PATH=Dockerfile.app)

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
COPY public public
# Same-origin API + WebSocket when UI and API share this service’s URL
ENV VITE_BACKEND_HTTP=
RUN npm run build --workspace frontend

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev
COPY backend backend
COPY --from=build /app/frontend/dist ./frontend/dist
ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV SERVE_FRONTEND=1
ENV PORT=8000
EXPOSE 8000
CMD ["node", "backend/src/index.js"]
