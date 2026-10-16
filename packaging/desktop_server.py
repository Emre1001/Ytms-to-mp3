"""Backend entry point for the desktop app (frozen with PyInstaller).

The Electron shell starts this process, reads the port from the first line
of stdout ("YTMP3_READY <port>") and then talks to it over 127.0.0.1 with the
token from YTMP3_TOKEN. When the shell goes away, stdin closes and we exit.

yt-dlp has to keep up with YouTube, so a bundled copy goes stale within weeks.
Once a day we look for a newer release on PyPI, verify its hash and keep the
wheel in the user data folder; the next start imports it instead of the
bundled one (a pure-Python wheel can be imported straight from the zip).
"""

import glob
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.request

DATA_DIR = os.environ.get("YTMP3_DATA") or os.path.join(tempfile.gettempdir(), "ytmp3")
WHEEL_DIR = os.path.join(DATA_DIR, "yt-dlp")
CHECK_FILE = os.path.join(WHEEL_DIR, "last-check")
CHECK_EVERY = 24 * 3600


def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0"))


def _bundled_version():
    try:
        from importlib.metadata import version
        return version("yt-dlp")
    except Exception:  # noqa: BLE001 - metadata missing in odd builds
        return "0"


def _wheel_version(path):
    m = re.match(r"yt_dlp-([^-]+)-", os.path.basename(path))
    return m.group(1) if m else "0"


def activate_newer_ytdlp():
    """Put the newest downloaded yt-dlp wheel in front of the bundled one."""
    bundled = _bundled_version()
    wheels = sorted(glob.glob(os.path.join(WHEEL_DIR, "yt_dlp-*.whl")), key=lambda p: _vtuple(_wheel_version(p)))
    for whl in reversed(wheels):
        if _vtuple(_wheel_version(whl)) <= _vtuple(bundled):
            break
        sys.path.insert(0, whl)
        try:
            import yt_dlp  # noqa: F401 - smoke test the wheel
            return
        except Exception:  # noqa: BLE001 - broken download: fall back to the next one
            sys.path.remove(whl)
            for name in [m for m in sys.modules if m == "yt_dlp" or m.startswith("yt_dlp.")]:
                del sys.modules[name]


def _ssl_context():
    import ssl
    if os.environ.get("SSL_CERT_FILE"):
        return ssl.create_default_context(cafile=os.environ["SSL_CERT_FILE"])
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return ssl.create_default_context()


def _fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "ytms-to-mp3-desktop"})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
        return r.read()


def check_for_update(state, running_version, force=False):
    """Download a newer yt-dlp wheel from PyPI, if there is one."""
    os.makedirs(WHEEL_DIR, exist_ok=True)
    if not force:
        try:
            if time.time() - os.path.getmtime(CHECK_FILE) < CHECK_EVERY:
                return
        except OSError:
            pass
    state.update(checking=True, error="")
    try:
        meta = json.loads(_fetch("https://pypi.org/pypi/yt-dlp/json"))
        latest = meta["info"]["version"]
        state["latest"] = latest
        if _vtuple(latest) <= _vtuple(running_version):
            return
        target = os.path.join(WHEEL_DIR, f"yt_dlp-{latest}-py3-none-any.whl")
        if not os.path.exists(target):
            files = [f for f in meta["urls"] if f["packagetype"] == "bdist_wheel" and f["filename"].endswith("py3-none-any.whl")]
            if not files:
                return
            blob = _fetch(files[0]["url"], timeout=120)
            if hashlib.sha256(blob).hexdigest() != files[0]["digests"]["sha256"]:
                raise RuntimeError("Prüfsumme stimmt nicht")
            tmp = target + ".part"
            with open(tmp, "wb") as fh:
                fh.write(blob)
            os.replace(tmp, target)
            for old in glob.glob(os.path.join(WHEEL_DIR, "yt_dlp-*.whl")):
                if old != target:
                    try:
                        os.remove(old)
                    except OSError:
                        pass
        state["pending"] = latest
    except Exception as exc:  # noqa: BLE001 - offline etc.; try again next start
        state["error"] = str(exc)[:200]
    finally:
        state["checking"] = False
        try:
            with open(CHECK_FILE, "w") as fh:
                fh.write(str(time.time()))
        except OSError:
            pass


def watch_parent():
    """Exit when the desktop shell closes our stdin (it quit or crashed)."""
    try:
        while sys.stdin.read(1):
            pass
    except Exception:  # noqa: BLE001
        pass
    os._exit(0)


def main():
    if not getattr(sys, "frozen", False):
        # Running from a checkout: make the repo root (app.py) importable.
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    activate_newer_ytdlp()

    import logging
    from werkzeug.serving import make_server
    import app as backend

    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    import yt_dlp

    state = backend.UPDATE_STATE
    running = yt_dlp.version.__version__
    state.update(running=running, bundled=_bundled_version())

    @backend.app.route("/api/update", methods=["POST"])
    def api_update():
        check_for_update(state, running, force=True)
        return backend.jsonify(state)

    server = make_server("127.0.0.1", int(os.environ.get("PORT", "0")), backend.app, threaded=True)
    print(f"YTMP3_READY {server.server_port}", flush=True)

    if sys.stdin and not sys.stdin.isatty():
        threading.Thread(target=watch_parent, daemon=True).start()
    threading.Thread(target=check_for_update, args=(state, running), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
