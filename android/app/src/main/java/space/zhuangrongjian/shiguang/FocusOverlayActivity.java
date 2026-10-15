package space.zhuangrongjian.shiguang;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 拾光 · 「专注中」的全屏页
 *
 * 黑名单应用被切到前台时，这一页会盖在它上面。
 *
 * 设计上刻意留了一条退路（「这次先算了」）：拦得死死的应用会被卸载，
 * 而卸载之后连那几秒的缓冲都没有了。留个小口子，人才愿意继续用它。
 */
public class FocusOverlayActivity extends Activity {

    public static final String EXTRA_LABEL = "label";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView countdown;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            updateCountdown();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_focus_overlay);

        // 锁屏上也弹出来，并且保持屏幕亮着（用户多半是刚拿起手机）
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String label = getIntent().getStringExtra(EXTRA_LABEL);
        if (label == null || label.isEmpty()) label = "专注";
        ((TextView) findViewById(R.id.focus_label)).setText(label);
        countdown = findViewById(R.id.focus_countdown);

        findViewById(R.id.focus_home).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent home = new Intent(Intent.ACTION_MAIN);
                home.addCategory(Intent.CATEGORY_HOME);
                home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(home);
                finish();
            }
        });

        /*
         * 「这次先算了」：点一下变成确认，再点一下才真的放行。
         * 就多这一下 —— 想清楚那一秒钟，很多时候就过去了。
         */
        final Button give = findViewById(R.id.focus_giveup);
        give.setOnClickListener(new View.OnClickListener() {
            private boolean armed = false;
            private final Runnable disarm = new Runnable() {
                @Override
                public void run() {
                    armed = false;
                    give.setText("这次先算了");
                }
            };

            @Override
            public void onClick(View v) {
                if (!armed) {
                    armed = true;
                    give.setText("再点一下，真的放过自己");
                    handler.postDelayed(disarm, 4000);
                    return;
                }
                handler.removeCallbacks(disarm);
                // 只放行这一次：把当前这条时段挪走，下一次切回来还会拦
                ShiguangFocus.snoozeCurrent(FocusOverlayActivity.this);
                finish();
            }
        });
    }

    private void updateCountdown() {
        JSONObject cur = ShiguangFocus.currentInterval(this);
        if (cur == null) {
            // 时段已经结束了，自己退场
            finish();
            return;
        }
        long left = cur.optLong("to", 0L) - System.currentTimeMillis();
        if (left <= 0) {
            finish();
            return;
        }
        long min = left / 60000;
        long sec = (left % 60000) / 1000;
        countdown.setText(min > 0
                ? "还有 " + min + " 分钟"
                : "还有 " + sec + " 秒");
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.removeCallbacks(tick);
        handler.post(tick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(tick);
    }

    @Override
    public void onBackPressed() {
        // 按返回就回桌面，别把人送回那个被挡住的 app 再弹一次
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(home);
        finish();
    }
}
