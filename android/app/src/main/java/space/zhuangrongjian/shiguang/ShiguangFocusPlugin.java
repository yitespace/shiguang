package space.zhuangrongjian.shiguang;

import android.content.Intent;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.util.List;

/**
 * 拾光 · 学习模式插件（JS 侧见 src/lib/native.ts）
 *
 * 它自己不判断「现在该不该锁」——那是 JS 算好推过来的。
 * 这里只负责：查权限、列应用、存时段、跳设置页。
 */
@CapacitorPlugin(name = "ShiguangFocus")
public class ShiguangFocusPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        boolean enabled = ShiguangFocus.isEnabled(getContext());
        ret.put("enabled", enabled);
        ret.put("running", ShiguangFocus.serviceRunning());
        if (enabled && !ShiguangFocus.serviceRunning()) {
            // 权限开着但服务没跑：多半被系统省电策略清掉了
            ret.put("note", "权限是开着的，但服务被系统清掉了。去「设置 → 应用 → 拾光」里允许自启动和后台运行。");
        } else if (!enabled) {
            ret.put("note", "还没打开无障碍权限。");
        } else {
            ret.put("note", "");
        }
        call.resolve(ret);
    }

    /** 跳到系统的无障碍设置页。系统不允许 App 自己打开这个权限，只能把人送过去 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开无障碍设置页：" + e.getMessage());
        }
    }

    /** 列出能启动的应用，给用户勾 */
    @PluginMethod
    public void listApps(PluginCall call) {
        List<ShiguangFocus.AppInfo> apps = ShiguangFocus.launcherApps(getContext());
        JSArray arr = new JSArray();
        for (ShiguangFocus.AppInfo a : apps) {
            JSObject o = new JSObject();
            o.put("package", a.pkg);
            o.put("label", a.label);
            o.put("system", a.system);
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("apps", arr);
        call.resolve(ret);
    }

    /**
     * 同步锁定时段。
     * intervals 已经是 JS 展开好的具体时刻：[{from, to, label, packages:[...]}]
     */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray got = call.getArray("intervals");
        JSONArray intervals = got == null ? new JSONArray() : got;
        ShiguangFocus.save(getContext(), intervals);
        JSObject ret = new JSObject();
        ret.put("count", intervals.length());
        call.resolve(ret);
    }

    /** 现在这一刻是什么状态（界面上要显示「正在专注」） */
    @PluginMethod
    public void current(PluginCall call) {
        JSObject ret = new JSObject();
        org.json.JSONObject cur = ShiguangFocus.currentInterval(getContext());
        if (cur == null) {
            ret.put("blocking", false);
        } else {
            ret.put("blocking", true);
            ret.put("label", cur.optString("label", "专注"));
            ret.put("to", cur.optLong("to", 0L));
        }
        ret.put("enabled", ShiguangFocus.isEnabled(getContext()));
        call.resolve(ret);
    }
}
