package com.mprtracker.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

// Call sound for chat calls (CallLayer.tsx, via src/lib/callAudio.ts).
// The WebView plays a WebRTC call on the loudspeaker unless the phone is put
// in "in a call" mode: start() does that and routes the sound to the ear
// speaker (earpiece) — or the loudspeaker for a video call — and turns the
// screen off while the phone is held to the ear (proximity sensor), like the
// phone's own dialer. setSpeaker() switches between the two; stop() puts
// everything back when the call ends. While a call is on, CallService keeps
// it running when the app is left (Home, another app, screen off).
@CapacitorPlugin(name = "CallAudio")
public class CallAudioPlugin extends Plugin {

    // A call answered / opened from the incoming-call notification
    // (IncomingCall.java -> MainActivity), waiting for the page to take it.
    private static String pendingCallId;
    private static String pendingAction;
    private static JSObject pendingGroup;
    private static long pendingAt;
    private static CallAudioPlugin instance;

    // group: { roomId, title, kind } for a group call (GroupCallLayer.tsx), else null.
    static void setPendingCall(String callId, String action, JSObject group) {
        pendingCallId = callId;
        pendingAction = action;
        pendingGroup = group;
        pendingAt = System.currentTimeMillis();
        CallAudioPlugin p = instance;
        if (p != null) {
            JSObject d = new JSObject();
            d.put("callId", callId);
            d.put("action", action);
            if (group != null) d.put("group", group);
            p.notifyListeners("callAction", d);
        }
    }

    @Override
    public void load() {
        instance = this;
    }

    // { callId, action: 'accept' | 'open', group? } once, or {} when there is
    // none (older than a minute is stale: that call has ended by now).
    // { group: true } takes only a group call, otherwise only a one-to-one
    // call — CallLayer and GroupCallLayer each take their own.
    @PluginMethod
    public void takePendingCall(PluginCall call) {
        boolean wantGroup = Boolean.TRUE.equals(call.getBoolean("group", false));
        JSObject r = new JSObject();
        if (pendingCallId != null && (pendingGroup != null) == wantGroup) {
            if (System.currentTimeMillis() - pendingAt < 60 * 1000) {
                r.put("callId", pendingCallId);
                r.put("action", pendingAction);
                if (pendingGroup != null) r.put("group", pendingGroup);
            }
            pendingCallId = null;
            pendingAction = null;
            pendingGroup = null;
        }
        call.resolve(r);
    }

