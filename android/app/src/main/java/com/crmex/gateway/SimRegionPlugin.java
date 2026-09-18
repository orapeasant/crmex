package com.crmex.gateway;

import android.telephony.TelephonyManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small custom plugin wrapping TelephonyManager.getSimCountryIso() — there is
 * no first-party Capacitor API for this (crmex.md §7.2, §14 open item). The
 * result is only ever used as a *default* region for phone normalization;
 * the user can override it, and shared-ui's regionResolver() falls back to
 * device locale (via @capacitor/device) if this returns null (PHN-08),
 * which happens on devices with no SIM, in airplane mode, or on some
 * dual-SIM / MVNO configurations that don't populate this field.
 */
@CapacitorPlugin(name = "SimRegion")
public class SimRegionPlugin extends Plugin {

    @PluginMethod
    public void getSimCountryIso(PluginCall call) {
        JSObject result = new JSObject();
        try {
            TelephonyManager tm = (TelephonyManager) getContext().getSystemService(android.content.Context.TELEPHONY_SERVICE);
            String iso = tm != null ? tm.getSimCountryIso() : null;
            if (iso != null && !iso.isEmpty()) {
                result.put("region", iso.toUpperCase(java.util.Locale.ROOT));
            } else {
                result.put("region", (String) null);
            }
        } catch (Exception e) {
            // Never let a platform quirk here crash the caller — this is a
            // best-effort default, not a hard requirement.
            result.put("region", (String) null);
        }
        call.resolve(result);
    }
}
