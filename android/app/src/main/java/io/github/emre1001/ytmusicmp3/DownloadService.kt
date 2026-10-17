package io.github.emre1001.ytmusicmp3

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Keeps the app alive while downloads run (a 50-track ZIP takes a while) and
 * shows their progress in a notification.
 */
class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var since = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        since = System.currentTimeMillis()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_PROGRESS, getString(R.string.channel_progress), NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_DONE, getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(this, ID_PROGRESS, progress(Engine.summary()), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (loop == null) {
            loop = scope.launch {
                while (true) {
                    delay(1000)
                    val s = Engine.summary()
                    if (s.first == 0) break
                    show(ID_PROGRESS, progress(s))
                }
                finish()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun finish() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        val done = Engine.finishedSince(since)
        if (done > 0 && !appVisible) {
            show(
                ID_DONE,
                base(CH_DONE)
                    .setContentTitle(if (done == 1) "Download fertig" else "$done Downloads fertig")
                    .setContentText("Gespeichert in ${Saver.musicLabel}")
                    .setAutoCancel(true)
                    .build()
            )
        }
        stopSelf()
    }

    private fun progress(summary: Pair<Int, Double>): android.app.Notification {
        val (jobs, p) = summary
        return base(CH_PROGRESS)
            .setContentTitle(if (jobs <= 1) "Wird geladen…" else "$jobs Aufträge laufen")
            .setContentText(if (p >= 0) "${(p * 100).toInt()} %" else "")
            .setProgress(100, if (p >= 0) (p * 100).toInt() else 0, p < 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun base(channel: String) = NotificationCompat.Builder(this, channel)
        .setSmallIcon(R.drawable.ic_stat)
        .setColor(ContextCompat.getColor(this, R.color.accent))
        .setContentIntent(
            PendingIntent.getActivity(
                this, 0,
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        )

    private fun show(id: Int, n: android.app.Notification) {
        try { NotificationManagerCompat.from(this).notify(id, n) } catch (_: SecurityException) {}
    }

    companion object {
        private const val CH_PROGRESS = "progress"
        private const val CH_DONE = "done"
        private const val ID_PROGRESS = 1
        private const val ID_DONE = 2

        @Volatile var appVisible = false

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
        }
    }
}
