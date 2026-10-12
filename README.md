# 拾光 · ShiGuang

> 随手记下每天发生的事，再用对话的方式把它们找回来。

**线上地址：<https://zhuangrongjian.space/shiguang/>**
初始密码 `123456` —— 进去后请马上去「我的 → 账号设置」里改掉。

---

## 这是什么

一个自用的记录网站 + 安卓 App，四个核心能力：

1. **记一记** —— 底栏正中间那颗按钮。点开问一句「写一条还是说一句」，两条路都只要一步。
2. **说一句** —— 心情差、不想打字时按住说话：录音存下来、自动转成文字、AI 再帮你提炼出要点和当时的心情。之后可以回放当时的声音。
3. **拾迹** —— 检索和 AI 问答合成一页。打字直接搜（毫秒级），按回车让 AI 读完相关记录讲一段；它只会引用你真实写过的事，标注日期，并列出依据的原文，点进去能跳到那天。
4. **那年今日** —— 自动翻出往年同一天写过的东西。一年前的你在干嘛，打开「过往」就看见了。

数据全部存在**你自己的阿里云服务器**上，不经过任何第三方数据库。

**多用户**：一个服务器上可以住很多人，彼此的记录完全隔离。
**账号就是手机号**：手机号 + 密码登录；配了短信的话还能用手机号 + 验证码快捷登录。
注册要**邀请码**（不是短信验证码，原因见下）。

---

## 账号与数据隔离

```
data/
  users.json              注册表：手机号 -> 账号（含密码哈希）
  server.json             会话签名密钥
  u/<userId>/             这个人的全部数据，结构跟单用户时一模一样
    meta.json             昵称、简介
    notes/YYYY-MM.jsonl
    audio/YYYY-MM/...
```

**为什么一人一个目录，而不是在每条记录里加 userId**：
`Store` 和 `AudioStore` 本来就是「给一个根目录就能跑」，
把根目录从 `data/` 换成 `data/u/<id>/` 就天然隔离了。
查询、检索、统计、AI 上下文的代码一行都不用改，
也就不存在「某个接口忘了加 where 条件就串号」这种最难查的 bug。

会话 token 里带着 `userId` 和这个人的 `epoch`（代数）：

```
v1.<userId>.<epoch>.<exp>.<签名>
```

改密码时只把**自己的** epoch +1，所以只会把自己其它设备踢下线，不牵连别人
（早先单用户时是轮换全局密钥，那会把所有人都踢了）。

### 注册用邀请码，不用短信

