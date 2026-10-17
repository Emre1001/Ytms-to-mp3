"""Writes the animated SVGs used in README.md (light + dark).

    pip install fonttools brotli
    python branding/readme_svgs.py

GitHub shows README images with <img>, which can't load web fonts — so a tiny
subset of Mona Sans is embedded into each SVG.
"""
import base64
import io
import os

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "readme")

THEMES = {
    "dark": dict(bg="#0b0b0c", fg="#f2f1ee", muted="#8f8d88", card="#151517", line="rgba(255,248,235,.09)",
                 grid="rgba(255,248,235,.05)", track="rgba(255,248,235,.1)", ok="#3ccb7f"),
    "light": dict(bg="#f5f4f1", fg="#151413", muted="#6f6d68", card="#ffffff", line="rgba(40,30,10,.1)",
                  grid="rgba(40,30,10,.05)", track="rgba(40,30,10,.09)", ok="#178a4c"),
}
ACC = "#ff6a1f"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
MARK = "M140 192v52M198 148v140M256 106v226M314 148v140M372 192v52"
CHEV = "M194 366l62 52 62-52"


def font_face(text):
    """Mona Sans, cut down to the glyphs in text, as a base64 @font-face."""
    font = TTFont(os.path.join(ROOT, "static", "fonts", "mona-sans.woff2"))
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, {"wdth": 112, "wght": (450, 850)})
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    data = base64.b64encode(buf.getvalue()).decode()
    return f"@font-face{{font-family:M;src:url(data:font/woff2;base64,{data}) format('woff2')}}"


def hero(t):
    rows = [("Nachtfahrt", "Lina Sommer", ACC, "#1d1b18"), ("Glas & Beton", "Kollektiv Nord", "#e8e2d6", "#2b4a6f"),
            ("Halbmond über Köln", "Mira Vale", "#14324a", "#f2c14e")]
    text = "Aus Playlists werden MP3s.Für Windows, Linux und Android · kostenlos · Open Source" + "".join(r[0] + r[1] for r in rows) + "YT Music MP3 %0123456789Lädt Wandelt um Geladen"
    row_svg = []
    for i, (title, artist, c1, c2) in enumerate(rows):
        y = 92 + i * 92
        row_svg.append(f"""
  <g class="row r{i}" transform="translate(800 {y})">
    <rect width="408" height="78" rx="16" fill="{t['card']}" stroke="{t['line']}"/>
    <rect x="14" y="14" width="50" height="50" rx="10" fill="{c1}"/>
    <circle cx="39" cy="43" r="14" fill="{c2}"/>
    <text x="80" y="36" class="tt">{title.replace('&', '&amp;')}</text>
    <text x="80" y="58" class="ar">{artist}</text>
    <g transform="translate(366 39)">
      <circle r="16" fill="none" stroke="{t['track']}" stroke-width="3.2"/>
      <circle class="ring" r="16" fill="none" stroke="{ACC}" stroke-width="3.2" pathLength="100" transform="rotate(-90)"/>
      <circle class="okbg" r="17" fill="{t['ok']}"/>
      <path class="ok" d="M-6 0.5l4 4 8-8.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
    </g>
  </g>""")
    delays = "".join(
        f".r{i} .ring{{animation-delay:{i * 0.9}s}}.r{i} .okbg,.r{i} .ok{{animation-delay:{i * 0.9}s}}" for i in range(3))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 440" width="1280" height="440" role="img" aria-label="YT Music → MP3 – Aus Playlists werden MP3s.">
