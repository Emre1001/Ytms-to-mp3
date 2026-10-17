"""Render the app UI (templates/index.html + static/) into a plain static folder.

The Android app ships this folder as assets, the website embeds it as the live
demo. Both talk to their own window.YTHost instead of the Flask API, so the
host script is inlined at the very top of <head>, before the page boots.

    python packaging/render_web.py OUT_DIR [--prefix /static/] [--inject host.js]
"""
import argparse
import os
import shutil

from jinja2 import Environment, FileSystemLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Same values the Flask app passes in (app.py: ALLOWED_BITRATES, AUDIO_BITRATE, MAX_ZIP_TRACKS, …).
BITRATES = ["128", "192", "256", "320"]
DEFAULT_BITRATE = "192"
MAX_ZIP = 100
PARALLEL_OPTIONS = [2, 4, 6, 8]  # app.py: PARALLEL_OPTIONS, DEFAULT_WORKERS
DEFAULT_PARALLEL = 4


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out")
    ap.add_argument("--prefix", default="static/", help="URL prefix for static files")
    ap.add_argument("--inject", action="append", default=[], help="script file to inline before the page boots")
    args = ap.parse_args()

    with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as fh:
        version = fh.read().strip()

    env = Environment(loader=FileSystemLoader(os.path.join(ROOT, "templates")), autoescape=True)
    html = env.get_template("index.html").render(
        url_for=lambda endpoint, filename: args.prefix + filename,
        ffmpeg=True,
        bitrates=BITRATES,
        default_bitrate=DEFAULT_BITRATE,
        max_zip=MAX_ZIP,
        version=version,
        app_version=version,
        parallel_options=PARALLEL_OPTIONS,
        default_parallel=DEFAULT_PARALLEL,
    )
    scripts = ""
    for path in args.inject:
        with open(path, encoding="utf-8") as fh:
            scripts += f"<script>\n{fh.read()}\n</script>\n"
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + scripts, 1)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(args.out, "static"), dirs_exist_ok=True)
    print(f"rendered {args.out}")


if __name__ == "__main__":
    main()
