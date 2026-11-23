package com.reroute.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.ref.WeakReference;

/**
 * "Hey Rico" for the page (src/native/wake.ts): turning it on or off (only while Reroute is open, or even when it's
 * closed), downloading Rico's ear the first time, letting go of the microphone while Rico talks out loud, and handing
 * the page each "Hey Rico", heard now or tapped in Rico's notification.
 */
@CapacitorPlugin(name = "RicoWake", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public class RicoWakePlugin extends Plugin {

    static final String PREFS = "rico_wake";
    /** Rico pops up over other apps on "Hey Rico" (RicoPopUp), with Android's "Display over other apps" allowed. */
    static final String POP_UP = "popUp";
    private static WeakReference<RicoWakePlugin> current = new WeakReference<>(null);

    @Override
    public void load() {
        current = new WeakReference<>(this);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean enabled() {
        return prefs().getBoolean("enabled", false);
    }

    private boolean background() {
        return prefs().getBoolean("background", false);
    }

    /** Hands "Hey Rico" to the page when it's on screen and listening; false otherwise. */
    static boolean deliverWake() {
        RicoWakePlugin plugin = current.get();
        if (plugin == null || !MainActivity.onScreen || !plugin.hasListeners("wake")) return false;
        JSObject from = new JSObject();
        from.put("from", "voice");
        plugin.notifyListeners("wake", from);
        return true;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("modelReady", RicoModel.ready(getContext()));
        out.put("enabled", enabled());
        out.put("background", background());
        out.put("listening", RicoListener.isRunning(getContext()));
        out.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        boolean overlay = Settings.canDrawOverlays(getContext());
        out.put("popUp", prefs().getBoolean(POP_UP, false) && overlay);
        out.put("overlay", overlay);
        call.resolve(out);
    }

    /** Pop up over other apps, or not. On, without Android's "Display over other apps" allowed, Android's page for it
     *  opens (the page asks again for the status when Reroute is back on screen). */
    @PluginMethod
    public void popUp(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        prefs().edit().putBoolean(POP_UP, on).apply();
        JSObject out = new JSObject();
        boolean asked = on && !Settings.canDrawOverlays(getContext());
        if (asked) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(allow);
        }
        out.put("asked", asked);
        call.resolve(out);
    }

    /** Rico's ear, the first time (about 38 MB): progress comes as "download" events. */
    @PluginMethod
    public void download(PluginCall call) {
        new Thread(() -> {
            try {
                RicoModel.download(getContext(), percent -> {
                    JSObject at = new JSObject();
                    at.put("percent", percent);
                    notifyListeners("download", at);
                });
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't download Rico's ear. Check the connection and try again.", "DOWNLOAD", e);
            }
        }, "rico-ear-download").start();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else call.reject("Rico needs the microphone to hear “Hey Rico”.", "MICROPHONE");
    }

    private void begin(PluginCall call) {
        if (!RicoModel.ready(getContext())) {
            call.reject("Rico's ear isn't downloaded yet.", "NO_MODEL");
            return;
        }
        prefs().edit().putBoolean("enabled", true).putBoolean("background", Boolean.TRUE.equals(call.getBoolean("background", false))).apply();
        send(RicoListener.ACTION_START, true);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("enabled", false).apply();
        if (RicoListener.isRunning(getContext())) send(RicoListener.ACTION_STOP, false);
        call.resolve();
    }

    /** Rico talks out loud: the listener lets go of the microphone for the page. */
    @PluginMethod
    public void pause(PluginCall call) {
        if (RicoListener.isRunning(getContext())) send(RicoListener.ACTION_PAUSE, false);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (RicoListener.isRunning(getContext())) send(RicoListener.ACTION_RESUME, false);
        call.resolve();
    }

    /** Whether the app was opened from Rico's notification, once: the page opens him listening. */
    @PluginMethod
    public void launchedByRico(PluginCall call) {
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        boolean byRico = intent != null && intent.hasExtra(RicoListener.EXTRA_RICO);
        if (byRico) intent.removeExtra(RicoListener.EXTRA_RICO);
        JSObject out = new JSObject();
        out.put("wake", byRico);
        call.resolve(out);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !intent.hasExtra(RicoListener.EXTRA_RICO)) return;
        intent.removeExtra(RicoListener.EXTRA_RICO);
        JSObject from = new JSObject();
        from.put("from", "notification");
        notifyListeners("wake", from);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Back on screen: listening again (also after the phone restarted, when Android won't start it on its own).
        if (enabled() && RicoModel.ready(getContext()) && getPermissionState("microphone") == PermissionState.GRANTED && !RicoListener.isRunning(getContext())) {
            send(RicoListener.ACTION_START, true);
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // "Only while Reroute is open": it stops with the screen.
        if (enabled() && !background() && RicoListener.isRunning(getContext())) send(RicoListener.ACTION_STOP, false);
    }

    private void send(String action, boolean foreground) {
        Intent intent = new Intent(getContext(), RicoListener.class).setAction(action);
        try {
            if (foreground) ContextCompat.startForegroundService(getContext(), intent);
            else getContext().startService(intent);
        } catch (RuntimeException e) {
            // Android won't start a service from the background: the next resume does it.
        }
    }
}
