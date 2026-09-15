# 进度台账（进仓库）

**为什么这个文件存在**：2026-09-14 的会话在收尾前被中断，而它的进度只写在
`PLAN*.md`（本地私有留痕、不在仓库），导致下一次会话必须从头 recon 一遍。

`doc/README.md` 已经规定了「根目录 `PLAN*.md` 是本地私有留痕」——那条约定是对的，
缺的是它的**对偶**：仓库里必须有一份「当前走到哪、下一步是什么」的台账。这就是本文件。

约定：

- 每完成一项即更新这里；跨会话恢复以本文件 + `PLAN.md` 为准，不依赖会话记忆。
- 与 `session-log-review.md` 分工：那份是**归因**（为什么失败），这份是**状态**（现在在哪）。

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 工作树版本 | **0.15.2**（已打包 / 已装 / 等重启生效） |
| 已装版本（web / headless） | **0.15.2**（已装，**运行中的进程仍是旧的**——需要一次重启） |
| 上游 | `origin/main` = `e190257`（本地领先，未推送） |
| 单测基线 | **418 通过 / 0 失败**（`node --test "test/*.test.mjs"`，`duration_ms ≈ 567000`） |
| 注释闸门 | **error 0 / warn 0，退出码 0**（已转**阻断**，进 CI 必需检查） |
| 下一阶段 | 真机验证（用户重启后） |

> **0.14.7 时的基线「305 通过」已过期**。本轮实测 **418**，增量来自三处：
> `accounts`(38) + `accounts-integration`(16) 在 0.14.7 已计入 305；之后新增
> `roster`(真实花名册)、`bench`/`prompt-bench-harness`（基准层）、
> `stall-settle`(12，本轮新增)。**台账此前一直没跟上**——这正是「记账未收口」的
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

### 护栏 `test/stall-settle.test.mjs`（12 项）

正向：到上限即收束、上限可配置、计时文案剥完为 0。
**反向安全线（同等重要）**：正文持续产出 → 永不命中（不腰斩长回复）；
上限为 0/非法 → **判据关闭**而不是「立刻收束」；缺 `lastAnswerAt` 基线 → 不收束；
正文里出现「思考中」三个字是内容、不被剥掉。

> 其中「缺基线」那条抓到一个真 bug：`Number(null)` 是 `0` 且 `isFinite(0)` 为真，
> 只判 `isFinite` 会把缺失的时间戳读成「epoch 0」＝「已等一万年」，
> 于是每轮缺字段时第一个 tick 就判死。**这比不修更坏**，已改成同时挡 `<= 0`。

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
- **归因报告** `doc/session-log-review.md`：最近两次会话的失败点、归因、复现命令。
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