<style>
{font_face(text)}
.h{{font:850 78px M,sans-serif;letter-spacing:-3px;fill:{t['fg']}}}
.acc{{fill:{ACC}}}
.sub{{font:500 22px M,sans-serif;fill:{t['muted']}}}
.tt{{font:650 19px M,sans-serif;fill:{t['fg']}}}
.ar{{font:500 15px M,sans-serif;fill:{t['muted']}}}
.bars path{{transform-box:fill-box;transform-origin:center;animation:lvl 1.1s ease-in-out infinite alternate}}
.bars path:nth-child(2){{animation-delay:-.4s}}.bars path:nth-child(3){{animation-delay:-.75s}}
.bars path:nth-child(4){{animation-delay:-.2s}}.bars path:nth-child(5){{animation-delay:-.55s}}
@keyframes lvl{{from{{transform:scaleY(.35)}}to{{transform:scaleY(1)}}}}
.ring{{stroke-dasharray:100;stroke-dashoffset:100;animation:fill 6s cubic-bezier(.4,0,.2,1) infinite}}
.okbg{{opacity:0;transform:scale(.4);transform-box:fill-box;transform-origin:center;animation:pop 6s cubic-bezier(.34,1.56,.64,1) infinite}}
.ok{{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 6s ease-out infinite}}
@keyframes fill{{0%,8%{{stroke-dashoffset:100}}48%,100%{{stroke-dashoffset:0}}}}
@keyframes pop{{0%,48%{{opacity:0;transform:scale(.4)}}54%,92%{{opacity:1;transform:none}}100%{{opacity:0}}}}
@keyframes draw{{0%,52%{{stroke-dashoffset:1}}60%,92%{{stroke-dashoffset:0}}100%{{stroke-dashoffset:1}}}}
{delays}
@media (prefers-reduced-motion:reduce){{*{{animation:none!important}}.ring{{stroke-dashoffset:0}}}}
</style>
<defs><pattern id="g" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="{t['grid']}"/></pattern>
<radialGradient id="fade" cx="78%" cy="50%" r="55%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="m"><rect width="1280" height="440" fill="url(#fade)"/></mask></defs>
<rect width="1280" height="440" rx="28" fill="{t['bg']}"/>
<rect width="1280" height="440" rx="28" fill="url(#g)" mask="url(#m)"/>
<g transform="translate(72 64)">
  <rect width="64" height="64" rx="18" fill="{ACC}"/>
  <g transform="translate(3.84 3.18) scale(.11)" fill="none" stroke="#1a0c04" stroke-width="42" stroke-linecap="round" stroke-linejoin="round">
    <g class="bars">{''.join(f'<path d="{p}"/>' for p in ['M140 192v52', 'M198 148v140', 'M256 106v226', 'M314 148v140', 'M372 192v52'])}</g>
    <path d="{CHEV}"/>
  </g>
</g>
<text x="66" y="236" class="h">Aus Playlists</text>
<text x="66" y="316" class="h">werden <tspan class="acc">MP3s.</tspan></text>
<text x="72" y="372" class="sub">Für Windows, Linux und Android · kostenlos · Open Source</text>
{''.join(row_svg)}
</svg>
"""


def flow(t):
    steps = [("01", "Link", "Playlist, Album, Song"), ("02", "Liste", "yt-dlp, kein Download"),
             ("03", "Ton", "bestaudio · Opus"), ("04", "MP3", "ffmpeg · 128–320k"),
             ("05", "Fertig", "Tags · Cover · ZIP")]
    text = "".join(a + b + c for a, b, c in steps)
    nodes, wires = [], []
    w, gap, x0 = 212, 50, 32
    for i, (num, title, cap) in enumerate(steps):
        x = x0 + i * (w + gap)
        nodes.append(f"""
  <g class="n n{i}" transform="translate({x} 60)">
    <rect class="box" width="{w}" height="140" rx="20" fill="{t['card']}" stroke="{t['line']}" stroke-width="1.5"/>
    <text x="22" y="40" class="num">{num}</text>
    <text x="22" y="88" class="tt">{title}</text>
    <text x="22" y="116" class="cap">{cap}</text>
  </g>""")
        if i < len(steps) - 1:
            wx = x + w
            wires.append(f'<line x1="{wx + 6}" y1="130" x2="{wx + gap - 6}" y2="130" stroke="{t["line"]}" stroke-width="2"/>'
                         f'<line class="pulse p{i}" x1="{wx + 6}" y1="130" x2="{wx + gap - 6}" y2="130" stroke="{ACC}" stroke-width="2" pathLength="10"/>')
    delays = "".join(f".n{i} .box,.n{i} .num{{animation-delay:{i * 0.8}s}}.p{i}{{animation-delay:{i * 0.8 + 0.4}s}}" for i in range(5))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1340 260" width="1340" height="260" role="img" aria-label="Ablauf: Link, Liste lesen, Ton laden, in MP3 umwandeln, fertig mit Tags, Cover und ZIP">
<style>
{font_face(text)}
.num{{font:600 14px {MONO};fill:{t['muted']};animation:numOn 4s infinite}}
.tt{{font:780 34px M,sans-serif;letter-spacing:-1px;fill:{t['fg']}}}
.cap{{font:500 13px {MONO};fill:{t['muted']}}}
.box{{animation:boxOn 4s infinite}}
.pulse{{stroke-dasharray:3 10;stroke-dashoffset:13;opacity:0;animation:pulse 4s linear infinite}}
@keyframes boxOn{{0%,4%{{stroke:{t['line']}}}10%,24%{{stroke:{ACC}}}34%,100%{{stroke:{t['line']}}}}}
@keyframes numOn{{0%,4%{{fill:{t['muted']}}}10%,24%{{fill:{ACC}}}34%,100%{{fill:{t['muted']}}}}}
@keyframes pulse{{0%{{stroke-dashoffset:13;opacity:1}}14%{{stroke-dashoffset:0;opacity:1}}15%,100%{{opacity:0}}}}
{delays}
@media (prefers-reduced-motion:reduce){{*{{animation:none!important}}}}
</style>
<rect width="1340" height="260" rx="28" fill="{t['bg']}"/>
{''.join(wires)}
{''.join(nodes)}
</svg>
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, t in THEMES.items():
        for kind, fn in (("hero", hero), ("flow", flow)):
            path = os.path.join(OUT, f"{kind}-{name}.svg")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(fn(t))
            print(path, os.path.getsize(path))


if __name__ == "__main__":
    main()
