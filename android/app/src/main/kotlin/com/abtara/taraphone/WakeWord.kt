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
class WakeWord(private val context: Context) : AutoCloseable {
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
    fun reset() {
        raw.fill(0f)
        melFrames.clear()
        repeat(EMB_FRAMES) { melFrames.addLast(FloatArray(MELS) { 1f }) }
        embeddings.clear()
        val rnd = Random(0)
        repeat(WARMUP_CHUNKS) { step(ShortArray(CHUNK) { (rnd.nextInt(2000) - 1000).toShort() }) }
    }

    /** Takes [CHUNK] samples; returns the score for the audio so far. */
    fun feed(chunk: ShortArray): Float {
        step(chunk)
        if (embeddings.size < WAKE_FRAMES) return 0f
        val input = FloatArray(WAKE_FRAMES * EMB)
        embeddings.forEachIndexed { i, e -> e.copyInto(input, i * EMB) }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, WAKE_FRAMES.toLong(), EMB.toLong())).use { t ->
            wake.run(mapOf(wakeIn to t)).use { r -> return (r[0] as OnnxTensor).floatBuffer.get(0) }
        }
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
        const val THRESHOLD = 0.5f
    }
}
