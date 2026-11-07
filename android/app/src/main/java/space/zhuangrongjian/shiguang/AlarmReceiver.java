package space.zhuangrongjian.shiguang;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 闹钟到点了。
 *
 * 分两种：
 *   · 「用闹钟提醒」的药 → 拉起全屏页 + 循环铃声 + 震动（App 没开也照响）
 *   · 普通提醒         → 只弹一条通知
 * 具体是哪种由排程时写进 Intent 的 alarm 字段决定。
 */
public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_FIRE = "space.zhuangrongjian.shiguang.FIRE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_FIRE.equals(intent.getAction())) return;
        String id = intent.getStringExtra("id");
        if (id == null) return;

        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        boolean alarm = intent.getBooleanExtra("alarm", false);

        if (!alarm) {
            ShiguangNotify.show(context, id, title, body, false);
            return;
        }

        // 先响起来，再拉起界面 —— 反过来会有「界面出来了但没声音」的空档
        RingService.start(context, title, body);

        Intent full = new Intent(context, MedAlarmActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        full.putExtra(MedAlarmActivity.EXTRA_TITLE, title);
        full.putExtra(MedAlarmActivity.EXTRA_BODY, body);
        full.putExtra(MedAlarmActivity.EXTRA_MED_ID, intent.getStringExtra("medId"));
        full.putExtra(MedAlarmActivity.EXTRA_DATE, intent.getStringExtra("date"));
        full.putExtra(MedAlarmActivity.EXTRA_SLOT, intent.getStringExtra("slot"));
        try {
            context.startActivity(full);
        } catch (Exception e) {
            // 后台启动 Activity 被拦的 ROM：至少还有铃声和一条通知
            ShiguangNotify.show(context, id, title, body, true);
        }
    }
}
