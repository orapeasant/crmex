package com.crmex.gateway;

import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Real MediaStore insert for "Save to Photos" (crmex.md §8.4). A plain file
 * write to app-private or even external storage does NOT appear in Gallery
 * apps without this (SAV-01) — that was the exact bug the spec calls out.
 *
 * - API 29+ (our test device, Android 10): MediaStore.Images.Media insert
 *   with RELATIVE_PATH under Pictures/, no extra permission needed
 *   (scoped storage).
 * - API <=28: requires WRITE_EXTERNAL_STORAGE (declared maxSdkVersion=28 in
 *   the manifest), writes into the public Pictures directory directly, then
 *   triggers MediaScannerConnection so it still shows up in Gallery.
 */
@CapacitorPlugin(
    name = "MediaSave",
    permissions = { @Permission(strings = { android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage") }
)
public class MediaSavePlugin extends Plugin {

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64 = call.getString("base64Data");
        String filename = call.getString("filename", "crmex_" + System.currentTimeMillis() + ".png");
        if (base64 == null) {
            call.reject("MISSING_BASE64_DATA");
            return;
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P /* API 28 */
            && getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            saveCall = call;
            requestPermissionForAlias("storage", call, "saveAfterPermission");
            return;
        }

        doSave(call, base64, filename);
    }

    private PluginCall saveCall;

    @PermissionCallback
    private void saveAfterPermission(PluginCall call) {
        if (getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("PERMISSION_DENIED"); // SAV-03
            return;
        }
        String base64 = call.getString("base64Data");
        String filename = call.getString("filename", "crmex_" + System.currentTimeMillis() + ".png");
        doSave(call, base64, filename);
    }

    private void doSave(PluginCall call, String base64, String filename) {
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("INVALID_BASE64", e);
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStoreQ(bytes, filename);
            } else {
                saveViaLegacyExternalStorage(bytes, filename);
            }
            JSObject result = new JSObject();
            result.put("saved", true);
            call.resolve(result);
        } catch (Exception e) {
            // SAV-05: out-of-storage or any other IO failure surfaces as a
            // clean rejection rather than a partial/corrupt file.
            call.reject("SAVE_FAILED", e);
        }
    }

    private void saveViaMediaStoreQ(byte[] bytes, String filename) throws Exception {
        Context ctx = getContext();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Leagentex");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri item = ctx.getContentResolver().insert(collection, values);
        if (item == null) throw new IllegalStateException("MediaStore insert returned null Uri");

        try (OutputStream out = ctx.getContentResolver().openOutputStream(item)) {
            if (out == null) throw new IllegalStateException("Could not open output stream for MediaStore item");
            out.write(bytes);
        }

        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        ctx.getContentResolver().update(item, values, null, null);
    }

    private void saveViaLegacyExternalStorage(byte[] bytes, String filename) throws Exception {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Leagentex");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Could not create Pictures/Leagentex directory");
        }
        File outFile = new File(dir, filename);
        try (FileOutputStream fos = new FileOutputStream(outFile)) {
            fos.write(bytes);
        }
        // Without this, pre-Q devices won't show the file in Gallery until a
        // reboot or manual scan — this is the other half of the SAV-01 bug.
        MediaScannerConnection.scanFile(getContext(), new String[] { outFile.getAbsolutePath() }, new String[] { "image/png" }, null);
    }
}
