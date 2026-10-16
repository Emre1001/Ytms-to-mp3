package io.github.emre1001.ytmusicmp3

import android.content.Context
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** An error that goes back to the page as {"error": message} with this HTTP-like status. */
class ApiError(val status: Int, message: String) : Exception(message)

private class Cancelled : Exception()

/**
 * The same job API the Flask backend offers (app.py), answered on the phone:
 * yt-dlp, ffmpeg and QuickJS come from youtubedl-android.
 */
object Engine {
    private const val MAX_PARALLEL = 3
    private const val MAX_ZIP_TRACKS = 100
    private const val JOB_TTL_MS = 30 * 60 * 1000L
    private val BITRATES = setOf("128", "192", "256", "320")
    private val VIDEO_ID = Regex("[\\w-]{6,20}")

    // Square-crop the cover: YouTube Music art sits letterboxed in a 16:9 thumbnail.
    private const val COVER_ARGS =
        "ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -qmin 1 -qscale:v 3 " +
            "-vf \"crop='if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\""

    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ready = CompletableDeferred<Unit>()
    private var initError: String? = null
    private val slots = Semaphore(MAX_PARALLEL)
    private val jobs = ConcurrentHashMap<String, Job>()

    @Volatile private var ytdlpVersion: String = ""
    @Volatile private var update = JSONObject()

    private val cacheDir get() = File(app.cacheDir, "yt-dlp")

    fun start(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext
        scope.launch {
            try {
                YoutubeDL.getInstance().init(app)
                FFmpeg.getInstance().init(app)
                ytdlpVersion = queryVersion()
                update = JSONObject().put("running", ytdlpVersion)
            } catch (e: Exception) {
                initError = e.message ?: e.toString()
            }
            ready.complete(Unit)
            if (initError == null) autoUpdate()
        }
    }

    private suspend fun awaitReady() {
        ready.await()
        initError?.let { throw ApiError(500, "Start fehlgeschlagen: $it") }
    }

    // ---------- API ----------

    suspend fun handle(method: String, path: String, body: String?): Pair<Int, String> = try {
        val data = if (body.isNullOrBlank()) JSONObject() else JSONObject(body)
        when {
            method == "POST" && path == "/api/playlist" -> 200 to playlist(data.optString("url").trim()).toString()
            method == "POST" && path == "/api/jobs" -> 201 to createJob(data).toString()
            method == "GET" && path == "/api/info" -> 200 to info().toString()
            method == "POST" && path == "/api/update" -> 200 to updateNow().toString()
            method == "POST" && path == "/native/save" -> 200 to save(data.optString("id")).toString()
            path.startsWith("/api/jobs/") -> {
                val job = jobs[path.removePrefix("/api/jobs/")]
                    ?: throw ApiError(404, "Auftrag nicht gefunden (abgelaufen?).")
                if (method == "DELETE") {
                    cancel(job)
                    200 to JSONObject().put("ok", true).toString()
                } else {
                    200 to job.toJson().toString()
                }
            }
            else -> throw ApiError(404, "Unbekannte Anfrage.")
        }
    } catch (e: ApiError) {
        e.status to JSONObject().put("error", e.message).toString()
    } catch (e: Exception) {
        500 to JSONObject().put("error", friendly(e.message)).toString()
    }

    private suspend fun playlist(url: String): JSONObject {
        if (url.isEmpty()) throw ApiError(400, "Bitte eine Playlist- oder Video-URL angeben.")
        awaitReady()
        val req = YoutubeDLRequest(url).apply {
            addOption("--flat-playlist")
            addOption("-J")
            addOption("--no-warnings")
            addOption("--cache-dir", cacheDir.absolutePath)
        }
        val out = try {
            YoutubeDL.getInstance().execute(req).out
        } catch (e: YoutubeDLException) {
            throw ApiError(502, "Konnte die Playlist nicht laden: ${friendly(e.message)}")
        }
        val info = JSONObject(out)
        val raw = info.optJSONArray("entries")
        val items = if (raw != null) (0 until raw.length()).mapNotNull { raw.optJSONObject(it) } else listOf(info)
        val entries = JSONArray()
        for (e in items) {
            val id = str(e, "id")
            if (id.isEmpty()) continue
            entries.put(
                JSONObject()
                    .put("id", id)
                    .put("title", str(e, "title").ifEmpty { "Unknown title" })
                    .put("uploader", str(e, "uploader").ifEmpty { str(e, "channel") })
                    .put("duration", e.optDouble("duration").takeIf { !it.isNaN() } ?: JSONObject.NULL)
                    .put("thumbnail", lastThumb(e) ?: JSONObject.NULL)
                    .put("url", "https://www.youtube.com/watch?v=$id")
            )
        }
        if (entries.length() == 0) throw ApiError(404, "Keine Titel in dieser Playlist gefunden.")
        return JSONObject()
            .put("title", str(info, "title").ifEmpty { "Playlist" })
            .put("uploader", str(info, "uploader").ifEmpty { str(info, "channel") })
            .put("thumbnail", (if (raw != null) lastThumb(info) else null) ?: JSONObject.NULL)
            .put("is_playlist", raw != null)
            .put("count", entries.length())
            .put("entries", entries)
    }

