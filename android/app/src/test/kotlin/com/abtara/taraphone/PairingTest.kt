package com.abtara.taraphone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    private val spki = "++//AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw="

    @Test
    fun parsesTheDashboardsLink() {
        // As URLSearchParams writes it in src/http/phone.ts (pairingUri).
        val link = "tara-phone://pair?h=desk.example.ts.net&p=4443&k=%2B%2B%2F%2FAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw%3D&c=Ab_c-12&n=Jarvis"
        assertEquals(
            PairingLink("desk.example.ts.net", 4443, spki, "Ab_c-12", "Jarvis"),
            PairingLink.parse(link),
        )
    }

    @Test
    fun refusesOtherCodes() {
        assertNull(PairingLink.parse("https://example.com"))
        assertNull(PairingLink.parse("tara-phone://pair?h=x&p=4443&c=1"))
        assertNull(PairingLink.parse("tara-phone://pair?h=a/b&p=4443&k=$spki&c=1"))
        assertNull(PairingLink.parse("tara-phone://pair?h=x&p=99999&k=$spki&c=1"))
        assertNull(PairingLink.parse("not a uri at all %%"))
    }

    @Test
    fun proofMatchesTheServers() {
        // Computed with node:crypto exactly as Phone.pinProof does.
        assertEquals("62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef", Pins.sha256Hex("test-key"))
        assertEquals(
            "mIeK678-T4XWm9UHA45nf8fLzDazMCklOXKeHO1_OAY",
            Pins.proof("test-key", "n0nce-n0nce-n0nce-1234", "abc+/="),
        )
    }
}
