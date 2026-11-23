package com.reroute.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** "Hey Rico" wakes him; the names that sound like him, answers on the way, and everything else, don't. */
public class WakePhraseTest {

    private static String answer(String text, double ricoConf) {
        return "{\n  \"result\" : [{\n      \"conf\" : 1.000000,\n      \"end\" : 0.66,\n      \"start\" : 0.30,\n      \"word\" : \"hey\"\n    }, {\n"
            + "      \"conf\" : " + ricoConf + ",\n      \"end\" : 1.02,\n      \"start\" : 0.66,\n      \"word\" : \"rico\"\n    }],\n"
            + "  \"text\" : \"" + text + "\"\n}";
    }

    @Test
    public void wakesOnHeyHiOrOkayRicoHeardClearly() {
        assertTrue(WakePhrase.heard(answer("hey rico", 0.98)));
        assertTrue(WakePhrase.heard("{\"text\" : \"hi rico\"}"));
        assertTrue(WakePhrase.heard("{\"text\": \"[unk] okay rico [unk]\"}"));
        assertTrue(WakePhrase.heard("{\"text\": \"HEY RICO\"}"));
    }

    @Test
    public void staysAsleepOtherwise() {
        assertFalse(WakePhrase.heard(null));
        assertFalse(WakePhrase.heard("{\"text\": \"\"}"));
        assertFalse(WakePhrase.heard("{\"text\": \"rico\"}"));
        assertFalse(WakePhrase.heard("{\"text\": \"hey ricky\"}"));
        assertFalse(WakePhrase.heard("{\"text\": \"hey nico nico\"}"));
        assertFalse(WakePhrase.heard("{\"text\": \"hey ricotta\"}"));
        // An answer on the way: it may yet turn out to be "hey nico".
        assertFalse(WakePhrase.heard("{\"partial\": \"hey rico\"}"));
        // Rico not heard clearly enough.
        assertFalse(WakePhrase.heard(answer("hey rico", 0.41)));
    }

    @Test
    public void readsTheWordsOfAFinishedAnswer() {
        assertEquals("hey rico", WakePhrase.words(answer("hey rico", 0.98)));
        assertEquals("", WakePhrase.words("{\"text\" : \"\"}"));
        assertEquals("", WakePhrase.words("{\"partial\": \"hey rico\"}"));
        assertEquals("", WakePhrase.words(null));
    }

    @Test
    public void listensForTheWakePhrasesAndTheirSoundAlikes() {
        for (String phrase : new String[] { "hey rico", "hi rico", "okay rico", "hey ricky", "[unk]" }) {
            assertTrue(phrase, WakePhrase.GRAMMAR.contains("\"" + phrase + "\""));
        }
    }
}
