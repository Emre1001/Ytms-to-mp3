"""Assemble the website (GitHub Pages) into OUT_DIR.

    python packaging/build_site.py _site

site/ is copied as is, the live demo is the real app UI rendered into app/
with site/demo-host.js as its backend, and fonts/icons come from static/.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "_site")
    site = os.path.join(ROOT, "site")
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(site, out, ignore=shutil.ignore_patterns("demo-host.js"))
    subprocess.check_call([
        sys.executable, os.path.join(ROOT, "packaging", "render_web.py"), os.path.join(out, "app"),
        "--prefix", "static/", "--inject", os.path.join(site, "demo-host.js"),
    ])
    assets = os.path.join(out, "assets")
    os.makedirs(assets, exist_ok=True)
    shutil.copy(os.path.join(ROOT, "static", "fonts", "mona-sans.woff2"), assets)
    shutil.copytree(os.path.join(ROOT, "static", "icons"), os.path.join(assets, "icons"), dirs_exist_ok=True)
    # GitHub Pages: serve files as they are (no Jekyll processing).
    open(os.path.join(out, ".nojekyll"), "w").close()
    print(f"site built in {out}")


if __name__ == "__main__":
    main()
