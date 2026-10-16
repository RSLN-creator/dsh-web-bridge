# 除 DeepSeek 外全部站点的「三项适配」真机审计（2026-10-14）

> **第二轮补充（同日 23:35）：Phase 2 真实对话验证已执行完毕。** 五站四态读数见 §10，
> 本轮由 Phase 2 暴露并修复的第二条真缺陷（contenteditable 回读判据）见 §11。
> 结论按纪律如实分四态，**没有把 UNVERIFIED 写成通过**。

> 本轮用户指令（逐字）：**「除了 deepseek 之外的所有站点（除了未登录，全是国模）：全部的对话问题：
> 风控你自己作为主裁判实施：然后你来判断风控和放行子智能体的操作：进行真实站点操作。
> 记住：只有全部必要操作全部做完：每个网站模型适配提示词，模型适配思维链，工具调用方法。
> 然后才能让他进行真实操作。先 plan 后 goal，限时是：每个子智能体 1h，你主队话 2h」**
>
> 用户后续补充（逐字）：**「qwen 不是我不想登录：是你的验证出了问题：rsyhnhln@qq.com 账号名这个：
> 需要验证码向我提问，你得一并解决」**、**「不是，你自己看左下角的登录啦啊，我看头像没有吗？
> 只是每次都有一个广告界面要先固定点×先，aaa 账户头像都有了」**、
> **「每次画面没加载 好你就关闭了！你自己截图看！」**（方法论纠正，见 §12）
>
> **证据分级**（照抄仓库纪律）：【码证】= 读源码/测试/文档的字面事实，附 `file:line`；
> 【实证】= 本机实际运行得到的读数（命令 + 原始输出）；【推断】= 由码证+机制推出，尚未实测；
> **【待验】**= 需真机/真实账号，本轮**没做**。

---

## 0. 一句话结论

**「三项前置全部做完才允许真实操作」这条纪律，在本轮救了所有站点。**
四个已登录站点里**有三个**的「思维链适配」在真机上**根本走不通**（GLM 档位点不到、kimi 选路判错、
doubao 回读判据与真机不符）——若先发真消息，这些缺陷会被误记成「站点风控」或「网页不稳定」。

本轮**已修复**其中三条真缺陷（用户批准后由 Lead 串行落笔，全部真机回归通过），
qwen 的登录阻塞已定性并交回用户（需要人过邮箱验证码，代码不绕风控）。

| 站点 | prompt | cot | tool | 真实发送 | 依据 |
| --- | --- | --- | --- | --- | --- |
| **glm** | PASS | **已修** PASS 3/3 | **FAIL**（端到端未验） | **未发**（前置未全绿） | `.tmp/site-reports/glm.md` |
| **kimi** | PASS（静态） | **已修** PASS 2/2 | UNVERIFIED | **未发** | `.tmp/site-reports/kimi.md` |
| **doubao** | PASS | **已修** PASS 2/2 | PASS（仅教学对表） | **未发** | `.tmp/site-reports/doubao.md` |
| **zai** | PASS | PASS 3/3 | BLOCKED（需发送） | **未发** | `.tmp/site-reports/zai.md` |
| **qwen** | 【待验】 | 【待验】 | 【待验】 | **BLOCKED（未登录）** | `.tmp/site-reports/qwen-login.md` |
| chatgpt / grok | 无结构性障碍 | **档位下发结构上做不到** | 无结构性障碍 | 未登录 | `.tmp/site-reports/unlogged-chatgpt-grok.md` |
| claude | **地区受限** | 同左 | 同左 | 不可达 | `.tmp/site-reports/unlogged-claude-gemini.md` |
| gemini | 【待验】 | **结构上不可分离** | 【待验】 | 未登录 | 同上 |

**本轮真机发送次数 = 0。** 全部真机操作都是**只读**（打开页面、读 DOM、点档位控件菜单），
一次消息都没发；这一点由 V1 复核官独立核验（见 §7）。

---

## 1. 风控主裁判（Lead）的放行机制

用户要求「风控你自己作为主裁判实施」。落地成三道闸：

1. **闸门文件** `.tmp/real-lane/GATE.md`：每站点 prompt/cot/tool 三行必须由 Lead 写成 `APPROVED`，
   才允许执行真实发送；未批准 = 一次都不许发。
2. **发送纪律**（`CONTRIBUTING.md` §1.3 + `doc/long-term-issues.md` #29 的既有成文）：
   串行、每站每变体 ≤3 次、间隔 ≥20s、**有头**运行（让验证码人能看见）、
   命中可见 captcha 即停并如实记 `BLOCKED`、**一律不绕风控**。
3. **执行器** `.tmp/real-lane/PHASE2-RUNBOOK.md`：唯一发送器 `site-verify.mjs`，
   一次 `--site <id>` 正好 3 次发送（等于每变体额度上限）。

**风控实况（本轮读数）**：

| 站点 | 风控读数 | 级别 |
| --- | --- | --- |
| zai | `enable_captcha=true` 而 captcha 节点 **0 个在页**（`#chat-captcha-element` total=0）；**未弹窗、未发消息** | 【实证】`.tmp/site-probes/zai/` |
| qwen | 预置阿里 NC 滑块容器 `#waf_nc_block`（当前 `display:none`，**今天没弹**） | 【实证】`qwen-login.md` §1.6 |
| glm / kimi / doubao | 未命中任何 captcha 节点 | 【实证】各站报告 |