    private fun createJob(data: JSONObject): JSONObject {
        val rawIds = data.optJSONArray("ids") ?: throw ApiError(400, "Keine Titel ausgewählt.")
        val ids = (0 until rawIds.length()).map { rawIds.optString(it) }
            .filter { VIDEO_ID.matches(it) }.distinct()
        if (ids.isEmpty()) throw ApiError(400, "Keine gültigen Titel ausgewählt.")
        val zip = data.optBoolean("zip")
        if (!zip && ids.size != 1) throw ApiError(400, "Ein MP3-Auftrag braucht genau einen Titel.")
        if (ids.size > MAX_ZIP_TRACKS) throw ApiError(400, "Maximal $MAX_ZIP_TRACKS Titel pro ZIP.")
        val titles = data.optJSONObject("titles") ?: JSONObject()
        val bitrate = data.optString("bitrate").takeIf { it in BITRATES } ?: "192"
        sweep()
        val job = Job(
            id = UUID.randomUUID().toString().replace("-", ""),
            kind = if (zip) "zip" else "mp3",
            name = data.optString("name").ifBlank { "playlist" }.take(200),
            bitrate = bitrate,
            tracks = ids.map { Track(it, str(titles, it).take(300)) },
        )
        jobs[job.id] = job
        scope.launch { run(job) }
        return job.toJson()
    }

    private fun cancel(job: Job) {
        job.cancelled = true
        job.pid?.let { YoutubeDL.getInstance().destroyProcessById(it) }
    }

    private suspend fun info(): JSONObject {
        ready.await()
        return JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("ytdlp", ytdlpVersion)
            .put("ffmpeg", true)
            .put("update", update)
    }

