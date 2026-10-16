package io.github.emre1001.ytmusicmp3

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * Shows the same UI as the web app (assets/www, rendered from templates/ and
 * static/) and answers its API calls natively through [Engine].
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    lateinit var web: WebView
        private set
    @Volatile private var pendingUrl: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        Engine.start(this)

        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        setContentView(root)
        // Keep the page clear of status bar, navigation bar, notch and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        setupWebView()
        pendingUrl = linkFrom(intent)
        web.loadUrl("https://$HOST/index.html")

        onBackPressedDispatcher.addCallback(this) {
            // Let the page close dialogs / go back to the start screen first.
            web.evaluateJavascript("(window.ytmp3&&ytmp3.back)?ytmp3.back():false") { handled ->
                if (handled != "true") moveTaskToBack(true)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        DownloadService.appVisible = true
    }

    override fun onStop() {
        DownloadService.appVisible = false
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = linkFrom(intent)
        if (url.isNotEmpty()) web.evaluateJavascript("window.__ytOpen&&__ytOpen(${JSONObject.quote(url)})", null)
    }

    private fun setupWebView() {
        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/") { path -> asset(path) }
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        web.addJavascriptInterface(Bridge(), "YTNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                open(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
    }

    private fun asset(path: String): WebResourceResponse? = try {
        val p = path.ifEmpty { "index.html" }
        WebResourceResponse(mime(p), "utf-8", assets.open("www/$p"))
    } catch (e: IOException) {
        null
    }

    private fun mime(p: String) = when (p.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js" -> "text/javascript"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "woff2" -> "font/woff2"
        "webmanifest", "json" -> "application/json"
        else -> "application/octet-stream"
    }

    private fun open(intent: Intent) {
        try {
            startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "Keine App zum Öffnen gefunden", Toast.LENGTH_SHORT).show()
        }
    }

    private fun applyTheme(bg: String) {
        val color = try { Color.parseColor(bg) } catch (e: IllegalArgumentException) { return }
        root.setBackgroundColor(color)
        web.setBackgroundColor(color)
        val light = ColorUtils.calculateLuminance(color) > 0.5
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getPreferences(MODE_PRIVATE)
        if (prefs.getBoolean("askedNotify", false)) return
        prefs.edit().putBoolean("askedNotify", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun <T> onMain(block: () -> T): T? {
        val task = FutureTask(Callable { block() })
        runOnUiThread(task)
        return try { task.get(2, TimeUnit.SECONDS) } catch (e: Exception) { null }
    }

    /** window.YTNative — wrapped into window.YTHost by web/host.js. */
    inner class Bridge {
        @JavascriptInterface
        fun request(id: Int, method: String, path: String, body: String) {
            lifecycleScope.launch(Dispatchers.IO) {
                val (status, json) = Engine.handle(method, path, body)
                if (path == "/api/jobs" && status < 300) {
                    DownloadService.start(this@MainActivity)
                    withContext(Dispatchers.Main) { askForNotifications() }
                }
                withContext(Dispatchers.Main) {
                    web.evaluateJavascript("window.__ytNative&&__ytNative($id,$status,${JSONObject.quote(json)})", null)
                }
            }
        }

        @JavascriptInterface
        fun clipboard(): String = onMain {
            val cm = getSystemService(ClipboardManager::class.java)
            cm?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString()
        } ?: ""

        @JavascriptInterface
        fun folder(): String = Saver.musicLabel

        @JavascriptInterface
        fun reveal(uri: String) {
            if (uri.isEmpty()) return openFolder()
            val type = contentResolver.getType(Uri.parse(uri)) ?: "audio/mpeg"
            runOnUiThread {
                open(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            }
        }

        @JavascriptInterface
        fun openFolder() {
            runOnUiThread {
                val dir = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:Music/${Saver.FOLDER}"
                )
                try {
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(dir, DocumentsContract.Document.MIME_TYPE_DIR))
                } catch (e: Exception) {
                    open(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
                }
            }
        }

        @JavascriptInterface
        fun theme(bg: String, fg: String) {
            runOnUiThread { applyTheme(bg) }
        }

        @JavascriptInterface
        fun takePendingUrl(): String = pendingUrl.also { pendingUrl = "" }
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private val URL_RE = Regex("""https?://\S+""")

        fun linkFrom(intent: Intent?): String {
            if (intent?.action != Intent.ACTION_SEND) return ""
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return ""
            return URL_RE.find(text)?.value ?: ""
        }
    }
}
