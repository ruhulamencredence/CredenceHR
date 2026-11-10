package com.mprtracker.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;

// The full-screen incoming-call screen (IncomingCallService): over the lock
// screen, waking the screen, like the phone's own call screen — the caller's
// initials, name, "Audio call · CredenceHR", and Decline / Accept.
//   Accept  -> the app opens and answers (MainActivity -> CallAudioPlugin
//              pending call -> CallLayer / GroupCallLayer).
//   Decline -> IncomingCall.DeclineReceiver (one-to-one: tells the server).
//   Volume key -> quiet (keeps showing); Back -> quiet and leaves the screen
//              (the call notification stays until it stops ringing).
// Built in code (no layout file), in the colours of the in-app call screen.
public class IncomingCallActivity extends Activity {

    private static WeakReference<IncomingCallActivity> live = new WeakReference<>(null);
    private String callId;

    static Intent intent(Context c) {
        return new Intent(c, IncomingCallActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
    }

    // The call stopped ringing (answered, declined, taken away): close.
    static void closeFor(String callId) {
        IncomingCallActivity a = live.get();
        if (a == null) return;
        if (callId != null && a.callId != null && !callId.equals(a.callId)) return;
        a.runOnUiThread(a::finish);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bundle d = IncomingCallService.current();
        if (d == null) {
            finish();
            return;
        }
        callId = d.getString("callId");
        live = new WeakReference<>(this);
        showOverLockScreen();
        setContentView(build(d));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Bundle d = IncomingCallService.current();
        if (d == null) {
            finish();
            return;
        }
        callId = d.getString("callId");
        setContentView(build(d));
    }

    @Override
    protected void onDestroy() {
        if (live.get() == this) live = new WeakReference<>(null);
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void showOverLockScreen() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            w.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.setStatusBarColor(Color.parseColor("#2E1065"));
        w.setNavigationBarColor(Color.parseColor("#0F172A"));
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private static String initials(String name) {
        StringBuilder b = new StringBuilder();
        for (String part : name.trim().split("\\s+")) {
            if (part.isEmpty()) continue;
            b.appendCodePoint(part.codePointAt(0));
            if (b.length() >= 2) break;
        }
        return b.length() == 0 ? "?" : b.toString().toUpperCase();
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private View roundButton(int color, int icon, String label, View.OnClickListener onClick) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageView b = new ImageView(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(color);
        b.setBackground(bg);
        b.setImageResource(icon);
        b.setColorFilter(Color.WHITE);
        b.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        b.setPadding(dp(20), dp(20), dp(20), dp(20));
        b.setContentDescription(label);
        b.setOnClickListener(onClick);
        col.addView(b, new LinearLayout.LayoutParams(dp(76), dp(76)));
        TextView l = text(label, 14, Color.parseColor("#E2E8F0"), true);
        l.setPadding(0, dp(10), 0, 0);
        col.addView(l);
        return col;
    }

    private View build(Bundle d) {
        FrameLayout root = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] { Color.parseColor("#2E1065"), Color.parseColor("#0F172A") });
        root.setBackground(bg);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setGravity(Gravity.CENTER_HORIZONTAL);
        top.setPadding(dp(24), dp(96), dp(24), 0);

        String name = IncomingCallService.title(d);
        TextView avatar = text(initials(name), 40, Color.WHITE, true);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor("#7C3AED"));
        circle.setStroke(dp(4), Color.parseColor("#33FFFFFF"));
        avatar.setBackground(circle);
        top.addView(avatar, new LinearLayout.LayoutParams(dp(120), dp(120)));

        TextView who = text(name, 28, Color.WHITE, true);
        who.setPadding(0, dp(24), 0, dp(6));
        top.addView(who);
        top.addView(text(IncomingCallService.subtitle(d), 15, Color.parseColor("#C4B5FD"), false));
        TextView ringing = text("Ringing…", 14, Color.parseColor("#94A3B8"), false);
        ringing.setPadding(0, dp(10), 0, 0);
        top.addView(ringing);
        root.addView(top, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding(dp(32), 0, dp(32), dp(72));
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(roundButton(Color.parseColor("#EF4444"), android.R.drawable.ic_menu_close_clear_cancel, "Decline", v -> decline()), half);
        row.addView(roundButton(Color.parseColor("#10B981"), android.R.drawable.sym_action_call, "Accept", v -> accept()), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(row, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        return root;
    }

    private void accept() {
        Bundle d = IncomingCallService.current();
        if (d == null) {
            finish();
            return;
        }
        Intent open = IncomingCall.openIntent(this, d, "accept");
        IncomingCallService.stopFor(this, d.getString("callId"));
        // Locked phone: ask to unlock, then the app answers (it shows over
        // the lock screen too, if the person doesn't unlock).
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null && km.isKeyguardLocked()) km.requestDismissKeyguard(this, null);
        startActivity(open);
        finish();
    }

    private void decline() {
        Bundle d = IncomingCallService.current();
        if (d != null) sendBroadcast(IncomingCall.declineIntent(this, d));
        IncomingCallService.stopFor(this, d != null ? d.getString("callId") : null);
        finish();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_MUTE) {
            CallRinger.silence();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        CallRinger.silence();
        super.onBackPressed();
    }
}