⚠ **不许把「节点 0 个」读成「风控已关闭」**：zai 的 `enable_captcha=true` 是站点自己说的，
闸门在**发送那一刻**才跑。本轮零发送 ⇒ 风控是否拦截**未被验证**。

---

## 2. 本轮修复的三条真缺陷（全部真机回归通过）

> 用户批准：「修（推荐）：GLM 补 optionSelector + doubao 回读判据改对勾 svg」。
> 共享文件（`lib/think-effort.js`）**只由 Lead 串行落笔**，子智能体只交证据。

### 2.1 GLM：档位下发整轮失败 → **1/3 → 3/3 PASS**

**现象**【实证】：`applyEffort(page, {siteId:'glm', target:'快速'})` 抛
`THINK_EFFORT_UI_CHANGED: 站点 glm 的思考档位子菜单入口「思考强度」不可点`；
`极致` 因走幂等快路恰好通过 ⇒ **该缺陷长期躲过真机复跑**。

**三层根因**（每一层都靠真机 trace 取出，非推断）：

1. 入口「思考强度」在**尚未打开的模型弹层里**：弹层未开时 `getByText` 命中 0，
   旧实现在此直接 `fail`。真机 trace：先点一次 `.think-mode-trigger` 开弹层后，
   同一 `getByText` 立刻 `count=1 / visible=true`。
2. GLM 档位条目是**裸 `div.think-mode-item`**（无 `role`/`data-state`）⇒
   不在 `CLICK_EFFORT_OPTION` 的 `CLICKABLE` 白名单里 ⇒ 候选池 `poolSize=0`（本段原无 `optionSelector`）。
3. 补上 `optionSelector` 后仍失败：`.think-mode-item` 同时命中**左列模型行**
   （`GLM-Flashnew5.3-Flash，回复速度快`）与**右列档位条目**（`快速`）；
   `filter({hasText:'快速'})` 匹配 2 个元素 ⇒ Playwright 严格模式 `isVisible()` **抛错**
   ⇒ 被 `catch` 吞成 false ⇒ 误报 `UNAVAILABLE`。
   另：重试时只重开模型弹层，**没有重新展开子菜单** ⇒ 下一档必然失败。

**修法**（`lib/think-effort.js`）：
- GLM 段补 `optionSelector: '.think-mode-item'`；
- `CLICK_EFFORT_OPTION` 支持 `{want, selector}`：**限池**后才启用前缀判据
  （GLM 真实条目文本是 `深度处理复杂任务` 这类**前缀**形态，旧的 `endsWith` 恒 false）；
- `click-option` 改为 **locator 优先 + 页面侧兜底**（kimi 的 testid 走 locator，
  GLM 走页面侧；护栏 ④ 钉住 kimi 那条路径不变）；
- 重试时若声明了 `itemLabel`，**重新展开子菜单**。

**回归**【实证】：`glm` 1/3 → **3/3 PASS**（`快速`/`深度`/`极致` 全绿）；
`test/think-effort.test.mjs` 27/27。

### 2.2 doubao：回读判据与真机不符 → **0/2 → 2/2 PASS**

**现象**【实证】：`probe-think-effort-live.mjs doubao` → `FAIL（0/2）`，
两档均 `THINK_EFFORT_UI_CHANGED / no-readback`。

**真机读数**：两条目 `aria-checked` / `data-state` **皆为 null**（全页 TRUE 计数 = 0）；
菜单开着时 `豆包 快速` 条目 svgCount=1（对勾 `M20.2246…`）、`豆包 专家` svgCount=0。

**⚠ 一条必须记下的证伪（Lead 自己第一版改法错了）**：
第一版按「对勾 svg 是唯一区分特征」新增了 `menuitem-svg` 口径 —— **实测证伪**：
豆包的 radix 菜单**点完条目后立刻关闭**，回读那一刻 `role="menuitem"` 条目**已不在 DOM**
（trace：`afterClick_*` 各采样点 menuitem 数 = 0）。
⇒「读弹层选中项」这一类口径（`aria-checked` / `menuitem-svg`）对豆包**结构性不可用**：
**不是判据不对，是读的时机窗口不存在。**

**修法**：改走 `effort-text` —— 真机 trace 显示点完后触发钮文本
**从 `豆包 快速` 变成 `豆包 专家`**；本段已声明 `triggerText:'豆包'`，
`effortFromTriggerLabel` 剥掉锚点即得档位，无需新增页面侧函数。

**回归**【实证】：doubao **0/2 → 2/2 PASS**；护栏 27/27。

### 2.3 kimi：选路判据被 GLM 的修复顺带修正 → **2/2 PASS**

site-kimi 独立报的 D1（档位是**二级菜单**，但 `useSubmenu()` 判它不需要 ⇒ `THINK_EFFORT_UNAVAILABLE`）
与上面 GLM 那三层是**同一条链**；修复后真机复跑 **kimi 2/2 PASS**（`标准` / `进阶`）。
⚠ 这条是**顺带修好的**，不是专门针对 kimi 设计的修复 ⇒ kimi 的长跑稳定性仍【待验】。

