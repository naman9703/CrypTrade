# Static UI + `serve`. Build with repository root as context.
# Railway build args (example): VITE_BACKEND_HTTP=https://your-backend.up.railway.app
# WebSocket defaults from VITE_BACKEND_HTTP if VITE_BACKEND_WS unset (see store.ts).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG VITE_BACKEND_HTTP=
ARG VITE_BACKEND_WS=
ENV VITE_BACKEND_HTTP=$VITE_BACKEND_HTTP
ENV VITE_BACKEND_WS=$VITE_BACKEND_WS
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci
COPY frontend frontend
COPY public public
RUN npm run build --workspace frontend

FROM node:22-bookworm-slim
RUN npm install -g serve@14
WORKDIR /srv
COPY --from=build /app/frontend/dist ./dist
COPY frontend/docker-entrypoint-serve.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
