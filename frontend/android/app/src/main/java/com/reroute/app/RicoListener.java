package com.reroute.app;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.List;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

/**
 * Listens for "Hey Rico", on the phone itself: a foreground service, with its notification showing all the while
 * ("Rico is listening for "Hey Rico""), so it carries on with Reroute in the background or closed when the traveller
 * has turned that on in Me. The microphone goes only to the on-phone recognizer (Vosk, RicoModel); nothing leaves
 * the phone. On "Hey Rico", Reroute on screen opens Rico at once; otherwise Rico pops up as a notification, and a
 * tap opens him listening. While Rico talks out loud, the listener lets go of the microphone (pause, resume), but
 * only while Reroute is on screen: swiped away or sent to the back mid-conversation, Rico listens again by himself.
 *
 * It runs in a process of its own (":ear", in the manifest): the recognizer is native code, and when its decoder
 * fails (Kaldi aborts on a lattice it can't prune: every path lost on some sound) it takes only this process down,
 * never Reroute. The app starts it again when it's next opened. Each "Hey Rico" crosses to the app's process as a
 * broadcast (WakeReceiver), and the app asks Android whether it's running (isRunning).
 */
public class RicoListener extends Service implements RecognitionListener {

    static final String ACTION_START = "com.reroute.app.rico.START";
    static final String ACTION_STOP = "com.reroute.app.rico.STOP";
    static final String ACTION_PAUSE = "com.reroute.app.rico.PAUSE";
    static final String ACTION_RESUME = "com.reroute.app.rico.RESUME";
    /** Opening the app from Rico's notification: it opens him listening. */
    static final String EXTRA_RICO = "com.reroute.app.rico";

    static final String LISTENING_CHANNEL = "rico_listening";
    static final String RICO_CHANNEL = "rico";
    private static final int LISTENING_ID = 7701;
    private static final int WAKE_ID = 7702;
    private static final String TAG = "RicoListener";
    /** One wake for one "Hey Rico": the recognizer can hear it again in the next answer. */
    private static final long WAKE_GAP_MS = 4000;
    /** How often, while Rico talks, the listener checks Reroute is still on screen. */
    private static final long PAUSE_CHECK_MS = 3000;

