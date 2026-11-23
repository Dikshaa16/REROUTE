package com.reroute.app;

import android.animation.ValueAnimator;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Rico popping up over whatever app is on screen when "Hey Rico" is heard with Reroute closed, as a voice assistant
 * does: a card at the bottom with Rico waving and a voice line moving beside "I'm here!", then Reroute opens on him
 * talking, with no notification to tap. Only with "Pop up over other apps" on in Me and Android's "Display over other
 * apps" allowed for Reroute, and never over the lock screen (the notification stays for those). A window of the
 * app's own on screen is also what lets Android open Reroute from the background (Android 15 and later), so the
 * card shows first.
 */
final class RicoPopUp {

    /** The window's title, so it can be found (dumpsys window, the parity test). */
    static final String TITLE = "RicoPopUp";
    /** How long Rico shows before Reroute opens, and the longest he stays if it doesn't. */
    private static final long OPEN_AFTER_MS = 900;
    private static final long GIVE_UP_MS = 6000;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static View shown;
    private static ValueAnimator line;

    private RicoPopUp() {}

    /** The traveller wants the pop-up (Me) and Android lets Reroute draw over other apps. */
    static boolean wanted(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(RicoWakePlugin.PREFS, Context.MODE_PRIVATE);
        return prefs.getBoolean(RicoWakePlugin.POP_UP, false) && Settings.canDrawOverlays(context);
    }

    /** Pops Rico up and opens Reroute on him; false when it can't (not wanted, or the phone is locked). */
    static boolean show(Context context) {
        Context app = context.getApplicationContext();
        if (!wanted(app)) return false;
        KeyguardManager keyguard = app.getSystemService(KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked()) return false;
        WindowManager windows = app.getSystemService(WindowManager.class);
        if (windows == null) return false;
        hide(app);
        View card = card(app);
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.BOTTOM;
        params.setTitle(TITLE);
        try {
            windows.addView(card, params);
        } catch (RuntimeException e) {
            // Android took the permission back a moment ago: the notification instead.
            return false;
        }
        shown = card;
        card.setOnClickListener(v -> open(app));
        // Up from the bottom with a bounce, Rico a beat behind.
        card.setTranslationY(dp(app, 220));
        card.animate().translationY(0).setInterpolator(new OvershootInterpolator(1.1f)).setDuration(380).start();
        main.postDelayed(() -> open(app), OPEN_AFTER_MS);
        main.postDelayed(() -> hide(app), GIVE_UP_MS);
        return true;
    }

    /** Reroute on screen, on Rico talking (RicoWakePlugin hands the page the wake). */
    private static void open(Context app) {
        if (shown == null) return;
        Intent intent = new Intent(app, MainActivity.class)
            .putExtra(RicoListener.EXTRA_RICO, "wake")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            app.startActivity(intent);
        } catch (RuntimeException e) {
            // Android wouldn't open it from here after all: the notification, as without the pop-up.
            hide(app);
            RicoListener.notifyWake(app);
        }
    }

    /** Gone: Reroute is on screen (MainActivity), or it never came. */
    static void hide(Context context) {
        main.removeCallbacksAndMessages(null);
        if (line != null) line.cancel();
        line = null;
        View view = shown;
        shown = null;
        if (view == null) return;
        WindowManager windows = context.getApplicationContext().getSystemService(WindowManager.class);
        try {
            if (windows != null) windows.removeView(view);
        } catch (RuntimeException e) {
            // Already gone.
        }
    }

    private static View card(Context app) {
        boolean dark = (app.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int surface = dark ? Color.rgb(0x1c, 0x22, 0x1e) : Color.WHITE;
        int ink = dark ? Color.rgb(0xec, 0xf0, 0xec) : Color.rgb(0x17, 0x1c, 0x19);

        LinearLayout row = new LinearLayout(app);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(app, 16);
        row.setPadding(pad, pad, pad, pad + dp(app, 8));
        GradientDrawable back = new GradientDrawable();
        back.setColor(surface);
        float r = dp(app, 28);
        back.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
        row.setBackground(back);
        row.setElevation(dp(app, 12));
        row.setContentDescription("Rico: I'm here! Opening Reroute.");

        ImageView rico = new ImageView(app);
        rico.setImageResource(R.drawable.rico_wave);
        rico.setScaleX(0.6f);
        rico.setScaleY(0.6f);
        rico.animate().scaleX(1f).scaleY(1f).setStartDelay(120).setInterpolator(new OvershootInterpolator(2.4f)).setDuration(420).start();
        row.addView(rico, new LinearLayout.LayoutParams(dp(app, 84), dp(app, 84)));

        LinearLayout words = new LinearLayout(app);
        words.setOrientation(LinearLayout.VERTICAL);
        words.setPadding(dp(app, 12), 0, 0, 0);
        TextView name = new TextView(app);
        name.setText("I'm here!");
        name.setTextColor(ink);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        name.setTypeface(name.getTypeface(), android.graphics.Typeface.BOLD);
        words.addView(name);
        VoiceLine wave = new VoiceLine(app);
        words.addView(wave, new LinearLayout.LayoutParams(dp(app, 148), dp(app, 36)));
        row.addView(words, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        line = ValueAnimator.ofFloat(0f, 1f);
        line.setDuration(1100);
        line.setRepeatCount(ValueAnimator.INFINITE);
        line.setInterpolator(new LinearInterpolator());
        line.addUpdateListener(a -> wave.at((float) a.getAnimatedValue()));
        line.start();
        return row;
    }

    private static int dp(Context context, float value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.getResources().getDisplayMetrics()));
    }

    /** Rico's voice line: five rounded bars rising and falling one after another, in Reroute's greens. */
    private static final class VoiceLine extends View {

        private static final int[] COLORS = { 0xFF0B7A4B, 0xFF34B27B, 0xFF0B7A4B, 0xFF34B27B, 0xFF0B7A4B };
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF bar = new RectF();
        private float t;

        VoiceLine(Context context) {
            super(context);
        }

        void at(float t) {
            this.t = t;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth();
            float h = getHeight();
            float gap = w / 5f;
            float width = gap * 0.42f;
            for (int i = 0; i < 5; i++) {
                double phase = 2 * Math.PI * (t - i * 0.14);
                float level = 0.28f + 0.72f * (float) (0.5 + 0.5 * Math.sin(phase));
                float tall = Math.max(width, h * level);
                float x = gap * i + (gap - width) / 2f;
                bar.set(x, (h - tall) / 2f, x + width, (h + tall) / 2f);
                paint.setColor(COLORS[i]);
                canvas.drawRoundRect(bar, width / 2f, width / 2f, paint);
            }
        }
    }
}