    private suspend fun updateNow(): JSONObject {
        awaitReady()
        val before = ytdlpVersion
        val status = try {
            YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel.STABLE)
        } catch (e: Exception) {
            update = JSONObject().put("running", before).put("error", friendly(e.message))
            return update
        }
        ytdlpVersion = queryVersion()
        prefs().edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply()
        update = JSONObject()
            .put("running", ytdlpVersion)
            .put("latest", ytdlpVersion)
            .put("updated", status == YoutubeDL.UpdateStatus.DONE && ytdlpVersion != before)
        return update
    }

    /** yt-dlp has to keep up with YouTube: check for a new release once a day. */
    private suspend fun autoUpdate() {
        val last = prefs().getLong("lastUpdateCheck", 0)
        if (System.currentTimeMillis() - last < 24 * 3600 * 1000L) return
        try { updateNow() } catch (_: Exception) {}
    }

    private fun save(id: String): JSONObject {
        val job = jobs[id] ?: throw ApiError(404, "Auftrag nicht gefunden (abgelaufen?).")
        return job.saved ?: Saver.save(app, job).also { job.saved = it }
    }

    // ---------- Running jobs ----------

    private suspend fun run(job: Job) {
        try {
            slots.withPermit {
                if (job.cancelled) throw Cancelled()
                job.status = "run"
                awaitReady()
                if (job.kind == "zip") runZip(job) else runMp3(job)
            }
            // Save right away so finished files land in the music folder even
            // while the app sits in the background.
            try { save(job.id) } catch (_: Exception) {}
        } catch (e: Cancelled) {
            markCancelled(job)
        } catch (e: Exception) {
            if (job.cancelled) markCancelled(job)
            else {
                job.error = if (e is ApiError) e.message ?: "" else friendly(e.message)
                job.status = "error"
            }
        }
        job.finishedAt = System.currentTimeMillis()
    }

    private fun markCancelled(job: Job) {
        job.status = "cancelled"
        job.error = "Abgebrochen."
        job.tracks.filter { it.status != "done" && it.status != "error" }.forEach {
            it.status = "cancelled"; it.speed = 0.0; it.eta = null
        }
    }

    private fun runMp3(job: Job) {
        val t = job.tracks[0]
        val mp3 = try {
            fetch(job, t, File(job.dir, "t"))
        } catch (e: Cancelled) {
            throw e
        } catch (e: Exception) {
            if (job.cancelled) throw Cancelled()
            t.fail(friendly(e.message))
            throw ApiError(502, t.error)
        }
        t.finish()
        job.ok = 1
        job.file = mp3
        job.downloadName = safeName(mp3.nameWithoutExtension) + ".mp3"
        job.status = "done"
    }

    private fun runZip(job: Job) {
        val zipFile = File(job.dir, "bundle.zip")
        val used = mutableSetOf<String>()
        val skipped = mutableListOf<Pair<String, String>>()
        ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
            // MP3s are already compressed.
            zip.setLevel(Deflater.NO_COMPRESSION)
            for ((i, t) in job.tracks.withIndex()) {
                if (job.cancelled) throw Cancelled()
                val dir = File(job.dir, "t$i")
                try {
                    val mp3 = fetch(job, t, dir)
                    val base = safeName(mp3.nameWithoutExtension)
                    var name = "$base.mp3"
                    var n = 2
                    while (name in used) name = "$base (${n++}).mp3"
                    used += name
                    zip.putNextEntry(ZipEntry(name))
                    mp3.inputStream().use { it.copyTo(zip) }
                    zip.closeEntry()
                    t.finish()
                    job.ok = used.size
                } catch (e: Cancelled) {
                    throw e
                } catch (e: Exception) {
                    if (job.cancelled) throw Cancelled()
                    t.fail(friendly(e.message))
                    skipped += t.title.ifEmpty { t.id } to t.error
                    job.skipped = skipped.size
                } finally {
                    dir.deleteRecursively()
                }
            }
            if (used.isEmpty()) {
                val detail = skipped.lastOrNull()?.let { " Grund: ${it.second}" } ?: ""
                throw ApiError(502, "Kein Titel konnte heruntergeladen werden.$detail")
            }
            if (skipped.isNotEmpty()) {
                zip.putNextEntry(ZipEntry("_Uebersprungene Titel.txt"))
                val report = "Diese Titel konnten nicht heruntergeladen werden:\n\n" +
                    skipped.joinToString("\n") { "- ${it.first}\n  Grund: ${it.second}" }
                zip.write(report.toByteArray())
                zip.closeEntry()
            }
        }
        job.file = zipFile
        job.downloadName = safeName(job.name) + ".zip"
        job.status = "done"
    }

    private val speedRe = Regex("""at\s+([\d.]+)\s*([KMGT]?)i?B/s""")

    /** Download one track as MP3 into dir, reporting progress into t. */
    private fun fetch(job: Job, t: Track, dir: File): File {
        dir.mkdirs()
        val req = YoutubeDLRequest("https://www.youtube.com/watch?v=${t.id}").apply {
            addOption("-f", "bestaudio/best")
            addOption("--no-playlist")
            addOption("--newline")
            addOption("--no-mtime")
            addOption("-x")
            addOption("--audio-format", "mp3")
            addOption("--audio-quality", "${job.bitrate}K")
            // "Artist - Title.mp3" when YouTube Music knows the artist, else the video title.
            addOption("-o", File(dir, "%(artist&{} - |)s%(track,title)s.%(ext)s").absolutePath)
            addOption("--embed-metadata")
            addOption("--embed-thumbnail")
            addOption("--convert-thumbnails", "jpg")
            addOption("--ppa", COVER_ARGS)
            // Long video descriptions don't belong in ID3 tags.
            addOption("--parse-metadata", ":(?P<meta_description>)")
            addOption("--parse-metadata", ":(?P<meta_synopsis>)")
            addOption("--cache-dir", cacheDir.absolutePath)
        }
        val pid = "${job.id}-${t.id}"
        job.pid = pid
        t.status = "download"
        t.pct = 0.0
        try {
            YoutubeDL.getInstance().execute(req, pid) { progress, eta, line -> onLine(job, t, progress, eta, line) }
        } catch (e: YoutubeDL.CanceledException) {
            throw Cancelled()
        } catch (e: YoutubeDLException) {
            if (job.cancelled) throw Cancelled()
            // Cover or tags failed, but the MP3 itself is usually there — keep it.
            newestMp3(dir) ?: throw e
        } finally {
            job.pid = null
        }
        if (job.cancelled) throw Cancelled()
        return newestMp3(dir) ?: throw IOException("Konvertierung lieferte keine MP3-Datei.")
    }

    private fun newestMp3(dir: File) =
        dir.listFiles()?.filter { it.extension.equals("mp3", true) }?.maxByOrNull { it.lastModified() }

    private fun onLine(job: Job, t: Track, progress: Float, eta: Long, line: String) {
        if (job.cancelled) {
            job.pid?.let { YoutubeDL.getInstance().destroyProcessById(it) }
            return
        }
        when {
            line.startsWith("[download]") && t.status == "download" && progress >= 0 -> {
                t.pct = progress.toDouble()
                t.eta = eta.takeIf { it >= 0 }
                speedRe.find(line)?.let { m ->
                    val unit = when (m.groupValues[2]) { "K" -> 1024.0; "M" -> 1048576.0; "G" -> 1073741824.0; else -> 1.0 }
                    t.speed = (m.groupValues[1].toDoubleOrNull() ?: 0.0) * unit
                }
            }
            line.startsWith("[ExtractAudio]") || line.startsWith("[Metadata]") || line.startsWith("[EmbedThumbnail]") ->
                if (t.status != "convert") {
                    t.status = "convert"; t.pct = 100.0; t.speed = 0.0; t.eta = null
                }
        }
    }

    private fun queryVersion(): String = try {
        YoutubeDL.getInstance().execute(YoutubeDLRequest(emptyList()).addOption("--version")).out.trim()
    } catch (_: Exception) {
        YoutubeDL.versionName(app) ?: ""
    }

    private fun sweep() {
        val limit = System.currentTimeMillis() - JOB_TTL_MS
        jobs.values.filter { it.finishedAt in 1 until limit }.forEach {
            jobs.remove(it.id)
            it.dir.deleteRecursively()
        }
    }

    /** What the notification shows: active jobs and their overall progress (0…1). */
    fun summary(): Pair<Int, Double> {
        val active = jobs.values.filter { it.status == "queue" || it.status == "run" }
        if (active.isEmpty()) return 0 to -1.0
        var sum = 0.0
        var n = 0
        for (j in active) for (t in j.tracks) {
            n++
            sum += when (t.status) {
                "done", "error" -> 1.0
                "download" -> t.pct / 100 * .9
                "convert" -> .95
                else -> 0.0
            }
        }
        return active.size to if (n > 0) sum / n else 0.0
    }

    fun finishedSince(time: Long) = jobs.values.count { it.status == "done" && it.finishedAt >= time }

    private fun prefs() = app.getSharedPreferences("engine", Context.MODE_PRIVATE)

    // ---------- Helpers ----------

    /** Translate common yt-dlp failures into the same German messages as app.py. */
    fun friendly(raw: String?): String {
        val msg = raw?.lines()?.lastOrNull { it.contains("ERROR") }?.trim() ?: raw?.trim().orEmpty()
        return when {
            "Sign in to confirm" in msg || "not a bot" in msg ->
                "YouTube blockiert gerade (Bot-Schutz). Bitte später noch einmal versuchen."
            "Video unavailable" in msg -> "Video nicht verfügbar (gelöscht, privat oder regional gesperrt)."
            "age" in msg.lowercase() && "restrict" in msg.lowercase() -> "Altersbeschränktes Video."
            "Unable to resolve host" in msg || "Failed to resolve" in msg || "Network is unreachable" in msg ->
                "Keine Internetverbindung."
            else -> msg.replace(Regex("^ERROR:\\s*(\\[[^\\]]+]\\s*[\\w-]*:?\\s*)?"), "").take(300).ifEmpty { "Unbekannter Fehler." }
        }
    }

    private val invalidChars = Regex("[\\\\/:*?\"<>|]")
    fun safeName(name: String) = invalidChars.replace(name, "_").trim().replace(Regex("\\s+"), " ").take(180).ifEmpty { "track" }

    private fun str(o: JSONObject, key: String) = if (o.isNull(key)) "" else o.optString(key)

    private fun lastThumb(o: JSONObject): String? {
        val thumbs = o.optJSONArray("thumbnails")
        if (thumbs != null && thumbs.length() > 0) return thumbs.optJSONObject(thumbs.length() - 1)?.let { str(it, "url") }?.ifEmpty { null }
        return str(o, "thumbnail").ifEmpty { null }
    }

    class Track(val id: String, val title: String) {
        @Volatile var status = "queue"
        @Volatile var pct = 0.0
        @Volatile var speed = 0.0
        @Volatile var eta: Long? = null
        @Volatile var error = ""

        fun finish() { status = "done"; pct = 100.0; speed = 0.0; eta = null }
        fun fail(msg: String) { status = "error"; error = msg; speed = 0.0; eta = null }

        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("title", title).put("status", status).put("pct", pct)
            .put("speed", speed).put("eta", eta ?: JSONObject.NULL).put("error", error)
    }

    class Job(val id: String, val kind: String, val name: String, val bitrate: String, val tracks: List<Track>) {
        val dir = File(app.cacheDir, "jobs/$id").apply { mkdirs() }
        @Volatile var status = "queue"
        @Volatile var error = ""
        @Volatile var ok = 0
        @Volatile var skipped = 0
        @Volatile var file: File? = null
        @Volatile var downloadName: String? = null
        @Volatile var cancelled = false
        @Volatile var pid: String? = null
        @Volatile var saved: JSONObject? = null
        @Volatile var finishedAt = 0L

        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("kind", kind).put("name", name).put("status", status).put("error", error)
            .put("ok", ok).put("skipped", skipped)
            .put("file", file?.name ?: JSONObject.NULL)
            .put("download_name", downloadName ?: JSONObject.NULL)
            .put("tracks", JSONArray(tracks.map { it.toJson() }))
    }
}
