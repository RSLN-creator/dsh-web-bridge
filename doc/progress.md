# 进度台账（进仓库）

**为什么这个文件存在**：2026-09-14 的会话在收尾前被中断，而它的进度只写在
`PLAN*.md`（本地私有留痕、不在仓库），导致下一次会话必须从头 recon 一遍。

`doc/README.md` 已经规定了「根目录 `PLAN*.md` 是本地私有留痕」——那条约定是对的，
缺的是它的**对偶**：仓库里必须有一份「当前走到哪、下一步是什么」的台账。这就是本文件。

约定：

- 每完成一项即更新这里；跨会话恢复以本文件 + `PLAN.md` 为准，不依赖会话记忆。
- 状态以本文件为准，**缺陷与「为什么不现在修」以 `long-term-issues.md` 为准**。
  一份写「现在在哪」，一份写「还欠什么」——两边都不复制对方的结论。
  （2026-09-16：原先这条写的是与 `session-log-review.md` 的分工，那份归因报告已按
  用户指示删除；错误码与归因现落在 `bridge-failure-ledger.md`。）

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 工作树版本 | **0.15.11** |
| 已装版本（profile） | **0.15.9**（0.15.10 / 0.15.11 尚未打包；三轮代码都在工作树里） |
| 运行中的进程 | **0.15.9**（2026-09-16 23:56 重启后实测：`/__webcode/status` → `version=0.15.9 hash=a2e1e2349249`；relay running、driver loggedIn、transport=playwright-edge、79 条会话映射已恢复、21 个模型在册） |
| 上游 | `origin/main` = `a956512`。**`89f7d41`(0.15.7) 与本轮 0.15.8～0.15.11 均未推送** |
| 单测基线 | **40/40 测试文件全绿**（逐文件跑；`client-server-contract` 曾红，根因与修法见 §0.15.11） |
| 注释闸门 | **error 0 / warn 0，退出码 0**（85 个文件，2026-09-17 实跑） |
| 文件规范闸门 | `check-repo-hygiene.mjs` **PASS**（无 BOM + 索引无死链） |
| 发布闸门 | `verify-pack` **29/29 逐字相同 + 接线完好**，退出 0（0.15.9 打包后实跑；0.15.10/11 尚未打包） |
| 记账闸门 | `check-ledger.mjs` **PASS**（version 0.15.11 / testFiles 40/40） |
| 下一阶段 | 打包 0.15.11 → `verify-pack` → 装 profile → 重启，做 §0.15.11「等待药丸同栏」与 0.15.9「缺 `name` 调用可见」两项真机验收 |

> **2026-09-17 三次漂移修正（第 5 次）**：上表此前写着「工作树 0.15.9 / 已装 0.15.9 /
> 只有 0.15.7 与本轮 0.15.9 未推送」，且 `check-ledger` 实测**红**（`package.json`
> = 0.15.11 vs 台账 0.15.9）。更严重的是：**0.15.10 与 0.15.11 两轮工作在本文件里
> 一个字都没有**——同一毛病第 5 次出现（正文补在下面）。本轮还发现
> `client-server-contract.test.mjs` 因多注册了一条死路由而**一直红着没人知道**，
> 因为台账写的是「40/40 全绿」而那份读数是旧轮次的。修法与判据见 §0.15.11。
>
> **2026-09-16 二次复核修正（第 4 次漂移）**：上表此前写着「已装 0.15.6 / 运行 0.15.6（需重启）」
> 与「0.15.4～0.15.7 全部未推送」，**三项均过期**——实测**已装且正在运行 0.15.7**，
> 且**只有 0.15.7 未推送**。同一次复核还发现 `long-term-issues.md` 的 `一览表`
> **漏登记 #19、#20**（正文有、表里没有）。完整诊断见
> [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md)。
>
> **第 3 次修订（2026-09-16）**：上表此前逐字写着「工作树 0.15.3 / 已装 0.15.3 / 运行进程仍是旧的 /
> 35 个测试文件」，**四行全过期**，且 0.15.4、0.15.5、0.15.6 三轮工作在本文件里**没有任何段落**
> （同一毛病第 3 次出现）。本次一并补齐，并把「版本号与测试文件数」的核对方式写进
> `doc/review-guide.md` 的收尾清单——**靠自觉的记账已经失败三次，不能再只靠自觉**。
>
> **本机跑测试的前提（2026-09-16 实测，必须知道）**：沙箱下的 `%TEMP%`
> 是 ACL 受限目录，`mkdtempSync(os.tmpdir())` 一律 **EPERM**，会让
> `regression` / `tool-loop` / `wiring-roster` 三个文件假失败。
> 把 `TMPDIR`/`TEMP`/`TMP` 指到工作区 `.tmp` 后 **39/39 全绿**。
> 这是环境前提，不是回归——已记入 `long-term-issues.md` #10。

## 0.15.11（已打代码 / 未打包 / 未安装）—— 等待药丸「同栏」由**结构**决定，不靠边距

**补记说明**：本轮与 0.15.10 的工作此前**没有写进本文件**（第 5 次漂移）。以下依据是
工作树源码里的留痕（`lib/client.cjs` 的注释、`lib/wait-stats.js` 的两条新导出）与实测读数，
不是事后回忆。

### 一、0.15.10 先做的（药丸化 + 面板）

用户报的是输入框底下那条等待信息**与官方统计药丸分成两栏**。旧实现的根因是**长度预算**：
它把「本会话 / 距上次发送 / 限流」三件事塞进一行，官方那个槽位放的是 13px 单行药丸，
一行只容得下「一个数 + 一个后缀」，于是必然换行成第二栏。

| 文件 | 改动 |
| --- | --- |
| `lib/wait-stats.js` | 新增 `composerWaitPillLabel`（单行短文案，无数据返回 `null` ⇒ 整枚不渲染）与 `waitStatDetailRows`（点击面板的明细行，对齐官方 stat-dialog 的 dl 网格） |
| `lib/web-control.js` | `waitStatsPayload` 增发 `label` / `sessionValue` / `detailRows`；`composerWaitLine`（长文案）**保留**，供旧前端与 curl 核对 |
| `lib/client.cjs` | 设置页的「累计等待发送」区块（`WaitStats`）删除——同一份数字不再两处重复 |

### 二、0.15.11：同栏改为结构决定

0.15.10 之后仍是「两条 dock 条目 ⇒ 必然换行」，因为 `conversation.composer.dock`
的每个条目都落在 composerStack（列向 flex）里。修法是**不再自建一行**：

- 新 `useOfficialStatsHost(wanted)`：用 `MutationObserver` 盯 `[data-composer-stats]`
  （官方 `ui-chat` StatsPills 的根节点），行一出现就 `React portal` 把这个节点挂进去，
  它于是成为该行里紧跟官方药丸之后的 **flex 子项**——居中、间距、换行全部归官方那条 CSS 管，
  **没有任何写死的偏移量**。
- 官方行缺席时（会话尚无任何统计：StatsPills 在 `steps===0 && !hasTokens` 时返回 null）
  回落自建一行，样式**逐字抄** StatsPills.root / stat-dialog.module.css（28px 高、
  border-radius 24px、`tabular-nums`、面板向上展开）。
- 关闭语义对齐官方 `openPill` 独占：Esc 收起 + `pointerdown` 落在自己 wrap 之外就收起
  （于是点官方任何一枚药丸时本面板随之关闭）。用 `rootRef` 而不是整行做边界，
  点自己面板内部（含滚动条）不会误关。
- 图标用 `IconQueueOutline14`（官方 primitives 无 gauge/clock，队列图标是同语义域最近的一个）。

### 三、同轮修掉的死路由（`GET wait-stats`）

`test/client-server-contract.test.mjs` 实测**红**，报 `GET wait-stats`：

```
契约：服务端每个动作至少能被一种方法触达（没有写错方法名的死路由）
  same-name action registered but method unreachable: GET wait-stats
```

