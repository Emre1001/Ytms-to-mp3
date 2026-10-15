'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const root = document.documentElement;
const body = document.body;
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
const MAX_ZIP = +body.dataset.maxzip || 100;
const P_DEFAULT = { theme: 'std', scheme: 'system', accent: 'auto', motion: 'auto', compact: false, bitrate: body.dataset.bitrate || '192', autoload: true, sound: true, notify: false };
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let prefs = { ...P_DEFAULT, ...store.get('ytmp3.prefs', {}) };
let theme = '';
let pl = null;            // geladene Playlist
let filter = 'all', query = '';
let loading = false, anchor = null, lastPoint = null;
let zip = null;           // ZIP-Auftrag: {id, ids, state, shown}
const rows = new Map();   // Video-ID → Zeile
const jobs = new Map();   // Auftrags-ID → {kind, ids}
const live = new Set();   // Zeilen, die gerade laden (werden pro Bild weich nachgezogen)

// ---------- Symbole, Texte, Formate ----------
const P = {
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  load: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  zip: '<path d="M12 4v10M7.5 9.5L12 14l4.5-4.5M5 19h14"/>',
  save: '<path d="M12 4v10M7.5 9.5L12 14l4.5-4.5M5 19h14"/>',
  each: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
};
const TXT = { load: 'laden', settings: 'optionen', close: 'zu', zip: 'zip', save: 'sichern', each: 'einzeln', check: 'auswahl', stop: 'stopp', trash: 'verlauf löschen' };
const LONG = { load: 'Laden', zip: 'Als ZIP', save: 'Sichern', each: 'Einzeln', check: 'Alle auswählen', stop: 'Abbrechen', trash: 'Zuletzt geöffnet löschen' };
const CHIP = { idle: '', queue: 'Wartet', download: 'Lädt', convert: 'Wandelt um', done: 'Geladen', error: 'Fehler' };
const ACTIVE = ['queue', 'download', 'convert'];
const GET_HTML = `<span class="g-lbl"><svg viewBox="0 0 24 24"><path d="M12 5v11M7.5 11.5L12 16l4.5-4.5"/></svg>MP3</span>
  <svg class="g-ring" viewBox="0 0 32 32"><circle class="rt" cx="16" cy="16" r="13.5"/><circle class="rv" cx="16" cy="16" r="13.5" pathLength="100"/></svg>
  <svg class="g-stop" viewBox="0 0 10 10"><rect width="10" height="10" rx="2.2"/></svg>
  <svg class="g-ok" viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" pathLength="1"/></svg>
  <svg class="g-bad" viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/></svg>`;

