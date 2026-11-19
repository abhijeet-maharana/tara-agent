package com.abtara.taraphone

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import java.nio.FloatBuffer
import kotlin.random.Random

/**
 * "Hey Jarvis" on the phone (Voice v2 step 4): openWakeWord's three models through ONNX Runtime. Audio
 * never leaves the phone for this; only a detection opens a conversation.
 *
 * Every 80 ms of 16 kHz audio ([CHUNK] samples): the mel spectrogram of the last 1,760 samples gives 8
 * frames (scaled `/10 + 2` as openWakeWord does), the last 76 frames give one 96-value embedding, and
 * the last 16 embeddings give the score (0–1). Checked against a Python run of the same steps: "Hey
 * Jarvis, what's running?" 0.997, a sentence without it 0.001.
 */
/** A wake word detector fed [frameLength] samples of 16 kHz audio at a time; a score ≥ [threshold] wakes. */
interface WakeEngine : AutoCloseable {
    val name: String
    val frameLength: Int
    val threshold: Float
    fun feed(frame: ShortArray): Float
    fun reset() {}
}

class WakeWord(private val context: Context) : WakeEngine {
    override val name = "openWakeWord"
    override val frameLength = CHUNK
    override val threshold = THRESHOLD
    private var envelope = 0.0
    private val env = OrtEnvironment.getEnvironment()
    private val opts = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(1)
        setInterOpNumThreads(1)
    }
    private fun model(name: String) = env.createSession(context.assets.open("oww/$name").use { it.readBytes() }, opts)
    private val mel = model("melspectrogram.onnx")
    private val embedding = model("embedding_model.onnx")
    private val wake = model("hey_jarvis_v0.1.onnx")
    private val melIn = mel.inputNames.first()
    private val embIn = embedding.inputNames.first()
    private val wakeIn = wake.inputNames.first()

    private val raw = FloatArray(MEL_INPUT)
    private val melFrames = ArrayDeque<FloatArray>()
    private val embeddings = ArrayDeque<FloatArray>()

    init {
        reset()
    }

    /** Forgets what was heard (after a conversation), warmed up on low noise as openWakeWord does. */
    override fun reset() {
        envelope = 0.0
        raw.fill(0f)
        melFrames.clear()
        repeat(EMB_FRAMES) { melFrames.addLast(FloatArray(MELS) { 1f }) }
        embeddings.clear()
        val rnd = Random(0)
        repeat(WARMUP_CHUNKS) { step(ShortArray(CHUNK) { (rnd.nextInt(2000) - 1000).toShort() }) }
    }

    /** Takes [CHUNK] samples; returns the score for the audio so far. */
    override fun feed(frame: ShortArray): Float {
        // Distant speech reaches the mic ~10x quieter than near speech and this model scores it low
        // (0.06 at level 179 vs 0.4-0.6 at 2,000-11,000): bring it up towards a speaking level, from a
        // slow envelope so the word keeps its shape.
        var sum = 0.0
        for (x in frame) sum += x.toDouble() * x
        envelope = maxOf(kotlin.math.sqrt(sum / frame.size), envelope * 0.97)
        val gain = if (envelope > MIN_GAIN_LEVEL) (WAKE_LEVEL / envelope).coerceIn(1.0, MAX_GAIN) else 1.0
        val chunk = if (gain > 1.0) ShortArray(frame.size) { (frame[it] * gain).coerceIn(-32768.0, 32767.0).toInt().toShort() } else frame
        step(chunk)
        if (embeddings.size < WAKE_FRAMES) return 0f
        val input = FloatArray(WAKE_FRAMES * EMB)
        embeddings.forEachIndexed { i, e -> e.copyInto(input, i * EMB) }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, WAKE_FRAMES.toLong(), EMB.toLong())).use { t ->
            wake.run(mapOf(wakeIn to t)).use { r -> return (r[0] as OnnxTensor).floatBuffer.get(0) }
        }
    }

    /** The 16 embeddings the last score came from (16 × 96), for a [Verifier]. */
    fun window(): FloatArray {
        val out = FloatArray(WAKE_FRAMES * EMB)
        embeddings.forEachIndexed { i, e -> e.copyInto(out, i * EMB) }
        return out
    }

    private fun step(chunk: ShortArray) {
        System.arraycopy(raw, CHUNK, raw, 0, MEL_INPUT - CHUNK)
        for (i in 0 until CHUNK) raw[MEL_INPUT - CHUNK + i] = chunk[i].toFloat()
        OnnxTensor.createTensor(env, FloatBuffer.wrap(raw), longArrayOf(1, MEL_INPUT.toLong())).use { t ->
            mel.run(mapOf(melIn to t)).use { r ->
                val out = (r[0] as OnnxTensor).floatBuffer
                val frames = out.remaining() / MELS
                repeat(frames) {
                    melFrames.addLast(FloatArray(MELS) { out.get() / 10f + 2f })
                }
            }
        }
        while (melFrames.size > EMB_FRAMES) melFrames.removeFirst()
        val window = FloatArray(EMB_FRAMES * MELS)
        melFrames.forEachIndexed { i, f -> f.copyInto(window, i * MELS) }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(window), longArrayOf(1, EMB_FRAMES.toLong(), MELS.toLong(), 1)).use { t ->
            embedding.run(mapOf(embIn to t)).use { r ->
                val out = (r[0] as OnnxTensor).floatBuffer
                embeddings.addLast(FloatArray(EMB) { out.get() })
            }
        }
        while (embeddings.size > WAKE_FRAMES) embeddings.removeFirst()
    }

    override fun close() {
        mel.close()
        embedding.close()
        wake.close()
        opts.close()
    }

    companion object {
        /** 80 ms at 16 kHz. */
        const val CHUNK = 1280
        /** The chunk plus 3 frames of context (160 samples each). */
        const val MEL_INPUT = CHUNK + 480
        const val MELS = 32
        const val EMB_FRAMES = 76
        const val EMB = 96
        const val WAKE_FRAMES = 16
        const val WARMUP_CHUNKS = 50
        /**
         * openWakeWord suggests 0.5; the owner's own voice scored 0.15–0.50 on the desk phone
         * (2026-11-17), and a sentence without the wake word ~0.001. A false start only opens a
         * conversation (actions still need the unlock and a yes).
         */
        const val THRESHOLD = 0.3f
        const val WAKE_LEVEL = 2_500.0
        const val MAX_GAIN = 12.0
        const val MIN_GAIN_LEVEL = 60.0
    }
}

