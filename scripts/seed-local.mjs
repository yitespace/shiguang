// =============================================================
// 本地联调用：往本地服务灌一批贴近真实使用的示例数据
// 用法：node scripts/seed-local.mjs            （默认 http://127.0.0.1:8787）
// 账号是手机号，默认用 13800138000 / test-pass-1（可用 TEST_PHONE / PASSWORD 覆盖）
//       BASE=http://127.0.0.1:8787 node scripts/seed-local.mjs
// 注意：只在本地联调使用，线上部署前会清空数据目录
// =============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const PHONE = process.env.TEST_PHONE || '13800138000';
const PASSWORD = process.env.PASSWORD || 'test-pass-1';

let cookie = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sg_session=')) cookie = kv;
  }
  return res.json();
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

/** 生成某天某个时刻的时间戳 */
function at(daysBack, hour, minute = 0) {
  const d = daysAgo(daysBack);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

// 内容取自用户自己的真实语境（工作 / 软考 / 健康 / 博客），便于检验 AI 回忆质量
const DATA = [
  // —— 3 天前 ——
  { d: 3, h: 9, m: 20, content: '和综治平台对接接口，确认了字段命名规范，他们那边要求统一用下划线风格', tags: ['工作'], mood: 4 },
  { d: 3, h: 14, m: 10, content: '做沈警官的 RPA 代码，把批量导出的流程串起来了，还差异常重试', tags: ['工作', 'RPA'], mood: 4 },
  { d: 3, h: 20, m: 30, content: '睡前刷了 40 道软考的项目管理真题，错的都是进度压缩那块', tags: ['软考', '学习'], mood: 3 },

  // —— 2 天前 ——
  { d: 2, h: 10, m: 5, content: '场地系统又有人反馈导出乱码，定位到是 CSV 没加 BOM，改了', tags: ['工作'], mood: 3 },
  { d: 2, h: 15, m: 40, content: '帮新人小陈调分页，SQL 少了个 where 条件，他第一次独立提 PR', tags: ['工作', '带人'], mood: 5 },
  { d: 2, h: 19, m: 0, content: '晚上跑了 5 公里，配速 6 分 10 秒，比上周快了一点', tags: ['健康'], mood: 5 },

  // —— 昨天 ——
  { d: 1, h: 9, m: 45, content: '沈警官的 RPA 加了重试和日志，跑了 30 条数据全部通过，交付给他了', tags: ['工作', 'RPA'], mood: 5 },
  { d: 1, h: 11, m: 30, content: '把博客从旧主题迁到 Astro，顺手把部署脚本改成 rsync + Caddy 热加载', tags: ['博客', '工作'], mood: 4 },
  { d: 1, h: 16, m: 20, content: '软考报名信息核对了一遍，中级系统集成工程师，考试在 11 月', tags: ['软考'], mood: 4 },
  { d: 1, h: 22, m: 15, content: '凌晨前把阿里云那台 ECS 的备份脚本改成 7 日 + 4 周轮转', tags: ['运维'], mood: 3 },

  // —— 今天 ——
  { d: 0, h: 9, m: 10, content: '早起把昨天 RPA 的交付文档补完了，写清楚怎么配置和怎么排查', tags: ['工作', 'RPA'], mood: 4 },
  { d: 0, h: 11, m: 0, content: '和综治平台开了个短会，下周要对接收费模块，说好先出接口文档', tags: ['工作'], mood: 3 },
  { d: 0, h: 14, m: 30, content: '给自己做了个记笔记的小网站，前后端一起写完，部署到自己的服务器上', tags: ['项目', '拾光'], mood: 5 },
];

async function main() {
  const login = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  if (!login.ok) {
    console.error('登录失败：', login.error);
    process.exit(1);
  }

  // 清掉已有记录，保证可重复执行
  const existing = await api('/api/entries?limit=2000');
  for (const e of existing.data?.entries || []) {
    await api(`/api/entries/${e.id}`, { method: 'DELETE' });
  }

  let n = 0;
  for (const item of DATA) {
    const ts = at(item.d, item.h, item.m);
    const res = await api('/api/entries', {
      method: 'POST',
      body: {
        content: item.content,
        tags: item.tags,
        mood: item.mood,
        createdAt: ts,
        date: ymd(new Date(ts)),
      },
    });
    if (res.ok) n++;
    else console.error('写入失败', res.error);
  }

  const stats = await api('/api/stats');
  console.log(`已写入 ${n} 条示例记录`);
  console.log(`统计：${stats.data.total} 条 / ${stats.data.days} 天 / 连续 ${stats.data.streak} 天`);
  for (let i = 0; i < 3; i++) {
    console.log(`  ${ymd(daysAgo(i))} 应有记录`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
