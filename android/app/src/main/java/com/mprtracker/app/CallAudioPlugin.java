package com.mprtracker.app;

import android.content.Context;
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
    private static long pendingAt;
    private static CallAudioPlugin instance;

    static void setPendingCall(String callId, String action) {
        pendingCallId = callId;
        pendingAction = action;
        pendingAt = System.currentTimeMillis();
        CallAudioPlugin p = instance;
        if (p != null) {
            JSObject d = new JSObject();
            d.put("callId", callId);
            d.put("action", action);
            p.notifyListeners("callAction", d);
        }
    }

    @Override
    public void load() {
        instance = this;
    }

    // { callId, action: 'accept' | 'open' } once, or {} when there is none
    // (older than a minute is stale: that call has ended by now).
    @PluginMethod
    public void takePendingCall(PluginCall call) {
        JSObject r = new JSObject();
        if (pendingCallId != null && System.currentTimeMillis() - pendingAt < 60 * 1000) {
            r.put("callId", pendingCallId);
            r.put("action", pendingAction);
        }
        pendingCallId = null;
        pendingAction = null;
        call.resolve(r);
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

    // The page rings / answered by itself: take the phone's call screen away.
    @PluginMethod
    public void cancelIncoming(PluginCall call) {
        IncomingCall.cancel(getContext(), call.getString("callId"));
        call.resolve();
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
        CallService.stop(getContext());
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
