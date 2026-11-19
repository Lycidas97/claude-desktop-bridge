package com.localbridge.mobile;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground;
    private boolean restoringActivity;

    public static boolean isForeground() {
        return foreground;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(BridgeUpdaterPlugin.class);
        registerPlugin(BridgeFilesPlugin.class);
        registerPlugin(BridgeIncomingFilePlugin.class);
        restoringActivity = savedInstanceState != null;
        super.onCreate(savedInstanceState);
        restoringActivity = false;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // BridgeActivity replays getIntent() while rebuilding the WebView.
        if (restoringActivity && BridgeIncomingFilePlugin.accepts(intent)) return;
        super.onNewIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        foreground = true;
    }

    @Override
    public void onStop() {
        foreground = false;
        super.onStop();
    }
}
