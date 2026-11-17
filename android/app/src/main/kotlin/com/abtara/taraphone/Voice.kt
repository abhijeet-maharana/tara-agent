package com.abtara.taraphone

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import org.json.JSONObject

/**
 * Push to talk (docs/jarvis-phone.md, Phase 4), with what Android already has, free: its speech
 * recognizer (Google's, as other apps use it) turns speech into words, tara-agent decides the answer
 * (`POST /phone/voice` with the device key and the lock state), and Android's text to speech says it.
 *
 * The page shows it all: [emit] sends `{type: state|level|partial|heard|reply|error}` to
 * `window.taraVoice`. A reply may ask for a yes (`expect: confirm`: listen again right after speaking)
 * or for the unlock (`unlock`: Android's unlock prompt, then the same words are sent again).
 *
 * The desk phone's media volume is usually 0 (it sits next to films and sleep), so an answer is said
 * at least at [ANSWER_VOLUME] of the media volume, put back afterwards.
 */
class Voice(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    private val ctx = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val keyguard = ctx.getSystemService(KeyguardManager::class.java)

    @Volatile var paired: Paired? = null

    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var turn = 0
    private var lastLevel = 0L
    /** Android's unlock prompt is up for this turn: leaving the screen for it doesn't cancel. */
    private var unlocking = false

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val afterSpeaking = mutableMapOf<String, () -> Unit>()
    private val waitingForTts = mutableListOf<() -> Unit>()
    private var utterances = 0
    private var restoreVolume = -1
    private var boostedTo = -1

    // Timings of the current turn, for the log and the page (ms, SystemClock.elapsedRealtime).
    private var tPressed = 0L
    private var tSpeechEnd = 0L
    private var tHeard = 0L
    private var tReply = 0L

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(ctx)

    /** Push to talk: starts listening, or stops when already listening. */
    fun toggle() = main.post { if (listening) cancel() else listen() }

    fun listen() = main.post {
        stopSpeaking()
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
            return@post
        }
        if (!available()) {
            event("error").put("text", "This phone has no speech recognizer").let(emit)
            return@post
        }
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(ctx).also {
            it.setRecognitionListener(Listener())
            recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANGUAGE)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
        turn++
        listening = true
        tPressed = SystemClock.elapsedRealtime()
        tSpeechEnd = 0
        r.startListening(intent)
        // "Listening" (and a short buzz) only once the recognizer is ready: words said before are lost.
        state("starting")
    }

    /** Stops listening and talking; a reply still on its way is dropped. */
    fun cancel() = main.post {
        turn++
        if (listening) recognizer?.cancel()
        listening = false
        stopSpeaking()
        state("idle")
    }

    /** Words typed or tapped on the page (the Yes / No buttons): sent as if spoken. */
    fun say(text: String) = main.post {
        if (listening) recognizer?.cancel()
        listening = false
        turn++
        tPressed = SystemClock.elapsedRealtime()
        tSpeechEnd = tPressed
        heard(text, turn)
    }

    /** An answer that came later (a question for Claude): said like any other. */
    fun answer(text: String) = main.post { speak(text) { state("idle") } }

    /** The screen went away (Home, another app): stop, unless it's for the unlock prompt. */
    fun leave() = main.post { if (!unlocking) cancel() }

    /** Starts the text to speech engine ahead of the first answer (its cold start took 1.8 s). */
    fun warm() = main.post { withTts {} }

    fun onPermission(granted: Boolean) {
        if (granted) listen() else event("error").put("text", "The microphone isn't allowed").let(emit)
    }

    fun close() {
        main.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        recognizer = null
        stopSpeaking()
        tts?.shutdown()
        tts = null
        io.shutdownNow()
    }

    // --- Hearing ---

    private inner class Listener : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            Log.i(TAG, "recognizer ready ${SystemClock.elapsedRealtime() - tPressed} ms after the tap")
            buzz()
            state("listening")
        }
        override fun onBeginningOfSpeech() {
            Log.i(TAG, "speech began ${SystemClock.elapsedRealtime() - tPressed} ms after the tap")
        }
        override fun onRmsChanged(rmsdB: Float) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastLevel < 90) return
            lastLevel = now
            emit(event("level").put("level", ((rmsdB + 2) / 12).coerceIn(0f, 1f).toDouble()))
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {
            tSpeechEnd = SystemClock.elapsedRealtime()
            state("thinking")
        }
        override fun onError(error: Int) {
            listening = false
            Log.i(TAG, "recognizer error $error")
            if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_CLIENT ||
                error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) {
                recognizer?.destroy()
                recognizer = null
            }
            val text = when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Didn't catch that"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "The microphone isn't allowed"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs the network"
                SpeechRecognizer.ERROR_AUDIO -> "The microphone didn't work"
                else -> "Speech recognition failed ($error)"
            }
            emit(event("error").put("text", text))
            state("idle")
        }
        override fun onResults(results: Bundle?) {
            listening = false
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
            Log.i(TAG, "final: $text")
            if (text.isNullOrEmpty()) {
                emit(event("error").put("text", "Didn't catch that"))
                return state("idle")
            }
            heard(text, turn)
        }
        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            if (!text.isNullOrBlank()) {
                Log.i(TAG, "partial: $text")
                emit(event("partial").put("text", text))
            }
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    // --- Asking tara-agent ---

    private fun heard(text: String, id: Int, afterUnlock: Boolean = false) {
        tHeard = SystemClock.elapsedRealtime()
        if (tSpeechEnd == 0L) tSpeechEnd = tHeard
        emit(event("heard").put("text", text))
        state("thinking")
        val p = paired ?: run {
            emit(event("error").put("text", "Not connected"))
            return state("idle")
        }
        val locked = keyguard?.isDeviceLocked != false
        io.execute {
            try {
                val reply = p.net().ok("POST", "/phone/voice", JSONObject().put("text", text).put("locked", locked), p.auth)
                main.post { if (id == turn) replied(text, reply, afterUnlock) }
            } catch (e: Exception) {
                Log.w(TAG, "voice turn failed", e)
                main.post {
                    if (id != turn) return@post
                    emit(event("error").put("text", "${p.agentName} didn't answer: ${e.message ?: e.javaClass.simpleName}"))
                    state("idle")
                }
            }
        }
    }

    private fun replied(text: String, reply: JSONObject, afterUnlock: Boolean) {
        tReply = SystemClock.elapsedRealtime()
        emit(event("reply").put("reply", reply).put("ms", tReply - tHeard))
        val say = reply.optString("say")
        if (reply.optBoolean("unlock") && !afterUnlock) {
            val id = turn
            val km = keyguard ?: return state("idle")
            speak(say) {}
            unlocking = true
            km.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = main.post {
                    unlocking = false
                    if (id == turn) heard(text, id, afterUnlock = true)
                }.let {}
                override fun onDismissCancelled() = main.post {
                    unlocking = false
                    state("idle")
                }.let {}
                override fun onDismissError() = main.post {
                    unlocking = false
                    state("idle")
                }.let {}
            })
            return
        }
        val confirm = reply.optString("expect") == "confirm"
        val id = turn
        speak(say) { if (confirm && id == turn) listen() else if (id == turn) state("idle") }
    }

    // --- Speaking ---

    private fun speak(text: String, then: () -> Unit) {
        if (text.isBlank()) return then()
        withTts {
            val t = tts ?: return@withTts then()
            boost()
            val id = "voice-${++utterances}"
            afterSpeaking[id] = then
            val params = Bundle().apply { putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC) }
            t.speak(text.take(600), TextToSpeech.QUEUE_FLUSH, params, id)
            state("speaking")
        }
    }

    private fun withTts(block: () -> Unit) {
        if (ttsReady) return block()
        waitingForTts += block
        if (tts != null) return
        tts = TextToSpeech(ctx) { status ->
            main.post {
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.language = Locale.forLanguageTag(LANGUAGE)
                    tts?.setOnUtteranceProgressListener(Progress())
                }
                val waiting = waitingForTts.toList()
                waitingForTts.clear()
                waiting.forEach { if (ttsReady) it() }
                if (!ttsReady) state("idle")
            }
        }
    }

    private inner class Progress : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {
            val now = SystemClock.elapsedRealtime()
            if (tPressed > 0 && tReply > 0) {
                Log.i(TAG, "voice timing: recognizer ${tHeard - tSpeechEnd} ms after speech ended, " +
                    "server ${tReply - tHeard} ms, speech starts ${now - tReply} ms later; " +
                    "end of speech to voice ${now - tSpeechEnd} ms")
                main.post {
                    emit(event("timing").put("recognize", tHeard - tSpeechEnd).put("server", tReply - tHeard)
                        .put("speak", now - tReply).put("total", now - tSpeechEnd))
                }
                tReply = 0
            }
        }
        override fun onDone(utteranceId: String) = finished(utteranceId)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) = finished(utteranceId)
        override fun onStop(utteranceId: String, interrupted: Boolean) = finished(utteranceId, run = false)
    }

    private fun finished(id: String, run: Boolean = true) = main.post {
        val then = afterSpeaking.remove(id)
        if (afterSpeaking.isEmpty()) restore()
        if (run) then?.invoke()
    }.let {}

    private fun stopSpeaking() {
        if (ttsReady) tts?.stop()
        afterSpeaking.clear()
        restore()
    }

    /** At least [ANSWER_VOLUME] of the media volume while it speaks. */
    private fun boost() {
        val a = audio ?: return
        val want = (a.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * ANSWER_VOLUME).roundToInt()
        val now = a.getStreamVolume(AudioManager.STREAM_MUSIC)
        if (now >= want) return
        runCatching { a.setStreamVolume(AudioManager.STREAM_MUSIC, want, 0) }.onSuccess {
            if (restoreVolume < 0) restoreVolume = now
            boostedTo = want
        }
    }

    /** Puts the volume back, unless someone changed it meanwhile. */
    private fun restore() {
        val a = audio ?: return
        if (restoreVolume >= 0 && a.getStreamVolume(AudioManager.STREAM_MUSIC) == boostedTo) {
            runCatching { a.setStreamVolume(AudioManager.STREAM_MUSIC, restoreVolume, 0) }
        }
        restoreVolume = -1
        boostedTo = -1
    }

    private fun buzz() {
        val vm = ctx.getSystemService(android.os.VibratorManager::class.java) ?: return
        vm.defaultVibrator.vibrate(android.os.VibrationEffect.createOneShot(25, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
    }

    private fun event(type: String) = JSONObject().put("type", type)
    private fun state(s: String) = emit(event("state").put("state", s))

    companion object {
        const val REQUEST_MIC = 41
        private const val TAG = "TaraPhone"
        /** Indian English; Google's recognizer also takes Hinglish in it. */
        const val LANGUAGE = "en-IN"
        const val ANSWER_VOLUME = 0.5
    }
}