/**
 * The owner's own "Hey Jarvis" model (Voice v2 step 4): the stock model barely knew his pronunciation,
 * so a small network (1536 -> 64 -> 1) over the same 16 x 96 features is trained on jarvis from his
 * recordings and general speech (deploy/wake/train_personal.py). It replaces the stock score. JSON from
 * `GET /phone/wake-model`: {kind: "mlp", mean, scale, w1 (64 x 1536), b1, w2, b2, threshold}.
 */
class PersonalModel(private val j: org.json.JSONObject) {
    private fun floats(k: String) = j.getJSONArray(k).let { a -> FloatArray(a.length()) { a.getDouble(it).toFloat() } }
    private val mean = floats("mean")
    private val scale = floats("scale")
    private val w1 = floats("w1")
    private val b1 = floats("b1")
    private val w2 = floats("w2")
    private val b2 = j.getDouble("b2").toFloat()
    val threshold = j.optDouble("threshold", 0.9).toFloat()
    private val x = FloatArray(mean.size)

    init {
        val n = WakeWord.WAKE_FRAMES * WakeWord.EMB
        require(j.optString("kind") == "mlp" && mean.size == n && scale.size == n && w1.size == b1.size * n && w2.size == b1.size) {
            "unexpected wake model shape"
        }
    }

    fun score(window: FloatArray): Float {
        for (i in x.indices) x[i] = (window[i] - mean[i]) / scale[i]
        var z = b2
        for (h in b1.indices) {
            var a = b1[h]
            val row = h * x.size
            for (i in x.indices) a += w1[row + i] * x[i]
            if (a > 0f) z += a * w2[h]
        }
        return (1.0 / (1.0 + kotlin.math.exp(-z.toDouble()))).toFloat()
    }
}
