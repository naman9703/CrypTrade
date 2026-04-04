# Node API + WebSocket only (no Python). Build with repository root as context.
# Railway: set root to repo root, Dockerfile path `backend/Dockerfile`, or set subdirectory + adjust COPYs.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev
COPY backend backend
ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV SERVE_FRONTEND=0
ENV PORT=8000
EXPOSE 8000
CMD ["node", "backend/src/index.js"]
