const loadForm = document.getElementById("loadForm");
const urlInput = document.getElementById("urlInput");
const loadBtn = document.getElementById("loadBtn");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const plTitle = document.getElementById("plTitle");
const plCount = document.getElementById("plCount");
const trackList = document.getElementById("trackList");
const selectAll = document.getElementById("selectAll");
const zipBtn = document.getElementById("zipBtn");
const bitrateSel = document.getElementById("bitrate");

let currentTitle = "playlist";

function currentBitrate() {
  return bitrateSel ? bitrateSel.value : "192";
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", isError);
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return "";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function triggerBrowserDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

loadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  loadBtn.disabled = true;
  setStatus("Lade Playlist …");
  results.classList.add("hidden");
  trackList.innerHTML = "";

  try {
    const res = await fetch("/api/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Fehler beim Laden.");

    currentTitle = data.title || "playlist";
    plTitle.textContent = data.title;
    plCount.textContent = `${data.count} Titel`;
    renderTracks(data.entries);
    results.classList.remove("hidden");
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    loadBtn.disabled = false;
  }
});

function renderTracks(entries) {
  trackList.innerHTML = "";
  for (const t of entries) {
    const li = document.createElement("li");
    li.className = "track";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.id = t.id;

    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.loading = "lazy";
    img.src = t.thumbnail || `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`;

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = t.title;
    const sub = document.createElement("div");
    sub.className = "t-sub";
    const parts = [];
    if (t.uploader) parts.push(t.uploader);
    const dur = fmtDuration(t.duration);
    if (dur) parts.push(dur);
    sub.textContent = parts.join(" · ");
    info.append(title, sub);

    const btn = document.createElement("button");
    btn.className = "dl-btn";
    btn.textContent = "MP3";
    btn.addEventListener("click", () => downloadOne(t.id, btn));

    li.append(cb, img, info, btn);
    trackList.appendChild(li);
  }
}

function filenameFromDisposition(res, fallback) {
  const cd = res.headers.get("Content-Disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch (_) { /* fall through */ }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

async function downloadOne(id, btn) {
  const original = "MP3";
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(
      `/api/download?id=${encodeURIComponent(id)}&bitrate=${encodeURIComponent(currentBitrate())}`
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Download fehlgeschlagen.");
    }
    const blob = await res.blob();
    const name = filenameFromDisposition(res, "track.mp3");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus("");
    btn.textContent = "✓ MP3";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("done");
    }, 2500);
  } catch (err) {
    setStatus(err.message, true);
    btn.textContent = original;
  } finally {
    btn.disabled = false;
  }
}

selectAll.addEventListener("change", () => {
  trackList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectAll.checked;
  });
});

zipBtn.addEventListener("click", async () => {
  const ids = [...trackList.querySelectorAll('input[type="checkbox"]:checked')].map(
    (cb) => cb.dataset.id
  );
  if (!ids.length) {
    setStatus("Bitte mindestens einen Titel auswählen.", true);
    return;
  }

  zipBtn.disabled = true;
  const orig = zipBtn.textContent;
  zipBtn.innerHTML = '<span class="spinner"></span> ZIP wird erstellt …';
  setStatus(`Lade ${ids.length} Titel und erstelle ZIP – das kann etwas dauern …`);

  try {
    const res = await fetch("/api/download-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, name: currentTitle, bitrate: currentBitrate() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "ZIP-Erstellung fehlgeschlagen.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    triggerBrowserDownload(url);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus("ZIP fertig ✓");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    zipBtn.disabled = false;
    zipBtn.textContent = orig;
  }
});
