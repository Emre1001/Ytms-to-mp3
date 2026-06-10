"""
YT Music -> MP3 Downloader

A small Flask web app that takes a YouTube / YouTube Music playlist (or a
single video) URL, lists the tracks, and lets you download each one as an MP3
or grab the whole selection as a single ZIP.

Requirements (system): ffmpeg must be installed and on PATH for MP3 conversion.
Python deps: see requirements.txt (Flask, yt-dlp).
"""

import io
import os
import re
import shutil
import tempfile
import threading
import zipfile

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_file,
)

import yt_dlp

app = Flask(__name__)

# Default audio quality in kbps for the MP3 conversion.
AUDIO_BITRATE = os.environ.get("AUDIO_BITRATE", "192")

# Bitrates the user is allowed to request from the UI.
ALLOWED_BITRATES = {"128", "192", "256", "320"}

# Limit how many tracks we will accept in one ZIP request to avoid abuse.
MAX_ZIP_TRACKS = int(os.environ.get("MAX_ZIP_TRACKS", "100"))


def clean_bitrate(value) -> str:
    """Return a validated bitrate string, falling back to the default."""
    value = str(value or "").strip()
    return value if value in ALLOWED_BITRATES else AUDIO_BITRATE


# Places we look for a Netscape-format cookies.txt. On Render, secret files
# are mounted read-only under /etc/secrets/.
_COOKIE_CANDIDATES = [
    os.environ.get("COOKIES_FILE", ""),
    "/etc/secrets/cookies.txt",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt"),
]
_cookie_copy = None
_cookie_lock = threading.Lock()


def cookie_file():
    """Return a writable copy of the configured cookies.txt, or None.

    yt-dlp rewrites the cookie file on exit, which fails on read-only mounts
    like Render secret files — so we hand it a temp copy instead.
    """
    global _cookie_copy
    with _cookie_lock:
        if _cookie_copy and os.path.exists(_cookie_copy):
            return _cookie_copy
        for path in _COOKIE_CANDIDATES:
            if path and os.path.isfile(path):
                fd, tmp = tempfile.mkstemp(prefix="cookies_", suffix=".txt")
                with open(path, "rb") as src, os.fdopen(fd, "wb") as dst:
                    dst.write(src.read())
                _cookie_copy = tmp
                return tmp
    return None


def base_ydl_opts() -> dict:
    """Common yt-dlp options: quiet + optional cookies / proxy / player client."""
    opts = {"quiet": True, "no_warnings": True}
    cookies = cookie_file()
    if cookies:
        opts["cookiefile"] = cookies
    proxy = os.environ.get("PROXY_URL")
    if proxy:
        opts["proxy"] = proxy
    player_client = os.environ.get("YT_PLAYER_CLIENT")
    if player_client:
        clients = [c.strip() for c in player_client.split(",") if c.strip()]
        if clients:
            opts["extractor_args"] = {"youtube": {"player_client": clients}}
    return opts


def friendly_error(exc) -> str:
    """Translate common yt-dlp failures into actionable German messages."""
    msg = str(exc)
    if "Sign in to confirm" in msg or "not a bot" in msg:
        return (
            "YouTube blockiert die Server-IP (Bot-Schutz). "
            "Hinterlege eine cookies.txt als Secret File (siehe README, "
            "Abschnitt 'YouTube-Cookies')."
        )
    if "Video unavailable" in msg:
        return "Video nicht verfügbar (gelöscht, privat oder regional gesperrt)."
    if "age" in msg.lower() and "restrict" in msg.lower():
        return "Altersbeschränktes Video – dafür werden YouTube-Cookies benötigt."
    # Strip the noisy "ERROR: [youtube] xyz:" prefix yt-dlp adds.
    msg = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*[\w-]*:?\s*)?", "", msg)
    return msg[:300]

_INVALID_FS_CHARS = re.compile(r'[\\/:*?"<>|]')


def safe_filename(name: str) -> str:
    """Turn an arbitrary track title into a filesystem-safe filename."""
    name = _INVALID_FS_CHARS.sub("_", name).strip()
    name = re.sub(r"\s+", " ", name)
    return name[:180] or "track"


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def extract_playlist(url: str) -> dict:
    """Return a dict with playlist title and a list of entries.

    Uses extract_flat so we don't resolve every video up front — fast and
    cheap, just enough to render the track list.
    """
    ydl_opts = {
        **base_ydl_opts(),
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    entries = []
    raw_entries = info.get("entries")
    if raw_entries is None:
        # A single video / track, not a playlist.
        raw_entries = [info]

    for entry in raw_entries:
        if not entry:
            continue
        video_id = entry.get("id")
        if not video_id:
            continue
        title = entry.get("title") or "Unknown title"
        uploader = entry.get("uploader") or entry.get("channel") or ""
        duration = entry.get("duration")
        thumb = None
        thumbs = entry.get("thumbnails")
        if thumbs:
            thumb = thumbs[-1].get("url")
        elif entry.get("thumbnail"):
            thumb = entry.get("thumbnail")
        entries.append(
            {
                "id": video_id,
                "title": title,
                "uploader": uploader,
                "duration": duration,
                "thumbnail": thumb,
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
        )

    return {
        "title": info.get("title") or "Playlist",
        "count": len(entries),
        "entries": entries,
    }


def download_track_to_dir(video_url: str, out_dir: str, bitrate: str = AUDIO_BITRATE) -> str:
    """Download a single track as MP3 into out_dir, return the file path."""
    outtmpl = os.path.join(out_dir, "%(title)s.%(ext)s")
    ydl_opts = {
        **base_ydl_opts(),
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": bitrate,
            }
        ],
        # Embed metadata + thumbnail so the MP3 looks nice in players.
        "writethumbnail": False,
        "postprocessor_args": [],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=True)

    # After post-processing the file ends in .mp3.
    base = ydl.prepare_filename(info)
    mp3_path = os.path.splitext(base)[0] + ".mp3"
    if not os.path.exists(mp3_path):
        # Fallback: find any mp3 in the dir.
        for f in os.listdir(out_dir):
            if f.lower().endswith(".mp3"):
                mp3_path = os.path.join(out_dir, f)
                break
    return mp3_path


