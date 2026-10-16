'use strict';
// Desktop shell for YT Music → MP3.
// Starts the bundled Python backend on 127.0.0.1, serves it under the stable
// origin ytmp3://app (so settings and history survive restarts) and saves
// finished files straight into the download folder.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const SCHEME = 'ytmp3';
const ORIGIN = `${SCHEME}://app`;
const isWin = process.platform === 'win32';
const dev = !app.isPackaged;
const token = crypto.randomBytes(24).toString('hex');
const TITLEBAR_H = 52;

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// An AppImage can't ship Chromium's setuid sandbox helper.
if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');
app.setAppUserModelId('io.github.emre1001.ytmusicmp3');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let backend = null;   // { child, port }
let base = '';        // http://127.0.0.1:<port>
let quitting = false;
let pendingUrl = linkFrom(process.argv);
const saved = new Set();

// ---------- Settings ----------
let settings = {};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { settings = {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}
const downloadDir = () => settings.downloadDir || path.join(app.getPath('downloads'), 'YT Music MP3');

function linkFrom(argv) {
  return (argv || []).find(a => /^https?:\/\/\S+$/i.test(a)) || '';
}

// ---------- Backend ----------
function resource(...p) {
  return dev ? path.join(__dirname, '..', 'dist', ...p) : path.join(process.resourcesPath, ...p);
}

function backendCommand() {
  const frozen = dev
    ? resource('ytmp3-server', isWin ? 'ytmp3-server.exe' : 'ytmp3-server')
    : resource('backend', isWin ? 'ytmp3-server.exe' : 'ytmp3-server');
  if (fs.existsSync(frozen)) return [frozen, []];
  // Development without a frozen backend: run the Python source directly.
  return [process.env.PYTHON || (isWin ? 'python' : 'python3'), [path.join(__dirname, '..', 'packaging', 'desktop_server.py')]];
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const bin = resource('bin');
    const qjs = path.join(bin, isWin ? 'qjs.exe' : 'qjs');
    const env = {
      ...process.env,
      YTMP3_TOKEN: token,
      YTMP3_DATA: app.getPath('userData'),
      YTMP3_CACHE: path.join(app.getPath('userData'), 'cache'),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    if (fs.existsSync(path.join(bin, isWin ? 'ffmpeg.exe' : 'ffmpeg'))) env.FFMPEG_LOCATION = bin;
    if (fs.existsSync(qjs)) env.YTMP3_QJS = qjs;
    // Electron doubles as Node.js — yt-dlp uses it to solve YouTube's JS challenges.
    env.YTMP3_NODE = process.execPath;
    env.ELECTRON_RUN_AS_NODE = '1';

    const [cmd, args] = backendCommand();
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const log = [];
    let out = '';
    let ready = false;
    child.stdout.on('data', d => {
      if (ready) return;
      out += d;
      const m = /YTMP3_READY (\d+)/.exec(out);
      if (m) { ready = true; resolve({ child, port: +m[1] }); }
    });
    child.stderr.on('data', d => {
      log.push(String(d));
      if (log.length > 60) log.shift();
      if (dev) process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (!ready) reject(new Error(`Der Hintergrunddienst wurde beendet (Code ${code}).\n${log.join('').slice(-1200)}`));
      else if (!quitting && backend && backend.child === child) {
        backend = null;
        base = '';
        showSplash(`Der Hintergrunddienst ist abgestürzt (Code ${code}).\n${log.join('').slice(-1200)}`);
      }
    });
  });
}

function stopBackend() {
  if (!backend) return;
  const { child } = backend;
  backend = null;
  base = '';
  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}
}

async function boot() {
  stopBackend();
  showSplash();
  try {
    backend = await startBackend();
    base = `http://127.0.0.1:${backend.port}`;
    if (win && !win.isDestroyed()) await win.loadURL(`${ORIGIN}/`);
  } catch (e) {
    showSplash(String(e && e.message || e));
  }
}

function showSplash(error) {
  if (!win || win.isDestroyed()) return;
  const query = { bg: settings.bg || '', fg: settings.fg || '' };
  if (error) query.error = error;
  win.loadFile(path.join(__dirname, 'splash.html'), { query });
}

