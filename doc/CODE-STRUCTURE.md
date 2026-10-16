# 代码结构归类：lib 的 55 个模块分几层

本文件把 `package/dsh-webcode-bridge/lib/` 的 **55 个模块 / 39,710 行**按**职责**归类，
并给出实测依赖方向。目的：让「改一处要动几个文件」这个问题有确定答案。

**口径（重要）**：行数是 `readFileSync(...).split(/\r?\n/).length` 的读数，与
`wiki/tools/gen-index.mjs` **同一口径**（比 `Measure-Object -Line` 多 1 行/文件，因为后者
不计末尾空行）。模块数与测试文件数由机器判：`node scripts/check-ledger.mjs` 与
`node wiki/tools/gen-index.mjs --check`。

实测时间 2026-10-17，基线 `0.19.76`，宿主 `dsh@0.2.1-alpha.2`。

> **本文件两次过期，两次都是「人写的数字」先烂**（2026-09-17 读数 30 个模块 / 15,175 行；
> 2026-09-30 重算为 48 / 34,570；2026-10-14 重算为 **53 / 38,662**；2026-10-17 重算为
> **55 / 39,710**）。
> 因此：**凡本节数字与 `gen-index.mjs` / `check-ledger.mjs` 冲突，一律以后两者为准**
> ——它们是机器现扫的，本节是人写的。改写本节时**先跑那两条命令，再抄读数**，
> 不要凭记忆改。

---

## 一、规模读数（实测）

| 项 | 值 | 取法 |
| --- | --- | --- |
| `lib/` 模块数 / 总行数 | **55 / 39,710** | `node wiki/tools/gen-index.mjs --check` |
| 最大模块 | `client.cjs` **7,826 行** | 浏览器侧单文件 bundle（非 ESM） |
| 次大 | `browser-driver.js` **5,397**、`index.js` **4,862**、`agent-preset.js` **3,072** | 同上 |
| 再次 | `web-control.js` 2,134、`think-effort.js` 1,199、`providers.js` 1,188、`decoder.js` 1,163 | 同上 |
| 测试文件 | **133 个** `*.test.mjs` | `node scripts/check-ledger.mjs` |
| 真机夹具 | `test/fixtures/` 下的 `dsml-real-*.txt` 与具名形态 | `test/fixtures/` |
| 入口 | `main: ./lib/index.js`；`exports` 另含 `./client`、`./cordis.patch.yml` | `package.json` |

> `client.cjs` 是**官方要求的单文件 CJS bundle**（它不能 `import` 自己的 `lib/`），
> 因此它的行数**不构成**「该拆」的信号——拆分它会破坏官方客户端契约。
> 这一点已写进 [`permissions-and-boundaries.md`](permissions-and-boundaries.md) §1.3。

---

## 二、分层（按职责，不是按目录）

`lib/` 是**扁平目录**——53 个文件同层（52 个 ESM `.js` + 1 个 CJS `client.cjs`）。下面这张表是**逻辑分层**，
是新成员理解这份代码的最短路径。分层口径与 [`wiki/architecture.md`](../wiki/architecture.md) §3 的 A–J 一致。

### A · 声明/真源（「这个站点长什么样」）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `providers.js` | 1188 | **多站点注册表真源**：`SITES` / 模型目录 / provider id 与分组名推导 |
| `contract.js` | 148 | 各站点网页契约投影（选择器 / SSE 端点 / 解码器 / 元数据键） |
| `decoder.js` | 1163 | 各站点 SSE/JSON 流解码器，以 `globalThis.WebCodeStreamDecoders` 注册 |
| `model-picker.js` | 505 | 各站点「真的切换网页模型」的**唯一**实现（精确匹配 + 回读确认） |
| `think-effort.js` | 1199 | 「思考等级」的**唯一真源**：档位清单 + 下发计划 + 回读判定（含页面侧函数） |
| `image-pricing.js` | 131 | 图片计价契约 |

### B · 身份（「这是哪个账号」）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `accounts.js` | 229 | 「站点 × 账户槽」纯身份层：accountKey / 模型 id / profile 路径的唯一推导 |
| `account-cache.js` | 117 | 账号昵称/头像落盘缓存 |
| `bridge-lock.js` | 578 | 「同一账号不得同时桥接」的**跨进程**单实例锁 |