### 2.4 反向验证（护栏必须是真护栏）

| 判据 | 变异 | 读数 |
| --- | --- | --- |
| doubao 回读口径 | `effort-text` → 旧 `aria-checked` | **27 → 26 pass / 1 fail** ✔ |
| GLM `optionSelector` | 删掉该行（真机复跑） | **3/3 → 1/3**，错误与修复前逐字同形 ✔ |

还原后逐字一致、复跑全绿。**方法教训**：我第一版反向验证用 `Set-Content` 写回，
**破坏了文件编码**（中文全丢、文件从 1087 行变 778 行）——已 `git checkout` 恢复并用
`[System.IO.File]::WriteAllText(... UTF8Encoding($false))` 重做。
**教训**：**变异测试前先备份、写回必须指定无 BOM UTF-8**，否则"还原"本身会变成一次事故。

---

## 3. qwen：用户「你的验证出了问题」的根因（需要用户手动一步）

用户原话：「qwen 不是我不想登录：是你的验证出了问题：rsyhnhln@qq.com 账号名这个：
需要验证码向我提问，你得一并解决」。

### 3.1 根因【实证 + 码证】

**不是 qwen 弹验证码拦人，是桥的登录循环等不了人输码。**

| 时刻 | 事件 | 来源 |
| --- | --- | --- |
| 2026-09-30 01:42:18 | 用户请求 `rsyhnhln@qq.com` 的邮箱验证码 | 【实证】localStorage `email_otp_cooldown` |
| 2026-09-30 01:46:58 | 桥落盘 `login wait timed out` | 【实证】desktop profile 状态文件 |

⇒ **相差 279.8 秒**，而桥的登录窗口只等 **300 秒**（`loginTimeoutMs: 300_000`，
`index.js:297` / `browser-driver.js:870`），且那个循环（`browser-driver.js:4655-4679`）
只有「URL 含 sign/login → continue」与「judgeLoggedIn」两个判据，
**从不调用 `detectChallenge`** ⇒ **结构上分不清「人正在输码」与「人放弃了」**。
这正是 `doc/long-term-issues.md` **#33** 登记的缺口现场。

**今天 qwen 确实没登录**（15 个 cookie 无一承载登录态、localStorage 只有
`qwen_token_logged_out_marker`、页面上「登录」「注册」可见）——`probe-bad` 是**真命中**，不是谎报。

**而且今天没有任何可见窗口**：8213 上那个浏览器 `--headless`、UA `HeadlessChrome/151`、
`MainWindowHandle` 全为空 ⇒ 用户**想登也没有地方点**。
（Lead 实测该端口 `/json/version` 返回 200；本机其余站点的 `DevToolsActivePort` 全部
`ECONNREFUSED`，因为它们都已被关掉。）

### 3.2 需要用户做什么（可直接照做）

1. **GUI 里打开一个真正可见的 Qwen 窗口**：「设置 → 网页桥接 → Qwen 那一行 → 点『打开窗口』」。
   它走 `POST /__webcode/window`（`web-control.js:542`）→ `launch({headless:false})`，
   **立刻返回、无 300 秒超时**。
   ⚠ **不要点设置页的「登录」按钮** —— 那条路就是 300 秒墙钟
   （`browser-driver.js:4657`），等不到就走同一个失败出口。
   ⚠ 这一步会**关掉再重启**那个无头浏览器（`browser-driver.js:4735-4739` 的设计如此），
   页面会重新加载一次，**不是故障**。
2. 在窗口里填 **`rsyhnhln@qq.com`** → 「继续」→ 去 QQ 邮箱取 6 位验证码 → 填入 → 继续。
   （本次不需要用户把验证码发给 Lead —— 桥只需要"人把这一步做完"。）
3. 做完告诉 Lead，Lead 读三处确认：`sites/qwen/webcode-login-state.json` 期望
   `loggedIn:true` + `basis:probe-ok`；`/__webcode/status` 的 qwen 行期望 `needLogin:false`；
   再只读附着 8213 看「登录/注册」是否消失。
   ⚠ **别看 `loginState`，它恒为 `idle`** —— 那是下面的缺陷 ①，不代表失败。
4. **两个账号请先确认用哪个**：`rsyhnhln@qq.com`（邮箱验证码，用户本次指名）与
   `3316399314@qq.com` / GitHub `RSLN-creator`（历史上成功的那次）是**两个身份**。

### 3.3 顺带发现的三条真缺陷（均已登记，本轮未修）

| # | 缺陷 | 证据 | 级别 |
| --- | --- | --- | --- |
| ① | **#53 的三态是死代码**：`browser-driver.js:1548` 精心算出的 `loginState`（`verified-in`/`-out`/`uncertain`）在 **`:1586` 被简写 `loginState,` 覆盖**（后者是 `:925` 的登录进度 `idle`）。JS 对象字面量后写者胜 ⇒ **0.19.75 的三态从未到达面板** | 活体反证：10 行 `loginState` **恒为 `idle`**，而三态只可能返回那三个值之一 | 【码证】+【实证】 |
| ② | `detectChallenge` 正则匹配不到 qwen 的阿里系风控指纹：`waf_nc_block` / `WAF_NC_WRAPPER` / `baxiaCommon.js` / `fireyejs.js` / `AWSC/awsc.js` / `sufei_data` **逐条实测 False**（`browser-driver.js:1113`） | qwen 页面确实预置 `#waf_nc_block`（当前 `display:none`） | 【实证】 |
| ③ | qwen **无 `captchaSelector`**（只有 zai 有）⇒ 发送侧 `WEB_CAPTCHA_REQUIRED` 对其**永不触发** | `providers.js` qwen 段 | 【码证】 |

