// =============================================================
// 拾光 · 录音
// 用 MediaRecorder 采音。各平台支持的编码不一样，按优先级挑一个能用的：
//   安卓/iOS: audio/mp4 或 audio/webm;codecs=opus
//   桌面 Chrome/Edge: audio/webm;codecs=opus
// =============================================================

export interface RecorderHandle {
  /** 停止录音并拿到音频数据 */
  stop: () => Promise<Blob>;
  /** 实时音量（0~1），用来画波形 */
  level: () => number;
  startedAt: number;
}

/** 录音时长上限，和后端保持一致 */
export const MAX_MS = 5 * 60 * 1000;

const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function isSecure(): boolean {
  if (typeof window === 'undefined') return true;
  return window.isSecureContext || location.hostname === 'localhost' || location.protocol === 'https:';
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* 老浏览器可能直接抛错 */
    }
  }
  return '';
}

export interface RecordResult {
  blob: Blob;
  base64: string;
  mime: string;
  durationMs: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(new Error('录音读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 开始录音
 * @param onError 出错回调（比如用户拒绝授权）
 */
export async function startRecording(onError?: (msg: string) => void): Promise<RecorderHandle> {
  if (!isSupported()) {
    throw new Error('当前环境不支持录音（需要 HTTPS 和较新的浏览器）');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 关掉浏览器自带的处理，保留人声原貌；失败会自动回退
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e: any) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('麦克风权限被拒绝了，请在浏览器或系统设置里允许后重试');
    }
    if (name === 'NotFoundError') {
      throw new Error('没有找到麦克风设备');
    }
    throw new Error(`无法打开麦克风：${e?.message || name || '未知错误'}`);
  }

  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks: BlobPart[] = [];
  const startedAt = Date.now();

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.onerror = () => onError?.('录音过程中出错了');
  rec.start(1000); // 每秒切一个分片，避免长录音占内存

  // 音量分析（画波形用）
  let analyser: AnalyserNode | null = null;
  let data: Uint8Array<ArrayBuffer> | null = null;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    }
  } catch {
    // 画不了波形不影响录音
  }

  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    try {
      analyser?.disconnect();
    } catch {
      /* ignore */
    }
  };

  return {
    startedAt,
    level() {
      if (!analyser || !data) return 0;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // 放大一下，说话时波形更明显
      return Math.min(1, rms * 4.5);
    },
    stop(): Promise<Blob> {
      return new Promise<Blob>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const type = rec.mimeType || mime || 'audio/webm';
          resolve(new Blob(chunks, { type }));
        };
        if (rec.state === 'inactive') {
          cleanup();
          return finish();
        }
        rec.onstop = () => {
          cleanup();
          finish();
        };
        try {
          rec.stop();
        } catch {
          cleanup();
          finish();
        }
        // 留一点时间让最后一个分片到达
        setTimeout(() => {
          cleanup();
          finish();
        }, 600);
      });
    },
  };
}

/** 停止并拿到可上传的结果 */
export async function finishRecording(handle: RecorderHandle): Promise<RecordResult> {
  const blob: Blob = await handle.stop();
  if (!blob || !blob.size) throw new Error('没有录到声音，请检查麦克风');
  const durationMs = Math.min(MAX_MS, Date.now() - handle.startedAt);
  const mime = (blob.type || 'audio/webm').split(';')[0];
  return { blob, base64: await blobToBase64(blob), mime, durationMs };
}

/** 录音的可播放地址（本地预览用） */
export function previewUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function extOfMime(mime: string): string {
  const m = String(mime).split(';')[0];
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('aac')) return 'aac';
  return 'webm';
}
