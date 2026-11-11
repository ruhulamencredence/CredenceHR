package com.mprtracker.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
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
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Scanner;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

// Employee Tracking, done natively — the everyday reporting (Live Follow is
// LiveTrackingService). The page used to do this with timers in the WebView,
// which Android pauses as soon as the app is in the background and which die
// with the app when it's swiped away, so tracking stopped. This foreground
// service keeps going on its own: it collects the phone's fixes and sends
// them to POST /api/tracking/ping in batches (every 3 minutes while moving,
// every 10 when standing still for 15 minutes), plus the phone's state
// (Location on, permission) to /api/tracking/state every 2 minutes. When the
// server answers "go live" it starts LiveTrackingService.
//
// Started from the page (LocationAccessPlugin.startDutyTracking) with the
// sign-in kept in SharedPreferences; START_STICKY plus "keep running" in
// SharedPreferences bring it back after Android stops it, and BootReceiver
// after a restart of the phone. It stops when the page stops it (logout,
// tracking turned off) or the server refuses the sign-in (401 / 403).
public class DutyTrackingService extends Service {

    static final String KEY_DUTY = "duty_on";
    // The alarm / a server wake-up push: report now (works in Doze).
    static final String ACTION_TICK = "com.mprtracker.app.DUTY_TICK";
    private static final long ALARM_MS = 10 * 60 * 1000;
    private static volatile boolean alive = false;
    private static final String CHANNEL_ID = "duty_tracking";
    private static final int NOTIFICATION_ID = 7343;

    private static final long ACTIVE_FIX_MS = 60 * 1000;
    private static final float ACTIVE_DISTANCE_M = 25f;
    private static final long ACTIVE_PING_MS = 3 * 60 * 1000;
    private static final long IDLE_FIX_MS = 5 * 60 * 1000;
    private static final float IDLE_DISTANCE_M = 120f;
    private static final long IDLE_PING_MS = 10 * 60 * 1000;
    private static final long IDLE_AFTER_MS = 15 * 60 * 1000;
    private static final long STATE_MS = 2 * 60 * 1000;
    private static final int MAX_PENDING = 300;
    // Worse than this (m) = a Wi-Fi / mobile-tower guess, not GPS.
    private static final float ROUGH_M = 100f;

    private FusedLocationProviderClient client;
    private LocationCallback callback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final List<Location> pending = new ArrayList<>();
    private Location latest;
    private long lastSentFixTime = 0;
    private long lastFixAt = 0;
    private boolean idle = false;
    private boolean running = false;
    private long lastPingAt = 0;

