package space.zhuangrongjian.shiguang;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 拾光 · 本地提醒的公共部分
 *
 * 通知、闹钟、开机重排这些事，插件（ShiguangNotifyPlugin）和广播接收器
 * （AlarmReceiver / BootReceiver）都要用，所以抽出来放这儿。
 *
 * 关于「什么时候响」：判断全在 JS 里做完了（服务端 care-logic.mjs 算的），
 * 这里拿到的就是一个个绝对时间戳。Java 这边一行推理都没有 —— 因为这台
 * 开发机上既没有模拟器也没有真机，Java 写了也测不了。
 */
final class ShiguangNotify {

    /** 普通提醒：通知栏弹一条，带声音和震动 */
    static final String CHANNEL_NORMAL = "shiguang_reminder";
    /** 闹钟模式：重要程度最高，会横幅弹出 */
    static final String CHANNEL_ALARM = "shiguang_alarm";

    private static final String PREFS = "shiguang_notify";
    private static final String KEY_SCHEDULE = "schedule";

    private ShiguangNotify() {}

    // ---------- 通道 ----------

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        if (nm.getNotificationChannel(CHANNEL_NORMAL) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_NORMAL, "提醒", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("吃药提醒和你说过的那些到点要做的事");
            c.enableVibration(true);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_ALARM) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_ALARM, "闹钟提醒", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("不能漏的那几次，会响铃并弹出全屏提醒");
            c.enableVibration(true);
            c.setVibrationPattern(new long[] { 0, 400, 250, 400, 250, 400 });
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            c.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, attrs);
            // 锁屏上也把内容显示出来 —— 吃药提醒没什么好藏的，藏了反而容易漏
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
    }

    // ---------- 发通知 ----------

    /**
     * 弹出提醒本身。
     * alarm=true 时走闹钟通道，并挂一个全屏 Intent（锁屏时直接铺满）。
     */
    static void show(Context ctx, String id, String title, String body, boolean alarm) {
        ensureChannels(ctx);
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("sg_from", "notify");

        int reqCode = id.hashCode();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(ctx, reqCode, open, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, alarm ? CHANNEL_ALARM : CHANNEL_NORMAL)
                .setSmallIcon(R.drawable.ic_stat_shiguang)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setCategory(alarm ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        if (alarm) {
            b.setDefaults(NotificationCompat.DEFAULT_ALL);
            Intent full = new Intent(ctx, MainActivity.class);
            full.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent fullPi = PendingIntent.getActivity(ctx, reqCode + 7919, full, flags);
            b.setFullScreenIntent(fullPi, true);
        }

        try {
            NotificationManagerCompat.from(ctx).notify(reqCode, b.build());
        } catch (SecurityException e) {
            // 用户没给通知权限。界面上的状态卡会告诉他，这里不用再吵。
        }
    }

    // ---------- 排程 ----------

    /**
     * 整份重排。
     *
     * 每次都是「全部取消 + 全部重排」，不做增量：增量在「改了一条药的时间」
     * 这种场景下很容易漏掉旧的那个闹钟，而留在错误时间响的闹钟比没有更糟 ——
     * 用户会以为设好了。
     */
    static int schedule(Context ctx, JSONArray items) {
        ensureChannels(ctx);
        cancelAll(ctx);

        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return 0;

        List<String> kept = new ArrayList<>();
        long now = System.currentTimeMillis();
        int count = 0;

        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            long at = it.optLong("at", 0L);
            String id = it.optString("id", "");
            if (at <= now || id.isEmpty()) continue;

            String title = it.optString("title", "拾光");
            String body = it.optString("body", "");
            boolean alarm = it.optBoolean("alarm", false);

            Intent fire = new Intent(ctx, AlarmReceiver.class);
            fire.setAction(AlarmReceiver.ACTION_FIRE);
            fire.putExtra("id", id);
            fire.putExtra("title", title);
            fire.putExtra("body", body);
            fire.putExtra("alarm", alarm);

            int reqCode = id.hashCode();
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(ctx, reqCode, fire, flags);

            try {
                if (alarm) {
                    /*
                     * 闹钟模式下用 setAlarmClock：系统会把它当真正的闹钟，
                     * Doze 里也照响，状态栏还会出现闹钟图标。
                     * 代价是 Android 12+ 需要「闹钟与提醒」权限，
                     * 没授权会抛 SecurityException —— 掉到下面的普通精确闹钟。
                     */
                    PendingIntent show = PendingIntent.getActivity(
                            ctx, reqCode + 7919, new Intent(ctx, MainActivity.class)
                                    .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP), flags);
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
                } else if (canExact(ctx)) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    // 没有精确闹钟权限就退成普通的，可能晚几分钟到，但总比没有强
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
                kept.add(it.toString());
                count++;
            } catch (SecurityException e) {
                try {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    kept.add(it.toString());
                    count++;
                } catch (Exception ignored) {
                    // 连普通的都排不上，放弃这一条，不影响其它
                }
            }
        }

        // 存下来，开机之后照着重排
        SharedPreferences.Editor ed = prefs(ctx).edit().putString(KEY_SCHEDULE, new JSONArray(kept).toString());
        ed.apply();
        return count;
    }

    static void cancelAll(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        JSONArray old = stored(ctx);
        for (int i = 0; i < old.length(); i++) {
            JSONObject it = old.optJSONObject(i);
            if (it == null) continue;
            Intent fire = new Intent(ctx, AlarmReceiver.class);
            fire.setAction(AlarmReceiver.ACTION_FIRE);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(ctx, it.optString("id", "").hashCode(), fire, flags);
            try {
                am.cancel(pi);
            } catch (Exception ignored) {
                /* 已经不存在就算了 */
            }
            pi.cancel();
        }
        NotificationManagerCompat.from(ctx).cancelAll();
        prefs(ctx).edit().remove(KEY_SCHEDULE).apply();
    }

    /** 开机之后把存下来的排程重新排一遍（AlarmManager 的闹钟重启就没了） */
    static int restore(Context ctx) {
        JSONArray saved = stored(ctx);
        if (saved.length() == 0) return 0;
        // schedule() 会先 cancelAll()，所以得先把旧数据拿出来再清
        JSONArray copy = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < saved.length(); i++) {
            JSONObject it = saved.optJSONObject(i);
            if (it != null && it.optLong("at", 0L) > now) copy.put(it);
        }
        return schedule(ctx, copy);
    }

    private static JSONArray stored(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY_SCHEDULE, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- 权限状态 ----------

    static boolean canExact(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    static boolean canFullScreen(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        return nm == null || nm.canUseFullScreenIntent();
    }

    static boolean notificationsAllowed(Context ctx) {
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    static boolean hasPermission(Context ctx, String perm) {
        return ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** 跳到系统的相关设置页 */
    static void openSettings(Context ctx, String which) {
        Intent i;
        if ("exactAlarm".equals(which) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + ctx.getPackageName()));
        } else if ("fullScreen".equals(which) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + ctx.getPackageName()));
        } else {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception ignored) {
            // 个别 ROM 没有这个页面，跳不过去就算了
        }
    }
}
