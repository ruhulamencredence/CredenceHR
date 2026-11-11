package com.mprtracker.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Location access for Employee Tracking's set-up card (TrackingNoticeCard.tsx,
// via src/lib/backgroundTracking.ts). Android never offers "Allow all the
// time" in the in-app dialog (Android 11+), so the set-up runs in two steps:
// requestForeground() shows the normal dialog ("While using the app"), then
// requestBackground() asks for ACCESS_BACKGROUND_LOCATION on its own, which
// Android answers by opening CredenceHR's Location permission page in
// Settings, with "Allow all the time" right there. Both resolve with the
// current status once the person is back in the app.
@CapacitorPlugin(
    name = "LocationAccess",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "background", strings = { "android.permission.ACCESS_BACKGROUND_LOCATION" })
    }
)
public class LocationAccessPlugin extends Plugin {

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasForeground() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    // Before Android 10 there is no separate background permission: the
    // ordinary location permission already covers it.
    private boolean hasBackground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForeground();
        return granted("android.permission.ACCESS_BACKGROUND_LOCATION");
    }

    private JSObject status() {
        JSObject ret = new JSObject();
        ret.put("foreground", hasForeground());
        ret.put("background", hasBackground());
        ret.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        ret.put("locationOn", lm != null && LocationManagerCompat.isLocationEnabled(lm));
        return ret;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestForeground(PluginCall call) {
        if (hasForeground()) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("location", call, "afterRequest");
    }

    // Only works once the foreground permission is held (Android ignores it
    // otherwise), so the card always asks requestForeground() first.
    @PluginMethod
    public void requestBackground(PluginCall call) {
        if (!hasForeground() || hasBackground()) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("background", call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        call.resolve(status());
    }

    // Fallback once Android stops showing the request (the person said no
    // too many times): CredenceHR's App info page in Settings.
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    // Live Follow runs natively (LiveTrackingService): it needs this
    // account's sign-in and the server address to send pings on its own.
    @PluginMethod
    public void setTrackingSession(PluginCall call) {
        String token = call.getString("token");
        String baseUrl = call.getString("baseUrl");
        if (token == null || baseUrl == null) {
            call.reject("token and baseUrl are required");
            return;
        }
        getContext()
            .getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(LiveTrackingService.KEY_TOKEN, token)
            .putString(LiveTrackingService.KEY_BASE, baseUrl.replaceAll("/+$", ""))
            .apply();
        call.resolve();
    }

    // Logout / tracking turned off: forget the sign-in and stop any live reporting.
    @PluginMethod
    public void clearTrackingSession(PluginCall call) {
        DutyTrackingService.stop(getContext());
        getContext().getSharedPreferences(LiveTrackingService.PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        LiveTrackingService.stop(getContext());
        call.resolve();
    }

    // Everyday Employee Tracking, reported natively (DutyTrackingService) so
    // it keeps going with the app in the background or swiped away. Needs
    // setTrackingSession first.
    @PluginMethod
    public void startDutyTracking(PluginCall call) {
        DutyTrackingService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopDutyTracking(PluginCall call) {
        DutyTrackingService.stop(getContext());
        call.resolve();
    }

    // Battery saving: many phones stop background apps anyway unless
    // CredenceHR is let off battery optimisation.
    @PluginMethod
    public void getBatteryStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean ignoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        }
        ret.put("unrestricted", ignoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception e) {
                Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        }
        call.resolve();
    }

    // One fresh position for Remote Attendance Check In / Out
    // (src/lib/attendanceFix.ts), with whether it came from a mock-location
    // ("fake GPS") app — Capacitor's Geolocation plugin doesn't say. The
    // server refuses a mock fix. A fix taken in the last maxAgeMs (30 s) is
    // accepted as is, so it's as quick as before.
    @SuppressLint("MissingPermission")
    @PluginMethod
    public void getCurrentFix(PluginCall call) {
        if (!hasForeground()) {
            call.reject("Location permission is required to mark attendance. Please allow location access and try again.", "PERMISSION");
            return;
        }
        int maxAge = call.getInt("maxAgeMs", 30000);
        int timeout = call.getInt("timeoutMs", 15000);
        CurrentLocationRequest req = new CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            .setMaxUpdateAgeMillis(maxAge)
            .setDurationMillis(timeout)
            .setGranularity(Granularity.GRANULARITY_PERMISSION_LEVEL)
            .build();
        CancellationTokenSource cts = new CancellationTokenSource();
        try {
            LocationServices.getFusedLocationProviderClient(getContext())
                .getCurrentLocation(req, cts.getToken())
                .addOnSuccessListener(loc -> {
                    if (loc == null) {
                        call.reject("Couldn't get your location. Turn on Location and try again.", "NO_FIX");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("latitude", loc.getLatitude());
                    ret.put("longitude", loc.getLongitude());
                    if (loc.hasAccuracy()) ret.put("accuracy", (double) loc.getAccuracy());
                    ret.put("time", loc.getTime());
                    ret.put("mock", MockLocation.of(loc));
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> call.reject("Couldn't get your location. Please try again.", "NO_FIX"));
        } catch (SecurityException e) {
            call.reject("Location permission is required to mark attendance. Please allow location access and try again.", "PERMISSION");
        }
    }

    // The phone's Location (GPS) switch.
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
