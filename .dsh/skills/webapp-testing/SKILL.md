---
name: webapp-testing
description: "用真实浏览器测试 Web 应用：功能验证、UI/布局审计、截图取证、控制台日志、跨视口与深色模式检查。适用于本地或线上站点，当需要验证前端功能、排查 UI 问题、做回归测试时使用。"
whenToUse: "需要测试 Web 应用、验证前端功能、排查 UI 布局问题、做视觉或可访问性审计、跑回归测试时"
license: 改编自 anthropics/skills (MIT)，结合本项目实测经验修订
---

# Web 应用测试

用真实浏览器驱动测试。本 skill 是**实战修订版**：保留了官方方法论，并补充了在本项目里
踩过的坑和对应的检查清单。

## 核心武器

本仓库自带一个 CDP 测试驱动，**不需要安装 Playwright**（沙箱里装不了包）：

```bash
node scripts/audit-ui.mjs [url] [--dark] [--desktop]   # 布局审计，可量化
node scripts/verify-interaction.mjs [url]              # 交互专项
node scripts/verify-edge.mjs [url]                     # 边界场景
node scripts/verify-features.mjs [url]                 # 功能验收
node scripts/verify-voice.mjs [url]                    # 语音链路
node scripts/verify-live.mjs [url]                     # 线上全流程
pnpm test:all                                          # 全部跑一遍
```

这些脚本用 Node 22 内置的 `WebSocket` + CDP 驱动 chromium，
依赖只有本机已有的 `~/.cache/ms-playwright/chromium-1217/.../chrome`。

---

## 铁律一：先等网络空闲，再断言

这是**最容易犯、也最隐蔽**的错误来源。

```js
// ❌ 错：导航后立刻断言，动态应用还没渲染完
await goto(url);
await sleep(1500);
check('列表有内容', await ev(`document.querySelectorAll('.item').length > 0`));

// ✅ 对：等到网络空闲 + 目标元素出现
await goto(url);
await waitForNetworkIdle();          // 或轮询目标条件
await waitFor(() => ev(`!!document.querySelector('.item')`), 15000);
```

**实测教训**：本项目有 3 次「测试失败」全是这个原因——
AI 回答还没流完就断言、日历数据还没加载就查徽标、心情标签还没渲染就检查。
每一次都差点当成产品 bug 去改代码。**测试报错时先怀疑等待逻辑，再怀疑产品。**

判断方法：如果加长等待或轮询后失败消失 → 是测试的问题，不是产品的问题。

## 铁律二：审计工具本身也要验证

自定义审计逻辑一定要先自证。本项目的对比度探针最初有 3 个 bug：

- 遇到半透明背景（`rgba` 且 alpha<1）就停下，算出的底色是错的
  → 必须逐层向上混合（alpha compositing）直到找到不透明底
- 横向溢出没排除「位于可横向滚动容器内」的元素 → 误报
- 装饰性小字（图例、时间戳）按正文标准要求 → 误报

**做法**：审计跑出的每个问题，先手工复核一遍。凡是算出来的指标，
都要能手工验算。

## 铁律三：选择器要稳

```js
// ✅ 稳定：语义化的类名、data 属性、aria-label
'.cal-day.is-selected'
'[aria-label*="条记录"]'
'.msg.ai .bubble'

// ❌ 脆弱：结构位置
'div > div:nth-child(3) > span'
```

本项目约定：交互元素尽量带 `aria-label`，测试直接用它，既稳又顺带验证了无障碍。

## 铁律四：测试之间不能互相依赖

**实测教训**：边界测试会清空所有数据（测「新用户第一眼」），
导致随后跑的功能测试在检索历史用例上失败——因为搜不到东西，
而「有结果才记历史」是正确设计。

**做法**：每个用例自己造数据、自己清理。需要前置数据就在用例开头创建。