### C · 执行（浏览器与排队）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `browser-driver.js` | **5397** | Playwright 驱动：登录判定、选模型、发车、抓流、会话槽、附件投递、看门狗接线 |
| `browser-runtime.js` | 222 | 「用哪个浏览器」与「没装时怎么装」 |
| `relay.js` | 433 | 单账号车道 + FIFO 队列 + 超时/中止 + consent |
| `attach-scope.js` | 131 | 附件证据的**唯一**判定实现（纯函数，注入 `page.evaluate`） |

### D · 解读与判据（纯函数，可离线反向验证）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `metrics.js` | 439 | 速率推导、token 估算、`model_type` 期望值、收束判据（按 UI 代际） |
| `idle-window.js` | 112 | 「无进展」看门狗该用哪把尺子（prefill 与已开流必须分相位） |
| `zero-progress.js` | 112 | 「本轮零进展」收尾判定（只有思考、正文零字符） |
| `repeat-detect.js` | 144 | 思维链「退化重复」的通用检测（**无词表**，只按形态） |
| `wait-stats.js` | 508 | 等待时长纯计算层（速览 = 本会话；设置页 = 历史累计，同一口径） |
| `continue-budget.js` | 134 | 自动续跑的整会话累计与「完整提醒」升级点（**不是刹车**） |
| `session-anchor.js` | 99 | 会话游标的内容锚定（锚尾部，不锚整体前缀指纹） |

### E · 协议（只有一处定义）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `agent-preset.js` | **3072** | **协议真源**：首轮 preset + 逐轮增量 + `mcp_action` 围栏的解析与再教学 |
| `tool-transport.js` | 78 | 「站点 → 工具调用传输形状」的**只读路由立面**（只路由，不实现协议） |
| `prompt-variants.js` | 225 | 首轮提示词变体的**只读清单**（每条调真函数现算） |
| `bench.js` | 284 | 提示词基准实验的纯判据层（不做模型自评、不算显著性） |

### F · 控制面与对外接口

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `web-control.js` | 2134 | 控制面路由 `/__webcode/*`（同源挂载 + 中继回落，带回环与 CSRF 判据） |
| `openai.js` | 316 | OpenAI 兼容 HTTP 前端（`/v1/*`） |
| `mirror.js` | 968 | 右栏同源镜像中继（固定上游的 same-origin relay，不是开放代理） |
| `upstream.js` | 220 | 面向镜像的 HTTP 客户端（绕开 Node fetch 16KB 响应头上限） |
| `cookies.js` | 205 | Set-Cookie 两个消费方向，各自按 RFC 6265 解析 |
| `loopback.js` | 104 | 「这个 Host 是不是本机回环」的唯一判定 |
| `update.js` | 368 | 本插件「检查更新 / 安装 / 重启提醒」逻辑层（只提醒，绝不代重启） |

### G · 界面

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `client.cjs` | 7826 | DSH Web 客户端面（浏览器侧单文件 bundle，**非 ESM**，不能 import lib/） |
| `settings-page.js` | 1023 | 独立设置页 `/__webcode/settings-page` 的静态 HTML |
| `comparison-view.js` | 522 | 多列对比视图 `/__webcode/comparison` 的静态 HTML |

### H · 记录/卫生

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `reply-log.js` | 134 | 网页**原始回复全文**的落盘日志（未归一化、未截断） |
| `prompt-store.js` | 181 | 提示词/上下文的每站点、每会话落盘 |
| `notices.js` | 70 | 交回会话的**展示文案**（协议安全 + 不许静默降级） |

### I · 任务/团队

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `task-ledger.js` | 669 | 桥**自己**的任务台账：任务是一等公民，不寄生在任何会话上 |
| `task-graph.js` | 237 | 任务图的**结构诊断**：就绪集、阻塞原因、关键路径、环与悬空边 |
| `task-plan.js` | 427 | 任务图的**执行语义**：准入判定（能不能开工、为什么不能） |
| `task-split.js` | 238 | 把一个目标拆成依赖图（AI 拆分 + 分配 + 结构校验） |
| `team-state.js` | 240 | Team/任务状态的磁盘投影（AgentTeams 包不在时的权威） |
| `roster.js` | 595 | 真实花名册投影：把「谁在跑」变成可从服务端读取的事实 |

