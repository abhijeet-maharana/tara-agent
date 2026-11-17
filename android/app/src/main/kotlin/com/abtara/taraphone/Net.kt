package com.abtara.taraphone

import java.io.File
import java.io.IOException
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import org.json.JSONObject

/** The server presented a certificate whose key is not the pinned one. */
class PinMismatch(val seen: String) : IOException("The server's certificate key changed")

class HttpFailure(val status: Int, message: String) : IOException(message)

/**
 * HTTPS to tara-agent for the shell's own calls (pairing, session, updates). With a pin, the
 * certificate is trusted only if its public key hash is the pinned one (a self-signed certificate
 * works too). Without one, the system's trust store decides, and [Response.spki] says what was seen.
 */
class Net(private val host: String, private val port: Int, private val pin: String?) {
    class Response(val status: Int, val body: ByteArray, val spki: String?) {
        fun json() = JSONObject(String(body))
    }

    private inner class Trust : X509TrustManager {
        @Volatile var seen: String? = null
        private val system: X509TrustManager by lazy {
            val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            f.init(null as KeyStore?)
            f.trustManagers.filterIsInstance<X509TrustManager>().first()
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
            val leaf = chain.firstOrNull() ?: throw CertificateException("No certificate")
            seen = Pins.spki(leaf)
            if (pin == null) system.checkServerTrusted(chain, authType)
            else if (!Pins.sameText(pin, seen!!)) throw CertificateException("Pin mismatch")
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) =
            throw CertificateException("Not a server")

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** TLS for other clients (the voice WebSocket): the same pin rule as [call]. */
    fun tls(): Pair<javax.net.ssl.SSLSocketFactory, X509TrustManager> {
        val trust = Trust()
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return ssl.socketFactory to trust
    }

    /** With a pin, the key identifies the server, not the host name. */
    val pinned get() = pin != null

    private fun open(path: String, method: String, headers: Map<String, String>): Pair<HttpsURLConnection, Trust> {
        val trust = Trust()
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val conn = URL("https://$host:$port$path").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = ssl.socketFactory
        // With a pin, the key (from the QR, next to the host name) is what identifies the server.
        if (pin != null) conn.setHostnameVerifier { _, _ -> true }
        conn.requestMethod = method
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn to trust
    }

    private fun <T> guarded(trust: Trust, block: () -> T): T =
        try {
            block()
        } catch (e: SSLHandshakeException) {
            val seen = trust.seen
            if (pin != null && seen != null && seen != pin) throw PinMismatch(seen)
            throw e
        }

    fun call(method: String, path: String, body: JSONObject? = null, auth: String? = null): Response {
        val headers = buildMap {
            put("accept", "application/json")
            if (body != null) put("content-type", "application/json")
            if (auth != null) put("authorization", auth)
        }
        val (conn, trust) = open(path, method, headers)
        return guarded(trust) {
            try {
                if (body != null) {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val status = conn.responseCode
                val bytes = (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } ?: ByteArray(0)
                Response(status, bytes, trust.seen)
            } finally {
                conn.disconnect()
            }
        }
    }

    /** Like [call], but throws [HttpFailure] (with the server's `error` text) for 4xx/5xx. */
    fun ok(method: String, path: String, body: JSONObject? = null, auth: String? = null): JSONObject {
        val r = call(method, path, body, auth)
        if (r.status >= 400) {
            val msg = runCatching { r.json().optString("error") }.getOrNull()?.takeIf { it.isNotBlank() }
            throw HttpFailure(r.status, msg ?: "HTTP ${r.status}")
        }
        return r.json()
    }

    /**
     * Reads a server-sent event stream line by line until it ends, fails or [stopped] says so. The
     * server sends something every 20 s, so a read that waits a minute means the link is gone.
     */
    fun stream(path: String, auth: String, stopped: () -> Boolean, onLine: (String) -> Unit) {
        val (conn, trust) = open(path, "GET", mapOf("authorization" to auth, "accept" to "text/event-stream"))
        conn.readTimeout = 60_000
        guarded(trust) {
            try {
                if (conn.responseCode != 200) throw HttpFailure(conn.responseCode, "HTTP ${conn.responseCode}")
                conn.inputStream.bufferedReader().use { r ->
                    while (!stopped()) onLine(r.readLine() ?: break)
                }
            } finally {
                conn.disconnect()
            }
        }
    }

    /** Downloads to [into], checking the SHA-256 tara-agent announced. */
    fun download(path: String, auth: String, into: File, sha256: String) {
        val (conn, trust) = open(path, "GET", mapOf("authorization" to auth))
        guarded(trust) {
            try {
                if (conn.responseCode != 200) throw HttpFailure(conn.responseCode, "Download failed: HTTP ${conn.responseCode}")
                val digest = MessageDigest.getInstance("SHA-256")
                conn.inputStream.use { input ->
                    into.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            digest.update(buf, 0, n)
                            out.write(buf, 0, n)
                        }
                    }
                }
                val got = digest.digest().joinToString("") { "%02x".format(it) }
                if (got != sha256) throw IOException("The download is damaged (checksum differs)")
            } finally {
                conn.disconnect()
            }
        }
    }
}
