package space.zhuangrongjian.shiguang;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;

/**
 * 拾光 · 学习模式的服务
 *
 * 它只干一件事：盯着「前台换成了哪个应用」，如果那个应用在当前锁定时段
 * 的黑名单里，就把拾光自己的全屏页盖上去。
 *
 * 这是安卓上唯一现实的做法。浏览器里做不到（没有任何 API 能阻止用户切应用），
 * 而且系统不允许 App 自己打开这个权限，必须用户手动去「无障碍」里开。
 *
 * 隐私：这里只读**包名**，不读屏幕内容。
 * accessibility_service_config.xml 里 canRetrieveWindowContent=false，
 * 系统层面就拿不到任何界面文字。
 */
public class FocusAccessibilityService extends AccessibilityService {

    private static volatile FocusAccessibilityService instance;

    /** 上一次盖住是什么时候。防止用户连点返回时反复启动 Activity */
    private long lastBlockAt = 0L;
    /** 刚盖过之后短暂放行，否则从盖住页回桌面那一下又会被自己拦一次 */
    private String lastBlockedPkg = null;

    static boolean isRunning() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            // 只要窗口变化，不需要内容变化（省电，也少读东西）
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.notificationTimeout = 80;
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            setServiceInfo(info);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        handle(pkg.toString());
    }

    private void handle(String pkg) {
        // 自己的界面永远放行，否则会自己盖自己
        if (pkg.equals(getPackageName())) {
            lastBlockedPkg = null;
            return;
        }
        String label = ShiguangFocus.blockedLabel(this, pkg);
        if (label == null) {
            lastBlockedPkg = null;
            return;
        }

        long now = SystemClock.elapsedRealtime();
        // 同一个应用刚盖过，两秒内不重复盖：用户按返回键会立刻又触发一次事件，
        // 不防的话会看到盖住页闪个不停
        if (pkg.equals(lastBlockedPkg) && now - lastBlockAt < 2000) return;
        lastBlockedPkg = pkg;
        lastBlockAt = now;

        Intent i = new Intent(this, FocusOverlayActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        i.putExtra(FocusOverlayActivity.EXTRA_LABEL, label);
        try {
            startActivity(i);
        } catch (Exception ignored) {
            // 有些 ROM 在后台禁止启动 Activity，那就退回桌面
            performGlobalAction(GLOBAL_ACTION_HOME);
        }
    }

    @Override
    public void onInterrupt() {
        /* 不需要处理 */
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }
}
