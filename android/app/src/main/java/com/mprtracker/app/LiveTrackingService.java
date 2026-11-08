package com.mprtracker.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Scanner;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

// Employee Tracking -> Live Follow, done natively.
//
// When an Admin starts following someone, the server sends that phone a
// silent push (LiveWakeMessagingService). This service then reports the
// phone's location every few seconds straight to POST /api/tracking/ping —
// no WebView involved, so it works while the app sits in Recent apps (where
// Android pauses the page's timers) and even after the app was swiped away
// (the push starts the process again). It stops by itself when the server's
// "live until" time passes, or when the server refuses the sign-in.
//
// The sign-in token and server address come from the page
// (LocationAccessPlugin.setTrackingSession) and are kept in
// SharedPreferences until logout.
public class LiveTrackingService extends Service {

    static final String PREFS = "credence_tracking";
    static final String KEY_TOKEN = "token";
    static final String KEY_BASE = "base_url";
    private static final String EXTRA_UNTIL = "until";
    private static final String CHANNEL_ID = "live_tracking";
    private static final int NOTIFICATION_ID = 7342;
    private static final long FIX_INTERVAL_MS = 5000;
    // Standing still: a "still here" heartbeat at most this often.
    private static final long HEARTBEAT_MS = 30000;
    private static final float MOVED_M = 5f;
    // Never stay on longer than this past the last "live until", whatever happens.
    private static final long MAX_LIVE_MS = 30 * 60 * 1000;

    private FusedLocationProviderClient client;
    private LocationCallback callback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private volatile long liveUntil = 0;
    private Location lastSent;
    private long lastSentAt = 0;
    private boolean running = false;

    /** Starts (or extends) live reporting until `untilMs`. Safe to call from a push. */
    public static void start(Context ctx, long untilMs) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (p.getString(KEY_TOKEN, null) == null || p.getString(KEY_BASE, null) == null) return;
        Intent i = new Intent(ctx, LiveTrackingService.class).putExtra(EXTRA_UNTIL, untilMs);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignore) {
            // Not allowed right now (e.g. no background-start exemption) — the
            // app's regular check-in still picks the live request up.
        }
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, LiveTrackingService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        long until = intent != null ? intent.getLongExtra(EXTRA_UNTIL, 0) : 0;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification());
            }
        } catch (Exception e) {
            // No location permission in the background any more — nothing to do.
            stopSelf();
            return START_NOT_STICKY;
        }
        setUntil(until);
        if (!running) begin();
        return START_NOT_STICKY;
    }

    private void setUntil(long until) {
        long cap = System.currentTimeMillis() + MAX_LIVE_MS;
        liveUntil = Math.min(Math.max(liveUntil, until), cap);
        handler.removeCallbacks(expiry);
        long wait = liveUntil - System.currentTimeMillis();
        if (wait <= 0) {
            stopSelf();
            return;
        }
        handler.postDelayed(expiry, wait + 1000);
    }

    private final Runnable expiry = () -> {
        if (System.currentTimeMillis() >= liveUntil) stopSelf();
    };

    @SuppressLint("MissingPermission")
    private void begin() {
        running = true;
        client = LocationServices.getFusedLocationProviderClient(this);
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FIX_INTERVAL_MS)
            .setMinUpdateIntervalMillis(3000)
            .build();
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location loc = result.getLastLocation();
                if (loc != null) onFix(loc);
            }
        };
        try {
            client.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (SecurityException e) {
            stopSelf();
        }
    }

    private void onFix(Location loc) {
        if (System.currentTimeMillis() >= liveUntil) {
            stopSelf();
            return;
        }
        long now = System.currentTimeMillis();
        boolean still = lastSent != null && lastSent.distanceTo(loc) < MOVED_M;
        if (still && now - lastSentAt < HEARTBEAT_MS) return;
        // Standing still: re-send the last stored point as a heartbeat (the
        // server stores nothing new but tells the watcher the phone answered).
        Location send = still ? lastSent : loc;
        lastSentAt = now;
        if (!still) lastSent = loc;
        final boolean repeat = still;
        net.execute(() -> post(send, repeat));
    }

    private void post(Location loc, boolean repeat) {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String token = p.getString(KEY_TOKEN, null);
        String base = p.getString(KEY_BASE, null);
        if (token == null || base == null) {
            handler.post(this::stopSelf);
            return;
        }
        HttpURLConnection c = null;
        try {
            JSONObject body = new JSONObject();
            body.put("lat", loc.getLatitude());
            body.put("lng", loc.getLongitude());
            if (loc.hasAccuracy()) body.put("accuracy_m", Math.round(loc.getAccuracy()));
            int battery = batteryPct();
            if (battery >= 0) body.put("battery_pct", battery);
            body.put("recorded_at", iso(loc.getTime()));
            body.put("repeat", repeat);
            body.put("mode", "live");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);

            c = (HttpURLConnection) new URL(base + "/api/tracking/ping").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }
            int code = c.getResponseCode();
            if (code == 401 || code == 403) {
                // Signed out, ended or no tracking access: stop and forget the sign-in.
                p.edit().remove(KEY_TOKEN).apply();
                handler.post(this::stopSelf);
                return;
            }
            if (code >= 200 && code < 300) {
                try (InputStream is = c.getInputStream(); Scanner s = new Scanner(is, "UTF-8").useDelimiter("\\A")) {
                    JSONObject res = new JSONObject(s.hasNext() ? s.next() : "{}");
                    long until = res.isNull("live_until") ? 0 : res.optLong("live_until", 0);
                    handler.post(() -> {
                        if (until <= System.currentTimeMillis()) stopSelf();
                        else setUntil(until);
                    });
                }
            }
        } catch (Exception ignore) {
            // Offline for a moment — the next fix tries again.
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private int batteryPct() {
        BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
        return bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;
    }

    private static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Live location", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while your location is being shared live for Employee Tracking.");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sharing live location")
            .setContentText("Employee Tracking is following your location right now.")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(pi)
            .build();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (client != null && callback != null) client.removeLocationUpdates(callback);
        running = false;
        net.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