**① 的 Lead 独立复核**：我亲自读 `browser-driver.js:1540-1590`，确认
`:1548-1561` 两个 IIFE 算出的三态与 `loginVerified`，在 `:1586` 被 `loginState,`
（`:925` 的进度变量）覆盖 —— **缺陷成立**。

---

## 4. doubao 登录态：用户是对的，我和子智能体都读错了一次

用户原话：「不是，你自己看左下角的登录啦啊，我看头像没有吗？
只是每次都有一个广告界面要先固定点×先，**aaa 账户头像都有了**」

**Lead 亲自开有头窗口复核（用户指令「你自己看」）**：

| 判据 | 声明（`providers.js:431-434`） | 真机命中 |
| --- | --- | --- |
| `loginProbe.bad` | `button:has-text("登录")…` | **0**（已登录 ⇒ 登录按钮消失，**正确**） |
| `loginProbe.ok` | `[class*="avatar"], .user-avatar, img[class*="avatar"]` | **0** ❌ |
| `accountProbe.avatar`（**同文件**） | `img[src*="passport.byteacctimg.com/img/user-avatar"]` | **1**（`36x36@17,850`） |
| `accountProbe.name` | `span.min-w-0.overflow-hidden.text-left` | **`aaa`**（逐字） |
| 生产 `judgeLoggedIn` 复刻 | — | **`probe-fallback`** ⇒ 按 #53 三态 = `uncertain` |

⇒ **用户完全正确**：账号头像与昵称 `aaa` 都在（截图为证）。
**根因**：真实头像的 class 是 `rounded-full object-cover select-none mr-8 h-36 w-36`，
**不含 "avatar" 字样**（词只在 `src` 的 `/img/user-avatar/` 里）；
而**同一份声明里的 `accountProbe.avatar` 早就有正确选择器**——两处口径不一致，
于是**已登录的 doubao 被判成不确定**。

**用户指出的另一条现场事实也被证实**：屏幕上有一个全屏广告遮罩
（`fixed inset-0 backdrop-blur-[4px]`，「下载电脑版」带 ×），
它**遮挡点击** ⇒ 任何「选择器点不到」的结论都必须先排除遮罩
（site-glm 独立发现同型现象：首轮点击失败是 `el-overlay-dialog` 拦了 actionability）。

**V1 复核官补充**：doubao 的登录判定是**双向都不可靠** —— 21:44 那次 `bad.count=1`（假阴），
22:00 那次 `bad.count=0` + 头像在（假阳 `probe-fallback`）。
报告 §5.3 曾写「该站当前实为未登录」，**已被推翻**（正确结论是「判据双向不可靠」，与 #53 同型且更严重）。

---

## 5. 各站点三项适配的完整读数（摘要）

### 5.1 结构性做不到的（不是缺陷，是能力边界）

| 站点 | 做不到的那一项 | 依据 |
| --- | --- | --- |
| gemini | **思考与正文在架构上不可分离**：`decoder.js:1161` 的注册表里 `dom: null` —— 它不是解码器，是「**没有解码器**」的哨兵；`browser-driver.js:1729` 用 `decoderKind !== 'dom'` 直接跳过 ⇒ `onThink`/`onDelta` **从不被调用**；终态 `thinking: ''` 是**硬编码字面量空串**（`:3902`） | 【码证】`unlogged-claude-gemini.md` |
| claude | **地区受限**：全文件只有 3 行**注释**，**无字段、无分支消费** ⇒ 登录这一环在代码层面就不存在，「补一次登录」也过不去 | 【码证】同上 |
| chatgpt / grok | **档位下发**：桥里没有任何这两站的网页档位知识（无 `efforts`/`effortControl`），且这是 `think-effort.js:45-52` 写明的**刻意取舍**，被 `test/think-effort.test.mjs:275-281` 钉死。⚠ **不能读成「cot 整条做不到」**——两站的思考流解码通道都存在（`decoder.js:493/:501`、`:886`） | 【码证】`unlogged-chatgpt-grok.md` |

### 5.2 token 侧（提示词 / 工具）普遍健康

- **提示词投递**：10 站点里 deepseek 走 `official` 变体、glm 走 `glm` 变体，
  其余 8 站走 `default`（`agent-preset.js:490-500` 的 else 支）。换行规范化白名单只有三项
  （`browser-driver.js:422-424`）：`\r\n?`→`\n`、行尾 `[ \t]+$`、`normalize('NFC')`。
