# PyInstaller spec for the desktop backend: `pyinstaller packaging/ytmp3-server.spec`
# Produces dist/ytmp3-server/ (onedir: starts fast, no unpacking on each launch).
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

ROOT = SPECPATH + "/.."

a = Analysis(
    [ROOT + "/packaging/desktop_server.py"],
    pathex=[ROOT],
    datas=[
        (ROOT + "/templates", "templates"),
        (ROOT + "/static", "static"),
        (ROOT + "/VERSION", "."),
        *copy_metadata("yt-dlp"),
        # yt-dlp's built-in copy of the YouTube challenge solver (fallback for yt_dlp_ejs).
        *collect_data_files("yt_dlp", includes=["**/*.js"]),
    ],
    hiddenimports=["app", *collect_submodules("yt_dlp")],
    excludes=["tkinter", "unittest", "pydoc", "test", "setuptools", "pkg_resources", "pip"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ytmp3-server",
    console=True,
    strip=sys.platform != "win32",
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="ytmp3-server", strip=sys.platform != "win32", upx=False)