@app.route("/")
def index():
    bitrates = sorted(ALLOWED_BITRATES, key=int)
    return render_template(
        "index.html",
        ffmpeg=ffmpeg_available(),
        bitrates=bitrates,
        default_bitrate=AUDIO_BITRATE,
    )


@app.route("/api/playlist", methods=["POST"])
def api_playlist():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Bitte eine Playlist- oder Video-URL angeben."}), 400
    try:
        result = extract_playlist(url)
    except Exception as exc:  # noqa: BLE001 - surface yt-dlp errors to the UI
        return jsonify({"error": f"Konnte die Playlist nicht laden: {friendly_error(exc)}"}), 502
    if not result["entries"]:
        return jsonify({"error": "Keine Titel in dieser Playlist gefunden."}), 404
    return jsonify(result)


@app.route("/api/download", methods=["GET"])
def api_download():
    """Download a single track as MP3 and stream it to the browser."""
    video_id = (request.args.get("id") or "").strip()
    if not video_id or not re.fullmatch(r"[\w-]{6,20}", video_id):
        return jsonify({"error": "Ungültige Video-ID."}), 400
    if not ffmpeg_available():
        return jsonify({"error": "ffmpeg ist nicht installiert (für MP3 nötig)."}), 500

    bitrate = clean_bitrate(request.args.get("bitrate"))
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    tmp_dir = tempfile.mkdtemp(prefix="ytmp3_")
    try:
        mp3_path = download_track_to_dir(video_url, tmp_dir, bitrate)
        if not os.path.exists(mp3_path):
            return jsonify({"error": "Download fehlgeschlagen."}), 502
        download_name = safe_filename(os.path.splitext(os.path.basename(mp3_path))[0]) + ".mp3"
        # Read into memory so we can clean up the temp dir immediately.
        with open(mp3_path, "rb") as fh:
            buf = io.BytesIO(fh.read())
        buf.seek(0)
        return send_file(
            buf,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name=download_name,
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Download fehlgeschlagen: {friendly_error(exc)}"}), 502
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.route("/api/download-zip", methods=["POST"])
def api_download_zip():
    """Download multiple tracks and bundle them into a single ZIP."""
    if not ffmpeg_available():
        return jsonify({"error": "ffmpeg ist nicht installiert (für MP3 nötig)."}), 500

    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    zip_name = safe_filename(data.get("name") or "playlist")
    bitrate = clean_bitrate(data.get("bitrate"))

    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "Keine Titel ausgewählt."}), 400
    ids = [i for i in ids if isinstance(i, str) and re.fullmatch(r"[\w-]{6,20}", i)]
    if not ids:
        return jsonify({"error": "Keine gültigen Titel ausgewählt."}), 400
    if len(ids) > MAX_ZIP_TRACKS:
        return jsonify({"error": f"Maximal {MAX_ZIP_TRACKS} Titel pro ZIP."}), 400

    # Optional id -> title map from the frontend, for readable skip reports.
    titles = data.get("titles") if isinstance(data.get("titles"), dict) else {}

    tmp_dir = tempfile.mkdtemp(prefix="ytmp3zip_")
    zip_buf = io.BytesIO()
    try:
        skipped = []  # (title, reason) for every track that failed
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            used_names = set()
            for video_id in ids:
                track_dir = tempfile.mkdtemp(prefix="t_", dir=tmp_dir)
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                label = str(titles.get(video_id) or video_id)
                try:
                    mp3_path = download_track_to_dir(video_url, track_dir, bitrate)
                except Exception as exc:  # noqa: BLE001 - skip failed tracks, keep going
                    skipped.append((label, friendly_error(exc)))
                    continue
                if not mp3_path or not os.path.exists(mp3_path):
                    skipped.append((label, "Konvertierung lieferte keine MP3-Datei."))
                    continue
                arc = safe_filename(os.path.splitext(os.path.basename(mp3_path))[0]) + ".mp3"
                # Avoid name collisions inside the archive.
                candidate = arc
                n = 2
                while candidate in used_names:
                    candidate = f"{arc[:-4]} ({n}).mp3"
                    n += 1
                used_names.add(candidate)
                zf.write(mp3_path, arcname=candidate)

            if not used_names:
                detail = f" Grund: {skipped[-1][1]}" if skipped else ""
                return jsonify({"error": f"Kein Titel konnte heruntergeladen werden.{detail}"}), 502

            if skipped:
                report = "Diese Titel konnten nicht heruntergeladen werden:\n\n"
                report += "\n".join(f"- {title}\n  Grund: {reason}" for title, reason in skipped)
                zf.writestr("_Uebersprungene Titel.txt", report)

        zip_buf.seek(0)
        response = send_file(
            zip_buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{zip_name}.zip",
        )
        # Counts for the UI status line ("X geladen, Y übersprungen").
        response.headers["X-Tracks-Ok"] = str(len(used_names))
        response.headers["X-Tracks-Skipped"] = str(len(skipped))
        return response
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=bool(os.environ.get("DEBUG")))