- **工具调用**：协议形状只有一处定义（`agent-preset.js:2553`：
  `tagged || obj.mcp_action === 'call'`）；`tool-parser.js` **确认未接线**
  （全树唯一 import 在 `test/tool-transport.test.mjs:13`）；
  **会话丢失处置满足红线**（`browser-driver.js:4169-4178` 抛 `WEB_SESSION_LOST`
  「没有第四态，不默默开新会话」→ `index.js:3632-3723` 取落盘正本**整段重放**）。

### 5.3 本轮**未做**的（诚实边界）

- **真实对话验证（Phase 2）：一次都没跑。** 四站里三站的 cot 前置未绿（现已修复但
  **修复后仍未做端到端真实发送**），qwen 未登录 ⇒ 按用户纪律「三项前置全部做完才能真实操作」，
  本轮**没有站点满足放行条件**。
- 长运行稳定性（>120s 单轮）、多轮工具循环收敛、会话重启恢复、视觉上传——全部【待验】。
- 未登录 4 站的「登录后最小验证清单」已写好（各站报告），但**一条都没执行**（无登录态）。

---

## 6. 团队编制与并行方式

| 角色 | 执行者 | 产出 |
| --- | --- | --- |
| S1–S4 站点审计 | `site-glm` / `site-kimi` / `site-doubao` / `site-zai`（durable teammate） | `.tmp/site-reports/<site>.md` |
| S5 qwen 登录根因 | `site-qwen`（durable teammate） | `.tmp/site-reports/qwen-login.md` |
| S6–S8 共享层审计 | `audit-prompt` / `audit-cot` / `audit-tool`（durable teammate） | `.tmp/site-reports/shared-*.md` |
| S9a / S9b 未登录 4 站 | subagent ×2（首个执行者上下文耗尽后**拆小重派**） | `unlogged-*.md` |
| V1 / V2 独立复核 | subagent ×2（对每份报告**取伪**） | `.tmp/verify/verdict-*.md` |

**编制约束的实际读数**：durable teammate 上限 **8**（Lead + 7 已满），
故 S9/V1/V2 改用 subagent（同样计入「≤12 子智能体」）。全部执行者 1h 时间盒内完成。

**写入隔离**：所有 agent 只写 `.tmp/`（`doc/` 报告与 `lib/` 修复**只由 Lead**落笔）；
V1/V2 复核官全程只读他人报告，未改任何 tracked 文件。

---

## 7. 独立复核（取伪）的结论

### V1（5 份站点报告，7 条实际取伪）

| 报告 | 判定 | 关键 |
| --- | --- | --- |
| glm | **可靠** | `CLICK_EFFORT_OPTION` 三档全 false 的因果链闭合 |
| kimi | **可靠** | **重量级结论独立复现**：`copyProfile` 无 mkdir ⇒ `hasDefault=false`（11 个顶层文件）；补一句 mkdir ⇒ 301 个文件。**推翻 #32 归因** |
| doubao | **部分可靠** | §5.3「实为未登录」**被推翻**（双向不可靠） |
| zai | **部分可靠** | §9 SHA 台账 1 条过期 + 漏 3 条 |
| qwen-login | **可靠** | 字节级复核逐字复现 |

**违规检查：零发送成立**（三条独立证据）：`webcode-send-state.json` 最后一条发送停在 **21:10:03**
（早于最早报告 21:51:28）；全部探针脚本 grep 无发送路径（`keyboard.press` 全是 `Escape`）；
`sites/*/webcode-login-state.json` mtime 全早于报告窗口。

⚠ **V1 发现的一处台账分叉（需如实记录）**：send-state 里 **zai 有 21:08:50 的发送且 `end=null`**，
而 `GATE.md` 写 zai「已用 0 次」。zai.md §8.2 独立发现了同一时刻的残留桥锁与 `DevToolsActivePort`
⇒ 说明那次会话被中断。**这条发生在团队开工（21:33）之前**，不是本轮 agent 发的；
但**它说明「已用次数」这个字段不能只看 GATE 台账**，应以 send-state 为准。

### V2（3 份共享层审计，5 条实际取伪）

| 报告 | 判定 | 关键 |
| --- | --- | --- |
| shared-prompt | **部分可靠** | 30 组 `file:line` 抽查 28 组精确；G1 定级取伪**攻击失败**（作者正确：只影响显示、不影响真实发送） |
| shared-tool | **部分可靠（头条结论不可靠）** | **头条被证伪**：GLM 原生夹具**不是**空护栏 —— `test-mock/probe-glm-native-shapes.mjs` 逐字读全部 3 份夹具并 PASS，且与夹具**同一提交**（`21bb3f9`）加入。作者那条「一条命令即可证伪」的命令**本身是坏的**（`test-mock` 路径在仓库根不存在，PowerShell 静默跳过 ⇒ 必然返回空） |

**V2 的两处计数错误**（已记）：`TOOL_CALL_UNPARSED` 实测 **32** 处（报告写 8）；
形态表 **9** 行（报告写 10）。一处**越界行号**：`prompt-variants.js:351-355`（该文件只有 225 行）。

> **方法论价值**：V2 这两条取伪恰好演示了本仓库最贵的一类错误 ——
> **「报告说没有护栏」与「报告说命令返回空」都可能是取证方法坏了，而不是事实如此**。
> 与 `doc/long-term-issues.md` §4.2（头注说已接线、实际从未 import）同源。

