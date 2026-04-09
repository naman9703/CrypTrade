#!/usr/bin/env bash
set -euo pipefail
# Run on the VPS from anywhere: ./deploy/vps-update.sh
# Resolves the repo root (directory containing docker-compose.yml).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/docker-compose.yml" ]]; then
  echo "error: docker-compose.yml not found under $ROOT" >&2
  exit 1
fi
cd "$ROOT"

git pull
docker compose up -d --build
sleep 3
curl -sS "http://127.0.0.1:8000/health" || true
echo
docker compose ps
