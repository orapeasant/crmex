package com.crmex.gateway;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the process resistant to Doze/app-standby
 * while a WhatsApp send batch is running (crmex.md §10.1, §10.2).
 *
 * What this service is NOT: it does not host the Baileys socket or any send
 * logic itself. That lives entirely in the embedded Node process managed by
 * capacitor-nodejs; this service's only job is the Android-required
 * foreground lifecycle + notification, started when a batch begins and
 * stopped when the queue drains (AND-01, AND-02, SEND-11).
 *
 * A foreground service RESISTS Doze/standby, it does not make the process
 * unkillable (crmex.md §10.2) — Huawei/EMUI in particular can still kill it.
 * See BatteryWhitelistHelper for the user-facing mitigation (AND-08).
 */
public class BackgroundEngineService extends Service {

    public static final String ACTION_START = "com.crmex.gateway.action.START_BATCH";
    public static final String ACTION_STOP = "com.crmex.gateway.action.STOP_BATCH";
    public static final String CHANNEL_ID = "crmex_send_batch";
    private static final int NOTIFICATION_ID = 4201;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannelIfNeeded();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification("Sending messages…");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        // START_NOT_STICKY: if Android kills this service, do not have the
        // OS respawn it automatically with a null intent — resumption is
        // driven by the outbox on next app launch (crmex.md §9.2), not by a
        // service auto-restart racing the WebView's own resume logic.
        return START_NOT_STICKY;
    }

    /**
     * Android 14+ calls this when a dataSync foreground service hits the
     * ~6-hour/24h cap (AND-07). The batch is NOT lost: every unsent
     * recipient is still sitting in the `outbox` table (crmex.md §9.2), so
     * stopping cleanly here and letting the user resume (or auto-resuming
     * next time the app is foregrounded) is correct and sufficient.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopForeground(true);
        stopSelf();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // not a bound service — started/stopped via intents from the plugin bridge
    }

    private Notification buildNotification(String text) {
        Intent contentIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            contentIntent,
            PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Leagentex")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build();
    }

    private void createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "WhatsApp send progress",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows progress while a WhatsApp batch is sending.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