---

## 8. 本轮发现但**未修**的缺陷（登记用）

| # | 缺陷 | 位置 | 级别 |
| --- | --- | --- | --- |
| 1 | **`strictModelType` 是死声明**：契约里写了 true/false，全 `lib/` **零消费**；真正的严格模型核验是 `browser-driver.js:3907` 一行硬编码 `siteId === 'deepseek'`。⚠ 它正是 `AGENTS.md` §4 第 1 条点名的红线字段 | `contract.js:23/:51` | 高 |
| 2 | **#53 三态是死代码**（`loginState` 被覆盖，见 §3.3①） | `browser-driver.js:1548` vs `:1586` | 高 |
| 3 | **doubao `loginProbe.ok` 与 `accountProbe.avatar` 口径不一致** ⇒ 已登录被判 `uncertain` | `providers.js:431-434` vs `:451-454` | 高 |
| 4 | **`copyProfile()` 缺 mkdir + 静默吞 ENOENT** ⇒ 副本无 `Default/` = 空 profile。**全站点通病**（kimi 已文件级证实，glm/zai/qwen/doubao 属推断） | `probe-think-control.mjs:74-87`、`probe-think-effort-live.mjs:67-82`、`probe-account-identity.mjs:113` | 高 |
| 5 | **`detectChallenge` 匹配不到 qwen 的阿里系风控指纹**；且 qwen 无 `captchaSelector` ⇒ `WEB_CAPTCHA_REQUIRED` 对其永不触发 | `browser-driver.js:1113` | 中 |
| 6 | **登录循环不检测验证码**（#33 缺口现场），失败落盘**不写 `basis`** ⇒ 原因下沉 | `browser-driver.js:4655-4679`、`:4693` | 中 |
| 7 | **`contract.js` 7 个字段生产代码零消费**（`requestMetadataKeys`/`siteOrigin`/`decoder`/`experimental` 等），真源都是 `site.*` | `contract.js` | 中 |
| 8 | **`ChatGptDecoder` 不产出 `conversationId`**，`finish()` 也不带 ⇒ 该站无任何会话身份来源 | `decoder.js:434-455` | 中 |
| 9 | **grok 解码器零护栏零夹具**（`test/` grep 0 命中） | `decoder.js:882-888` | 中 |
| 10 | **`</think>` 剥除跨帧切分时失效**（`正文</thi` + `nk>尾巴` 两出口都留残片），与 CHANGELOG 0.19.47 承诺矛盾 | `decoder.js` glm 段 | 中 |
| 11 | **gemini `DOM_CAPTURE` 轮询上限 240s 与 `requestTimeoutMs` 默认 240_000ms 持平** ⇒ 最坏情况同时到期、已抓文本被丢弃 | `browser-driver.js:325-331`+`:871` | 中 |
| 12 | `zai-capture-frames.mjs:216` 仍用被 #56① 推翻的旧可见性判据 ⇒ #29 那句「captcha 节点仍可见」很可能是「空壳 + rects 兜底」 | `test-mock/` | 低 |
| 13 | `ZaiDecoder` 三处字段覆盖缺口（只带 `content` 快照会丢正文且仍报 complete；`tool_name`/`content_blocks` 帧静默丢弃） | `decoder.js` zai 段 | 低 |

---

## 9. 可复核入口

```powershell
# 三项适配的真机零发送回归（Lead 自建，直接对真实 profile，不拷副本）
cd D:\9_Code_Workspace\dsh-webcode-bridge
node .tmp\real-lane\lead-effort-regression.mjs glm     # 期望 3/3 PASS
node .tmp\real-lane\lead-effort-regression.mjs kimi    # 期望 2/2 PASS
node .tmp\real-lane\lead-effort-regression.mjs doubao  # 期望 2/2 PASS
node .tmp\real-lane\lead-effort-regression.mjs zai     # 期望 3/3 PASS

# 护栏（含反向验证用变异点）
cd package\dsh-webcode-bridge
node test\think-effort.test.mjs        # 期望 27/27 exit 0
node test\provider-surface.test.mjs    # 对外面逐字不变
```

**真机发送仍未做**，闸门在 `.tmp/real-lane/GATE.md`，执行手册在 `.tmp/real-lane/PHASE2-RUNBOOK.md`。

---

## 10. Phase 2：五站真实对话验证的四态结果（2026-10-14 23:00–23:35）

**执行方式**：`site-verify.mjs --site <id> --profile-root <副本根>`，**有头**、串行、每站一次
（= 3 次发送 = 每变体上限）。完整台账：`.tmp/real-lane/PHASE2-RESULTS.md`；原始日志 `.tmp/real-lane/out/*-phase2*.log`。

