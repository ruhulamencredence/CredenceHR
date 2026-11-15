package com.mprtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// The repeating wake-up of Employee Tracking (DutyTrackingService.scheduleAlarm):
// Android delivers it even in Doze / with battery optimisation on.
public class DutyAlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        // The tracking time has started (Tracking Schedule).
        if (intent != null && DutyTrackingService.ACTION_RESUME.equals(intent.getAction())) {
            DutyTrackingService.resume(context);
            return;
        }
        // The tracking time has ended: stop now (the notification goes).
        if (intent != null && DutyTrackingService.ACTION_WINDOW_END.equals(intent.getAction())) {
            DutyTrackingService.windowEnded(context, goAsync());
            return;
        }
        DutyTrackingService.wake(context);
        if (!DutyTrackingService.paused(context)) DutyTrackingService.scheduleAlarm(context);
    }
}
