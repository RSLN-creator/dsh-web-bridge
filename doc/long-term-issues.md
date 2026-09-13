# 长期问题与已知欠账

本文件收录 **dsh-webcode-bridge 结构性、已知、本次不修**的问题。

它不是 bug 列表：其中的每一条都已经过真机取证或被写进代码注释，且当前**有意**保持现状。
目的是让后续维护者（以及未来的会话）不必把同一件事重新发现一遍。

版本口径：本文件随 **0.14.0** 建立。

## 一览表

| # | 条目 | 严重度 | 阻塞 0.14.0 发布 | 关联文件 |
| --- | --- | --- | --- | --- |
| 1 | 上下文窗口声明口径 | 中 | 否 | `lib/index.js`、`lib/providers.js`、`lib/browser-driver.js` |
| 2 | 会话槽 LRU 上限与淘汰 | 中 | 否 | `lib/index.js` |
| 3 | 网页 UI 漂移 | 高 | 否 | `lib/providers.js`、`lib/contract.js`、`lib/decoder.js`、`lib/browser-driver.js` |
| 4 | 模型选择契约覆盖率 | 中 | 否 | `lib/providers.js`、`lib/browser-driver.js`、`lib/model-picker.js` |
| 5 | 单槽吞吐（FIFO 队列） | 中 | 否 | `lib/relay.js`、`lib/index.js` |
| 6 | 超时口径三者关系 | 中 | 否 | `lib/index.js`、`lib/browser-driver.js`、`lib/metrics.js` |
| 7 | profile 锁与孤儿 Edge | 中 | 否 | `lib/browser-driver.js` |
| 8 | 发送间隔的基准语义 | 低 | 否 | `lib/index.js`、`lib/metrics.js` |
| 9 | 三项既有假失败 | 低 | 否 | `doc/review-guide.md`、`test-mock/run-m2*.js` |
| 10 | 测试脚本的收集口径与环境限制 | 低 | 否 | `package.json` |
| 11 | 大 prompt 的性能提示（可选节） | 低 | 否 | `lib/browser-driver.js` |
| 12 | 图片预算（可选节） | 低 | 否 | `lib/index.js` |
| 13 | 网页端「部分流」自愈（可选节） | 低 | 否 | `lib/browser-driver.js` |
| 14 | Z.ai 无会话地址形状（新，0.14.2） | 中 | 否 | `lib/providers.js`、`lib/browser-driver.js` |

---

## 1. 上下文窗口声明口径：**已改为实测下界**（0.14.2 部分解决）

> **0.14.2 更新**：本条的一大部分已经落地，阅读时请以下面为准。
>
> - **「composer 真实上限未知」这个前提被推翻了**。真机探针
>   （`test-mock/real-probe-23-glm-budget.mjs` + `real-probe-24-glm-ceiling.mjs`，
>   2026-09-14，有头 Edge + 真实登录态）把输入框逐档灌满并回读：GLM 到
>   **1,200,000 字符**、Z.ai 到 **1,000,000 字符**，**全部逐字回读、没有一档被截断**。
>   即输入框容量比原先假设的大得多，**从来不是瓶颈**。
> - 声明值因此收口为 `providers.js` 的 `GLM_CONTEXT_WINDOW = 1_000_000`（glm 3 条 +
>   zai 4 条共用），并有**实测下界**支撑，不再是随手写的占位。
> - **仍然未知、也测不到的是「模型注意力窗口的规格」**——那要看站点服务端的截断
>   行为，探针测不出来，且会随网页改版变化。所以声明值的真实语义是
>   「本桥愿意让 transcript 长到多大」，**不是**模型规格。这一点已写进代码注释。
> - **越界现在有专门的闸**：`metrics.checkContextBudget` + `CONTEXT_WINDOW_EXCEEDED`
>   （在 `buildTurn` 之后、`attach` 之前拦下，网页端完全未被写入），
>   配合既有的 `PROMPT_TRUNCATED` 回读校验形成「发前拦、发后核」两道。
> - **声明值现在可见**：`GET /__webcode/context-windows` 列出每站点的声明值与来源。
>
> 下面保留原文，因为「为什么当初选择保守声明」的推理与
> 「未校准站点仍取 64_000 兜底」这两点**依然有效**。

### 现状

DSH 的 LLM provider 必须通过 `resolveModel` 声明一个 `contextWindow`，宿主据此决定何时压缩
transcript。但**网页 composer 的真实上限未知**——它是网页端的实现细节，没有对外契约。

代码位置：`lib/index.js` 的 `resolveModel`，`lib/index.js:434-441`。取值优先级是：

1. 模型自带 `m.context`（`lib/providers.js` 各站点的 `models[].context`，如 `deepseek` 为
   `1_000_000`，见 `lib/providers.js:42`）；
2. 配置项 `cfg.contextWindowBySite[siteId]`（默认只有 `{ deepseek: 1_000_000 }`，
   见 `lib/index.js:49-52`）；