**判据本身是对的**：那条 GET 是 0.15.10 顺手加的（注释写「便于 curl 核对累计值」），
但**没有任何真实消费方**——客户端只走 `api('wait-stats', {sessionId})` ⇒ POST。
实测 `POST wait-stats` 带空 body 给出**逐字相同**的累计视图：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8931/__webcode/wait-stats' -Method POST `
  -ContentType 'application/json' -Body '{}'    # → 200，rows 就是累计面
```

所以修法是**删掉那条 GET**，不是改宽测试。这与 0.15.3 的立场一致（「若确属误报，请改
本脚本的判据而不是绕过它」）——这里不是误报：多一条永不抵达的同名路由，只会让
「哪个方法是对的」重新变成需要猜的事，而那正是 0.15.3 那次 405 的同族病根。

> **为什么这条红了的测试没被台账记到**：台账那一行写的是「40/40 全绿」，但那是
> **上一个轮次的读数**。这印证了本仓库反复踩的同一个坑——**读数会过期，而闸门不会自己
> 重跑**。本轮把「逐文件跑一遍并核对 40/40」写进收尾清单。

## 0.15.10（已打代码 / 未打包 / 未安装）—— 见 §0.15.11 第一节

单行药丸 + 点击面板；设置页重复的累计区块删除。判据：`test/wait-stats.test.mjs`
（`composerWaitPillLabel` / `waitStatDetailRows` 的纯函数护栏）与
`test/client-render.test.mjs`（药丸渲染与面板交互）。

## 0.15.9（已打包 / 已装 / 已重启生效）—— 用户报的「web 内容在 harness 显示不了」：缺 `name` 的调用被静默丢弃

**用户原话**：「现在返回 web 的内容会在 harness 端显示异常/显示不了？有些可以有些不行？
请你先优先只修复这个问题，让实际 harness 能正常长期跑！这是最近有的问题，修复过却还是存在！」

### 一、先拿到「网页实际发出的字节」（这一步是全部结论的地基）

历史修复反复不中，共同点都是**只有 harness 侧的读数**（「正文停了」「只有思考」），
从来没有网页那一侧的原话。本轮用桥自己的只读控制面把头一次拿到：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8931/__webcode/history' -Method POST `
  -ContentType 'application/json' -Body '{"sessionId":"49ab6330-0fbd-4842-a7b7-e9ce5d57031b"}'
