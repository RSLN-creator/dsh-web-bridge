# 代码结构归类：lib 的 30 个模块分几层

本文件把 `package/dsh-webcode-bridge/lib/` 的 **30 个模块 / 15,175 行**按**职责**归类，并给出实测依赖方向。
目的：让「改一处要动几个文件」这个问题有确定答案。

实测时间 2026-09-17，基线 0.16.3。行数含注释（本仓库注释密度极高，属有意设计）。

---

## 一、规模读数（实测）

| 项 | 值 | 取法 |
| --- | --- | --- |
| `lib/` 模块数 / 总行数 | **30 / 15,175** | `Get-ChildItem lib -Filter *.js` |
| 最大模块 | `browser-driver.js` **2,734 行** | 同上 |
| 次大 | `index.js` **2,325 行**、`agent-preset.js` **1,537 行**、`web-control.js` **917 行** | 同上 |
| 测试文件 | **52 个** `*.test.mjs` | `test/` 目录计数（与 `check-ledger.mjs` 同一口径） |
| 真机夹具 | **14 份** `dsml-real-*.txt` + 5 份具名形态 | `test/fixtures/` |
| 入口 | `main: ./lib/index.js`；`exports` 另含 `.client`、`./cordis.patch.yml` | `package.json` |

---

## 二、分层（按职责，不是按目录）

`lib/` 是**扁平目录**——30 个文件同层。下面这张表是**逻辑分层**，是新成员理解这份代码的最短路径。

### 第 1 层 · 入口与适配（进程边界）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `index.js` | 2325 | **Host half**。LLM provider 适配器、流式块协议、会话游标、设置、路由挂载。**唯一的装配中心** |
| `client.cjs` | (bundle) | **浏览器侧注入**（设置页 / 侧栏入口）。渲染契约由 `test/client-render.test.mjs` 钉住 |
| `bin/bridge-standalone.js` | (bin) | 无 DSH 时的独立启动 |

### 第 2 层 · 站点知识（「这个站点长什么样」）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `providers.js` | 666 | 多站点内容服务注册表；`listAllModels` / `resolveWebModel` 严格解析 |
| `contract.js` | 98 | 各站点网页契约收口（选择器/路径/解码器/严格模型校验） |
| `decoder.js` | 744 | 各站点 SSE/JSON 流解码器（注册表形态） |
| `model-picker.js` | 359 | 各站点「真的切换网页模型」的**唯一**实现 |
| `accounts.js` | 229 | 「站点 × 账户槽」纯身份层（0.14.7） |
| `metrics.js` | 282 | 速率推导、token 估算、`model_type` 期望值（按 UI 代际，纯函数） |

### 第 3 层 · 协议与判据（纯函数，可离线反向验证）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `agent-preset.js` | 1537 | **工具协议的唯一定义处**：首轮预设 + 增量序列化 + 回复解析 |
| `dsml-repair.js` | 100 | 网页原生 DSML 的**无名闭合标签**还原（0.16.2） |
| `flatten.js` | 80 | 把 upstream 会话状态压成单条网页 prompt |
| `prompt-variants.js` | 138 | 首轮提示词的只读变体清单（0.14.0） |
| `bench.js` | 284 | 提示词基准实验的纯判据层（0.14.8） |
| `idle-window.js` | 100 | 看门狗该用哪把尺子（分相位，0.16.3） |
| `zero-progress.js` | 64 | 「本轮零进展」收尾判定（0.15.5） |

### 第 4 层 · 浏览器驱动（最重、风险最高）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `browser-driver.js` | **2734** | Playwright 驱动系统 Edge：登录判定、选模型、发车、抓流、会话槽、附件投递、看门狗接线 |

