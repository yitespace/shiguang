// =============================================================
// 拾光 · 原子写文件
//
// 写到临时文件再 rename，避免进程被杀时留下半个文件。
// 临时文件名里必须带一个进程内自增序号：只用 pid 的话，
// 同一个进程里两个并发写会撞到同一个临时文件——先完成的那个把它
// rename 走了，后一个的 rename 直接 ENOENT。
// 线上新用户第一次登录时 /api/stats 和 /api/memories 同时打进来，
// 就是这么 500 的。这个坑踩过一次，别再把序号去掉。
// =============================================================

import fsp from 'node:fs/promises';

let seq = 0;

export async function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${++seq}`;
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    // rename 失败时把临时文件收掉，别在数据目录里留垃圾
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
