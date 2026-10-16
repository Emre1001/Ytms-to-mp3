"""
YT Music -> MP3 Downloader

A small Flask web app that takes a YouTube / YouTube Music playlist (or a
single video) URL, lists the tracks, and lets you download each one as an MP3
or grab the whole selection as a single ZIP.

Requirements (system): ffmpeg must be installed and on PATH for MP3 conversion
(or FFMPEG_LOCATION must point at it, as the desktop app does).
Python deps: see requirements.txt (Flask, yt-dlp).
"""

import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_file,
)

import yt_dlp
from yt_dlp.postprocessor.metadataparser import MetadataParserPP

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)


def _read_version() -> str:
    try:
        with open(os.path.join(BASE_DIR, "VERSION"), encoding="utf-8") as fh:
            return fh.read().strip() or "dev"
    except OSError:
        return "dev"


APP_VERSION = _read_version()

# Default audio quality in kbps for the MP3 conversion.
AUDIO_BITRATE = os.environ.get("AUDIO_BITRATE", "192")

# Bitrates the user is allowed to request from the UI.
ALLOWED_BITRATES = {"128", "192", "256", "320"}

# Limit how many tracks we will accept in one ZIP request to avoid abuse.
MAX_ZIP_TRACKS = int(os.environ.get("MAX_ZIP_TRACKS", "100"))

# ffmpeg binary or the folder that holds it; default is whatever is on PATH.
FFMPEG_LOCATION = os.environ.get("FFMPEG_LOCATION") or None

# Write title/artist/album tags and the (square-cropped) cover into each MP3.
EMBED_META = os.environ.get("EMBED_META", "1") != "0"

# The desktop app sets a random token and sends it with every request, so
# other local programs or websites can't drive the local server.
ACCESS_TOKEN = os.environ.get("YTMP3_TOKEN") or None

# Cache-buster for static/style.css and static/app.js.
_STATIC = os.path.join(BASE_DIR, "static")
ASSET_VERSION = str(int(max(
    (os.path.getmtime(os.path.join(_STATIC, f)) for f in os.listdir(_STATIC)),
    default=0,
)))


def clean_bitrate(value) -> str:
    """Return a validated bitrate string, falling back to the default."""
    value = str(value or "").strip()
    return value if value in ALLOWED_BITRATES else AUDIO_BITRATE


