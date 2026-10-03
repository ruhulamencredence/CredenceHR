package com.mprtracker.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
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

    // The phone's Location (GPS) switch.
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
