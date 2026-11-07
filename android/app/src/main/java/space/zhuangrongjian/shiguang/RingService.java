package space.zhuangrongjian.shiguang;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * 拾光 · 响铃服务
 *
 * 闹钟到点之后真正「响起来」的地方：循环播放闹铃 + 持续震动，
 * 直到用户在前面那屏点了按钮。
 *
 * 为什么必须是一个前台服务：
 *   普通的 MediaPlayer 在应用退到后台甚至进程被杀之后就停了，
 *   而吃药提醒最需要它响的时候，恰恰是用户根本没打开 App 的时候。
 *   前台服务带一条常驻通知，系统不会随便回收。
 *
 * 铃声用系统闹钟音（DEFAULT_ALARM_ALERT_URI），它本身就够醒，
 * 而且跟随用户的系统设置 —— 换成我们自带的音频反而会被静音策略吃掉。
 */
public class RingService extends Service {

    public static final String ACTION_START = "space.zhuangrongjian.shiguang.RING_START";
    public static final String ACTION_STOP = "space.zhuangrongjian.shiguang.RING_STOP";
    private static final String CH = "shiguang_ring";
    private static final int NOTIF_ID = 7801;

    private MediaPlayer player;
    private Vibrator vib;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 震动波形：响 600ms、停 400ms，循环 */
    private static final long[] PATTERN = { 0, 600, 400, 600, 400, 900, 500 };
    private final Runnable buzz = new Runnable() {
        @Override
        public void run() {
            if (vib == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createWaveform(PATTERN, 0));
            } else {
                vib.vibrate(PATTERN, 0);
            }
        }
    };

    public static void start(Context ctx, String title, String body) {
        Intent i = new Intent(ctx, RingService.class);
        i.setAction(ACTION_START);
        i.putExtra("title", title);
        i.putExtra("body", body);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void stop(Context ctx) {
        Intent i = new Intent(ctx, RingService.class);
        i.setAction(ACTION_STOP);
        try {
            ctx.startService(i);
        } catch (Exception ignored) {
            /* 服务没在跑就算了 */
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (ACTION_STOP.equals(action)) {
            quiet();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            String title = intent.getStringExtra("title");
            String body = intent.getStringExtra("body");
            goForeground(title == null ? "该吃药了" : title, body == null ? "" : body);
            playRingtone();
            startVibration();
            return START_STICKY;
        }
        return START_NOT_STICKY;
    }

    private void goForeground(String title, String body) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CH) == null) {
                NotificationChannel c = new NotificationChannel(CH, "正在响的提醒", NotificationManager.IMPORTANCE_LOW);
                c.setSound(null, null);
                c.enableVibration(false);
                c.setShowBadge(false);
                nm.createNotificationChannel(c);
            }
        }
        Intent open = new Intent(this, MedAlarmActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 7801, open, flags);

        Notification n = new Notification.Builder(this, Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? CH : "")
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(R.drawable.ic_stat_shiguang)
                .setContentIntent(pi)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // 少数 ROM 不允许前台服务，退化成普通通知也要能响
        }
    }

    private void playRingtone() {
        if (player != null) return;
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (uri == null) return;
        try {
            player = new MediaPlayer();
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            player.setAudioAttributes(attrs);
            player.setDataSource(this, uri);
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception e) {
            player = null;
        }
    }

    private void startVibration() {
        if (vib == null) vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        handler.post(buzz);
    }

    private void quiet() {
        handler.removeCallbacks(buzz);
        if (vib != null) {
            try {
                vib.cancel();
            } catch (Exception ignored) {
                /* 忽略 */
            }
        }
        if (player != null) {
            try {
                if (player.isPlaying()) player.stop();
            } catch (Exception ignored) {
                /* 忽略 */
            }
            player.release();
            player = null;
        }
        try {
            stopForeground(true);
        } catch (Exception ignored) {
            /* 忽略 */
        }
    }

    @Override
    public void onDestroy() {
        quiet();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
