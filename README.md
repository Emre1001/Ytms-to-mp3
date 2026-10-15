# 🎵 YT Music → MP3 Downloader

Eine kleine Web-App, mit der man die Titel einer **YouTube-Music-Playlist**
(oder einer normalen YouTube-Playlist / eines einzelnen Videos) auflisten und
**einzeln als MP3** oder **gesammelt als ZIP** herunterladen kann.

> ⚠️ **Nutzungshinweis:** Lade nur Inhalte herunter, an denen du die Rechte
> besitzt oder die ausdrücklich zum Download freigegeben sind. Das Tool ist für
> rechtmäßige, private Zwecke gedacht.

## Features

- Playlist-Link einfügen, ins Fenster ziehen oder einfach irgendwo mit
  <kbd>Strg</kbd>+<kbd>V</kbd> einfügen → alle Titel werden mit Cover, Titel,
  Interpret und Dauer aufgelistet.
- **Einzeldownload** jedes Titels als MP3 – mit echtem Fortschritt (Prozent,
  Tempo, Restzeit, Umwandlungs-Phase) und Abbrechen per Tipp auf den Ring.
- **Mehrfachauswahl** (Tippen, <kbd>Shift</kbd>-Klick für Bereiche,
  <kbd>Strg</kbd>+<kbd>A</kbd>) und Download als **eine ZIP-Datei**; das Dock
  unten zeigt, welcher Titel gerade gepackt wird.
- **Qualitätsauswahl** (128 / 192 / 256 / 320 kbps), Suche, Filter
  (Alle / Ausgewählt / Geladen / Fehler) und „Zuletzt geöffnet“.
- Oberfläche im Stil von [Speedload](https://github.com/Emre1001/speedload):
  vier Designs (**Standard, Glas, ASCII, Split-Flap**), Hell/Dunkel/System,
  Akzentfarbe, Animationen in drei Stufen (Voll / Wenig / Aus, folgt sonst der
  Systemeinstellung). Einstellungen bleiben im Browser gespeichert.
- Kein Build-Schritt (reines HTML/CSS/JS), funktioniert auch am Handy.

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

### Online stellen – Nutzung ganz ohne eigenen Rechner (Render.com)

Wenn du keinen Rechner hast und die Seite einfach vom Handy aus aufrufen
willst, kannst du sie kostenlos bei **Render.com** hosten. Die nötige Konfig
(`render.yaml` + `Dockerfile` mit ffmpeg) liegt bereits im Repo. Einrichtung
komplett im Handy-Browser:

1. Auf <https://render.com> mit dem **GitHub-Konto** anmelden.
2. **New → Blueprint** wählen und das Repo `Emre1001/Ytms-to-mp3` verbinden.
3. Render liest die `render.yaml` automatisch → auf **Apply / Create** tippen.
4. Nach dem Build bekommst du eine feste URL wie
   `https://ytms-to-mp3.onrender.com` – die kannst du am Handy als Lesezeichen
   oder Startbildschirm-Symbol speichern.

> ⏱️ Im kostenlosen Tarif „schläft" der Dienst nach Inaktivität ein; der erste
> Aufruf danach dauert ca. 30 Sekunden, bis er wieder hochgefahren ist.

> ⚠️ **Wichtige Einschränkung:** YouTube blockiert Downloads von
> Rechenzentrums-IPs (also von Hostern wie Render) häufig mit der Meldung
> „Sign in to confirm you're not a bot". Es kann daher sein, dass Downloads
> in der Cloud fehlschlagen. Umgehen lässt sich das nur, indem man eigene
> YouTube-Cookies hinterlegt (siehe yt-dlp `--cookies`). Zuverlässig
> funktioniert das Tool am ehesten in einem privaten Netz.

### YouTube-Cookies hinterlegen (gegen „Kein Titel konnte heruntergeladen werden")

Wenn Downloads in der Cloud mit Bot-Schutz-Fehlern scheitern, hilft eine
**cookies.txt** mit einem eingeloggten YouTube-Konto:

1. **cookies.txt exportieren** (Netscape-Format):
   - Am Handy: **Firefox für Android** installieren, bei YouTube einloggen und
     ein Add-on wie „cookies.txt" / „Export Cookies" verwenden.
   - Am PC: Browser-Erweiterung „Get cookies.txt LOCALLY" auf youtube.com.
2. **In Render hinterlegen:** Dienst öffnen → **Environment → Secret Files** →
   neue Datei mit Namen `cookies.txt` anlegen und den Export-Inhalt einfügen.
   Sie wird unter `/etc/secrets/cookies.txt` gemountet – die App findet sie
   dort automatisch (kein weiterer Schritt nötig). Danach **Deploy** auslösen
   bzw. den Dienst neu starten.
3. Alternativ kann der Pfad per Umgebungsvariable `COOKIES_FILE` gesetzt
   werden, oder eine `cookies.txt` neben `app.py` gelegt werden.

> 🔐 **Empfehlung:** Dafür ein Zweit-/Wegwerf-Google-Konto verwenden – es
> besteht ein Restrisiko, dass YouTube das Konto sperrt.

Weitere Stellschrauben bei Blockaden:

- `PROXY_URL` – Downloads über einen (z. B. Residential-)Proxy leiten.
- `YT_PLAYER_CLIENT` – yt-dlp-Player-Clients erzwingen, z. B. `android,web`.

### Vom Handy aus nutzen, wenn du doch einen Rechner im selben WLAN hast (Android/iOS)

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
| `MAX_PARALLEL`   | `3`      | Gleichzeitige Downloads pro Server-Prozess |
| `JOB_TTL`        | `1800`   | Sekunden, die fertige Dateien zum erneuten Sichern liegen bleiben |
| `COOKIES_FILE`   | –        | Pfad zu einer cookies.txt (Netscape-Format) |
| `PROXY_URL`      | –        | Proxy für alle YouTube-Anfragen        |
| `YT_PLAYER_CLIENT` | –      | yt-dlp-Player-Clients, z. B. `android,web` |
| `DEBUG`          | –        | Auf einen Wert setzen für Flask-Debug  |

## Funktionsweise

1. Das Backend nutzt [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), um die
   Playlist-Metadaten (ohne vollständigen Download) auszulesen.
2. Beim Download wird die beste Audiospur geholt und per `ffmpeg` zu MP3
   konvertiert.
3. Jeder Download läuft als Auftrag im Hintergrund (`POST /api/jobs`). Der
   Fortschritt aus yt-dlp landet in einer kleinen Statusdatei im Temp-Ordner,
   die das UI abfragt (`GET /api/jobs/<id>`) – so klappt das auch mit mehreren
   gunicorn-Workern. Die fertige MP3/ZIP holt der Browser über
   `GET /api/jobs/<id>/file`; `DELETE /api/jobs/<id>` bricht ab.
4. Für ZIPs werden die Titel nacheinander geladen und in ein Archiv gepackt;
   nicht ladbare Titel werden übersprungen und in der ZIP aufgelistet.

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