    static volatile boolean running = false;
    private static long lastWake = 0;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private boolean paused = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            paused = true;
            stopListening();
            Log.i(TAG, "Letting go of the microphone while Rico talks");
            // Only while Reroute is on screen: whatever takes his voice screen away (the app swiped off, or sent to the
            // back) without saying so, Rico listens again.
            main.postDelayed(whilePaused, PAUSE_CHECK_MS);
            return START_NOT_STICKY;
        }
        if (ACTION_RESUME.equals(action)) {
            paused = false;
            listen();
            return START_NOT_STICKY;
        }
        // Start: in the foreground at once (Android asks within seconds), then load the ear and listen.
        try {
            ServiceCompat.startForeground(
                this,
                LISTENING_ID,
                listeningNotification(),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0
            );
        } catch (RuntimeException e) {
            // Android refuses a microphone service started from the background (after a restart, say): Reroute
            // starts it again the next time it's opened.
            Log.w(TAG, "Couldn't listen in the foreground", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        paused = false;
        listen();
        return START_NOT_STICKY;
    }

    /** While Rico's voice screen has the microphone: listening again as soon as Reroute isn't on screen. */
    private final Runnable whilePaused = new Runnable() {
        @Override
        public void run() {
            if (!paused) return;
            if (rerouteOnScreen()) {
                main.postDelayed(this, PAUSE_CHECK_MS);
                return;
            }
            Log.i(TAG, "Listening again: Reroute isn't on screen");
            paused = false;
            listen();
        }
    };

    /** Whether Reroute's own screen (the app's main process, not this one) is in front. */
    private boolean rerouteOnScreen() {
        ActivityManager manager = getSystemService(ActivityManager.class);
        List<ActivityManager.RunningAppProcessInfo> processes = manager != null ? manager.getRunningAppProcesses() : null;
        if (processes == null) return false;
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (getPackageName().equals(process.processName)) {
                return process.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
            }
        }
        return false;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Reroute swiped away from Recents: his voice screen went with it, so Rico listens again at once.
        if (paused) {
            Log.i(TAG, "Listening again: Reroute was swiped away");
            paused = false;
            listen();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopListening();
        if (model != null) model.close();
        model = null;
        running = false;
        super.onDestroy();
    }

    private void stopEverything() {
        stopListening();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        running = false;
    }

    private void listen() {
        if (speech != null || paused) return;
        if (!RicoModel.ready(this)) {
            Log.w(TAG, "No model yet: turn Hey Rico on again in Me");
            stopEverything();
            return;
        }
        new Thread(() -> {
            try {
                if (model == null) {
                    LibVosk.setLogLevel(LogLevel.WARNINGS);
                    model = new Model(RicoModel.dir(this).getAbsolutePath());
                }
                Recognizer recognizer = new Recognizer(model, 16000.0f, WakePhrase.GRAMMAR);
                // Each word with how sure the recognizer is, so a muffled "Rico" doesn't wake him.
                recognizer.setWords(true);
                main.post(() -> {
                    if (paused || speech != null || !running) {
                        recognizer.close();
                        return;
                    }
                    try {
                        speech = new SpeechService(recognizer, 16000.0f);
                        speech.startListening(this);
                    } catch (Exception e) {
                        // The microphone is busy (a call, or another app recording): try again shortly.
                        Log.w(TAG, "The microphone isn't free", e);
                        recognizer.close();
                        speech = null;
                        main.postDelayed(this::listen, 5000);
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "Couldn't load Rico's ear", e);
                main.post(this::stopEverything);
            }
        }, "rico-ear").start();
    }

    private void stopListening() {
        main.removeCallbacksAndMessages(null);
        if (speech != null) {
            speech.stop();
            speech.shutdown();
            speech = null;
        }
    }

    @Override
    public void onPartialResult(String hypothesis) {
        // Answers on the way don't count (WakePhrase.heard): only finished ones.
    }

    @Override
    public void onResult(String hypothesis) {
        heard(hypothesis);
    }

    @Override
    public void onFinalResult(String hypothesis) {
        heard(hypothesis);
    }

    /** To the app's process, which knows whether Reroute is on screen. */
    private void heard(String hypothesis) {
        boolean wake = WakePhrase.heard(hypothesis);
        // What the ear made of each phrase, with how sure it was, in debug builds only (adb logcat -s RicoListener):
        // why a "Hey Rico" on a real phone didn't wake him. Only the listed phrases can come out of it.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0 && !WakePhrase.words(hypothesis).isEmpty()) {
            Log.d(TAG, (wake ? "Wake: " : "Heard: ") + hypothesis.replaceAll("\\s+", " "));
        }
        if (wake) sendBroadcast(new Intent(this, WakeReceiver.class));
    }

    @Override
    public void onError(Exception e) {
        Log.w(TAG, "The recognizer stopped", e);
        stopListening();
        main.postDelayed(this::listen, 5000);
    }

    @Override
    public void onTimeout() {
        stopListening();
        listen();
    }

    /** Whether Rico's ear is running. It's another process, so the app asks Android (for its own services only). */
    @SuppressWarnings("deprecation")
    static boolean isRunning(Context context) {
        ActivityManager manager = context.getSystemService(ActivityManager.class);
        if (manager == null) return false;
        for (ActivityManager.RunningServiceInfo info : manager.getRunningServices(Integer.MAX_VALUE)) {
            if (RicoListener.class.getName().equals(info.service.getClassName()) && info.foreground) return true;
        }
        return false;
    }

    /** "Hey Rico" was heard (in the app's process): Reroute on screen opens Rico; otherwise he pops up over the screen and
     *  opens it, or comes as a notification. */
    static void woke(Context context) {
        long now = System.currentTimeMillis();
        synchronized (RicoListener.class) {
            if (now - lastWake < WAKE_GAP_MS) return;
            lastWake = now;
        }
        if (RicoWakePlugin.deliverWake()) return;
        // Over whatever is on screen, when the traveller lets him (Me, and Android's "Display over other apps").
        if (RicoPopUp.show(context)) return;
        notifyWake(context);
    }

    /** "I'm here! Tap to talk.": Rico as a notification, which opens him talking. */
    static void notifyWake(Context context) {
        NotificationManagerCompat notifications = NotificationManagerCompat.from(context);
        if (!notifications.areNotificationsEnabled()) return;
        ensureChannels(context);
        Intent open = new Intent(context, MainActivity.class)
            .putExtra(EXTRA_RICO, "wake")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, WAKE_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification wake = new NotificationCompat.Builder(context, RICO_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reroute)
            .setColor(ContextCompat.getColor(context, R.color.reroute_green))
            .setContentTitle("Rico")
            .setContentText("I'm here! Tap to talk.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setContentIntent(tap)
            .setAutoCancel(true)
            // A "Hey Rico" from a minute ago isn't a call any more.
            .setTimeoutAfter(60_000)
            .build();
        try {
            notifications.notify(WAKE_ID, wake);
        } catch (SecurityException e) {
            // Notifications were turned off a moment ago.
        }
    }

    private Notification listeningNotification() {
        ensureChannels(this);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, LISTENING_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, RicoListener.class).setAction(ACTION_STOP);
        PendingIntent off = PendingIntent.getService(this, LISTENING_ID + 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, LISTENING_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reroute)
            .setColor(ContextCompat.getColor(this, R.color.reroute_green))
            .setContentTitle("Rico is listening for “Hey Rico”")
            .setContentText("Only on this phone. Turn it off here or in Me.")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(tap)
            .addAction(0, "Stop listening", off)
            .build();
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(LISTENING_CHANNEL) == null) {
            NotificationChannel quiet = new NotificationChannel(LISTENING_CHANNEL, "Listening for Hey Rico", NotificationManager.IMPORTANCE_LOW);
            quiet.setDescription("Shows while Rico listens for “Hey Rico”.");
            quiet.setShowBadge(false);
            manager.createNotificationChannel(quiet);
        }
        if (manager.getNotificationChannel(RICO_CHANNEL) == null) {
            NotificationChannel rico = new NotificationChannel(RICO_CHANNEL, "Rico", NotificationManager.IMPORTANCE_HIGH);
            rico.setDescription("Rico answering “Hey Rico”, and checking in.");
            rico.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(rico);
        }
    }
}
