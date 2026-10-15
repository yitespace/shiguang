package space.zhuangrongjian.shiguang;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机 / 应用被更新之后把闹钟重新排一遍。
 *
 * AlarmManager 里排的闹钟重启就全没了，不重排的话用户会以为提醒还在，
 * 结果一整天一条都没响 —— 对吃药提醒来说这是最坏的一种失败：
 * 静悄悄地不工作。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.intent.action.QUICKBOOT_POWERON".equals(a)) {
            ShiguangNotify.restore(context);
        }
    }
}
