package com.abtara.taraphone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log

/**
 * A foreground service that does nothing itself: while it runs, Android counts the app as in use, so
 * its network stays up with the screen off (Android 15 blocks it for an app whose screen is asleep:
 * `network_blocked_for_top_sleeping_and_above`). [AlertStream] in the activity then still hears urgent
 * alerts and turns the screen on. Started by the activity once it has a session.
 */
class LinkService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Desk link", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps the link to tara-agent open for alerts while the screen is off"
                setShowBadge(false)
            },
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Listening for alerts")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        try {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } catch (e: Exception) {
            // Android refuses a foreground start from the background; the activity starts it again.
            Log.w(TAG, "could not start in the foreground", e)
            stopSelf()
        }
        return START_STICKY
    }

    companion object {
        private const val TAG = "TaraLink"
        private const val CHANNEL = "link"
        private const val ID = 1

        fun start(context: Context) {
            try {
                context.startForegroundService(Intent(context, LinkService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "could not start", e)
            }
        }
    }
}
