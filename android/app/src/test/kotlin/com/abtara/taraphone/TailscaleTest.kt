package com.abtara.taraphone

import java.io.IOException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TailscaleTest {
    @Test
    fun aMissingTailnetLooksDown() {
        assertTrue(Tailscale.looksDown(UnknownHostException("desk.example.ts.net")))
        assertTrue(Tailscale.looksDown(IOException("wrapped", java.net.ConnectException("refused"))))
        assertTrue(Tailscale.looksDown(java.net.SocketException("Software caused connection abort")))
    }

    @Test
    fun aRefusedKeyOrBadCertificateDoesNot() {
        assertFalse(Tailscale.looksDown(HttpFailure(401, "Unknown phone")))
        assertFalse(Tailscale.looksDown(SSLHandshakeException("Pin mismatch")))
        assertFalse(Tailscale.looksDown(PinMismatch("abc")))
    }
}
