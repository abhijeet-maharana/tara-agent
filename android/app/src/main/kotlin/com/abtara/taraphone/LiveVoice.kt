package com.abtara.taraphone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
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
 * One unprocessed microphone (the speech-recognition source) serves the wake word and the
 * conversation; quiet speech is raised before it goes up. There is no echo canceller on it, so while
 * Jarvis speaks the phone sends silence (half duplex): it never hears itself, and interrupting is by
 * tap or ✕. Answers play at the media volume, raised to [CALL_VOLUME] for the conversation.
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
    @Volatile private var detector: WakeEngine? = null
    /** The owner's own wake word model (trained on jarvis), when there is one. */
    @Volatile private var personal: PersonalModel? = null
    /** A recording for training the wake word, filled by the microphone thread. */
    private class Capture(val label: String, val where: String, val bytes: Int) {
        val out = java.io.ByteArrayOutputStream()
    }
    @Volatile private var capture: Capture? = null
    /**
     * Music plays on the speaker (the page says so): the owner's voice reaches the wake word partly
     * drowned (0.63–0.77 against 0.95, 2026-11-17), so a lower threshold applies meanwhile.
     */
    @Volatile var musicPlaying = false
    /** The teach screen is open: the mic keeps running for recordings, but nothing wakes. */
    @Volatile var training = false
    private val uploads = java.util.concurrent.Executors.newSingleThreadExecutor()
    @Volatile private var sendRing = false
    /** The last second of audio before a wake word, sent first when it fires. */
    private val ring = java.util.concurrent.LinkedBlockingDeque<ByteArray>()
    /** The level of what was sent lately, for the gain in [toGemini]. */
    @Volatile private var sendEnvelope = 0.0
    @Volatile private var sendFloor = 300.0
    @Volatile private var sendPeak = 0.0
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
            loadWakeModel()
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
        // ✕ means silence now: what was already received doesn't keep playing.
        playQueue.clear()
        flushPlayback = true
        if (!talking) return@post
        send(JSONObject().put("type", "stop"))
        stopTalking()
    }

    /** Records [ms] of the wake word's microphone for training; the page hears back through `sample` events. */
    fun recordSample(label: String, where: String, ms: Int) = main.post {
        if (talking || recorder?.isAlive != true) {
            emit(JSONObject().put("type", "sample").put("state", "error").put("message", "The microphone isn't listening (quiet mode, or a conversation is open)"))
            return@post
        }
        capture = Capture(label, where, ms.coerceIn(500, 20_000) * IN_RATE / 1000 * 2)
        emit(JSONObject().put("type", "sample").put("state", "recording"))
    }

    private fun upload(c: Capture) {
        val p = paired ?: return
        val pcm = c.out.toByteArray()
        uploads.execute {
            val ev = JSONObject().put("type", "sample")
            try {
                val body = JSONObject().put("label", c.label).put("where", c.where)
                    .put("pcm", android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP))
                val r = p.net().ok("POST", "/phone/wake-sample", body, p.auth)
                ev.put("state", "saved").put("counts", r.optJSONObject("counts") ?: JSONObject())
                    .put("level", rms(pcm, pcm.size).roundToInt())
            } catch (e: Exception) {
                ev.put("state", "error").put("message", e.message ?: e.javaClass.simpleName)
            }
            main.post { emit(ev) }
        }
    }

    /** Loads the owner's own wake word model from tara-agent (404: none trained yet, the stock model alone). */
    fun loadWakeModel() {
        val p = paired ?: return
        uploads.execute {
            try {
                val r = p.net().call("GET", "/phone/wake-model", auth = p.auth)
                personal = if (r.status == 200) PersonalModel(r.json()) else null
                Log.i(TAG, "live: own wake word model ${if (personal != null) "loaded (threshold ${personal?.threshold})" else "none (${r.status})"}")
            } catch (e: Exception) {
                Log.w(TAG, "live: couldn't load the own wake word model: ${e.message}")
            }
        }
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
            // In a conversation: the call source (echo canceller). Listening for the wake word: the
            // speech-recognition source, without noise suppression, closer to what the models learnt on.
            // One microphone for everything (2026-11-17): the speech-recognition source, unprocessed. The
            // call source's noise suppression mangled far-away speech, and swapping sources mid-question
            // garbled it; echo is handled by sending silence while Jarvis speaks (see SEND_HOLD_MS).
            val source = MediaRecorder.AudioSource.VOICE_RECOGNITION
            val rec = try {
                AudioRecord(source, IN_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, max(min, FRAME_BYTES * 8))
            } catch (e: Exception) {
                Log.w(TAG, "live: no microphone", e)
                return@Thread
            }
            Log.i(TAG, "live: microphone on")
            val buf = ByteArray(FRAME_BYTES)
            var chunk = ShortArray(0)
            var filled = 0
            var floor = 300.0
            var lastLevel = 0L
            var peak = 0.0
            var lastPeakLog = 0L
            // Near misses, for tuning: the best score and the loudest frame every 2 s.
            var bestScore = 0f
            var wakePeak = 0.0
            var lastScoreLog = 0L
            try {
                rec.startRecording()
                while (!Thread.currentThread().isInterrupted && !closed && micWanted()) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    val now = SystemClock.elapsedRealtime()
                    if (talking) {
                        if (sendRing) {
                            sendRing = false
                            // Only the moment before the wake word fired (a question said in one breath),
                            // not "Hey Jarvis" itself: its broken-off end was heard as "service", "voy".
                            for (f in ring.toList().takeLast(WAKE_TAIL_FRAMES)) socket?.send(toGemini(f, f.size).toByteString())
                        }
                        ring.clear()
                        filled = 0
                        // Half duplex: while Jarvis speaks (and a moment after), silence goes up, so the
                        // model never hears itself. Interrupting is by tap (or ✕), not by voice.
                        val speaking = now - lastPlayed < SEND_HOLD_MS || playQueue.isNotEmpty()
                        socket?.send((if (speaking) ByteArray(n) else toGemini(buf, n)).toByteString(0, n))
                    } else {
                        // Listening for the wake word: the last second is kept for the question after it.
                        if (resetWake) {
                            resetWake = false
                            detector?.reset()
                            filled = 0
                        }
                        wakePeak = max(wakePeak, rms(buf, n))
                        if (now - lastScoreLog > 2_000) {
                            if (bestScore > 0.05f) Log.i(TAG, "live: wake score best ${"%.2f".format(bestScore)}, mic peak ${wakePeak.roundToInt()}")
                            bestScore = 0f
                            wakePeak = 0.0
                            lastScoreLog = now
                        }
                        ring.addLast(buf.copyOf(n))
                        while (ring.size > RING_FRAMES) ring.removeFirst()
                        // Recording a training sample: no detection meanwhile ("Hey Jarvis" is the point).
                        val c = capture
                        if (c != null) {
                            c.out.write(buf, 0, n)
                            if (c.out.size() >= c.bytes) {
                                capture = null
                                upload(c)
                            }
                            filled = 0
                            continue
                        }
                        if (training) {
                            filled = 0
                            continue
                        }
                        val engine = wakeEngine() ?: continue
                        if (chunk.size != engine.frameLength) {
                            chunk = ShortArray(engine.frameLength)
                            filled = 0
                        }
                        var i = 0
                        while (i + 1 < n) {
                            chunk[filled++] = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xff)).toShort()
                            i += 2
                            if (filled == chunk.size) {
                                filled = 0
                                val base = engine.feed(chunk)
                                val pm = personal
                                // The owner's own model, when trained, decides instead of the stock one.
                                val score = if (pm != null && engine is WakeWord) pm.score(engine.window()) else base
                                val normal = if (pm != null && engine is WakeWord) pm.threshold else engine.threshold
                                val threshold = if (musicPlaying && pm != null) minOf(normal, MUSIC_THRESHOLD) else normal
                                if (score > bestScore) bestScore = score
                                if (score >= threshold && now - lastWake > WAKE_GAP_MS) {
                                    lastWake = now
                                    Log.i(TAG, "live: wake word heard (${if (pm != null) "own model" else engine.name}, stock ${"%.2f".format(base)}, score ${"%.2f".format(score)})")
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
                Log.i(TAG, "live: microphone off")
                // Seen from here this thread is still alive: clear it, or the restart below never starts.
                if (recorder === Thread.currentThread()) recorder = null
                main.post { ensureRecorder() }
            }
        }, "live-mic")
        recorder = t
        t.start()
    }

    /** The wake word engine (openWakeWord), loaded on first use. */
    private fun wakeEngine(): WakeEngine? {
        detector?.let { return it }
        val e = runCatching { WakeWord(ctx) }.onFailure {
            Log.w(TAG, "live: wake word unavailable", it)
            wakeWanted = false
        }.getOrNull()
        detector = e
        return e
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
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
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

    /** The answer's volume: the media volume (0 on the desk phone) raised for a conversation, put back after. */
    private fun callAudio(on: Boolean) {
        val a = audio ?: return
        val stream = AudioManager.STREAM_MUSIC
        if (on) {
            val want = (a.getStreamMaxVolume(stream) * CALL_VOLUME).roundToInt()
            val now = a.getStreamVolume(stream)
            if (now < want) runCatching { a.setStreamVolume(stream, want, 0) }.onSuccess {
                if (restoreVolume < 0) restoreVolume = now
                boostedTo = want
            }
        } else {
            if (playQueue.isNotEmpty() || track != null && SystemClock.elapsedRealtime() - lastPlayed < 500) return
            if (restoreVolume >= 0 && a.getStreamVolume(stream) == boostedTo)
                runCatching { a.setStreamVolume(stream, restoreVolume, 0) }
            restoreVolume = -1
            boostedTo = -1
        }
    }

    /**
     * What goes to Gemini: quiet (far) speech brought up towards a speaking level, from a slow envelope
     * so words keep their shape; at most [MAX_SEND_GAIN]x, none in a quiet room.
     */
    private fun toGemini(b: ByteArray, n: Int): ByteArray {
        val r = rms(b, n)
        // Falls back slowly (~4 s to halve), so the room between words isn't raised to speech level.
        sendEnvelope = max(r, sendEnvelope * 0.993)
        var gain = if (sendEnvelope > 60.0) (SEND_LEVEL / sendEnvelope).coerceIn(1.0, MAX_SEND_GAIN) else 1.0
        // Noise gate: frames well below the speech level (a fan, a distant TV) are turned down, so the
        // room doesn't blur the user's words (checked on a clip with a TV: the whole question heard).
        sendFloor = if (r < sendFloor) sendFloor * 0.9 + r * 0.1 else sendFloor * 0.999 + r * 0.001
        sendPeak = max(r, sendPeak * 0.995)
        if (r < max(sendFloor * 2.5, sendPeak * 0.25)) gain *= GATE_LEVEL
        if (gain in 0.99..1.01) return b
        val out = ByteArray(n)
        var i = 0
        while (i + 1 < n) {
            val v = ((b[i + 1].toInt() shl 8) or (b[i].toInt() and 0xff)).toShort()
            val g = (v * gain).coerceIn(-32768.0, 32767.0).toInt()
            out[i] = (g and 0xff).toByte()
            out[i + 1] = (g shr 8).toByte()
            i += 2
        }
        return out
    }

    private fun buzz() {
        val vm = ctx.getSystemService(android.os.VibratorManager::class.java) ?: return
        vm.defaultVibrator.vibrate(android.os.VibrationEffect.createOneShot(25, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
    }

    fun close() {
        uploads.shutdown()
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
        /** Silence goes up while Jarvis speaks and this long after (the room's echo dies away). */
        const val SEND_HOLD_MS = 300L
        /** The owner's model while music plays (the song alone scores ~0.2–0.3). */
        const val MUSIC_THRESHOLD = 0.6f
        const val SEND_LEVEL = 2_000.0
        const val MAX_SEND_GAIN = 3.0
        /** How far the noise gate turns the room down. */
        const val GATE_LEVEL = 0.25
        /** What is sent from before a wake word: 0.32 s. */
        const val WAKE_TAIL_FRAMES = 8

    }
}