### J · 并列多会话

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `column-context.js` | 181 | 并列多会话的列身份与工作区约定（**只做约定，不做拦截**） |
| `column-fs.js` | 194 | 并列三列的产物围栏（照抄官方 canonicalize-then-contain 口径） |

### 不在生产链路上

| 模块 | 行数 | 状态 |
| --- | --- | --- |
| `tool-parser.js` | 53 | ⚠ **未接线**，只被单测引用。留着是一份**待决的产品决定**，不是死代码——删之前先读它的文件头 |

---

## 三、依赖方向（2026-10-17 实测的内部 import 边，`test-mock/structure-audit.mjs`）

> 下面是**扇出 Top**（依赖谁最多）与**扇入 Top**（被谁依赖最多）的实测读数，与
> 2026-09-30 手写的完整边表**方向一致、数字已刷新**。完整边表保留在下一段
> （历史快照），以「装配中心 index / 协议心脏 agent-preset / 任务出口 roster /
> 并列子系统 column-*」四条结构性事实为准。

| 排名 | 扇出（依赖最多） | 扇入（被依赖最多） |
| --- | --- | --- |
| 1 | `index.js` → **29** 个 lib 模块 | `agent-preset.js` / `error-codes.js` / `metrics.js` / `providers.js`（各 **5**） |
| 2 | `browser-driver.js` → **16** | `accounts.js` / `loopback.js`（各 **4**） |
| 3 | `web-control.js` → **12** | `flatten.js` / `prompt-store.js` / `think-effort.js` / `upstream.js`（各 **3**） |

**四条结构性事实**：

1. **`index.js` 是唯一装配中心**，29 个出边；它自己不被任何模块 import。
   改任何一个「谁被谁用」的关系，第一个要看的就是它。
2. **`agent-preset.js` 是协议层的心脏**：`bench.js` / `prompt-variants.js` / `tool-transport.js`
   都依赖它。这条边说明「协议只有一处定义」不是口号，是依赖图上的事实
   （[`review-guide.md`](review-guide.md) 第三条不可越界约束）。
3. **`roster.js` 是任务子系统的唯一出口**：`task-graph` / `task-plan` / `team-state` / `task-ledger`
   只被它引用，`index.js` 通过它间接拿到任务图。
4. **`column-fs.js` 依赖 `column-context.js`** 是并列多会话子系统里唯一的内部边；
   两者都**不**被驱动层引用（围栏只服务「本插件自己落盘」这一条路径，见
   [`long-term-issues.md`](long-term-issues.md) #35）。

**未发现环**：2026-10-17 静态 import 扫描（`test-mock/structure-audit.mjs`）
输出「（无）」——所有边都指向更底层或同层模块，没有 A→B→A。

### 2026-09-30 手写边表（历史快照，方向仍真，数字见上）

```
index.js            -> 27 个 lib 模块（providers, accounts, account-cache, relay, think-effort,
                       openai, browser-driver, zero-progress, repeat-detect, idle-window,
                       web-control, agent-preset, tool-transport, notices, image-pricing,
                       continue-budget, reply-log, session-anchor, prompt-store, mirror,
                       upstream, flatten, roster, metrics, wait-stats, settings-page,
                       comparison-view）—— 唯一的装配中心

browser-driver.js   -> browser-runtime, cookies, contract, accounts, model-picker, metrics,
                       zero-progress, account-cache, think-effort, bridge-lock, attach-scope
web-control.js      -> providers, accounts, prompt-variants, prompt-store, wait-stats,
                       loopback, browser-runtime, upstream, update, column-context,
                       column-fs, task-ledger
roster.js           -> task-graph, task-plan, team-state, task-ledger
mirror.js           -> upstream, loopback, cookies
openai.js           -> flatten, providers, metrics, loopback
contract.js         -> providers, metrics
providers.js        -> accounts, think-effort
agent-preset.js     -> flatten
prompt-variants.js  -> agent-preset, providers
tool-transport.js   -> prompt-variants, agent-preset
relay.js            -> metrics
bench.js            -> agent-preset
column-fs.js        -> column-context
continue-budget.js  -> prompt-store
upstream.js         -> loopback
tool-parser.js      -> agent-preset, tool-transport   （未接线，仅单测）
```

