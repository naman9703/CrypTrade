# Single Railway service: Python AI (internal) + Node API + Vite static UI
FROM node:22-bookworm-slim

# libgomp1: required for XGBoost OpenMP on Debian slim (otherwise import fails → HistGradientBoosting fallback)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-venv python3-pip curl libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN npm ci

COPY backend backend
COPY frontend frontend
COPY ai-service ai-service
COPY public public
COPY scripts/docker-entrypoint.sh scripts/docker-entrypoint.sh

RUN chmod +x scripts/docker-entrypoint.sh

# Python deps for AI (CPU wheels on linux/amd64)
RUN python3 -m venv ai-service/.venv \
  && ai-service/.venv/bin/pip install --no-cache-dir -r ai-service/requirements.txt

# Same-origin API + WebSocket in production (empty = relative URLs)
RUN VITE_BACKEND_HTTP= npm run build:frontend

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV PORT=8000
ENV AI_BASE_URL=http://127.0.0.1:8001
ENV SERVE_FRONTEND=1

EXPOSE 8000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
