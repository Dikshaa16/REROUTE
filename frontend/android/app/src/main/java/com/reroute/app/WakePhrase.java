package com.reroute.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** "Hey Rico": the words the on-phone listener waits for, and how its answers are read. */
final class WakePhrase {

    /**
     * What the recognizer may hear: the wake phrases, a few names that sound like Rico (so a "hey Ricky" is heard as
     * Ricky, not him), and anything else as [unk]. A short list keeps it light on the battery and false alarms rare.
     */
    static final String GRAMMAR =
        "[\"hey rico\", \"hi rico\", \"okay rico\", \"rico\", \"hey ricky\", \"hey rick\", \"hey nico\", \"hey echo\", \"[unk]\"]";

    /** How sure the recognizer must be that it heard "Rico" himself (its word confidence, 0 to 1). */
    static final double SURE = 0.6;

    private static final Pattern WAKE = Pattern.compile("\\b(hey|hi|okay) rico\\b");
    /** The words of a finished answer: {"text": "..."}. */
    private static final Pattern TEXT = Pattern.compile("\"text\"\\s*:\\s*\"([^\"]*)\"");
    /** Rico in the answer's words, with how sure the recognizer is: {"conf": 0.98, ..., "word": "rico"}. */
    private static final Pattern RICO = Pattern.compile("\"conf\"\\s*:\\s*([0-9.]+)[^{}]*\"word\"\\s*:\\s*\"rico\"");

    private WakePhrase() {}

    /**
     * Whether one of the recognizer's finished answers holds "hey Rico" (or "hi" or "okay Rico"), with Rico heard
     * clearly. Answers on the way don't count: heading for "hey nico", one can read "hey rico" for a moment.
     */
    static boolean heard(String answer) {
        if (!WAKE.matcher(words(answer).toLowerCase(Locale.ROOT)).find()) return false;
        Matcher rico = RICO.matcher(answer);
        // Without word details (the recognizer set to give none), the words alone decide.
        return !rico.find() || Double.parseDouble(rico.group(1)) >= SURE;
    }

    /** The words of a finished answer; none ("") for silence, or an answer on the way. */
    static String words(String answer) {
        if (answer == null) return "";
        Matcher text = TEXT.matcher(answer);
        return text.find() ? text.group(1) : "";
    }
}