```js
// ✅ 自给自足
const seed = `测试种子-${Date.now()}`;
await createEntry({ content: seed, date: today });
await waitFor(() => search(seed).count > 0);
// ... 断言 ...
await deleteEntry(byContent(seed));   // 用完清掉
```

## 铁律五：清理要用真实接口，别点 UI

删除按钮在手机上可能是浮层、在桌面可能是 hover 才出现。
清理数据直接调接口，可靠且快：

```js
const list = await fetch(api + '/entries?limit=2000', { credentials: 'include' }).then(r => r.json());
for (const e of list.data.entries) {
  await fetch(api + '/entries/' + e.id, { method: 'DELETE', credentials: 'include' });
}
```

---

## 测试流程

### 1. 先侦察，再断言

```js
// 打开页面，等稳定
await goto(url);
await sleep(2500);
// 截图 + 打印 DOM 关键信息
await shot('recon');
console.log(await ev(`JSON.stringify({
  title: document.title,
  textLen: document.body.innerText.length,
  buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).slice(0, 15)
})`));
```

**先看渲染结果，再决定选择器**。不要凭想象写选择器。

### 2. 分层测试

| 层次 | 查什么 | 本仓库脚本 |
| --- | --- | --- |
| 接口 | 增删改查、鉴权、边界值 | `test-api.mjs` |
| 布局 | 重叠、溢出、触控、对比度 | `audit-ui.mjs` |
| 交互 | 点得动、输入有反馈、状态正确 | `verify-interaction.mjs` |
| 边界 | 空数据、超长、高密度、特殊字符 | `verify-edge.mjs` |
| 端到端 | 完整用户旅程 | `verify-live.mjs` |

### 3. 跨维度矩阵

**同一个页面在不同维度下是不同的问题源**，至少要覆盖：

- 视口：360 / 412 / 1360
- 主题：浅色 / 深色
- 数据量：空 / 1 条 / 50 条
- 内容形态：极短 / 极长 / 含 emoji / 含特殊字符

本项目的日历 bug（网格塌成一列）只在「页面渲染后」才暴露，
而桌面端输入框溢出只在 1360px 下出现。

### 4. 失败分类，别急着改代码

拿到失败后先分类：

| 类型 | 判断依据 | 处理 |
| --- | --- | --- |
| **产品 bug** | 加长等待仍失败；手工复现得到同样结果 | 改代码 |
| **测试 bug** | 等待不足、选择器错、日期算错、用例耦合 | 改测试 |
| **环境问题** | 服务没起、数据被别的用例清了、Key 失效 | 修环境 |

**本项目真实统计**：一轮完整测试里 7 个失败，只有 4 个是真产品 bug，
3 个是测试自身的问题。**如果不做分类，会把好代码改坏。**

---

## 常见坑清单

- **UTC vs 本地时间**：`toISOString()` 给的是 UTC 日期，界面上按本地日期分组。
  断言日期时务必用本地日期：
  ```js
  const d = new Date(); const p = n => String(n).padStart(2,'0');
  const today = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  ```
- **首行不满不是 bug**：日历第一行可能不足 7 格（月初不是周一时）。
  判定列数要取「最宽的一行」。
- **sticky/fixed 元素在全页截图里会浮在中间**：`captureBeyondViewport: true`
  时 sticky 元素停在视口位置，看起来像重叠。**先判断是不是截图假象**。
- **禁用态元素不该断言对比度**：先过滤 `disabled` 和 `opacity < 0.5` 的祖先。
- **动画未结束**：断言前等 `transitionend` 或直接轮询目标状态。
- **Service Worker 缓存**：改了前端后线上可能还是旧版。
  测试线上时加缓存清理，或确认 SW 已更新。

---

## 截图取证

每个用例失败时都要有截图，否则无法复盘：

```js
const shot = async (name) => {
  const { data } = await send(ws, 'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true }, S);
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
```

截图超过 8192px 会读不了，需要先缩放：

```bash
ffmpeg -y -v error -i shot.png -vf "scale=iw*0.5:-1" small.png
```
