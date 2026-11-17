package com.abtara.taraphone

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * Tailscale on the desk phone sometimes turns itself off (always-on VPN set or not), and then the
 * shell can't reach tara-agent. When a connection fails the way a missing tailnet looks (the host
 * name doesn't resolve, no route, timeout, the link cut), the shell asks Tailscale to connect with its own
 * `CONNECT_VPN` broadcast, at most once every [GAP_MS]. Harmless when Tailscale is already up.
 */
object Tailscale {
    private const val TAG = "TaraTailscale"
    private const val PKG = "com.tailscale.ipn"
    private const val GAP_MS = 2 * 60_000L
    @Volatile private var lastAsked = Long.MIN_VALUE / 2

    /** True for errors that a down tailnet causes (not a refused key or a bad certificate). */
    fun looksDown(e: Throwable): Boolean =
        e is UnknownHostException || e is NoRouteToHostException || e is ConnectException || e is SocketTimeoutException ||
            // "Software caused connection abort": the VPN went away under an open connection.
            e is SocketException ||
            (e.cause?.let(::looksDown) ?: false)

    /** Asks Tailscale to connect when [e] looks like the tailnet is down. */
    fun reviveIfDown(context: Context, e: Throwable) {
        if (!looksDown(e)) return
        val now = SystemClock.elapsedRealtime()
        synchronized(this) {
            if (now - lastAsked < GAP_MS) return
            lastAsked = now
        }
        try {
            context.sendBroadcast(Intent("$PKG.CONNECT_VPN").setClassName(PKG, "$PKG.IPNReceiver"))
            Log.i(TAG, "can't reach tara-agent (${e.javaClass.simpleName}): asked Tailscale to connect")
        } catch (x: Exception) {
            Log.w(TAG, "could not ask Tailscale to connect", x)
        }
    }
}