3. 兜底：`deepseek` 取 `1_000_000`，**其余站点取 `64_000`**（`lib/index.js:439-441`）。

越界不靠截断兜底，而靠**回读校验**：驱动填入输入框后会 `readComposer` 回读一次，
长度短于原文超过 8 个字符即抛 `PROMPT_TRUNCATED`，且此时还没按发送键，网页端未被污染
（`lib/browser-driver.js:1081-1089`）。

### 影响

- 声明值偏小时，DSH 的上下文压缩会比网页真实能力**更早**触发——多花几轮压缩，但不会丢内容。
- 声明值偏大时，压缩可能永不触发，transcript 只增不减，最终撞上 `PROMPT_TRUNCATED`
  或网页端性能下降（见第 11 节）。
- 用户在 GUI 上看到的上下文占用百分比，是相对一个**估计值**的比例，不是网页真实用量。

### 为什么现在不修

真实上限只能靠真机二分探测得出，且**会随网页改版变化**——今天测出的数字明天就可能失效。
把它写成"精确值"反而制造一种不存在的确定性。当前选择是「保守声明 + 越界明确报错」：
失败是可见的、可解释的，而不是静默截断成半截提示词（后者表现为「越到后面越答非所问」，
正是 `lib/browser-driver.js:1081-1083` 注释里记录的历史症状）。

### 若要修，从哪下手

做一次可重复的真机探测（`test-mock/` 下新增探针：逐档递增字符数，直到 `PROMPT_TRUNCATED`），
把结果按站点写进 `cfg.contextWindowBySite`，并在设置页暴露「按真机校准」按钮。
但探测结果必须有失效日期与复检入口，否则只是把漂移问题推迟。

---

## 2. 会话槽 LRU：上限 512，超出丢弃最老条目

### 现状

`sessionState` 是 `apply()` 作用域内的一个 `Map`，键是会话路径，值是「已经发到第几条消息」
的游标（`lib/index.js:362`）。

- 淘汰阈值写死在提交路径里：`lib/index.js:1476`——`if (sessionState.size > 512) sessionState.delete(sessionState.keys().next().value);`
- 策略是 **LRU**，靠「先删后插」把键移到 `Map` 尾部实现（`lib/index.js:1470-1475`）。
  注释明确记录了旧写法的错误：对已存在的键 `set` 不改变插入序，淘汰会先丢掉**最老的热会话**。

### 影响

被淘汰的会话在下一轮会被判为「无游标」→ 走 `serializeFirstTurn` **整段重发**。
表现为：一个长期挂着的会话，忽然在某一轮把全部历史重新发一遍（网页侧也会因此变慢）。
用户看到的是「上下文像重置了」，但实际是游标丢失导致的重复发送，不是内容丢失。

### 为什么现在不修

512 个并发活跃会话远超单机实际用量（本插件的瓶颈是单槽吞吐，见第 5 节），
调大上限只是把内存压力往后推。真正的修复方向不是「更大的 Map」，而是
「把游标持久化到会话存储」——那是一次数据结构变更，不该在 0.14.0 的收尾里做。

### 若要修，从哪下手

把 `sessionState` 从内存 `Map` 改为经 `ctx.get('sessionPersistence')`（或 profile 目录下的
小 JSON）持久化的键值存储，并对 `commit()` 的写入做原子化处理（参考 `lib/index.js:1055-1063`
的 `rememberSend` 写法）。上限可保留，但淘汰应只发生在冷会话上。

---

## 3. 网页 UI 漂移：契约是手工维护的，改版即失效

### 现状

每个站点的网页契约（输入框/发送按钮/停止按钮/附件选择器/完成路径/解码器）集中声明在
`lib/providers.js` 的 `SITES` 数组里，严格模型校验与期望元数据在 `lib/contract.js`，
各站点流解码器在 `lib/decoder.js`。**这三处是站点知识的唯一定义处**，其余模块只面向
`{site, model}` 二元组（`lib/providers.js:1-8` 的注释即此约定）。

发现漂移的手段：

- **错误码**：`MODEL_UI_CHANGED`（未捕获到请求体，或实际元数据与期望不符，
  `lib/browser-driver.js:1120-1144`）、`MODEL_UNAVAILABLE`（模型切换失败，
  `lib/browser-driver.js:1295-1300`）、`PROMPT_TRUNCATED`（`lib/browser-driver.js:1086-1088`）、
  `WEB_SESSION_LOST`、`RATE_LIMITED` 等。
- **探针**：`test-mock/real-verify.mjs`（`pnpm doctor`）、`real-probe-17` ~ `real-probe-20`，
  以及站点级的 `probe-model-dropdown.mjs` / `verify-model-switch.mjs`。清单见
  `doc/review-guide.md:41-50`。
