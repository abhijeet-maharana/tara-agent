package com.abtara.taraphone

import android.util.Log
import org.json.JSONObject

/**
 * The shell's own line to `/phone/events`, for urgent alerts. With the screen off, Android parks the
 * WebView's page process and the page's event stream goes quiet, but this app process stays awake (it
 * is the top app), so the shell listens here and turns the screen on, vibrates and speaks itself. The
 * page then only shows the alert. Reconnects with back-off until [stop].
 */
class AlertStream(
    private val onAlert: (JSONObject) -> Unit,
    /** The stream failed; e.g. to ask Tailscale to connect. */
    private val onFailure: (Exception) -> Unit = {},
) {
    @Volatile private var paired: Paired? = null
    @Volatile private var stopped = false
    private var thread: Thread? = null
    private val seen = ArrayDeque<String>()

    /** Starts listening (or switches to [p], e.g. after the pin moved). */
    @Synchronized
    fun start(p: Paired) {
        paired = p
        stopped = false
        if (thread?.isAlive == true) return
        thread = Thread(::loop, "tara-alerts").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        stopped = true
        thread?.interrupt()
    }

    private fun loop() {
        var wait = 5_000L
        while (!stopped) {
            val p = paired ?: break
            val started = System.currentTimeMillis()
            try {
                var event = ""
                val data = StringBuilder()
                p.net().stream("/phone/events", p.auth, { stopped || paired != p }) { line ->
                    when {
                        line.startsWith("event:") -> event = line.substring(6).trim()
                        line.startsWith("data:") -> data.append(line.substring(5).trim())
                        line.isEmpty() -> {
                            if (event == "alert" && data.isNotEmpty()) handle(JSONObject(data.toString()))
                            event = ""
                            data.setLength(0)
                        }
                    }
                }
            } catch (e: Exception) {
                if (stopped) break
                Log.w(TAG, "alert stream: ${e.message}")
                onFailure(e)
            }
            // A stream that held for a while starts the back-off again.
            if (System.currentTimeMillis() - started > 60_000) wait = 5_000L
            try {
                Thread.sleep(wait)
            } catch (_: InterruptedException) {
                if (stopped) break
            }
            wait = (wait * 2).coerceAtMost(60_000L)
        }
    }

    private fun handle(alert: JSONObject) {
        val id = alert.optString("id")
        synchronized(seen) {
            if (id in seen) return
            seen.addLast(id)
            if (seen.size > 50) seen.removeFirst()
        }
        if (alert.optBoolean("wake")) onAlert(alert)
    }

    companion object {
        private const val TAG = "TaraAlerts"
    }
}
