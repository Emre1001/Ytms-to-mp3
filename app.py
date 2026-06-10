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

# Audio quality in kbps for the MP3 conversion.
AUDIO_BITRATE = os.environ.get("AUDIO_BITRATE", "192")

# Limit how many tracks we will accept in one ZIP request to avoid abuse.
MAX_ZIP_TRACKS = int(os.environ.get("MAX_ZIP_TRACKS", "100"))

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
        "quiet": True,
        "no_warnings": True,
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


def download_track_to_dir(video_url: str, out_dir: str) -> str:
    """Download a single track as MP3 into out_dir, return the file path."""
    outtmpl = os.path.join(out_dir, "%(title)s.%(ext)s")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": AUDIO_BITRATE,
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
    return render_template("index.html", ffmpeg=ffmpeg_available())


@app.route("/api/playlist", methods=["POST"])
def api_playlist():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Bitte eine Playlist- oder Video-URL angeben."}), 400
    try:
        result = extract_playlist(url)
    except Exception as exc:  # noqa: BLE001 - surface yt-dlp errors to the UI
        return jsonify({"error": f"Konnte die Playlist nicht laden: {exc}"}), 502
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

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    tmp_dir = tempfile.mkdtemp(prefix="ytmp3_")
    try:
        mp3_path = download_track_to_dir(video_url, tmp_dir)
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
        return jsonify({"error": f"Download fehlgeschlagen: {exc}"}), 502
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

    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "Keine Titel ausgewählt."}), 400
    ids = [i for i in ids if isinstance(i, str) and re.fullmatch(r"[\w-]{6,20}", i)]
    if not ids:
        return jsonify({"error": "Keine gültigen Titel ausgewählt."}), 400
    if len(ids) > MAX_ZIP_TRACKS:
        return jsonify({"error": f"Maximal {MAX_ZIP_TRACKS} Titel pro ZIP."}), 400

    tmp_dir = tempfile.mkdtemp(prefix="ytmp3zip_")
    zip_buf = io.BytesIO()
    try:
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            used_names = set()
            for video_id in ids:
                track_dir = tempfile.mkdtemp(prefix="t_", dir=tmp_dir)
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                try:
                    mp3_path = download_track_to_dir(video_url, track_dir)
                except Exception:  # noqa: BLE001 - skip failed tracks, keep going
                    continue
                if not mp3_path or not os.path.exists(mp3_path):
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
                return jsonify({"error": "Kein Titel konnte heruntergeladen werden."}), 502

        zip_buf.seek(0)
        return send_file(
            zip_buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{zip_name}.zip",
        )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=bool(os.environ.get("DEBUG")))
