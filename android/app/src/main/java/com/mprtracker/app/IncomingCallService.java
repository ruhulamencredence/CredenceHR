package com.mprtracker.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.Map;

// An incoming chat call (one-to-one or group) while the app is closed or in
// the background, started from the "call_incoming" push
// (LiveWakeMessagingService -> IncomingCall.show).
//
// A foreground service of type phoneCall, so Android treats it as a call:
//  - rings with the phone's own ringtone and vibrates (CallRinger), at the
//    ring volume, until it is answered, declined or taken away (45 s at most);
//  - its notification is a call notification (Answer / Decline) whose
//    full-screen intent opens IncomingCallActivity — the call screen over
//    the lock screen; with "Display over other apps" allowed the call screen
//    also opens while the phone is in use;
//  - "call_cancel" (the caller hung up, answered on another device, nobody
//    answered) stops it (IncomingCall.cancel).
// Where Android won't start it, IncomingCall falls back to the plain
// ringing notification it showed before.
public class IncomingCallService extends Service {

    static final String CHANNEL_ID = "incoming_call_screen";
    static final int NOTIFICATION_ID = 0x43A13000;
    static final long RING_MS = 45 * 1000;
    static final String[] KEYS = { "callId", "fromName", "kind", "declineKey", "group", "roomId", "title" };

    private static volatile Bundle current;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock cpuLock;

    // The call ringing right now (its push data), or null.
    static Bundle current() {
        return current;
    }

    static boolean start(Context context, Map<String, String> data) {
        Intent i = new Intent(context, IncomingCallService.class);
        for (String k : KEYS) {
            String v = data.get(k);
            if (v != null) i.putExtra(k, v);
        }
        try {
            ContextCompat.startForegroundService(context, i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // callId null = whatever is ringing.
    static void stopFor(Context context, String callId) {
        Bundle c = current;
        if (c == null) return;
        if (callId != null && !callId.equals(c.getString("callId"))) return;
        current = null;
        CallRinger.stop();
        IncomingCallActivity.closeFor(callId);
        try {
            context.stopService(new Intent(context, IncomingCallService.class));
        } catch (Exception ignored) {
            // already gone
        }
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Bundle data = intent != null && intent.getExtras() != null ? new Bundle(intent.getExtras()) : null;
        String callId = data != null ? data.getString("callId") : null;
        if (callId == null || callId.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            Notification n = build(this, data);
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
        } catch (Exception e) {
            // Not allowed here: the plain ringing notification instead.
            current = null;
            IncomingCall.showLegacy(this, toMap(data));
            stopSelf();
            return START_NOT_STICKY;
        }
        current = data;
        holdCpu();
        CallRinger.stop();
        CallRinger.start(this);
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(() -> stopFor(this, callId), RING_MS);
        // Phone in use and "Display over other apps" allowed: open the call
        // screen straight away (otherwise Android shows the call notification
        // at the top, and the call screen when the phone is locked / asleep).
        if (canDrawOverlays(this) && !MainActivity.isOnScreen()) {
            try {
                startActivity(IncomingCallActivity.intent(this));
            } catch (Exception ignored) {
                // the notification is there
            }
        }
        return START_NOT_STICKY;
    }

    static boolean canDrawOverlays(Context c) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(c);
    }

    private static Map<String, String> toMap(Bundle b) {
        java.util.HashMap<String, String> m = new java.util.HashMap<>();
        if (b != null) for (String k : KEYS) if (b.getString(k) != null) m.put(k, b.getString(k));
        return m;
    }

    static String title(Bundle d) {
        String from = d.getString("fromName");
        return from == null || from.isEmpty() ? "Someone" : from;
    }

    static String subtitle(Bundle d) {
        boolean video = "video".equals(d.getString("kind"));
        if ("1".equals(d.getString("group"))) {
            String t = d.getString("title");
            return (video ? "Group video call" : "Group audio call") + (t != null && !t.isEmpty() ? " · " + t : "");
        }
        return video ? "Video call · CredenceHR" : "Audio call · CredenceHR";
    }

    private static Notification build(Context ctx, Bundle d) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            // No sound / vibration on the channel: CallRinger rings (the
            // phone's ringtone, looping), whatever the phone did to the channel.
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Chat audio / video calls while the app is closed");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent screen = PendingIntent.getActivity(ctx, NOTIFICATION_ID, IncomingCallActivity.intent(ctx), piFlags);
        PendingIntent accept = PendingIntent.getActivity(ctx, NOTIFICATION_ID + 1, IncomingCall.openIntent(ctx, d, "accept"), piFlags);
        PendingIntent decline = PendingIntent.getBroadcast(ctx, NOTIFICATION_ID + 2, IncomingCall.declineIntent(ctx, d), piFlags);
        Person caller = new Person.Builder().setName(title(d)).setImportant(true).build();
        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(title(d))
            .setContentText(subtitle(d))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(screen)
            .setFullScreenIntent(screen, true)
            .setTimeoutAfter(RING_MS)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, accept))
            .build();
    }

    // Keep the CPU awake while ringing with the screen off.
    private void holdCpu() {
        try {
            if (cpuLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CredenceHR:ringing");
            }
            if (cpuLock != null && !cpuLock.isHeld()) cpuLock.acquire(RING_MS + 5000);
        } catch (Exception ignored) {
            // best effort
        }
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopFor(this, null);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        CallRinger.stop();
        current = null;
        IncomingCallActivity.closeFor(null);
        try {
            if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        } catch (Exception ignored) {
            // already released
        }
        super.onDestroy();
    }
}
