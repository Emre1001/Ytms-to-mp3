'use strict';
// YT Music → MP3 – Website: Scroll-Erzählung, Live-Demo, Downloads.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const REPO = 'Emre1001/Ytms-to-mp3';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ---------- Hell / Dunkel (wächst als Kreis aus dem Klickpunkt, wie in der App) ----------
const scheme = () => root.dataset.scheme || (mqDark.matches ? 'dark' : 'light');
function reveal(go, point) {
  if (!document.startViewTransition || reduce) { go(); return; }
  const [x, y] = point || [innerWidth / 2, innerHeight / 2];
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(go);
  vt.ready.then(() => root.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 700, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
  )).catch(() => {});
}
$('#scheme').addEventListener('click', e => {
  const next = scheme() === 'dark' ? 'light' : 'dark';
  reveal(() => {
    root.dataset.scheme = next;
    try { localStorage.setItem('site.scheme', next); } catch {}
  }, [e.clientX, e.clientY]);
  tellFrames({ scheme: next });
});
mqDark.addEventListener('change', () => { if (!root.dataset.scheme) tellFrames({ scheme: scheme() }); });

// ---------- Scroll: Navigation, Fortschrittswerte, angeheftete Erzählung ----------
const nav = $('#nav');
const hero = $('.hero');
const win = $('#hero-window');
const story = $('#ablauf');
const stage = $('#stage');
const steps = $$('#steps .step');
const rail = $$('.rail i');
const statement = $('.statement');
let words = [];
let lastStep = -1;

// Satz in Wörter zerlegen, die beim Scrollen nacheinander aufleuchten
if (statement) {
  statement.innerHTML = statement.textContent.trim().split(/\s+/).map(w => `<span class="wd">${w}</span>`).join(' ');
  words = $$('.wd', statement);
}

function onScroll() {
  const vh = innerHeight;
  nav.classList.toggle('scrolled', scrollY > 8);

  // Hero: Überschrift wird beim Scrollen schmaler, das App-Fenster richtet sich auf
  const hp = clamp(scrollY / (vh * 0.9));
  hero.style.setProperty('--p', hp.toFixed(3));
  const wr = win.getBoundingClientRect();
  win.style.setProperty('--wp', reduce ? 1 : clamp((vh - wr.top) / (vh * 0.8)).toFixed(3));

  // Ablauf: Fortschritt durch den angehefteten Abschnitt → Schritt 0…4
  const sr = story.getBoundingClientRect();
  const sp = clamp(-sr.top / (sr.height - vh));
  story.style.setProperty('--sp', sp.toFixed(3));
  stage.style.setProperty('--sp', sp.toFixed(3));
  const step = Math.min(4, Math.floor(sp * 5.0001));
  if (step !== lastStep) {
    lastStep = step;
    stage.dataset.step = step;
    steps.forEach((el, i) => { el.classList.toggle('on', i === step); el.classList.toggle('past', i < step); });
    rail.forEach((el, i) => { el.classList.toggle('done', i <= step); el.classList.toggle('cur', i === step); });
  }

  // Aussage: Wort für Wort
  if (words.length) {
    const r = statement.getBoundingClientRect();
    const p = clamp((vh * 0.82 - r.top) / (r.height + vh * 0.3));
    const n = Math.round(p * words.length * 1.08);
    words.forEach((w, i) => w.classList.toggle('on', reduce || i < n));
  }
}
let ticking = false;
addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; onScroll(); });
}, { passive: true });
addEventListener('resize', onScroll);

// Klick auf einen Schritt-Link springt mitten in den passenden Abschnitt
function scrollToStep(i) {
  const top = story.offsetTop + (story.offsetHeight - innerHeight) * ((i + 0.5) / 5);
  scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}
steps.forEach((el, i) => el.addEventListener('click', () => { if (i !== lastStep) scrollToStep(i); }));