const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const artist = s => String(s || '').replace(/ - Topic$/, '');
const isField = t => t instanceof Element && t.closest('input,textarea,select,[contenteditable]');
const isActive = r => ACTIVE.includes(r.st.status);
const smooth = () => root.dataset.motion !== 'off';
const fancy = () => theme === 'std' || theme === 'glass';
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
function fmtB(b) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return (i ? nf1.format(b) : Math.round(b)) + ' ' + u[i];
}
function fmtT(s) {
  if (!isFinite(s) || s == null || s < 0) return '';
  s = Math.round(s);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function fmtDur(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}
function fmtLong(s) {
  s = Math.round(s || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
  if (h) return `${h} Std.${m ? ` ${m} Min.` : ''}`;
  return m ? `${m} Min.` : `${s} Sek.`;
}

function label(k, text) {
  if (fancy()) return `<svg viewBox="0 0 24 24" aria-hidden="true">${P[k] || ''}</svg>${text ? `<span>${esc(text)}</span>` : ''}`;
  const t = text || TXT[k];
  if (!t) return '';
  return theme === 'ascii' ? `[${esc(t.toLowerCase())}]` : esc(t.toUpperCase());
}
function btn(el, k, text) {
  const h = label(k, text);
  if (el._h !== h) { el.innerHTML = h; el._h = h; }
}

// Text setzen; im Split-Flap-Design Zeichen für Zeichen mit Klapp-Animation (aus Speedload)
function setF(el, text) {
  if (theme !== 'flap' || !el.classList.contains('f')) { if (el.textContent !== text) el.textContent = text; return; }
  const w = +el.dataset.w || text.length;
  text = text.toUpperCase().padEnd(w).slice(0, w);
  if (el.children.length !== w || !el.firstElementChild.classList.contains('fl')) el.innerHTML = '<span class="fl"></span>'.repeat(w);
  [...el.children].forEach((c, i) => {
    if (c.textContent !== text[i]) {
      c.textContent = text[i];
      if (smooth()) { c.classList.remove('flip'); void c.offsetWidth; c.style.animationDelay = i * 18 + 'ms'; c.classList.add('flip'); }
    }
  });
}

// Zahl rollt nach oben oder unten weg
function roll(el, text) {
  const cur = el.lastElementChild;
  if (cur && cur.textContent === text) return;
  if (!smooth() || !cur) { el.innerHTML = `<span>${esc(text)}</span>`; return; }
  const up = +text > +cur.textContent;
  const n = document.createElement('span');
  n.textContent = text;
  n.className = up ? 'dn' : 'up';
  el.append(n);
  cur.className = up ? 'up' : 'dn';
  setTimeout(() => cur.remove(), 520);
  requestAnimationFrame(() => requestAnimationFrame(() => { n.className = ''; }));
  while (el.children.length > 3) el.firstElementChild.remove();
}

function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

// ---------- Server ----------
async function api(path, data, method) {
  let r;
  try {
    r = await fetch(path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
      cache: 'no-store',
    });
  } catch { throw 'Keine Verbindung zum Server.'; }
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw v.error || 'Fehler ' + r.status;
  return v;
}

// ---------- Aussehen ----------
function applyLook(animate) {
  const scheme = prefs.scheme === 'system' ? (mqDark.matches ? 'dark' : 'light') : prefs.scheme;
  const motion = prefs.motion === 'auto' ? (mqMotion.matches ? 'reduced' : 'full') : prefs.motion;
  const go = () => {
    root.dataset.scheme = scheme;
    root.dataset.motion = motion;
    if (prefs.accent === 'auto') { body.style.removeProperty('--acc'); body.style.removeProperty('--acc2'); }
    else { body.style.setProperty('--acc', prefs.accent); body.style.setProperty('--acc2', `color-mix(in oklab, ${prefs.accent}, #fff 35%)`); }
    body.classList.toggle('compact', !!prefs.compact);
    if (prefs.theme !== theme) {
      theme = prefs.theme;
      body.classList.remove('t-std', 't-glass', 't-ascii', 't-flap');
      body.classList.add('t-' + theme);
      rebuild();
    }
    const tc = $('meta[name=theme-color]');
    if (tc) tc.content = getComputedStyle(body).getPropertyValue('--bg').trim() || '#1b1b1d';
    moveInds();
    topH();
  };
  const big = theme && (prefs.theme !== theme || scheme !== root.dataset.scheme);
  if (animate && big && document.startViewTransition && motion !== 'off') reveal(go); else go();
}

// Neues Design wächst als Kreis aus dem Klickpunkt
function reveal(go) {
  const [x, y] = lastPoint || [innerWidth / 2, innerHeight / 2];
  const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(go);
  vt.ready.then(() => root.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
    { duration: 750, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
  )).catch(() => {});
}

function rebuild() {
  $$('[data-ic]').forEach(el => { el._h = null; btn(el, el.dataset.ic, 'txt' in el.dataset ? LONG[el.dataset.ic] : ''); });
  const logo = $('.logo');
  if (theme === 'flap') setF(logo, 'YT MUSIC>MP3');
  else logo.innerHTML = 'YT Music <em>→</em> MP3';
  if (pl) {
    $('#pltitle').textContent = '';
    setF($('#pltitle'), pl.title);
    buildList(false);
  }
  $('#empty').dataset.k = '';
  if (!pl && !loading) renderEmpty('welcome');
  renderMeta();
}

function moveInds() {
  $$('.tabs,.seg').forEach(box => {
    const ind = $('.ind', box);
    if (!ind) return;
    const on = box.classList.contains('tabs') ? $('[aria-selected=true]', box) : $('input:checked', box)?.closest('label');
    if (!on || !on.offsetWidth) { ind.style.opacity = 0; return; }
    const first = !ind.style.width;
    if (first) ind.style.transition = 'none';
    ind.style.opacity = 1;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
    if (first) { void ind.offsetWidth; ind.style.transition = ''; }
  });
}

function topH() {
  root.style.setProperty('--top-h', $('#top').offsetHeight + 'px');
}

// ---------- Playlist laden ----------
function pickUrl(raw) {
  const s = String(raw || '').trim();
  const url = s.split(/\s+/).find(u => /^https?:\/\/\S+$/i.test(u));
  if (url) return url;
  if (/^[\w-]{11}$/.test(s)) return 'https://www.youtube.com/watch?v=' + s;
  if (/^(PL|OL|RD|UU|LL|FL|VL)[\w-]{10,}$/.test(s)) return 'https://music.youtube.com/playlist?list=' + s;
  return '';
}

async function loadPlaylist(raw) {
  const url = pickUrl(raw);
  if (!url) { shake($('#loadf')); toast('Das sieht nicht nach einem Link aus', 'bad'); return; }
  if (loading) return;
  if (jobs.size && !await ask('Laufende Downloads stoppen?', 'Beim Öffnen einer anderen Playlist werden laufende Downloads abgebrochen.', 'Stoppen & öffnen')) return;
  cancelAll();
  $('#url').value = url;
  loading = true;
  root.classList.add('loading');
  const lb = $('#loadb');
  lb.disabled = true;
  lb._h = null;
  lb.innerHTML = '<span class="spin"></span>';
  skeleton();
  try {
    const data = await api('/api/playlist', { url });
    pl = { ...data, url };
    remember(pl);
    try { history.replaceState(null, '', '?url=' + encodeURIComponent(url)); } catch {}
    showPlaylist(true);
    $('#url').blur();
  } catch (e) {
    toast(String(e), 'bad');
    shake($('#loadf'));
    if (pl) showPlaylist(false); else showWelcome();
  } finally {
    loading = false;
    root.classList.remove('loading');
    lb.disabled = false;
    btn(lb, 'load', LONG.load);
  }
}

function skeleton() {
  $('#empty').hidden = true;
  $('#toolbar').hidden = true;
  const hero = $('#hero');
  hero.hidden = false;
  hero.classList.remove('in');
  $('#kind').textContent = 'Wird geladen…';
  $('#pltitle').innerHTML = '<span class="sk" style="display:block;width:min(420px,70%);height:32px;border-radius:8px"></span>';
  $('#plmeta').innerHTML = '<span class="sk" style="display:inline-block;width:180px;height:14px"></span>';
  $('.hero-acts').hidden = true;
  const cover = $('#cover');
  cover.className = 'cover sk';
  cover.innerHTML = '';
  $('#herobg').style.backgroundImage = 'none';
  const list = $('#list');
  list.innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="skrow" style="animation-delay:${i * 50}ms">
    <span class="sk" style="height:20px;border-radius:6px"></span><span class="sk" style="height:48px;border-radius:9px"></span>
    <span class="l"><span class="sk" style="height:13px;width:${55 + (i * 17) % 35}%"></span><span class="sk" style="height:11px;width:${25 + (i * 11) % 20}%"></span></span>
    <span class="sk" style="height:30px;border-radius:99px"></span></div>`).join('');
  live.clear();
  renderMeta();
}

function showPlaylist(fresh) {
  const e = $('#empty');
  e.hidden = true;
  if (fresh) {
    rows.clear();
    live.clear();
    anchor = null;
    filter = 'all';
    query = '';
    $('#find').value = '';
    pl.entries.forEach((t, i) => rows.set(t.id, { id: t.id, t, i, el: null, sel: true, st: { status: 'idle', pct: 0, speed: 0, eta: null, error: '' }, job: null, shown: 0, sp: 0, file: null, doneAt: 0, br: prefs.bitrate }));
  }
  const n = pl.entries.length;
  const dur = pl.entries.reduce((s, t) => s + (t.duration || 0), 0);
  $('#kind').textContent = pl.is_playlist ? 'Playlist' : 'Einzelner Titel';
  $('#pltitle').textContent = '';
  setF($('#pltitle'), pl.title);
  const by = artist(pl.uploader || (!pl.is_playlist && pl.entries[0] && pl.entries[0].uploader));
  $('#plmeta').textContent = [by, n === 1 ? '1 Titel' : `${n} Titel`, fmtLong(dur)].filter(Boolean).join(' · ');
  $('.hero-acts').hidden = false;
  buildCover();
  const hero = $('#hero');
  hero.hidden = false;
  if (fresh) { hero.classList.remove('in'); void hero.offsetWidth; hero.classList.add('in'); }
  $('#toolbar').hidden = n < 2;
  buildList(fresh);
  renderMeta();
  topH();
}

function buildCover() {
  const cover = $('#cover');
  const ids = pl.entries.slice(0, 4).map(t => t.id);
  const srcs = pl.thumbnail ? [pl.thumbnail] : ids.length >= 4 ? ids.map(thumb) : [pl.entries[0] && (pl.entries[0].thumbnail || thumb(pl.entries[0].id))];
  cover.className = 'cover' + (srcs.length === 4 ? ' mosaic' : '');
  cover.innerHTML = '';
  srcs.filter(Boolean).forEach(src => {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => img.classList.add('ok');
    img.src = src;
    cover.append(img);
  });
  $('#herobg').style.backgroundImage = srcs[0] ? `url("${srcs[0]}")` : 'none';
}

// ---------- Liste ----------
function buildList(stagger) {
  const list = $('#list');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const r of rows.values()) {
    makeRow(r);
    const vis = matches(r);
    r.el.hidden = !vis;
    if (vis && stagger && smooth() && shown < 16) {
      r.el.classList.add('in');
      r.el.style.animationDelay = shown * 38 + 'ms';
    }
    if (vis) shown++;
    frag.append(r.el);
    update(r);
  }
  list.append(frag);
  renderEmptyFilter();
}

function makeRow(r) {
  const el = document.createElement('article');
  el.className = 'trk' + (r.sel ? ' sel' : '');
  el.dataset.id = r.id;
  el.innerHTML = `<span class="cb" role="checkbox" tabindex="0" aria-checked="${r.sel}" aria-label="Auswählen"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
    <div class="art"><img alt=""><span class="no"></span><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></div>
    <div class="body">
      <div class="line1"><span class="name f" data-w="26"></span><span class="chip"></span></div>
      <div class="sub"><span class="artist"></span><span class="dur"></span></div>
      <div class="more"><div><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><div class="stats"><span class="pct"></span><span class="spd"></span><span class="eta"></span><span class="msg"></span></div></div></div>
    </div>
    <button class="get" type="button"></button>`;
  const q = s => el.querySelector(s);
  r.q = q;
  r.el = el;
  setF(q('.name'), r.t.title);
  q('.name').title = r.t.title;
  q('.artist').textContent = artist(r.t.uploader);
  q('.dur').textContent = fmtDur(r.t.duration);
  q('.no').textContent = String(r.i + 1).padStart(2, '0');
  if (fancy()) {
    const img = q('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = () => img.classList.add('ok');
    img.onerror = () => { if (r.t.thumbnail && img.src !== r.t.thumbnail) img.src = r.t.thumbnail; };
    img.src = thumb(r.id);
    q('.get').innerHTML = GET_HTML;
  }
  el.addEventListener('animationend', e => { if (e.animationName === 'cardIn') { el.classList.remove('in'); el.style.animationDelay = ''; } });
}

function update(r) {
  const s = r.st, st = s.status, el = r.el;
  if (!el) return;
  el.dataset.st = st;
  el.classList.toggle('act', ACTIVE.includes(st));
  r.q('.chip').textContent = CHIP[st] || '';
  const inZip = zip && r.job === zip.id && ACTIVE.includes(st);
  const g = r.q('.get');
  g.classList.toggle('zipped', !!inZip);
  const tip = inZip ? 'Wird in die ZIP gepackt' : st === 'download' || st === 'queue' || st === 'convert' ? 'Abbrechen'
    : st === 'done' ? 'Nochmal sichern' : st === 'error' ? 'Erneut versuchen' : 'Als MP3 laden';
  g.title = tip;
  g.setAttribute('aria-label', `${tip}: ${r.t.title}`);
  r.q('.msg').textContent = st === 'queue' ? (inZip ? 'Wartet auf seinen Platz in der ZIP…' : 'Wartet auf einen freien Platz…')
    : st === 'convert' ? `Wird zu MP3 umgewandelt (${r.br} kbps)…` : st === 'error' ? s.error : '';
  if (st !== 'download') { r.q('.spd').textContent = ''; r.q('.eta').textContent = ''; r.q('.pct').textContent = ''; }
  paint(r);
}

// Fortschritt zeichnen (pro Bild für ladende Zeilen)
function paint(r) {
  const st = r.st.status, pct = st === 'done' ? 100 : st === 'download' ? r.shown : 0;
  const bar = r.q('.bar');
  if (theme === 'ascii') {
    const n = prefs.compact ? 28 : 40, k = Math.round(pct / 100 * n);
    const t = st === 'convert' || st === 'queue' ? '[' + '~'.repeat(n) + ']' : '[' + '#'.repeat(k) + '.'.repeat(n - k) + ']';
    if (bar.textContent !== t) bar.textContent = t;
  } else if (theme === 'flap') {
    const n = 30;
    if (bar.children.length !== n) bar.innerHTML = '<b></b>'.repeat(n);
    const k = Math.round(pct / 100 * n);
    [...bar.children].forEach((b, i) => { const on = i < k; if (b.classList.contains('on') !== on) b.classList.toggle('on', on); });
  } else {
    bar.firstElementChild.style.width = pct + '%';
    const rv = r.q('.rv');
    if (rv) rv.style.strokeDashoffset = 100 - pct;
  }
  bar.setAttribute('aria-valuenow', Math.floor(pct));
  if (st === 'download') {
    r.q('.pct').textContent = nf1.format(pct) + ' %';
    r.q('.spd').textContent = r.sp > 1 ? fmtB(r.sp) + '/s' : '';
    r.q('.eta').textContent = r.st.eta != null ? 'noch ' + fmtT(r.st.eta) : '';
  }
  if (!fancy()) {
    const t = { idle: 'mp3', queue: '…', download: Math.floor(pct) + '%', convert: 'mp3…', done: 'ok', error: 'nochmal' }[st];
    const g = r.q('.get'), txt = theme === 'ascii' ? `[${t}]` : t.toUpperCase();
    if (g.textContent !== txt) g.textContent = txt;
  }
}

function setState(r, patch) {
  const was = r.st.status;
  r.st = { ...r.st, ...patch };
  const st = r.st.status;
  if (st === 'download') live.add(r); else live.delete(r);
  if (st === 'download' && was !== 'download') r.shown = 0;
  if (!smooth()) { r.shown = r.st.pct; r.sp = r.st.speed; }
  if (was !== st) update(r); else if (st !== 'download') update(r);
  if (st === 'done' && was !== 'done') finished(r);
  meta();
}

function matches(r) {
  const s = r.st.status;
  const okF = filter === 'all' || (filter === 'sel' && r.sel) || (filter === 'done' && s === 'done') || (filter === 'err' && s === 'error');
  if (!okF) return false;
  if (!query) return true;
  return norm(r.t.title + ' ' + r.t.uploader).includes(query);
}

function applyFilter() {
  let k = 0;
  for (const r of rows.values()) {
    const vis = matches(r);
    if (vis && r.el.hidden && smooth() && k < 14) {
      r.el.classList.remove('in');
      void r.el.offsetWidth;
      r.el.style.animationDelay = k++ * 30 + 'ms';
      r.el.classList.add('in');
    }
    r.el.hidden = !vis;
  }
  renderEmptyFilter();
  renderMeta();
}

function visibleRows() { return [...rows.values()].filter(r => r.el && !r.el.hidden); }

function setSel(r, v, pop) {
  if (r.sel === v) return;
  r.sel = v;
  r.el.classList.toggle('sel', v);
  const cb = r.q('.cb');
  cb.setAttribute('aria-checked', v);
  if (pop && smooth()) { cb.classList.remove('pop'); void cb.offsetWidth; cb.classList.add('pop'); }
}

function toggle(r, range) {
  const vis = visibleRows();
  if (range && anchor && anchor !== r && vis.includes(anchor)) {
    const a = vis.indexOf(anchor), b = vis.indexOf(r);
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) setSel(vis[k], anchor.sel, true);
  } else {
    setSel(r, !r.sel, true);
    anchor = r;
  }
  meta();
}

function selectAll(v) {
  const vis = visibleRows();
  if (v == null) v = !vis.every(r => r.sel);
  vis.forEach(r => setSel(r, v, false));
  meta();
}

// ---------- Kopf, Tabs, Dock ----------
let metaQ = 0;
function meta() { if (!metaQ) metaQ = requestAnimationFrame(() => { metaQ = 0; renderMeta(); }); }

function renderMeta() {
  const all = [...rows.values()];
  const count = { all: all.length, sel: 0, done: 0, err: 0 };
  let selDur = 0;
  for (const r of all) {
    if (r.sel) { count.sel++; selDur += r.t.duration || 0; }
    if (r.st.status === 'done') count.done++;
    if (r.st.status === 'error') count.err++;
  }
  $$('.tabs [data-f]').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.f === filter);
    const n = String(count[b.dataset.f]);
    if (b.lastElementChild.textContent !== n) b.lastElementChild.textContent = n;
  });
  moveInds();

  const zipRunning = !!(zip && !['done', 'error', 'cancelled'].includes(zip.state.status));
  const vis = visibleRows();
  btn($('#selall'), 'check', vis.length && vis.every(r => r.sel) ? 'Keine auswählen' : 'Alle auswählen');
  btn($('#allzip'), 'zip', all.length === 1 ? 'Als MP3 laden' : 'Alles als ZIP');
  $('#allzip').disabled = zipRunning || !all.length;
  $('#selall').hidden = all.length < 2;

  // Dock
  const dock = $('#dock'), din = $('.dock-in');
  const mode = zip ? (zip.state.status === 'done' ? 'zipdone' : 'zip') : 'sel';
  dock.classList.toggle('on', !!pl && !loading && (mode !== 'sel' || count.sel > 0));
  din.dataset.m = mode;
  roll($('#selcount'), String(count.sel));
  $('#selinfo').textContent = [fmtLong(selDur), `MP3 · ${prefs.bitrate} kbps`].filter(Boolean).join(' · ');
  btn($('#zipsel'), count.sel === 1 ? 'each' : 'zip', count.sel === 1 ? 'Als MP3' : 'Als ZIP');
  $('#zipsel').disabled = zipRunning && count.sel > 1;
  $('#each').hidden = count.sel < 2;
  if (zip) renderZip();
  else document.title = 'YT Music → MP3';
}

function zipProgress(s) {
  const total = s.tracks.length || 1;
  let p = 0;
  for (const t of s.tracks) {
    if (t.status === 'done' || t.status === 'error') p += 1;
    else if (t.status === 'download') p += (t.pct || 0) / 100 * .85;
    else if (t.status === 'convert') p += .92;
  }
  return Math.min(100, p / total * 100);
}

function renderZip() {
  const s = zip.state, total = s.tracks.length;
  if (s.status === 'done') {
    $('#dhead').textContent = 'ZIP fertig';
    $('#dsub').textContent = [`${s.ok} Titel`, s.skipped ? `${s.skipped} übersprungen` : '', s.download_name].filter(Boolean).join(' · ');
    document.title = 'Fertig · YT Music → MP3';
    return;
  }
  const finished = s.tracks.filter(t => t.status === 'done' || t.status === 'error').length;
  const cur = s.tracks.find(t => t.status === 'download' || t.status === 'convert');
  $('#zhead').textContent = s.status === 'queue' ? 'ZIP wartet…' : `ZIP · Titel ${Math.min(finished + 1, total)} von ${total}`;
  $('#zsub').textContent = [cur ? cur.title + (cur.status === 'convert' ? ' · wird umgewandelt' : '') : 'Gleich geht’s los…', s.skipped ? `${s.skipped} übersprungen` : ''].filter(Boolean).join(' · ');
  document.title = `${Math.floor(zip.shown)} % · YT Music → MP3`;
}

// ---------- Leer / Willkommen ----------
const CASSETTE = (a, b) => `  .-----------------------.
  |  .-----------------.  |
  |  |   (<span>${a}</span>)     (<span>${b}</span>)   |  |
  |  '-----------------'  |
  |      ___________      |
  '-----/_o_______o_\\-----'`;
let reelTimer = 0;

function showWelcome() {
  cancelAll();
  pl = null;
  rows.clear();
  live.clear();
  $('#list').textContent = '';
  $('#hero').hidden = true;
  $('#toolbar').hidden = true;
  try { history.replaceState(null, '', location.pathname); } catch {}
  renderEmpty('welcome');
  renderMeta();
}

function renderEmptyFilter() {
  if (!pl) return;
  const any = visibleRows().length > 0;
  if (any) { $('#empty').hidden = true; return; }
  renderEmpty('nothing');
}

function renderEmpty(kind) {
  const e = $('#empty');
  e.hidden = false;
  const recent = store.get('ytmp3.recent', []);
  const key = kind + theme + (kind === 'welcome' ? recent.map(x => x.url).join() : filter + query);
  if (e.dataset.k === key) return;
  e.dataset.k = key;
  clearInterval(reelTimer);
  e.classList.remove('in', 'nothing');
  if (kind === 'welcome') {
    const art = fancy() ? `<div class="eqart" aria-hidden="true">${'<i></i>'.repeat(7)}</div>`
      : theme === 'ascii' ? `<pre aria-hidden="true">${CASSETTE('|', '|')}</pre>` : '<div></div>';
    e.innerHTML = `${art}<h2 class="f" data-w="16"></h2>
      <p>Link von YouTube Music oder YouTube einfügen – Playlist, Album oder einzelner Titel. Dann auswählen und einzeln oder als ZIP laden.</p>
      <div class="hints"><span class="k"><kbd>/</kbd> Link-Feld</span><span class="k"><kbd>Strg</kbd>+<kbd>V</kbd> irgendwo einfügen</span><span class="k">Link ins Fenster ziehen</span></div>
      ${recent.length ? `<div class="recent"><h3>Zuletzt geöffnet</h3><div class="rgrid">${recent.map((x, i) => `
        <button class="rc" data-url="${esc(x.url)}" style="animation-delay:${i * 40}ms">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
        <span><b>${esc(x.title)}</b><small>${x.count === 1 ? '1 Titel' : x.count + ' Titel'}</small></span><span class="x" role="button" tabindex="0" data-forget="${esc(x.url)}" aria-label="Aus Verlauf entfernen"><svg viewBox="0 0 24 24">${P.close}</svg></span></button>`).join('')}</div></div>` : '<div></div>'}`;
    const h = $('h2', e), w = theme === 'flap' ? 'Link einfügen' : 'Aus Playlists werden MP3s.';
    h.dataset.w = w.length;
    setF(h, w);
    if (theme === 'ascii' && smooth()) {
      let k = 0;
      reelTimer = setInterval(() => {
        const pre = $('pre', e);
        if (!pre || e.hidden) return clearInterval(reelTimer);
        const c = '|/-\\'[k++ % 4];
        pre.querySelectorAll('span').forEach(s => { s.textContent = c; });
      }, 160);
    }
  } else {
    e.classList.add('nothing');
    const msg = query ? ['Nichts gefunden', `Kein Titel passt zu „${$('#find').value.trim()}“.`]
      : filter === 'sel' ? ['Nichts ausgewählt', 'Tippe auf einen Titel, um ihn auszuwählen.']
        : filter === 'done' ? ['Noch nichts geladen', 'Fertige MP3s erscheinen hier.']
          : filter === 'err' ? ['Keine Fehler', 'Alles lief glatt.'] : ['Hier ist nichts', ''];
    e.innerHTML = `<h2 class="f" data-w="${msg[0].length}"></h2><p></p>`;
    setF($('h2', e), msg[0]);
    $('p', e).textContent = msg[1];
  }
  if (smooth()) { void e.offsetWidth; e.classList.add('in'); }
}

function remember(p) {
  const first = p.entries[0];
  const entry = { url: p.url, title: p.title, count: p.entries.length, thumb: p.thumbnail || (first ? thumb(first.id) : '') };
  const list = store.get('ytmp3.recent', []).filter(x => x.url !== p.url);
  list.unshift(entry);
  store.set('ytmp3.recent', list.slice(0, 6));
}

// ---------- Downloads ----------
// Einzel-MP3s: höchstens drei Aufträge gleichzeitig, der Rest wartet hier
const pending = [];
let inflight = 0;
const mp3Jobs = () => [...jobs.values()].filter(j => j.kind === 'mp3').length;

function startMp3(r) {
  if (isActive(r)) return;
  r.job = null;
  r.br = prefs.bitrate;
  setState(r, { status: 'queue', pct: 0, speed: 0, eta: null, error: '' });
  pending.push(r);
  pump();
}

function pump() {
  while (pending.length && mp3Jobs() + inflight < 3) {
    const r = pending.shift();
    if (r.st.status !== 'queue' || r.job || r.launching || rows.get(r.id) !== r) continue;
    inflight++;
    r.launching = true;
    launch(r).finally(() => { r.launching = false; inflight--; pump(); });
  }
}

async function launch(r) {
  try {
    const s = await api('/api/jobs', { ids: [r.id], titles: { [r.id]: r.t.title }, bitrate: r.br });
    if (r.st.status !== 'queue' || rows.get(r.id) !== r) { api('/api/jobs/' + s.id, null, 'DELETE').catch(() => {}); return; }
    r.job = s.id;
    jobs.set(s.id, { kind: 'mp3', ids: [r.id] });
    poll();
  } catch (e) {
    setState(r, { status: 'error', error: String(e) });
    toast(String(e), 'bad');
  }
}

async function startZip(list) {
  if (!list.length) return;
  if (list.length === 1) return startMp3(list[0]);
  if (zip && zip.state.status !== 'done') { toast('Es wird schon eine ZIP erstellt', 'info'); return; }
  if (list.length > MAX_ZIP) { toast(`Höchstens ${MAX_ZIP} Titel pro ZIP – bitte weniger auswählen`, 'bad'); return; }
  const titles = {};
  list.forEach(r => { titles[r.id] = r.t.title; });
  try {
    const s = await api('/api/jobs', { ids: list.map(r => r.id), titles, zip: true, name: pl.title, bitrate: prefs.bitrate });
    zip = { id: s.id, ids: list.map(r => r.id), state: s, shown: 0 };
    jobs.set(s.id, { kind: 'zip', ids: zip.ids });
    list.forEach(r => {
      if (isActive(r)) return;
      r.job = s.id;
      r.br = prefs.bitrate;
      setState(r, { status: 'queue', pct: 0, speed: 0, eta: null, error: '' });
    });
    meta();
    poll();
  } catch (e) { toast(String(e), 'bad'); }
}

function startEach(list) {
  list.filter(r => !isActive(r)).forEach((r, i) => setTimeout(() => startMp3(r), i * 60));
}

function cancelJob(id) {
  const j = jobs.get(id);
  jobs.delete(id);
  api('/api/jobs/' + id, null, 'DELETE').catch(() => {});
  if (!j) return;
  for (const vid of j.ids) {
    const r = rows.get(vid);
    if (r && r.job === id && isActive(r)) { r.job = null; setState(r, { status: 'idle', pct: 0 }); }
  }
  pump();
}

function cancelAll() {
  pending.length = 0;
  [...jobs.keys()].forEach(cancelJob);
  for (const r of rows.values()) if (isActive(r)) { r.job = null; setState(r, { status: 'idle', pct: 0 }); }
  zip = null;
}

function save(id) {
  const a = document.createElement('a');
  a.href = `/api/jobs/${id}/file`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

function getClick(r) {
  const st = r.st.status;
  if (zip && r.job === zip.id && isActive(r)) return;
  if (isActive(r)) { if (r.job) cancelJob(r.job); else setState(r, { status: 'idle' }); return; }
  if (st === 'done' && r.file && Date.now() - r.doneAt < 25 * 60e3) { save(r.file); return; }
  startMp3(r);
}

let polling = false;
function poll() { if (!polling) tick(); }
async function tick() {
  polling = true;
  const ids = [...jobs.keys()];
  if (!ids.length) { polling = false; return; }
  await Promise.all(ids.map(async id => {
    try { applyJob(await api('/api/jobs/' + id)); }
    catch (e) {
      const j = jobs.get(id);
      if (!j) return;
      j.fails = (j.fails || 0) + 1;
      if (j.fails > 10 || /nicht gefunden/i.test(String(e))) failJob(id, String(e));
    }
  }));
  setTimeout(tick, document.hidden ? 1500 : 450);
}

function failJob(id, msg) {
  const j = jobs.get(id);
  jobs.delete(id);
  if (!j) return;
  for (const vid of j.ids) {
    const r = rows.get(vid);
    if (r && r.job === id && isActive(r)) setState(r, { status: 'error', error: msg });
  }
  if (zip && zip.id === id) { zip = null; toast(msg, 'bad'); }
}

let batch = { ok: 0 };
function applyJob(s) {
  const j = jobs.get(s.id);
  if (!j) return;
  for (const t of s.tracks) {
    const r = rows.get(t.id);
    if (!r || r.job !== s.id) continue;
    const status = t.status === 'cancelled' ? 'idle' : t.status;
    r.br = r.br || prefs.bitrate;
    setState(r, { status, pct: t.pct || 0, speed: t.speed || 0, eta: t.eta, error: t.error || '' });
  }
  if (zip && zip.id === s.id) zip.state = s;
  if (!['done', 'error', 'cancelled'].includes(s.status)) return;
  jobs.delete(s.id);
  if (j.kind === 'mp3') {
    const r = rows.get(j.ids[0]);
    if (s.status === 'done') {
      if (r) { r.file = s.id; r.doneAt = Date.now(); }
      batch.ok++;
      save(s.id);
    } else if (s.status === 'error') {
      if (r && r.st.status !== 'error') setState(r, { status: 'error', error: s.error });
      toast(s.error || 'Download fehlgeschlagen', 'bad');
    }
    pump();
    if (!mp3Jobs() && !pending.length && !inflight) {
      if (batch.ok > 1) done(`${batch.ok} MP3s sind fertig`);
      batch = { ok: 0 };
    }
  } else if (zip && zip.id === s.id) {
    if (s.status === 'done') {
      save(s.id);
      done(`ZIP fertig: ${s.ok} Titel${s.skipped ? `, ${s.skipped} übersprungen` : ''}`);
    } else {
      if (s.status === 'error') toast(s.error || 'ZIP fehlgeschlagen', 'bad');
      zip = null;
    }
  }
  meta();
}

function finished(r) {
  const el = r.el;
  if (el && smooth()) { el.classList.remove('yay'); void el.offsetWidth; el.classList.add('yay'); }
  if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
}

function done(msg) {
  toast(msg, 'ok');
  if (prefs.sound) chime();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus()))
    try { new Notification('YT Music → MP3', { body: msg, tag: 'ytmp3' }); } catch {}
}

// ---------- Bild für Bild ----------
let zipDrawn = false;
function frame() {
  const k = smooth() ? .16 : 1;
  for (const r of live) {
    r.shown += (r.st.pct - r.shown) * k;
    if (Math.abs(r.st.pct - r.shown) < .05) r.shown = r.st.pct;
    r.sp += ((r.st.speed || 0) - r.sp) * (smooth() ? .08 : 1);
    paint(r);
  }
  if (zip && zip.state.status !== 'done') {
    const target = zipProgress(zip.state);
    zip.shown += (target - zip.shown) * (smooth() ? .1 : 1);
    const p = zip.shown;
    $('.d-fill').style.width = p + '%';
    $('.dmini .rv').style.strokeDashoffset = 100 - p;
    const t = String(Math.floor(p));
    if ($('#zpct').textContent !== t) $('#zpct').textContent = t;
    const tt = `${t} % · YT Music → MP3`;
    if (document.title !== tt && zip.state.status !== 'queue') document.title = tt;
  } else if (!zip && zipDrawn) $('.d-fill').style.width = '0';
  zipDrawn = !!zip;
  requestAnimationFrame(frame);
}

// ---------- Meldungen ----------
function ask(title, text, ok) {
  const d = $('#ask');
  $('#ask-t').textContent = title;
  $('#ask-p').textContent = text;
  $('#ask-ok').textContent = ok;
  d.returnValue = '';
  d.showModal();
  $('#ask-no').focus();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}

function toast(msg, kind = 'info', action) {
  const box = $('#toasts');
  while (box.children.length > 2) box.firstElementChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  const s = document.createElement('span');
  s.textContent = msg;
  t.append(s);
  const bye = () => { t.classList.add('out'); setTimeout(() => t.remove(), 320); };
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); bye(); }; t.append(b); }
  box.append(t);
  setTimeout(bye, kind === 'bad' ? 6000 : 3500);
}

function chime() {
  try {
    const a = new AudioContext(), t0 = a.currentTime;
    [660, 880, 1320].forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain(), t = t0 + i * .11;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(.12, t + .02);
      g.gain.exponentialRampToValueAtTime(.001, t + .45);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + .5);
    });
    setTimeout(() => a.close(), 1200);
  } catch {}
}

// ---------- Einstellungen ----------
function fillPrefs() {
  $$('[data-p]').forEach(el => {
    const v = prefs[el.dataset.p];
    if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.type === 'checkbox') el.checked = !!v;
  });
  moveInds();
}

function bindPrefs() {
  $$('[data-p]').forEach(el => el.addEventListener('change', async () => {
    if (el.type === 'radio' && !el.checked) return;
    const k = el.dataset.p;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'notify' && v && 'Notification' in window && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { v = el.checked = false; toast('Benachrichtigungen wurden nicht erlaubt', 'bad'); }
    }
    prefs[k] = v;
    store.set('ytmp3.prefs', prefs);
    fillPrefs();
    applyLook(true);
    if (k === 'compact' && pl) for (const r of rows.values()) paint(r);
    meta();
  }));
}

function openDrawer() {
  fillPrefs();
  const d = $('#drawer');
  d.classList.remove('closing');
  if (!d.open) d.showModal();
  requestAnimationFrame(moveInds);
}
function closeDrawer() {
  const d = $('#drawer');
  if (!d.open || d.classList.contains('closing')) return;
  if (!smooth()) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.classList.remove('closing'); d.close(); }, 240);
}

// ---------- Ereignisse ----------
$('#loadf').addEventListener('submit', e => { e.preventDefault(); loadPlaylist($('#url').value); });
$('#url').addEventListener('paste', () => setTimeout(() => { if (prefs.autoload && pickUrl($('#url').value)) loadPlaylist($('#url').value); }, 0));
$('#setb').onclick = openDrawer;
$('#drclose').onclick = closeDrawer;
$('#drawer').addEventListener('cancel', e => { e.preventDefault(); closeDrawer(); });
$('#drawer').addEventListener('click', e => { if (e.target === e.currentTarget) closeDrawer(); });
$('#forget').onclick = () => { store.set('ytmp3.recent', []); toast('Verlauf gelöscht', 'ok'); if (!pl) renderEmpty('welcome'); };

const goHome = async () => {
  if (!pl) { $('#url').focus(); return; }
  if (jobs.size && !await ask('Zur Startseite?', 'Laufende Downloads werden dabei abgebrochen.', 'Abbrechen & zurück')) return;
  $('#url').value = '';
  showWelcome();
};
$('#home').addEventListener('click', goHome);
$('#home').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

$('#list').addEventListener('click', e => {
  const el = e.target.closest('.trk');
  if (!el) return;
  const r = rows.get(el.dataset.id);
  if (!r) return;
  if (e.target.closest('.get')) { getClick(r); return; }
  toggle(r, e.shiftKey);
});
$('#list').addEventListener('keydown', e => {
  const cb = e.target.closest('.cb');
  if (!cb || (e.key !== ' ' && e.key !== 'Enter')) return;
  e.preventDefault();
  const r = rows.get(cb.closest('.trk').dataset.id);
  if (r) toggle(r, e.shiftKey);
});

$$('.tabs [data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; applyFilter(); }));
let findT = 0;
$('#find').addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(() => { query = norm($('#find').value.trim()); applyFilter(); }, 90); });
$('#find').addEventListener('keydown', e => { if (e.key === 'Escape' && $('#find').value) { e.preventDefault(); $('#find').value = ''; query = ''; applyFilter(); } });

$('#selall').onclick = () => selectAll();
$('#allzip').onclick = () => startZip([...rows.values()]);
$('#zipsel').onclick = () => { const s = [...rows.values()].filter(r => r.sel); s.length === 1 ? getClick(s[0]) : startZip(s); };
$('#each').onclick = () => startEach([...rows.values()].filter(r => r.sel));
$('#zstop').onclick = async () => {
  if (!zip) return;
  if (!await ask('ZIP abbrechen?', 'Bereits geladene Titel dieser ZIP gehen verloren.', 'Abbrechen')) return;
  if (zip) cancelJob(zip.id);
  zip = null;
  meta();
};
$('#dsave').onclick = () => { if (zip) save(zip.id); };
$('#dclose').onclick = () => { zip = null; meta(); };

$('#empty').addEventListener('click', e => {
  const x = e.target.closest('[data-forget]');
  if (x) {
    e.stopPropagation();
    store.set('ytmp3.recent', store.get('ytmp3.recent', []).filter(r => r.url !== x.dataset.forget));
    const card = x.closest('.rc');
    if (smooth() && card) { card.style.transition = 'opacity .25s, transform .35s var(--ease)'; card.style.opacity = 0; card.style.transform = 'scale(.92)'; setTimeout(() => renderEmpty('welcome'), 260); }
    else renderEmpty('welcome');
    return;
  }
  const c = e.target.closest('.rc');
  if (c) loadPlaylist(c.dataset.url);
});

addEventListener('pointerdown', e => { lastPoint = [e.clientX, e.clientY]; }, true);
mqDark.addEventListener('change', () => applyLook(true));
mqMotion.addEventListener('change', () => applyLook());
addEventListener('resize', () => { moveInds(); topH(); });
addEventListener('scroll', () => {
  const tb = $('#toolbar');
  if (!tb.hidden) tb.classList.toggle('stuck', tb.getBoundingClientRect().top <= $('#top').offsetHeight + 1 && scrollY > 40);
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && jobs.size) poll(); });
document.addEventListener('keydown', e => {
  if ($('dialog[open]')) return;
  if (e.key === '/' && !isField(e.target)) { e.preventDefault(); $('#url').focus(); $('#url').select(); }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openDrawer(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !isField(e.target) && pl) { e.preventDefault(); selectAll(); }
});
document.addEventListener('paste', e => {
  if (isField(e.target)) return;
  const t = e.clipboardData.getData('text');
  if (!pickUrl(t)) return;
  e.preventDefault();
  if (prefs.autoload) loadPlaylist(t); else { $('#url').value = pickUrl(t); $('#url').focus(); }
});
let dragDepth = 0;
const hasLink = e => [...e.dataTransfer.types].some(t => t === 'text/uri-list' || t === 'text/plain');
addEventListener('dragenter', e => { if (hasLink(e)) { dragDepth++; $('#drop').classList.add('on'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on'); } });
addEventListener('dragover', e => { if (hasLink(e)) e.preventDefault(); });
addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.remove('on');
  loadPlaylist((e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').filter(l => !l.startsWith('#')).join(' '));
});
new ResizeObserver(topH).observe($('#top'));

// ---------- Start ----------
applyLook();
fillPrefs();
bindPrefs();
const startUrl = new URLSearchParams(location.search).get('url');
if (startUrl) loadPlaylist(startUrl); else showWelcome();
requestAnimationFrame(frame);
