package com.reroute.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

/**
 * Reroute's web app in Capacitor's web view. Additions: Google's authorization screen (Calendar access, and the
 * code for the server) reports back through onActivityResult; pushed alerts (RerouteMessagingPlugin and Service);
 * and debug builds may reach the local stack, whose certificate is self-signed (DevNetwork; release builds contain
 * none of that).
 */
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    /** Reroute is on screen: a pushed alert goes to the page, which shows it itself (RerouteMessagingService). */
    static volatile boolean onScreen = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RerouteMessagingPlugin.class);
        registerPlugin(RicoWakePlugin.class);
        super.onCreate(savedInstanceState);
        DevNetwork.install(getBridge());
    }

    /**
     * As a browser does for a tab in the background: the page learns it's hidden (document.visibilityState), so the web
     * app's alerts become phone notifications. JavaScript keeps running; only animations and the like pause.
     */
    @Override
    public void onPause() {
        onScreen = false;
        super.onPause();
        if (getBridge() != null) getBridge().getWebView().onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null) getBridge().getWebView().onResume();
        onScreen = true;
        // Rico's pop-up over other apps has done its job.
        RicoPopUp.hide(this);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN || requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) return;
        PluginHandle handle = getBridge().getPlugin("SocialLogin");
        Plugin plugin = handle == null ? null : handle.getInstance();
        if (plugin instanceof SocialLoginPlugin) ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }

    /** Required by the sign-in plugin to show that onActivityResult above passes Google's answer on. */
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
