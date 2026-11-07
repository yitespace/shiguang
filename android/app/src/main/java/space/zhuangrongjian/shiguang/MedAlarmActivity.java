package space.zhuangrongjian.shiguang;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

/**
 * 拾光 · 吃药闹钟的全屏页
 *
 * 闹钟到点直接盖在最上面（锁屏时也一样），带循环铃声和震动。
 * 用户可以：吃了 / 10 分钟后再叫我 / 关掉。
 *
 * 为什么「吃了」不直接在这里调接口：这一页是原生界面，拿不到登录态。
 * 所以它只把「哪一顿吃了」记到 SharedPreferences，然后打开 App，
 * 由网页层带着 cookie 去打卡 —— 判断和数据都留在 JS 里，
 * 和「逻辑放 JS、Java 只做胶水」的原则一致。
 */
public class MedAlarmActivity extends Activity {

    public static final String EXTRA_MED_ID = "medId";
    public static final String EXTRA_DATE = "date";
    public static final String EXTRA_SLOT = "slot";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    /** 待打卡队列，网页层启动时会来读走 */
    static final String PREFS = "shiguang_pending";
    static final String KEY_TAKE = "pendingTake";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_med_alarm);

        // 锁屏上也铺满，并把屏幕点亮 —— 该吃药的时候多半是刚拿起手机
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String body = getIntent().getStringExtra(EXTRA_BODY);
        ((TextView) findViewById(R.id.med_title)).setText(title == null ? "该吃药了" : title);
        ((TextView) findViewById(R.id.med_body)).setText(body == null ? "" : body);

        findViewById(R.id.med_taken).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                markTaken();
                RingService.stop(MedAlarmActivity.this);
                openApp();
                finish();
            }
        });

        Button snooze = findViewById(R.id.med_snooze);
        snooze.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 10 分钟后再响一次。不打卡，只是往后挪。
                ShiguangNotify.snoozeOnce(MedAlarmActivity.this, 10);
                RingService.stop(MedAlarmActivity.this);
                finish();
            }
        });

        findViewById(R.id.med_close).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                RingService.stop(MedAlarmActivity.this);
                finish();
            }
        });
    }

    /** 记下「这一顿吃了」，等 App 起来之后由网页层真正写进服务器 */
    private void markTaken() {
        String medId = getIntent().getStringExtra(EXTRA_MED_ID);
        String date = getIntent().getStringExtra(EXTRA_DATE);
        String slot = getIntent().getStringExtra(EXTRA_SLOT);
        if (medId == null || slot == null) return;
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit()
                .putString(KEY_TAKE, medId + "|" + (date == null ? "" : date) + "|" + slot + "|" + System.currentTimeMillis())
                .apply();
    }

    private void openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("sg_from", "alarm");
        startActivity(i);
    }

    @Override
    public void onBackPressed() {
        // 返回 = 关掉提示，但铃声必须停，不然会一直响在后台
        RingService.stop(this);
        super.onBackPressed();
    }
}
