package com.mprtracker.app;

import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    // The exact server URL Capacitor was configured to load (see
    // capacitor.config.ts -> server.url). Kept here so the offline page's
    // "Try Again" button/auto-retry can navigate straight back to it instead
    // of guessing the URL.
    private String appServerUrl;
    private WebView webView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Set up edge-to-edge natively, synchronously, right here -- rather
        // than solely relying on App.tsx's StatusBar.setOverlaysWebView({
        // overlay: true }), which only runs later (async, from JS, after the
        // bundle has loaded). On some devices/timings the window's real
        // insets were still being computed with decorFitsSystemWindows still
        // true when our own insets listener below first fired, so it
        // captured a stale/zero value that never got corrected -- these two
        // calls guarantee the window is already in its final edge-to-edge
        // state before the very first insets dispatch, on top of what the
        // theme's windowLayoutInDisplayCutoutMode="shortEdges" already sets.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = getWindow().getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attrs);
        }

        webView = this.bridge.getWebView();
        appServerUrl = this.bridge.getServerUrl();

        // Wrap Capacitor's own WebViewClient so its bridge/plugin handling
        // (shouldOverrideUrlLoading, shouldInterceptRequest, etc.) keeps
        // working exactly as before -- we only add error handling on top.
        webView.setWebViewClient(new BridgeWebViewClient(this.bridge) {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    showOfflinePage(view);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                // Also catch a main-frame request that reached the server but
                // came back as a server-side failure (502/503/504 etc.) --
                // same broken experience for the user as a timeout.
                if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                    showOfflinePage(view);
                }
            }

            // Legacy overload -- the WebResourceRequest/WebResourceError
            // version above only fires on API 23+. minSdkVersion here is 22
            // (Android 5.1), so this keeps those devices covered too.
            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                showOfflinePage(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // The very first window-insets dispatch (below) can land
                // before the page has actually loaded, so document.documentElement
                // isn't there yet and that evaluateJavascript call silently
                // no-ops -- re-trigger the listener now that the page is
                // definitely ready, so the CSS variable it sets always ends
                // up applied at least once per load.
                ViewCompat.requestApplyInsets(webView);
                // Belt-and-braces: on a few OEM skins the FIRST insets
                // dispatch after a fresh page load still lands before the
                // window has fully settled into its edge-to-edge layout,
                // carrying a stale (often 0) value that never gets
                // corrected because nothing changes again afterward. One
                // more request half a second later re-reads whatever the
                // window's real insets are by then and re-injects them --
                // a no-op (same value written twice) everywhere else.
                new Handler(Looper.getMainLooper()).postDelayed(
                    () -> ViewCompat.requestApplyInsets(webView), 500
                );
            }
        });

        // App.tsx's StatusBar.setOverlaysWebView({ overlay: true }) makes the
        // WebView draw under the status bar/notch, and Navbar.tsx/GlobalSidebar.tsx/
        // index.css reserve space for it via CSS `env(safe-area-inset-top)`.
        // That works on most devices, but on some tall/high-density panels
        // with a display cutout (observed on a 1260x2800 20:9 punch-hole
        // display) the WebView's own env(safe-area-inset-*) comes back 0 or
        // short of the real cutout height regardless of
        // windowLayoutInDisplayCutoutMode, so the header ends up drawn too
        // high and the status bar clock/icons overlap it. Bypass that by
        // reading the REAL system bar + cutout insets straight from
        // Android's own WindowInsetsCompat and pushing them into the page as
        // a CSS custom property the page can prefer over env() — see
        // `var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))`
        // in index.css/Navbar.tsx/GlobalSidebar.tsx/App.tsx. No-ops (falls
        // through to the env() fallback, i.e. today's behavior) on any
        // device where this technique isn't needed.
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            int topPx = insets.getInsets(
                WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout()
            ).top;
            int bottomPx = insets.getInsets(
                WindowInsetsCompat.Type.navigationBars() | WindowInsetsCompat.Type.displayCutout()
            ).bottom;
            // Some heavily-customized OEM skins report a wrong (often 0)
            // status bar inset through the modern WindowInsetsCompat API for
            // their own non-standard status bar implementation, even with
            // decorFitsSystemWindows/windowLayoutInDisplayCutoutMode both set
            // correctly above. android:dimen/status_bar_height is a much
            // older, internal-but-stable resource that's still present (and
            // still accurate) on virtually every Android build, including
            // those, since too much legacy platform/OEM code still depends
            // on it directly -- used here only as a floor, never lowering
            // whatever the modern API already got right.
            int legacyStatusBarResId = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (legacyStatusBarResId > 0) {
                topPx = Math.max(topPx, getResources().getDimensionPixelSize(legacyStatusBarResId));
            }
            float density = getResources().getDisplayMetrics().density;
            float topCssPx = density > 0 ? topPx / density : topPx;
            float bottomCssPx = density > 0 ? bottomPx / density : bottomPx;
            String js = "document.documentElement.style.setProperty('--native-safe-area-inset-top','"
                + topCssPx + "px');"
                + "document.documentElement.style.setProperty('--native-safe-area-inset-bottom','"
                + bottomCssPx + "px');";
            webView.evaluateJavascript(js, null);
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void showOfflinePage(WebView view) {
        String url = "file:///android_asset/offline.html";
        if (appServerUrl != null) {
            url += "?url=" + Uri.encode(appServerUrl);
        }
        view.loadUrl(url);
    }
}