**四条结构性事实**：

1. **`index.js` 是唯一装配中心**，27 个出边；它自己不被任何模块 import。
   改任何一个「谁被谁用」的关系，第一个要看的就是它。
2. **`agent-preset.js` 是协议层的心脏**：`bench.js` / `prompt-variants.js` / `tool-transport.js`
   都依赖它。这条边说明「协议只有一处定义」不是口号，是依赖图上的事实
   （[`review-guide.md`](review-guide.md) 第三条不可越界约束）。
3. **`roster.js` 是任务子系统的唯一出口**：`task-graph` / `task-plan` / `team-state` / `task-ledger`
   只被它引用，`index.js` 通过它间接拿到任务图。
4. **`column-fs.js` 依赖 `column-context.js`** 是并列多会话子系统里唯一的内部边；
   两者都**不**被驱动层引用（围栏只服务「本插件自己落盘」这一条路径，见
   [`long-term-issues.md`](long-term-issues.md) #35）。

**未发现环**：上表所有边都指向更底层或同层模块，没有出现 A→B→A。

---

## 四、God file 清单（维护成本的真实来源）

| 模块 | 行数 | 为什么它是 God file | 有没有拆的可能 |
| --- | --- | --- | --- |
| `browser-driver.js` | 5397 | 站点差异化、DOM 契约、登录判定、发送、捕获、SSE、会话槽、附件投递**全在一个文件** | **可拆**：站点差异可外移（见 [`ROADMAP.md`](ROADMAP.md) 第二节的 P2） |
| `index.js` | 4862 | provider 适配器 + 流式块协议 + 会话游标 + 设置 + 路由挂载；`apply()` 单函数跨度极大 | 已抽出 `settings-page.js`，可继续抽 |
| `agent-preset.js` | 3072 | 协议编解码**内聚**，但已含 5 代兼容分支 | **不拆**：内聚性高，优先加注释 |
| `client.cjs` | 7826 | 浏览器侧全部 UI（四块面板） | **不可拆**：官方要求单文件 CJS bundle（见 §一 的注） |
| `web-control.js` | 2134 | 控制面路由 + 网页历史导入 | 历史导入可独立 |

**判据**：拆分的标准不是行数，而是「**改一处要不要动多个文件**」。
`browser-driver.js` 满足拆分条件（站点差异散落其中）；
`agent-preset.js` 不满足（它的 5 代分支服务同一个协议，拆开会制造两套协议漂移）。

---

## 五、什么不是运行链路（审查时可跳过）

- `reference/`（逆向参考仓库，纯 git clone，`.gitignore` 已排除）
- `doc/`（全部文档）
- `test-mock/archive/`（已归档的一次性探针 + 旧 `extension/`）
- `.tmp/`（本机暂存，含大量可再生产物）
- `.local-plans/` 下的 `PLAN*.md`、`REPORT.md`（本地私有留痕，不入库）

出处：[`review-guide.md`](review-guide.md)。

---

## 六、测试分布（按被保护的对象归类）

> **计数口径**：`check-ledger.mjs` 数的是 `test/*.test.mjs` 的**文件数**（当前 **116**），
> 不是断言数。文件数变了必须同步台账，否则闸门红。
> 下表的**分组**是稳定的，**每组的文件数会涨**——需要精确数字时以闸门读数为准。

| 保护对象 | 代表测试 |
| --- | --- |
| **协议解析 / 泄漏** | `regression`、`protocol-leak`、`parse`、`nameless-call`、`dsml-native-close`、`dsml-real-reply-regression`、`fence-nested-call`、`fence-prose` |
| **站点契约 / 解码** | `multi-site-decoder`、`glm-conversation`、`glm-session-replay`、`site-mount`、`mirror`、`model-picker`、`model-labels` |
| **思考等级** | `think-effort`、`captcha-gate` |
| **账户槽** | `accounts`、`accounts-integration` |
| **驱动时序 / 收束** | `idle-window`、`watchdog-first-byte`、`timeout-order`、`stall-settle`、`zero-progress`、`wip-settle`、`stream-tail`、`send-gap`、`repeat-detect` |
| **附件投递** | `prompt-transport`、`prompt-transport-attach`、`upload-attachment-structure`、`attach-callsite`、`context-budget` |
| **UI 渲染契约** | `client-render`、`client-server-contract`、`present-preset`、`hooks-order`、`live-view` |
| **控制面** | `control-routes`、`cookies`、`wiring-roster` |
| **任务图 / 花名册** | `roster`、`task-graph`、`task-plan`、`task-ledger` |
| **指标 / 等待** | `metrics`、`wait-stats`、`bench`、`prompt-variants`、`prompt-bench-harness` |