- **只读诊断端点**：`GET /__webcode/diagnostics` → `driver.diagnostics()`
  （`lib/web-control.js:201`，实现见 `lib/browser-driver.js:1496-1531`），返回当前 URL 路径、
  检测到的 UI 代际、`selectedModel`、`requestMetadata`、composer 附近的可点元素列表等。

### 影响

任意一家站点改版，都可能让该站点的选择器或解码器失效。故障形态从「完全不能用」
（输入框定位不到）到「静默降级」（能对话但模型没切过去）不等。

### 为什么现在不修

**不能自动适配**，因为网页 DOM 与 SSE 形状没有稳定契约，任何「自适应选择器」都只能靠启发式猜，
而猜错的代价正是历史上最严重的一类事故——0.12.9 的 `getByText(labels[0], {exact:true})`
启发式会选错模型（`lib/browser-driver.js:1263-1273`、`lib/providers.js:307-308` 记的
`GLM-5.3` 是 `GLM-5.3-Flash` 前缀这一具体陷阱）。当前立场是：**宁可不切，也不猜着切**。

### 若要修，从哪下手

把「发现漂移」做成例行而非事后：定期跑 `pnpm doctor` + `real-verify.mjs`，
把每次真机 dump 落进 `test-mock/out/` 并纳入版本控制（现在已经是这个模式，
见 `lib/providers.js` 各站点注释里引用的 dump 文件名），使选择器变更可 diff、可回溯。
进一步的自动化只能做到「改版后立刻报警」，做不到「自动修好」。

---

## 4. 模型选择契约覆盖率：部分站点有，其余如实报 unverified

### 现状

`lib/model-picker.js` 执行「精确名匹配 + 点击后回读确认」。是否可用由
`pickerUsable(picker)` 判定（`lib/model-picker.js:355-357`）——`segmented: true` 的契约
**故意不声明 trigger**（选项常驻页面，点触发等于先把模式切走）。

**当前有 `modelPicker` 契约的站点**（从 `lib/providers.js` 读出，非推测）：

| 站点 | 形态 | 位置 |
| --- | --- | --- |
| `glm`（智谱清言） | 弹层式，`.think-mode-trigger` → `.think-mode-item` | `lib/providers.js:73-88` |
| `kimi` | 弹层式，触发只显示思考强度，回读需开菜单（`readbackInMenu: true`） | `lib/providers.js:147-158` |
| `doubao`（豆包） | **分段式**，`segmented: true`，无 trigger、无 `aria-selected` | `lib/providers.js:218-224` |
| `zai`（Z.ai） | 弹层式，`button.modelSelectorButton` → `button[aria-label='model-item']` | `lib/providers.js:309-314` |

**当前没有 `modelPicker` 契约的站点**：`deepseek`（走独立的 `selectModelDeepSeek` 路径，
不使用通用契约，见 `lib/browser-driver.js:1259`）、`chatgpt`、`qwen`、`grok`、`claude`、`gemini`。

没有契约时的行为：先试一次原生 `<select>`（读回值相等才算成功），否则
`selectedModel = null`，返回 `{ strict: false, fallback: 'unverified' }` 并 `warn`
（`lib/browser-driver.js:1275-1292`）。**不假装切换成功**——这一点是 0.13.0 的
核心修正，旧实现在没有契约时猜着点、点不到就 `return { strict:false, fallback:'default-model' }`，
而调用方把它当成功继续走，于是模型选择在多数站点上是静默的空操作
（`lib/browser-driver.js:1266-1273`）。

另外两类「点了但无法确认」也如实标注：
`readback-mismatch`（点了也回读到名字，但不是目标名）与 `unverified-click`
（站点没声明回读选择器），见 `lib/browser-driver.js:1303-1312`。

### 影响

对无契约站点，用户在选择器里选「Qwen」「Grok」等具体条目时，**桥不做任何模型 UI 操作**，
实际对话用的是网页当前选中的模型。选择器里能选 ≠ 网页上真的切了。

### 为什么现在不修

契约必须逐站真机 dump 才能写（`test-mock/probe-model-dropdown.mjs`），而
`chatgpt` / `claude` 在本机网络层返回 403（WAF / 地区限制，见 `lib/providers.js:107-111`
与 `:255-259`），**根本进不去页面**，无从 dump。这是网络级障碍，不是代码问题。

### 若要修，从哪下手

对可达但未校准的站点（`qwen` / `grok` / `gemini`）逐个跑 `probe-model-dropdown.mjs`，
按 dump 结果往 `lib/providers.js` 补 `modelPicker`；每补一个，在
`test-mock/verify-model-switch.mjs` 里加一条真机断言。`chatgpt` / `claude` 需要先解决网络可达性。

---

## 5. 单槽吞吐：网页一次只能跑一轮，并行子代理只能排队

### 现状

`lib/relay.js` 是一个**单槽执行器 + FIFO 队列**：`busy` 标志保证同一时刻只有一个请求在跑
（`lib/relay.js:88-91`、`lib/relay.js:208-211`）。原因写在文件头注释里——
「the web page only ever automates one message at a time (low-frequency)」
（`lib/relay.js:10-12`）。

