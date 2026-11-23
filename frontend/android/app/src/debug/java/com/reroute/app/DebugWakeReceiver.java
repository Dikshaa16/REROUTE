package com.reroute.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import java.io.FileInputStream;
import org.vosk.Model;
import org.vosk.Recognizer;

/**
 * Debug builds only (this file is in src/debug): plays a recording into Rico's ear in place of the microphone, so
 * "Hey Rico" can be tested on an emulator, through the same model, grammar and wake as RicoListener:
 *   adb shell am broadcast -n com.reroute.app/.DebugWakeReceiver --es wav /path/to/file.wav
 * The recording is a 16 kHz, 16-bit mono WAV the app can read. Logs "DebugWake: woke" or "DebugWake: asleep".
 */
public class DebugWakeReceiver extends BroadcastReceiver {

    private static final String TAG = "DebugWake";

    @Override
    public void onReceive(Context context, Intent intent) {
        String path = intent.getStringExtra("wav");
        if (path == null || !RicoModel.ready(context)) {
            Log.w(TAG, "Needs --es wav <file> and Rico's ear downloaded (turn Hey Rico on in Me)");
            return;
        }
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        // One recognizer at a time, as on a phone: Rico's ear lets go of the microphone while the recording plays.
        boolean live = RicoListener.isRunning(app);
        if (live) app.startService(new Intent(app, RicoListener.class).setAction(RicoListener.ACTION_PAUSE));
        new Thread(() -> {
            if (live) SystemClock.sleep(1000);
            try (Model model = new Model(RicoModel.dir(app).getAbsolutePath()); FileInputStream in = new FileInputStream(path)) {
                // The WAV header: 44 bytes before the samples.
                if (in.skip(44) != 44) throw new java.io.IOException("Not a WAV file");
                boolean woke = false;
                StringBuilder heard = new StringBuilder();
                try (Recognizer recognizer = new Recognizer(model, 16000.0f, WakePhrase.GRAMMAR)) {
                    recognizer.setWords(true);
                    byte[] buffer = new byte[4096];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        if (!recognizer.acceptWaveForm(buffer, n)) continue;
                        String answer = recognizer.getResult();
                        heard.append(answer.replaceAll("\\s+", " ")).append(' ');
                        if (WakePhrase.heard(answer)) woke = true;
                    }
                    String last = recognizer.getFinalResult();
                    heard.append(last.replaceAll("\\s+", " "));
                    if (WakePhrase.heard(last)) woke = true;
                }
                Log.i(TAG, (woke ? "woke" : "asleep") + " " + heard);
                boolean wake = woke;
                new Handler(Looper.getMainLooper()).post(() -> {
                    // Listening again first, so a voice screen that opens for the wake can pause it as it would.
                    if (live) app.startService(new Intent(app, RicoListener.class).setAction(RicoListener.ACTION_RESUME));
                    if (wake) RicoListener.woke(app);
                });
            } catch (Exception e) {
                Log.w(TAG, "Couldn't play the recording", e);
            } finally {
                pending.finish();
            }
        }, "debug-wake").start();
    }
}
