FROM python:3.11-slim

# ffmpeg is required by yt-dlp for the MP3 conversion.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

# Long --timeout: ZIP downloads convert many tracks in one request.
CMD gunicorn --workers 2 --threads 4 --timeout 900 --bind 0.0.0.0:${PORT:-5000} app:app
