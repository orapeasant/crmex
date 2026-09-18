package com.crmex.gateway;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS-facing control surface for {@link BackgroundEngineService}. The WebView
 * calls start() right before handing a batch to the Node process over the
 * capacitor-nodejs bridge, and stop() when `wa:batch-done` arrives
 * (crmex.md §9.2, §10.1; SEND-11, AND-01, AND-02).
 */
@CapacitorPlugin(
    name = "BackgroundEngine",
    permissions = { @Permission(strings = { android.Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class BackgroundEnginePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "startAfterPermission");
            return;
        }
        startService();
        call.resolve();
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        // AND-05: even if the user denies POST_NOTIFICATIONS, the service
        // still starts and sends still proceed — the only loss is
        // visibility, which is surfaced to the user by the caller checking
        // this resolved flag, not a hard failure.
        JSObject result = new JSObject();
        result.put("notificationsGranted", getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED);
        startService();
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), BackgroundEngineService.class);
        intent.setAction(BackgroundEngineService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    private void startService() {
        Intent intent = new Intent(getContext(), BackgroundEngineService.class);
        intent.setAction(BackgroundEngineService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }
}
