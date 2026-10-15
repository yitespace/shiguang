package space.zhuangrongjian.shiguang;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 闹钟到点了。
 *
 * 只做一件事：把通知弹出去。所有「该不该响、几点响、响什么字」
 * 在排程的时候就已经定好了（那些判断在 JS 里，见 care-logic.mjs）。
 */
public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_FIRE = "space.zhuangrongjian.shiguang.FIRE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_FIRE.equals(intent.getAction())) return;
        String id = intent.getStringExtra("id");
        if (id == null) return;
        ShiguangNotify.show(
                context,
                id,
                intent.getStringExtra("title"),
                intent.getStringExtra("body"),
                intent.getBooleanExtra("alarm", false));
    }
}
