package com.abtara.taraphone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

/**
 * Voice v2 (docs/jarvis-phone.md): a conversation with Gemini Live through tara-agent. A WebSocket to
 * `/phone/live` (device key, pinned TLS) carries the microphone up (16 kHz PCM) and the voice down
 * (24 kHz PCM), plus JSON events that the page shows ([emit] → `window.taraLive`): state, both
 * sides' words, a step per tool call, cards.
 *
 * Talking and listening at once needs echo cancellation, or the model hears itself and stops: the
 * microphone is the voice-call source with Android's echo canceller, and the voice plays as a call
 * on the loudspeaker (audio mode `IN_COMMUNICATION`) while a conversation is open. Its volume is the
 * call volume, raised to [CALL_VOLUME] for the conversation and put back after.
 *
 * Latency is measured here, where it is felt: from the last loud microphone frame to the first frame
 * of the answer, logged as `live timing` and sent to tara-agent, which logs it with the lane.
 */
class LiveVoice(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    private val ctx = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val keyguard = ctx.getSystemService(KeyguardManager::class.java)

    @Volatile private var paired: Paired? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var connected = false
    private var client: OkHttpClient? = null
    private var retryMs = 2_000L
    private var closed = false

    /** A conversation is open: the microphone streams. */
    @Volatile var talking = false
        private set
    @Volatile private var recorder: Thread? = null
    @Volatile private var lastLock: Boolean? = null
    private var unlocking = false

    // The wake word: wanted (not quiet mode), the screen showing, and its detector (loaded on first use).
    @Volatile private var wakeWanted = true
    @Volatile private var visible = true
    private var wakeShown = false
    @Volatile private var detector: WakeWord? = null
    @Volatile private var sendRing = false
    /** The last second of audio before a wake word; kept across a microphone restart. */
    private val ring = java.util.concurrent.LinkedBlockingDeque<ByteArray>()
    /**
     * The microphone must start after the audio mode changes: Android sets up the echo canceller for
     * the mode an input starts in. A recorder opened for the wake word (normal mode) lets Jarvis hear
     * itself in a conversation (seen 2026-11-17: it answered its own words, transcribed as gibberish).
     */
    @Volatile private var restartMic = false
    @Volatile private var micInCall = false
    @Volatile private var resetWake = false
    @Volatile private var lastWake = 0L

    // Playback: a queue drained by its own thread into an AudioTrack.
    private val playQueue = LinkedBlockingQueue<ByteArray>()
    @Volatile private var track: AudioTrack? = null
    private var player: Thread? = null
    @Volatile private var lastPlayed = 0L
    @Volatile private var flushPlayback = false

    // End of speech → first sound, measured on the phone.
    @Volatile private var lastVoiceAt = 0L
    @Volatile private var waitingFirstAudio = false

    private var savedMode = -1
    private var restoreVolume = -1
    private var boostedTo = -1

    /** True once tara-agent said this host has Voice v2 and the line is up. */
    fun available() = connected

    fun start(p: Paired) {
        if (paired == p && socket != null) return
        paired = p
        closed = false
        val (ssl, trust) = p.net().tls()
        client = OkHttpClient.Builder()
            .sslSocketFactory(ssl, trust)
            .apply { if (p.net().pinned) hostnameVerifier { _, _ -> true } }
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        open()
    }

    private fun open() {
        val p = paired ?: return
        val c = client ?: return
        if (closed) return
        val req = Request.Builder().url("wss://${p.host}:${p.port}/phone/live").header("Authorization", p.auth).build()
        socket = c.newWebSocket(req, Listener())
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "live: connected")
            connected = true
            retryMs = 2_000
            main.post { ensureRecorder() }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val e = runCatching { JSONObject(text) }.getOrNull() ?: return
            main.post { event(e) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = play(bytes.toByteArray())

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped("closed $code $reason")

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            dropped(if (response?.code == 404) "Voice v2 is off on the host" else (t.message ?: t.javaClass.simpleName))
    }

    private fun dropped(why: String) {
        Log.w(TAG, "live: link down: $why")
        connected = false
        socket = null
        main.post {
            if (talking) {
                stopTalking()
                emit(JSONObject().put("type", "error").put("message", "Voice link lost"))
                emit(JSONObject().put("type", "state").put("state", "idle"))
            }
            if (!closed) {
                main.postDelayed({ open() }, retryMs)
                retryMs = (retryMs * 2).coerceAtMost(60_000)
            }
        }
    }

    private fun send(json: JSONObject) = socket?.send(json.toString())

    // --- Events from tara-agent ---

    private fun event(e: JSONObject) {
        when (e.optString("type")) {
            "end" -> stopTalking()
            "interrupted" -> {
                flushPlayback = true
                playQueue.clear()
            }
            "unlock" -> unlock()
        }
        emit(e)
    }

    // --- Talking ---

    /** 🎙 or the wake word: opens a conversation, or ends the open one. */
    fun toggle() = main.post { if (talking) stop() else talk() }

    fun talk(fromWake: Boolean = false) = main.post {
        if (talking) return@post
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), Voice.REQUEST_MIC)
            return@post
        }
        if (!connected) {
            emit(JSONObject().put("type", "error").put("message", "Voice isn't connected"))
            return@post
        }
        callAudio(true)
        val locked = keyguard?.isDeviceLocked != false
        lastLock = locked
        send(JSONObject().put("type", "start").put("locked", locked))
        // After "Hey Jarvis", the last second goes first: the question often follows in one breath.
        sendRing = fromWake
        talking = true
        ensureRecorder()
        main.post(lockWatch)
        buzz()
    }

    fun stop() = main.post {
        if (!talking) return@post
        send(JSONObject().put("type", "stop"))
        stopTalking()
    }

    /** The Yes / No buttons on the screen. */
    fun confirm(yes: Boolean) = send(JSONObject().put("type", "confirm").put("yes", yes))

    /** The screen went away (Home, another app): end the conversation, unless it's for the unlock. */
    fun leave() = main.post {
        if (unlocking) return@post
        visible = false
        if (talking) stop()
    }

    /** The screen is back: the wake word listens again. */
    fun resume() = main.post {
        visible = true
        ensureRecorder()
    }

    /**
     * "Hey Jarvis" on or off: off in quiet mode (the page says so), and while the screen is away. Only
     * the phone hears the room until the wake word; then a conversation opens as with 🎙.
     */
    fun setWake(on: Boolean) = main.post {
        if (wakeWanted != on) Log.i(TAG, "live: wake word ${if (on) "on" else "off"}")
        wakeWanted = on
        // A page that just loaded learns the state too.
        wakeShown = !wakeListening()
        ensureRecorder()
    }

    private fun stopTalking() {
        talking = false
        main.removeCallbacks(lockWatch)
        // The detector belongs to the microphone thread: it resets there.
        resetWake = true
        // Let the last words play before the audio mode goes back.
        main.postDelayed({ if (!talking) callAudio(false) }, 1_500)
    }

    /** The microphone runs while talking, or while the wake word may be heard. */
    private fun wakeListening() =
        wakeWanted && visible && connected && !closed &&
            activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun micWanted() = talking || wakeListening()

    private fun ensureRecorder() {
        val on = wakeListening()
        if (on != wakeShown) {
            wakeShown = on
            emit(JSONObject().put("type", "wake").put("on", on))
        }
        if (micWanted() && recorder?.isAlive != true) startRecorder()
    }

    /** The lock state, sent on change while a conversation is open (actions need it unlocked). */
    private val lockWatch = object : Runnable {
        override fun run() {
            if (!talking) return
            val locked = keyguard?.isDeviceLocked != false
            if (locked != lastLock) {
                lastLock = locked
                send(JSONObject().put("type", "lock").put("locked", locked))
            }
            main.postDelayed(this, 700)
        }
    }

    private fun unlock() {
        val km = keyguard ?: return
        if (!km.isDeviceLocked) {
            send(JSONObject().put("type", "lock").put("locked", false))
            return
        }
        unlocking = true
        km.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                unlocking = false
                lastLock = false
                send(JSONObject().put("type", "lock").put("locked", false))
            }
            override fun onDismissCancelled() { unlocking = false }
            override fun onDismissError() { unlocking = false }
        })
    }

    @SuppressLint("MissingPermission")
    private fun startRecorder() {
        val t = Thread({
            val min = AudioRecord.getMinBufferSize(IN_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = try {
                AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, IN_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, max(min, FRAME_BYTES * 8))
            } catch (e: Exception) {
                Log.w(TAG, "live: no microphone", e)
                return@Thread
            }
            val aec = if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } else null
            val ns = if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } else null
            Log.i(TAG, "live: microphone on (echo canceller ${aec?.enabled ?: "none"}, noise suppressor ${ns?.enabled ?: "none"})")
            micInCall = audio?.mode == AudioManager.MODE_IN_COMMUNICATION
            val buf = ByteArray(FRAME_BYTES)
            val chunk = ShortArray(WakeWord.CHUNK)
            var filled = 0
            var floor = 300.0
            var lastLevel = 0L
            var peak = 0.0
            var lastPeakLog = 0L
            try {
                rec.startRecording()
                while (!Thread.currentThread().isInterrupted && !closed && micWanted() && !restartMic) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    val now = SystemClock.elapsedRealtime()
                    if (talking) {
                        if (sendRing) {
                            sendRing = false
                            for (f in ring) socket?.send(f.toByteString())
                        }
                        ring.clear()
                        filled = 0
                        socket?.send(buf.toByteString(0, n))
                    } else {
                        // Listening for the wake word: the last second is kept for the question after it.
                        if (resetWake) {
                            resetWake = false
                            detector?.reset()
                            filled = 0
                        }
                        ring.addLast(buf.copyOf(n))
                        while (ring.size > RING_FRAMES) ring.removeFirst()
                        var i = 0
                        while (i + 1 < n) {
                            chunk[filled++] = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xff)).toShort()
                            i += 2
                            if (filled == chunk.size) {
                                filled = 0
                                val score = wakeScore(chunk)
                                if (score >= WakeWord.THRESHOLD && now - lastWake > WAKE_GAP_MS) {
                                    lastWake = now
                                    Log.i(TAG, "live: wake word heard (score ${"%.2f".format(score)})")
                                    // The wake word counts as speech for the latency figure.
                                    lastVoiceAt = now
                                    talk(fromWake = true)
                                }
                            }
                        }
                        continue
                    }
                    val rms = rms(buf, n)
                    val playing = now - lastPlayed < 400
                    // The noise floor learns only from frames without our own voice playing (its echo
                    // would lift it), and rises slowly, so speech doesn't become the floor.
                    if (!playing) floor = if (rms < floor) floor * 0.9 + rms * 0.1 else floor * 0.999 + rms * 0.001
                    if (!playing && rms > max(floor * 3, MIN_SPEECH_RMS)) {
                        lastVoiceAt = now
                        waitingFirstAudio = true
                    }
                    peak = max(peak, rms)
                    if (now - lastPeakLog > 1_000) {
                        if (peak > MIN_SPEECH_RMS) Log.d(TAG, "live mic: peak ${peak.roundToInt()} floor ${floor.roundToInt()}${if (playing) " (playing)" else ""}")
                        peak = 0.0
                        lastPeakLog = now
                    }
                    if (now - lastLevel > 90) {
                        lastLevel = now
                        val level = (rms / 3000.0).coerceIn(0.0, 1.0)
                        main.post { emit(JSONObject().put("type", "level").put("level", level)) }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "live: microphone stopped", e)
            } finally {
                runCatching { rec.stop() }
                rec.release()
                aec?.release()
                ns?.release()
                Log.i(TAG, "live: microphone off${if (restartMic) " (restarting for the audio mode)" else ""}")
                restartMic = false
                main.post { ensureRecorder() }
            }
        }, "live-mic")
        recorder = t
        t.start()
    }

    /** The wake word's score for 80 ms of audio; the models load on first use. */
    private fun wakeScore(chunk: ShortArray): Float {
        val d = detector ?: runCatching { WakeWord(ctx) }.onFailure {
            Log.w(TAG, "live: wake word unavailable", it)
            wakeWanted = false
        }.getOrNull()?.also { detector = it } ?: return 0f
        return d.feed(chunk)
    }

    private fun rms(b: ByteArray, n: Int): Double {
        var sum = 0.0
        var i = 0
        while (i + 1 < n) {
            val s = ((b[i + 1].toInt() shl 8) or (b[i].toInt() and 0xff)).toShort().toDouble()
            sum += s * s
            i += 2
        }
        return sqrt(sum / max(1, n / 2))
    }

    // --- Playing ---

    private fun play(pcm: ByteArray) {
        if (waitingFirstAudio && lastVoiceAt > 0) {
            val ms = SystemClock.elapsedRealtime() - lastVoiceAt
            waitingFirstAudio = false
            if (ms in 0..60_000) {
                Log.i(TAG, "live timing: end of speech to first sound $ms ms")
                send(JSONObject().put("type", "timing").put("ms", ms))
                main.post { emit(JSONObject().put("type", "timing").put("total", ms)) }
            }
        }
        waitingFirstAudio = false
        if (!talking) main.post { callAudio(true) }
        // The wake word's microphone started in normal mode, without the echo canceller: swap it for
        // one in call mode now that Jarvis answers (the user has finished; mid-sentence it garbled).
        if (talking && recorder?.isAlive == true && !micInCall) restartMic = true
        playQueue.offer(pcm)
        ensurePlayer()
    }

    @Synchronized
    private fun ensurePlayer() {
        if (player?.isAlive == true) return
        val t = Thread({
            val min = AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val tr = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(OUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(max(min, OUT_RATE / 5 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            track = tr
            tr.play()
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val chunk = playQueue.poll(8, TimeUnit.SECONDS) ?: break
                    if (flushPlayback) {
                        flushPlayback = false
                        tr.pause(); tr.flush(); tr.play()
                        continue
                    }
                    lastPlayed = SystemClock.elapsedRealtime()
                    tr.write(chunk, 0, chunk.size)
                    lastPlayed = SystemClock.elapsedRealtime()
                }
            } catch (_: InterruptedException) {
            } finally {
                runCatching { tr.stop() }
                tr.release()
                track = null
                main.post { if (!talking) callAudio(false) }
            }
        }, "live-play")
        player = t
        t.start()
    }

    /** The voice-call audio mode on the loudspeaker (for the echo canceller), and its volume. */
    @SuppressLint("WrongConstant") // savedMode is a mode AudioManager gave us
    private fun callAudio(on: Boolean) {
        val a = audio ?: return
        if (on) {
            if (savedMode < 0) savedMode = a.mode
            a.mode = AudioManager.MODE_IN_COMMUNICATION
            a.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                ?.let { a.setCommunicationDevice(it) }
            val want = (a.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL) * CALL_VOLUME).roundToInt()
            val now = a.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
            if (now < want) runCatching { a.setStreamVolume(AudioManager.STREAM_VOICE_CALL, want, 0) }.onSuccess {
                if (restoreVolume < 0) restoreVolume = now
                boostedTo = want
            }
        } else {
            if (playQueue.isNotEmpty() || track != null && SystemClock.elapsedRealtime() - lastPlayed < 500) return
            if (savedMode < 0) return
            if (restoreVolume >= 0 && a.getStreamVolume(AudioManager.STREAM_VOICE_CALL) == boostedTo)
                runCatching { a.setStreamVolume(AudioManager.STREAM_VOICE_CALL, restoreVolume, 0) }
            restoreVolume = -1
            boostedTo = -1
            a.clearCommunicationDevice()
            a.mode = savedMode
            savedMode = -1
            if (recorder?.isAlive == true && micInCall && !talking) restartMic = true
        }
    }

    private fun buzz() {
        val vm = ctx.getSystemService(android.os.VibratorManager::class.java) ?: return
        vm.defaultVibrator.vibrate(android.os.VibrationEffect.createOneShot(25, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
    }

    fun close() {
        closed = true
        talking = false
        detector?.close()
        detector = null
        recorder?.interrupt()
        player?.interrupt()
        socket?.close(1000, "bye")
        socket = null
        main.removeCallbacksAndMessages(null)
        callAudio(false)
    }

    companion object {
        private const val TAG = "TaraPhone"
        const val IN_RATE = 16_000
        const val OUT_RATE = 24_000
        /** 40 ms of 16 kHz 16-bit mono. */
        const val FRAME_BYTES = IN_RATE / 25 * 2
        /** Below this the microphone is never "speech", whatever the noise floor (16-bit RMS). */
        const val MIN_SPEECH_RMS = 350.0
        const val CALL_VOLUME = 0.7
        /** Audio kept before a wake word: 1 s of 40 ms frames. */
        const val RING_FRAMES = 25
        /** One detection per this long (the score stays high for a few chunks). */
        const val WAKE_GAP_MS = 2_000L
    }
}
