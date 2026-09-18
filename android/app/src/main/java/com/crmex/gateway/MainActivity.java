package com.crmex.gateway;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SimRegionPlugin.class);
        registerPlugin(BackgroundEnginePlugin.class);
        registerPlugin(BatteryWhitelistPlugin.class);
        registerPlugin(MediaSavePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
