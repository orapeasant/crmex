package com.crmex.gateway;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * crmex.md §10.2/AND-08: OEM battery managers (Huawei/EMUI worst of all, and
 * our test device is a Huawei P30 Pro) kill background processes far more
 * aggressively than stock Android's Doze. A foreground service resists Doze
 * but does not survive an OEM battery-manager kill. This plugin lets the app
 * detect the standard Android-level "not ignoring battery optimizations"
 * state and prompt the user into the standard AOSP exemption dialog.
 *
 * IMPORTANT — what this does NOT do: there is no public API to detect or
 * open Huawei's separate "Protected apps" / "Launch" manager screen; that is
 * a vendor-specific settings screen with no stable Intent action across EMUI
 * versions. The most this app can do generically is (a) request the
 * standard Android battery-optimization exemption via
 * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, which does help even on EMUI, and
 * (b) tell the user, in copy, to also check their phone's battery/app
 * launch settings — a manual step that must stay documented rather than
 * automated (see android/README.md, "Huawei/EMUI").
 */
@CapacitorPlugin(name = "BatteryWhitelist")
public class BatteryWhitelistPlugin extends Plugin {

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("ignoring", ignoring);
        call.resolve(result);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
