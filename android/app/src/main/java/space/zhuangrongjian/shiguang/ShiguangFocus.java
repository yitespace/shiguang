package space.zhuangrongjian.shiguang;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 拾光 · 学习模式的公共部分
 *
 * 核心约定：**这里不做任何时间推理**。
 * JS 那边已经把规则展开成了一串「从 A 到 B 这段时间，锁这几个包」
 * （见 care-logic.mjs 的 buildFocusIntervals），存进来之后，
 * 判断「现在该不该锁」就只剩一个时间戳比较 + 一次字符串比对。
 *
 * 为什么不在这边解释规则：这台开发机上没有模拟器也没有真机，
 * Java 写了根本跑不起来，逻辑放这边等于没测过。
 */
final class ShiguangFocus {

    private static final String PREFS = "shiguang_focus";
    private static final String KEY_INTERVALS = "intervals";
    private static final String KEY_SNOOZE = "snoozeUntil";

    private ShiguangFocus() {}

    /** 存下来的锁定时段：[{from, to, label, packages:[...]}] */
    static void save(Context ctx, JSONArray intervals) {
        JSONArray clean = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < intervals.length() && clean.length() < 200; i++) {
            JSONObject it = intervals.optJSONObject(i);
            if (it == null) continue;
            long to = it.optLong("to", 0L);
            if (to <= now) continue; // 已经过去的不用留
            clean.put(it);
        }
        prefs(ctx).edit().putString(KEY_INTERVALS, clean.toString()).apply();
    }

    /**
     * 「这次先算了」：放过当前这一段，但不动后面的时段。
     *
     * 记的是「当前时段什么时候结束」，所以下一次时段照拦不误 ——
     * 放过的是一次专注，不是整个功能。
     *
     * 为什么留这个口子：拦得死死的应用会被直接卸载，
     * 卸了之后连那几秒的缓冲都没了。留条退路，人才愿意继续用它。
     */
    static void snoozeCurrent(Context ctx) {
        JSONObject cur = currentInterval(ctx);
        if (cur == null) return;
        prefs(ctx).edit().putLong(KEY_SNOOZE, cur.optLong("to", 0L)).apply();
    }

    static long snoozeUntil(Context ctx) {
        return prefs(ctx).getLong(KEY_SNOOZE, 0L);
    }

    static JSONArray intervals(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY_INTERVALS, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /**
     * 现在这一刻，这个包该不该被挡住。
     * 该挡就返回那条时段的标签（界面上要显示「专注中 · 晚自习」），
     * 不该挡返回 null。
     */
    static String blockedLabel(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return null;
        long now = System.currentTimeMillis();
        long snooze = snoozeUntil(ctx);
        JSONArray list = intervals(ctx);
        for (int i = 0; i < list.length(); i++) {
            JSONObject it = list.optJSONObject(i);
            if (it == null) continue;
            long to = it.optLong("to", 0L);
            // 刚点过「这次先算了」的那一段，剩下的时间不再拦
            if (to <= snooze) continue;
            if (now < it.optLong("from", 0L) || now >= to) continue;
            JSONArray pkgs = it.optJSONArray("packages");
            if (pkgs == null) continue;
            for (int j = 0; j < pkgs.length(); j++) {
                if (pkg.equals(pkgs.optString(j))) {
                    return it.optString("label", "专注");
                }
            }
        }
        return null;
    }

    /** 当前正在生效的那条时段（用来显示「还有多久」） */
    static JSONObject currentInterval(Context ctx) {
        long now = System.currentTimeMillis();
        long snooze = snoozeUntil(ctx);
        JSONArray list = intervals(ctx);
        for (int i = 0; i < list.length(); i++) {
            JSONObject it = list.optJSONObject(i);
            if (it == null) continue;
            long to = it.optLong("to", 0L);
            if (to <= snooze) continue;
            if (now >= it.optLong("from", 0L) && now < to) return it;
        }
        return null;
    }

    // ---------- 权限 ----------

    /** 无障碍服务开了没 */
    static boolean isEnabled(Context ctx) {
        String want = new ComponentName(ctx, FocusAccessibilityService.class).flattenToString();
        String flat = new ComponentName(ctx, FocusAccessibilityService.class).flattenToShortString();

        String enabled = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        TextUtils.SimpleStringSplitter sp = new TextUtils.SimpleStringSplitter(':');
        sp.setString(enabled);
        while (sp.hasNext()) {
            String s = sp.next();
            if (s.equalsIgnoreCase(want) || s.equalsIgnoreCase(flat)) return true;
        }
        return false;
    }

    static boolean serviceRunning() {
        return FocusAccessibilityService.isRunning();
    }

    // ---------- 应用列表 ----------

    /** 能启动的应用。系统应用也列出来，但标上 system，让用户自己决定 */
    static List<AppInfo> launcherApps(Context ctx) {
        PackageManager pm = ctx.getPackageManager();
        android.content.Intent main = new android.content.Intent(android.content.Intent.ACTION_MAIN);
        main.addCategory(android.content.Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);

        List<AppInfo> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        String self = ctx.getPackageName();

        for (ResolveInfo ri : list) {
            if (ri.activityInfo == null) continue;
            String pkg = ri.activityInfo.packageName;
            if (pkg == null || pkg.equals(self) || !seen.add(pkg)) continue;
            CharSequence label = ri.loadLabel(pm);
            boolean system = false;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            } catch (Exception ignored) {
                /* 拿不到就当普通应用 */
            }
            out.add(new AppInfo(pkg, label == null ? pkg : label.toString(), system));
        }
        Collections.sort(out, new Comparator<AppInfo>() {
            @Override
            public int compare(AppInfo a, AppInfo b) {
                // 系统应用沉到最后：要锁的通常不是它们
                if (a.system != b.system) return a.system ? 1 : -1;
                return a.label.compareToIgnoreCase(b.label);
            }
        });
        return out;
    }

    static final class AppInfo {
        final String pkg;
        final String label;
        final boolean system;

        AppInfo(String pkg, String label, boolean system) {
            this.pkg = pkg;
            this.label = label;
            this.system = system;
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