| 站点 | 四态 | PASS | FAIL | BLOCKED | UNVERIFIED | 一句话 |
| --- | --- | --- | --- | --- | --- | --- |
| **qwen** | UNVERIFIED | **9** | 0 | 0 | 2 | 链路通；`sessionId` 两轮皆 null ⇒ 不算往返闭环 |
| **glm** | UNVERIFIED | **10** | 0 | 0 | 1 | **`tool.resultRoundTrip` PASS**（第二轮 127 字 + **会话 id 一致**）|
| **zai** | FAIL | **9** | 1 | 0 | 1 | 第二轮切模型 `MODEL_UNAVAILABLE …（no-options）`，**两次运行读数一致** ⇒ 可复现 |
| **kimi** | FAIL | 2 | 1 | 0 | 8 | 站点侧限流：`resource_exhausted：和Kimi聊天的人太多了` |
| **doubao** | FAIL | 2 | 1 | 0 | 8 | **站点弹图片式人机验证**，桥未识别 ⇒ 报「超时」而非「需验证」|

### 10.1 本轮最硬的正面读数：glm 的完整工具闭环

```
PASS  tool.callParsed       — 解析出 1 条：read
PASS  tool.resultRoundTrip  — 第二轮收到 127 字，会话一致（6acf9978581cc707568d90bc）
```

⇒「调用 → 本地执行 → `mcp_action:"result"` 回填**同一个**网页会话 → 第二轮收束」这条链路
**在 glm 上真实成立**。这是本轮唯一拿到完整 `tool.resultRoundTrip` PASS 的站点。

### 10.2 kimi：站点侧限流（不是桥的缺陷，但工具的**归类**有问题）

站点自己回的原文：

```
resource_exhausted：zh-CN@和Kimi聊天的人太多了，订阅会员可进入优先队列
流首段: {"heartbeat":{}} {"eventOffset":1,"done":{}} {"error":{"code":"resource_e…
```

**这是外部条件**（站点忙/限流），按本仓库四态纪律应当记 **BLOCKED**；
但 `site-verify.mjs` 把它归进 `send.text` 的 **FAIL** 分支——因为它的分类正则
只认 `CAPTCHA|RATE_LIMIT|NEED_LOGIN`（`site-verify.mjs:232`），站点自己的
`resource_exhausted` 不在其中。
⇒ **工具侧归类缺陷（真实、可复现）**：`FAIL` 与 `BLOCKED` 的区别在仓库纪律里是硬的
（前者是产品结论、后者不是），这个站点码不在表里就会把「站点太忙」记成「桥坏了」。

### 10.3 doubao：站点弹图片式人机验证，桥**没识别**

截图铁证（`.tmp/site-probes/doubao/doubao-answer2-*.png`）：消息**发送成功**（气泡可见），
随后 doubao 弹出**图片选择式验证**：

> 「常见于森林的生态元素 / 请选择所有符合上文描述的图片，并拖拽到下方」+ 提交按钮

⇒ 网页在验证通过前**不生成回复** ⇒ 桥等 110s，报
`turn timeout scene {captureAlive:true, replyChars:0, selectorHit:false}`。

**为什么桥没识别**：doubao **未声明 `captchaSelector`**（全仓只有 zai 声明了，`providers.js:640`），
而 `detectChallenge`（`browser-driver.js:1168-1183`）的三条判据是
「title 命中滑块/验证」「body 文案命中…」「WAF 脚本指纹」——**图片选择式**验证的文案
（「请选择所有符合上文描述的图片」）**不在** body 正则里（那里有「请点击下方图形」「请依次点击」，
但没有「请选择所有…图片」这一形态）。
⇒ **真实缺陷**：报错方向误导（用户会以为桥/网页卡住，而不是「需要你去过验证」）。

### 10.4 zai：第二轮切模型失败（可复现）

```
FAIL  tool.resultRoundTrip  — 第二轮（回填结果）失败：
      MODEL_UNAVAILABLE: 未能切换到 GLM-5.3-Flash（no-options）
```

- 抛点 `browser-driver.js:4421`，由 `model-picker.js:314` 的 `ok:false, reason:'no-options'` 触发。
- **两次独立运行读数完全一致**（不是时序抖动）。
- 【待验】第二轮为何要走切模型、以及 `zai:glm-5.3-flash` 在第二轮菜单里为何 0 选项。

### 10.5 未做的（诚实边界）

- kimi / doubao 的 8 项 UNVERIFIED **本轮拿不到读数**（被限流 / 被人机验证挡住）⇒ 不是通过。
- 全部读数来自**我拷贝的 profile**（线上桥进程持有各站 `webcode-bridge.lock.json`）
  ⇒「线上那个 profile 也验过了」**不成立**。

---

## 11. Phase 2 暴露并修复的第二条真缺陷：contenteditable 回读判据

### 11.1 现象（自相矛盾的报错）

```
FAIL send.text — PROMPT_TRUNCATED: 网页输入框只接收了 20/17 字符（判据=content-mismatch）
```

**回读（20）比发送（17）还长** —— 这个形状本身说明判据错，不是网页截断。

### 11.2 真机读数（doubao/tiptap，只写不发送）

| 写入（17 字）`[本地工具传输协议]\n请回复：收到` | 结果 |
| --- | --- |
| `innerText` | **18** 字（`\n` → `\n\n`） |
| `textContent` | **16** 字（换行被吞） |
| **块感知读取（新）** | **17 字 ✓** |

**根因**：tiptap/ProseMirror 把**每个换行渲染成一个块级 `<p>`**：

| 写入 | DOM |
| --- | --- |
| `a\nb` | `<p>a</p><p>b</p>` |
| `a\n\nb` | `<p>a</p><p class="is-empty"><br></p><p>b</p>` |

