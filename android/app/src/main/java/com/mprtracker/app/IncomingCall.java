package com.mprtracker.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.CapConfig;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

// A chat call reaching a phone whose app is closed or in the background.
//
// The server (CallRoutes.ts) sends a high-priority "call_incoming" push
// (LiveWakeMessagingService) as well as ringing the open app. When the app
// isn't on screen this shows the phone's own incoming-call screen: full
// screen over the lock screen where Android allows it, otherwise a heads-up
// notification, ringing (the phone's ringtone, repeating) and vibrating,
// with Accept and Decline.
//
//   Accept  -> opens the app (MainActivity) with the call id; the page
//              connects, the server announces the ringing call again and
//              CallLayer.tsx answers it at once (CallAudioPlugin.takePendingCall).
//   Decline -> POST /api/calls/push-decline with the one-call key from the
//              push — the app doesn't have to open.
//   Tapping the notification itself opens the app on the ringing call.
//
// A "call_cancel" push (caller hung up, answered on another device, no
// answer) takes it away again; it also goes by itself after 45 s.
public final class IncomingCall {

    static final String CHANNEL_ID = "incoming_calls";
    static final String EXTRA_CALL_ID = "credence_call_id";
    static final String EXTRA_CALL_ACTION = "credence_call_action";
    private static final long RING_MS = 45 * 1000;

    private IncomingCall() {}

    private static int notificationId(String callId) {
        return 0x43A11000 + (callId.hashCode() & 0xFFF);
    }

    static void show(Context context, Map<String, String> data) {
        String callId = data.get("callId");
        if (callId == null || callId.isEmpty()) return;
        // The page is on screen: it rings by itself (CallLayer.tsx).
        if (MainActivity.isOnScreen()) return;
        String from = data.get("fromName");
        if (from == null || from.isEmpty()) from = "Someone";
        boolean video = "video".equals(data.get("kind"));

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Chat audio / video calls while the app is closed");
            ch.setSound(ring, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        int id = notificationId(callId);
        PendingIntent open = PendingIntent.getActivity(context, id, openIntent(context, callId, "open"), flags);
        PendingIntent accept = PendingIntent.getActivity(context, id + 1, openIntent(context, callId, "accept"), flags);
        Intent declineIntent = new Intent(context, DeclineReceiver.class)
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra("key", data.get("declineKey"));
        PendingIntent decline = PendingIntent.getBroadcast(context, id + 2, declineIntent, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(from)
            .setContentText(video ? "Incoming video call · CredenceHR" : "Incoming audio call · CredenceHR")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setSound(ring)
            .setVibrate(new long[] { 0, 800, 600, 800, 600 })
            .setTimeoutAfter(RING_MS)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decline)
            .addAction(android.R.drawable.sym_action_call, "Accept", accept);
        Notification n = b.build();
        // Keep ringing (not just one sound) until it is answered or taken away.
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            nm.notify(id, n);
        } catch (SecurityException e) {
            // Notifications are turned off for the app: nothing to show.
        }
    }

    static void cancel(Context context, String callId) {
        if (callId == null) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(notificationId(callId));
    }

    private static Intent openIntent(Context context, String callId, String action) {
        return new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setAction("credence.call." + action + "." + callId)
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_CALL_ACTION, action);
    }

    // The server the app talks to: the one tracking saved (the page's real
    // address), else the one the APK was built for.
    static String serverBase(Context context) {
        SharedPreferences p = context.getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE);
        String base = p.getString(LiveTrackingService.KEY_BASE, null);
        if (base == null || base.isEmpty()) {
            try {
                base = CapConfig.loadDefault(context).getServerUrl();
            } catch (Exception ignore) {
                base = null;
            }
        }
        if (base != null && base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base;
    }

    // Decline from the notification without opening the app.
    public static class DeclineReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            final String callId = intent.getStringExtra(EXTRA_CALL_ID);
            final String key = intent.getStringExtra("key");
            cancel(context, callId);
            final String base = serverBase(context);
            if (callId == null || key == null || base == null) return;
            final PendingResult pending = goAsync();
            new Thread(() -> {
                HttpURLConnection c = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("callId", callId);
                    body.put("key", key);
                    c = (HttpURLConnection) new URL(base + "/api/calls/push-decline").openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                    c.getResponseCode();
                } catch (Exception ignore) {
                    // No network: the caller hears it ring out instead.
                } finally {
                    if (c != null) c.disconnect();
                    pending.finish();
                }
            }).start();
        }
    }
}