node .tmp/extract-nameless-fixtures.mjs     # 逐字落成 test/fixtures/nameless-*.txt
```

结果一句话：**模型连着两轮把调用写成 `<tool_call>{"mcp_action":"call","purpose":…,"arguments":{…}}`——没有 `name` 字段**。

### 二、根因（`lib/agent-preset.js` 的 `takeObj`）

围栏调用只认「JSON 能解析 **且** 有 `name`」，缺名直接 `return`，**连 diagnostics 都不写**
（0.15.6「丢弃不再静默」只覆盖了 JSON 解析失败那一支）。于是：调用消失 → 协议被
`proseSafeEnd` 扣住 → 只剩散文；正文全是协议时整轮被判「只有思考」，交回一句与事实
相反的 `THINKING_ONLY_NO_ANSWER`。真机读数：`turn 4 step 1 = reasoning(739)+text(59)`，
`turn 4 end reason=completed`，之后 4 个 turn 模型反复说「my tool calls didn't get results」。

### 三、修法

| 文件 | 改动 |
| --- | --- |
| `lib/agent-preset.js` | 新增 `normCallArgs`（导出归一化，流式与收尾共用）与 `inferToolNameFromArgs`（按**本会话工具表**反推名字：每个键都必须被该工具声明、必填必须齐、候选必须唯一）；`parseAgentReply(text, { tools })` 用它救回缺名/包装名调用，猜不出时**必须**留 diagnostics；还原成功的调用带 `nameInferred` |
| `lib/index.js` | 两处解析传 `tools`；流式开块也用同一份判据（界面提前显示「正在调用 read」）；新增 `TOOL_CALL_UNPARSED` 提示——协议被探测到但一条可执行调用都没有时，如实说明并给重发格式，**取代**那句反事实的 thinking-only 文案与空白消息 |
| `lib/zero-progress.js` | **未改**。它的顺序契约（thinking-only 先于 protocol-withheld）仍然成立；新分支排在它**之前**，且提示里带上思考尾部，不吞任何内容 |

**为什么不做「按第一个键查表」**：`{file_path}` 会被读成 `write` 并覆盖文件——
执行错的事比丢调用更坏。唯一解要求把这类误判挡在门外。

### 四、判据与反向验证

| 项 | 读数 |
| --- | --- |
| 红基线（修复前） | 四份真机夹具 `calls=0 / diagnostics=[]`（`.tmp/red-baseline-nameless.txt`） |
| 新护栏 | `test/nameless-call.test.mjs` **15 项**：①②③⑤⑦⑫⑬⑭ 修复前为红；④⑥⑧⑨⑩⑪ 是反向安全线，⑪a 覆盖另两条早退分支的留痕 |
| 全量单测 | **40/40 文件全绿、556 项断言 0 失败**（逐文件跑；`.tmp/full-test-run-0159-final.txt`） |
| 注释闸门 | `lint-comments` error 0 / warn 0，退出 0 |
| 记账闸门 | `check-ledger` PASS（version 0.15.9 / testFiles 40/40） |
| 真机口径 | 重启后对同一网页形状应看到 `tool-call` 块（修复前一个块都不开） |

### 六、打包与安装（本轮收尾的实际读数）

| 步骤 | 命令 | 读数 |
| --- | --- | --- |
| 打包 | `pnpm pack`（`package/dsh-webcode-bridge/`） | `dsh-webcode-bridge-0.15.9.tgz`（308,118 B） |
| 发布护栏 | `node scripts/verify-pack.mjs <tgz>` | **逐字相同 29/29**，接线完好，退出 0 |
| 安装 | `node scripts/install-profiles.mjs` | `web: v0.15.9`、`headless: v0.15.9`，退出 0 |
| 安装核对 | `.tmp/verify-installed-0159.mjs` | 版本 0.15.9 ✔；lib **24/24 sha256 相同** ✔；用**已安装**解析器跑四份真机夹具，`["grep","pwsh"]`/`["read","pwsh"]`/`["read"]`/`["read"]` 全对 ✔ |
| 已装包端到端 | `.tmp/verify-installed-e2e-0159.mjs` | 导入**已安装**的 `lib/index.js` 跑真机夹具 → 工具调用块 `["read","pwsh"]`、散文保留、协议未泄漏；解析不出调用时正文含 `TOOL_CALL_UNPARSED` 且不再误报「只思考」✔ |
| 重启 | `.tmp/restart-dsh-web.ps1`（分离进程 90 秒倒计时） | 旧进程 23800 停止 → 新进程 **14648** 于 23:56:16 起来，3080/8931 同时恢复监听 |
| 重启后核对 | `GET /__webcode/status` | **`version=0.15.9`、`hash=a2e1e2349249`**；relay running、driver loggedIn（transport=playwright-edge）、**79 条会话映射已恢复**（含 `session-07907f7c → 49ab6330`）、21 个模型在册 ✔ |
| 真机活体冒烟 | `POST 127.0.0.1:8931/v1/chat/completions`（真实网页轮次） | **200，3.6 s 返回正文**（`"I can't read that file: the read tool isn't available in this conversation."`——符合该端点行为：`/v1` 只做纯对话转发、不教协议）。证明重启后的 **relay + driver + 网页会话整条链是活的** ✔ |

**收尾诚实说明**：`/v1` 这条 OpenAI 兼容路径不经过 harness 适配器，因此它**不能**用来验证缺 `name` 的调用还原；
那条链路的判据是「用真机字节跑适配器得到工具调用块」，已由上表两行（安装核对 + 已装包端到端）
覆盖。缺名调用何时出现由网页模型决定，无法在真机上定向制造——夹具就是模型原话本身。

### 七、这一条为什么值得单独记

`takeObj` 有**两条**出口会丢调用（JSON 解析失败、结构不合法），0.15.6 只给前者装了留痕。
**「不留痕的早退分支」是静默丢弃的唯一来源**——给一条路加日志时，要把同一个函数里
所有 `return` 一起数一遍。台账正文见 `long-term-issues.md` #23。

## 0.15.8（已打代码 / 未打包 / 未安装）—— #19 真根因修复 + 仓库结构整理

### 一、#19 修复：`invoke` 体的 lazy 截断（主路径静默丢调用）

**根因**（诊断定位，`diagnosis-2026-09-16.md` §5）：`lib/agent-preset.js` 的 `invoke`
体用 **lazy** 正则 `([\s\S]*?)</invoke>` 捕获。当**参数体里举例引用了协议自身的闭合标签**
（写文档/审计报告说明协议形状时必然出现）时，在示例里的第一个 `</invoke>` 处截断 →
体内无配平 `</parameter>` → `n===0` → **调用被静默丢弃**。

**真机证据**：仓库根那份 22,366 字符的 `REPORT.md` 泄漏样本——它本该是一次 `write`
调用的参数体，却因调用不可执行而**变成了文件本身**，真正的交付物从未落盘。

**修法**：新增 `invokeBodyEnd(src, from)`——**配平感知的状态机**，只在「参数外」遇到的
第一个 `</invoke>` 才算体终点。

| 方案 | 结果 |
| --- | --- |
| lazy（修复前） | 体 10,133 字符，**无配平参数 → 0 调用** |
| **greedy（未采用）** | 能救单个调用，但会把同轮第二个调用吞进第一个的体里 |
| **配平状态机（采用）** | 体延伸到位，`name=write`，`content=10,121` 字符 |

**反向验证（`doc/comment-style.md` §9.3：先红后绿）**：新增 ⑬ 在修复前**实测为红**
（`pass 17 / fail 1`），修复后 **19/19 全绿**。

**同时修掉修法自己引入的一个回归**：换成两次定位后 `m[0]` 不再包含体，
导致「畸形标签抢救」分支（扫 `m[0]` 找 `"name"/"arguments"` 片段）失效。
实测 `regression.test.mjs` 由 53/53 变成 49/53；重建 `m[0]` 后回到 **53/53**。
另外给状态机加了**降级兜底**：扫到结尾仍不配平时退回第一个 `</invoke>`（取旧行为），
而不是返回 -1 把整条调用丢掉。

### 二、仓库结构整理

| 动作 | 结果 |
| --- | --- |
| 一次性探针归档 | `test-mock/` 顶层 **83 → 25** 项；58 个无代码引用的探针移到 `test-mock/archive/`（git 识别为 **58 个 rename**，历史保留） |
| 死代码移出根目录 | `extension/`（9 文件，零代码引用，`relay.js:12` 明言「there is no extension」）→ `test-mock/archive/extension/`；仓库根目录不再有它 |
| `.tmp` 清理 | **272.3 MB → 122.8 MB**（删 `.tmp/pnpm-probe/node_modules` 149.5 MB 可再生缓存 + 30 个空的 `webcode-test-*` / `webcode-wiring-*` 测试残留目录） |
| 悬空 gitlink 清除 | `reference/` 下 4 个 mode-160000 gitlink（`webcode`、`opencode2dsh`、`deepseek-web-import`、`dsh-deepseek-chat`）**无 `.gitmodules` 却是子模块条目** → `git rm --cached`，磁盘文件保留，`.gitignore:9 reference/*/` 从此真正生效 |
| 死链修复 | `README.md` 两处指向被 `.gitignore` 排除的 `PLAN.md` 已改为仓库内权威入口 |
| 文档同步 | 归档路径变化同步进 `doc/review-guide.md`、`doc/ci-cd.md`、`CONTRIBUTING.md`；新增 `test-mock/archive/README.md` 写明目录约定与「归档后相对导入失效」 |

**判据（下次整理照此，不要凭「看起来旧」）**：留 = 被代码引用或属稳定入口；
归档 = 只被文档提及且那轮结论已回写。

## 2026-09-16 全局诊断（本轮工作，无产品代码改动）

一次完整盘点，产出单独成文：[diagnosis-2026-09-16.md](diagnosis-2026-09-16.md)。
**三条已证结论改变了台账的原有记法**，摘要如下（细节与复现命令见该文）：

| # | 结论 | 影响 |
| --- | --- | --- |
| **#19 已归因** | 真根因是 `lib/agent-preset.js:1186` 的 `invokeRe` 用 **lazy** 体捕获 `([\s\S]*?)</invoke>`；当**参数体里举例引用了协议自身的闭合标签**（写文档/审计报告的主路径）时，体在示例里的第一个 `</invoke>` 处截断 → 无配平 `</parameter>` → `n===0` → 调用静默消失。**与 0.15.6 猜的「围栏形状」无关**（8 种围栏形状实测全部健康） | 从「未归因」改为**「已归因，待修」**；修法方向已用 lazy/greedy 对照验证 |
| **#22 前提推翻** | `session-fcbb5bf8` step 7 的 `assistant/message` **有** text 块（357 字符），且那**就是桥自己写的 `THINKING_ONLY_NO_ANSWER` 诊断文本**（`thinkingOnlyNotice` → `emitText` 落库）。原报告「没有 text 块」为误 | 可能性 2（捕获链丢正文）**排除**；**真正的缺陷是诊断文本被持久化进助手正文**，严重度 中 → **高** |
| **#9 重定性** | `run-m2` / `run-m2b` / `run-m2c` 三项实跑均为 `spawn EPERM`，**从未跑到自己的断言**。原记「走废弃扩展链路 / mock 形状脱节 → 干净树同样失败」**无实测支持** | 改记 **UNTESTABLE（本机）**，须由 CI 读数定性；不得再当作「已知既有失败」解释红色项 |

**同轮完成的收尾**：

- `long-term-issues.md` 一览表**补登记 #19、#20**（此前正文有、表里没有）；
  #9/#19/#22 各加复核段；#10 补记本机**第二类 EPERM**（`mkdtemp`，可用 `TMPDIR` 绕过）。
- `README.md` 两处指向 `PLAN.md`（被 `.gitignore` 排除）的**死链已修**——
  克隆者看不到该文件；改为指向仓库内的 `doc/` 权威入口，并加一段说明。
- `doc/README.md` 索引加入本诊断报告。
- **护栏**：`test/fence-nested-call.test.mjs` 新增 ⓪a/⓪b 两项真机形态用例（12 → **14 项**）。
- **可复现证据脚本**：`.tmp/probe-diagnosis-2026-09-16.mjs`（组 A/B/C，退出码即判据）。
- 复核读数：**测试 39/39 全绿**、`check-ledger` **exit 0**、`lint-comments` **error 0 / warn 0**。

**下一步（P0）**：① #22 修 `thinkingOnlyNotice` 不得进正文通道（注意 `TOOL_UNKNOWN`
**需要**模型看见，两类提示须分开评估）；② #19 按 `<parameter>` 配平定界修 `invokeRe`
（**不要**直接用 greedy——会把同轮第二个调用吞进第一个）；③ 两者都要先补
`withheld` / `n===0` 的**形状指纹留痕**。


## 0.15.7（已打包 / 待装 / 需重启生效）—— SET 重发吞掉流式增量

用户原话（逐字）：**「？怎么回事》明明有输出：`<tool_call>{…}</tool_call>`
却提示 THINKING_ONLY_NO_ANSWER」**。

**用户的观感是对的**：问题不在收尾判定，而在**接收层的流式增量**。

### 根因

DeepSeek 会把**整份 response 对象**反复重发，`fragments` 每次都比上一次长。
两个入口（真机都出现过）旧实现都是**整份替换**，且只在**第一次**见到该
response 时外发增量：

- `{o:'SET', p:'', v:{response:{…}}}`
- `{o:'SET', p:'response/fragments', v:[…]}`

于是 `onDelta` 累计的 `acc` 停在第一帧，而 `finish().text` 是完整正文：

```
acc           = "Hello"          ← 界面正文停在半路
finish().text = "Hello world!"   ← 「明明有输出」
```

后果链条：正文停半路 → `index.js` 的边界探测只看 `acc`、后段里的
`<tool_call>` **探不到** → 一个 tool-call 块都不开、**工具从未执行** →
收尾 `finalText` 与 `textSent` 分叉 → 判成「正文空 + 只有思考」→
交回 `THINKING_ONLY_NO_ANSWER`。

### 修法

抽出 `emitFragmentDiff(next, prev)`，**两个入口共用**，按下标逐位对比：

| 情形 | 处置 |
| --- | --- |
| 同下标变长且以旧内容为前缀 | 只发增长的后缀 |
| 同下标被改写 | **不发**（补发会变成重复正文） |
| 新增下标 | 整段当增量发 |

附带修掉两个同源缺陷：**新增片段**整段漏发、**新增图片**流式期间不触发
`onImage`（轮次进行中界面无图，只能靠 `finish()` 事后捞回）。

### 护栏与反向验证

`test/decoder-fragment-diff.test.mjs`（9 项 = 5 判据 + 3 反向安全线 + 1 接线）。
**反向验证已做**：把 diff 外发改回「只在首次」→ **pass 4 / fail 5**；
恢复后 **9/9 全绿**。全量 **39/39** 测试文件通过。

### 一条通用教训

`onDelta`（增量通道）与 `finish()`（权威快照）**两条通道同时存在**，
而测试历来只 assert `finish()`——它**总是对的**，所以那个洞活到了真机。

> **任何「增量通道 + 权威快照」双通道的解码器，都必须有一条把两者
> 钉在一起的断言（流式外发 ≡ 权威全文逐字一致）。**

详见 `doc/long-term-issues.md` #21（本条）与 #22（同一用户报告里
**未归因**的另一半：DeepSeek 只出思考不出正文）。

## 0.15.6（已发布 / 已装 / 已重启生效）—— 参数含围栏的调用被丢弃并整段泄漏

用户原话（逐字）：**「harness 端的 markdown 渲染整块不见（web 正常）」**。

这是 0.15.5 修「普通 markdown 围栏被误判成协议」时**引入的回归**，影响面是
**写文档/写代码的主路径**（97 个会话里参数含 ``` 的 tool-call 有 108 个）。

| # | 环节 | 缺陷 |
| --- | --- | --- |
| ① | `parseAgentReply` | 非贪婪围栏正则 `` /```([\s\S]*?)```/ `` 在**第一个内层 ```** 处截断体 → `JSON.parse` 失败 → `takeObj` 静默 return → **调用消失，文件从未落盘** |
| ② | `firstCallFenceAt` | 用同一个错误窗口 → `hasJson=false` → 真调用围栏被判成普通围栏 → `findProtocolStart` 返回 **-1** |
| ③ | `proseSafeEnd` | index=-1 时返回**全文长度** → 整段原始协议被当正文外发并持久化 |

**根因一句话**：「什么算围栏体」有两份知识（解析器一份、泄漏防护一份），两份都写错了同一边界。

**修法**：两侧统一到 `readCallAt`（花括号 + 字符串转义感知）这一个定位器，
并给 `proseSafeEnd` 加一道独立兜底。

**A/B 实测**（`.tmp/probe-audit-regress.mjs`，同一段文本）：

| 版本 | boundary | proseSafeEnd | withheld | parsedCalls | contentIntact |
| --- | --- | --- | --- | --- | --- |
| 0.15.3 | 53 | 53 | 313 | 0 | false |
| **0.15.5** | **-1** | **366（全文）** | **0** | 0 | false |
| **0.15.6** | 53 | 53 | 313 | **1** | **true** |

**验证**：新增 `test/fence-nested-call.test.mjs` 12 项；反向验证（倒回修复前）
**pass 5 / fail 7**，证明护栏真的钉住了缺陷。完整记录见 `doc/verify.md` §0.15.6。

> 本文件**首次写入就是被这个缺陷吃掉的**（write 参数里含代码块 → 调用消失 + 协议泄漏），
> 当时不得不补写一份审计报告来记录这件事——那份报告已按用户指示于 2026-09-16 删除。
> 教训留在本文件与 `doc/verify.md` §0.15.6 里。
> **并且 2026-09-16 又一次复现**：一次 `edit` 被 `withheld 390 chars` 且未落盘，
> 见 `doc/long-term-issues.md` #19。这是本项目第一例「缺陷吃掉了它自己的记录」。

## 0.15.5（已发布 / 已装 / 已重启生效）—— 「零进展轮」顺序纠正 + 去 BOM

**真机缺陷的原始现场**（子代理会话 `ecad7b6a`）：

```
step1  usage={inputTokens:26263,outputTokens:197}   blocks=[text(66), tool-call(pwsh)]
step2  usage={inputTokens:28555,outputTokens:0}     blocks=[reasoning(201)]
turn/end reason=completed
```

后果：`doc/research/graph-plugins-references.md` 与 `panel-plugins-references.md` 均 MISSING，
`reference/` 无任何新克隆——**一个工具调用发出去之后，整轮以「零产出」收场却报 completed**。

**修法**：`zeroProgressDecision` 的判据顺序——`thinking-only` 判定必须先于
`protocol-withheld` 判定，否则「正文空 + 思考非空 + 有扣留协议」这一类会被静默吞掉。
新增纯函数模块 `lib/zero-progress.js` + `test/zero-progress.test.mjs`（11 项）。

**反向验证**（`doc/verify.md` §0.15.5）：换回旧顺序 → exit 1 / fail 2；恢复 → exit 0 / pass 11。

**同一轮的其他改动**：`package.json` 去 BOM（首三字节 `123,10,32`）、
`.github/CODEOWNERS` 把 `@owner` 占位符换成真实账号 `@RSLN-creator`。

## 0.15.4（已发布 / 已装 / 已重启生效）—— 真实花名册的两个语义缺陷

**没有单独台账段落，从 `lib/roster.js:25-54` 的注释与 `lib/client.cjs:389` 反推**——
两个缺陷都有**真机 + 官方源码双重证据**：

| # | 缺陷 | 现场 | 修法 |
| --- | --- | --- | --- |
| A | 「挑第一个能通过 `listMembers` 的 agent」会读到**别人的** lead | 官方 `tryMembership`（`dsh-experimental-agent-team/lib/index.js:397-430`）对**任何没有 subagentDescriptor 的顶层 Agent** 都返回 `{role:'lead',name:'lead'}` 而**不抛错**，`list()` 还无条件先插一行 lead 伪行。于是旧实现读到的是「进程里第一个顶层 agent 自己的 lead」——与用户正在看的会话无关。**活进程实证：换两个不同 `sessionId` 查询 `/status`，`team` 段逐字相同** | 只用**当前会话自己**当凭据（`agents.get(sessionId)`）；拿不到就如实说 `caller-not-live`，绝不用别的 agent 顶替 |
| B | 把 Team **总任务数**当成「每个成员的任务数」 | 对每个成员都调 `listTasks(agent).length`——那个数是整块任务板的条数，对每个成员都一样；还同一 agent 调了两次 | 按官方 `TeamTaskView.ownerName` 归属，且**整表只读一次** |

**顺带**：Team 的「成员」与「任务板」拆成两个字段（官方 `remoteView` 返回的本来就是
`{members, tasks}`，任务板是**团队级**的，不是某个成员的属性）。

**验证**：`test/wiring-roster.test.mjs` 与 `test/roster.test.mjs`（本轮大幅扩写，+340 行）。

## 0.15.3（本轮）—— 设置页整块空白 + 花名册恒读不到

用户原话（逐字）：**「请你查看设置界面 窗口问题，现在空白一片」**。

查下去是**三个独立缺陷叠加**，其中两个同属「引用/调用点都在、链路的另一端不存在」
这一族（上一轮 `projectRoster` 漏 import 是同族），而且**离线全绿**。

| # | 缺陷 | 现场 | 后果 | 修法 |
| --- | --- | --- | --- | --- |
| ① | `SiteAccounts` 的 hook 写在提前 `return` 之后 | `lib/client.cjs`：3 个 `useState` + 1 个 `useEffect` 之后是「站点表为空就返回加载中」，**这句之后**又写第 5 个 `useState`（`picked`） | 首屏跑 4 个 hook 就 return，`sites` 到达后同一次挂载走到第 5 个 → React 硬错误 → 错误冒泡到 `settings.section` 的 `SlotErrorBoundary` → **整块栏目变空占位** | `picked` 提到提前 `return` 之前 |
| ② | `status` 只注册了 GET，客户端走 POST | `api('status', { sessionId })` 带 body ⇒ POST；`web-control.js` 只有 `'GET status'` | 真机 `POST /__webcode/status` ⇒ **405**；`subAgentsError` 报的 `no-session-id` 是**后果**不是根因 | `actions['POST status'] = actions['GET status']`（**别名**，不复制实现） |
| ③ | `settings.section` 是 root 作用域，`inject` 拿不到 sessionId | 0.15.0 写了 `inject: (sessionId) => ({ sessionId })` | root 槽的 `inject` 只拿到 `actions` 对象，被当成会话 id 送到服务端 | 新增 `SettingsSection`，经官方 standard prop **`useSessions`** 读 `state.current` |

**官方契约证据（本地权威，不是推断）**：
`...\dsh-cordis-client-runner\lib\client.js:3873` → `settings.section` 的 `scope: "root"`；
同处 `:3902` 的 `standardProps` 列表含 `useSessions: UseSessions`；
官方 `dsh-client-ui-settings-general\lib\client.js` 自己就是
`useSessions(state => …state.current…)` 读会话。

### 为什么原来的护栏全绿（本轮最该记住的一条）

- `client-render.test.mjs` 的 `useState` 桩是**按名字取值**的映射，结构上察觉不到
  hook 顺序/数量违规；且切换 payload 时会清空 states ⇒「同一次挂载内 4→5 个 hook」
  从未被复现。
- 同一个文件的 mock fetch **不看方法**，任何 URL 都回 200 + JSON ⇒
  「服务端没这条路由」整个不可见。

护栏的建模失真，把整类缺陷盖住了。新增的三条护栏都**先证明能抓到缺陷再修**
（反向验证记录见 `doc/verify.md`）：

| 护栏 | 抓什么 | 反向验证 |
| --- | --- | --- |
| `test/hooks-order.test.mjs`（2 项） | 组件体顶层「hook 在提前 return 之后」 | 搬回 return 之后 → 红；搬回 → 绿 |
| `test/client-server-contract.test.mjs`（2 项） | 客户端 `api(action, body)` 推的方法 vs 服务端动作表 | 删别名 → 红；恢复 → 绿 |
| `client-render.test.mjs` +2 项 | root 槽不得用 inject 冒充会话来源；降级链必须完整 | 三条反向用例全部被抓到 |

> 护栏自身两次失手也记录在案：`hooks-order` 第一版不跟踪花括号深度会**误报**
> （会误报的护栏会被直接绕过）；第二版跟踪了深度却漏掉**单行守卫**
> （`if (cond) return x;`）这一形态——正是真机缺陷的写法，反向验证因此**静默漏过**。
> 教训：**护栏写完必须反向验证，且反向用例本身要确认「变更真的生效了」。**

### 验证（全部实跑）

| # | 判据 | 命令 | 结果 |
| --- | --- | --- | --- |
| A1 | 全量单测 | 35 个测试文件逐文件跑 | **35/35 全绿** |
| A2 | 注释闸门 | `node scripts/lint-comments.mjs` | 退出 **0** |
| A3 | 打包 | `pnpm pack` | `dsh-webcode-bridge-0.15.3.tgz`（285,437 字节） |
| A4 | 发布闸门 | `node scripts/verify-pack.mjs <tgz>` | **28/28 逐字相同** + 接线完好，退出 **0** |
| A5 | 装入真机 profile | `node scripts/install-profiles.mjs <tgz> --profiles web` | web **0.15.3**，退出 **0** |
| A6 | 安装副本逐条核对 | `Select-String` on installed copy | `picked` 在 return 之前（504 < 579）/ `POST status` 别名在位 / `useSessions` 接线在位 / `roster` import 在位 |
| A7 | 推送 | `git push origin main` | `1798bd5..ca1e855`，退出 **0** |

### 仍需重启后确认（离线无法证明）

1. `GET /__webcode/status` → `build.version` = **0.15.3**（当前进程实测仍是 0.15.2，
   `POST` 实测仍是 **405** —— 与「装完不重启不生效」完全一致）。
2. 设置 →「网页桥接」栏目能渲染出各卡片（缺陷 ①）。
3. `subAgentsError` 不再含 `no-session-id`（缺陷 ②③）；空时应显示
   「当前没有正在运行的…」而不是「读不到」。

> **0.14.7 时的基线「305 通过」已过期**。本轮实测 **421**，增量来自三处：
> `accounts`(38) + `accounts-integration`(16) 在 0.14.7 已计入 305；之后新增
> `roster`(真实花名册)、`bench`/`prompt-bench-harness`（基准层）、
> `stall-settle`(15，本轮新增：12 项判据 + 3 项接线护栏)。**台账此前一直没跟上**——这正是「记账未收口」的
> 同一族问题，写在这里以免下次又拿旧数当基线。

## 0.15.2（本轮）—— 修「只出思维链然后卡死」+ LoopX 移除 + 闸门转正

用户原话（逐字）：**「长时间后只有思维链卡住，harness 端，没有任何报错，没有下一步」**。
注意这不是 0.14.0 修过的那一类（那类是「网页早写完了却没送 FINISHED」）。

### 根因：0.14.0 的双条件判据有结构性盲区

0.14.0 的 `shouldSettleWip` 判据是「流停 **且** 页面 DOM 助手消息停止增长」。盲区在于：
**思考阶段网页把「思考中 / Thought for 5s」这类计时文案持续写进同一个助手节点**，
节点 `innerText.length` 因此一直变长 → `lastDomGrowthAt` 被无休止刷新 →
**「DOM 停长」永远不成立** → 收束器永不动作。而看门狗按「最后一个增量」计时，
思考增量同样刷新它，也判不出来。唯一兜底是 240s 总超时，报错还是通用 `web turn timed out`。

一句话教训：**任何依赖「还在动」的判据，都要问一句「这个『动』会不会是假的」**——
计时器在动不是模型在产出内容。

### 修法（三条，缺一不可）

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `lib/metrics.js` `answerDomLength` | DOM 采样改量**剥掉整行计时文案后**的真实回答长度，让「只剩计时器在动」重新等于「DOM 停长」 |
| ② | `lib/metrics.js` `shouldSettleStalledThinking` | **绝对墙钟**判据：自最后一次**正文/图片**起超过 `answerTimeoutMs`（默认 180s）即收束，不看 DOM、不看思考 |
| ③ | `lib/browser-driver.js` `startWipWatch` | 接线：新增 `lastAnswerAt`（**只由正文/图片刷新，思考不刷新**）；`settled_by` 如实区分 `thinking-only-settled` / `partial-wip-settled(dom-timer-only)` / 其余 |

### 顺带修掉的两个真缺陷

1. **`empty response` 抹掉归因**：`lib/index.js` 收尾分支原本无条件
   `assertNonEmpty(out, '', [])` —— 第二个实参写死空串，于是「思考全文都在、正文为空」
   被判成空回复。改成：正文空 + 无调用 + 思考非空 → **不抛错**，交回一条带现场的
   `THINKING_ONLY_NO_ANSWER` 提示（含思考尾部 200 字、收束原因、累计次数），
   与既有 `TOOL_UNKNOWN` 同型，任务因此**继续**而不是整轮作废。
2. **`emitText` 写死下标 0**：工具轮里思考块已用掉 0（`openThink` 从 nextIndex 分配），
   收尾再写 0 会与**已关闭**的 reasoning 块撞下标。`TOOL_UNKNOWN` 与本次新增的
   `THINKING_ONLY_NO_ANSWER` 两条路径都落在这条缝上。已改为显式传 `nextIndex`。

### 可观测

`status()` 新增 `thinkingOnlyTurns`、`lastStalledSettle`（含 `thinkingChars` / `answerChars` /
`waitedMs` / `domTimerOnly`）、`answerTimeoutMs`；`idleScene()` 与 `WEB_NO_PROGRESS`
报错文本同步带上，看门狗超时时能直接读出「只有思考、没有回答」。

### 护栏 `test/stall-settle.test.mjs`（15 项 = 12 判据 + 3 接线）

正向：到上限即收束、上限可配置、计时文案剥完为 0。
**反向安全线（同等重要）**：正文持续产出 → 永不命中（不腰斩长回复）；
上限为 0/非法 → **判据关闭**而不是「立刻收束」；缺 `lastAnswerAt` 基线 → 不收束；
正文里出现「思考中」三个字是内容、不被剥掉。

> 其中「缺基线」那条抓到一个真 bug：`Number(null)` 是 `0` 且 `isFinite(0)` 为真，
> 只判 `isFinite` 会把缺失的时间戳读成「epoch 0」＝「已等一万年」，
> 于是每轮缺字段时第一个 tick 就判死。**这比不修更坏**，已改成同时挡 `<= 0`。

**另有 3 项是接线护栏，与「判据本身对不对」是两回事。** 加它们的原因是复查时
发现的一个真实缺口：0.15.2 最初只在 `browser-driver.js` 加了 `answerTimeoutMs`
的默认值，而 `index.js` 既没在 `DEFAULTS` 声明、也没在 `createBrowserDriver`
时传进去（两处 call site 都漏了）。**行为是对的**——driver 内部默认恰好也是
180s——但**配置层完全够不着它**：任何人想调这个上限都会发现自己改的值没有任何
效果。这类「静默不生效」缺陷不会让任何断言变红，只会让下一次真机排障时少一个旋钮。

接线护栏的判据刻意选「传进去能不能读到」而不是「默认值等于多少」：前者能抓住
「加了配置项但忘了接」这一整类问题，后者只能抓住某一次写错常量。三项分别覆盖
接线存在、缺省回落 180s（而不是 `undefined`——`undefined` 会让判据直接
`return false`，等于这条防线静默消失）、以及 `0` 被保留为「显式关闭」而不是被
`|| 默认值` 吃掉。

### LoopX 整体移除（已完成，2026-09-15）

用户决定舍弃。**本仓库零代码引用**（`package/` 与 `scripts/` 下 `git grep -i loopx` 命中 0），
也**未被任何活动配置引用**（`~/.dsh/settings.yaml`、`.agent-presets/`、`profiles/web/package.json`
三处均无）。因此移除的是仓库外的东西，已按下列清单**全部删除并逐项核对**：

| 项 | 内容 | 体积 |
| --- | --- | --- |
| 运行时本体 | `~/.agents/runtime/dsh-loopx-plugin` | 104.92 MB / 2272 文件 |
| 7 个 skill | `loopx`、`loopx-benchmark`、`loopx-doc-registry`、`loopx-pr-program`、`loopx-pr-review`、`loopx-project`、`loopx-self-repair` | 0.31 MB |
| 3 个锁/安装记录 | `.loopx-skill-install.json`、`.loopx-workflow-skills.lock{,.holder.json}` | ~2 KB |
| **合计** | | **约 105.22 MB** |

**删除后核对**：`skills/` 下 loopx 条目 **0** 个；`runtime/dsh-loopx-plugin` 不存在；
**其余 85 个 skill 目录完好**（证明没有误删）；会话技能目录里 7 个 `loopx*` 技能已消失。

**仓库内保留不动**：
- `doc/progress.md`（本节）、`doc/verify.md`、`scripts/install-profiles.mjs` 里对它的 3 处提及
  已改写成**通用教训**——任何走 GitHub tarball 的依赖都会踩同一条证书坑，
  这条知识比「某个包曾经坏过」更耐用。
- `REPORT.md` 的取证记录保留（它已被 `.gitignore` 排除，属本地私有留痕）。
- **不**给 `.gitignore` 加 `.loopx/`：该目录从未存在于本仓库，加一条空规则是噪音。
  （REPORT 的 C-5 因此关闭为「不适用」，而不是「已修」。）

### 注释闸门转正

`scripts/lint-comments.mjs` 从「非阻断」改为**阻断**，并进 CI 必需检查。关键修法：
原 CS002 按**整行扫源码**，于是 `const MARKER_RE = /\b(TODO|…)\b/;` 这种
**正则字面量**里的 `TODO` 被当成待办注释——一个「查待办注释」的规则在读代码。
改为先用状态机抽出真正的注释文本再判。**并验证了它没变成空壳**：种一条真
`// TODO fix this later` → 确认报错 → 撤回 → 恢复 0。细节见 `doc/ci-cd.md` §4。

### CI/CD 与审查补强

- `ci.yml`：注释闸门删 `continue-on-error`；新增 `scripts/ci-local.mjs --fast` 自检
  （`--fast` 跳过慢的全量单测，净成本约 1 秒，换来两个平台都验证一次本机入口的
  按平台分叉逻辑）；`release.yml` 同步转阻断。
- 新增 `.github/CODEOWNERS`（**须先把 `@owner` 换成真实账号**）。
- `codeql.yml`：加 `paths-ignore`（`reference/**`、产物目录、`.tmp/**`、`*.tgz`）。
- `doc/review-guide.md`：新增「卡死类缺陷的审查要点」——**任何等待/超时/收束逻辑
  必须同时给出绝对上限与反向单测**。
- `doc/ci-cd.md`：§4 改写为转正说明（含 CS002 判据 bug 的完整记录）、§7 必需检查清单更新。

### 文档收口（REPORT C-8）

- `doc/README.md` 表格列错位已修（LoopX 那行已随移除删掉，全表 3 列一致，27 个链接全部可解析）。
- `doc/long-term-issues.md`：补上缺失的 `## 16` 正标题（此前一览表有 15/16/17，
  正文只有 15 和 17，跳号会让人以为这条被删了）。
- `PLAN.md:3` 版本头 `0.14.5` → `0.15.2`。

### git 收口（REPORT A-3）

工作树此前积压了大量未提交改动（REPORT A-3 记录的「阶段 A-6 只做了一半」）。
本次按主题分成 **5 个提交**收口，每个提交都能单独看懂、单独回滚：

| 提交 | 主题 |
| --- | --- |
| `e92db16` | `fix(stall)`：只出思维链卡死的第三条防线（本轮核心） |
| `df2f194` | `test+ci`：注释闸门转阻断，CI/CD 与审查补强 |
| `ecd3e31` | `feat(bench+roster)`：提示词基准层与真实花名册 |
| `cec55fe` | `feat(tooling)`：会话日志解析器与泄漏检测盲区修复 |
| `3fbfdce` | `fix(protocol)`：协议原文不再被持久化进助手正文 |

**REPORT A-3 点名的两项均已裁决**：

1. `scripts/session-read.mjs`（用户明确要求的交付）—— 已入库，见 `cec55fe`。
2. `bench-out.txt`（OOM 留痕）—— **裁决为不入库**。它是「每次跑都可能变」的产物，
   而真正的证据（约 4GB 堆耗尽、669849ms）已逐字写进 `lib/bench.js` 的注释；
   同时把 `bench.js` 里对它的**文件引用摘掉**——注释指向一个读者手上没有的文件，
   比没有引用更坏。已加 `.gitignore` 规则。

**新发现并如实记录（不掩盖）**：加 `*.tgz` 规则时发现**历史上有 56 个 tgz
已被跟踪**（共 5.55 MB）。gitignore 对已跟踪文件无效，所以这条规则只挡新文件。
本次**刻意不删**历史 tgz：`doc/ci-cd.md` §6.2 的回滚步骤明确依赖它们
（「回滚：装回上一个版本的 tgz（package\ 下存着历史版本）」），删掉会让那条文档失效。
现状是**有意为之**，理由已写进 `.gitignore` 注释——包括「若将来清理，必须
`git rm --cached` 与改写回滚文档一起做」。

## 0.14.7（已发布 / 已装）—— 同站多账户

## 0.14.6（已发布 / 已装 / 已验证）

**0.14.6 = 0.14.5 的全部内容 + `<call>` / `</call_call>` 残片修复。**

为什么要多一个版本号（发布纪律，不是洁癖）：`0.14.5.tgz` **已经打过**且内容不同，
同名同版本换内容会被 pnpm 按版本号去重而静默不更新（0.13.0 踩过这个坑）。
因此把「0.14.5 + 残片修复」合并发布为 **0.14.6** —— 用户仍然**只需重启一次**。

### 修了什么

`lib/agent-preset.js`：

1. `PROTOCOL_ANCHORS[0]` 候选集加 `call_call|call`（**只进锚点，不进 transport**）。
2. `partialProtocolAt` 前缀表补 `<call` / `<call_call`（流式半成品防线）。

`test-mock/parse-session-log.mjs`：

3. `detectProtocolLeak` **同步扩集**——检测器与被保护的正则共享盲区时，
   「日志没有泄漏告警」是**假阴性**。

`test/protocol-leak.test.mjs`：新增 4 项（残片是锚点 / 残片永不 transport /
残片不吞前面的散文 / `<calling>` 不是锚点），**15 项全绿**。

### 验证

- 全部测试文件 **26/26 通过**，`run-m1.js` **M1 PASS**。
- `verify-pack`：**24/25 逐字相同**，唯一差异是 `package.json` 被 pnpm 规范化掉
  `packageManager` 字段——已逐字段 diff 证明**其余字段零差异**（`field diffs: 0`，
  只有 `tree-only keys: ["packageManager"]`）。
- 两个 profile 均装 **0.14.6**，四个改动标记逐一核对在位：
  `call_call` 在锚点 ✓、`'<call'` 在前缀表 ✓、`PROMPT_WRITE_STALLED` ✓。
- 回滚备份：`profiles/web/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml}.bak-2026-09-14-addplugins`。

### 重启后核对点（2026-09-14 晚间已逐条实测通过）

| # | 核对点 | 实测结果 |
| --- | --- | --- |
| 1 | `build.version` 应为 0.14.6、`hash` 变化 | ✔ `build.version=0.14.6`、`build.hash=f6837b9a8cf1`；进程 PID 22184，启动 19:36:21 |
| 2 | 不再出现 `</call>` / `<call_call>` 残片 | ✔ 两个 profile 的 `agent-preset.js` 均含 `call_call|calls|call` 锚点与 `<call`/`<call_call` 前缀表；`protocol-leak` **15/15** 通过 |
| 3 | composer 分块写入生效，不再 30s `locator.fill` 超时 | ✔ 本会话即由桥接驱动，`lastEndReason=finished`、`lastRate.responseMs=952`；`--recent 3` 无 `locator.fill` 超时 |

**新增正面证据（0.14.6 之前没有的）**：`node test-mock/parse-session-log.mjs --recent 3 --errors-only`
在 `session-ec60921d` / `session-abaa2740` 上**零 `protocol-leak` 命中**；
而修复前的 `session-b01554c3` 有 4 处命中（`</call>` @106/@103、`</call_call>` @68/@75）。

**同时发现一个新族（未归因，已入账）**：`session-ec60921d` 有一条
`tool/result isError: invalid arguments: missing required property "command"` ——
与 composer 无关，属工具调用参数缺失族，记入 `bridge-failure-ledger.md` 与
`long-term-issues.md` 第 17 条。

## 本轮（0.14.5）已完成

- **会话日志解析工具** `test-mock/parse-session-log.mjs`：按 zstd magic 切多帧
  （单帧解压只得 220 字节，这个坑上一轮踩了三次）。
- **归因**：错误码 × 已做适配 × 残留风险的对照表见 `doc/bridge-failure-ledger.md`
  （原先这里指向 `session-log-review.md`，那份已按用户指示于 2026-09-16 删除）。
- **P0 修复**：composer 分块写入 + `PROMPT_WRITE_STALLED`。真机证据是 80 万字符
  一次性 `fill` 导致 30s 超时；决策抽成纯函数 `composerWritePlan` / `stallStep`。
  护栏 `test/composer-write.test.mjs` 12 项。
- **P1 修复**：`<tool_result>` 加进协议边界锚点（但**不**加进 transport 判定）。
  护栏 `test/protocol-leak.test.mjs` +2 项。

## 0.14.7（已发布 / 已装 / 等重启生效）—— 同站多账户

用户明确「team 最后实现，优先解决前面问题」。0.14.6 收口后本轮做的是**同站多账户**。

### 数据模型（`lib/accounts.js`，纯函数身份层）

| 概念 | 0.14.6 | 0.14.7 |
| --- | --- | --- |
| 账户槽 id | 不存在 | `<siteId>#<slot>`；**默认槽仍是 `<siteId>`**（`#1` 是其别名） |
| profile 目录 | `<profileDir>/sites/<siteId>` | 默认槽**逐字不变**；非默认槽 `<profileDir>/sites/<siteId>/<slot>` |
| 模型 id | `site:model` | `site@slot:model`；`site:model` 与全部历史别名照旧解析到默认槽 |
| 显示名 | `站点短键/模型id` | 非默认槽追加 `(账户N)`；**默认槽不加**（既有断言原样通过） |
| 发送间隔 | 设置级单值 | **槽级**（`sendGapMsBySlot`），回落链 槽 → 站点键 → 全局 |
| 设置字段 | — | `accounts: []`（**默认空 = 行为与 0.14.6 完全一致**）、`sendGapMsBySlot: {}` |

### 落地的文件

- **新增** `lib/accounts.js`：`parseAccountKey` / `formatAccountKey` / `formatModelId` /
  `parseModelId` / `slotProfileDir` / `accountLabel` / `normalizeAccounts` / `slotsForSite` /
  `sendGapForSlot`（与 `composerWritePlan` 同纪律：决策抽纯函数，调用方只做 IO）。
- `lib/providers.js`：`listAllModels(accounts)` 展开槽；`resolveWebModel` 支持 `@slot`；
  默认槽的 id / 显示名 / `accountKey` 与 0.14.6 **逐字相同**。
- `lib/browser-driver.js`：接受 `slot`，日志前缀带槽（`[webcode-driver:glm#2]`），status 透出 `slot`/`accountKey`。
- `lib/index.js`：`driverFor(accountKey)` 按槽建独立驱动与独立 profileDir；发送间隔按槽计时；
  `buildTurn` 的 meta 带 `slot`/`accountKey`；`driverStatus` 按槽展开（含未初始化槽）。
- `lib/web-control.js`：`login`/`verify-login`/`window`/`session-import`/`connect` 全部按 accountKey 路由；
  `login-sites` 合并「全站点默认槽 + 已配置非默认槽」；`settings` 写入前归一化 `accounts`/`sendGapMsBySlot`。
- `lib/client.cjs`：`SiteAccounts` 按 `accountKey` 索引——**两个账户两行，互不覆盖**。

### 顺带修掉的一个真 bug

`resolveWebModel` 首版只处理 `slot !== default` 的分支，导致 `glm@1:glm-5.3`
（`1` 是默认槽别名）掉进 `split(':')` 兜底、被切成站点 `glm@1` → 报「不支持的网页模型」。
账户1 本该与默认槽完全等价。已改为**连同默认槽一起交给 `parseModelId`**，并有专门护栏。

### 验证

- `npm test`：**305 通过 / 0 失败**，`run-m1.js` **M1 PASS**。
- `accounts.test.mjs` 38 项（纯函数全形态）+ `accounts-integration.test.mjs` 16 项
  （默认槽零位移 / 两槽不串 / 槽级间隔接缝）。
- `verify-pack`：26 项中 25 项逐字相同，唯一差异是 `package.json` 被 pnpm 规范化掉
  `packageManager`（逐字段 diff 确认 **field diffs: 1**，且版本一致 0.14.7）。
- 双 profile 安装标记逐一核对：`accounts.js` 在位、`normalizeSlot`（driver）、
  `listAllModels(accounts`（providers）、`accountKeyOf`（web-control）、`displayName`（client）、
  `formatModelId`（index）全部 `True`。
- 回滚备份：`profiles/{web,headless}/*.bak-2026-09-14-accounts`。

### 重启后要核对的三点

1. `/__webcode/status` 的 `build.version` = **0.14.7**。
2. 设置页「账户与登录管理」每个站点一行；配置 `accounts` 后**同一站点出现两行**
   （`智谱清言 (GLM)` 与 `智谱清言 (GLM) (账户2)`），两行状态互不覆盖。
3. 未配置 `accounts` 时行为与 0.14.6 完全一致（默认槽零位移）。

## 下一阶段（0.14.8 Team 面板）

官方三个 `@deepseek-ai/dsh-experimental-*` 包**已装**（web profile，全部 `0.1.5-rc.1`），
但它们的 `package.json` 里**没有 `dsh.client` 入口**（只有 profile 包有 `bundle.patch`）——
即**官方 Team 面板的 client 侧不在已发布 tarball 里**，不能照抄。

因此路线是：服务端复用官方 `agentTeams` Remote method（`view`/`createTask`/`updateTask`），
本项目自建右栏只读面板（roster 五态 + 任务板），沿用官方九个工具名与语义。
**必须显式声明**：单进程共享 checkout，并行的是会话与呈现，不是文件系统。

## 已装入 web profile 的两个新插件（2026-09-14，重启已生效）

| 插件 | 版本 | 状态 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.1.5-rc.1 | 已装，bundle 层已注册 |
| （其依赖）`@deepseek-ai/dsh-experimental-agent-team` | 0.1.5-rc.1 | 已装（**必须钉 rc.1**，见教程 §2） |
| （其依赖）`@deepseek-ai/dsh-experimental-tool-agent-team` | 0.1.5-rc.1 | 已装 |
| `dsh-local-link` | 1.1.1 | 已装，bundle 层已注册 |

- 四个包安装副本与 tarball 逐文件 SHA256：`8/8`、`43/43`、`7/7`、`22/22` **零差异**。
- `dsh --profile web --dump-config` 已确认两个新层存在，原有 11 个 bundle 一个不少。
- 教程：[agent-teams](tutorial-agent-teams.md) / [phone-access](tutorial-phone-access.md)。
- **重启后要做的两件**（状态更新）：① 侧栏出现 `Local access` —— 用户已确认**二维码没问题**，本条关闭；
  ② 对 Lead 说「创建一个名为 reviewer 的 teammate 检查 diff」确认 9 个 Team 工具已注册 —— **待做**，属阶段 C。

## 本轮（2026-09-14 下午）新增结论

### 二维码「找不到」已定位（后端正常，前端触发点隐蔽）

- 实测 **3088 端口在监听**（`OwningProcess=36232`，与 3080 **同一个 node 进程**），
  `POST http://127.0.0.1:3080/__dsh-local-link/admin/pairing` 返回 **201**，
  body 里带 `qrDataUrl`（base64 PNG）与一次性 `url`。**后端完全正常。**
- 前端入口注册在 DSH 官方侧栏槽位 **`sidebar.footer.action`**（id `local-link-connect`，`order: -10`），
  渲染在侧栏 **footArea**（`sidebar.settings` 之上）。
- **两个「找不到」的原因**：① 文字标签只在**侧栏展开时**渲染
  （`wide && <span>{t(\"footer.trigger\")}</span>`）——折叠时只剩一个图标；
  ② 该入口与 `settings.section` 的 `Local access` 分区都受 `desktopOrigin()` 约束
  （hostname 必须是 `localhost`/`127.0.0.1`/`::1`），用局域网 IP 打开桌面页时**两者都隐藏**。
- 已写进 `doc/tutorial-phone-access.md` **§3.5「二维码到底在哪」**（含验证命令与诊断读法）。

### 卡住的直接根因：0.14.5 未装（**已由 0.14.6 解决**，见上方「重启后核对点」）

`session-c710ef6e` turn 2 终局逐字：

```
turn/end reason = {\"kind\":\"error\",\"error\":{\"message\":\"locator.fill: Timeout 30000ms exceeded…\"}}
```

这正是 0.14.5 修的 P0（80 万字符一次性 `fill()`）。当时运行的 0.14.4 上**必然**复现。
→ 已通过发布并安装 **0.14.6** 解决；重启后实测 `lastEndReason=finished`、无 `locator.fill` 超时。

### `<call>` / `</call_call>` 残片漏进正文（**已在 0.14.6 修复并验证**）

`lib/agent-preset.js` 的 `PROTOCOL_ANCHORS[0]` 候选集**不含 `call` 与 `call_call`**，
于是 `findProtocolStart` 返回 -1，残片被当正文外发并持久化。
真机证据 13 处（`session-698700ea` seq=91/119/179/289/326/569/779）。
**且 `detectProtocolLeak` 共享同一盲区** → 日志不告警是假阴性。
0.14.6 已把锚点、前缀表、检测器三处同步扩集（`doc/long-term-issues.md` 第 15 条），护栏 **15/15 通过**。

### 本轮零真机探针

全部结论来自**离线会话日志 + 已装包源码**。风控纪律（间隔 ≥20s、最多 3 次、
风控页 ≠ 未登录）不变；同站多账户会成倍放大风控风险，实现时须每槽独立限流、
探针串行化、默认不并发探测。

## 已知环境约束（不要重新踩）

- **`spawnSync` 从 Node 里调用任何外部程序都会 `EPERM`**（2026-09-16 实测，Node v24.18.0）。
  实测四种写法**全部** `status=null, error.code='EPERM'`：`spawnSync('git',…)`、
  `spawnSync('node',…)`、`spawnSync('cmd',…)`、以及**写绝对路径**的
  `spawnSync('C:\\Program Files\\Git\\cmd\\git.exe',…)`。而同一台机器上 pwsh 直接跑
  `git rev-parse` 正常返回 —— 即这是**Node 子进程创建被沙箱挡住**，不是 git 没装。
  **两个真实后果，必须知道**：
  1. `test-mock/artifacts-check.mjs` 会走它的「不在 git 工作树内 → SKIP → exit 0」分支。
     它**打印的是 SKIP 而不是 PASS**（这一点写得对，没有假装通过），但在本机它
     **等于一条空转护栏**——本次 `output/` 规则的修复就是靠手跑 `git check-ignore` 验证的，
     不能指望这条闸门。CI 上 git 可用，闸门是真的。
  2. `scripts/ci-local.mjs` 的**全部四步**都经 `spawnSync` 启动，因此在本机**四步都不会真的跑**。
     本机复核必须逐条手跑命令（本次 38 个测试文件就是这么跑的）。
  > 这一条与既有的「`node --test` glob 在本机 `spawn EPERM`」是**同一个根因**，
  > 此前只被记成「glob 不支持」这一局部现象，覆盖面被低估了。
- `pnpm install` 曾因一个**无关依赖**（走 GitHub release tarball 的包）证书校验失败
  （`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）而整体失败 → 安装走手动解包
  （`scripts/install-profiles.mjs`）。**这是通用约束**：依赖树里只要还有任何一个包从
  GitHub tarball 拉，这条路径就会再踩一次。可用的绕过是 `$env:NODE_OPTIONS='--use-system-ca'`
  （Node 24+ 用系统证书库），见 `doc/verify.md`。
  > 0.15.2：那个具体依赖（LoopX 插件）已被用户决定整体舍弃，本仓库不再引用它；
  > 上面这条作为**通用教训**保留。
- git 远端 HTTPS 证书校验失败 → 推送/拉取用 `GIT_SSL_NO_VERIFY=1`（仅本机网络问题的
  绕过，不改全局 git 配置）。
- **反复深链同一会话地址会触发站点风控**（0.14.3 事故）：探针要节制，间隔 ≥20s、
  最多 3 次；风控页 ≠ 未登录。
- 真机长跑用 `WEBCODE_PROFILE_DIR` 覆盖，与正在运行的 DSH 隔离。

## 真机验收矩阵

见 `doc/verify.md`。本轮新增待验项：

- composer 分块写入在真机上不再出现 30s `locator.fill` 超时（或失败时给出
  `PROMPT_WRITE_STALLED` 与已写进度）。
- 右栏新布局在重启 DSH 后目视核对官方尺寸。
