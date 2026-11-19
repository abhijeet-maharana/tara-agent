package com.abtara.taraphone

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale
import org.json.JSONObject

/**
 * `window.Android`: what the `/phone` page may ask of the phone. WebView puts this object into every
 * frame, sandboxed ones too, so each call needs [key], a random value only our own page is given (by a
 * script injected into frames from the paired origin; see [script]). Pages use the `window.taraPhone`
 * wrapper that script defines, which holds the key in a closure.
 *
 * Kept small on purpose (PhoneBox's rule): the page asks, the shell decides. Nothing here acts on
 * tara-agent; actions go to the server, which checks them.
 */
class Bridge(private val context: Context, private val host: Host) {
    interface Host {
        fun wakeScreen()
        fun openSetup()
        fun openRemote()
    }

    val key: String = ByteArray(24).also { SecureRandom().nextBytes(it) }.let {
        Base64.getUrlEncoder().withoutPadding().encodeToString(it)
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val pending = mutableListOf<String>()

    /** Push to talk (Phase 4); set by the activity. */
    @Volatile var voice: Voice? = null

    /** Voice v2 (Gemini Live through tara-agent), used instead of [voice] when the host has it. */
    @Volatile var live: LiveVoice? = null

    private fun liveUp() = live?.available() == true

    private fun ok(given: String?) = given != null && MessageDigest.isEqual(given.toByteArray(), key.toByteArray())

    @JavascriptInterface
    fun vibrate(key: String?, ms: Int) {
        if (ok(key)) buzz(ms)
    }

    /** Vibrates for [ms] (the shell's own alerts call it directly). */
    fun buzz(ms: Int) {
        val vm = context.getSystemService(VibratorManager::class.java) ?: return
        vm.defaultVibrator.vibrate(VibrationEffect.createOneShot(ms.coerceIn(1, 5_000).toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
    }

    /** Android's own text to speech, for alerts while no voice session is open. */
    @JavascriptInterface
    fun speak(key: String?, text: String?) {
        if (ok(key)) say(text)
    }

    /** Says [text] with Android's text to speech (the shell's own alerts call it directly). */
    fun say(text: String?) {
        if (text.isNullOrBlank()) return
        val line = text.take(500)
        synchronized(this) {
            if (ttsReady) {
                tts?.speak(line, TextToSpeech.QUEUE_ADD, null, "tara-${System.nanoTime()}")
                return
            }
            pending += line
            if (tts == null) {
                tts = TextToSpeech(context.applicationContext) { status ->
                    synchronized(this) {
                        ttsReady = status == TextToSpeech.SUCCESS
                        if (ttsReady) {
                            tts?.language = Locale.getDefault()
                            pending.forEach { tts?.speak(it, TextToSpeech.QUEUE_ADD, null, "tara-${System.nanoTime()}") }
                        }
                        pending.clear()
                    }
                }
            }
        }
    }

    /** "locked" or "unlocked": the phone's own lock (PIN / fingerprint). */
    @JavascriptInterface
    fun lockState(key: String?): String {
        if (!ok(key)) return ""
        val km = context.getSystemService(KeyguardManager::class.java)
        return if (km?.isDeviceLocked == true) "locked" else "unlocked"
    }

    /** JSON: {level, charging, plugged, temperature (°C), health}. */
    @JavascriptInterface
    fun battery(key: String?): String = if (ok(key)) batteryJson(context) else ""

    /** Turns the screen on (over the lock screen) for an alert. */
    @JavascriptInterface
    fun wakeScreen(key: String?) {
        if (ok(key)) host.wakeScreen()
    }

    /** The shell's version, e.g. "0.1.0 (459000)". */
    @JavascriptInterface
    fun version(key: String?): String = if (ok(key)) "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})" else ""

    /** The shell's own setup panel (pairing, retry, Android settings). */
    @JavascriptInterface
    fun openSetup(key: String?) {
        if (ok(key)) host.openSetup()
    }

    /** True when RustDesk is installed, so the page shows its button. */
    @JavascriptInterface
    fun hasRemote(key: String?): Boolean = ok(key) && remoteIntent(context) != null

    /**
     * Opens RustDesk to see and use the host's screen (the shared Chromes and the rest). Asks for the
     * phone's unlock first: remote control is never one tap away on a locked phone.
     */
    @JavascriptInterface
    fun openRemote(key: String?) {
        if (ok(key)) host.openRemote()
    }

    /** True when the phone can listen (a speech recognizer is installed), so the page shows 🎙. */
    @JavascriptInterface
    fun hasVoice(key: String?): Boolean = ok(key) && (liveUp() || voice?.available() == true)

    /** "Hey Jarvis" on or off (the page turns it off in quiet mode). */
    @JavascriptInterface
    fun setWake(key: String?, on: Boolean) {
        if (ok(key)) live?.setWake(on)
    }

    /** Records a wake word training sample ("wake" or "other", where: near/far/room) for [ms]. */
    @JavascriptInterface
    fun recordWakeSample(key: String?, label: String?, where: String?, ms: Int) {
        if (ok(key) && (label == "wake" || label == "other") && where != null) live?.recordSample(label, where, ms)
    }

    /** The teach screen is open (true) or closed: the wake word doesn't fire meanwhile. */
    @JavascriptInterface
    fun setTraining(key: String?, on: Boolean) {
        if (ok(key)) live?.training = on
    }

    /** Music is playing on the speaker (true) or not: the wake word is easier to trigger meanwhile. */
    @JavascriptInterface
    fun setMusic(key: String?, playing: Boolean) {
        if (ok(key)) live?.musicPlaying = playing
    }

    /** Fetches the wake word verifier again (after training). */
    @JavascriptInterface
    fun reloadWake(key: String?) {
        if (ok(key)) live?.loadWakeModel()
    }

    /** True while Voice v2 is connected: the page shows its live view (steps, cards). */
    @JavascriptInterface
    fun hasLive(key: String?): Boolean = ok(key) && liveUp()

    /** Push to talk: listen, or stop when listening. Replies come to `window.taraVoice`. */
    @JavascriptInterface
    fun listen(key: String?) {
        if (!ok(key)) return
        if (liveUp()) live?.toggle() else voice?.toggle()
    }

    /** Stops listening and speaking. */
    @JavascriptInterface
    fun cancelVoice(key: String?) {
        if (!ok(key)) return
        live?.stop()
        voice?.cancel()
    }

    /** Words from the page (its Yes / No buttons), sent as if spoken. */
    @JavascriptInterface
    fun voiceText(key: String?, text: String?) {
        if (!ok(key) || text.isNullOrBlank()) return
        val l = live
        if (l != null && l.available() && (text == "yes" || text == "no")) l.confirm(text == "yes")
        else voice?.say(text.take(500))
    }

    /** Says an answer that came later (`voice` event), at answer volume. */
    @JavascriptInterface
    fun answer(key: String?, text: String?) {
        if (ok(key) && !text.isNullOrBlank()) voice?.answer(text.take(600))
    }

    fun close() {
        synchronized(this) {
            tts?.shutdown()
            tts = null
            ttsReady = false
        }
    }

    /** Defines `window.taraPhone` with the key bound; injected only into frames from the paired origin. */
    fun script(): String =
        """
        (function (a, k) {
          if (!a || window.taraPhone) return;
          window.taraPhone = Object.freeze({
            vibrate: function (ms) { a.vibrate(k, ms | 0); },
            speak: function (text) { a.speak(k, String(text)); },
            lockState: function () { return a.lockState(k); },
            battery: function () { return a.battery(k); },
            wakeScreen: function () { a.wakeScreen(k); },
            version: function () { return a.version(k); },
            openSetup: function () { a.openSetup(k); },
            hasRemote: function () { return a.hasRemote(k); },
            openRemote: function () { a.openRemote(k); },
            hasVoice: function () { return a.hasVoice(k); },
            hasLive: function () { return a.hasLive(k); },
            setWake: function (on) { a.setWake(k, Boolean(on)); },
            recordWakeSample: function (l, w, ms) { a.recordWakeSample(k, String(l), String(w), ms | 0); },
            reloadWake: function () { a.reloadWake(k); },
            setTraining: function (on) { a.setTraining(k, Boolean(on)); },
            setMusic: function (on) { a.setMusic(k, Boolean(on)); },
            listen: function () { a.listen(k); },
            cancelVoice: function () { a.cancelVoice(k); },
            voiceText: function (t) { a.voiceText(k, String(t)); },
            answer: function (t) { a.answer(k, String(t)); },
            // The shell itself wakes, vibrates and speaks for alerts (AlertStream), screen off or on.
            nativeAlerts: true
          });
        })(window.Android, ${JSONObject.quote(key)});
        """.trimIndent()

    companion object {
        /** JSON: {level, charging, plugged, temperature (°C), health} (the page and [Telemetry] use it). */
        fun batteryJson(context: Context): String {
            val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return "{}"
            val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
            val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            return JSONObject()
                .put("level", if (level < 0) null else level * 100 / scale)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
                .put("plugged", i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0)
                .put("temperature", i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0)
                .put("health", i.getIntExtra(BatteryManager.EXTRA_HEALTH, 0))
                .toString()
        }

        /** RustDesk's Android app. */
        const val REMOTE_PACKAGE = "com.carriez.flutter_hbb"

        fun remoteIntent(context: Context): Intent? =
            context.packageManager.getLaunchIntentForPackage(REMOTE_PACKAGE)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        /** A screen wake lock that turns the display on, held briefly; the activity then keeps it on. */
        @Suppress("DEPRECATION")
        fun wake(context: Context) {
            val pm = context.getSystemService(PowerManager::class.java) ?: return
            pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "tara:wake",
            ).acquire(10_000)
        }
    }
}
