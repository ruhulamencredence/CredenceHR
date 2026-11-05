package com.mprtracker.app;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// Takes over the push plugin's Firebase service (AndroidManifest.xml removes
// the plugin's own entry) so a silent "tracking_live" push from Live Follow
// starts LiveTrackingService natively — it works with the app in Recent apps
// or swiped away, where the page can't act on anything. Every message still
// goes on to the plugin as before (chat/alert notifications, token refresh).
public class LiveWakeMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("tracking_live".equals(data.get("type"))) {
            long until = 0;
            try {
                until = Long.parseLong(data.get("until"));
            } catch (Exception ignore) {
                // No time given — nothing to start.
            }
            if (until > System.currentTimeMillis()) LiveTrackingService.start(getApplicationContext(), until);
        }
        // The server hasn't heard from this phone for a while (Android or
        // battery saving stopped tracking): a high-priority push may start
        // the service again even with the app closed.
        if ("tracking_wake".equals(data.get("type"))) DutyTrackingService.wake(getApplicationContext());
        // A chat call while the app is closed / in the background: the
        // phone's incoming-call screen (IncomingCall.java), and away again
        // when the call ends elsewhere.
        if ("call_incoming".equals(data.get("type"))) IncomingCall.show(getApplicationContext(), data);
        if ("call_cancel".equals(data.get("type"))) IncomingCall.cancel(getApplicationContext(), data.get("callId"));
        super.onMessageReceived(remoteMessage);
    }
}
