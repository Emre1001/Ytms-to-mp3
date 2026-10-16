FROM python:3.11-slim

# ffmpeg converts to MP3; QuickJS lets yt-dlp solve YouTube's JavaScript challenges.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && curl -fsSL -o /usr/local/bin/qjs https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-linux-x86_64 \
    && chmod +x /usr/local/bin/qjs \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

# Long --timeout: ZIP downloads convert many tracks in one request.
CMD gunicorn --workers 2 --threads 4 --timeout 900 --bind 0.0.0.0:${PORT:-5000} app:app
