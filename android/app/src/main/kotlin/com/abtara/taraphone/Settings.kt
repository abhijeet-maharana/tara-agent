package com.abtara.taraphone

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A paired tara-agent: where it is, its pinned key, and this phone's device id and key. */
data class Paired(
    val host: String,
    val port: Int,
    val spki: String,
    val agentName: String,
    val deviceId: String,
    val deviceKey: String,
) {
    val origin get() = "https://$host:$port"
    val auth get() = "Device $deviceId:$deviceKey"
    fun net(pinned: Boolean = true) = Net(host, port, if (pinned) spki else null)
}

/**
 * Stored in app-private preferences; the device key is encrypted with an Android Keystore key, so
 * a copy of the app's files is useless without this phone's hardware. (The admin key for actions
 * comes later, with user authentication required: see docs/jarvis-phone.md.)
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("tara", Context.MODE_PRIVATE)

    fun load(): Paired? {
        val host = prefs.getString("host", null) ?: return null
        val sealed = prefs.getString("key", null) ?: return null
        val key = runCatching { open(sealed) }.getOrNull() ?: return null
        return Paired(
            host,
            prefs.getInt("port", 0),
            prefs.getString("spki", null) ?: return null,
            prefs.getString("name", null) ?: "tara",
            prefs.getString("id", null) ?: return null,
            key,
        )
    }

    fun save(p: Paired) {
        prefs.edit()
            .putString("host", p.host)
            .putInt("port", p.port)
            .putString("spki", p.spki)
            .putString("name", p.agentName)
            .putString("id", p.deviceId)
            .putString("key", seal(p.deviceKey))
            .apply()
    }

    fun clear() = prefs.edit().clear().apply()

    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(text: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        return Base64.encodeToString(c.iv + c.doFinal(text.toByteArray()), Base64.NO_WRAP)
    }

    private fun open(sealed: String): String {
        val all = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, all, 0, 12))
        return String(c.doFinal(all, 12, all.size - 12))
    }

    private companion object {
        const val ALIAS = "tara-phone-device-key"
    }
}
