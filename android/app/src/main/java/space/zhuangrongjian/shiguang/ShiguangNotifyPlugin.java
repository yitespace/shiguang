package space.zhuangrongjian.shiguang;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 拾光 · 提醒插件（JS 侧见 src/lib/native.ts）
 *
 * 前端每次改完药或者提醒，都会调一次 schedule() 把整份时间表推过来。
 * 这里只负责照着排系统闹钟，不做任何时间推理。
 */
@CapacitorPlugin(
        name = "ShiguangNotify",
        permissions = { @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class ShiguangNotifyPlugin extends Plugin {

    /** 能力状态。界面上那张卡直接显示这些字段，不粉饰 */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted = getPermissionState("notify").toString().equals("granted")
                    && ShiguangNotify.notificationsAllowed(getContext());
        } else {
            granted = ShiguangNotify.notificationsAllowed(getContext());
        }
        ret.put("permission", granted ? "granted" : "prompt");
        ret.put("exactAlarm", ShiguangNotify.canExact(getContext()));
        ret.put("fullScreen", ShiguangNotify.canFullScreen(getContext()));
        ret.put("note", buildNote(granted));
        call.resolve(ret);
    }

    private String buildNote(boolean granted) {
        if (!granted) return "还没给拾光通知权限，到点不会有任何提示。";
        if (!ShiguangNotify.canExact(getContext())) {
            return "没有「闹钟与提醒」权限，提醒可能会晚几分钟到。去系统设置里允许一下就能准时。";
        }
        if (!ShiguangNotify.canFullScreen(getContext())) {
            return "没有全屏提醒权限，闹钟模式的提醒只会出现在通知栏，锁屏时可能看不到。";
        }
        return "App 关着也能准时提醒。";
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("permission", ShiguangNotify.notificationsAllowed(getContext()) ? "granted" : "denied");
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notify", call, "notifyPermCallback");
    }

    @PermissionCallback
    private void notifyPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", getPermissionState("notify").toString());
        call.resolve(ret);
    }

    /** 跳到系统的通知 / 闹钟 / 全屏提醒设置页 */
    @PluginMethod
    public void openSettings(PluginCall call) {
        ShiguangNotify.openSettings(getContext(), call.getString("which", "app"));
        call.resolve();
    }

    /** 整份重排。items: [{id, at, title, body, alarm}] */
    @PluginMethod
    public void schedule(PluginCall call) {
        // Capacitor 的 getArray 返回的是 JSArray（JSONArray 的子类）。
        // 没传就当成空表 —— 空表是合法的，表示「全部取消」。
        JSArray got = call.getArray("items");
        JSONArray items = got == null ? new JSONArray() : got;
        int n = ShiguangNotify.schedule(getContext(), items);
        JSObject ret = new JSObject();
        ret.put("count", n);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        ShiguangNotify.cancelAll(getContext());
        call.resolve();
    }

    /** 立刻弹一条，让用户确认「真的收得到」 */
    @PluginMethod
    public void test(PluginCall call) {
        ShiguangNotify.show(getContext(), "sg-test-" + System.currentTimeMillis(),
                "拾光", "提醒长这样。到点你就会看到它。", false);
        call.resolve();
    }

    /** 调试用：看看现在存了哪些排程 */
    @PluginMethod
    public void list(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.SharedPreferences p =
                    getContext().getSharedPreferences("shiguang_notify", android.content.Context.MODE_PRIVATE);
            ret.put("raw", p.getString("schedule", "[]"));
        } catch (Exception e) {
            ret.put("raw", "[]");
        }
        call.resolve(ret);
    }
}