    /** Turns everyday tracking on for the signed-in account (kept across restarts). */
    public static void start(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE);
        if (p.getString(LiveTrackingService.KEY_TOKEN, null) == null) return;
        p.edit().putBoolean(KEY_DUTY, true).apply();
        Intent i = new Intent(ctx, DutyTrackingService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignore) {
            // Not allowed right now (no background location) — the page tries again.
        }
    }

    public static void stop(Context ctx) {
        cancelAlarm(ctx);
        ctx.getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_DUTY, false).apply();
        ctx.stopService(new Intent(ctx, DutyTrackingService.class));
    }

    static boolean wanted(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_DUTY, false) && p.getString(LiveTrackingService.KEY_TOKEN, null) != null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!wanted(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, notification());
            }
        } catch (Exception e) {
            // No location permission in the background — nothing to do now.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) begin();
        else if (intent != null && ACTION_TICK.equals(intent.getAction())) {
            // Woken by the alarm or the server: report at once.
            sendPing();
            net.execute(this::postState);
        }
        scheduleAlarm(this);
        return START_STICKY;
    }

    // A repeating wake-up that Android still delivers in Doze / with battery
    // optimisation on (setAndAllowWhileIdle), so reports keep going even when
    // the phone sleeps and the service's own timers are frozen. If Android
    // has stopped the service, the alarm tries to start it again.
    static void scheduleAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = alarmIntent(ctx);
        long at = SystemClock.elapsedRealtime() + ALARM_MS;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            else am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
        } catch (Exception ignore) {
            // best effort
        }
    }

    static void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    private static PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, DutyAlarmReceiver.class).setAction(ACTION_TICK);
        return PendingIntent.getBroadcast(ctx, 7344, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** From the alarm or a "tracking_wake" push: report now, starting the service if it was stopped. */
    static void wake(Context ctx) {
        if (!wanted(ctx)) {
            cancelAlarm(ctx);
            return;
        }
        Intent i = new Intent(ctx, DutyTrackingService.class).setAction(ACTION_TICK);
        try {
            if (alive) ctx.startService(i);
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignore) {
            // Not allowed from here right now — the server's wake-up push
            // (allowed to start it) or the next app open brings it back.
            scheduleAlarm(ctx);
        }
    }

    // Swiped away from Recent apps: keep reporting.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    private void begin() {
        running = true;
        alive = true;
        lastFixAt = System.currentTimeMillis();
        client = LocationServices.getFusedLocationProviderClient(this);
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                for (Location loc : result.getLocations()) onFix(loc);
            }
        };
        arm(false);
        handler.postDelayed(pingTick, ACTIVE_PING_MS);
        handler.post(stateTick);
        handler.postDelayed(idleTick, 60 * 1000);
    }

    @SuppressLint("MissingPermission")
    private void arm(boolean asIdle) {
        idle = asIdle;
        try {
            client.removeLocationUpdates(callback);
        } catch (Exception ignore) {
            // nothing armed yet
        }
        LocationRequest req = new LocationRequest.Builder(
            asIdle ? Priority.PRIORITY_BALANCED_POWER_ACCURACY : Priority.PRIORITY_HIGH_ACCURACY,
            asIdle ? IDLE_FIX_MS : ACTIVE_FIX_MS
        )
            .setMinUpdateDistanceMeters(asIdle ? IDLE_DISTANCE_M : ACTIVE_DISTANCE_M)
            .setMinUpdateIntervalMillis(asIdle ? IDLE_FIX_MS / 2 : 15 * 1000)
            // No old cached position handed back as new (a jump on the map).
            .setMaxUpdateAgeMillis(asIdle ? IDLE_FIX_MS : 30 * 1000)
            .setGranularity(Granularity.GRANULARITY_FINE)
            // Moving: wait a moment for a GPS-grade first fix instead of a
            // rough guess. Idle stays on the low-power Balanced setting.
            .setWaitForAccurateLocation(!asIdle)
            .build();
        try {
            client.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (SecurityException e) {
            // Permission taken away: say so on the next state report.
        }
    }

    private void onFix(Location loc) {
        // Sitting still, Wi-Fi / tower guesses wander a few hundred metres,
        // pass the 120 m "moved" test and woke full GPS for nothing (battery)
        // while drawing a jump. A rough fix within its own error of the last
        // one is that drift, not movement: ignored. A fake-GPS fix is always
        // kept — it has to be seen.
        if (idle && latest != null && loc.hasAccuracy() && loc.getAccuracy() > ROUGH_M && !MockLocation.of(loc)
            && loc.distanceTo(latest) <= loc.getAccuracy() + (latest.hasAccuracy() ? latest.getAccuracy() : 0f)) {
            return;
        }
        latest = loc;
        lastFixAt = System.currentTimeMillis();
        pending.add(loc);
        if (pending.size() > MAX_PENDING) pending.subList(0, pending.size() - MAX_PENDING).clear();
        // A fix wakes the phone even in Doze, when the timers below are
        // frozen: send from here once the interval has passed.
        if (System.currentTimeMillis() - lastPingAt >= (idle ? IDLE_PING_MS : ACTIVE_PING_MS) - 5000) sendPing();
        // Moved past the coarse distance while idle: back to the tight settings.
        if (idle) {
            arm(false);
            reschedulePing(ACTIVE_PING_MS);
        }
    }

    private final Runnable pingTick = new Runnable() {
        @Override
        public void run() {
            sendPing();
            handler.postDelayed(this, idle ? IDLE_PING_MS : ACTIVE_PING_MS);
        }
    };

    private void reschedulePing(long ms) {
        handler.removeCallbacks(pingTick);
        handler.postDelayed(pingTick, ms);
    }

    private final Runnable stateTick = new Runnable() {
        @Override
        public void run() {
            net.execute(DutyTrackingService.this::postState);
            handler.postDelayed(this, STATE_MS);
        }
    };

    private final Runnable idleTick = new Runnable() {
        @Override
        public void run() {
            if (!idle && System.currentTimeMillis() - lastFixAt >= IDLE_AFTER_MS) {
                arm(true);
                reschedulePing(IDLE_PING_MS);
            }
            handler.postDelayed(this, 60 * 1000);
        }
    };

    private void sendPing() {
        if (latest == null) return;
        lastPingAt = System.currentTimeMillis();
        final Location fix = latest;
        final boolean repeat = fix.getTime() == lastSentFixTime;
        final List<Location> batch = repeat ? new ArrayList<>() : new ArrayList<>(pending);
        final String mode = idle ? "idle" : "active";
        net.execute(() -> postPing(fix, batch, repeat, mode));
    }

    private void postPing(Location fix, List<Location> batch, boolean repeat, String mode) {
        try {
            JSONObject body = new JSONObject();
            body.put("lat", fix.getLatitude());
            body.put("lng", fix.getLongitude());
            if (fix.hasAccuracy()) body.put("accuracy_m", Math.round(fix.getAccuracy()));
            int battery = batteryPct();
            if (battery >= 0) body.put("battery_pct", battery);
            body.put("recorded_at", iso(fix.getTime()));
            body.put("repeat", repeat);
            body.put("mode", mode);
            if (MockLocation.of(fix)) body.put("mock", true);
            JSONArray points = new JSONArray();
            for (Location l : batch) {
                JSONObject pt = new JSONObject();
                pt.put("lat", l.getLatitude());
                pt.put("lng", l.getLongitude());
                if (l.hasAccuracy()) pt.put("accuracy_m", Math.round(l.getAccuracy()));
                pt.put("recorded_at", iso(l.getTime()));
                if (MockLocation.of(l)) pt.put("mock", true);
                points.put(pt);
            }
            body.put("points", points);
            JSONObject res = post("/api/tracking/ping", body);
            if (res == null) return;
            if (!repeat) {
                final long sentUpTo = batch.isEmpty() ? fix.getTime() : batch.get(batch.size() - 1).getTime();
                handler.post(() -> {
                    lastSentFixTime = fix.getTime();
                    List<Location> keep = new ArrayList<>();
                    for (Location l : pending) if (l.getTime() > sentUpTo) keep.add(l);
                    pending.clear();
                    pending.addAll(keep);
                });
            }
            long until = res.isNull("live_until") ? 0 : res.optLong("live_until", 0);
            if (until > System.currentTimeMillis()) LiveTrackingService.start(getApplicationContext(), until);
        } catch (Exception ignore) {
            // Offline — the fixes stay queued for the next send.
        }
    }

    private void postState() {
        try {
            JSONObject body = new JSONObject();
            LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            body.put("location_on", lm != null && LocationManagerCompat.isLocationEnabled(lm));
            boolean fg = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
            body.put("foreground", fg);
            body.put("background", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ? fg : granted("android.permission.ACCESS_BACKGROUND_LOCATION"));
            body.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
            body.put("mode", idle ? "idle" : "active");
            int battery = batteryPct();
            if (battery >= 0) body.put("battery_pct", battery);
            post("/api/tracking/state", body);
        } catch (Exception ignore) {
            // next heartbeat tries again
        }
    }

    // POSTs JSON with the kept sign-in; null when it didn't go through.
    // A refused sign-in (401 / 403) ends tracking on this phone.
    @Nullable
    private JSONObject post(String path, JSONObject body) {
        SharedPreferences p = getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE);
        String token = p.getString(LiveTrackingService.KEY_TOKEN, null);
        String base = p.getString(LiveTrackingService.KEY_BASE, null);
        if (token == null || base == null) {
            handler.post(this::stopSelf);
            return null;
        }
        HttpURLConnection c = null;
        // Keep the CPU awake for the send itself (the phone may be asleep).
        PowerManager.WakeLock wl = null;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CredenceHR:tracking-send");
                wl.acquire(30 * 1000L);
            }
        } catch (Exception ignore) {
            wl = null;
        }
        try {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c = (HttpURLConnection) new URL(base + path).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }
            int code = c.getResponseCode();
            if (code == 401 || code == 403) {
                p.edit().remove(LiveTrackingService.KEY_TOKEN).putBoolean(KEY_DUTY, false).apply();
                handler.post(this::stopSelf);
                return null;
            }
            if (code < 200 || code >= 300) return null;
            try (InputStream is = c.getInputStream(); Scanner s = new Scanner(is, "UTF-8").useDelimiter("\\A")) {
                return new JSONObject(s.hasNext() ? s.next() : "{}");
            } catch (Exception e) {
                return new JSONObject();
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
            try {
                if (wl != null && wl.isHeld()) wl.release();
            } catch (Exception ignore) {
                // already released
            }
        }
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
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
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Employee Tracking", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while your location is reported for Employee Tracking.");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Employee Tracking active")
            .setContentText("Reporting your location for Employee Tracking. Tap to open the app.")
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
        alive = false;
        // Stopped by Android (not by logout): the alarm brings it back.
        if (wanted(this)) scheduleAlarm(this);
        net.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
