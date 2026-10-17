// window.YTHost for the live demo on the website.
// Answers the app's API with a sample playlist and simulated downloads —
// nothing is fetched from YouTube and nothing is saved.
//   ?film=1        plays a short scripted run-through (the hero on the website)
//   ?start=list    opens the sample playlist right away
//   ?theme=…&scheme=…  initial design; the page can change it via postMessage
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var FILM = q.get('film') === '1';
  var LINK = 'https://music.youtube.com/playlist?list=PLroadtrip-sommer';
  var TRACKS = [
    ['Nachtfahrt', 'Lina Sommer', 214], ['Glas & Beton', 'Kollektiv Nord', 187],
    ['Halbmond über Köln', 'Mira Vale', 243], ['Leuchtfeuer', 'Ostwind', 201],
    ['Sieben Brücken', 'Tarek Aydın', 265], ['Papierflieger', 'Juna', 178],
    ['Kaltes Licht', 'Neon Atlas', 232], ['Weit weg', 'Lina Sommer', 199],
    ['Funkstille', 'Die Antennen', 221], ['Morgengrau', 'Mira Vale', 256],
    ['Strom', 'Kollektiv Nord', 190], ['Zuhause', 'Juna', 207],
  ];
  var IDS = TRACKS.map(function (_, i) { return 'demo' + String(i).padStart(2, '0') + 'track'; });
  var BROKEN = IDS[8]; // "Funkstille" fails on purpose, so error handling shows up too

  // ---------- Settings live in memory, so demos on the page don't affect each other ----------
  var mem = {
    'ytmp3.prefs': JSON.stringify({
      theme: q.get('theme') || 'std', scheme: q.get('scheme') || 'system',
      sound: false, notify: false, autoload: true,
    }),
  };
  try {
    var ls = window.localStorage, gi = Storage.prototype.getItem, si = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) {
      return this === ls && /^ytmp3\./.test(k) ? (k in mem ? mem[k] : null) : gi.call(this, k);
    };
    Storage.prototype.setItem = function (k, v) {
      if (this === ls && /^ytmp3\./.test(k)) mem[k] = String(v); else si.call(this, k, v);
    };
  } catch (e) {}

  // ---------- Cover art: small abstract SVGs instead of real album covers ----------
  var PALETTES = [
    ['#ff6a1f', '#1d1b18', '#f5f4f1'], ['#e8e2d6', '#2b4a6f', '#c8553d'], ['#14324a', '#f2c14e', '#e8e2d6'],
    ['#3a1f4d', '#ff8fa3', '#f7d6e0'], ['#0f3d3e', '#e9c46a', '#f4f1ea'], ['#f4f1ea', '#d1495b', '#1b1b1e'],
    ['#1b1b1e', '#9bc1bc', '#f4f1ea'], ['#2d6a4f', '#f1faee', '#ff6a1f'], ['#5b2a86', '#f7b801', '#f1e9da'],
    ['#c8553d', '#f2d0a9', '#2b2b2b'], ['#283618', '#fefae0', '#dda15e'], ['#023047', '#8ecae6', '#ffb703'],
  ];
  function cover(i) {
    var p = PALETTES[i % PALETTES.length], a = p[0], b = p[1], c = p[2], s;
    switch (i % 6) {
      case 0: s = '<rect width="320" height="320" fill="' + a + '"/><circle cx="160" cy="176" r="92" fill="' + b + '"/><rect y="200" width="320" height="120" fill="' + a + '"/><rect y="200" width="320" height="6" fill="' + c + '"/>'; break;
      case 1: s = '<rect width="320" height="320" fill="' + a + '"/>' + [120, 90, 60, 30].map(function (r, k) { return '<circle cx="160" cy="160" r="' + r + '" fill="' + (k % 2 ? a : b) + '"/>'; }).join('') + '<circle cx="160" cy="160" r="8" fill="' + c + '"/>'; break;
      case 2: s = '<rect width="320" height="320" fill="' + a + '"/><g transform="rotate(-35 160 160)">' + [0, 1, 2, 3, 4, 5].map(function (k) { return '<rect x="-80" y="' + (k * 64 - 40) + '" width="480" height="30" fill="' + b + '"/>'; }).join('') + '</g><circle cx="236" cy="84" r="34" fill="' + c + '"/>'; break;
      case 3: var d = ''; for (var x = 0; x < 6; x++) for (var y = 0; y < 6; y++) d += '<circle cx="' + (40 + x * 48) + '" cy="' + (40 + y * 48) + '" r="' + (x === 4 && y === 1 ? 18 : 9) + '" fill="' + (x === 4 && y === 1 ? c : b) + '"/>';
        s = '<rect width="320" height="320" fill="' + a + '"/>' + d; break;
      case 4: s = '<rect width="320" height="320" fill="' + a + '"/><circle cx="124" cy="150" r="86" fill="' + b + '"/><circle cx="196" cy="170" r="86" fill="' + c + '" opacity=".85"/>'; break;
      default: s = '<rect width="320" height="320" fill="' + a + '"/>' + [140, 110, 80, 50].map(function (r, k) { return '<circle cx="160" cy="300" r="' + r + '" fill="none" stroke="' + [b, c, b, c][k] + '" stroke-width="22"/>'; }).join('');
    }
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">' + s + '</svg>');
  }

  // ---------- Simulated backend (same JSON shapes as app.py) ----------
  var jobs = {}, seq = 0;
  var speedUp = FILM ? 2.6 : 1;

  function playlist() {
    return {
      title: 'Roadtrip Sommer', uploader: 'Beispiel-Playlist', thumbnail: null, is_playlist: true,
      count: TRACKS.length,
      entries: TRACKS.map(function (t, i) {
        return { id: IDS[i], title: t[0], uploader: t[1] + ' - Topic', duration: t[2], thumbnail: null, url: '' };
      }),
    };
  }

  function createJob(d) {
    var ids = (d.ids || []).filter(function (x) { return IDS.indexOf(x) >= 0; });
    if (!ids.length) return [400, { error: 'Keine gültigen Titel ausgewählt.' }];
    var id = (++seq).toString(16).padStart(32, '0');
    var job = {
      id: id, kind: d.zip ? 'zip' : 'mp3', name: d.name || 'playlist', status: 'run', error: '',
      ok: 0, skipped: 0, file: null, download_name: null, cancelled: false,
      workers: Math.max(1, Math.min(8, +d.workers || 4)),
      tracks: ids.map(function (vid) {
        return { id: vid, title: (d.titles || {})[vid] || vid, status: 'queue', pct: 0, speed: 0, eta: null, error: '' };
      }),
    };
    jobs[id] = job;
    var todo = job.tracks.slice(), left = Math.min(job.workers, todo.length);
    // Like app.py: a ZIP runs several workers, every track waits for a free slot.
    for (var w = 0; w < left; w++) worker();
    function worker() {
      var t = todo.shift();
      if (!t || job.cancelled) {
        if (--left === 0) finishJob(job);
        return;
      }
      slot(function (release) { runTrack(job, t, function () { release(); worker(); }); });
    }
    return [201, snapshot(job)];
  }

  // Process-wide slots, like _track_slots in app.py
  var free = 8, waiting = [];
  function slot(fn) {
    if (free > 0) { free--; fn(release); } else waiting.push(fn);
    function release() { var next = waiting.shift(); if (next) next(release); else free++; }
  }

  function finishJob(job) {
    if (job.cancelled) return finishCancelled(job);
    if (job.kind === 'zip' && !job.ok) { job.status = 'error'; job.error = 'Kein Titel konnte heruntergeladen werden.'; return; }
    if (job.kind === 'mp3' && job.tracks[0].status === 'error') { job.status = 'error'; job.error = job.tracks[0].error; return; }
    job.status = 'done';
    job.file = job.kind === 'zip' ? 'bundle.zip' : 'track.mp3';
    job.download_name = job.kind === 'zip' ? job.name + '.zip' : job.tracks[0].title + '.mp3';
  }

  function runTrack(job, t, done) {
    if (job.cancelled) return done();
    t.status = 'download';
    if (t.id === BROKEN) {
      return setTimeout(function () {
        t.status = 'error'; t.error = 'Video nicht verfügbar (gelöscht, privat oder regional gesperrt).';
        if (job.kind === 'zip') job.skipped++;
        done();
      }, 900 / speedUp);
    }
    var total = 3e6 + Math.random() * 4e6, got = 0, base = 1.1e6 + Math.random() * 2.2e6;
    var timer = setInterval(function () {
      if (job.cancelled) { clearInterval(timer); return done(); }
      var sp = base * (0.75 + Math.random() * 0.5) * speedUp;
      got = Math.min(total, got + sp * 0.12);
      t.pct = Math.round(got / total * 1000) / 10;
      t.speed = sp;
      t.eta = Math.max(0, Math.round((total - got) / sp));
      if (got >= total) {
        clearInterval(timer);
        t.status = 'convert'; t.pct = 100; t.speed = 0; t.eta = null;
        setTimeout(function () {
          if (!job.cancelled) { t.status = 'done'; job.ok++; }
          done();
        }, (700 + Math.random() * 400) / speedUp);
      }
    }, 120);
  }

  function finishCancelled(job) {
    job.status = 'cancelled'; job.error = 'Abgebrochen.';
    job.tracks.forEach(function (t) { if (t.status !== 'done' && t.status !== 'error') { t.status = 'cancelled'; t.speed = 0; t.eta = null; } });
  }

  function snapshot(job) {
    var o = JSON.parse(JSON.stringify(job));
    delete o.cancelled;
    return o;
  }

  function route(method, path, data) {
    if (path === '/api/info') return [200, { ytdlp: 'Demo', ffmpeg: true, update: {} }];
    if (path === '/api/playlist') return [200, playlist(), 900];
    if (path === '/api/jobs' && method === 'POST') return createJob(data || {});
    var m = /^\/api\/jobs\/([0-9a-f]+)$/.exec(path);
    if (m) {
      var job = jobs[m[1]];
      if (!job) return [404, { error: 'Auftrag nicht gefunden (abgelaufen?).' }];
      if (method === 'DELETE') { job.cancelled = true; return [200, { ok: true }]; }
      return [200, snapshot(job)];
    }
    return [404, { error: 'Unbekannte Anfrage.' }];
  }

  var told = false;
  window.YTHost = {
    platform: 'demo',
    os: '',
    api: function (method, path, data) {
      var r = route(method, path, data);
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ status: r[0], json: r[1] }); }, r[2] ? r[2] / (FILM ? 1.6 : 1) : 30);
      });
    },
    save: function () {
      if (!told && window.toast) { told = true; window.toast('Demo mit Beispielmusik – es wird nichts gespeichert', 'info'); }
      return Promise.resolve(null);
    },
    thumb: function (id) { var i = IDS.indexOf(id); return i >= 0 ? cover(i) : ''; },
    readClipboard: function () { return Promise.resolve(LINK); },
  };

  // ---------- Remote control from the website ----------
  function setPref(name, value, point) {
    var el = document.querySelector('input[data-p="' + name + '"][value="' + value + '"]');
    if (!el || el.checked) return;
    if (point) window.dispatchEvent(new PointerEvent('pointerdown', { clientX: point[0], clientY: point[1] }));
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'ytmp3-demo') return;
    var d = e.data;
    if (d.theme) setPref('theme', d.theme, d.point);
    if (d.scheme) setPref('scheme', d.scheme, d.point);
    if ('visible' in d) visible = d.visible;
  });

  // ---------- Film: a short scripted run-through for the hero ----------
  var stopped = !FILM, visible = true;
  function sleep(ms) {
    return new Promise(function (r) {
      (function wait() { if (!visible && !stopped) return setTimeout(wait, 200); setTimeout(r, ms); })();
    });
  }
  function until(test, ms) {
    return new Promise(function (r) {
      var t0 = Date.now();
      (function poll() { if (stopped || test() || Date.now() - t0 > (ms || 60000)) return r(); setTimeout(poll, 120); })();
    });
  }
  function stop(e) {
    if (!e.isTrusted || stopped) return;
    stopped = true;
    parent.postMessage({ type: 'ytmp3-film', stopped: true }, location.origin);
  }
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (n) { window.addEventListener(n, stop, true); });

  async function film() {
    while (!stopped) {
      await sleep(1100);
      var input = document.getElementById('url');
      if (stopped) return;
      // preventScroll: the demo must never scroll the website around it
      input.focus({ preventScroll: true });
      for (var i = 0; i < LINK.length && !stopped; i++) {
        input.value = LINK.slice(0, i + 1);
        await sleep(18 + Math.random() * 34);
      }
      await sleep(380);
      if (stopped) return;
      document.getElementById('loadb').click();
      await until(function () { return document.querySelectorAll('.trk').length > 0; });
      await sleep(1700);
      var rows = function () { return document.querySelectorAll('.trk'); };
      for (var k of [3, 6]) {
        if (stopped) return;
        rows()[k].click();
        await sleep(520);
      }
      await sleep(700);
      if (stopped) return;
      document.getElementById('zipsel').click();
      var last = null;
      await until(function () {
        var act = document.querySelector('.trk[data-st=download],.trk[data-st=convert]');
        if (act && act !== last) {
          last = act;
          // Scroll only inside the demo (scrollIntoView would move the website too)
          var r = act.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 2, behavior: 'smooth' });
        }
        return document.querySelector('.dock-in[data-m=zipdone]');
      }, 90000);
      await sleep(6500);
      if (stopped) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await sleep(600);
      if (window.showWelcome) window.showWelcome();
      document.getElementById('url').value = '';
    }
  }

  window.addEventListener('load', function () {
    if (FILM) film();
    else if (q.get('start') === 'list' && window.loadPlaylist) window.loadPlaylist(LINK);
  });
})();
