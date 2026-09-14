package com.mprtracker.app;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    // The exact server URL Capacitor was configured to load (see
    // capacitor.config.ts -> server.url). Kept here so the offline page's
    // "Try Again" button/auto-retry can navigate straight back to it instead
    // of guessing the URL.
    private String appServerUrl;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = this.bridge.getWebView();
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
        });
    }

    private void showOfflinePage(WebView view) {
        String url = "file:///android_asset/offline.html";
        if (appServerUrl != null) {
            url += "?url=" + Uri.encode(appServerUrl);
        }
        view.loadUrl(url);
    }
}