# Places we look for a Netscape-format cookies.txt. On Render, secret files
# are mounted read-only under /etc/secrets/.
_COOKIE_CANDIDATES = [
    os.environ.get("COOKIES_FILE", ""),
    "/etc/secrets/cookies.txt",
    os.path.join(BASE_DIR, "cookies.txt"),
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


def js_runtimes() -> dict:
    """JavaScript runtimes yt-dlp may use for YouTube's player challenges.

    The desktop app points YTMP3_NODE at Electron's built-in Node and ships
    QuickJS (YTMP3_QJS) as a fallback; otherwise whatever is installed is used.
    Runtimes that aren't found are simply skipped by yt-dlp.
    """
    node = os.environ.get("YTMP3_NODE")
    qjs = os.environ.get("YTMP3_QJS") or shutil.which("qjs")
    return {
        "deno": {},
        "node": {"path": node} if node else {},
        "bun": {},
        "quickjs": {"path": qjs} if qjs else {},
    }


def base_ydl_opts() -> dict:
    """Common yt-dlp options: quiet + optional cookies / proxy / player client."""
    opts = {"quiet": True, "no_warnings": True, "noprogress": True, "js_runtimes": js_runtimes()}
    if FFMPEG_LOCATION:
        opts["ffmpeg_location"] = FFMPEG_LOCATION
    if os.environ.get("YTMP3_CACHE"):
        opts["cachedir"] = os.environ["YTMP3_CACHE"]
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


def ffmpeg_path():
    """Path of the ffmpeg binary that yt-dlp will use, or None."""
    if FFMPEG_LOCATION:
        exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        path = os.path.join(FFMPEG_LOCATION, exe) if os.path.isdir(FFMPEG_LOCATION) else FFMPEG_LOCATION
        return path if os.path.isfile(path) else None
    return shutil.which("ffmpeg")


def ffmpeg_available() -> bool:
    return ffmpeg_path() is not None


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

    cover = None
    if info.get("entries") is not None:
        thumbs = info.get("thumbnails") or []
        if thumbs:
            cover = thumbs[-1].get("url")
    return {
        "title": info.get("title") or "Playlist",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "thumbnail": cover,
        "is_playlist": info.get("entries") is not None,
        "count": len(entries),
        "entries": entries,
    }


# Square-crop the thumbnail: YouTube Music covers sit letterboxed in a 16:9 frame.
_COVER_ARGS = ["-c:v", "mjpeg", "-qmin", "1", "-qscale:v", "3",
               "-vf", "crop='if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"]


def download_track_to_dir(
    video_url: str,
    out_dir: str,
    bitrate: str = AUDIO_BITRATE,
    progress_hooks=None,
    postprocessor_hooks=None,
) -> str:
    """Download a single track as MP3 into out_dir, return the file path."""
    # "Artist - Title.mp3" when yt-dlp knows the artist (YouTube Music), else the video title.
    outtmpl = os.path.join(out_dir, "%(artist&{} - |)s%(track,title)s.%(ext)s")
    postprocessors = [
        {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": bitrate},
    ]
    if EMBED_META:
        postprocessors = [
            # Long video descriptions don't belong in ID3 tags.
            {"key": "MetadataParser", "when": "pre_process", "actions": [
                (MetadataParserPP.Actions.INTERPRET, "", "(?P<meta_description>)"),
                (MetadataParserPP.Actions.INTERPRET, "", "(?P<meta_synopsis>)"),
            ]},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            *postprocessors,
            {"key": "FFmpegMetadata", "add_metadata": True},
            {"key": "EmbedThumbnail", "already_have_thumbnail": False},
        ]
    ydl_opts = {
        **base_ydl_opts(),
        "progress_hooks": progress_hooks or [],
        "postprocessor_hooks": postprocessor_hooks or [],
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": postprocessors,
        "writethumbnail": EMBED_META,
        "postprocessor_args": {"thumbnailsconvertor+ffmpeg_o": _COVER_ARGS},
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(video_url, download=True)
        except yt_dlp.utils.PostProcessingError:
            # Tags or cover failed, but the MP3 itself is usually there — keep it.
            info = None
            if not any(f.lower().endswith(".mp3") for f in os.listdir(out_dir)):
                raise

    mp3_path = ""
    if info:
        # After post-processing the file ends in .mp3.
        mp3_path = os.path.splitext(ydl.prepare_filename(info))[0] + ".mp3"
    if not os.path.exists(mp3_path):
        # Fallback: find any mp3 in the dir.
        for f in os.listdir(out_dir):
            if f.lower().endswith(".mp3"):
                mp3_path = os.path.join(out_dir, f)
                break
    return mp3_path


@app.before_request
def require_token():
    if ACCESS_TOKEN and request.headers.get("X-YTMP3-Token") != ACCESS_TOKEN:
        return jsonify({"error": "Kein Zugriff."}), 403


@app.route("/")
def index():
    bitrates = sorted(ALLOWED_BITRATES, key=int)
    return render_template(
        "index.html",
        ffmpeg=ffmpeg_available(),
        bitrates=bitrates,
        default_bitrate=AUDIO_BITRATE,
        max_zip=MAX_ZIP_TRACKS,
        version=ASSET_VERSION,
        app_version=APP_VERSION,
    )


@app.route("/api/info", methods=["GET"])
def api_info():
    """Versions for the settings panel (and a quick health check)."""
    return jsonify({
        "version": APP_VERSION,
        "ytdlp": yt_dlp.version.__version__,
        "ffmpeg": ffmpeg_available(),
        "update": UPDATE_STATE,
    })


# The desktop launcher fills this in when it fetched a newer yt-dlp.
UPDATE_STATE = {}


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


# ---------------------------------------------------------------------------
# Background jobs with live progress
#
# The UI starts a job, polls its state and fetches the finished file. State
# lives on disk (one folder per job) so every gunicorn worker can answer the
# polls, no matter which worker runs the download.
# ---------------------------------------------------------------------------

JOBS_DIR = os.path.join(tempfile.gettempdir(), "ytmp3_jobs")
JOB_TTL = int(os.environ.get("JOB_TTL", "1800"))  # seconds a finished job is kept
MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL", "3"))  # per worker process
_slots = threading.BoundedSemaphore(MAX_PARALLEL)
_VIDEO_ID = re.compile(r"[\w-]{6,20}")
_JOB_ID = re.compile(r"[0-9a-f]{32}")


class Cancelled(Exception):
    pass


def job_dir(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def read_job(job_id: str):
    if not _JOB_ID.fullmatch(job_id or ""):
        return None
    try:
        with open(os.path.join(job_dir(job_id), "state.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def sweep_jobs():
    """Delete job folders older than JOB_TTL."""
    try:
        names = os.listdir(JOBS_DIR)
    except OSError:
        return
    limit = time.time() - JOB_TTL
    for name in names:
        path = os.path.join(JOBS_DIR, name)
        try:
            if os.path.getmtime(path) < limit:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


class Job:
    """One MP3 or ZIP job. Writes its state to state.json, throttled."""

    def __init__(self, kind, tracks, bitrate, name):
        self.id = uuid.uuid4().hex
        self.dir = job_dir(self.id)
        os.makedirs(self.dir, exist_ok=True)
        self.bitrate = bitrate
        self.state = {
            "id": self.id,
            "kind": kind,
            "name": name,
            "status": "queue",
            "error": "",
            "ok": 0,
            "skipped": 0,
            "file": None,
            "tracks": [
                {"id": vid, "title": title, "status": "queue", "pct": 0,
                 "speed": 0, "eta": None, "error": ""}
                for vid, title in tracks
            ],
        }
        self._last_write = 0.0
        self.write(force=True)

    def write(self, force=False):
        now = time.monotonic()
        if not force and now - self._last_write < 0.25:
            return
        self._last_write = now
        tmp = os.path.join(self.dir, "state.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.state, fh)
        os.replace(tmp, os.path.join(self.dir, "state.json"))

    def cancelled(self):
        return os.path.exists(os.path.join(self.dir, "cancel"))

    def fetch(self, track, out_dir):
        """Download one track into out_dir, reporting progress into track."""

        def on_progress(d):
            if self.cancelled():
                raise Cancelled()
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                got = d.get("downloaded_bytes") or 0
                track["status"] = "download"
                track["pct"] = round(got / total * 100, 1) if total else 0
                track["speed"] = d.get("speed") or 0
                track["eta"] = d.get("eta")
                self.write()
            elif d.get("status") == "finished":
                track.update(status="convert", pct=100, speed=0, eta=None)
                self.write(force=True)

        def on_post(d):
            if self.cancelled():
                raise Cancelled()
            if d.get("status") == "started" and track["status"] != "convert":
                track.update(status="convert", pct=100, speed=0, eta=None)
                self.write(force=True)

        track.update(status="download", pct=0)
        self.write(force=True)
        return download_track_to_dir(
            f"https://www.youtube.com/watch?v={track['id']}",
            out_dir,
            self.bitrate,
            progress_hooks=[on_progress],
            postprocessor_hooks=[on_post],
        )

    def run(self):
        try:
            with _slots:
                if self.cancelled():
                    raise Cancelled()
                self.state["status"] = "run"
                self.write(force=True)
                if self.state["kind"] == "zip":
                    self._run_zip()
                else:
                    self._run_mp3()
        except Cancelled:
            self.state.update(status="cancelled", error="Abgebrochen.")
            for t in self.state["tracks"]:
                if t["status"] not in ("done", "error"):
                    t.update(status="cancelled", speed=0, eta=None)
        except Exception as exc:  # noqa: BLE001 - surface to the UI
            if self.cancelled():
                self.state.update(status="cancelled", error="Abgebrochen.")
            else:
                self.state.update(status="error", error=friendly_error(exc))
        self.write(force=True)

    def _run_mp3(self):
        track = self.state["tracks"][0]
        try:
            mp3 = self.fetch(track, self.dir)
        except Cancelled:
            raise
        except Exception as exc:  # noqa: BLE001
            if self.cancelled():
                raise Cancelled() from exc
            track.update(status="error", error=friendly_error(exc), speed=0, eta=None)
            raise
        if not mp3 or not os.path.exists(mp3):
            track.update(status="error", error="Konvertierung lieferte keine MP3-Datei.")
            raise RuntimeError("Konvertierung lieferte keine MP3-Datei.")
        name = safe_filename(os.path.splitext(os.path.basename(mp3))[0]) + ".mp3"
        track.update(status="done", pct=100, speed=0, eta=None)
        self.state.update(status="done", ok=1, file=os.path.basename(mp3), download_name=name)

    def _run_zip(self):
        skipped = []
        zip_path = os.path.join(self.dir, "bundle.zip")
        used = set()
        # MP3 is already compressed, so ZIP_STORED is just as small and much faster.
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
            for track in self.state["tracks"]:
                if self.cancelled():
                    raise Cancelled()
                track_dir = tempfile.mkdtemp(prefix="t_", dir=self.dir)
                try:
                    mp3 = self.fetch(track, track_dir)
                    if not mp3 or not os.path.exists(mp3):
                        raise RuntimeError("Konvertierung lieferte keine MP3-Datei.")
                    arc = safe_filename(os.path.splitext(os.path.basename(mp3))[0]) + ".mp3"
                    candidate, n = arc, 2
                    while candidate in used:
                        candidate = f"{arc[:-4]} ({n}).mp3"
                        n += 1
                    used.add(candidate)
                    zf.write(mp3, arcname=candidate)
                    track.update(status="done", pct=100, speed=0, eta=None)
                    self.state["ok"] = len(used)
                except Cancelled:
                    raise
                except Exception as exc:  # noqa: BLE001 - skip failed tracks, keep going
                    if self.cancelled():
                        raise Cancelled() from exc
                    reason = friendly_error(exc)
                    track.update(status="error", error=reason, speed=0, eta=None)
                    skipped.append((track["title"] or track["id"], reason))
                    self.state["skipped"] = len(skipped)
                finally:
                    shutil.rmtree(track_dir, ignore_errors=True)
                self.write(force=True)

            if not used:
                detail = f" Grund: {skipped[-1][1]}" if skipped else ""
                raise RuntimeError(f"Kein Titel konnte heruntergeladen werden.{detail}")
            if skipped:
                report = "Diese Titel konnten nicht heruntergeladen werden:\n\n"
                report += "\n".join(f"- {t}\n  Grund: {r}" for t, r in skipped)
                zf.writestr("_Uebersprungene Titel.txt", report)

        self.state.update(
            status="done",
            file="bundle.zip",
            download_name=f"{safe_filename(self.state['name'] or 'playlist')}.zip",
        )


@app.route("/api/jobs", methods=["POST"])
def api_jobs_create():
    """Start an MP3 job (one id) or a ZIP job (zip: true, many ids)."""
    if not ffmpeg_available():
        return jsonify({"error": "ffmpeg ist nicht installiert (für MP3 nötig)."}), 500
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list):
        return jsonify({"error": "Keine Titel ausgewählt."}), 400
    ids = list(dict.fromkeys(i for i in ids if isinstance(i, str) and _VIDEO_ID.fullmatch(i)))
    if not ids:
        return jsonify({"error": "Keine gültigen Titel ausgewählt."}), 400
    as_zip = bool(data.get("zip"))
    if not as_zip and len(ids) != 1:
        return jsonify({"error": "Ein MP3-Auftrag braucht genau einen Titel."}), 400
    if len(ids) > MAX_ZIP_TRACKS:
        return jsonify({"error": f"Maximal {MAX_ZIP_TRACKS} Titel pro ZIP."}), 400
    titles = data.get("titles") if isinstance(data.get("titles"), dict) else {}

    sweep_jobs()
    job = Job(
        "zip" if as_zip else "mp3",
        [(i, str(titles.get(i) or "")[:300]) for i in ids],
        clean_bitrate(data.get("bitrate")),
        str(data.get("name") or "playlist")[:200],
    )
    threading.Thread(target=job.run, daemon=True).start()
    return jsonify(job.state), 201


@app.route("/api/jobs/<job_id>", methods=["GET"])
def api_jobs_get(job_id):
    state = read_job(job_id)
    if state is None:
        return jsonify({"error": "Auftrag nicht gefunden (abgelaufen?)."}), 404
    return jsonify(state)


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def api_jobs_cancel(job_id):
    if read_job(job_id) is None:
        return jsonify({"error": "Auftrag nicht gefunden."}), 404
    open(os.path.join(job_dir(job_id), "cancel"), "w").close()
    return jsonify({"ok": True})


@app.route("/api/jobs/<job_id>/file", methods=["GET"])
def api_jobs_file(job_id):
    state = read_job(job_id)
    if not state or state.get("status") != "done" or not state.get("file"):
        return jsonify({"error": "Datei ist (noch) nicht bereit."}), 404
    path = os.path.join(job_dir(job_id), os.path.basename(state["file"]))
    if not os.path.isfile(path):
        return jsonify({"error": "Datei ist abgelaufen. Bitte neu laden."}), 410
    return send_file(
        path,
        mimetype="application/zip" if state["kind"] == "zip" else "audio/mpeg",
        as_attachment=True,
        download_name=state.get("download_name") or os.path.basename(path),
        max_age=0,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=bool(os.environ.get("DEBUG")))
