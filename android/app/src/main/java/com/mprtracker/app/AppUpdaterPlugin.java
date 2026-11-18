package com.mprtracker.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// "Update available" inside the app (AppUpdatePrompt.tsx via
// src/lib/appUpdater.ts), instead of sending the person to the browser:
//   download({url})        the new APK into the app's cache, with "progress"
//                          events; only from the app's own server, and only
//                          a file that really is a newer CredenceHR APK
//   canInstall()           whether Android lets this app install (the
//                          one-time "Install unknown apps" switch, Android 8+)
//   openInstallSettings()  that switch's page in Settings; resolves with
//                          canInstall once the person is back
//   install()              Android's own "Do you want to update this app?"
//                          screen for the downloaded file
//   cancel()               stops a download in progress
// Android always asks the person to confirm an install — an app outside
// the Play Store can't update itself silently.
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String APK_TYPE = "application/vnd.android.package-archive";
    private volatile boolean cancelled = false;
    private volatile boolean busy = false;

    private File apkFile() {
        File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, "CredenceHR-update.apk");
    }

    private boolean canInstallNow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    @SuppressWarnings("deprecation")
    private long versionCodeOf(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    // Only the server the app itself opens (capacitor.config.ts server.url).
    private boolean fromOwnServer(Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getHost() == null) return false;
        String server = null;
        try {
            server = getBridge().getConfig().getServerUrl();
        } catch (Exception ignored) {
            // no server url configured
        }
        if (server == null || server.isEmpty()) return false;
        Uri own = Uri.parse(server);
        return uri.getHost().equalsIgnoreCase(own.getHost());
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", canInstallNow());
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        call.resolve();
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        if (!fromOwnServer(uri)) {
            call.reject("Not this app's own download link", "BAD_URL");
            return;
        }
        if (busy) {
            call.reject("A download is already running", "BUSY");
            return;
        }
        busy = true;
        cancelled = false;
        new Thread(() -> {
            File out = apkFile();
            File part = new File(out.getPath() + ".part");
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                long total = conn.getContentLengthLong();
                long loaded = 0;
                long lastSent = 0;
                byte[] buf = new byte[64 * 1024];
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (cancelled) throw new InterruptedException("cancelled");
                        os.write(buf, 0, n);
                        loaded += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent > 250) {
                            lastSent = now;
                            JSObject p = new JSObject();
                            p.put("loaded", loaded);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                // Make sure it is a CredenceHR APK, and newer than this one.
                PackageManager pm = getContext().getPackageManager();
                PackageInfo got = pm.getPackageArchiveInfo(part.getPath(), 0);
                if (got == null || !getContext().getPackageName().equals(got.packageName)) {
                    throw new Exception("The downloaded file is not the CredenceHR app");
                }
                PackageInfo mine = pm.getPackageInfo(getContext().getPackageName(), 0);
                if (versionCodeOf(got) <= versionCodeOf(mine)) {
                    throw new Exception("The downloaded app is not newer than this one");
                }
                if (out.exists()) out.delete();
                if (!part.renameTo(out)) throw new Exception("Could not save the download");
                JSObject p = new JSObject();
                p.put("loaded", loaded);
                p.put("total", loaded);
                notifyListeners("progress", p);
                JSObject ret = new JSObject();
                ret.put("size", loaded);
                ret.put("versionName", got.versionName);
                call.resolve(ret);
            } catch (InterruptedException e) {
                part.delete();
                call.reject("Download cancelled", "CANCELLED");
            } catch (Exception e) {
                part.delete();
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage(), "FAILED");
            } finally {
                if (conn != null) conn.disconnect();
                busy = false;
            }
        }).start();
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (canInstallNow() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            JSObject ret = new JSObject();
            ret.put("allowed", canInstallNow());
            call.resolve(ret);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, intent, "afterInstallSettings");
    }

    @ActivityCallback
    private void afterInstallSettings(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("allowed", canInstallNow());
        call.resolve(ret);
    }

    @PluginMethod
    public void install(PluginCall call) {
        File file = apkFile();
        if (!file.exists()) {
            call.reject("Nothing downloaded yet", "NO_FILE");
            return;
        }
        if (!canInstallNow()) {
            call.reject("Installing updates isn't allowed yet", "NOT_ALLOWED");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Could not open the installer" : e.getMessage(), "FAILED");
        }
    }
}
