package com.abtara.taraphone

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.io.IOException
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The desk phone's one screen: tara-agent's `/phone` in a full-screen WebView that keeps the display
 * on and shows over the lock screen. It is also the home app (kiosk) and opens after a reboot.
 *
 * Flow: pair (QR → `POST /phone/pair` over the pinned key) → session (`POST /phone/session` with the
 * device key → a day-long cookie for the WebView) → load `/phone`. The pin is checked on the shell's
 * own connections and again on the WebView's page certificate.
 */
class MainActivity : Activity(), Bridge.Host {
    private lateinit var settings: Settings
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    private lateinit var panel: View
    private lateinit var statusText: TextView
    private lateinit var backButton: Button

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var paired: Paired? = null
    private var startScript: ScriptHandler? = null
    private var scriptOrigin: String? = null
    private var pageLoaded = false
    private var mainFrameFailed = false
    private var authRetried = false
    private var certMismatches = 0
    private var retryMs = RETRY_MIN_MS
    private var offeredUpdate = 0
    private val retry = Runnable { connect() }
    private val renew = Runnable { connect() }
    private val updateCheck = Runnable { checkUpdate() }
    private val alerts = AlertStream(
        onAlert = { a ->
            main.post {
                wakeScreen()
                bridge.buzz(if (a.optBoolean("speak")) 700 else 300)
                if (a.optBoolean("speak")) main.postDelayed({ bridge.say(a.optString("text")) }, 400)
            }
        },
        onFailure = { e -> Tailscale.reviveIfDown(applicationContext, e) },
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setShowWhenLocked(true)
        setTurnScreenOn(true)

        settings = Settings(this)
        bridge = Bridge(this, this)
        web = WebView(this).apply {
            setBackgroundColor(BG)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)
            settings.setSupportMultipleWindows(false)
            settings.textZoom = 100
            addJavascriptInterface(bridge, "Android")
            webViewClient = Client()
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "page: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)

        panel = buildPanel()
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(BG)
            addView(web, FrameLayout.LayoutParams(-1, -1))
            addView(panel, FrameLayout.LayoutParams(-1, -1))
        })

        paired = settings.load()
        if (!openLink(intent)) {
            if (paired == null) showPanel("Not paired yet. On the dashboard, open Phone and scan its QR.")
            else connect()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openLink(intent)
    }

    override fun onResume() {
        super.onResume()
        immersive()
        // Back from a long sleep or from Settings: make sure the page and its session are fresh.
        if (paired != null && !pageLoaded) connect()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    /**
     * Home app: Back never leaves the screen. It only closes the setup panel. (Going back in the
     * WebView's history once landed on an earlier about:blank and left the screen black.)
     */
    @Deprecated("Home app: Back only closes the setup panel")
    override fun onBackPressed() {
        if (panel.visibility == View.VISIBLE && pageLoaded) hidePanel()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        alerts.stop()
        io.shutdownNow()
        bridge.close()
        web.destroy()
        super.onDestroy()
    }

    // --- Bridge.Host ---

    override fun wakeScreen() {
        main.post {
            setTurnScreenOn(true)
            Bridge.wake(this)
        }
    }

    override fun openSetup() {
        main.post {
            val p = paired
            showPanel(if (p == null) "Not paired." else "Paired with ${p.agentName} at ${p.host}:${p.port}.")
        }
    }

    // --- Pairing and the session ---

    /** A `tara-phone://pair?…` link (from the QR, or `adb shell am start -d`). */
    private fun openLink(intent: Intent?): Boolean {
        val link = intent?.data?.toString()?.let(PairingLink::parse) ?: return false
        pair(link)
        return true
    }

    private fun pair(link: PairingLink) {
        showPanel("Pairing with ${link.name} at ${link.host}…")
        io.execute {
            try {
                val body = JSONObject().put("code", link.code).put("name", deviceName())
                val r = Net(link.host, link.port, link.spki).ok("POST", "/phone/pair", body)
                val p = Paired(link.host, link.port, link.spki, link.name, r.getString("id"), r.getString("key"))
                settings.save(p)
                main.post {
                    paired = p
                    pageLoaded = false
                    authRetried = false
                    connect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "pairing failed", e)
                main.post { showPanel("Pairing failed: ${describe(e)}") }
            }
        }
    }

    /** Gets a fresh session cookie, then (re)loads `/phone` if it isn't showing. */
    private fun connect() {
        val p = paired ?: return showPanel("Not paired yet. On the dashboard, open Phone and scan its QR.")
        main.removeCallbacks(retry)
        main.removeCallbacks(renew)
        if (!pageLoaded) showPanel("Connecting to ${p.agentName} at ${p.host}…")
        io.execute {
            try {
                val (q, s) = session(p)
                main.post { applySession(q, s) }
            } catch (e: Exception) {
                Log.w(TAG, "connect failed", e)
                main.post { failed(e) }
            }
        }
    }

    /** `POST /phone/session`; when the certificate's key changed, moves the pin first (with proof). */
    private fun session(p: Paired): Pair<Paired, JSONObject> {
        val body = JSONObject().put("version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        return try {
            p to p.net().ok("POST", "/phone/session", body, p.auth)
        } catch (e: PinMismatch) {
            val q = repin(p)
            q to q.net().ok("POST", "/phone/session", body, q.auth)
        }
    }

    /**
     * The certificate was renewed with a new key. The system must trust the new one, and tara-agent
     * must prove (HMAC under this phone's key hash) that it is the key it serves; then the pin moves.
     */
    private fun repin(p: Paired): Paired {
        val nonce = ByteArray(24).also { SecureRandom().nextBytes(it) }.let {
            Base64.getUrlEncoder().withoutPadding().encodeToString(it)
        }
        val r = p.net(pinned = false).call("POST", "/phone/pin", JSONObject().put("id", p.deviceId).put("nonce", nonce))
        if (r.status != 200) throw IOException("The certificate changed and tara-agent could not confirm it (HTTP ${r.status}): pair again")
        val j = r.json()
        val spki = j.getString("spki")
        val good = r.spki == spki && Pins.sameText(Pins.proof(p.deviceKey, nonce, spki), j.getString("proof"))
        if (!good) throw SecurityException("The certificate changed and the proof did not match: pair again")
        Log.i(TAG, "certificate key changed; pin moved to $spki")
        return p.copy(spki = spki).also(settings::save)
    }

    private fun applySession(p: Paired, s: JSONObject) {
        paired = p
        retryMs = RETRY_MIN_MS
        certMismatches = 0
        val cookie = "${s.optString("cookie", "tara_phone")}=${s.getString("session")}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400"
        CookieManager.getInstance().setCookie(p.origin, cookie) {
            CookieManager.getInstance().flush()
            if (!pageLoaded || web.url?.startsWith(p.origin) != true) load(p)
        }
        main.postDelayed(renew, RENEW_MS)
        alerts.start(p)
        LinkService.start(this)
        main.removeCallbacks(updateCheck)
        main.postDelayed(updateCheck, 5_000)
    }

    private fun load(p: Paired) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && scriptOrigin != p.origin) {
            startScript?.remove()
            startScript = WebViewCompat.addDocumentStartJavaScript(web, bridge.script(), setOf(p.origin))
            scriptOrigin = p.origin
        }
        mainFrameFailed = false
        web.loadUrl("${p.origin}/phone")
    }

    private fun failed(e: Exception) {
        Tailscale.reviveIfDown(applicationContext, e)
        if (e is HttpFailure && e.status == 401) {
            // Forgotten on the dashboard, or the server's database was reset.
            pageLoaded = false
            web.loadUrl("about:blank")
            alerts.stop()
            return showPanel("tara-agent doesn't know this phone any more. Scan a new pairing QR.")
        }
        if (e is SecurityException) return showPanel(describe(e))
        val wait = retryMs
        retryMs = (retryMs * 2).coerceAtMost(RETRY_MAX_MS)
        main.postDelayed(retry, wait)
        // A failed renewal while the page shows is retried quietly.
        if (!pageLoaded) showPanel("Can't reach ${paired?.host}: ${describe(e)}\nTrying again in ${wait / 1000} s. Is Tailscale on?")
    }

    // --- Updates ---

    private fun checkUpdate() {
        val p = paired ?: return
        main.removeCallbacks(updateCheck)
        main.postDelayed(updateCheck, UPDATE_EVERY_MS)
        io.execute {
            val u = runCatching { Updater.check(p) }.onFailure { Log.w(TAG, "update check failed", it) }.getOrNull()
            if (u != null && u.versionCode != offeredUpdate) main.post { offerUpdate(p, u) }
        }
    }

    private fun offerUpdate(p: Paired, u: Update) {
        if (isFinishing) return
        offeredUpdate = u.versionCode
        AlertDialog.Builder(this)
            .setTitle("Update Tara Phone")
            .setMessage("Version ${u.versionName} (${u.versionCode}) is ready on ${p.agentName}. You have ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}).")
            .setPositiveButton("Update") { _, _ ->
                if (!packageManager.canRequestPackageInstalls()) {
                    offeredUpdate = 0
                    startActivity(Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                    return@setPositiveButton
                }
                io.execute {
                    runCatching { Updater.install(this, p, u) }.onFailure {
                        Log.w(TAG, "update failed", it)
                        main.post { showPanel("Update failed: ${describe(it)}") }
                    }
                }
            }
            .setNegativeButton("Later", null)
            .show()
    }

    // --- The WebView ---

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            val p = paired ?: return
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && url.startsWith(p.origin)) {
                view.evaluateJavascript(bridge.script(), null)
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            val p = paired ?: return
            if (!url.startsWith(p.origin)) return
            // The WebView made its own TLS connection: check its certificate against the pin too.
            val cert = view.certificate?.x509Certificate
            if (cert == null || Pins.spki(cert) != p.spki) {
                pageLoaded = false
                view.loadUrl("about:blank")
                if (++certMismatches <= 2) connect() // a renewed key: connect() moves the pin (with proof)
                else showPanel("The page's certificate doesn't match the paired one. Pair again.")
                return
            }
            if (mainFrameFailed) return
            // Nothing behind the screen to go back to (an earlier about:blank or error page).
            view.clearHistory()
            pageLoaded = true
            authRetried = false
            hidePanel()
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            pageLoaded = false
            if (response.statusCode == 401 && !authRetried) {
                authRetried = true
                connect()
            } else {
                showPanel("${paired?.agentName} answered HTTP ${response.statusCode}.")
                main.postDelayed(retry, RETRY_MAX_MS)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            pageLoaded = false
            failed(IOException(error.description.toString()))
        }

        /** Only a certificate whose key is the pinned one passes (e.g. a self-signed one). */
        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val p = paired
            val cert = error.certificate.x509Certificate
            if (p != null && cert != null && error.url.startsWith(p.origin) && Pins.spki(cert) == p.spki) handler.proceed()
            else {
                handler.cancel()
                showPanel("Certificate problem on ${error.url}: refused.")
            }
        }

        /** A kiosk: only the paired tara-agent's pages open here. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val p = paired ?: return true
            return !request.url.toString().startsWith("${p.origin}/")
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "WebView renderer gone (crashed=${detail.didCrash()}); restarting")
            recreate()
            return true
        }
    }

    // --- Screen ---

    private fun immersive() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun showPanel(text: String) {
        statusText.text = text
        backButton.visibility = if (pageLoaded) View.VISIBLE else View.GONE
        panel.visibility = View.VISIBLE
    }

    private fun hidePanel() {
        panel.visibility = View.GONE
    }

    /** The shell's own screen: pairing, retry, and a way out to Android (it is the home app). */
    private fun buildPanel(): View {
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(56), dp(28), dp(28))
        }
        column.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            setTextColor(Color.WHITE)
            textSize = 30f
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
        })
        column.addView(TextView(this).apply {
            text = "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
            setTextColor(DIM)
            textSize = 13f
        })
        statusText = TextView(this).apply {
            setTextColor(TEXT)
            textSize = 18f
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, dp(28))
        }
        column.addView(statusText)
        fun button(label: String, action: () -> Unit) = Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 17f
            setOnClickListener { action() }
            column.addView(this, LinearLayout.LayoutParams(-1, dp(56)).apply { topMargin = dp(10) })
        }
        button("Scan pairing QR") { scan() }
        button("Retry") {
            pageLoaded = false
            authRetried = false
            connect()
        }
        backButton = button("Back to the screen") { hidePanel() }
        button("Phone apps") { openPhoneLauncher() }
        button("Android settings") { startActivity(Intent(AndroidSettings.ACTION_SETTINGS)) }
        button("Choose home app") { startActivity(Intent(AndroidSettings.ACTION_HOME_SETTINGS)) }
        return ScrollView(this).apply {
            setBackgroundColor(BG)
            isFillViewport = true
            addView(column)
        }
    }

    /**
     * The phone's own launcher (Moto's, with every app), for using the phone for a while. This app
     * stays the home app, so Home comes back to the desk screen.
     */
    private fun openPhoneLauncher() {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val other = packageManager.queryIntentActivities(home, 0)
            .map { it.activityInfo }
            .filter { it.packageName != packageName && it.exported }
            // The system's fallback home has no app list; any real launcher comes first.
            .sortedBy { if (it.packageName == "com.android.settings") 1 else 0 }
            .firstOrNull()
        if (other == null) {
            showPanel("No other launcher found. Use Choose home app instead.")
            return
        }
        runCatching {
            startActivity(Intent(home).setClassName(other.packageName, other.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { showPanel("Couldn't open ${other.packageName}: ${it.message}") }
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code ->
                val link = PairingLink.parse(code.rawValue ?: "")
                if (link == null) showPanel("That QR isn't a pairing code. Open Phone on the dashboard.") else pair(link)
            }
            .addOnFailureListener { showPanel("The scanner didn't open: ${it.message}") }
    }

    private fun deviceName(): String =
        AndroidSettings.Global.getString(contentResolver, AndroidSettings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"

    private fun describe(e: Throwable): String = when (e) {
        is HttpFailure -> e.message ?: "HTTP ${e.status}"
        is PinMismatch -> "the server's certificate isn't the paired one"
        is java.net.UnknownHostException -> "unknown host (is Tailscale on?)"
        is java.net.SocketTimeoutException -> "timed out"
        is java.net.ConnectException -> "connection refused or no route"
        else -> e.message ?: e.javaClass.simpleName
    }

    private companion object {
        const val TAG = "TaraPhone"
        const val BG = 0xFF090D16.toInt()
        const val TEXT = 0xFFCBD5E1.toInt()
        const val DIM = 0xFF94A3B8.toInt()
        const val RETRY_MIN_MS = 5_000L
        const val RETRY_MAX_MS = 120_000L
        const val RENEW_MS = 12 * 3_600_000L
        const val UPDATE_EVERY_MS = 6 * 3_600_000L
    }
}