- **队列上限 32**：超出直接拒绝，错误文本是
  `queue full (32) — the web page is a low-throughput backend`（`lib/relay.js:216-219`）。
- **排队超时 `queueTimeoutMs`**：`lib/relay.js:26` 的默认值是 `300_000`（5 分钟），
  但插件通过 `DEFAULTS` 传入 **`900_000`（15 分钟）**（`lib/index.js:42-45`）。
  该默认值的注释明确写了为什么必须显著大于单轮上限：旧值 300s 只比单轮的 240s 多 60s，
  排在第二位的请求几乎必然「刚开始跑就超时」，长任务里的并行分支会成片失败。
- 排队中的请求可以被取消：`item.signal` 的 abort 会把它从队列里摘掉（`lib/relay.js:237-247`）。

### 影响

并行子代理（DSH 侧同时发起多个分支）在本插件上是**串行**的。第 N 个分支的端到端延迟
≈ N × 单轮耗时。队列满 32 或排队超过 15 分钟的分支会直接失败。

### 为什么现在不修

不能并发是**被操作对象**决定的，不是实现偷懒：一个 Edge profile 对应一个网页会话，
网页 composer 一次只接受一条消息，多发会互相污染输入框与流捕获。要做真并发，
需要多 profile / 多账号 / 多 Edge 实例，那是产品级决策（登录态、风控、资源占用），
不属于当前插件的范围。

### 若要修，从哪下手

若真要提升吞吐，方向是「按站点开多槽」（每个站点已有独立 profileDir 与独立 driver，
见 `lib/index.js:931-956`），把 `busy` 从全局改为**按站点**。但同一站点内的并发仍然无解。
队列上限与超时值可改为可配置项（当前 32 与 900s 都是常量）。

---

## 6. 超时口径：三个超时各管一段，不要混为一谈

### 现状

0.14.0 之后有三个独立的超时概念，作用域完全不同：

| 名称 | 默认值 | 配置项 | 作用域 | 位置 |
| --- | --- | --- | --- | --- |
| `requestTimeoutMs` | `240_000`（240s） | `cfg.requestTimeoutMs` | **单轮**总上限：从发出到本轮结束 | `lib/index.js:41`、`lib/relay.js:25`、`lib/browser-driver.js:177`、定时器在 `lib/browser-driver.js:1046-1067` |
| `WIP_IDLE_MS` | `2500`（2.5s） | `cfg.wipIdleMs` | **稳态窗口**：流停且 DOM 停止增长持续这么久 → 按已有正文收束 | 常量 `lib/browser-driver.js:217`、`lib/index.js:1072`；判定 `lib/metrics.js:106-111`；巡检 `lib/browser-driver.js:531-578` |
| `IDLE_TIMEOUT_MS` | `120_000`（120s） | `cfg.idleTimeoutMs` | **适配器侧看门狗**：自上次 delta/think/image 起无任何事件 | `lib/index.js:1073`、消费点 `lib/index.js:503-514` |

三者的关系：

- `WIP_IDLE_MS` 是**救援**机制，把「网页写完了但没送 FINISHED」的轮次在秒级救回来，
  避免用户看到无限「思考中」。它的判定是**双条件**（流停 **且** DOM 助手消息长度停止增长），
  任一条不满足就不收束——只看流停会把仍在生成的长回复判死（`lib/metrics.js:93-95`）。
- `IDLE_TIMEOUT_MS` 是**护栏**，管的是 WIP 收束救不了的那一类：捕获链从未建立、页面僵死、
  或整个 relay 卡在别处。它必须在 `WIP_IDLE_MS` **之后**才开火，否则会把本可救回的回复判死——
  代码里用 `Math.max(WIP_IDLE_MS + 1000, ...)` 强制保证这个顺序（`lib/index.js:1071-1073`）。
- `requestTimeoutMs` 是**兜底**，只在驱动自己还在跑时有效。

`endReason` 会在 relay metrics 里透出收束原因：`finished` / `partial-wip-settled` /
`timeout`（`lib/relay.js:181-183`）。

### 影响

三者都可在真机上表现为「等很久然后失败」，但修法完全不同：
调 `wipIdleMs` 治「回复写完了却卡住」，调 `idleTimeoutMs` 治「桥这边没有事件」，
调 `requestTimeoutMs` 才是真的在改单轮预算。混用会互相掩盖。

### 为什么现在不修

这不是缺陷，而是三层的分工。但三者**只存在于代码与配置项里**，设置页没有暴露——
用户遇到「卡住」时只能看到一个笼统的失败，无法自己调。

### 若要修，从哪下手

在设置页暴露三个值（带「必须满足 idleTimeoutMs > wipIdleMs + 1s」的校验提示），
并在右栏统计里显示本轮实际的 `endReason`。`endReason` 已经在 metrics 里了
（`lib/relay.js:181-183`），只差展示。

