package com.mprtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// After the phone restarts (or the app is updated), Employee Tracking picks
// up again by itself if it was on (DutyTrackingService), without waiting for
// the person to open the app.
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (DutyTrackingService.wanted(context)) DutyTrackingService.start(context);
    }
}
