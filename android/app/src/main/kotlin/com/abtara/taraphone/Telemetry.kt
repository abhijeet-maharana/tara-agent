package com.abtara.taraphone

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Tells tara-agent how the phone is (battery level, charging, temperature) every [EVERY_MS], with the
 * device key, so its Health page can warn when the phone runs hot, sits at 100 % for days, runs down
 * off the charger, or stops reporting (Tailscale off, app gone). Runs until [stop].
 */
class Telemetry(private val context: Context) {
    @Volatile private var paired: Paired? = null
    @Volatile private var stopped = false
    private var thread: Thread? = null

    @Synchronized
    fun start(p: Paired) {
        paired = p
        stopped = false
        if (thread?.isAlive == true) return
        thread = Thread(::loop, "tara-telemetry").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        stopped = true
        thread?.interrupt()
    }

    private fun loop() {
        while (!stopped) {
            val p = paired ?: break
            try {
                val battery = JSONObject(Bridge.batteryJson(context))
                p.net().ok("POST", "/phone/telemetry", JSONObject().put("battery", battery), p.auth)
            } catch (e: Exception) {
                if (stopped) break
                Log.w(TAG, "telemetry: ${e.message}")
            }
            try {
                Thread.sleep(EVERY_MS)
            } catch (_: InterruptedException) {
                if (stopped) break
            }
        }
    }

    companion object {
        private const val TAG = "TaraTelemetry"
        const val EVERY_MS = 10 * 60_000L
    }
}