---

## 7. profile 锁与孤儿 Edge：只能按命令行匹配杀

### 现状

Windows 上 Chromium 的持久 profile 有单实例锁，锁文件是
`SingletonLock` / `SingletonCookie` / `SingletonSocket` / `lockfile`
（`SINGLETON_FILES`，`lib/browser-driver.js:596`）。浏览器被强杀或启动中途失败时这些文件会留下，
下一次 `launchPersistentContext` 直接抛 `ProcessSingleton` 类错误——
用户看到的是「退出过一次之后不管哪里都无法登录」（`lib/browser-driver.js:592-595`）。

处理分三层：

1. **清陈旧锁文件**：`clearStaleProfileLocks()` 只在本次进程确认没有活着的 `ctx` 时才清
   （有 `ctx` 说明锁是真被持有的），`lib/browser-driver.js:597-616`。
2. **清不掉时杀孤儿进程**：Windows 上 `fs.rmSync` 抛 `EPERM` 意味着锁被一个**活着的** Edge
   持有，于是调用 `killOrphanEdgeForProfile()`（`lib/browser-driver.js:611`）。
3. **WMI Terminate**：用 `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"`
   过滤出命令行包含本 `profileDir` 的进程，逐个 `Invoke-CimMethod ... Terminate`，
   `lib/browser-driver.js:621-636`。必须走 WMI，因为 `Stop-Process` / `taskkill` 对 Chromium
   子进程的受限 DACL 会拒绝访问（真机 2026-09-12 实测）。

另有一条更温和的路：`releaseOrphanByCDP()`（`lib/browser-driver.js:638-649`）经
profile 里的 `DevToolsActivePort` 连上调试端口后 `browser.close()`，让孤儿进程优雅退出。

### 影响

**局限很明确：只能杀掉命令行里含本 `profileDir` 的进程。** 如果 Edge 的启动方式让
`CommandLine` 里不含该路径（例如由别的启动器拉起、路径被改写、或用户手动开的 Edge
恰好用了同一个 profile），孤儿进程就杀不掉，锁也清不掉，该站点会一直无法启动。
此时唯一的恢复手段是用户手工关闭那个 Edge。

另外，杀进程是**有副作用**的：若那个 Edge 窗口里还有用户自己的标签页，它们会一起被终结。

### 为什么现在不修

没有更精确的判据可用：Windows 上无法从进程反查「它是否持有这个 profile 的锁」。
命令行匹配是在「不误杀用户自己的 Edge」与「能救回卡住的场景」之间的折中——
宁可漏杀（用户手工处理），也不误杀。

### 若要修，从哪下手

优先走 `releaseOrphanByCDP()`（优雅、无副作用），把 WMI 强杀降级为最后手段；
并在失败时把「请手动关闭任务管理器里的 msedge.exe」写进面向用户的报错文本
（目前只有 `warn('orphan edge kill failed:', ...)`）。

---

## 8. 发送间隔的基准：已改为 send-to-send，但「是否可切换」仍是待定项

### 现状

设置页的「发送间隔」= 两次向同一站点**发送**之间的最小毫秒数，也是 `RATE_LIMITED`
退避的基数（`lib/index.js:65-72`）。

0.14.0 做了两处语义修正：

- **基准从「上一轮结束」改为「上一轮发出」**（send-to-send）。旧实现在长回复下会把等待
  吃掉——真机实测一轮跑 20918ms 时，10000ms 的间隔只剩 7609ms 可见
  （`lib/index.js:68-71`，现场记录见 `PLAN-0.14.0-HANDOFF.md:28-29`）。
- **基准落盘**：`<profileDir>/webcode-send-state.json`，原子写 + `0o600`，启动读回时丢弃
  24h 以上的陈旧条目并拒绝未来时间戳（时钟回拨）（`lib/index.js:1031-1063`，
  判定函数 `lib/metrics.js:68-80`）。旧实现只在进程内存里，DSH 每次重启就清空，
  于是**重启后第一轮零等待**。

判定与透出：`computeSendGap()` 返回 `{ waitMs, sincePrevSendMs, skewed }`，
metrics 里对应 `sendWaitMs` / `gapTargetMs` / `sincePrevSendMs`
（`lib/relay.js:173-183`、`lib/index.js:1121-1136`）。

### 待定项：基准是否应该做成可切换项

`PLAN-0.14.0-HANDOFF.md:181` 把 `sendGapBasis` 的**切换项**列为待办，
而 0.14.0 只实现了单一语义（send-to-send）。两种语义各有适用场景：

- **send-to-send**（当前实现）：防止**发送频率**过高触发站点滑窗限流。
  间隔从发出那一刻起算，长回复期间时钟一直在走，因此下一轮可能**不需要等待**——
  这正是「设了 10s 却看不到等待」的另一半来源，而这是正确的行为。
