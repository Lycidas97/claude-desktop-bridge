package com.localbridge.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground;

    public static boolean isForeground() {
        return foreground;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(BridgeUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
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