---

## 七、当前结构性的欠账

| # | 欠账 | 读数 | 影响 |
| --- | --- | --- | --- |
| 1 | **站点知识散落在 4 个文件** | `providers.js` / `contract.js` / `decoder.js` / `browser-driver.js` | 新增站点要改 4 处；UI 改版要跨文件找。见 [`ROADMAP.md`](ROADMAP.md) 的「站点差异外移」一节 |
| 2 | **兜底助手选择器只服务 DeepSeek 形状** | `browser-driver.js` 的 `ANSWER_SELECTOR` 内容只有 DeepSeek 类名；10 个站点里只有 **glm / zai / doubao** 在 `providers.js` 声明了 `answerSelector` | 其余 7 站落在兜底串上；形状不匹配时采样恒空。**但按本仓库纪律不得靠猜补**——没有真机读数就不声明选择器。见 `answerSelectorFor` 的注释 |
| 3 | `test-mock` 顶层仍有 9 份 trace JSONL | 无代码引用（仅文档提及） | 属「可归档」类；不影响运行 |
| 4 | **god-function 实测（2026-10-17 结构审查）** | `createBrowserDriver` ≈ **4482 行**、`apply` ≈ **2022 行**、`createWebControl` ≈ **1857 行**（`test-mock/structure-audit.mjs` 启发式边界扫描，数字偏保守——它把嵌套 method 也算进宿主函数） | 不是行数问题，是「改一处要读通整个函数」的认知成本。**判据仍是 §四的**：`browser-driver.js` 可拆（站点差异外移），`agent-preset.js` 不拆（5 代分支服务同一协议） |

> **欠账 #2 的重要更正（2026-09-30）**：本项目此前的记载（`research/2026-09-26-dwb-site-modularity-audit.md` §C1
> 与本文更早的版本）写的是「`providers.js` 的 `answerSelector` **尚不存在**（`grep` 零命中）」。
> **那句话在写下时是真的，现在是假的**：0.19.19 已经把该字段落地（`contract.js:47` 投影、
> `browser-driver.js` 按「声明优先、缺省回落」解析），glm 与 zai 均已声明，
> `test/zai-answer-selector.test.mjs` 也已存在。
>
> 0.19.50 补的是**另一半**：那条「声明优先」的规则当时只活在一个内联表达式里，
> 而 `createBrowserDriver` 需要真浏览器才跑得起来 ⇒ **规则写反了没有任何单测会红**。
> 现抽出具名纯函数 `answerSelectorFor(siteId)` 并由 `test/answer-selector.test.mjs` 钉住
> （含两条反向验证：把优先级调反、把兜底串改一个字符，护栏都必须变红）。
>
> **这条更正本身就是本文件存在的理由**：一份 2026-09-26 的调研结论被 2026-09-30 的我
> 当成一手事实写进了这里。**研究文档是快照，改代码前必须 `grep` 现网。**

第 1 笔是**结构性**的，也是 [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md) 第 6.1 节给出的唯一框架级建议：
**收成 `lib/sites/<siteId>.js`**（每站点一个文件、导出同一形状对象），逐站点迁移、DeepSeek 先行。

> **关于「要不要按站点复制隔离」的正面回答**：**不要复制**。
> 复制在本仓库**已经产生过漂移而不是隔离**（三份 `ANSWER_SELECTOR` 字面量「修一处、忘两处」）；
> 且共用基类让 0.19.16 **一次修了 4 个解码器族**，复制会让它变 4 次。
> 真正提供隔离的是「每站点一个文件 + 同一形状」，不是「同一段代码抄 N 份」。
> 完整论证见 [`research/2026-09-26-dwb-site-modularity-audit.md`](research/2026-09-26-dwb-site-modularity-audit.md)。