- **end-to-start**（旧语义）：保证两轮之间有固定的**冷却期**，给站点侧的处理留出喘息。
  对「回复越长、服务端越累」的站点更安全，代价是整体吞吐更低。

两者不是对错之分，是防护目标不同。

### 影响

当前固定为 send-to-send。如果某个站点实际是被「轮次间冷却」而非「发送频率」限流的，
当前实现会在长回复后立刻再发，可能撞上限流（表现为 `RATE_LIMITED` 退避重试）。

### 为什么现在不修

两种语义都需要真机数据才能判断哪家站点适用哪种，而 0.14.0 已经有更紧急的
「卡住」问题要收尾（见 `PLAN-0.14.0-HANDOFF.md` 的 P1-3）。先在单一语义上把
**可见性**做对（设置值与实际间隔都透出，没等待时也有数字可核对），
比再加一个开关更重要。

### 若要修，从哪下手

在 `computeSendGap` 之上加一个 `basis` 参数（`'send-to-send' | 'end-to-start'`），
设置页加对应选项，`webcode-send-state.json` 需要同时记「上次发出」与「上次结束」两个时刻。
`lib/metrics.js` 的 `computeSendGap` 是纯函数，两种语义都可以离线断言。

---

## 9. 三项既有假失败：干净树上同样失败，不是回归

### 现状

来自 `doc/review-guide.md:52-59`，原文收录：

- `test-mock/run-m2.js`：走的是已废弃的浏览器扩展链路（`extension/`），
  当前架构不再使用，**M2 恒 FAIL**。
- `run-m2b-driver.js` / `run-m2c-webapi.js`：mock 站点的响应形状已与驱动期望脱节，
  `completion via driver` 一项**恒 FAIL**。其余断言仍有效。

这三项在改动前的干净树上同样失败。

### 影响

跑真机/mock 套件时会有固定的红色项。任何「全绿」的说法都必须把这四项排除在外，
否则会被误判为回归。

### 为什么保留它们（而不是删掉）

- `run-m2.js` 对应的 `extension/` 链路**代码仍在仓库里**（虽然不在运行链路，
  `doc/review-guide.md:27-28` 明确说审查时可跳过）。删脚本而不删链路，等于把
  「这条链路已废弃」这一事实的唯一记录也删掉。
- `run-m2b` / `run-m2c` 的其余断言**仍然有效**——它们覆盖的是驱动与 webapi 的其它行为，
  只因 mock 响应形状脱节而挂掉一项。删掉整个文件会连带丢掉那些覆盖。
- 把假失败记录在案，比让每个新维护者重新发现一次要便宜得多。这正是本文件存在的理由。

### 若要修，从哪下手

- `run-m2.js`：要么随 `extension/` 一起删除（需先确认无人依赖），要么改成显式 skip 并打印原因。
- `run-m2b` / `run-m2c`：更新 mock 站点的响应形状，使 `completion via driver` 这一项能真跑通；
  或者把该项从断言改为「已知不适用」的标注。

---

## 10. 测试脚本的收集口径与环境限制

### 现状

`package/dsh-webcode-bridge/package.json:12` 的 test 脚本：

```
node --test "test/*.test.mjs" && node test/parse.test.mjs && node test/run-m1.js
```

即用 **glob 收 `test/*.test.mjs`**，后面再用 `&&` 串上两个显式脚本
（`test/parse.test.mjs` 与 `test/run-m1.js`）。前者本来就落在 glob 模式内，
属于重复列出（无害）；后者是 `.js` 后缀的 M1 契约脚本，glob 收不到，必须显式写。

`doc/review-guide.md:38-39` 的告诫：「glob 收全 `test/*.test.mjs`，别再把新测试文件漏在脚本外」。

**环境限制（本机沙箱）**：`node --test "test/*.test.mjs"` 可能以 `spawn EPERM` 失败
（`PLAN-0.14.0-HANDOFF.md:35-36`）。规避方式是**逐文件**跑：

```
node test/<file>.mjs
```

### 影响

- 新增测试文件时，若文件名不匹配 `test/*.test.mjs`（例如放在子目录、或后缀不同），
  它不会进入 `npm test` 的收集范围，**永远不跑**——这是静默的覆盖率漏洞。
- 在本机沙箱下，`npm test` 会因为 `spawn EPERM` 直接失败，看起来像测试挂了，
  实际是环境限制。误判方向是「以为是回归」。

### 为什么现在不修

`spawn EPERM` 是**本机沙箱**的限制，不是仓库的问题——在正常环境下 `node --test` 的
进程派生是允许的。改脚本去迎合一个特定沙箱，会让正常环境失去并行执行的好处。
逐文件跑的代价只是慢，不是不准。

### 若要修，从哪下手