// ---------- Einblenden ----------
const io = new IntersectionObserver(entries => {
  const fresh = entries.filter(e => e.isIntersecting).map(e => e.target);
  fresh.forEach((el, i) => {
    el.style.setProperty('--d', i * 80);
    el.classList.add('in');
    io.unobserve(el);
    if (el.classList.contains('fact')) countUp($('.count', el));
  });
}, { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
$$('.rv').forEach(el => io.observe(el));

// Zahlen zählen hoch (die Null zählt herunter)
function countUp(el) {
  if (!el) return;
  const to = +el.dataset.to, from = to === 0 ? 99 : 0, t0 = performance.now(), dur = reduce ? 1 : 1500;
  (function tick(t) {
    const k = clamp((t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}

// ---------- Kachel: echter Fortschritt ----------
(function progressTile() {
  const tile = $('.t-progress');
  if (!tile) return;
  const row = $('.demo-row', tile), pct = $('.pct', tile), sp = $('.sp', tile), eta = $('.eta', tile);
  const nf = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  let p = 0, shown = 0, speed = 2.1, visible = false;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(tile);
  setInterval(() => {
    if (!visible) return;
    speed = clamp(speed + (Math.random() - 0.5) * 0.5, 1.2, 3.4);
    p = p >= 100 ? -18 : Math.min(100, p + speed * 1.9);
  }, 260);
  (function frame() {
    const target = Math.max(0, p);
    shown += (target - shown) * (reduce ? 1 : 0.12);
    if (target === 0) shown = 0;
    row.style.setProperty('--prog', shown.toFixed(2));
    pct.textContent = nf.format(shown) + ' %';
    sp.textContent = nf.format(speed) + ' MB/s';
    eta.textContent = 'noch 00:' + String(Math.max(0, Math.round((100 - shown) / (speed * 7.3)))).padStart(2, '0');
    requestAnimationFrame(frame);
  })();
})();

// ---------- Kachel: yt-dlp-Version klappt um ----------
(function flipTile() {
  const box = $('.digits');
  if (!box) return;
  const a = box.dataset.a, b = box.dataset.b;
  box.innerHTML = [...a].map(c => `<b class="${c === '.' ? 'dot' : ''}">${c}</b>`).join('');
  const cells = $$('b', box);
  let showB = false;
  function flip() {
    const text = showB ? a : b;
    showB = !showB;
    cells.forEach((c, i) => {
      if (c.textContent === text[i]) return;
      setTimeout(() => { c.textContent = text[i]; c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip'); }, i * 70);
    });
  }
  let timer = 0;
  new IntersectionObserver(([e]) => {
    clearInterval(timer);
    if (e.isIntersecting && !reduce) { setTimeout(flip, 900); timer = setInterval(flip, 3600); }
  }, { threshold: 0.4 }).observe(box);
})();

// ---------- Live-Demos (die echte App mit Beispielmusik) ----------
const frames = { film: $('#film'), demo: $('#demo'), phone: $('#phone') };
function tellFrames(msg, only) {
  for (const [name, f] of Object.entries(frames)) {
    if (!f || !f.src || (only && only !== name) || (name === 'phone' && msg.scheme)) continue;
    try { f.contentWindow.postMessage({ type: 'ytmp3-demo', ...msg }, location.origin); } catch {}
  }
}
function load(f, src) {
  if (!f || f.src) return;
  const sep = src.includes('?') ? '&' : '?';
  f.src = src + (f.id === 'phone' ? '' : `${sep}scheme=${scheme()}`);
}

// Fenster skalieren: am Desktop eine echte Desktop-Breite, am Handy die Handy-Ansicht
function fit(screen) {
  const f = $('iframe', screen);
  const cw = screen.clientWidth;
  const w = cw < 640 ? cw : clamp(cw, 1040, 1280);
  const s = cw / w;
  const h = cw < 640 ? 620 : Math.round(w * 0.6);
  f.style.width = w + 'px';
  f.style.height = h + 'px';
  f.style.transform = s === 1 ? '' : `scale(${s})`;
  screen.style.height = Math.round(h * s) + 'px';
  screen.dataset.scale = s;
}
const ro = new ResizeObserver(es => es.forEach(e => fit(e.target)));
$$('.window .screen').forEach(s => { fit(s); ro.observe(s); });

// Hero: Film abspielen (bei „weniger Bewegung“ nur die fertige Liste zeigen)
load(frames.film, reduce ? 'app/?start=list' : frames.film.dataset.src);
new IntersectionObserver(([e]) => tellFrames({ visible: e.isIntersecting }, 'film'), { threshold: 0.05 }).observe(win);
addEventListener('message', e => {
  if (e.origin === location.origin && e.data && e.data.type === 'ytmp3-film' && e.data.stopped) filmStopped();
});
function filmStopped() {
  const n = $('#film-note');
  n.classList.add('gone');
  $('.lt', n).textContent = 'Live-Demo – probier alles aus';
}
if (reduce) filmStopped();

// Weitere Demos erst laden, wenn sie in die Nähe kommen
const lazy = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  load(e.target, e.target.dataset.src);
  lazy.unobserve(e.target);
}), { rootMargin: '800px 0px' });
[frames.demo, frames.phone].forEach(f => f && lazy.observe(f));

// Design-Umschalter: Kreis wächst in der Demo von der Seite des Knopfs aus
const sw = $('.switch');
function moveInd() {
  const on = $('[aria-checked=true]', sw), ind = $('.ind', sw);
  ind.style.width = on.offsetWidth + 'px';
  ind.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}
$$('button', sw).forEach(b => b.addEventListener('click', () => {
  $$('button', sw).forEach(x => x.setAttribute('aria-checked', x === b));
  moveInd();
  const fr = frames.demo.getBoundingClientRect(), br = b.getBoundingClientRect();
  const s = +frames.demo.parentElement.dataset.scale || 1;
  const x = clamp((br.left + br.width / 2 - fr.left) / s, 0, fr.width / s);
  tellFrames({ theme: b.dataset.theme, point: [x, 0] }, 'demo');
}));
moveInd();
addEventListener('resize', moveInd);

// ---------- Downloads: passendes Gerät erkennen, Release-Infos holen ----------
const ua = navigator.userAgent;
const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
const os = /Android/i.test(ua) ? 'android' : /Win/i.test(plat) || /Windows/i.test(ua) ? 'windows'
  : /Linux|X11/i.test(plat + ua) && !/CrOS/.test(ua) ? 'linux' : '';
const MAIN = { windows: 'YT-Music-MP3-windows-x64-Setup.exe', android: 'YT-Music-MP3-android-arm64.apk', linux: 'YT-Music-MP3-linux-x86_64.AppImage' };
const NAME = { windows: 'Windows', android: 'Android', linux: 'Linux' };
const fileUrl = f => `${RELEASES}/download/${f}`;

$$('[data-file]').forEach(a => { a.href = fileUrl(a.dataset.file); });
if (os) {
  const card = $(`.dl[data-os="${os}"]`);
  if (card) card.classList.add('mine');
  const cta = $('#cta-main');
  cta.href = fileUrl(MAIN[os]);
  $('span', cta).textContent = `Für ${NAME[os]} laden`;
}

const mb = n => `${Math.round(n / 1048576)} MB`;
fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
  .then(rel => {
    const v = String(rel.tag_name || '').replace(/^v/, '');
    const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    if (v) $('#ver').textContent = `Version ${v}`;
    $('#rel-info').textContent = `Aktuell: Version ${v}${date ? ` vom ${date}` : ''}.`;
    const sizes = Object.fromEntries((rel.assets || []).map(a => [a.name, a.size]));
    $$('.btn[data-file]').forEach(a => {
      const s = sizes[a.dataset.file];
      if (s) $('small', a).textContent = `${$('small', a).textContent} · ${mb(s)}`;
    });
  })
  .catch(status => {
    if (status === 404) {
      // Noch kein Release veröffentlicht: Links zeigen auf die Release-Seite
      $$('[data-file]').forEach(a => { a.href = `https://github.com/${REPO}/releases`; });
      if (os) $('#cta-main').href = '#download';
      $('#rel-info').textContent = 'Die erste fertige Version erscheint in Kürze auf GitHub.';
    }
  });

onScroll();
