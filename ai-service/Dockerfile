# AI FastAPI service (XGBoost needs libgomp on Debian slim)
FROM python:3.11-slim-bookworm
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN mkdir -p /app/data/model /app/data/feedback
ENV AI_SERVICE_HOST=0.0.0.0
ENV AI_SERVICE_PORT=8001
ENV PYTHONUNBUFFERED=1
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
