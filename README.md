# 🎵 YT Music → MP3 Downloader

Eine kleine Web-App, mit der man die Titel einer **YouTube-Music-Playlist**
(oder einer normalen YouTube-Playlist / eines einzelnen Videos) auflisten und
**einzeln als MP3** oder **gesammelt als ZIP** herunterladen kann.

> ⚠️ **Nutzungshinweis:** Lade nur Inhalte herunter, an denen du die Rechte
> besitzt oder die ausdrücklich zum Download freigegeben sind. Das Tool ist für
> rechtmäßige, private Zwecke gedacht.

## Features

- Playlist-Link einfügen → alle Titel werden mit Cover, Titel, Interpret und
  Dauer aufgelistet.
- **Einzeldownload** jedes Titels als MP3.
- **Qualitätsauswahl** im UI (128 / 192 / 256 / 320 kbps).
- **Mehrfachauswahl** per Checkbox und Download als **eine ZIP-Datei**.
- Schlankes, dunkles UI ohne Build-Schritt (reines HTML/CSS/JS).

## Voraussetzungen

- **Python 3.9+**
- **ffmpeg** muss installiert und im `PATH` sein (für die MP3-Konvertierung)
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Windows: [ffmpeg.org](https://ffmpeg.org/download.html)

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Starten

```bash
python app.py
```

Dann im Browser öffnen: <http://localhost:5000>

### Mit Docker (inkl. ffmpeg)

Das Docker-Image bringt `ffmpeg` bereits mit:

```bash
docker build -t ytms-to-mp3 .
docker run --rm -p 5000:5000 ytms-to-mp3
```

Dann öffnen: <http://localhost:5000>

### Vom Handy aus nutzen (Android/iOS)

Das UI ist responsiv und funktioniert im mobilen Browser. Damit das Handy den
Server erreicht, müssen Handy und Rechner im **selben WLAN** sein:

1. IP-Adresse des Rechners herausfinden (z. B. `ip addr` / `ifconfig`, etwa `192.168.0.42`).
2. Server starten (`python app.py`) – er lauscht bereits auf allen Adressen.
3. Am Handy im Browser öffnen: `http://192.168.0.42:5000`

Die MP3- und ZIP-Downloads landen dann direkt im Download-Ordner des Handys.
Für den Zugriff von außerhalb des WLANs den Server bei einem Hoster deployen
(z. B. per Docker, siehe oben).

### Konfiguration (optional, über Umgebungsvariablen)

| Variable         | Standard | Bedeutung                              |
| ---------------- | -------- | -------------------------------------- |
| `PORT`           | `5000`   | Port des Webservers                    |
| `AUDIO_BITRATE`  | `192`    | Standard-MP3-Bitrate in kbps (UI-Auswahl überschreibt) |
| `MAX_ZIP_TRACKS` | `100`    | Max. Anzahl Titel pro ZIP-Download     |
| `DEBUG`          | –        | Auf einen Wert setzen für Flask-Debug  |

## Funktionsweise

1. Das Backend nutzt [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), um die
   Playlist-Metadaten (ohne vollständigen Download) auszulesen.
2. Beim Download wird die beste Audiospur geholt und per `ffmpeg` zu MP3
   konvertiert.
3. Für ZIPs werden alle ausgewählten Titel heruntergeladen und im Speicher zu
   einem Archiv gebündelt.

## Projektstruktur

```
.
├── app.py              # Flask-Backend (API + Routen)
├── requirements.txt
├── templates/
│   └── index.html      # UI
└── static/
    ├── style.css
    └── app.js          # Frontend-Logik
```
