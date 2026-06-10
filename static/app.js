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

let currentTitle = "playlist";

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

function downloadOne(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  // The browser handles the actual file download; we can't easily detect
  // completion of a navigation download, so we re-enable after a short delay.
  triggerBrowserDownload(`/api/download?id=${encodeURIComponent(id)}`);
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "✓ MP3";
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("done");
    }, 2500);
  }, 1500);
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
      body: JSON.stringify({ ids, name: currentTitle }),
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
