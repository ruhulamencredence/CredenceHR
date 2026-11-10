package com.mprtracker.app;

import android.location.Location;
import android.os.Build;

// Whether a fix came from a mock-location ("fake GPS") app — Android marks
// every fix such an app makes. Sent with each point as "mock": true; the
// server stores it (location_pings.is_mock) and Employee Tracking shows it
// in red, never as part of the route.
final class MockLocation {
    private MockLocation() {}

    @SuppressWarnings("deprecation")
    static boolean of(Location loc) {
        if (loc == null) return false;
        try {
            return Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider();
        } catch (Exception e) {
            return false;
        }
    }
}