- 在 CI 或文档里固化「逐文件跑」的清单（`PLAN-0.14.0-HANDOFF.md:150-164` 已有一份）。
- 加一条护栏测试：断言 `test/` 下所有 `*.test.mjs` 都能被 `package.json` 的 test 脚本匹配到。
  这能结构性地消灭「新测试漏在脚本外」。

---

## 11. 大 prompt 的性能提示（可选节）

### 现状

驱动在填写输入框之前检查长度，超过 **400,000 字符**时 `warn` 一行
`large prompt:${len} chars — the web composer may become slow; consider trimming context`
（`lib/browser-driver.js:1071-1073`）。

这是一个**纯警告**，不改变行为：消息照发。真正的硬拦截在回读校验那里
（`PROMPT_TRUNCATED`，`lib/browser-driver.js:1084-1089`）。

### 影响

超大 prompt 会让网页 composer 变卡（前端编辑器处理大文本），端到端延迟上升，
但不会失败。用户侧只在宿主控制台能看到这条 warn。

### 为什么现在不修

阈值 400k 是经验值，没有真机校准数据支撑一个更精确的数字；而在警告之外做任何事
（例如拒绝发送）都会在「长上下文任务」这个本插件的核心用例上误伤用户。

### 若要修，从哪下手

把这条 warn 提升为 metrics 里可见的字段（例如 `promptChars` + 一个超限标记），
让右栏能提示「本轮提示词偏长，网页端可能变慢」。真机采集几轮大 prompt 的
`durationMs` / `sendWaitMs` 后，再决定是否需要更早触发压缩。

---

## 12. 图片预算（可选节）

### 现状

`lib/index.js` 定义了两个与图片相关的上限：

- `REQUEST_IMAGE_POLICY = Object.freeze({ maxPixels: 640_000, maxBytes: 1_048_576 })`
  （`lib/index.js:140-142`）。这是传给 `attachments.readImageRequest(ref, policy, signal)`
  的投影预算，注释说明是与 `dsh-llm-deepseek` 的默认档对齐，让桥取到的版本和原生
  DeepSeek 路由同档。
- `RAW_IMAGE_MAX_BYTES = 8 * 1024 * 1024`（`lib/index.js:143-144`）。这是
  attachments 服务不支持 request 投影时的**兜底**上限——直接读原始字节，超限即跳过。

durable 图片块的读取按优先级降级，每一档失败都**记名不静默**
（`lib/index.js:162-171` 的注释与 `resolveImages` 实现）：

1. `readImageRequest(ref, policy)` —— 宿主归一化 + 按预算投影后的请求版本；
2. `readImage(ref)` —— 原始归一化字节，超过 `RAW_IMAGE_MAX_BYTES` 即拒；
3. 都失败 → 记进 `skipped` 并 `warn`，返回给调用方明确报错，
   而不是让模型说「没看到图」（`lib/index.js:207-209`、`lib/index.js:1415`）。

另有远程图片抓取上限：`resolveRemoteImages` 里 `RAW_IMAGE_MAX_BYTES` 也用于拦远程图
（`lib/index.js:146-160`），单张抓取有 10s 超时。

### 影响

- 超过 `maxPixels` / `maxBytes` 的图会被宿主投影（缩放/重编码），不是原图。
- attachments 服务不可用时降级到原始字节，8MB 以上的图会被跳过并报错。
- 网页端的图片**张数**上限由驱动侧另行拦截：`setImageLimitsProvider` 把宿主的
  `attachments.imageLimits` 交给每个驱动，「上传前据此拦下必然被拒绝的输入（张数/字节），
  而不是发出去再猜为什么『模型说没图』」（`lib/index.js:934-937`）。

### 为什么现在不修

这是一组**对齐**而非**欠账**：预算值刻意与原生 DeepSeek 路由保持一致，
避免同一个 harness 截图在两条路径上得到不同清晰度。改动它需要同步上游口径，
不属于本插件能单方面决定的参数。

### 若要修，从哪下手

若 `dsh-llm-deepseek` 的默认档变化，此处必须同步（`lib/index.js:140-141` 的注释即此约定）。
建议加一条测试断言两处数值一致，或在注释里记录上游文件路径与版本。

---

## 13. 网页端「部分流」自愈（可选节）

### 现状

网页流可能不送 `FINISHED`/`close` 就结束（`status: 'WIP'`）。驱动的处理是：
**把已拿到的正文/思考/图片当作本轮结果交出去**，而不是抛错
（`lib/browser-driver.js:1160-1170`）。

- 每次自愈计数 `recoveredTurns += 1`，并记下 `lastRecovered = { at, reason, status, chars }`。
- 注释明确记录旧行为：直接抛错会「把模型已输出的正文与完整工具调用整段丢弃，
  界面上就是『跑到一半突然停止』，且工具循环再也不会继续」。
- 0.14.0 的 WIP 稳态收束（`startWipWatch`）刻意与这条既有 partial 路径**同形**，
  因此上层的工具协议解析、部分流自愈、空回复判定全部照旧，不新增第二条收尾通路
  （`lib/browser-driver.js:528-529`）。
