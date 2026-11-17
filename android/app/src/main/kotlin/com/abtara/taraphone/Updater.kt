package com.abtara.taraphone

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import java.io.File

/** A newer shell tara-agent serves (`GET /phone/app.json`). */
data class Update(val versionCode: Int, val versionName: String, val sha256: String)

/**
 * App updates come from tara-agent, not a store: it serves the APK `./gradlew publishApk` built. The
 * phone asks now and then; a newer one is offered with one tap, and Android shows its own install
 * prompt (the app needs "Install unknown apps" once).
 */
object Updater {
    private const val TAG = "TaraUpdate"

    /** The newer version on offer, or null. Network: call off the main thread. */
    fun check(p: Paired): Update? {
        val r = p.net().call("GET", "/phone/app.json", auth = p.auth)
        if (r.status != 200) return null
        val j = r.json()
        val code = j.optInt("versionCode", 0)
        if (code <= BuildConfig.VERSION_CODE) return null
        return Update(code, j.optString("versionName"), j.optString("sha256"))
    }

    /** Downloads, checks and hands the APK to the system installer. Network: call off the main thread. */
    fun install(context: Context, p: Paired, u: Update) {
        val file = File(context.cacheDir, "update.apk")
        p.net().download("/phone/app.apk", p.auth, file, u.sha256)
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("tara-phone.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, InstallReceiver::class.java)
            val pi = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pi.intentSender)
        }
        file.delete()
        Log.i(TAG, "install of ${u.versionName} (${u.versionCode}) handed to the system")
    }
}

/** The installer's answer: on "needs the user", show its confirmation screen. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i("TaraUpdate", "updated")
            else -> Log.w("TaraUpdate", "install failed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        }
    }
}

/** After a reboot or an update, open the screen again (as the home app it opens anyway). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            )
        }.onFailure { Log.w("TaraBoot", "could not open the screen: ${it.message}") }
    }
}
