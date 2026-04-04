# FastAPI AI service only. Build with repository root as context.
# Set AI_BASE_URL on the backend service to this service’s public https URL.
FROM python:3.11-slim-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ai-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY ai-service/app ./app
ENV MODEL_DIR=/app/data/model
RUN mkdir -p /app/data/model
ENV PORT=8001
EXPOSE 8001
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