- `recoveredTurns` / `lastRecovered` 会透出到 `/__webcode/status` 与右栏。

### 影响

自愈是**有代价**的：被交出去的内容可能不完整（模型还没写完）。上层会解析工具协议、
执行、回填，下一轮让模型续写。因此用户可能在长回复中看到「分段」的形态。
但它保住的是「已经产出的内容」与「工具循环不中断」，代价明显小于整段丢弃。

### 为什么现在不修

这是**故意的设计**，不是缺陷。它把「网页不稳定」这个外部事实转化为可控的降级，
而不是让桥把它变成硬失败。真正的修法在网页端（让它稳定送 FINISHED），不在桥这边。

### 若要修，从哪下手

不需要修。需要的是**可观测**：右栏在 `recoveredTurns > 0` 时显示一行说明
（`PLAN-0.14.0-HANDOFF.md:128-129` 已列为待做项），让用户知道「这一轮的结束是桥救回来的」，
而不是以为模型自己停了。

---

## 14. Z.ai 没有会话地址形状：只能整段重建（0.14.2 新发现）

### 现状

0.14.2 把「会话 id ↔ 地址」的知识从驱动里抽成**按站点声明**
（`lib/providers.js` 的 `CONVERSATION_URL_SHAPES` / `CONVERSATION_URL_BUILDERS`），
导航判定收成三态（`lib/contract.js` 的 `conversationNav`）：`fresh` / `resume` /
`unsupported`。

- **glm**：形状已取证并声明 —— `?cid=<24 位十六进制>`，且与 SSE 首帧的
  `conversation_id` 逐字相同（真机 2026-09-14 实录
  `https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77`）。
- **deepseek**：两种历史形状（`?chat_session_id=` 与 `/a/chat/s/`）原样保留。
- **zai**：**故意不声明**。两个探针都没拿到证据：
  - `real-probe-25-zai-url.mjs`：`page.url()` 是裸根 `https://chat.z.ai/`，
    query 键为空，页面里只有两条法务链接，**没有任何会话链接**；
  - `real-probe-23-glm-budget.mjs`（`PROBE_SITE=zai`）：整轮 120s 超时，
    超时现场 `{captureAlive: true, replyChars: 0}`。

### 影响

zai 的每一轮都会走 `unsupported` 分支 → 抛 `WEB_SESSION_LOST` → 上层以
`fresh: true` 重放首轮整段。也就是说 **zai 的会话上下文只能靠「整段重放」维持，
每次都是新开的网页对话**：功能上不丢内容（首轮全文 = 完整上下文 + 工具协议），
但网页侧的对话列表会越堆越多，且每轮都要重发全文（长会话下更慢）。

对比旧实现：那时 zai 也一样拿不到 id，但是**静默**的——用户只看到「每轮新开对话」，
面板上没有任何线索。现在 `sessionLostCount` / `lastSessionLost` 会透出到
`/__webcode/status` 与右栏（`lib/client.cjs`），原因逐字可读。

### 为什么现在不修

**没有证据可以拿来声明形状。** 按本项目一贯立场（0.12.9 的教训：`getByText`
启发式选错模型；`lib/providers.js:307-308` 记的 `GLM-5.3` 是 `GLM-5.3-Flash`
前缀陷阱）——**宁可不切，也不猜着切**。给 zai 编一个形状（哪怕是「照抄 GLM 的
`?cid=`」）会让驱动导航到一个不存在的地址：页面可能停在首页或报错，而驱动会以为
自己在续聊，于是**静默丢掉上下文**——比现在的「明确整段重建」更糟。

另外 zai 那条 120s 超时本身是**独立问题**（`replyChars: 0`，捕获链在但页面没吐
正文），它属于第 3 条「网页 UI 漂移」，不属于本条。

### 若要修，从哪下手

1. **先解决 zai 的轮次超时**（第 3 条的路子）：跑一次带 `WEBCODE_SSE_DEBUG` 的
   zai 轮次，看 `/api/chat/completions` 是否真的被捕获、解码器 `openai-sse`
   是否对得上形状。轮次能正常收尾之后，`conversation_id` 才可能出现在流里。
2. **再取地址形状**：zai 轮次成功后再跑 `real-probe-25-zai-url.mjs`，这回要看
   **历史会话**页面（先手动开一个有历史的对话），确认地址形态后再往
   `CONVERSATION_URL_SHAPES` / `CONVERSATION_URL_BUILDERS` 各加一条。
3. 若最终确认 zai **只**把 id 放在流里、地址栏确实不带，则给
   `CONVERSATION_URL_BUILDERS` 之外补一条「只能靠流 id 续聊」的路径——但那需要
   站点支持「用 API 打开某个会话」，属于新机制，不能靠现有两张表表达。

---

本文件是维护台账，不是发布阻塞清单。