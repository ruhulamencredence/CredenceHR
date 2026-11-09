package com.mprtracker.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// The repeating wake-up of Employee Tracking (DutyTrackingService.scheduleAlarm):
// Android delivers it even in Doze / with battery optimisation on.
public class DutyAlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        DutyTrackingService.wake(context);
        DutyTrackingService.scheduleAlarm(context);
    }
}
