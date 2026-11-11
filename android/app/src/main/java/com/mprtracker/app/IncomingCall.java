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
import android.os.Bundle;
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
// The server (CallRoutes.ts, GroupCallRoutes.ts) sends a high-priority
// "call_incoming" push (LiveWakeMessagingService) as well as ringing the open
// app. When the app isn't on screen, show() starts IncomingCallService: the
// phone's own ringtone, looping (CallRinger), a call notification, and the
// full-screen call screen over the lock screen (IncomingCallActivity). Where
// Android won't start that service, showLegacy() is the plain ringing
// notification used before (its sound comes from the notification channel).
//
//   Accept  -> opens the app (MainActivity) with the call; the page connects,
//              the server announces the ringing call again and CallLayer.tsx
//              answers it at once (CallAudioPlugin.takePendingCall); a group
//              call is joined (GroupCallLayer.tsx).
//   Decline -> one-to-one: POST /api/calls/push-decline with the one-call key
//              from the push — the app doesn't have to open. Group: just stops
//              ringing on this phone.
//
// A "call_cancel" push (caller hung up, answered on another device, no
// answer, group call over) takes it away again; it also goes by itself after 45 s.
public final class IncomingCall {

    static final String CHANNEL_ID = "incoming_calls";
    static final String EXTRA_CALL_ID = "credence_call_id";
    static final String EXTRA_CALL_ACTION = "credence_call_action";
    static final String EXTRA_GROUP = "credence_call_group";
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
        if (IncomingCallService.start(context, data)) return;
        showLegacy(context, data);
    }

    static void showLegacy(Context context, Map<String, String> data) {
        String callId = data.get("callId");
        if (callId == null || callId.isEmpty()) return;
        String from = data.get("fromName");
        if (from == null || from.isEmpty()) from = "Someone";

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
        Bundle d = new Bundle();
        for (Map.Entry<String, String> e : data.entrySet()) d.putString(e.getKey(), e.getValue());
        PendingIntent open = PendingIntent.getActivity(context, id, openIntent(context, d, "open"), flags);
        PendingIntent accept = PendingIntent.getActivity(context, id + 1, openIntent(context, d, "accept"), flags);
        PendingIntent decline = PendingIntent.getBroadcast(context, id + 2, declineIntent(context, d), flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(from)
            .setContentText(IncomingCallService.subtitle(d))
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
        IncomingCallService.stopFor(context, callId);
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(notificationId(callId));
    }

    // Opens the app on the call (MainActivity.handleCallIntent). A group
    // call carries what the page needs to join it.
    static Intent openIntent(Context context, Bundle d, String action) {
        String callId = d.getString("callId");
        Intent i = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setAction("credence.call." + action + "." + callId)
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_CALL_ACTION, action);
        if ("1".equals(d.getString("group"))) {
            i.putExtra(EXTRA_GROUP, true)
                .putExtra("roomId", d.getString("roomId"))
                .putExtra("title", d.getString("title"))
                .putExtra("kind", d.getString("kind"))
                .putExtra("fromName", d.getString("fromName"));
        }
        return i;
    }

    static Intent declineIntent(Context context, Bundle d) {
        return new Intent(context, DeclineReceiver.class)
            .putExtra(EXTRA_CALL_ID, d.getString("callId"))
            .putExtra("key", d.getString("declineKey"));
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
