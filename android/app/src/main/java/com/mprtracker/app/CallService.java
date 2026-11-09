package com.mprtracker.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

// "Ongoing call" while a chat call is on (CallAudioPlugin start -> stop).
//
// Without it, leaving the app mid-call (Home, another app, screen off)
// tells Android nothing is happening: Android 11+ freezes the app's process
// within seconds and cuts the microphone of an app in the background, so the
// connection to the server goes quiet and the call is ended. A foreground
// service of type microphone (and camera for a video call) keeps the
// process, the microphone and the connection running, like the phone's own
// calls. Its notification returns to the call when tapped and has Hang up.
public class CallService extends Service {

    static final String CHANNEL_ID = "ongoing_calls";
    private static final int NOTIFICATION_ID = 0x43A12000;
    private static final String EXTRA_VIDEO = "video";
    private static final String ACTION_HANGUP = "credence.call.hangup";

    private PowerManager.WakeLock cpuLock;

    static void start(Context context, boolean video) {
        Intent i = new Intent(context, CallService.class).putExtra(EXTRA_VIDEO, video);
        try {
            ContextCompat.startForegroundService(context, i);
        } catch (Exception ignored) {
            // Not allowed right now (app not on screen): the call still runs
            // while the app stays open.
        }
    }

    static void stop(Context context) {
        try {
            context.stopService(new Intent(context, CallService.class));
        } catch (Exception ignored) {
            // already gone
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while a chat call is on, so it keeps going outside the app");
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent back = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, NOTIFICATION_ID, back, piFlags);
        PendingIntent hangup = PendingIntent.getBroadcast(this, NOTIFICATION_ID + 1, new Intent(this, HangupReceiver.class).setAction(ACTION_HANGUP), piFlags);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_outgoing)
            .setContentTitle(video ? "Video call · CredenceHR" : "Audio call · CredenceHR")
            .setContentText("Call in progress — tap to return")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", hangup)
            .build();

        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video && granted(Manifest.permission.CAMERA)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        try {
            if (type != 0) ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Neither microphone nor camera allowed: nothing to keep alive.
                stopSelf();
                return START_NOT_STICKY;
            } else startForeground(NOTIFICATION_ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        holdCpu();
        return START_NOT_STICKY;
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    // Keep the CPU awake with the screen off (sound and connection keep going).
    private void holdCpu() {
        try {
            if (cpuLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CredenceHR:ongoingCall");
            }
            if (cpuLock != null && !cpuLock.isHeld()) cpuLock.acquire(4 * 60 * 60 * 1000L);
        } catch (Exception ignored) {
            // best effort
        }
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15+ time limits do not apply to microphone / camera, but end
        // cleanly if the system ever asks.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try {
            if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        } catch (Exception ignored) {
            // already released
        }
        super.onDestroy();
    }

    // Hang up from the notification: the page ends the call (CallLayer /
    // GroupCallLayer listen through CallAudioPlugin "callHangup").
    public static class HangupReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            CallAudioPlugin.hangupFromNotification(context);
        }
    }
}