于是 `innerText` 在**块与块之间**补 `\n\n`（换行数翻倍），`textContent` **不补任何分隔**
（换行被吞）。**两个浏览器内建读数都不等于写入内容** ⇒ `composerEchoVerdict` 恒判
`content-mismatch` ⇒ **每一轮含换行的提示词都被 `PROMPT_TRUNCATED` 拦住**。
DSH 的真实轮次**必然含换行**（preset 是多行文本）⇒ 这是 **doubao 全线不可用**的量级。

### 11.3 修法：修**读取**，不放宽判据

新增纯函数 `EDITOR_BLOCK_TEXT`（`lib/browser-driver.js`，**v4**）：

1. 有块级子节点时**只按顶层子节点切分**，每段取「行内文本」，用**单个 `\n`** 连接；
2. 行内文本递归拼接，行内 `<br>` 记一个 `\n`（那是用户的硬换行）；
3. **只含换行的段视为空串**（空块里的 `<br>` 是 ProseMirror 的**占位断行**，不是用户写的换行）；
4. 去掉**首尾**空段（编辑器边界空 `<p>`），**中间空段保留**（那是真空行）。

`readComposer` 对 contenteditable 改用它。
**`composerEchoVerdict` 的白名单一个字都没动** ⇒ 真正的截断在块感知读取下**依然**不等、照旧被拦。

**真机验证**：doubao **7/7**、kimi **7/7** 逐字精确（含空行、`\t`、17 字原案两处）。
**效果**：doubao 的 `PROMPT_TRUNCATED` **消失**，失败下沉到下一层（暴露了 §10.3 的验证弹窗）。

### 11.4 变异测试的反向验证（护栏必须是真护栏）

| 变异 | 读数 |
| --- | --- |
| 把「空块占位 `<br>` 记空串」去掉（退回 v3） | **25 → 23 pass / 2 fail** ✔ |
| 把 `join('\n')` 改成 `join('')` | **25 → 21 pass / 4 fail** ✔ |

还原后 25/25。新增 6 条护栏落在 `test/composer-write.test.mjs`（用最小 DOM 桩，不引 jsdom）。

### 11.5 一条方法论更正：我用错了四个版本的算法，全靠真机读数收敛

v1（wrap 每块加 `\n`）4/5 → v2（递归 join）**1/6** → v3（顶层切分 + join）5/7 → v4（空块记空串）**7/7**。
**每一版都是被真机读数否掉的**，而不是靠推理选出来的。
⇒ 与 §12 的教训同源：**这类 DOM 形状的判断必须实测**，`innerText`/`textContent` 的直觉都不可靠。

---

## 12. 用户的方法论纠正（必须记住的一条）

用户原话（逐字）：**「每次画面没加载 好你就关闭了！你自己截图看！」**

**成立，而且是我这轮最该记的一条。** 具体错在：

1. 我多次在 `page.evaluate` 之后**没有截图**就下结论，或**截图截早了**——
   qwen 的「访问验证」那次，我截到的内容区是空白的，于是判断「无可点元素」；
   而用户随后**亲手过了验证**（「你截图截早了点，有的，我过了，输了验证码登录了」）。
2. 真正的教训是**两层**：
   - **对站点**：SPA 的「瞬时状态」与「稳定状态」不是一件事（§10 的 qwen 水合竞态就是这条的代码版）；
   - **对我自己**：`page.close()` / 截图 都要等**页面进入稳定态**，
     并且**每次判断前先看一眼截图**——本轮的 doubao 验证弹窗正是**靠截图**才钉死的
     （`replyChars:0` 光看数字会误判成「网页没生成」）。
3. 已落进做法：本轮后半程所有真机探针都**先等 10–12s 水合**再读，且**每个关键判断配一张截图**。

---

## 13. 本轮未修的缺陷（登记用，新增）

| # | 缺陷 | 位置 | 级别 |
| --- | --- | --- | --- |
| 14 | **`site-verify` 把站点侧限流归成 FAIL**：`resource_exhausted`（站点自己的码）不在分类正则 `CAPTCHA\|RATE_LIMIT\|NEED_LOGIN` 里 ⇒ 「站点太忙」被记成「桥坏了」，与仓库四态纪律冲突 | `test-mock/site-verify.mjs:232` | 中 |
| 15 | **doubao 的视频/图片式人机验证桥识别不到**：`detectChallenge` 的 body 正则没有「请选择所有…图片」这一形态，且 doubao 未声明 `captchaSelector` ⇒ 报「超时」而非 `WEB_CAPTCHA_REQUIRED` | `browser-driver.js:1168-1183`、`providers.js`（doubao 缺 `captchaSelector`） | 高 |
| 16 | **zai 第二轮切模型 `no-options`**：`model-picker.js:314` 返回 0 选项，两次运行一致可复现 | `lib/model-picker.js:314`、`browser-driver.js:4421` | 中 |
| 17 | **kimi / doubao 声明了 `loginProbe` 但真机 ok 特征命中 0** ⇒ `basis=probe-fallback`（不确定），与 #53/#59 同族 | `lib/providers.js` | 中 |
