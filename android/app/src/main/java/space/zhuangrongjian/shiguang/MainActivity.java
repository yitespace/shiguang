package space.zhuangrongjian.shiguang;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * 拾光 · 安卓入口
 *
 * 两个自己写的插件：
 *   ShiguangNotify  本地提醒 / 闹钟（npm 装不了 Capacitor 插件，只能手写）
 *   ShiguangFocus   学习模式的应用锁（走无障碍服务）
 *
 * 注册必须放在 super.onCreate() 之前，否则 Bridge 起来的时候插件还没挂上。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShiguangNotifyPlugin.class);
        registerPlugin(ShiguangFocusPlugin.class);
        super.onCreate(savedInstanceState);
        ShiguangNotify.ensureChannels(this);
    }
}