    // The page rings (app open): the phone's own ringtone and vibration
    // instead of the page's beeps (CallRinger: follows Silent / Vibrate / DND).
    @PluginMethod
    public void startRinging(PluginCall call) {
        CallRinger.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopRinging(PluginCall call) {
        // Not while the phone's own call screen is ringing for a call.
        if (IncomingCallService.current() == null) CallRinger.stop();
        call.resolve();
    }

    // What a phone needs for calls to ring with the app closed (Chat ->
    // "Calls on this phone"): notifications allowed, the full-screen call
    // screen allowed (Android 14+), "Display over other apps" (call screen
    // while the phone is in use) and no battery optimisation.
    @PluginMethod
    public void getCallSetup(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        r.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
        boolean full = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            full = nm == null || nm.canUseFullScreenIntent();
        }
        r.put("fullScreen", full);
        r.put("overlay", IncomingCallService.canDrawOverlays(c));
        boolean battery = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            battery = pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
        }
        r.put("battery", battery);
        call.resolve(r);
    }

    // which: notifications | fullScreen | overlay | battery — that setting's page.
    @PluginMethod
    public void openCallSetting(PluginCall call) {
        Context c = getContext();
        String which = call.getString("which", "");
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        Intent i;
        if ("notifications".equals(which) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
        } else if ("fullScreen".equals(which) && Build.VERSION.SDK_INT >= 34) {
            i = new Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT", pkg);
        } else if ("overlay".equals(which) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg);
        } else if ("battery".equals(which) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg);
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (Exception e) {
            Intent app = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                c.startActivity(app);
            } catch (Exception ignored) {
                // no settings app
            }
        }
        call.resolve();
    }

    // A video call is on (start with video .. stop): leaving the app then
    // goes to picture-in-picture (MainActivity.onUserLeaveHint).
    private static volatile boolean videoOn = false;

    static boolean videoCallOn() {
        return videoOn;
    }

    static void pictureInPictureChanged(boolean on) {
        CallAudioPlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("on", on);
        p.notifyListeners("pictureInPicture", d);
    }

    // Hang up tapped on the ongoing-call notification (CallService): the page
    // ends the call. With no page listening, just put everything back.
    static void hangupFromNotification(Context context) {
        CallAudioPlugin p = instance;
        if (p != null && p.hasListeners("callHangup")) {
            p.notifyListeners("callHangup", new JSObject());
        } else {
            CallService.stop(context);
            if (p != null) p.release();
        }
    }

    // The page rings / answered / ended it: take the phone's call screen away.
    // ringingHere (the page got the call and rings): only while the app is
    // on screen — a page left in the background (its connection still up)
    // must not take the call screen away; it rings there instead.
    @PluginMethod
    public void cancelIncoming(PluginCall call) {
        boolean ringingHere = Boolean.TRUE.equals(call.getBoolean("ringingHere", false));
        if (!ringingHere || MainActivity.isOnScreen()) IncomingCall.cancel(getContext(), call.getString("callId"));
        call.resolve();
    }

    // The app came on screen while its call screen was ringing: the page
    // rings from now on (CallLayer / GroupCallLayer "ringHandover").
    static void ringHandover() {
        CallAudioPlugin p = instance;
        if (p != null) p.notifyListeners("ringHandover", new JSObject());
    }

    private AudioManager audio;
    private AudioFocusRequest focusRequest;
    private PowerManager.WakeLock proximityLock;
    private int previousMode = AudioManager.MODE_NORMAL;
    private boolean active = false;
    private boolean speaker = false;

    private AudioManager audio() {
        if (audio == null) audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        return audio;
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean wantSpeaker = Boolean.TRUE.equals(call.getBoolean("speaker", false));
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", wantSpeaker));
        // Keep the call going when the app is left (Home, screen off).
        CallService.start(getContext(), video);
        videoOn = video;
        try {
            AudioManager am = audio();
            if (!active) {
                previousMode = am.getMode();
                requestFocus(am);
                active = true;
            }
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            route(am, wantSpeaker);
            call.resolve(state());
        } catch (Exception e) {
            call.reject("Could not set the call sound: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            AudioManager am = audio();
            if (!active) {
                previousMode = am.getMode();
                requestFocus(am);
                active = true;
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            route(am, on);
            call.resolve(state());
        } catch (Exception e) {
            call.reject("Could not switch the speaker: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        release();
        call.resolve(state());
    }

    @Override
    protected void handleOnDestroy() {
        release();
        super.handleOnDestroy();
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("active", active);
        r.put("speaker", speaker);
        return r;
    }

    private void requestFocus(AudioManager am) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).build();
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void route(AudioManager am, boolean toSpeaker) {
        speaker = toSpeaker;
        boolean done = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: pick the device itself. A headset / Bluetooth, if
            // one is connected, is left to the system for the earpiece case.
            int wanted = toSpeaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
            AudioDeviceInfo pick = null;
            if (!toSpeaker) {
                for (AudioDeviceInfo d : devices) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                        pick = d;
                        break;
                    }
                }
            }
            if (pick == null) {
                for (AudioDeviceInfo d : devices) {
                    if (d.getType() == wanted) {
                        pick = d;
                        break;
                    }
                }
            }
            if (pick != null) done = am.setCommunicationDevice(pick);
        }
        if (!done) am.setSpeakerphoneOn(toSpeaker);
        proximity(!toSpeaker);
    }

    // Screen off while the phone is at the ear (earpiece only).
    private void proximity(boolean on) {
        try {
            if (on) {
                if (proximityLock == null) {
                    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                    if (pm != null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                        proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "CredenceHR:call");
                    }
                }
                if (proximityLock != null && !proximityLock.isHeld()) proximityLock.acquire(2 * 60 * 60 * 1000L);
            } else if (proximityLock != null && proximityLock.isHeld()) {
                proximityLock.release();
            }
        } catch (Exception ignored) {
            // not every phone has the sensor
        }
    }

    private void release() {
        videoOn = false;
        CallService.stop(getContext());
        // Call over while in picture-in-picture: close that small window.
        final android.app.Activity a = getActivity();
        if (a != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            a.runOnUiThread(() -> {
                try {
                    if (a.isInPictureInPictureMode()) a.moveTaskToBack(false);
                } catch (Exception ignored) {
                    // best effort
                }
            });
        }
        if (!active) return;
        active = false;
        speaker = false;
        proximity(false);
        try {
            AudioManager am = audio();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice();
            am.setSpeakerphoneOn(false);
            am.setMode(previousMode);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
            else am.abandonAudioFocus(null);
        } catch (Exception ignored) {
            // best effort
        }
    }
}
