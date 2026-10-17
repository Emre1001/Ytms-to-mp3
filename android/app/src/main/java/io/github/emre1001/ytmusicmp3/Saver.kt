package io.github.emre1001.ytmusicmp3

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import org.json.JSONObject
import java.io.IOException

/** Copies finished files into shared storage: MP3s to Music/, ZIPs to Download/. */
object Saver {
    const val FOLDER = "YT Music MP3"
    val musicLabel = "Musik/$FOLDER"

    fun save(context: Context, job: Engine.Job): JSONObject {
        val file = job.file ?: throw ApiError(404, "Datei ist (noch) nicht bereit.")
        if (!file.exists()) throw ApiError(410, "Datei ist abgelaufen. Bitte neu laden.")
        val zip = job.kind == "zip"
        val name = job.downloadName ?: file.name
        val mime = if (zip) "application/zip" else "audio/mpeg"
        val collection = if (zip) MediaStore.Downloads.EXTERNAL_CONTENT_URI else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val folder = (if (zip) Environment.DIRECTORY_DOWNLOADS else Environment.DIRECTORY_MUSIC) + "/" + FOLDER

        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: throw IOException("Speichern fehlgeschlagen.")
        try {
            resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
                ?: throw IOException("Speichern fehlgeschlagen.")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        // MediaStore may have renamed it ("Name (1).mp3") if the file already existed.
        val finalName = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: name
        return JSONObject()
            .put("name", finalName)
            .put("path", uri.toString())
            .put("dir", if (zip) "Download/$FOLDER" else musicLabel)
            .put("mime", mime)
    }
}