### 第 5 层 · 镜像与网络（右栏真站点）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `mirror.js` | 724 | 站点反代 + 同源改写 + bootstrap 注入 |
| `upstream.js` | 177 | 面向镜像的 HTTP 客户端（Node 原生，不依赖全局 fetch 限制） |
| `cookies.js` | 205 | Set-Cookie 两个消费方向，各自按 RFC 6265 解析 |
| `loopback.js` | 40 | 「这个 Host 是不是本机回环」的**唯一**判定实现 |

### 第 6 层 · 执行与排队

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `relay.js` | 331 | 单槽执行器 + FIFO 队列 + 超时 / 中止 + consent |
| `wait-stats.js` | 205 | 「本次总等待发送时间」纯计算层 |

### 第 7 层 · 对外接口与控制面

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `openai.js` | 306 | OpenAI 兼容 HTTP 前端（`/v1/*`、`/bridge/*`）+ CSRF |
| `web-control.js` | 917 | 同源控制面路由（`/__webcode/*`）+ 网页历史导入 |
| `settings-page.js` | 393 | 独立设置页静态 HTML（纯展示模板，从 `index.js` 抽出） |

### 第 8 层 · 花名册与任务图（0.16.x 新增）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `roster.js` | 556 | 真实花名册投影：把「谁在跑」变成可从服务端读取的事实 |
| `task-graph.js` | 237 | 任务板图诊断：就绪集、阻塞原因、关键路径、环与悬空边 |
| `task-plan.js` | 427 | 任务图的**执行语义**：谁能开工、为什么不能、要不要重试、跑完没有 |
| `task-ledger.js` | 439 | 桥**自己**的任务台账：任务是一等公民，不寄生在任何会话上 |
| `task-split.js` | 238 | 把一个目标拆成依赖图：AI 拆分 + 分配 + 结构校验 |
| `team-state.js` | 240 | Team / 任务状态的**磁盘**投影：AgentTeams 包不在时的权威来源 |

---

## 三、依赖方向（实测的内部 import 边）

```
index.js            -> accounts, agent-preset, browser-driver, flatten, idle-window,
                       metrics, mirror, openai, providers, relay, roster,
                       settings-page, upstream, wait-stats, web-control, zero-progress
                       （16 个出边 —— 唯一的装配中心）

browser-driver.js   -> accounts, contract, cookies, metrics, model-picker
roster.js           -> task-graph, task-plan, team-state
web-control.js      -> accounts, loopback, prompt-variants, providers, upstream, wait-stats
mirror.js           -> cookies, loopback, upstream
openai.js           -> flatten, loopback, metrics, providers
contract.js         -> metrics, providers
agent-preset.js     -> dsml-repair, flatten
providers.js        -> accounts
relay.js            -> metrics
bench.js            -> agent-preset
prompt-variants.js  -> agent-preset
```

**三条结构性事实**：

1. **`index.js` 是唯一装配中心**，16 个出边；它自己不被任何模块 import。
   改任何一个「谁被谁用」的关系，第一个要看的就是它。
2. **`agent-preset.js` 是协议层的心脏**：`bench.js` 与 `prompt-variants.js` 都依赖它，
   它自己只依赖 `dsml-repair` 与 `flatten`。这条边说明「协议只有一处定义」不是口号，
   是依赖图上的事实（`doc/review-guide.md:72-73` 的第三条不可越界约束）。
3. **`roster.js` 是任务子系统的唯一出口**：`task-graph` / `task-plan` / `team-state`
   三个模块只被它引用，`index.js` 通过它间接拿到任务图。这条边是 0.16.1
   「磁盘回落让『卸载 AgentTeams』成立」的结构基础。

**未发现环**：上表所有边都指向更底层或同层模块，没有出现 A→B→A。

---

## 四、God file 清单（维护成本的真实来源）

