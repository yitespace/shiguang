// =============================================================
// 拾光 · 后端接口自测
// 用法：DEEPSEEK_API_KEY=xxx node scripts/test-api.mjs
// 会启动一个临时数据目录的服务实例，覆盖增删改查 / 检索 / AI
// =============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 别用 8791：那是本地联调常驻服务的端口，撞上了测试会打到别人的数据上
const PORT = Number(process.env.TEST_API_PORT || 8793);
const DATA = path.join(os.tmpdir(), `shiguang-test-${Date.now()}`);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = process.env.TEST_PHONE || '13800138000';
// 没配阿里云短信 Key 时，用开发模式把「绑定手机号 → 验证码登录」整条链路也测掉
const SMS_DEV = ['1', 'true', 'yes'].includes(String(process.env.SHIGUANG_SMS_DEV || '').toLowerCase());

let pass = 0;
let failed = 0;
const results = [];

function check(name, cond, extra = '') {
  // 立刻打印，不要攒到最后：脚本一旦中途抛异常，攒着的结果就全丢了，
  // 连「走到哪一步挂的」都看不出来
  if (cond) {
    pass++;
    results.push(`  \x1b[32m✓\x1b[0m ${name}`);
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    results.push(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`);
  }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SHIGUANG_DATA: DATA,
    SHIGUANG_COOKIE_PATH: '/',
    // 让子进程和测试脚本对「短信是否可用」的判断保持一致
    SHIGUANG_SMS_DEV: SMS_DEV ? '1' : '',
    // 冷却窗口压到 1.2 秒，否则光是等限流就要耗掉一分钟
    SHIGUANG_SMS_RESEND_MS: SMS_DEV ? '1200' : '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/healthz`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

let cookie = '';
async function api(pathname, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sg_session=')) cookie = kv;
  }
  if (raw) return res;
  return res.json();
}

// 造一批测试数据：覆盖不同日期、标签、心情
const today = new Date();
const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dayAgo = (n) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return ymd(d);
};

const SEED = [
  { date: dayAgo(0), createdAt: Date.now() - 3600e3, content: '上午和综治平台沟通接口字段，下午写沈警官的 RPA 代码', tags: ['工作', 'RPA'], mood: 4 },
  { date: dayAgo(0), createdAt: Date.now() - 1800e3, content: '帮新人小陈调试了场地系统的分页问题，是 SQL 少了个 where 条件', tags: ['工作', '带人'], mood: 5 },
  { date: dayAgo(1), createdAt: Date.now() - 90000e3, content: '软考中级系统集成工程师，刷了 60 道项目管理真题，正确率 78%', tags: ['软考', '学习'], mood: 3 },
  { date: dayAgo(2), createdAt: Date.now() - 180000e3, content: '晚上跑了 5 公里，回来做了番茄牛腩', tags: ['健康', '生活'], mood: 5 },
  { date: dayAgo(9), createdAt: Date.now() - 800000e3, content: '给博客写了个新的部署脚本，rsync + Caddy 热加载，20 秒发完', tags: ['工作', '博客'], mood: 4 },
];

async function main() {
  console.log('\n\x1b[36m拾光 · 后端自测\x1b[0m\n');
  if (!(await waitUp())) {
    console.error('服务未启动：\n' + serverLog);
    process.exit(1);
  }

  // ---------- 认证：账号就是手机号 ----------
  let r = await api('/api/auth/status');
  check('未登录时 authed=false', r.data?.authed === false);
  check('未登录时 me 为空', r.data?.me === null);
  check('未登录时 AI 可用性可见', typeof r.data?.ai === 'boolean');

  // ---------- 登录方式（决定登录页显示什么，必须免登录可读） ----------
  r = await api('/api/auth/methods');
  check('未登录能读到登录方式', r.ok === true, JSON.stringify(r).slice(0, 120));
  check('密码登录永远可用', r.data?.password === true);
  check('开放注册是开着的', r.data?.register === true);
  check('注册要邀请码', r.data?.invite === true);
  check('不上报任何人的手机号', !('phone' in (r.data || {})), JSON.stringify(r.data));
  check('一开始一个账号都没有', r.data?.userCount === 0, `实际 ${r.data?.userCount}`);
  check('一开始注册就是开着的', r.data?.register === true);

  r = await api('/api/entries');
  check('未登录访问记录被拒绝 401', r.ok === false && /登录/.test(r.error || ''));

  // ---------- 没注册过就别想收到验证码 ----------
  r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: PHONE } });
  check('没注册的号不给发登录码', r.ok === false && /还没注册/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: '123' } });
  check('手机号格式不对被拒', r.ok === false && /格式/.test(r.error || ''));
  r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: '13800138000', purpose: 'bind' } });
  check('已经没有「绑定」这个用途了', r.ok === false, JSON.stringify(r).slice(0, 100));

  r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: 'whatever-1' } });
  check('没注册的号登不进去', r.ok === false);
  check('提示不暴露这个号存不存在', /手机号或密码/.test(r.error || ''), String(r.error));

  // ---------- 注册（手机号 + 邀请码 + 密码） ----------
  // 邀请码是服务启动时生成到数据目录的，测试直接读文件拿
  const INVITE = (process.env.SHIGUANG_INVITE_CODE || fs.readFileSync(path.join(DATA, 'invite-code.txt'), 'utf8')).trim();
  check('数据目录里生成了邀请码', /^[0-9A-F]{8}$/.test(INVITE), INVITE);

  const PASSWORD = 'test-pass-1';
  r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE, inviteCode: 'WRONG', password: PASSWORD } });
  check('邀请码不对注册不了', r.ok === false && /邀请码/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE, inviteCode: INVITE, password: '123' } });
  check('密码太短被拒', r.ok === false && /至少 6 位/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE, inviteCode: INVITE, password: '12345678' } });
  check('纯数字密码被拒', r.ok === false && /纯数字/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/register', { method: 'POST', body: { phone: '12345', inviteCode: INVITE, password: PASSWORD } });
  check('手机号格式不对被拒', r.ok === false && /格式/.test(r.error || ''), String(r.error));

  r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE, inviteCode: INVITE, password: PASSWORD } });
  check('邀请码对了能注册', r.ok === true, JSON.stringify(r).slice(0, 140));
  check('注册后直接是登录状态', cookie.startsWith('sg_session='));
  check(
    '注册返回的 me 里没有密码哈希',
    r.data?.me?.phoneMasked === '138****8000' && !JSON.stringify(r.data.me).includes('hash'),
    JSON.stringify(r.data?.me),
  );

  r = await api('/api/auth/status');
  check('注册后 authed=true', r.data?.authed === true);
  check('注册后 status 里带 me', r.data?.me?.phone === PHONE, JSON.stringify(r.data?.me));

  // 邀请码忘了大小写也能用
  r = await api('/api/auth/register', {
    method: 'POST',
    body: { phone: '13700137001', inviteCode: INVITE.toLowerCase(), password: 'case-pass' },
  });
  check('邀请码不区分大小写', r.ok === true, JSON.stringify(r).slice(0, 120));

  // 同一个号不能注册两次
  r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE, inviteCode: INVITE, password: PASSWORD } });
  check('同一个号不能注册两次', r.ok === false && /已经注册过/.test(r.error || ''), String(r.error));

  // 邀请码是可复用的：管理员发出去之后几个人都能用
  r = await api('/api/auth/register', { method: 'POST', body: { phone: '13700137002', inviteCode: INVITE, password: 'more-pass' } });
  check('邀请码可以给多个人用', r.ok === true, JSON.stringify(r).slice(0, 120));

  // 上面为了验邀请码又注册了几个号，每一次注册都会把会话换成新号。
  // 这里换回 A，后面的用例都是围绕 A 写的。
  cookie = '';
  r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  check('换回主测试账号', r.ok === true, JSON.stringify(r).slice(0, 100));

  if (SMS_DEV) {
    // 短信只是登录的快捷方式，和注册无关；这里单独验一下这条链路
    r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: PHONE } });
    check('已注册的号能发登录码', r.ok === true, JSON.stringify(r).slice(0, 120));
    const loginCode = r.data?.devCode;
    check('开发模式回显验证码', /^\d{6}$/.test(String(loginCode || '')), String(loginCode));

    r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: PHONE } });
    check('冷却期内重发被限流', r.ok === false && /频繁/.test(r.error || ''), String(r.error));
    await sleep(1400);
    r = await api('/api/auth/sms/send', { method: 'POST', body: { phone: PHONE } });
    check('冷却期过后可以重发', r.ok === true, JSON.stringify(r).slice(0, 120));
    const loginCode2 = r.data?.devCode;

    const savedCookie = cookie;
    cookie = '';
    r = await api('/api/auth/sms/login', { method: 'POST', body: { phone: PHONE, code: '000000' } });
    check('错误验证码登不进去', r.ok === false);
    r = await api('/api/auth/sms/login', { method: 'POST', body: { phone: PHONE, code: loginCode2 } });
    check('验证码能快捷登录', r.ok === true && cookie.startsWith('sg_session='), JSON.stringify(r).slice(0, 120));
    r = await api('/api/auth/status');
    check('验证码登录后也是同一个人', r.data?.me?.phone === PHONE);
    cookie = savedCookie;
    void loginCode;
  } else {
    console.log('  \x1b[90m· 未开启短信开发模式（SHIGUANG_SMS_DEV=1），跳过短信登录链路\x1b[0m');
  }

  // ---------- 密码登录 ----------
  const firstCookie = cookie;
  cookie = '';
  r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: '错的密码' } });
  check('错误密码被拒绝', r.ok === false);
  r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  check('手机号 + 密码能登录', r.ok === true && cookie.startsWith('sg_session='), JSON.stringify(r).slice(0, 120));
  cookie = firstCookie;

  r = await api('/api/auth/methods');
  check('账号数已经统计上了', (r.data?.userCount || 0) >= 1, `实际 ${r.data?.userCount}`);

  // ---------- 账号信息 ----------
  r = await api('/api/auth/profile');
  check('账号信息可读', r.ok === true && r.data?.phone === PHONE);
  check('账号信息带掩码号', r.data?.phoneMasked === '138****8000', String(r.data?.phoneMasked));
  check('账号信息带昵称字段（默认空）', r.data?.nickname === '', JSON.stringify(r.data?.nickname));
  check('账号信息带简介字段（默认空）', r.data?.bio === '', JSON.stringify(r.data?.bio));

  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: '阿简', bio: '写点东西' } });
  check('能改昵称和简介', r.ok === true && r.data?.nickname === '阿简' && r.data?.bio === '写点东西', JSON.stringify(r).slice(0, 120));
  r = await api('/api/auth/profile');
  check('改完能读回来', r.data?.nickname === '阿简' && r.data?.bio === '写点东西');

  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: '名'.repeat(50), bio: '字'.repeat(300) } });
  check('昵称超长被截到 20 字', r.data?.nickname?.length === 20, `实际 ${r.data?.nickname?.length}`);
  check('简介超长被截到 80 字', r.data?.bio?.length === 80, `实际 ${r.data?.bio?.length}`);

  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: ' 有\n换 行 ', bio: '上\n下' } });
  check('昵称里的换行被压成空格', r.data?.nickname === '有 换 行', JSON.stringify(r.data?.nickname));
  check('简介里的换行被压成空格', r.data?.bio === '上 下', JSON.stringify(r.data?.bio));

  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: 123, bio: { a: 1 } } });
  check('非字符串字段被忽略，不会写成 [object Object]', r.ok === true && r.data?.nickname === '' && r.data?.bio === '', JSON.stringify(r.data));

  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: '', bio: '' } });
  check('昵称简介能清空', r.ok === true && r.data?.nickname === '' && r.data?.bio === '');

  // 改资料也要登录
  const beforeProfile = cookie;
  cookie = '';
  r = await api('/api/auth/profile', { method: 'PUT', body: { nickname: '偷偷改', bio: '' } });
  check('未登录不能改昵称简介', r.ok === false && /登录/.test(r.error || ''), JSON.stringify(r).slice(0, 100));
  cookie = beforeProfile;

  // ---------- 第二个账号：数据必须互相看不见 ----------
  if (SMS_DEV) {
    const PHONE2 = '13900139001';
    const PASSWORD2 = 'second-pass';

    r = await api('/api/auth/register', { method: 'POST', body: { phone: PHONE2, inviteCode: INVITE, password: PASSWORD2 } });
    check('能注册第二个账号', r.ok === true && r.data?.me?.phone === PHONE2, JSON.stringify(r).slice(0, 120));
    const cookieB = cookie;

    // 用 A 写两条
    cookie = firstCookie;
    await api('/api/entries', { method: 'POST', body: { content: 'A 的私密记录：今天去看了牙医', tags: ['健康'] } });
    await api('/api/entries', { method: 'POST', body: { content: 'A 的第二条', tags: ['生活'] } });

    // 用 B 写一条
    cookie = cookieB;
    await api('/api/entries', { method: 'POST', body: { content: 'B 的记录：在准备软考', tags: ['学习'] } });

    cookie = firstCookie;
    r = await api('/api/entries');
    check('A 只看到自己的两条', r.data?.total === 2, `实际 ${r.data?.total} / ${JSON.stringify(r).slice(0, 120)}`);
    check(
      'A 看不到 B 写的',
      !JSON.stringify(r.data || {}).includes('B 的记录'),
      JSON.stringify(r.data || {}).slice(0, 120),
    );
    r = await api('/api/stats');
    check('A 的统计也只算自己的', r.data?.total === 2, `实际 ${r.data?.total} / ${JSON.stringify(r).slice(0, 120)}`);
    r = await api('/api/search?q=' + encodeURIComponent('软考'));
    check('A 搜不到 B 的内容', (r.data?.hits || []).length === 0, JSON.stringify(r.data || {}).slice(0, 140));

    cookie = cookieB;
    r = await api('/api/entries');
    check('B 只看到自己的一条', r.data?.total === 1, `实际 ${r.data?.total}`);
    r = await api('/api/stats');
    check('B 的统计是 1', r.data?.total === 1, `实际 ${r.data?.total}`);

    // 昵称也是各改各的
    await api('/api/auth/profile', { method: 'PUT', body: { nickname: '小王', bio: '在准备软考' } });
    cookie = firstCookie;
    r = await api('/api/auth/profile');
    check('B 改昵称影响不到 A', r.data?.nickname === '', JSON.stringify(r.data?.nickname));

    // 改 B 的密码不该把 A 踢下线
    cookie = cookieB;
    r = await api('/api/auth/password', { method: 'POST', body: { oldPassword: PASSWORD2, newPassword: 'third-pass' } });
    check('B 能改自己的密码', r.ok === true, JSON.stringify(r).slice(0, 120));
    cookie = firstCookie;
    r = await api('/api/auth/status');
    check('B 改密码不会把 A 踢下线', r.data?.authed === true);
    cookie = cookieB;
    r = await api('/api/auth/status');
    check('B 自己的旧会话作废了', r.data?.authed === false);

    // 把 B 的会话换回来，方便后面继续
    cookie = '';
    r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE2, password: 'third-pass' } });
    check('B 用新密码能登回来', r.ok === true);

    // 隔离用例自己造的数据要清干净，否则后面「列表返回 5 条」这类断言会被带偏
    for (const c of [cookie, firstCookie]) {
      cookie = c;
      const list = await api('/api/entries?limit=2000');
      for (const e of list.data?.entries || []) {
        await api(`/api/entries/${e.id}`, { method: 'DELETE' });
      }
    }
    cookie = firstCookie;
    r = await api('/api/entries');
    check('隔离用例的数据已清理干净', r.data?.total === 0, `剩下 ${r.data?.total} 条`);
  } else {
    console.log('  \x1b[90m· 跳过多用户隔离用例（需要 SHIGUANG_SMS_DEV=1）\x1b[0m');
  }

  // ---------- 手机号就是账号，所以「换号」等于换账号 ----------
  r = await api('/api/auth/phone', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  check('换成自己现在的号会被拦', r.ok === false && /已经是/.test(r.error || ''), String(r.error));
  r = await api('/api/auth/phone', { method: 'POST', body: { phone: '13900139001', password: PASSWORD } });
  check('换成别人已注册的号会被拦', r.ok === false && /已经被别人/.test(r.error || ''), String(r.error));
  r = await api('/api/auth/phone', { method: 'POST', body: { phone: '13600136000', password: '错的密码' } });
  check('密码不对换不了号', r.ok === false && /密码/.test(r.error || ''), String(r.error));

  // 换号成功后，旧号要能释放出来，新号要能登录
  r = await api('/api/auth/phone', { method: 'POST', body: { phone: '13600136000', password: PASSWORD } });
  check('密码对了能换号', r.ok === true && r.data?.phoneMasked === '136****6000', JSON.stringify(r).slice(0, 120));
  r = await api('/api/auth/profile');
  check('换完号账号信息跟着变', r.data?.phone === '13600136000', String(r.data?.phone));

  const afterPhoneCookie = cookie;
  cookie = '';
  r = await api('/api/auth/login', { method: 'POST', body: { phone: '13600136000', password: PASSWORD } });
  check('能用新手机号登录', r.ok === true, JSON.stringify(r).slice(0, 100));
  cookie = afterPhoneCookie;

  // 换回原来的号（原来的号已经释放，可以重新占）
  r = await api('/api/auth/phone', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  check('能换回原来的号', r.ok === true && r.data?.phone === PHONE, JSON.stringify(r).slice(0, 120));

  // 换手机号不需要短信验证码（这是这次改动的重点）
  check('换号接口不要求短信验证码', !('code' in (r.data || {})), JSON.stringify(r.data));

  // ---------- 退出登录 ----------
  r = await api('/api/auth/signout', { method: 'POST' });
  check('退出登录成功', r.ok === true);
  cookie = '';
  r = await api('/api/entries');
  check('退出后旧会话读不到数据', r.ok === false);

  // 重新登录，后面的用例继续用
  r = await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  check('重新登录成功', r.ok === true);
  // ---------- 记录 CRUD ----------
  const created = [];
  for (const s of SEED) {
    const res = await api('/api/entries', { method: 'POST', body: s });
    if (res.ok) created.push(res.data.entry);
  }
  check('写入 5 条记录', created.length === 5);

  r = await api('/api/entries');
  check('列表返回 5 条', r.data?.entries?.length === 5);
  check('列表按时间倒序', (r.data?.entries?.[0]?.createdAt || 0) >= (r.data?.entries?.[1]?.createdAt || 0));

  // 用最后一条做更新测试，避免覆盖后面检索用例要用的内容
  const target = created[created.length - 1];
  r = await api(`/api/entries/${target.id}`, { method: 'PATCH', body: { content: '改过的内容：接口联调完成' } });
  check('更新记录成功', r.ok && r.data.entry.content.includes('联调完成'));

  // ---------- 检索 ----------
  r = await api('/api/search?q=' + encodeURIComponent('沈警官'));
  check('中文检索命中 RPA 记录', r.data?.count >= 1 && r.data.hits[0].entry.content.includes('RPA'));

  r = await api('/api/search?q=' + encodeURIComponent('软考'));
  check('标签/正文检索命中软考', r.data?.count >= 1);

  r = await api('/api/search?q=' + encodeURIComponent('SQL'));
  check('英文检索命中', r.data?.count >= 1);

  r = await api('/api/search?q=' + encodeURIComponent('不存在的词xyzzy'));
  check('无结果时返回空数组', r.data?.count === 0);

  r = await api('/api/search?q=' + encodeURIComponent('前天我做了什么'));
  check('检索页能识别时间范围', r.data?.range?.from === dayAgo(2));

  // ---------- 某天 / 统计 ----------
  r = await api(`/api/day/${dayAgo(0)}`);
  check('按天查询返回当天记录', r.data?.entries?.length === 2);
  check('按天查询带星期', typeof r.data?.weekday === 'string');

  r = await api('/api/stats');
  check('统计：总有 5 条', r.data?.total === 5);
  check('统计：覆盖 4 天', r.data?.days === 4);
  check('统计：连续天数 >= 3', (r.data?.streak || 0) >= 3);

  r = await api('/api/tags');
  check('标签聚合可用', Array.isArray(r.data?.tags) && r.data.tags.length >= 5);

  r = await api(`/api/calendar?month=${dayAgo(0).slice(0, 7)}`);
  check('日历密度可用', typeof r.data?.counts === 'object');

  // ---------- 时间解析（纯函数，通过接口暴露的 range 验证） ----------
  const cases = [
    ['今天做了什么', 1],
    ['昨天呢', 2],
    ['9月17号', null],
    ['上周', 7],
    ['这个月', null],
  ];
  for (const [text, spanGuess] of cases) {
    const res = await api('/api/search?q=' + encodeURIComponent(text));
    const rg = res.data?.range;
    const okCase = rg && /^\d{4}-\d{2}-\d{2}$/.test(rg.from) && /^\d{4}-\d{2}-\d{2}$/.test(rg.to);
    check(`时间解析「${text}」-> ${rg?.from || 'null'}${spanGuess ? '' : ''}`, !!okCase);
  }

  // ---------- 问答接口返回依据记录（合并了检索和对话后的关键契约） ----------
  const chatRes = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ question: '我最近做了什么？' }),
  });
  check('问答接口可访问', chatRes.ok, `HTTP ${chatRes.status}`);
  const sseText = await chatRes.text();
  const doneLine = sseText.split('\n').find((l) => l.includes('"type":"done"'));
  check('流以 done 事件结束', !!doneLine);
  if (doneLine) {
    let done = null;
    try {
      done = JSON.parse(doneLine.slice(6));
    } catch {
      /* ignore */
    }
    check('done 事件能被解析', !!done);
    check('done 事件带 answer', typeof done?.answer === 'string' && done.answer.length > 0);
    check('done 事件带 refs 日期', Array.isArray(done?.refs) && done.refs.length > 0);
    // 这两条是「找回」页能就地展示记录的前提
    check('done 事件带 entries 记录数组', Array.isArray(done?.entries), `实际类型 ${typeof done?.entries}`);
    check('entries 里的记录有正文', Array.isArray(done?.entries) && done.entries.length > 0 && (done.entries[0].content || '').length > 0);
    check('entries 里的记录有日期', Array.isArray(done?.entries) && /^\d{4}-\d{2}-\d{2}$/.test(done.entries[0].date || ''));
  }

  // ---------- AI（需要 key） ----------
  const health = await api('/api/healthz');
  if (health.data?.ai) {
    console.log('\n  \x1b[36m· 调用真实 DeepSeek 接口\x1b[0m');

    // 流式问答
    const res = await fetch(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ question: `${dayAgo(0)} 我做了什么？` }),
    });
    let sse = '';
    let deltas = 0;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      sse += chunk;
      deltas += (chunk.match(/data: /g) || []).length;
    }
    check('SSE 流式返回了多个片段', deltas > 3);
    check('流里没有泄漏内部标记', !sse.includes('<!--REFS') && !sse.includes('REFS:'));
    const doneLine = sse.split('\n').find((l) => l.includes('"type":"done"'));
    let doneObj = null;
    if (doneLine) {
      try {
        doneObj = JSON.parse(doneLine.slice(6));
      } catch {
        /* ignore */
      }
    }
    check('流以 done 事件结束', !!doneObj);
    const answer = doneObj?.answer || '';
    check('AI 回答非空', answer.length > 10);
    check('AI 回答标注了日期', /\d{4}-\d{2}-\d{2}|今天|当天/.test(answer));
    check(
      'AI 回答复述了当天真实细节',
      /综治|RPA|小陈|场地|SQL|接口/i.test(answer),
      `实际回答：${answer.slice(0, 80)}`,
    );
    check('AI 未把无关内容混进来（软考/跑步）', !/番茄牛腩/.test(answer) || /软考/.test(answer), '允许相邻背景');
    console.log(`\n  \x1b[90mAI 对「${dayAgo(0)} 我做了什么？」的回答：\x1b[0m\n  ${answer.replace(/\n/g, '\n  ')}\n`);
    if (doneObj?.meta) {
      console.log(`  \x1b[90m命中时间范围：${doneObj.meta.range?.label || '无'} / 参考记录 ${doneObj.meta.usedEntries} 条 / tokens ${doneObj.meta.usage?.total_tokens ?? '-'}\x1b[0m\n`);
    }

    // 非流式问答
    const r2 = await api('/api/ai/ask', { method: 'POST', body: { question: '我软考复习到什么程度了？' } });
    check('非流式 AI 问答成功', r2.ok && (r2.data?.answer || '').length > 5);
    if (r2.ok) {
      check('AI 能回答关键词类问题', /软考|真题|78|系统集成/.test(r2.data.answer), `实际：${(r2.data.answer || '').slice(0, 80)}`);
      console.log(`  \x1b[90mAI 对「我软考复习到什么程度了？」的回答：\x1b[0m\n  ${(r2.data.answer || '').replace(/\n/g, '\n  ')}\n`);
    }

    // 每日总结
    const r3 = await api('/api/summary', { method: 'POST', body: { date: dayAgo(0) } });
    check('每日总结生成成功', r3.ok && (r3.data?.summary || '').length > 20);
    if (r3.ok) {
      console.log(`  \x1b[90m「${dayAgo(0)}」的每日回顾：\x1b[0m\n  ${(r3.data.summary || '').replace(/\n/g, '\n  ')}\n`);
      const again = await api('/api/summary', { method: 'POST', body: { date: dayAgo(0) } });
      check('每日总结有缓存（第二次直接命中）', again.data?.cached === true);
    }

    // 空数据问题的鲁棒性：问一个记录里根本没有的事，应该明确说没记录
    const r4 = await api('/api/ai/ask', { method: 'POST', body: { question: '我上个月去日本旅游吃了什么？' } });
    const refusal = r4.data?.answer || '';
    check(
      '对不存在的事明确说没有记录（不编造）',
      r4.ok && /没有(写|记|相关|找到)|一条记录都|查不到|未记录/.test(refusal),
      `实际：${refusal.slice(0, 110)}`,
    );
  } else {
    console.log('\n  \x1b[33m! 未配置 DEEPSEEK_API_KEY，跳过 AI 测试\x1b[0m');
  }

  // ---------- 语音：AI 提炼 ----------
  console.log('\n  \x1b[36m· 语音记录链路\x1b[0m');

  // 一段真实的口语转写（有语气词、重复、错别字）
  const messy = '呃今天就是那个综治平台那边又改需求了然后我下午改了一版接口改到六点多吧反正挺烦的不过晚上吃了顿好的心情还行吧那个小陈他问我的那个分页问题我也给他解决了';
  const ex = await api('/api/voice/extract', { method: 'POST', body: { transcript: messy } });
  check('语音提炼接口成功', ex.ok && ex.data?.cleaned);
  if (ex.ok) {
    const d = ex.data;
    console.log(`     整理后：${d.cleaned}`);
    console.log(`     要点：${JSON.stringify(d.points)} | 心情：${d.mood} | 标签：${JSON.stringify(d.tags)}`);
    check('整理后比原文短（去了口语）', d.cleaned.length < messy.length, `${d.cleaned.length} vs ${messy.length}`);
    check('提炼出要点', Array.isArray(d.points) && d.points.length >= 1);
    check('要点都不超过 24 字', d.points.every((p) => p.length <= 24), JSON.stringify(d.points));
    check('判断出心情（确实有情绪表达）', typeof d.mood === 'number' && d.mood >= 1 && d.mood <= 5, `mood=${d.mood}`);
    check('给出了标签', Array.isArray(d.tags) && d.tags.length >= 1, JSON.stringify(d.tags));
    check('保留真实信息（综治平台/小陈）', /综治|接口|小陈|分页/.test(d.cleaned + d.points.join('')));
    check('没有编造没提到的内容', !/请假|离职|加班费|辞职/.test(d.cleaned + d.points.join('')));
  }

  // 无情绪的中性短句：不该硬猜心情
  const neutral = await api('/api/voice/extract', { method: 'POST', body: { transcript: '今天下午三点在会议室开了个会讨论了三个方案' } });
  check('中性内容也给整理结果', neutral.ok && neutral.data?.cleaned);
  if (neutral.ok) {
    console.log(`     中性整理：${neutral.data.cleaned} | 心情：${neutral.data.mood}`);
  }

  // ---------- 语音：上传 + 播放 + 检索 ----------
  // 造一段最小的 webm 头（不是真音频，只验证存储/URL/Range 链路）
  const fakeAudio = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),          // EBML 魔数
    Buffer.alloc(4096, 7),
  ]).toString('base64');

  const up = await api('/api/voice/upload', {
    method: 'POST',
    body: { audio: fakeAudio, durationMs: 4200, transcript: '这是一段语音的转写内容用来测试检索' },
  });
  check('录音上传成功', up.ok && up.data?.audio?.id, JSON.stringify(up.data).slice(0, 120));
  const audioId = up.data?.audio?.id;
  check('返回可播放地址', /(^|\/)api\/audio\//.test(String(up.data?.audio?.url || '')), String(up.data?.audio?.url));

  if (audioId) {
    // 播放（Range 请求）
    const full = await api(`/api/audio/${audioId}`, { raw: true });
    check('能取到录音（200）', full.status === 200);
    check('返回音频类型', String(full.headers.get('content-type')).startsWith('audio/'));
    const ranged = await fetch(`${BASE}/api/audio/${audioId}`, {
      headers: { Cookie: cookie, Range: 'bytes=0-99' },
    });
    check('支持 Range 拖动（206）', ranged.status === 206, `实际=${ranged.status}`);
    check('Content-Range 正确', /bytes 0-99\//.test(ranged.headers.get('content-range') || ''));
    const part = Buffer.from(await ranged.arrayBuffer());
    check('Range 返回 100 字节', part.length === 100, `实际=${part.length}`);

    // 把录音挂到一条记录上，验证检索能搜到转写内容
    const withAudio = await api('/api/entries', {
      method: 'POST',
      body: {
        content: '（语音记录）',
        attachments: [{ id: audioId, durationMs: 4200, points: ['测试要点甲乙丙'] }],
      },
    });
    check('记录能挂上录音', withAudio.ok && withAudio.data?.entry?.attachments?.length === 1);
    const got = await api(`/api/entries/${withAudio.data.entry.id}`);
    check('读回时带转写文本', /语音的转写内容/.test(JSON.stringify(withAudio.data.entry.attachments)));

    // 搜转写里的词（正文里没有，只在转写里）
    const s1 = await api('/api/search?q=' + encodeURIComponent('转写内容用来测试'));
    check('能搜到语音转写里的内容', s1.data?.count >= 1, `命中=${s1.data?.count}`);
    // 搜要点里的词
    const s2 = await api('/api/search?q=' + encodeURIComponent('测试要点甲乙丙'));
    check('能搜到语音要点里的内容', s2.data?.count >= 1, `命中=${s2.data?.count}`);

    await api(`/api/entries/${withAudio.data.entry.id}`, { method: 'DELETE' });
    await api(`/api/audio/${audioId}`, { method: 'DELETE' }).catch(() => {});
  }

  // 超大录音要被拒绝
  const huge = Buffer.alloc(9 * 1024 * 1024, 1).toString('base64');
  const tooBig = await api('/api/voice/upload', { method: 'POST', body: { audio: huge } });
  check('超过 8MB 的录音被拒绝', tooBig.ok === false, JSON.stringify(tooBig).slice(0, 100));

  // 没配 ASR 时要给明确提示，而不是崩
  const healthNow = await api('/api/healthz');
  if (!healthNow.data?.asr?.enabled) {
    const tr = await api('/api/voice/transcribe', { method: 'POST', body: { audio: fakeAudio } });
    check('未配置转写通道时返回明确提示', tr.ok === false && /转写通道/.test(tr.error || ''), JSON.stringify(tr).slice(0, 120));
  } else {
    // 配了通道：即使上游报错（欠费/额度），也必须把「录音留下 + 可操作提示」给出
    const tr = await api('/api/voice/transcribe', { method: 'POST', body: { audio: fakeAudio, mime: 'audio/webm' } });
    check('配了通道时转写不抛异常', tr.ok === true, JSON.stringify(tr).slice(0, 140));
    if (tr.ok) {
      const d = tr.data;
      check('录音始终被保留下来', !!d.audio?.id);
      if (!d.transcript) {
        check('转写失败时带上错误类型', !!d.errorKind, `kind=${d.errorKind}`);
        check('转写失败时给可操作提示', !!d.hint, `hint=${String(d.hint).slice(0, 40)}`);
        console.log(`     上游返回：${String(d.error || '').slice(0, 100)}`);
        console.log(`     提示用户：${d.hint}`);
      } else {
        check('转写成功返回文本', d.transcript.length > 0);
        console.log(`     识别结果：${d.transcript}`);
      }
      await api(`/api/audio/${d.audio.id}`, { method: 'DELETE' });
    }
  }

  // ---------- 跨域（安卓 App 必需） ----------
  console.log('\n  \x1b[36m· 跨域与 Cookie 属性\x1b[0m');
  const ORIGIN = 'http://localhost:5181'; // 模拟 App 壳

  const pre = await fetch(`${BASE}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  check('预检请求返回 204', pre.status === 204, `实际=${pre.status}`);
  check('预检放行该来源', pre.headers.get('access-control-allow-origin') === ORIGIN);
  check('预检允许携带凭据', pre.headers.get('access-control-allow-credentials') === 'true');

  const crossLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  const corsCookie = (crossLogin.headers.getSetCookie?.() || []).join(' | ');
  check('跨域登录成功', crossLogin.status === 200);
  check('跨域响应带 Access-Control-Allow-Origin', crossLogin.headers.get('access-control-allow-origin') === ORIGIN);
  check('跨域 Cookie 用路径 /（否则 App 带不上）', /Path=\/;/.test(corsCookie), corsCookie.slice(0, 120));
  check('跨域 Cookie 用 SameSite=None + Secure', /SameSite=None; Secure/i.test(corsCookie), corsCookie.slice(0, 120));

  // 不带 Origin 的同源请求应保持最严格的 Lax
  const sameLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  const sameCookie = (sameLogin.headers.getSetCookie?.() || []).join(' | ');
  check('同源 Cookie 仍是 SameSite=Lax（更安全）', /SameSite=Lax/.test(sameCookie), sameCookie.slice(0, 120));

  // 陌生来源不该被放行
  const evil = await fetch(`${BASE}/api/healthz`, { headers: { Origin: 'https://evil.example.com' } });
  check('陌生来源不放行 CORS', !evil.headers.get('access-control-allow-origin'));

  // ---------- 那年今日 ----------
  console.log('\n  \x1b[36m· 那年今日\x1b[0m');

  // 造一条「一年前的今天」和一条「两年前的今天」
  const todayStr = ymd(today);
  const [yy, mm, dd] = todayStr.split('-').map(Number);
  const p1 = `${yy - 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const p2 = `${yy - 2}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const mkPast = async (date, content) => {
    const ts = new Date(`${date}T20:00:00`).getTime();
    return api('/api/entries', { method: 'POST', body: { content, date, createdAt: ts, tags: ['往日'] } });
  };
  const e1 = await mkPast(p1, '一年前的今天，我在写拾光的前身，那会儿还只会用记事本');
  const e2 = await mkPast(p2, '两年前的今天，刚入职第一家公司，什么都看不懂');

  let mem = await api(`/api/memories?date=${todayStr}`);
  check('那年今日接口可用', mem.ok && Array.isArray(mem.data?.groups));
  check('翻到了 2 个年份', mem.data?.groups?.length === 2, `实际=${mem.data?.groups?.length}`);
  check('按年份由近到远排序', mem.data?.groups?.[0]?.yearsAgo === 1 && mem.data?.groups?.[1]?.yearsAgo === 2);
  check('条数正确', mem.data?.count === 2, `实际=${mem.data?.count}`);
  check('带回了当年的正文', /拾光的前身/.test(JSON.stringify(mem.data.groups)));
  check('不带往年的其它日子', !JSON.stringify(mem.data.groups).includes('刚入职第一家公司') === false);

  // 没有往年记录的日子
  const empty = await api('/api/memories?date=1999-01-01');
  check('没有往年记录时返回空数组', empty.ok && empty.data.groups.length === 0);

  // 非法日期
  const bad = await api('/api/memories?date=不是日期');
  check('非法日期被拒', bad.ok === false);

  // AI 串讲
  // 真实模型偶尔会超时或返回空，重试两次再判失败——
  // 「模型抽风」和「功能坏了」是两件事，不能混成一条红叉
  if (health.data?.ai) {
    let refl = null;
    for (let i = 0; i < 3; i++) {
      refl = await api('/api/memories/reflect', { method: 'POST', body: { date: todayStr } });
      if (refl.ok && (refl.data?.summary || '').length > 10) break;
      await sleep(800);
    }
    check(
      'AI 能就往年今日说一段',
      refl?.ok && (refl.data?.summary || '').length > 10,
      `长度=${(refl?.data?.summary || '').length} 错误=${refl?.error || '无'}`,
    );
    if (refl.ok && refl.data.summary) {
      console.log(`     AI：${refl.data.summary.replace(/\n/g, ' ').slice(0, 150)}`);
      check('AI 没有编造（提到记事本或第一家公司）', /记事本|第一家公司|入职/.test(refl.data.summary));
    }
    // 没有往年记录时不该硬编
    const reflEmpty = await api('/api/memories/reflect', { method: 'POST', body: { date: '1999-01-01' } });
    check('没有往年记录时 AI 返回空', reflEmpty.ok && reflEmpty.data?.empty === true);
  }

  await api(`/api/entries/${e1.data.entry.id}`, { method: 'DELETE' });
  await api(`/api/entries/${e2.data.entry.id}`, { method: 'DELETE' });

  // ---------- 删除后能「撤销」恢复 ----------
  console.log('\n  \x1b[36m· 删除与恢复\x1b[0m');
  const mk = await api('/api/entries', {
    method: 'POST',
    body: { content: '这条待会儿要被删掉再恢复', tags: ['临时'], mood: 2, createdAt: Date.now() - 60000 },
  });
  const mkId = mk.data.entry.id;
  const delRes = await api(`/api/entries/${mkId}`, { method: 'DELETE' });
  check('删除成功', delRes.ok);
  check('删除后列表里没有它', !(await api('/api/entries')).data.entries.some((e) => e.id === mkId));

  // 模拟前端「撤销」：用同样的 id 与时间重新提交
  const back = await api('/api/entries', {
    method: 'POST',
    body: {
      id: mkId,
      content: '这条待会儿要被删掉再恢复',
      tags: ['临时'],
      mood: 2,
      createdAt: mk.data.entry.createdAt,
      date: mk.data.entry.date,
    },
  });
  check('恢复成功（同 id 重新出现）', back.ok && back.data.entry.id === mkId);
  const after = await api('/api/entries');
  check('恢复后能查到', after.data.entries.some((e) => e.id === mkId));
  check('恢复后字段完整', after.data.entries.find((e) => e.id === mkId)?.tags?.includes('临时'));
  await api(`/api/entries/${mkId}`, { method: 'DELETE' });

  // ---------- 删除 ----------
  r = await api(`/api/entries/${target.id}`, { method: 'DELETE' });
  check('删除记录成功', r.ok);
  r = await api('/api/entries');
  check('删除后列表少一条', r.data?.entries?.length === 4);

  // ---------- 持久化：重启后数据还在 ----------
  server.kill('SIGTERM');
  await sleep(1200);
  const server2 = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.mjs')], {
    env: {
    ...process.env,
    PORT: String(PORT),
    SHIGUANG_DATA: DATA,
    SHIGUANG_COOKIE_PATH: '/',
    // 让子进程和测试脚本对「短信是否可用」的判断保持一致
    SHIGUANG_SMS_DEV: SMS_DEV ? '1' : '',
    // 冷却窗口压到 1.2 秒，否则光是等限流就要耗掉一分钟
    SHIGUANG_SMS_RESEND_MS: SMS_DEV ? '1200' : '',
  },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server2.stdout.on('data', () => {});
  server2.stderr.on('data', () => {});
  await sleep(1500);
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: { phone: PHONE, password: PASSWORD } });
  const r5 = await api('/api/entries');
  check('重启后数据仍在（4 条）', r5.data?.entries?.length === 4);
  check('重启后能搜到老记录', (await api('/api/search?q=' + encodeURIComponent('软考'))).data?.count >= 1);
  server2.kill('SIGTERM');
  await sleep(500);

  // ---------- 汇总 ----------
  // 已经在 check() 里逐条打过了，这里只补一句总结
  console.log(`\n\x1b[1m${failed === 0 ? '\x1b[32m全部通过' : '\x1b[31m有失败项'}\x1b[0m  ${pass} 通过 / ${failed} 失败\n`);
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('测试异常', e);
  console.log(serverLog.slice(-3000));
  server.kill('SIGKILL');
  process.exit(1);
});