**为什么不发短信验证码**：账号是手机号，最严谨的做法当然是发条短信证明号是你的。
但阿里云短信现在要先办**资质**（企业认证或他用资质，个人认证的自用资质过不了）、
再申请签名和模板，最后还要过**运营商实名报备**（[官方说明](https://help.aliyun.com/zh/sms/user-guide/qualification-application-description)：
报备平均 5~7 个工作日，部分运营商 7~10 个工作日）。整套下来两周起步，
对「先让几个朋友用起来」来说太重了。

所以注册门槛改成**邀请码**：

- 服务首次启动会在 `data/invite-code.txt`（600 权限）里生成一个 8 位邀请码，也打进启动日志
- 注册要填：手机号 + 邀请码 + 密码。**不牵扯短信**
- 邀请码**可复用**，发给几个朋友都能用；不区分大小写（省得手抄出错）
- 想换码：把 `SHIGUANG_INVITE_CODE=新码` 写进 `/etc/shiguang.env` 然后重启；
  或者直接改 `data/invite-code.txt`
- 想关门：`SHIGUANG_OPEN_REGISTER=0`，已注册的人照常登录，只是不再接受新号

**已知取舍**：邀请码验证不了「这个手机号是不是本人的」。它挡的是陌生人，
不是存心冒用别人号的人。等阿里云那边资质批下来了，把 `ALIYUN_SMS_*` 填上，
登录页会自动多出「验证码登录」，那时候再决定要不要把注册也改回短信验证。

短信现在只保留**登录快捷方式**这一个用途（配好了登录页才有那一栏）。
注册用邀请码，换手机号用当前密码——**这两个流程完全不碰短信**，
所以短信没配好也不影响任何人把账号用起来。

命令行兜底一直都在：

```bash
node server/src/cli.mjs add <手机号> <密码> [昵称]   # 建号
node server/src/cli.mjs list                        # 都有谁
node server/src/cli.mjs passwd <手机号> <新密码>     # 重置密码
node server/src/cli.mjs data <手机号>                # 看数据在哪、有多少条
node server/src/cli.mjs remove <手机号>              # 移出注册表（数据目录保留）
```

---

## 界面结构

底部导航是「左二 + 中间一颗大按钮 + 右二」：

```
 过往    拾迹        ⊕        统计    我的
  │      │       记一记        │      │
  │      │                    │      └─ 账号、外观、数据、服务，退出登录
  │      │                    └──────── 热力图、标签、趋势
  │      └───────────────────────────── 搜一下 / 问 AI
  └──────────────────────────────────── 上面日历，下面时间线
```

中间那颗只显示图标、不显示文字；两边各两项，尺寸完全一致（审计脚本里钉了这条规则）。
底栏贴死屏幕底边，不浮动；选中态是**图标外一圈圆底**，不是铺满一格的方块。
顶部没有固定栏——标题直接就是内容的一部分，往下滚会让位给内容。

「我的」页按同类 App 的个人中心范式来：**渐变头图 → 负边距上浮的统计卡 → 分组菜单（彩色圆角图标 + 名称 + 当前值 + 箭头）→ 退出登录单独一块**。
移动端头图顶到屏幕最上沿（连安全区一起吃），桌面端收成一张跟内容列对齐的圆角卡片。

一级页面只负责「看自己的记录」，跟身份、设备偏好有关的东西都收进二级页：

```
我的              统计卡 + 我的记录 + 退出登录
 └ 点头像 → 个人资料   昵称/简介 + 账号 + 通用 + 服务
 └ 账号设置 → 设置     数据情况 + 导出 + 安全 + 缓存
```

头图那块用 `<a href>` 而不是 `<button>`：`<a>` 的内容模型是透明的，里面可以放 `<h1>`；
`<button>` 只允许短语内容，塞标题是非法 HTML。而且真链接能中键新开、能右键复制地址。

---

## 功能一览

| 页面 | 能干什么 |
| --- | --- |
| **过往** | 上半是月历：有记录的日子按条数深浅上色、带小圆点，点某天就把下面的时间线滚到那天；下半是时间线，按天分组、带那年今日；顶部还有一行快速记录，回车即存 |
| **拾迹** | 一个输入框搞定两件事：打字立刻出结果列表；按回车让 AI 读完相关记录给一段回答，回答下面直接列出它依据的记录，点进去能跳到那天 |
| **统计** | 总记录 / 天数 / 连续天数 / 平均；一年热力图；哪个星期记得多、什么时段记得多；高频标签；按月趋势；语音记录条数与总时长 |
| **我的** | 顶部是记录足迹（昵称、简介，点头像进个人资料）；下面一张统计卡（条数/天数/连续）点进去看完整统计；再往下是「我的记录」（统计、导出、第一条、累计字数）；退出登录单独一块 |
| **个人资料** | 点头像进来。改昵称和简介（改完「我的」页头图立刻跟着变，头像换成昵称首字）；账号（登录方式、手机号、改密码）；通用（外观、同步）；服务状态（AI / 语音） |
| **设置** | 数据情况；导出 Markdown（可直接丢进 Obsidian）/ JSON；安全（改密码、换手机号——要输当前密码）；清理本地缓存；快捷键说明 |

「记一记」里的两条路：

| 入口 | 流程 |
| --- | --- |
| **写一条** | 直接开记录面板，打字存下 |
| **说一句** | 录音（带实时波形）→ 自动转文字 → AI 提炼要点 / 判断心情 / 建议标签 → 存下录音可回放 |

其它细节：

- **离线可用**：断网时照样能记，恢复网络自动补传（PWA，可「添加到主屏幕」当 App 用）
- **主题**：暖纸白天模式 + 暖棕夜间模式，跟随系统
- **快捷键**：`N` 直接开写、`V` 直接开说（键盘用户不用先过一遍选择层）；拾迹页 `Enter` 问 AI、`Esc` 清空
- **数据安全**：按天追加式保存（`JSONL`），改动留历史；误删有撤销；**服务器每天自动备份**（保留 7 日 + 4 周）
- **防手滑**：没写完就关掉的内容会自动存草稿，下次打开自动恢复（保留 24 小时）
- **旧链接不失效**：`#/calendar`、`#/search`、`#/chat` 都会自动跳到新位置

---

## 安卓 App

页面打包进 App 里（离线可用），连服务器同步。录音权限已配好。

```bash
pnpm build:apk          # 产出 android/app/build/outputs/apk/release/*.apk
pnpm deploy --with-apk  # 顺便发到 https://zhuangrongjian.space/download/shiguang.apk
```

- 工具链复用 `心迹/.android-build`（JDK 21 + Android SDK 35 + Gradle），不重复下载
- 签名密钥库在 `拾光/.android-build/shiguang-release.keystore`，口令 `shiguang`，**请务必备份**
- App 信息：包名 `space.zhuangrongjian.shiguang`，最低支持 Android 7.0（API 24）
- 装到手机后首次录音会弹系统权限框，允许即可

---

## 语音识别怎么配（重要）

DeepSeek 没有语音接口，所以语音转文字**必须另接一家**。代码里做成了多通道适配器，
按下面顺序自动尝试，任何一家通了就用，也可以只留一家：

| 顺序 | 服务商 | 模型 | 说明 |
| --- | --- | --- | --- |
| 1 | 阿里云百炼 | `qwen3-asr-flash` | **推荐**，语音识别有免费额度，你已有阿里云账号 |
| 2 | 硅基流动 | `Qwen/Qwen3-ASR-1.7B` | 实测 15 秒语音 **0.6 秒**出结果，标点好 |
| 3 | 硅基流动 | `FunAudioLLM/SenseVoiceSmall` | 兜底，实测同段音频要 14~42 秒 |
| 4 | 任意 OpenAI 兼容 | `whisper-1` 等 | 填 `ASR_BASE_URL` 即可 |

### 配置方法

```bash
ssh aliyun
vi /etc/shiguang.env
```

加一行（哪家有额度就填哪家，可以都填，自动按上面顺序挑）：

```ini
# 阿里云百炼（推荐，控制台 → API-KEY 管理）
DASHSCOPE_API_KEY=sk-xxxxxxxx

# 或硅基流动
SILICONFLOW_API_KEY=sk-xxxxxxxx
```

```bash
systemctl restart shiguang
curl -s http://127.0.0.1:8787/api/healthz   # 看 asr.enabled 是否为 true
```

想强制指定某一家：`ASR_PROVIDER=dashscope|siliconflow|openai`
想换模型：`ASR_MODEL=qwen3-asr-flash`

### 没配好会怎样

不会崩，也不会丢录音：

- 录音照常保存，能回放
- 界面明确告诉你哪一步没成，并给出「该去哪解决」
- 你可以在弹层里直接手动输入文字，AI 提炼要点照样能用
- 修好之后点「重试识别」，那段录音会重新走一遍识别

常见报错对应处理：

| 提示 | 含义 | 怎么办 |
| --- | --- | --- |
| 账户余额不足 | 服务商没钱了 | 换一家（百炼有免费额度）或充值 |
| API Key 无效 | Key 填错/被删 | 换 `/etc/shiguang.env` 里的 Key |
| 请求太频繁 | 触发限流 | 等几秒点「重试识别」 |

---

## 技术结构

```
拾光/
├── index.html                 单页入口
├── src/                       前端（Vue 3 + TypeScript + Vite）
│   ├── App.vue                外壳：侧栏 / 顶栏 / 底栏 / 全局弹层
│   ├── pages/                 五个页面 + 登录页
│   │   ├── PastPage.vue       「过往」：上日历 + 下时间线（合并了旧的记录页和日历页）
│   │   ├── FindPage.vue       「拾迹」：检索 + AI 问答（合并了旧的检索页和对话页）
│   │   ├── StatsPage.vue      「统计」
│   │   ├── MinePage.vue       「我的」：头图 + 统计卡 + 我的记录 + 退出登录
│   │   ├── ProfilePage.vue    「个人资料」：昵称/简介 + 账号 + 通用 + 服务
│   │   ├── SettingsPage.vue   「设置」
│   │   └── LoginPage.vue      密码 / 短信验证码两种登录
│   ├── components/            Icon / EntryCard / MemoryCard / RecorderSheet / VoiceSheet / AudioPlayer
│   ├── lib/                   api / store / date / markdown / recorder / voice-text
│   └── styles/global.css      设计系统（颜色、圆角、阴影、组件）
├── server/                    后端（纯 Node，零第三方依赖）
│   ├── src/index.mjs          HTTP 服务与路由
│   ├── src/store.mjs          存储层（JSONL + 检索索引）
│   ├── src/ai.mjs             AI 大脑：时间理解 + 检索 + 提示词 + 语音提炼
│   ├── src/asr.mjs            语音转写适配器（百炼 / 硅基流动 / OpenAI 兼容）
│   ├── src/sms.mjs            阿里云短信（手写 HMAC-SHA1 签名）+ 验证码签发校验
│   ├── src/audio.mjs          录音存储 + Range 播放支持
│   ├── src/audio-http.mjs     音频收发与 base64 解码
│   ├── src/deepseek.mjs       DeepSeek 客户端（含 SSE 流式）
│   ├── src/users.mjs          多用户注册表（手机号账号、密码哈希、一人一目录）
│   ├── src/cli.mjs            命令行建号 / 改密 / 查数据
│   ├── src/auth.mjs           scrypt 口令 + HMAC 会话（token 带 userId 和 epoch）
│   ├── src/text.mjs           中文分词与检索打分
│   ├── backup.sh              每日备份（7 日 + 4 周轮转）
│   ├── shiguang.service       systemd 服务定义
│   ├── shiguang-backup.timer  备份定时器
│   ├── caddy-snippet.caddyfile Caddy 站点片段
│   └── install-server.sh      服务器一次性初始化
└── scripts/
    ├── deploy.sh              一键发布
    ├── test-api.mjs           后端自测（130 项，含真实 AI 调用、跨域、短信绑定/登录回归）
    ├── audit-ui.mjs           UI 审计（重叠/溢出/对比度/触控目标/底栏一致性，可量化）
    ├── shoot-view.mjs         视口截图（各页面 + 各种弹层状态，供肉眼复核）
    ├── verify-invite.mjs      邀请码注册验收（生成 → 校验 → 复用 → 大小写）
    ├── verify-auth.mjs        登录验收（门禁/密码/验证码/注册/多用户隔离/退出登录）
    ├── verify-profile.mjs     个人资料验收（昵称/简介编辑、内容搬运、超长与注入）
    ├── verify-find.mjs        「拾迹」验收（打字检索 + 问 AI + 依据跳转 + 旧地址重定向）
    ├── verify-interaction.mjs 交互验收（日历选中滚动、弹层、可点性、控制台）
    ├── verify-features.mjs    功能验收（草稿/撤销/那年今日/检索历史/快捷键/底栏结构…）
    ├── verify-edge.mjs        边界验收（一天多条、跨年闰年、检索特殊字符）
    ├── verify-voice.mjs       语音验收（录音/转写/提炼/回放）
    ├── verify-live.mjs        线上验收（浏览器真跑一遍全流程）
    ├── build-apk.sh           打包安卓 APK
    ├── gen-android-icons.mjs  生成安卓图标
    ├── cdp-probe.mjs          调试探针：在页面里跑任意表达式看真实尺寸/颜色
    ├── shoot.mjs              页面截图（旧版，整页拼接）
    └── seed-local.mjs         本地灌示例数据
```

**为什么后端不用框架**：服务器只有 1.6G 内存，且希望零依赖、不会因为装包失败而挂掉。全部用 Node 内置模块写成，`node server/src/index.mjs` 就能跑。

---

## 服务器上的部署形态

| 位置 | 内容 |
| --- | --- |
| `/opt/shiguang/server` | 后端代码 |
| `/var/www/shiguang` | 前端静态文件（Caddy 挂在 `/shiguang/`） |
| `/var/lib/shiguang` | **你的记录数据**（notes/*.jsonl、chats.json、meta.json、summary-*.json） |
| `/var/www/download` | 安卓安装包（`/download/shiguang.apk`） |
| `/etc/shiguang.env` | 配置（含 DeepSeek Key 与语音转写 Key，权限 600） |
| `/etc/systemd/system/shiguang.service` | 服务定义，开机自启 |

请求走向：

```
浏览器 /shiguang/            → Caddy → /var/www/shiguang（静态文件）
浏览器 /shiguang/api/*       → Caddy（strip 前缀）→ 127.0.0.1:8787（Node）
Node /api/ai/*               → api.deepseek.com（deepseek-flash）
```

---

## 日常使用

### 发版（改完代码）

```bash
cd 拾光
pnpm deploy              # 构建 + 同步 + 重启 + 线上验收
pnpm deploy --check      # 只看线上状态，不发版
pnpm deploy --no-build   # 用已有 dist 发版
```

### 运维

```bash
ssh aliyun 'systemctl status shiguang --no-pager'     # 服务状态
ssh aliyun 'journalctl -u shiguang -n 50 --no-pager'  # 看日志
ssh aliyun 'systemctl restart shiguang'               # 重启
ssh aliyun 'curl -s http://127.0.0.1:8787/api/healthz' # 服务自检
```

### 改配置

```bash
ssh aliyun
vi /etc/shiguang.env        # PORT / DEEPSEEK_MODEL / DEEPSEEK_API_KEY 都在这里
systemctl restart shiguang
```

### 备份数据

**服务器每天 03:30 自动备份**（systemd timer），保留最近 7 天 + 最近 4 周：

```bash
ssh aliyun 'ls -la /var/backups/shiguang/daily/ | tail -5'    # 看现有备份
ssh aliyun 'systemctl list-timers shiguang-backup.timer'      # 看下次时间
ssh aliyun 'bash /opt/shiguang/server/backup.sh'              # 立刻手动备一次
```

**恢复某一天的数据**：

```bash
ssh aliyun
systemctl stop shiguang
tar xzf /var/backups/shiguang/daily/shiguang-2026-09-26.tar.gz -C /var/lib
systemctl start shiguang
```

想额外拉一份到本地：

```bash
scp aliyun:/var/backups/shiguang/daily/$(date +%F).tar.gz ./
```

也可以在「设置」页点「导出 Markdown / JSON」自己存一份。

---

## 本地开发

```bash
cd 拾光
pnpm install
pnpm build              # 含类型检查

# 起后端（需要一个 DeepSeek Key）
DEEPSEEK_API_KEY=sk-xxx node server/src/index.mjs

# 另开一个终端：起前端
pnpm dev                # http://127.0.0.1:5181，/api 自动代理到 8787
```

或者一步到位：先 `pnpm build`，再只跑后端，它会直接托管 `dist/`，访问 <http://127.0.0.1:8787> 即可。

### 测试

项目里装了 5 个 skill（`.dsh/skills/`），改 UI 或写测试前建议先加载：

| Skill | 来源 | 安装量 | 用途 |
| --- | --- | --- | --- |
| `find-skills` | vercel-labs/skills | 360 万 | 在开放技能生态里搜索并安装 skill |
| `frontend-design` | anthropics/skills（官方） | 92.9 万 | 有主张的视觉方向：排版、配色、避免模板感 |
| `design-taste-frontend` | leonxlnx/taste-skill | 52.8 万 | 反平庸清单：AI 味禁列、pre-flight 检查 |
| `webapp-testing` | anthropics/skills + 本项目修订 | — | 测试方法论与踩坑清单 |
| `ui-review` | 多专家会诊思路 + 本项目实现 | — | 五视角 UI 审查 |

重新安装或更新：

```bash
export npm_config_cache="$PWD/.npm-cache"   # 沙箱里 ~/.npm 只读
npx skills add vercel-labs/skills@find-skills -y
npx skills add anthropics/skills@frontend-design -y
npx skills add leonxlnx/taste-skill@design-taste-frontend -y
npx skills check      # 查更新
```

### 设计上遵循的硬规则

`frontend-design` 和 `design-taste-frontend` 给了一批可执行的禁令，本项目已按它们整改：

- **零破折号**：`—` 和 `–` 全项目清除（LLM 最明显的识别特征）
- **不要外发光**：主色元素的 `box-shadow` 改成克制的着色投影 + 内高光
- **强调色饱和度 < 80%**：AI 青从 89.9% 降到 75.4%（白字对比度 2.61 → 4.61）
- **一行最多一个中点 `·`**：已全部合规
- **进度条不留灰色底槽**：条形统计只留数据本身
- **不用纯黑阴影**：阴影都带暖棕色相，和背景同调
- **文字对比度全部 ≥ 4.5:1**：三级文字、危险按钮、日历上的强度格、渐变按钮都实测过；
  「淡底 + 亮色文字」这种组合最容易翻车（玫瑰淡底配亮粉只有 2.6:1）

关于对比度还有个教训值得记下来：审计脚本里的 `parseColor` 正则写在模板字符串里，
`\(` 被 JS 当成转义吃掉了，于是正则永远匹配不到颜色，整条对比度检查**静默失效了很久**，
一直显示「无问题」。现在这份脚本会解析 `rgb()`、`rgba()` 和 `color-mix()`
算出来的 `color(srgb ...)` 三种写法，渐变底也单独查一遍——
不然 `background-color` 是透明的，它会一路找到白卡，算出「白字压白底 = 1.00」这种假结果。

一共 12 个测试脚本，覆盖从接口到像素的各个层面。**改完代码建议跑 `pnpm test:all`**：

```bash
pnpm test:all            # 全部跑一遍（约 8 分钟）

# —— 也可以单独跑 ——
SHIGUANG_SMS_DEV=1 node scripts/test-api.mjs   # 后端接口 130 项（含真实 AI、跨域、短信绑定）
pnpm audit:ui                       # 布局审计：重叠/溢出/触控目标/对比度/底栏一致性
pnpm audit:ui:dark                  # 同上，深色模式
pnpm audit:ui:desktop               # 同上，桌面端
pnpm verify:invite                  # 邀请码注册：生成 / 校验 / 复用 / 大小写
pnpm verify:auth                    # 登录：门禁/密码/验证码/注册/多用户隔离/退出登录
pnpm verify:profile                 # 个人资料：昵称/简介编辑、内容搬运、超长与注入
pnpm verify:find                    # 「拾迹」：检索/问答/依据记录/旧地址重定向
pnpm verify:interaction             # 交互：换月/选日滚动/输入/发送/弹层/「记一记」选择层
pnpm verify:features                # 功能：草稿/撤销/那年今日/检索历史/底栏结构
pnpm verify:edge                    # 边界：空数据/超长/高密度/闰年/特殊字符
pnpm verify:voice                   # 语音：录音/转写/提炼/回放
node scripts/verify-live.mjs        # 线上验收（对着真实域名跑）
pnpm shots                          # 截图：各页面 + 弹层状态，输出 .shots/view-mob-light/
```

**测试脚本开头一定要「注销 SW + 清空 Cache Storage」**：

```js
const rs = await navigator.serviceWorker.getRegistrations();
await Promise.all(rs.map(r => r.unregister()));
const ks = await caches.keys();
await Promise.all(ks.map(k => caches.delete(k)));
```

只注销 SW 是不够的——它 precache 过一份 `index.html`，留着的话浏览器会继续跑
**上一版构建**，测试报出来的「失败」其实是旧代码的问题，排查方向会被整个带偏
（这次就在这上面绕了很久）。所有测试脚本现在都做了这一步。

**布局审计是可量化的**，不是靠肉眼看：它会在浏览器里真实测量每个元素的
矩形、计算 WCAG 对比度、找出触控目标过小的按钮、核对底栏四格是否等宽等中心，
并逐页截图。输出在 `.audit/<组合>/`，共四种组合（移动/桌面 × 浅色/深色）。

**视口截图别用整页拼接**：`Page.captureScreenshot({captureBeyondViewport:true})`
会把 `position:fixed` 的底栏按当前滚动位置重绘一次，长图里底栏会「浮」在页面中间，
看着像元素重叠。`shoot-view.mjs` 只截视口，看到的才是真实首屏。

跑登录验收需要一个开了短信开发模式的服务实例：

```bash
PORT=8791 SHIGUANG_SMS_DEV=1 SHIGUANG_DATA="$PWD/.run/data" node server/src/index.mjs
node scripts/verify-auth.mjs http://127.0.0.1:8791
```

---

## 接口一览

除 `/api/healthz`、`/api/auth/status`、`/api/auth/methods`、`/api/auth/sms/*`、`/api/auth/login`
外都需要登录（HttpOnly 会话 Cookie）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/healthz` | 健康检查（账号数、AI / 语音 / 短信是否就绪，不含任何人的私人数据） |
| GET | `/api/auth/status` | 当前是否已登录 |
| GET | `/api/auth/methods` | 有哪些登录方式（决定登录页显示几个页签），**免登录可读** |
| POST | `/api/auth/register` | 注册（手机号 + 邀请码 + 密码，不走短信） |
| POST | `/api/auth/login` | 手机号 + 密码登录 |
| POST | `/api/auth/sms/send` | 发登录验证码（只有这一个用途了；没配短信时直接说明） |
| POST | `/api/auth/sms/login` | 手机号 + 验证码快捷登录 |
| GET | `/api/auth/profile` | 账号信息（掩码手机号、昵称、简介） |
| POST | `/api/auth/phone` | 换手机号（等于换账号，用**当前密码**验证，不要短信） |
| POST | `/api/auth/signout` | 退出登录（清会话 Cookie） |
| POST | `/api/auth/password` | 改密码（会让其它设备下线） |
| GET/POST | `/api/entries` | 列表 / 新建 |
| PATCH/DELETE | `/api/entries/:id` | 修改 / 删除（软删除） |
| GET | `/api/day/:date` | 某天的记录 + 已有回顾 |
| GET | `/api/search?q=` | 全文检索（含时间词理解） |
| POST | `/api/ai/chat` | 问答（SSE 流式，`done` 事件带 `entries` 依据原文） |
| POST | `/api/ai/ask` | 单轮问答（非流式） |
| POST | `/api/summary` | 生成某天回顾（带缓存） |
| GET | `/api/stats` `/api/tags` `/api/calendar` | 统计 / 标签 / 日历密度 |

### 短信登录怎么配

用的是**阿里云短信**（`dysmsapi.aliyuncs.com`），手写 HMAC-SHA1 签名，没引第三方 SDK。
在阿里云控制台申请签名和模板后，往 `/etc/shiguang.env` 加四行：

```ini
ALIYUN_SMS_AK_ID=LTAIxxxxxxxxxxxx
ALIYUN_SMS_AK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
ALIYUN_SMS_SIGN=拾光                  # 控制台审核通过的签名
ALIYUN_SMS_TEMPLATE=SMS_123456789     # 模板里变量名必须是 ${code}
ALIYUN_SMS_REGION=cn-hangzhou         # 可选
```

```bash
systemctl restart shiguang
curl -s http://127.0.0.1:8787/api/healthz   # 看 sms.enabled 是否为 true
```

配好之后：先用密码登录 → 「我的 → 账号设置 → 绑定手机号」→ 登录页就会多出
「短信验证码」一栏。没绑定手机号时，登录页不会显示这一栏，短信接口也不会给
没绑定的号码发码（避免被当成免费短信网关）。

**还没配好也能先跑通**：把 `SHIGUANG_SMS_DEV=1` 写进环境变量，短信不会真发，
验证码直接回显在页面上并写进日志，整条绑定 → 登录链路都能走一遍。生产别开这个。
`SHIGUANG_SMS_RESEND_MS` 可以调小重发冷却（默认 60 秒，自动化测试里会调到 1.2 秒）。

验证码规则：6 位数字、5 分钟有效、最多试 5 次、同一号码 60 秒内不许重发；
验证码记录只存内存，重启即失效。限流窗口独立于验证码本身，
所以「验证成功」不会顺带把冷却时间也清掉。

---

## AI 是怎么工作的

1. **理解时间**：从提问里解析「今天 / 上周三 / 9月17号 / 最近一周 / 上个月」等说法。用**浏览器所在时区**的今天作基准，避免服务器时区把日期算错一天。
2. **取上下文**：时间命中的记录给全文，前后各 3 天作背景；问题里的关键词再检索一批最相关的记录；最后附一份全量时间线速览。整个记录库都在模型 1M 上下文之内。
3. **生成回答**：系统提示词要求它**只依据记录回答、不许脑补**，引用事实要标 `[YYYY-MM-DD]`，找不到就说没记录。回答末尾会输出一个隐藏的引用块，服务端剥离后转成前端可点击的日期。
4. **流式输出**：`deepseek-flash` 的 SSE 增量转发给浏览器；内部标记会先扣住，保证不会漏给用户看到。

---

## 语音是怎么处理的

1. **录**：浏览器 `MediaRecorder` 采音（安卓/iOS 走 mp4，桌面走 webm/opus，32kbps 够用且省流量），实时画波形，最长 5 分钟。
2. **转文字**：音频上传到服务器 → 服务器转给选定的语音服务商 → 拿回转写文本。**Key 只在服务器上，不进浏览器。**
3. **提炼**：转写文本交给 DeepSeek，要求它去掉口语噪音、整理成通顺句子，并抓出 1~4 条要点、判断心情、给标签。提示词里写死了「绝不能编造，没说的信息一个字都不要加」。
4. **AI 不可用时**：用本地规则做减法清理（去语气词、合并重复），要点用断句兜底，保证界面不空着。
5. **存**：录音文件放 `data/audio/YYYY-MM/`，记录里只存附件摘要（id + 时长 + 要点），避免记录文件被撑大。录音**原始文件永久保留**，随时能回放当时的声音。

### App 报错怎么看

App 里的页面跑在 `https://localhost`，接口在你自己的域名上，属于**跨域**，
所以服务端专门做了 CORS 与 Cookie 适配（见 `server/src/index.mjs` 的 `corsHeaders`）。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「请求失败（200）」 | 响应不是 JSON（多数是跨域被拦） | 已修：现在会直接说清是「返回了非 JSON 内容」 |
| 登录成功但立刻又是未登录 | 跨站 Cookie 被浏览器丢弃 | 已修：跨域时自动用 `SameSite=None; Secure` + `Path=/` |
| 连不上服务器 | 手机没网 / 域名解析不了 | App 会提示「请检查手机网络」 |
| 录音没反应 | 没给麦克风权限 | 系统设置 → 应用 → 拾光 → 权限 → 麦克风 |

**注意**：网页版和 App 用的是**同一套账号密码**，但登录状态各自独立
（30 天免登录）。改了密码后两边都要重新登录。

---

## 安全说明

- 单用户登录，两种方式：访问密码，或「已绑定手机号 + 短信验证码」。密码用 `scrypt` 加盐哈希存在服务器，会话是 HMAC 签名的 HttpOnly Cookie（30 天）。
- 短信接口只给**已绑定的那个号码**发码；绑定本身需要先登录并验证该号码，所以拿不到「给任意号码发短信」的能力。
- 验证码 5 分钟过期、最多试 5 次、60 秒内不许重发；只存内存，重启即失效。
- 手机号在界面上只显示掩码（`138****8000`），完整号码不出现在任何页面上。
- 跨域只放行 App 壳（`localhost` / `capacitor://localhost`）和自己的域名，**不用 `*`**，陌生来源一律不放行。
- 同源网页版仍用最严格的 `SameSite=Lax`；只有跨域的 App 请求才用 `SameSite=None; Secure`。
- 所有数据接口都要登录；未登录一律 401。
- 改密码会同时轮换会话密钥，其它设备立即失效。
- 初始密码是 `123456`，**请务必先在「我的 → 账号设置」里改掉**。改密码会让其它设备下线。
- 笔记内容会发送到 DeepSeek 官方接口用于生成回答，这是 AI 功能的必要前提；除此之外不流向任何地方。

---

## 一些设计取舍

- **锚点日期**：每条记录除了时间戳还存一个 `date` 字段，按本地日期分组，避免跨时区/夏令时把记录挪到隔壁天。
- **软删除**：删除只是打标记，数据还在文件里，改错了能翻回来。
- **JSONL 追加**：写入是 O(1) 追加，断电最多丢最后一行；累积到 300 次改动会自动合并压缩一次。
- **服务器为准 + 本地缓存**：清掉浏览器数据不会丢笔记；离线也能记，联网自动补传。
- **hash 路由**：静态托管不需要任何服务端重写规则，刷新任何页面都不会 404。
