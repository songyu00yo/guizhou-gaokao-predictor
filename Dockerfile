FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py colleges_chat.py ./
COPY backend ./backend
COPY static ./static
COPY data/artifacts/predictions_2027.json data/artifacts/model_report.json data/artifacts/segment_2026.json data/artifacts/runtime_manifest.json ./data/artifacts/

RUN useradd --create-home --uid 10001 appuser && mkdir -p /app/var/cache && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
