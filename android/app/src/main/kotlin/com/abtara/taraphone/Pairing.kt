package com.abtara.taraphone

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * What the dashboard's pairing QR says: `tara-phone://pair?h=<host>&p=<port>&k=<spki>&c=<code>&n=<name>`
 * (see src/http/phone.ts). `spki` is the base64 SHA-256 of the HTTPS certificate's public key.
 */
data class PairingLink(val host: String, val port: Int, val spki: String, val code: String, val name: String) {
    companion object {
        private val HOST = Regex("^[A-Za-z0-9.-]{1,253}$")
        private val SPKI = Regex("^[A-Za-z0-9+/]{43}=$")

        /** Null when the text is not a pairing link (any other QR the camera sees). */
        fun parse(text: String): PairingLink? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "tara-phone" || uri.host != "pair") return null
            val q = (uri.rawQuery ?: "").split('&').filter { it.contains('=') }.associate {
                val (k, v) = it.split('=', limit = 2)
                k to URLDecoder.decode(v, "UTF-8")
            }
            val host = q["h"]?.takeIf { HOST.matches(it) } ?: return null
            val port = q["p"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val spki = q["k"]?.takeIf { SPKI.matches(it) } ?: return null
            val code = q["c"]?.takeIf { it.isNotBlank() } ?: return null
            return PairingLink(host, port, spki, code, q["n"]?.takeIf { it.isNotBlank() } ?: "tara")
        }
    }
}

object Pins {
    /** Base64 SHA-256 of a certificate's SubjectPublicKeyInfo: the same value tara-agent puts in the QR. */
    fun spki(cert: X509Certificate): String = spki(cert.publicKey.encoded)

    fun spki(subjectPublicKeyInfo: ByteArray): String =
        Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(subjectPublicKeyInfo))

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    /**
     * The proof `POST /phone/pin` returns: HMAC-SHA256, keyed with the hex SHA-256 of the device key,
     * of `pin.<nonce>.<spki>`, base64url without padding. Only tara-agent (which keeps that hash) can
     * make it, so a renewed certificate's key can be trusted without scanning a new QR.
     */
    fun proof(deviceKey: String, nonce: String, spki: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sha256Hex(deviceKey).toByteArray(), "HmacSHA256"))
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(mac.doFinal("pin.$nonce.$spki".toByteArray()))
    }

    fun sameText(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
}