// ytmp3://app/<path> → backend, with the access token added.
function registerProtocol() {
  protocol.handle(SCHEME, async req => {
    if (!base) return new Response('Startet…', { status: 503 });
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set('X-YTMP3-Token', token);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
    try {
      return await net.fetch(base + u.pathname + u.search, { method: req.method, headers, body });
    } catch {
      return new Response(JSON.stringify({ error: 'Keine Verbindung zum Hintergrunddienst.' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }
  });
}

// ---------- Saving files ----------
function fileName(disposition, fallback) {
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition || '');
  let name = '';
  if (star) try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {}
  if (!name) {
    const plain = /filename="?([^";]+)"?/i.exec(disposition || '');
    name = plain ? plain[1] : fallback;
  }
  name = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return name || fallback;
}

function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${stem} (${n})${ext}`);
  return p;
}

async function saveJob(jobId) {
  if (!/^[0-9a-f]{32}$/.test(String(jobId))) throw new Error('Ungültiger Auftrag.');
  const res = await net.fetch(`${base}/api/jobs/${jobId}/file`, { headers: { 'X-YTMP3-Token': token } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Fehler ${res.status}`);
  }
  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = freePath(dir, fileName(res.headers.get('content-disposition'), `${jobId}.mp3`));
  const part = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    fs.renameSync(part, target);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  saved.add(target);
  return { path: target, name: path.basename(target), dir };
}

// ---------- Window ----------
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = settings.bg || (dark ? '#0f0f10' : '#f5f4f1');
  const b = settings.bounds || {};
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width || 1180, height: b.height || 820,
    minWidth: 420, minHeight: 560,
    show: false,
    backgroundColor: bg,
    title: 'YT Music MP3',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    ...(isWin ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: settings.fg || (dark ? '#f2f2f0' : '#141414'), height: TITLEBAR_H },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.on('close', () => {
    settings.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings();
  });
  win.on('focus', () => win.flashFrame(false));

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(`${ORIGIN}/`) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  wc.on('did-finish-load', () => {
    if (pendingUrl && wc.getURL().startsWith(ORIGIN)) {
      wc.send('open-url', pendingUrl);
      pendingUrl = '';
    }
  });
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) {
      items.push(
        { role: 'cut', label: 'Ausschneiden', enabled: p.editFlags.canCut },
        { role: 'copy', label: 'Kopieren', enabled: p.editFlags.canCopy },
        { role: 'paste', label: 'Einfügen', enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Alles auswählen' },
      );
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Kopieren' });
    }
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Link kopieren', click: () => clipboard.writeText(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && dev) wc.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
}

// ---------- Bridge to the page (see preload.js) ----------
ipcMain.handle('save', (_e, jobId) => saveJob(jobId));
ipcMain.handle('reveal', (_e, p) => {
  if (saved.has(p) && fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(downloadDir());
});
ipcMain.handle('open-folder', () => {
  fs.mkdirSync(downloadDir(), { recursive: true });
  return shell.openPath(downloadDir());
});
ipcMain.handle('get-folder', () => downloadDir());
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Speicherort für MP3s',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!r.canceled && r.filePaths[0]) {
    settings.downloadDir = r.filePaths[0];
    saveSettings();
  }
  return downloadDir();
});
ipcMain.on('progress', (_e, p) => {
  if (win && !win.isDestroyed()) win.setProgressBar(typeof p === 'number' && p >= 0 ? Math.min(1, p) : -1);
});
ipcMain.on('attention', () => {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
});
ipcMain.on('theme', (_e, { bg, fg } = {}) => {
  const color = c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
  if (color(bg)) { settings.bg = bg; if (win) win.setBackgroundColor(bg); }
  if (color(fg)) {
    settings.fg = fg;
    if (isWin && win) win.setTitleBarOverlay({ color: '#00000000', symbolColor: fg, height: TITLEBAR_H });
  }
  saveSettings();
});
ipcMain.handle('restart-backend', () => boot());

// ---------- Lifecycle ----------
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const url = linkFrom(argv);
  if (url) win.webContents.send('open-url', url);
});

app.on('before-quit', () => { quitting = true; stopBackend(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  loadSettings();
  Menu.setApplicationMenu(null);
  registerProtocol();
  createWindow();
  boot();
});
