package com.mprtracker.app;

import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

// Rings an incoming chat call with the phone's OWN ringtone (the one set in
// the phone's Sound settings), looping, at the ring volume, and vibrates —
// like a normal phone call. Used by IncomingCallService (app closed / in the
// background) and by CallAudioPlugin.startRinging (the page is open).
//
// Follows the phone: Silent -> nothing; Vibrate -> vibration only; Do Not
// Disturb on (not "All") -> nothing. Playing it ourselves (not as the
// notification's sound) means it rings even where a phone (Xiaomi, Oppo,
// Vivo…) created the notification channel muted.
final class CallRinger {
    private CallRinger() {}

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static boolean on = false;
    private static final long[] PATTERN = { 0, 900, 700 };

    static synchronized boolean isRinging() {
        return on;
    }

    static synchronized void start(Context context) {
        if (on) return;
        Context app = context.getApplicationContext();
        on = true;
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        int mode = am != null ? am.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
        if (mode == AudioManager.RINGER_MODE_SILENT || dndBlocks(app)) return;
        if (mode == AudioManager.RINGER_MODE_NORMAL) playTone(app);
        vibrate(app);
    }

    static synchronized void stop() {
        on = false;
        try {
            if (player != null) {
                player.stop();
                player.release();
            }
        } catch (Exception ignored) {
            // already stopped
        }
        player = null;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
            // nothing to cancel
        }
        vibrator = null;
    }

    // Volume key pressed while ringing: quiet, but the call keeps ringing on screen.
    static synchronized void silence() {
        boolean was = on;
        stop();
        on = was;
    }

    private static boolean dndBlocks(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
            int f = nm.getCurrentInterruptionFilter();
            return f != NotificationManager.INTERRUPTION_FILTER_ALL && f != NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
        } catch (Exception e) {
            return false;
        }
    }

    private static Uri ringtone(Context c) {
        Uri u = null;
        try {
            u = RingtoneManager.getActualDefaultRingtoneUri(c, RingtoneManager.TYPE_RINGTONE);
        } catch (Exception ignored) {
            // no access: the default below
        }
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return u;
    }

    private static void playTone(Context c) {
        Uri u = ringtone(c);
        if (u == null) return;
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            mp.setDataSource(c, u);
            mp.setLooping(true);
            mp.setOnPreparedListener(MediaPlayer::start);
            mp.setOnErrorListener((p, what, extra) -> true);
            mp.prepareAsync();
            player = mp;
        } catch (Exception e) {
            // A ringtone the app can't read (e.g. on a removed SD card): the
            // phone's built-in default instead.
            try {
                MediaPlayer mp = new MediaPlayer();
                mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
                mp.setDataSource(c, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE));
                mp.setLooping(true);
                mp.setOnPreparedListener(MediaPlayer::start);
                mp.setOnErrorListener((p, what, extra) -> true);
                mp.prepareAsync();
                player = mp;
            } catch (Exception ignored) {
                player = null;
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static void vibrate(Context c) {
        try {
            Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                v = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                v = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (v == null || !v.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build();
                v.vibrate(VibrationEffect.createWaveform(PATTERN, 0), attrs);
            } else {
                v.vibrate(PATTERN, 0);
            }
            vibrator = v;
        } catch (Exception ignored) {
            // no vibration
        }
    }
}
