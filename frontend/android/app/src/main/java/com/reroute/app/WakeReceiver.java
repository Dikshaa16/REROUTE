package com.reroute.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Hey Rico", from Rico's ear (RicoListener, in its own process) to the app's: Reroute on screen opens Rico at once,
 * otherwise he pops up as a notification (RicoListener.woke).
 */
public class WakeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        RicoListener.woke(context);
    }
}