| 模块 | 行数 | 为什么它是 God file | 有没有拆的可能 |
| --- | --- | --- | --- |
| `browser-driver.js` | 2734 | 站点差异化、DOM 契约、登录判定、发送、捕获、SSE、会话槽、附件投递**全在一个文件** | 可拆：站点差异可外移（见 `ROADMAP.md` 第 2 节） |
| `index.js` | 2325 | provider 适配器 + 流式块协议 + 会话游标 + 设置 + 路由挂载；`apply()` 单函数跨度极大 | 已抽出 `settings-page.js`，可继续抽 |
| `agent-preset.js` | 1537 | 协议编解码**内聚**，但已含 5 代兼容分支 | 内聚性高，优先加注释而非拆分 |
| `web-control.js` | 917 | 控制面路由 + 网页历史导入 | 历史导入可独立 |

**判据**：拆分的标准不是行数，而是「**改一处要不要动多个文件**」。
`browser-driver.js` 满足拆分条件（站点差异散落其中）；
`agent-preset.js` 不满足（它的 5 代分支服务同一个协议，拆开会制造两套协议漂移）。

---

## 五、什么不是运行链路（审查时可跳过）

- `reference/`（37 个逆向参考仓库，纯 git clone，`.gitignore` 已排除）
- `doc/`（全部文档）
- `test-mock/archive/`（58 个已归档的一次性探针 + 旧 `extension/`）
- `.tmp/`（本机暂存，313 个文件，含大量可再生产物）
- 根目录 `PLAN*.md`、`REPORT.md`（本地私有留痕，不入库）

出处：`doc/review-guide.md:27-31`。

---

## 六、测试分布（52 个文件按被保护的对象归类）

| 保护对象 | 代表测试 |
| --- | --- |
| **协议解析 / 泄漏** | `regression`(75KB)、`protocol-leak`(24KB)、`parse`、`nameless-call`、`dsml-native-close`、`dsml-real-reply-regression`、`fence-nested-call`、`fence-prose` |
| **站点契约 / 解码** | `multi-site-decoder`、`glm-conversation`、`glm-session-replay`、`site-mount`、`mirror`、`model-picker`、`model-labels` |
| **账户槽** | `accounts`(38 项)、`accounts-integration`(16 项) |
| **驱动时序 / 收束** | `idle-window`(17)、`watchdog-first-byte`(9)、`timeout-order`(5)、`stall-settle`、`zero-progress`、`wip-settle`、`stream-tail`、`send-gap` |
| **附件投递** | `prompt-transport`(8)、`prompt-transport-attach`(9)、`upload-attachment-structure`(4)、`attach-callsite`(6)、`context-budget` |
| **UI 渲染契约** | `client-render`(69KB)、`client-server-contract`、`present-preset`、`hooks-order` |
| **控制面** | `control-routes`、`cookies`、`wiring-roster` |
| **任务图 / 花名册** | `roster`、`task-graph`、`task-plan`、`task-ledger` |
| **指标 / 等待** | `metrics`、`wait-stats`、`bench`、`prompt-variants`、`prompt-bench-harness` |

> **一个必须知道的计数口径**：`check-ledger.mjs` 数的是 `test/*.test.mjs` 的**文件数**（当前 52），
> 不是断言数。文件数变了必须同步台账，否则闸门红。

---

## 七、当前结构性的三笔欠账

| # | 欠账 | 读数 | 影响 |
| --- | --- | --- | --- |
| 1 | **0.16.x 四轮改动全部未提交** | 44 项未提交（13 改 + 31 新）；`origin/main` 仍在 `6b836d2` | 工作树误删即丢四轮修复 + 14 份真机夹具；见 `ROADMAP.md` 第 3 节 |
| 2 | **站点知识散落在 4 个文件** | `providers.js` / `contract.js` / `decoder.js` / `browser-driver.js` | 新增站点要改 4 处；UI 改版要跨文件找；见 `ROADMAP.md` 第 2 节 |
| 3 | `test-mock` 顶层仍有 9 份 trace JSONL（约 1MB） | 无代码引用（仅 3 处文档提及） | 属「可归档」类；不影响运行 |

第 2 笔是**结构性**的，也是 `doc/diagnosis-2026-09-16.md` 第 6.1 节给出的唯一框架级建议。