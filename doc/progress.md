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
| 工作树版本 | **0.16.21** |
| 已装版本（profile） | **0.16.21**（2026-09-19 实测：web + headless 两处声明一致指向 `dsh-webcode-bridge-0.16.21.tgz`，`node_modules` 内 `package.json` = 0.16.21 且 `lib/client.cjs` 含本版 token 与 page 契约；`dsh plugin add` 声明持久层通道） |
| 运行中的进程 | run-8 真机验收以 `dsh --profile headless` 进程级验证（0.16.16 时段）；DSH web（3080）2026-09-19 凌晨未运行 |
| 上游 | `origin/main` = `9d4c61a`（0.16.10 台账推送）；0.16.11–0.16.21 本地已提交/待推 |
| 单测基线 | **67/67 测试文件**；全量 **784 条**（0.16.20 为 782；0.16.21：`client-render` 新增 2 条样式契约——等待药丸 content-font token、左栏任务板官方 page 契约） |
| 注释闸门 | **error 0 / warn 0，退出码 0**（2026-09-19 实跑） |
| 文件规范闸门 | `check-repo-hygiene.mjs` **PASS**（无 BOM + 索引无死链 + CI/engines Node 版本相容） |
| 发布闸门 | `verify-pack` 逐文件 sha256 相同 + 接线完好，退出 0（0.16.16 实跑 37/37） |
| 记账闸门 | `check-ledger.mjs` **PASS**（version 0.16.21 / testFiles 67/67） |
| 已装包核对 | 0.16.21 已装机核对（见已装版本行） |
| 下一阶段 | **0.16.21 需重启 DSH 后生效**；第三步（站点选择框 + 官方矢量品牌图标）只出调研结论，见 [doc/brand-icons-research.md](brand-icons-research.md) |

> **§0.16.10 真机判据（重启后逐条核）**：① `GET /__webcode/status` 的 `build.version` = **0.16.10**；
> ② 让模型回复一段含 `<b>`、`<foo>`、`Array<T>` 或字面 `<tool_call>` 示例的正文，**逐字对比** harness
> 收到的块内容与网页端原文——0.16.9 及以前会静默少掉那个 `<`。

> **⚠ 台账更正（2026-09-19）**：本表此前一行写着「已装版本（profile）**0.16.7**（web + headless
> 两个 profile 的 `package.json` 实测均为 0.16.7）」与「运行中的进程 **0.16.7**」。**这两条对 `web`
> 是错的**：审计实测 web profile 当时是 **0.16.5**（`lib/index.js` sha256 `14A87102DAFB…`），
> 只有 headless 是 0.16.7（`C9D096EBF8AB…`）。台账把两个 profile 混成了一句，于是「已装 0.16.7」
> 掩盖了「web 落后两个版本」这个真因，直接导致用户按台账以为装好了、重启后仍然不变。
> **教训记在这里而不是删掉**：凡是「已装/已重启/已验证」这类状态行，**必须逐 profile 写、并附
> sha256 前 12 位**，否则它会把「一个 profile 装了」读成「都装了」。 |

## 0.16.19（2026-09-19）—— run-9 占位符照抄事故：教学示例改真实工具名 + 围栏示例守卫 + TOOL_UNKNOWN 自动再教学

**用户指令（逐字）**：「？？？你提示词还没有改啊！我想要出现这个时候自动返回提示词！好让会话继续！」

### 一、run-9 取证（0.16.18 验收轮，`session-897d07bb`，reply-log 逐字）

用户问「官方怎么做」，模型回答时把 0.16.18 教学骨架**原样抄进 ``` 代码块**举例
（骨架占位名是「工具名 / 工具名二」），桥把围栏里的占位名当真执行 → 2 次
TOOL_UNKNOWN。模型下一轮自己道破：「占位符不是调用，只有真实工具名才会执行」，
并学会用 `_` 代替 ▁ 自保——教学缺陷与解析缺陷各占一半。

### 二、修了什么

| 改动 | 落点 | 说明 |
| --- | --- | --- |
| 教学示例改**真实工具名** | `officialCallExampleFor(tools)` / `officialToolCallSkeletonFor(tools)`；buildPreset、serializeFirstTurn transport、trainNoteFor（新增第三参 tools，三个调用方都传入） | 示例名+参数样例取自会话工具表（required 优先，number→1/boolean→false/array→[]/其余→"…"）；占位符只在无工具表的纯测试场景兜底 |
| **围栏示例守卫** | `parseAgentReply` invoke 扫描 | 已配对 ``` 区内的 invoke 一律视为示例不执行（真机逐字夹具 `official-echo-1-run9-fenced-template.txt` → 0 calls）；未配对 ``` 保守不守卫（宁可执行示例也不吞真调用）；参数值内嵌 ``` 的 write（fence-nested-call 家族）不受影响——判据只看 invoke 起点 |
| **TOOL_UNKNOWN 自动再教学** | `lib/index.js` | 通知自动附官方模板示例（真实工具名）+ 点名「骨架占位符/文档示例不是调用」——用户要求「出现时自动返回提示词，好让会话继续」；UNPARSED 重发指引同步改真实工具名 |

### 三、护栏

`test/official-tool-calls.test.mjs` 9 条（新增 run-9 围栏夹具 0 calls、骨架真名、
未配对围栏边界、参数内嵌围栏不受影响）；全量 774 条绿。

### 四、装机与验收（用户执行）

打包装机流程同前；验收判据：① 再问「官方怎么做」类问题不再触发 TOOL_UNKNOWN；
② 万一触发，通知自动带正确格式示例、会话继续；③ reply-log 全文照常落盘。

## 0.16.18（2026-09-19）—— 教学切官方 tool-call 训练模板（DSML 转备案），无参调用修复

**用户指令（逐字）**：「战略实验：把教学格式换成/并测 DeepSeek 官方训练先验的 tool-call 模板
（<｜tool calls begin｜> 家族），可能从根上止血——直接改复刻！这个保留成备案不删除
只是现在新增官方做法优先」

### 一、官方模板逐字依据（不是推测）

HF `deepseek-ai/DeepSeek-V3.1` tokenizer_config.json 的 chat_template（2026-09-19 核对）：
`<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>NAME<｜tool▁sep｜>{ARGS}<｜tool▁call▁end｜>…<｜tool▁calls▁end｜>`
（连接符 U+2581 ▁、竖线 U+FF5C）。这是模型**被训练时见过的形状**；0.16.2 起教的 DSML
在官方仓库 grep 全库 **0 命中**——模型对它无先验，长跑必然持续漂移。

### 二、修了什么（DSML 全套宽容一字不动，教学改指官方形状）

| 改动 | 落点 | 说明 |
| --- | --- | --- |
| 官方模板常量与示例（`officialToolCallSpecimen/Skeleton`） | `lib/agent-preset.js` | 教学与 UNPARSED 重发指引共用一份 |
| 官方 → 规范 invoke 形改写 | `normalizeDsml` 首步 | 全调用段收编 + 孤立 calls 包裹映射；旧代空格词形、`function` 前缀、```json 围栏漂移都收；恢复层/流式探测三层受益 |
| 协议锚点 + 流式前缀补官方家族 | `PROTOCOL_ANCHORS`、`partialProtocolAt` | 红基线：0.16.17 代码对官方模板 0 calls 且 proseSafeEnd=全长（整段漏正文）——锚点是先决条件 |
| **无参调用不再整条丢弃** | 主解析 takeObj 条件 | run-8 FAIL#3/4/5 真机逐字形状（cordis_inspect_list，properties:{}）连续 3 次被丢；收紧条件=名字非空 + 非包装壳 + 体为空/完整 JSON |
| deepseek 站点三处教学同形状 | buildPreset / serializeFirstTurn transport / TRAIN_NOTE | DSML 教学文本全部退役（git 历史留档），解析备案保留 |

### 三、护栏（`test/official-tool-calls.test.mjs` 7 条全绿）

官方单调用/多调用/旧词形+前缀+围栏/无参两种形态/教学骨架自洽/DSML 备案不回归/
两种格式同轮混写；`glm-session-replay` 的 deepseek 三格断言同步切官方。

### 四、装机与真机验收（用户执行）

- 打包 `dsh-webcode-bridge-0.16.18.tgz`（verify-pack 39/39），走 `dsh plugin add`
  声明持久层通道装 web + headless；逐 profile 核对三处声明 + sha256。
- **验收判据（战略实验）**：同任务重跑，对比「UNPARSED/isError 次数」与 0.16.15–0.16.17
  轮（每轮 4–9 条）——官方模板下漂移族应显著下降；`~/.dsh/logs/webcode-bridge-replies.log`
  照常全文落盘，模型若仍回退 DSML 备案形状，逐字夹具继续反哺。

## 0.16.17（2026-09-19）—— 网页原始回复全文落盘：取证断链第三次后的补链

**用户指令（逐字）**：「刚才这个又是怎么回事》？有无保留原接收内容日志？没有请你新增」

### 一、run-8 取证（0.16.16 真机验收，`session-0fd32761`，04:08–04:56）

99 次调用、2 isError、**4 次 TOOL_CALL_UNPARSED（扣留 693/1003/1470/1474 字符，
四种形状全部不同）**、0 恢复派发：

| 时间 | 扣留量 | 头 200 字符可见的形状 |
| --- | --- | --- |
| 04:24:01 | 693 | 读 `dsh-client-ui-conversation` 类型文件；畸形在 200 字符之外 |
| 04:27:24 | 1003 | `client.cjs` 参数正常闭合、下一参数开标签正常起头；畸形在 200 之外 |
| 04:28:08 | 1470 | `<invoke>` 后出现 `parameter name="pwsh">`（参数名写成工具名）再接 `command` |
| 04:56:28 | 1474 | edit 调用：`file_path` 完全正常，其后 `<｜ olds_string`——简写漂移（夹具 15 同族）**且参数名拼错**、old_string 值是含 `<` 的代码（0.16.12 改写的安全线「值内不得再出现 `<`」在此拒绝改写） |

2 条 isError 均 `missing required property "file_path"`（read 只带 limit/offset）——
`TOOL_ARGS_MISSING_REQUIRED` 同族在 0.16.16 后仍以新形状复现。

### 二、根因（运维侧，不是解析侧）

**四种形状的 1474/1470/1003/693 字符全文在磁盘上都不存在**。0.16.13 的
「扣留全文进日志」走 `console.warn`（lib/index.js `warn`）→ DSH 进程 stderr →
运行时不持久化。会话存档只有提示里那 200 字符头。归因第三次断链
（15/16 只存头 200 → 19/20 靠残片重构 → run-8 连重构依据都没有）。

### 三、修法（`lib/reply-log.js` + `lib/index.js` 接线）

- 每轮收尾（`parseAgentReply` 之后、分支之前）把**原始回复全文**（未归一化、未截断）
  追加到 `~/.dsh/logs/webcode-bridge-replies.log`：头行定界 + 时间/会话/字符数/调用数，
  尾行定界；超 10 MB 轮转一代 `.1`；
- 写失败静默返回 null，绝不影响回合；测试进程（`NODE_TEST_CONTEXT`）守卫：
  不写真实目录（`glm-session-replay`/`empty-response` 等真接线测试不再污染），
  环境变量 `WEBCODE_REPLY_LOG_DIR` 可重定向；
- 0.16.13 的 stderr 全文打印降级为指路（打印日志文件路径）；
- **接线真实验证**：`WEBCODE_REPLY_LOG_DIR=$(mktemp -d) node --test test/empty-response.test.mjs`
  产出真实日志记录（头行 + 原文 + 尾行）——桩驱动测试绕不过文件系统，这不算
  「无自动化红线的接线披露」。

### 四、下一版怎么用这份日志

run-8 的四种形状重跑复现后，从 `webcode-bridge-replies.log` 按 session 与时间定位
原文，逐字入夹具（15–20 的同一纪律），再谈改写规则——不再有「全文未落盘」这一步。

## 0.16.16（2026-09-19）—— 闭/开参数标记「熔接」宽容：run-7 isError 7 条的根因收口

**用户指令（逐字）**：「方向是给 normalizeDsml 增加对『</ parameter name=…> 闭开熔接形』的改写规则！
然后我需要你通过校验！打包安装……我只需要你跑通测试，快速解决根问题，我来跑真机验证！」

### 一、取证（会话存档逐字节，见 `doc/diagnosis-2026-09-19.md` 后续补记）

长跑第 7 轮（0.16.15，`session-755c156a` 主会话 + 6 个派生子代理）的子代理会话里共 9 条
`tool/result isError`，主会话 0 条（台账 §二第 7 轮只记了主会话）。三族：

| 族 | 会话 | 条数 | 现象 |
| --- | --- | --- | --- |
| 熔接形 | `6541b055` / `489b0093` | 4+1 | `path`/`file_path` 值尾粘着 `</ parameter name="X" string="Y">` 残片 → pattern/limit 参数丢失 → `missing required property "pattern"` ×4、`cannot read … not found` ×1；`6541b055` 连续 4 次写出同形 |
| 残片入参值 | `755c156a` | 2 | `file_path` 值内部被写进 `｜｜DSML｜｜`（`task-split.js｜｜DSML｜｜`）→ not found |
| 策略正确拒绝 | `6541b055` | 2 | 子代理（`provider: spawn`）自己再调 subagent → `depth 2 exceeds maxDepth 1`，**不是缺陷** |

### 二、修法（最小改动一处）

`normalizeDsml` 末尾（简写宽容之后、裸开标记之前）新增一条：`</ parameter name="X"[属性]>` →
`</parameter><parameter name="X">`。保守判据：**闭标签带 name 属性**在合法 DSML 与合法 XML 里
都不存在；无 name 属性的闭标签（`</parameter>`、`</ parameter>`）不在匹配内，夹具 15 的既有
安全线断言逐字不变。

**红基线**：夹具 19/20 在 0.16.15 代码上解析出的污染值与真机 `tool/call` 存档**逐字相同**
（path 值尾残片、file_path 值尾残片 + offset 存活），这是「外层骨架重构」口径成立的证据——
见 `test/dsml-real-drift-2026-09-19.test.mjs` 头注释。

### 三、护栏（全绿）

- `test/dsml-real-drift-2026-09-19.test.mjs` +2：夹具 19（grep 双参干净）、20（read 三参干净，
  limit 回归）；19/20 的取法口径（原始网页回复未落盘、残片逐字、骨架按夹具 15 同款风格重构）
  写在文件头；
- `test/dsml-param-shorthand.test.mjs` +5：熔接改写正向 ×2、反向安全线 ×3（无 name 属性闭标签
  不动、开标签 `string=` 原生属性不动 + 补壳行为不变、非 parameter 闭壳不动）。

### 四、装机与真机验收（用户执行）

- 打包 `dsh-webcode-bridge-0.16.16.tgz`（`verify-pack` 37/37 逐字相同 + 接线完好），
  走声明持久层通道 `dsh plugin --profile <name> add` 装 web + headless 两个 profile；
  装后逐 profile 核对三处声明一致 + `lib/index.js` sha256 前 12 位 `4B3C10D9C594`（已核，见当前状态表）。
- **验收判据**：同任务重跑（含子代理派发的审计类任务），① 无 `missing required property` 类
  isError；② 无 `cannot read` 类因参数污染产生的 not found；③ `｜｜DSML｜｜` 残片入参值形
  （本版**未修**，见残留风险）若复发出现在 `tool/call` args 里，如实记录——按保守原则桥不剥
  参数值内部的标记。

## 0.16.11–0.16.15（2026-09-19 本轮）—— 长跑会话阻断点修复与真机连续验证


**用户指令（逐字）**：「把我提到的这些写入doc/，然后开始修复长跑会话问题，真机实际长时间
会话验证（30分钟+50轮无外部提醒工具调用+最佳工程提示词）」「然后等我验收，版本号保持0.16.x」
「其他不要动」；执行中追加：「1.注意写好你实时调试记录 2.请你将每次真实调用失误原文记录好！
看原有已记录的工具调用失败文档！」；收尾指令：「就这样先，直接打包按照做好记录和文档，提交git」。

实时调试日志（逐时间线）：`.tmp/debug-log-longrun-2026-09-19.md`（工作区暂存，持久事实以本节为准）。
取证底稿：`doc/diagnosis-2026-09-19.md`；缺陷条目：#25 / #26（`long-term-issues.md`）。

### 一、修了什么（六类，全部最小改动，逐项有护栏+反向验证）

| 版本 | 缺陷/改动 | 落点 | 反向验证 |
| --- | --- | --- | --- |
| 0.16.11 | #26：思考-only 轮 `empty response` 硬失败 → 纯函数 `emptyWebResponseError`（全空才判空+报错带现场） | `lib/zero-progress.js`、`lib/browser-driver.js` | 纯函数红基线=实现前；**驱动接线 2 行无自动化红线（桩驱动绕过真驱动），如实披露** |
| 0.16.11 | #25：UNPARSED 提示带被扣原文头（≤200 字符） | `lib/index.js` | 摘掉 head 实参 ⇒ 2/2 红 → 恢复 ⇒ 绿 |
| 0.16.11 | PROMPT_TRUNCATED 无退路 → fresh 首轮按 accepted−2KB 自动压缩重试一次（`maxPromptChars` 丢最旧段+显式标记）；增量轮不重试 | `lib/browser-driver.js`、`lib/index.js`、`lib/agent-preset.js` | 分支错误码改失配 ⇒ 端到端红 → 恢复 ⇒ 绿 |
| 0.16.12 | run-2 简写参数漂移（`｜｜DSML｜｜ file_path="…`）→ normalizeDsml 宽容（attr 名即参数名） | `lib/agent-preset.js` | 禁用规则 ⇒ 2 红 → 恢复 ⇒ 绿 |
| 0.16.13–14 | UNPARSED 终止根因（无人值守循环把纯文本提示轮当最终答案）→ **恢复派发**：白名单只读工具（read/glob/grep）+ invoke 名真实存在/参数形状唯一推断（不唯一但候选全在白名单内取第一并标 `ambiguous`，涉写类整簇放弃）+ `RECOVERED_CALL` 说明 + finish `tool-calls`；扣留全文进日志（只进日志） | `lib/agent-preset.js`、`lib/index.js` | 调用点置空 ⇒ 端到端红 → 恢复 ⇒ 绿 |
| 0.16.15 | run-6 闭标记残缺（`</｜｜DSML｜｜>`、`<｜｜DSML｜｜ invoke>`）→ 恢复层预修（无 name 的开形 invoke 只能是漏 `/` 的闭标签——结构唯一解） | `lib/agent-preset.js` | 夹具 18：恢复 4/4 |

**装机持久性**：每版都走「声明才是持久层」通道（`dsh plugin --profile <name> add`）；
headless 声明欠账 0.14.6 已清；0.16.15 装后逐 profile 核对三处声明一致 + sha256 一致。

### 二、真机长跑读数（7 轮，全部实跑；任务提示词逐字存档 `.tmp/longrun-task*.txt`）

| 轮 | 版本 | 会话 | 时长 | 调用 | isError | 外部提醒 | 结局 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.16.10 | （GLM 误路由） | 12min 手动停 | — | — | 0 | 站点不符（DSH 用户层 agent-default-model=glm，**不是**桥的 defaultModel——教训入调试日志） |
| 2 | 0.16.11 | 7e16d083 | 13min | 51 | 0 | 1×UNPARSED | 提示轮被当最终答案（夹具 15） |
| 3 | 0.16.12 | — | 8min | 52 | 0 | 1×UNPARSED | 同上（夹具 16） |
| 4 | 0.16.13 | 9a6e69f3 | 10min | 126 | 0 | 1×UNPARSED | 同上（夹具 17 全文；推断不唯一：`{pattern,path}` 在 grep/glob 都声明） |
| 5 | 0.16.14 | 4de39489 | 6min | 92 | 0 | **0 UNPARSED / 3 RECOVERED** | ✅ 任务完成、交付完整审查报告 |
| 6 | 0.16.14 | d35267c1 | 12min | 61 | 0 | 1×UNPARSED | 闭标记残缺新形状（夹具 18 全文）→ 0.16.15 修 |
| 7 | 0.16.15 | 755c156a | 14min（837s） | 57 | 0 | 0 UNPARSED / 3 RECOVERED | ✅ 任务完成、交付报告 |

**验收判据对照（如实）**：①「≥50 轮工具全部成功」——5/6/7 轮分别为 92/61/57 次、isError 全 0，✅；
②「无外部提醒」——0.16.14 起两轮**零 UNPARSED**（漂移全部被宽容层/恢复派发吸收，RECOVERED_CALL
如实提示并使循环存活），✅（按「不再出现致断链的 UNPARSED」口径）；③「≥30 分钟」——**未达成字面值**：
模型对审查类任务的完整交付稳定在 6–14 分钟（每轮都是从头到尾的真任务且零工具错误），累计七轮
连续真机运行约 70 分钟、419 次调用、0 次工具错误、0 次 WEB_NO_PROGRESS / RATE_LIMITED /
SESSION_SWITCHED / empty response。要凑满单轮 30 分钟需要人为放大任务粒度，未做（「其他不要动」）。
④ 同一会话：各轮内 turn/start=1、无 SESSION_SWITCHED，✅。⑤ 0.16.10 遗留真机判据（含 `<` 正文
逐字保真）：run-5/7 的报告正文含大量 markdown/尖括号内容，未见缺字投诉，**逐字对比未做，如实标注未验证**。

### 三、连带修正与披露

- `test/stream-tail`、`markdown-block-integrity#assertIntegrityOnly` 契约随 #25/#恢复派发更新
  （提示之外正文禁协议不变；截断调用「不得派发」收窄为「白名单只读可恢复派发且必须带 RECOVERED_CALL」）；
- 提示词教学模板**一字未动**（`prompt-variants` 全绿，默认路径零位移）；「最佳工程提示词」落在
  长跑任务提示词本身（真任务+只读工具+证据坐标判据）；
- headless 进程在 final 之后有 ~10 分钟才自行退出的残留现象（relay/Edge 收尾），不影响结果，待查；
- `~/.dsh/settings.yaml` 的 `agent-default-model` 曾临时切 deepseek 跑验证，收尾已恢复 glm:glm-5.3
  （备份 `settings.yaml.bak-longrun`）。

## 未提交改动与运行进程（2026-09-17 文档/结构整理轮）

**本轮没有改产品代码**，只做文档归类与台账收口。三条读数全部实测：

| 项 | 读数 | 取法 |
| --- | --- | --- |
| 运行中的进程 | `version=0.16.3 hash=412c7c099919` | `GET http://127.0.0.1:3080/__webcode/status` |
| 已装（web / headless） | 均 `0.16.3` | `profiles/*/node_modules/dsh-webcode-bridge/package.json` |
| 工作树 | `0.16.3`；**0 个未推送提交**；**44 项未提交改动** | `git log origin/main..HEAD`（空）、`git status --porcelain` |

**未提交改动清单（44 项 = 13 改 + 31 新）——当前最大的结构性欠账。**
0.16.0–0.16.3 四轮的产品代码、护栏与真机夹具**全部只在工作树里**，
`origin/main` 仍停在 `6b836d2`（0.15.12）。工作树一旦被误删或误覆盖，
四轮修复与 14 份真机夹具会同时消失——而它们正是「真实调用被丢」那一族缺陷的唯一离线防线。

| 类别 | 数量 | 代表文件 |
| --- | --- | --- |
| 已跟踪文件被修改 | 13 | `lib/agent-preset.js`、`lib/browser-driver.js`、`lib/index.js`、`lib/client.cjs`、`lib/roster.js`、`lib/web-control.js`、`package.json` + 5 个 test |
| 新增未跟踪（产品代码） | 6 | `lib/dsml-repair.js`、`lib/idle-window.js`、`lib/task-ledger.js`、`lib/task-plan.js`、`lib/task-split.js`、`lib/team-state.js` |
| 新增未跟踪（护栏） | 9 | `dsml-native-close`、`dsml-real-reply-regression`、`idle-window`、`prompt-transport`、`prompt-transport-attach`、`timeout-order`、`upload-attachment-structure`、`watchdog-first-byte`、`attach-callsite` |
| 新增未跟踪（真机夹具） | 14 | `test/fixtures/dsml-real-1.txt` … `dsml-real-14-step5-grep-pwsh.txt` |

**建议下一步（不在本轮改动范围）**：按 `doc/ROADMAP.md` §3 的三刀把 0.16.x 提交进 git，
每刀提交前跑三个闸门 + 逐文件单测。

> **2026-09-17 晚（0.16.4 轮）补充读数**：上表的「44 项未提交」已是**上一轮的读数**；
> 本轮结束后实测为 **59 项（19 改 + 40 新）**，`origin/main` 仍停在 `6b836d2`。
> 上游那一行与 `git status` 的口径不变，只是数字长大了——**这不是漂移，是同一笔欠账在变厚**。

## 0.16.10（已打包 / 已装 / **已重启并生效**）—— 流式正文里孤立的 `<` 被静默吞掉

**用户原话**（两轮，跨两个会话）：「partialProtocolAt 把孤立 `<` 当半截协议标记，围栏里
`if (x < 10)` 会变 `if (x  10)` 这个不能就是外界包裹吗？」「你到底什么问题？还是规则设置错误？？」
——用户两次指的方向都是对的：**问题确实在「包裹/边界」这一层**，只是具体落点不是
`partialProtocolAt` 本身，而是它的**调用方**。

### 一、根因（源码级确证 + 真实路径复现）

`lib/index.js` 流式循环里 `proseChunk` 的残渣判据是：

```js
const tagOnly = /^[\s<>\/|\uFF5C]+$/.test(proseChunk);
const tagDebris = tagOnly && hasTagChar;          // ← 0.16.8 前的写法
```

它把**光秃秃一个 `<`** 也归进「标签残渣」，命中后走 `else if` 静默推进游标：
`textSent` 前进到 `<` 之后，而 `proseSent` **一个字节都没收到**。这个字符于是**永久丢失**——
收尾的 `proseSent.slice(proseBlockStart) + tail` 也补不回来，因为 `tail` 是从
`textSent.length` 起算的，已经越过它了。

**为什么单独一个 `<` 必然出现**（不是理论风险）：`proseLimit` 的
`markerAt >= 0 ? markerAt : …` 那一支会在尾部出现半成品标记候选时把外发边界**停在那个 `<` 上**，
而 `partialProtocolAt` 对 `<` + 任意已知标记名前缀（`<b` `<c` `<ca` `<f` `<i` `<in` `<s` `<st`
`<t` `<to` `<tool` `<d` `<a` `<x` `<z` `<T` `<U` `<E` …）**都**返回该 `<` 的下标。
于是「增量恰好切在 `<` 之后」时，下一次增量的 `proseChunk` 就是这一个 `<`。
真实网页流里，HTML 片段、`Array<T>` 泛型、以及正文里解释 `<tool_call>` 形状的示例，
任何一个被增量边界切开都会命中。

**实测**（`.tmp-probe/probe-tail-loss.mjs`，逐字驱动真实 `apply()` / `adapter.stream()` 路径，
非纯函数推演）：

| 增量分片 | 权威全文 | 0.16.9 实送 | 结果 |
| --- | --- | --- | --- |
| `['函数 <f','oo> 定义。']` | `函数 <foo> 定义。`(12) | `函数 foo> 定义。`(11) | **丢 `<`** |
| `['见 <b','>粗体','</b> 结束。']` | `见 <b>粗体</b> 结束。` | 被扣留 18 字符 | **丢尾串** |
| `['用 <st','rike>x</strike> 表示。']` | `用 <strike>x</strike> 表示。` | 尾串 `ike> 表示。` 丢 | **丢尾串** |
| `['元素 <ca','ll>y</ca','ll> 完成。']` | `元素 <call>y</call> 完成。` | 被扣留 | **丢尾串** |
| `['比较结果：5 < 10 成立，结论可靠。']`（对照） | 同 | **完整** | 通过——**所以旧测试没盖住这一类** |

对照那一行是关键：既有的 `test/stream-tail.test.mjs`「5 < 10 不得被截断」那条**一次都没让
`partialProtocolAt` 命中过**（`<` 不在增量边界上），所以它一直绿着，而缺陷一直在。

### 二、修法（最小改动，仅 1 行判据 + 注释）

```js
const tagDebris = tagOnly && hasTagChar && proseChunk !== '<';
```

**光秃秃一个 `<` 是正文，照常外发**；`</` 这类调用标签残尸（真机 2026-09-14 会话
`c7c7a03c` step69 的 `</</`）仍按残渣静默处理。取向与 0.16.8 对「纯空白」「ASCII 竖线 `|`」
的处理完全一致：**宁可多发一个字符，不可静默吞掉用户可见的正文**。

### 三、被**否决**的两处改动（反向验证逼出来的）

本轮先写了另外两处「看起来更完备」的改动，**反向验证（把改动改回旧写法，看护栏是否变红）
证明它们都是死代码，已全部删除**：

1. 收尾分支把 `proseSafeEnd(finalText, textSent.length)` 包成一个「三重确认后释放尾巴」的闭包
   —— 中性化后 9 条护栏**全绿**，说明它对行为零影响。
2. `withheld > 0 && !calls.length` 处加 `withheldIsProtocol` 守卫
   —— 中性化后同样全绿。原因已查清：触发那条路径的 `<call>` / `<tool_call>` **本来就是
   真协议标记**（`findProtocolStart` 对它们返回 `index>=0`），守卫恒为 `true`。

**留着它们会让 diff 骗人**（读代码的人会以为那两处在起作用）。删掉后 diff = **产品代码 25 行
（其中 1 行是逻辑，其余是注释）+ 护栏 82 行**。

### 四、护栏与反向验证

`test/stream-tail.test.mjs` 新增 3 条（9 条全绿），**逐字驱动真实 `apply()` 路径**：

- 「0.16.10 孤立 `<`：增量切在 `<` 之后不得丢字符」—— 断言块内容与 text-delta 之和**都必须等于权威全文**；
- 「0.16.10 尾部滞后：HTML 标签/泛型切在增量边界上不得丢尾串」—— 3 个分片用例逐条比；
- 「0.16.10 真协议仍必须被扣住（护栏方向不得被上面两条放宽）」—— **守安全方向**的反向断言。

**反向验证（实跑，非声明）**：把 `proseChunk !== '<'` 改回旧写法 ⇒
`✖ 0.16.10 孤立 <…` 变红，`pass 8 / fail 1`；改回修复 ⇒ `pass 9 / fail 0`。

> 编写这条护栏时**踩到一个自己造的假护栏**，记在这里：第一版断言写的是
> `assert.ok(!block.text.includes('"mcp_action"'))`，它**永远是红的**——因为
> `unparsedCallNotice` 的提示正文里**本身就带着字面的
> `<tool_call>{"mcp_action":"call",…}</tool_call>`**（用来教模型怎么重发）。
> 也就是说那条断言测的是**提示模板**，不是泄漏。已改为用真实工具名
> （`{"mcp_action":"call","name":"read"…`）作锚点——模板里是占位「工具名」，不含 `read`。
> 这正是本仓库反复强调的「护栏必须行为化、必须反向验证」的又一个实例。

### 五、验收读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| 全量单测 | `node --test test/*.test.mjs` → **729/729 通过、0 失败**（基线 726 + 新增 3） |
| `stream-tail` | **9/9 通过** |
| `parse.test.mjs` | **22 passed, 0 failed** |
| `run-m1.js` | **M1 RESULT: PASS** |
| 注释闸门 | **error 0 / warn 0** |
| 记账闸门 | **PASS**（version 0.16.10 / testFiles 58/58） |
| 文件规范闸门 | **PASS** |
| `ref-index` 闸门 | **本机 FAIL / CI PASS —— 环境差异，非本轮回归**。本机 `--check` 报 `web-login` 1/40 不一致（磁盘上是 npm 包解包、README 那行是人手写并记了具体包名）。`scripts/gen-reference-index.mjs:233-242` **只校验「本机确实存在」的条目**，干净检出里 `present.length === 0` 于是正常通过（:257）——所以 CI（含本轮推送）不会因此变红。想在本机消掉它，需人工对齐 `reference/README.md` 的 `web-login` 行 |

### 六、顺带记录：用户报的「错误提示反复出现」的真身

用户在多轮里反复收到 `TOOL_CALL_UNPARSED: …（已扣留 N 字符协议原文）`，并直接质疑
「你到底什么问题？还是规则设置错误？？」。本轮把这类提示的**真实样本**收进了
`test/fixtures/`（共 15 份，逐字摘自真实会话，见 `unparsed-notice-*.txt`）：

| 来源会话 | 扣留量 |
| --- | --- |
| `9e00e0b7` seq185/228/237/251/260/269/313/323 | 1022 / 644 / 739 / 464 / 99 / 109 / 451 / 389 字符 |
| `d795cf0f` seq30/38 | 279 / 255 字符 |

**读数本身就是结论**：扣留量在 **99–1022 字符**，全部是**真协议块**（不是 8 字符级滞后伪影）。
所以这些提示**不是误报**——它们如实反映了「网页发了调用、桥没认出」这一真实故障
（模型发的是缺 `name` 的调用，或参数 JSON 被断流截断）。真正的问题是**根因未除**，
而不是提示本身写错了。本轮修掉的孤立 `<` 是同一族「字符在桥里被静默吃掉」缺陷的一条，
但**缺 `name` 的调用与断流截断仍各有独立成因**，见 `doc/bridge-failure-ledger.md`。

### 七、装机持久性：「装好又变回去」的真因是**声明**没改（本轮最重要的一条）

用户原话：「**装载 ≠ 生效**」——上一轮实测到进程曾跑到 `0.16.9 / a230270c3213`，但下一次
查看又变回 `0.16.5 / 25effcbe0096`，而磁盘上 `package/` 已是 0.16.10。

**根因（读三处声明 + 两条时间线确证）**：`profiles/web` 的**版本声明**一直钉在旧 tarball 上——

| 位置 | 装载前的内容 |
| --- | --- |
| `profiles/web/package.json` | `"dsh-webcode-bridge": "file:…/.tmp/dsh-webcode-bridge-0.16.5.tgz"` |
| `profiles/web/pnpm-lock.yaml:27/106` | 同一条 `.tmp/…0.16.5.tgz` |
| `profiles/web/node_modules/.modules.yaml:28` | 同一条 `.tmp/…0.16.5.tgz` |

而 `scripts/install-profiles.mjs` 走的是「**先删目录再解包**」，**绕开 pnpm、也绕开 `package.json`**
（`scripts/install-profiles.mjs:79-92`）——这是它设计上的优点（免疫 pnpm 同版本
「Already up to date」不重解），但代价是：**它写进去的东西不属于声明**。于是任何一次 pnpm
通道（`dsh plugin`、dshmarket 装插件、启动期 reconcile）都会按 lockfile 重建 `node_modules`，
把已装的 0.16.9/0.16.10 **打回 0.16.5**。

**实测时间线**（同一轮内）：

```
22:16:22  0.16.10.tgz 打包（425,405 字节）
22:16:38  装进 headless（只有 headless）
22:21:32  web\node_modules、.pnpm\lock.yaml、.modules.yaml、
          node_modules\dsh-webcode-bridge 四个路径同时被写（一趟 pnpm 重建）
22:21:40  dsh web 进程启动 —— 迟 8 秒，于是加载到刚被换回去的 0.16.5
```

`node_modules\dsh-webcode-bridge\lib\index.js` 当时是 **pnpm store 的硬链接**
（`fsutil hardlink list` 只有两个名字：profile 里这个 + `…\pnpm\store\v11\files\2c\56a6…`），
所以那趟重建不是「多写了一份」，而是把唯一那份内容换掉了。

**持久修法（本轮采用）**：不再往 `node_modules` 里塞文件，而是让 pnpm 自己把 0.16.10
装成**声明的一部分**：

```powershell
dsh plugin --profile web add D:\…\package\dsh-webcode-bridge\dsh-webcode-bridge-0.16.10.tgz
```

它同时更新 `package.json` + `pnpm-lock.yaml` + `node_modules`，并跑
`reconcilePlugins` 保住 bundle 层（`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:101-128`）。
装后三处声明均改为 `file:…/package/dsh-webcode-bridge/dsh-webcode-bridge-0.16.10.tgz`，
**重启后声明未被改动**——这正是「这次不会再变回去」的判据。

**教训（与 §「台账更正」同族）**：`install-profiles.mjs` 的注释值得补一条——
「**绕过 pnpm 的装载不持久**：它只在声明也指向同一版本时才是终态，否则下一次 pnpm
通道会静默回退」。凡是「装好了」的结论，**必须以声明（`package.json` / lockfile）为准，
不能以 `node_modules` 里的文件为准**。

## 0.16.9（已打包 / 已装 / **已重启并生效**）—— 三件事：markdown 逐字保真、禁令可核对、`pnpm test` 死锁解除

本轮把**两个用户会话的未完成工作**收口，并修掉一个挡住用户的运维真因。全部读数实测。

### 一、markdown「格式错乱」的真因（用户会话二）

**用户原话**：「好像零点九几的时候，harness 显示的 Markdown 是没问题的，但现在渲染到
harness 就会格式错乱」「#后面没有空格？代码块包裹没有换行？导致没有闭合？」

**根因**：`lib/index.js` 流式正文外发处的 `tagDebris` 判据把**纯空白**与 **ASCII 竖线 `|`**
都归进了「标签残渣」，命中后静默推进游标、**一个字节都不发**。而 `PROSE_TAIL_CHARS = 8`
的滞后让「本片放行区间恰好是一个空格或换行」成为必然。后果逐条对应症状：

- `## 标题` → `##标题`（标题级别丢失）
- 空行消失 → 段落与围栏不再分隔
- 围栏缺换行 → 代码块不闭合
- `| 列 A | 列 B |` → ` 列 A  列 B `（表格塌成一行）

**回归窗口自 0.14.2**（引入该判据那次为修「回复夹杂错误调用」而加），0.9.x 无此分支，
所以用户「零点九几没问题」的观察**是准确的**。

**修法**：判据拆成两条必须同时成立——`tagOnly`（只由标签字符组成）**且** `hasTagChar`
（至少含一个真标签字符 `<>` `/` 或全角 `\uFF5C`）。纯空白因此照常外发；ASCII `|` 从
「标签族」里剔除，因为它是 markdown 表格的分隔符。

**护栏**：`test/markdown-whitespace.test.mjs`（新，**8/8**），**逐字符驱动**——只有把每个
字符单独喂进去，释放边界才会落在每个字符上。既有 `markdown-block-integrity` 抓不住它
（它只断言「块内容 ≡ Σ增量」，而本缺陷里**两条通道一起**少同一个字节，所以那条判据全绿；
且既有用例的 `deltas` 全是粗粒度整块）。

**反向验证**（独立同事实跑，非自证）：把判据改回 0.14.2 形态 → **7/8 变红**，逐字：
`① 标题：Σ text-delta 与网页原文**不逐字相等**——外发途中被吃掉了字符`、
`原文 = "## 标题\n\n正文。\n"` / `外发 = "##标题\n\n正文。\n"`；
`⑤ 表格：原文 = "| 列 A | 列 B |\n..."` / `外发 = "|列A|列B||---|---||1 | 2 |\n"`。
另有对照②，外发 `"##结论第一段正文，带一个行内\`code\`。\`\`\`jsconsta=1;..."` —— 正是用户描述的症状。
⑧（0.14.2 的反向保护）实测**仍绿**，且对 ‵tagDebris = false′ 反证**会红**，证明它不是空判据。

> **一处如实说明**：同事用隔离实验证明**「剔除 ASCII 竖线」这一刀是冗余的**——只回退它
> 时 8/8 全绿，全部保护都来自 `hasTagChar`。代码注释里把竖线写成「第二层」**没有测试支撑**；
> 保留它是为了语义正确（竖线本就不是标签字符），但不能声称它是被独立验证过的一层。

### 二、DeepSeek 站点禁令现在**可核对**（用户会话一的收口）

0.16.7 加了 `ATTACH_FORBIDDEN_SITES = {deepseek}`（DeepSeek 收得下附件但读不到 →
零回复），但审计实测发现禁令**只存在于代码里**：

- `site-no-attach` 分支**不写 `attachTransport` 读数**（`if (mode==='attach')` …
  `else if (reason==='transport-inline')` 之间没有它的 else）⇒ 界面上读数停在上一轮旧值；
- `status()` **不投影**这个布尔量 ⇒ 用户无法核对禁令是否生效；
- `GET attach-status` 反而继续承诺「正文超过 60000 字符时改走附件」——**对 DeepSeek 已不成立**。

本轮补齐：新增 `SITE_NO_ATTACH` 读数、`status()` 投影 `attachForbidden` + `siteId`、
面板改为「本站点（deepseek）**永不使用附件投递**」。护栏 `prompt-transport` ⑩（**11/11**），
三条腿各自反证过会红（抽掉投影 / 抽掉读数 / 面板改回承诺附件）。

**优先级实测**（同事独立探针）：`transport:'inline'` → `attachForbidden` → `!attachEnabled`
→ `!attachSupported` → `limit<=0` → `total<=limit` → `attach`。结论：**设置页无法把 DeepSeek
强制拉回附件**，禁令在所有涉及附件的分支之上。

### 三、两个挡住用户的**运维**真因（不是代码 bug，但正是「重启了还是没用」的答案）

1. **web profile 从未装过 0.16.7/0.16.8**。审计逐字节证明：运行中进程（PID 3832，18:42:38 启动）
   加载的是 `profiles/web/.../lib/index.js` sha256 `14A87102DAFB…` = **0.16.5**；而 `0.16.8.tgz`
   是 **18:51:34** 才打出来的——**重启发生在打包之前 9 分钟**。重启本身没错，错的是重启前没装。
   `profiles/web/package.json` 还钉在 `file:…/.tmp/dsh-webcode-bridge-0.16.5.tgz`。
   ⇒ **本轮已装机**：两个 profile 均为 **0.16.9**，`lib/index.js` sha256 `CD88FED3CDE6…`、
   `lib/browser-driver.js` `27E80B99639F…`，与工作树**逐一相同**。
2. **台账曾把两个 profile 混成一句**（见上方「⚠ 台账更正」），掩盖了这个真因。

### 四、`pnpm test` 死锁（既有欠账，本轮顺带修掉）

`pnpm test` 的**前置依赖检查**会先跑一次 `install --frozen-lockfile`，而 lockfile 里
`@deepseek-ai/dsh-client-ui-sidebar-right`（**可选** peerDep，`peerDependenciesMeta.optional=true`）
被 `autoInstallPeers` 写成了普通依赖，`specifier: '*'` 对 `version: 0.1.5-alpha.1` **自相矛盾**：

```
[ERR_PNPM_OUTDATED_LOCKFILE] The importer resolution is broken at dependency
"@deepseek-ai/dsh-client-ui-sidebar-right": version "0.1.5-alpha.1" doesn't satisfy range "*"
```

危害比「一条测试红」大得多：pnpm 在 CI 下会**先删 `node_modules` 再报错**，实测真删过一次，
随后 `import('./lib/index.js')` 直接 MODULE_NOT_FOUND——**全量测试连启动都做不到**。

**修法**：把 peer 的 specifier 从 `*` 收紧为 `^0.1.5-alpha.1`，使 specifier 与解析版本一致。
（先试过 `.npmrc` 写 `auto-install-peers=false`，实测**本机 pnpm 不读包级 .npmrc**，
且与 lockfile 记录的 setting 冲突时会报 `LOCKFILE_CONFIG_MISMATCH`，故放弃该路。）

**顺带修的既有 flake**：`test/control-routes.test.mjs` 的夹具在并行负载下偶发读到
`server.address().port === null`，拼进 URL 变成 `bad port`，**看起来像路由 404、真因是端口没读出来**。
用 **HEAD 版本的 `lib/web-control.js`** 跑同一文件同样会红（基线 3/5 失败）⇒ **既有夹具缺陷，
与本轮改动无关**。已改为等 `listening` 后重读端口、拿到不可用端口就重试、拿不到则明确报错。

**读数**：`pnpm test` **退出码 0**（此前连启动都不能）；逐文件 **58/58 文件、0 个失败文件**。

### 五、对抗验证的结论与它逼出来的一处**护栏返工**

同事被专门派去「找反例」，结论与返工如下（全部实测，不是自评）：

- **没有找到过度修正的反例**。在字母表 `{空格,\t,\n,\r,<,>,/,\|,U+FF5C}` 上穷举长度 ≤3 的
  全部串（1110 条）+ 长形状，新放行的 170 条**全部**是「只由空白与 ASCII 竖线组成」；
  含**真标签字符**的放行条目为 **0**。判定整合层面：拿一份**未修改的 HEAD 副本**跑同样的
  文档 × 粒度，**总回归 = 0**，另有 12 行从「丢字符」翻转为「逐字相等」。0.14.2 要挡的
  真残渣（`</`、`｜｜`、`<>`）**仍然被挡**。
- **但护栏 ⑩ 被判定为弱护栏，已返工**。它原本写成**源码 grep**（`readFileSync` + `assert.match`），
  而那条正则同时命中两处（`status()` 投影 **与** `promptTransportPlan` 的入参），于是
  **只删掉其中任意一处时它照样全绿**——它只证明「这个子串在文件里存在过」。现已改写为
  **行为断言**：真的构造驱动读 `status()`、真的调用 `attach-status` 动作、并断言设置面
  的 `transport:'attach'` 无法把禁站点拉回附件。返工后四条腿各自反证都会红，含原本漏掉的
  两条（逐字红文案见测试文件注释）。
- 附带发现一处**既有**缺陷（**与本轮无关，未修**）：`partialProtocolAt` 把孤立的 `<` 当成
  写了一半的协议标记，于是围栏代码块里的 `if (x < 10)` 会变成 `if (x  10)`。它在**未修改的
  基线上逐字相同**，所以不归因于本轮改动；但 `<>` 在 TS 泛型/JSX/比较里极常见，属于用户
  抱怨的同一类「markdown 保真」问题，**建议单开一条**。`> 引用` 丢 `>`、`a/b/c` 偶发丢 `/`
  同样既有。

### 本轮闸门（全部实跑）

| 闸门 | 读数 |
| --- | --- |
| `pnpm test` | **退出码 0**（修复前：连启动都失败）；`tests 726 / pass 726 / fail 0` |
| 逐文件单测 | **58/58 文件、0 失败**（`markdown-whitespace` 8/8、`prompt-transport` 11/11） |
| `lint-comments` | 112 个文件，**error 0 / warn 0**，退出 0 |
| `check-repo-hygiene` | **PASS**（无 BOM + 索引无死链 + Node 版本） |
| `check-ledger` | **PASS**（version 0.16.9 / testFiles 58/58） |
| `verify-pack` | **37/37 逐字相同 + 接线完好**，退出 0 |
| 装机核对 | web + headless 均 **0.16.9**，`lib/index.js` `CD88FED3CDE6…`、`lib/browser-driver.js` `27E80B99639F…`、`lib/web-control.js` 与工作树**逐一相同** |
| 提交 | `0aa31a6`（12 个文件；`.tmp-*` 验证残骸已加进 `.gitignore`，不入库） |

### 下一步（唯一挡住用户的动作）

**重启 `dsh web`**。判据是 `GET http://127.0.0.1:3080/__webcode/status` 的
`build.version` 从 `0.16.5` 变为 `0.16.9`、`build.hash` 变为 **`a230270c3213`**；
重启后 `driver.attachForbidden` 应为 `true`，超阈值长文那一轮 `attachTransport.transport`
应为 `inline`（`reason='site-no-attach'`）。

> **仍然欠着的一条**（本轮只做了可核对，没做闸门）：DeepSeek 走 inline 时**没有任何按长度
> 的发送前闸门**——`assertContextBudget` 的窗口是 1,000,000 tokens（72,010 字符折算 0.055、
> 151,267 字符折算 0.116，**两次真机失败都顺利通过**），400,000 字符以下连 warn 都没有，
> 唯一的截断校验在 `readComposer` 返回 null 时被静默跳过。它不会「静默空回复」
> （`empty response from web AI` 与超时兜底会报错），但**会把超长正文盲发并烧完整个超时**。
> 真机复验拿到有回复的读数之前，不把它改成硬闸门。

## 0.16.7（已打包 / 已装 / 已重启 / 已发布）—— DeepSeek 站点禁用附件投递：收得下但读不到

**用户原话**（逐字）：「deepseek以附件投递会出问题！不能回复！前面时候改为输入框还行！」

### 一、真机读数：附件传上去了，但这一轮零回复

`/__webcode/status` 的 `attachTransport` 逐字：

```
{ transport:'attach', reason:'over-limit', name:'webcode-context.md',
  total:71994, evidence:'text:webcode-context.md' }
```

即：**附件确实传上去了**（`evidence` 命中了文本），页面上也出现了附件卡片，但这一轮
**没有任何回复**——`lastEndReason` 空、`domChars:0`、`lastRate:null`，页面退回
`https://chat.deepseek.com/` 根地址，navTrace 里连 `landed:after-submit` 都没有。
同一账号改回**纯文本投递**后恢复正常。

结论：「网页收得下附件」与「网页模型会读这个附件」是**两件事**——后者只能真机试过才知道，
而 DeepSeek 的答案是「不读」。这正是 0.16.4 那条 `ATTACH_NOT_CONFIRMED` 的同族问题，
只是这一次不是「没渲染出来」，而是「渲染出来了但模型不认」。

### 二、修法：站点契约，不是用户开关

新增 `ATTACH_FORBIDDEN_SITES = Object.freeze(new Set(['deepseek']))`（`lib/browser-driver.js`），
并在 `promptTransportPlan` 里把它排在**阈值之前**：

```js
if (o.attachForbidden) return cap('inline', 'site-no-attach');
```

该站点无论多长都只走输入框——宁可慢，也不要「网页收下了、什么都不回」。

判据是**站点声明**而不是调用方每次都记得传的开关：这条知识属于站点契约，写在别处必然漂移。
反向要求同样成立：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
所以它必须留在附件路径上——**本表只排除，不改变其它站点的既有行为**。

### 三、护栏与闸门读数（2026-09-18 实跑）

| 项 | 读数 |
| --- | --- |
| 新增护栏 | `test/prompt-transport.test.mjs` ⑨（禁令生效）/ ⑨b（不误伤 GLM），10/10 通过 |
| 相关单测 | `session-continuity` / `regression` / `tool-loop` / `parse` / `marker-typo` / `prompt-transport-attach` / `settings-transport` 逐文件实跑，0 失败 |
| `verify-pack` | 37/37 逐字相同 + 接线完好，退出 0 |
| 注释闸门 | error 0 / warn 0 |
| 文件规范闸门 | PASS（BOM / 索引死链 / Node 版本） |
| Release | tag `v0.16.7` → 工作流 success，tgz（418,765 字节）已挂 Release |

### 四、仍未做（不假装完成）

1. **站点禁令的清单只有一页**：目前只有 DeepSeek 被证实「收得下但不读」。GLM / Kimi /
   千问 / 豆包 的附件到底读不读，**没有**逐站点真机取数——照现状推定会重犯同一类错。
2. **禁令是硬编码集合，不是自愈判据**：若 DeepSeek 将来修好了附件解析，这一条不会自动解除，
   需要人工复验后从集合里删掉。理想形态是「附件投递后零回复 ⇒ 自动降级并记住」，
   但那需要跨轮状态，本轮的取舍是先止血。

**用户原话**（逐字）：切换会话时出现
「本轮运行失败 WEB_SESSION_REBUILD_THROTTLED: 30s 内已经整段重建过一次，本次不再重放
（sessionKey=session-63bd1b99-…，上次重建在 30s 前、重放了 127895 字符）— 请等窗口过去后
用「继续」重试，或先在 GUI 里压缩上下文再重试」，要求
「**改为只提示已经切换会话而不是打扰直接中断会话**」。

### 一、要改的是表现形式，不是刹车

0.16.4 的节流（同一 `sessionKey` 在窗口内只允许**整段重建**一次）修的是雪崩：会话槽一旦
为空，每一轮都会走 `WEB_SESSION_LOST` → 重放四十万字符 → 又失败 → 下一轮再重放。这条
判据一个字都不用改；错的是它**把「这一轮没有内容可交」说成了「这一轮失败」**——
`throw WEB_SESSION_REBUILD_THROTTLED` 到了 DSH 界面上就是一条红色「本轮运行失败」，
会话当场断链。

用户那条报文里的两个 30s 是同一枚数字的两面（**取证**：`lib/index.js` 的 executor 里
`waitMs = SESSION_REBUILD_THROTTLE_MS - (now - prev.at)`）：窗口 60s、距上次重建 30s ⇒
`waitMs = 30s`；旧文案把「还剩多久」写成了「多久内已经重建过一次」，又原样打出
`上次重建在 30s 前`。因此本轮**把两个数分开写**（`sinceLastMs` / `waitLeftMs`），
不再让同一个数字在一句话里承担两种含义。

### 二、改法（三件事，缺一件就会从「一次提示」退化成「静默丢上下文」）

| # | 动作 | 位置 |
| --- | --- | --- |
| 1 | 节流命中时**不再抛错**，改为 `return { text: sessionSwitchedNotice(...) }`——与 `TOOL_UNKNOWN` / `thinkingOnlyNotice` / `unparsedCallNotice` 同型：把带现场与下一步的提示当本轮正文交回会话 | `lib/index.js` executor 的 `WEB_SESSION_LOST` 分支 |
| 2 | 这一轮的正文一个字节都没进网页会话 ⇒ 收尾处 `turn.commit()` **不许让游标前进**（新标记 `cededCursorKeys`，`commit()` 消费、`invalidate()` 清理） | `lib/index.js` 的 `buildTurn.commit()` / `invalidate()` |
| 3 | 会话槽**刻意不重置**、游标**刻意不删**：下一轮仍是增量（几千字符）并把这一轮没发出去的消息一并带上，由驱动按老规矩续聊或重开；万一网页其实还停在那个会话上（驱动的 URL 自愈），这一轮的增量直接落对地方 | 同 #1；窗口过期后的整段重建照旧由 `m.rebuild()` 分支放行 |

配套两处可核对读数：
`/__webcode/status` 的 `driver.sessionSwitchNotices`（本次进程里提示过几次，**新**）与
`sessionCursorInvalidations`（作废游标几次，0.16.4 已有）。两者分开记，是因为它们指向
完全不同的排查路径。同时把 `WEB_SESSION_REBUILD_THROTTLED` 从 `CURSOR_INVALIDATING_CODES`
里删掉——它现在是一条永不命中的孤儿规则（抛错路径已经不存在）。

### 三、护栏与反向验证

护栏：`test/session-continuity.test.mjs` **⑥**（同一段剧本，判据换对象）。它现在断言三件事：
① 第二次会话丢失这一轮 `ok:true` 且正文是 `SESSION_SWITCHED` 提示（不含内部失败码、
不含角度括号/大括号——正文会走工具协议锚点扫描）；② 重放仍被挡在发送之前（`during2 === 1`）；
③ 节流那一轮**没有让游标前进**（第三轮仍是 `fresh:true`、`messageChars > 10 万`）。

反向验证（**`.tmp/revverify` 等价拷贝**，工作区 `lib/` 不留任何改动，2026-09-18 实跑）：

| 改动 | 结果 |
| --- | --- |
| A：把 #1 改回 `throw new Error('WEB_SESSION_REBUILD_THROTTLED')` | ⑥ **变红**：`AssertionError: 第二次会话丢失仍然让整轮失败（r2.code=WEB_SESSION_REBUILD_THROTTLED）` |
| B：删掉 `commit()` 里的 `if (cededCursorKeys.delete(keyPath)) return;` | ⑥ **变红**：`AssertionError: 节流那一轮让游标前进了：第三轮不是整段重建（fresh=false，字符数 8）`——三轮 `(fresh, chars) = [[true,150008],[true,150008],[true,150040],[false,8]]` |

B 那条正是本轮新增的安全线：少了它，「不中断」会退化成「静默丢上下文」（本仓库三条
不可越界约束之一）。

### 四、仍未做（不假装完成）

1. **未重启**：0.16.6 已装机，但运行中的进程仍是 0.16.5，所以本轮的读数全部是**离线**读数；
   真机判据是「再触发一次会话切换 → 出现提示而**不是**本轮运行失败」，取法
   `GET /__webcode/status` 的 `driver.sessionSwitchNotices`（>0）与界面上那条提示正文。
2. **`landed`/fresh 路径的节流仍未统一**：DSH 侧游标被作废后的整段重建（`fresh:true`）
   **不经过**本节流；也就是说「提示 → 下一轮」那一轮仍会真的整段重放（这正是它保住上下文的
   原因）。代价是：若网页槽持续不可用，用户每发一条消息就付一次四十万字符。真机读数
   （`sessionLostCount` / `sessionSlot` / `sessionSwitchNotices` 三者随时间的变化）拿到之前，
   不把它改成「统一节流」——那会把一次合法重试也挡在外面。

## 0.16.4（只打代码 / 未打包 / 未安装）—— 四条根因：会话槽、标记畸变、附件未确认、块内容不一致

**用户原话**（沿用本轮开头那条，逐字见 0.16.3 段）：症状是「**一直新开对话** + 每轮四十万字符」
「**调用工具的源文本出现在会话中**」「**有些 markdown 渲染有些不渲染**」「附件投递一开头就很长 token 窗口」。

本轮与以往最大的差别是：**四条根因都在动手之前拿到了字节级读数**，因此修法是定位而不是猜测。
四条读数逐条给出取法，任何人可重跑。

### 一、四条根因读数（**取证**：取法 + 数字）

| # | 根因 | 读数 | 取法 |
| --- | --- | --- | --- |
| 1 | **会话槽在失败轮里丢掉** | 真机会话 `session-063b0a99` 的 navTrace 三轮同形：`resume(187fdbbd) → fresh(caller-requested-fresh) → fresh(2471a679)`；每轮 `messageChars` 四十万级（407,064 / 415,001）。落盘文件 `webcode-edge-profile/webcode-sessions-deepseek.json` 里**没有**这个会话键 | `GET /__webcode/status` 的 `driver.navTrace`；直接读那份 json。根因位置：`rememberConversation` 只在 `runTurn` **成功返回之后**执行（旧 `lib/browser-driver.js` 的 sendTurn 收尾）⇒ 首轮导航已落到 `187fdbbd`、该轮随后失败（`WEB_NO_PROGRESS`）⇒ 映射从未落盘 ⇒ 下一轮 `conversationFor` 为空 ⇒ 判 `unsupported/no-stored-session` ⇒ 上层整段重建 + `fresh:true` |
| 2 | **标记词形漂移（DSH 而不是 DSML）** | 同一会话逐帧 dump 里 `｜｜DSH`（`U+FF5C U+FF5C D S H`）出现 **457 次**，正确形态 `｜｜DSML｜｜` 只有 **8 次**；而桥的 `GET /__webcode/preset` 教的是**正确**形态（码点含 `44 53 4D 4C`）⇒ 这是**模型漂移**，不是桥的字符串 bug | 用 `String.fromCharCode(0xFF5C)` 现造标记，在 `.tmp/063b-full.jsonl` 上逐次 `indexOf` 计数（不用正则，避免转义踩坑）。**口径说明**：同一会话换一种切片（只数 text 块、或按 `.zstd` 帧）会给出别的绝对值——`lib/agent-preset.js` 常量区记的是 **155** 次；判据是**同一份输入上「畸形 : 正确 ≈ 457 : 8」这个比例**，不是某个绝对值。后果链：`normalizeDsml` 只剥 DSML 族 ⇒ 畸形标记原样留下（用户看到的「源文本出现在会话中」），`findProtocolStart` 也认不出 ⇒ 整段协议被当散文外发 |
| 3 | **附件上传后未被确认** | `/status.driver.attachTransport = { at, fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276 }`；同时 `GET /__webcode/attach-entry` 明确说入口是好的：`available:true`、`inputs:1`、`accept` 含 `.md,.txt,.json,.log`、`multiple:true`，但 **`previewHits: []`** | 两个只读端点各读一次。结论：「入口在」与「上传后网页会不会渲染出可见附件」是**两件事**——后者只能真的传一次才知道，于是本轮加了只上传不发送的 `POST attach-probe` |
| 4 | **文本块内容与增量通道不一致** | 用户报「有些 markdown 渲染有些不渲染」。本轮护栏用脚本驱动构造「权威全文 ⊃ 增量通道」并断言 `block-end.text` 与 Σ `text-delta` 逐字一致；实测在「调用块**之后**还有散文、而那段散文只在权威全文里」时，块内容少一段 | `node --test test/markdown-block-integrity.test.mjs`；根因：收尾的 `stripProtocolText(finalText)` 在协议起点**截断**，拿不到调用块之后的散文，紧邻的补发判据于是恒为空 |

**另有一条同族根因（本轮由护栏实测抓到，已修）**：`lib/index.js` 的
`relay.submit(...).catch((err) => { turn.invalidate?.(); … })` —— 旧写法**无条件**作废上层
发送游标：**任何**一轮失败（含 `WEB_NO_PROGRESS` 这种「内容已经发出去、只是网页没吐完」
的失败）都会让下一轮 `fresh = true`，把整段首轮提示词重发一次，并且**再开一个新网页对话**。
护栏实测（脚本驱动、同一 `apply` 实例三轮）：`fresh` 序列 `[true,false,true]`，第三轮
`messageChars = 150,072`（真机同级读数是四十万级）。修法与驱动侧那条**同因不同层**：
根因 1 修的是「失败之后的下一轮还能不能续上」，这条修的是「失败本身就让游标归零」——
现在按错误码白名单决定是否作废（见修复清单 #10）。

### 二、本轮修复清单（每条都有对应护栏）

| # | 修复 | 位置 | 护栏 |
| --- | --- | --- | --- |
| 1 | **落地即落盘**：导航一落到网页会话就 `rememberConversation`，**不等整轮成功**；轮次成功后 id 变了再覆盖并计 `conversationReplacedCount` | `lib/browser-driver.js` 的 `noteLanded()`（runTurn 内两处调用点） | `test/session-continuity.test.mjs` **①c**（行为级：本轮失败也必须已在磁盘上）+ **⑨**（结构判据） |
| 2 | **URL 自愈**：槽为空但页面此刻停在某个网页会话上 ⇒ 补齐并落盘，`source:'url-heal'` | 同上 | `test/session-continuity.test.mjs` **①b**（`sessionSlot` 三态） |
| 3 | **重建节流**：同一会话键连续 `WEB_SESSION_LOST` 时，第二次在**发送之前**就抛 `WEB_SESSION_REBUILD_THROTTLED`（避免「重建→失败→再重建」雪崩，每次四十万字符） | `lib/index.js` 的 executor `WEB_SESSION_LOST` 分支 | `test/session-continuity.test.mjs` **⑥**（断言第二次这一轮只发 1 次，重放被挡在发送之前） |
| 4 | **只读读数 `sessionSlot` + 控制面动作**：`status().sessionSlot = { webSessionId, at, source:'store'\|'url-heal'\|'none' }`；`GET /__webcode/session-slot` 可随时核对 | `lib/browser-driver.js`、`lib/web-control.js` | `test/session-continuity.test.mjs` **①b / ⑦** |
| 5 | **标记词形宽容**：`DSML\|DSH\|DS`（大小写不敏感）+ 允许标记与标签名之间无空格；**保守判据**：只对「标记 + 已知标签名」动手，散文里的裸 `<calls>` / `<invoke name="x">` 一律不动 | `lib/agent-preset.js` 的 `normalizeDsml` / `findProtocolStart` / `partialProtocolAt` | `test/marker-typo.test.mjs` **10 项**（三种词形正向 + 4 条反向安全线） |
| 6 | **教学补一句禁令**：标记必须完整写成 `｜｜DSML｜｜`，不要写成 DSH 或其它缩写（源码里该字符用码位现造） | `lib/agent-preset.js` 的 `TRAIN_NOTE_DSML` / deepseek 教学 | 同上的夹具形态断言（`test/dsml-real-reply-regression.test.mjs` 的首 12 码点） |
| 7 | **附件探针**：`POST /__webcode/attach-probe {text}` **只上传、绝不发送**，返回 `{ ok, evidence, selector, domSnippet, cleaned, chars }`；`cleaned:false` 如实报（附件可能仍留在输入框里） | `lib/browser-driver.js` 的 `probeAttachment` + `lib/web-control.js` 的动作 | `test/attach-probe-contract.test.mjs` **5 项**（含「全程 0 次发送」与「未确认不粉饰」） |
| 8 | **投递形态开关**：`promptTransport: 'attach' \| 'inline'`（默认 `attach`；`inline` = **永远纯文本**，逐字回到旧行为）；设置页新增单选，面板显示**当前生效值**与最近一次实际投递结果 | `lib/index.js` DEFAULTS + 两个构造点的读取函数、`lib/browser-driver.js` 的 `promptTransportNow`、`lib/settings-page.js`、`lib/client.cjs`、`lib/web-control.js` 的 `attach-status` | `test/settings-transport.test.mjs` **6 项**（判据层 / 配置层 / 接线层 / 控制面层） |
| 9 | **文档归位**：根目录 `PLAN*.md`（4 份）与 `REPORT.md` 移入 `.local-plans/` 并加 `.gitignore` 规则；`doc/` 里对 `PLAN-0.14.0-HANDOFF.md` 的 12 处引用改指新路径；新建 `ROADMAP.md` / `REQUIREMENTS-TASKBOARD.md` / `PROMPT-ENGINEERING.md` 并补进索引 | `.local-plans/`、`.gitignore`、`doc/README.md`、`doc/*.md` | `check-repo-hygiene.mjs`（索引死链）+ `grep` 自查「还有没有指向旧路径的行」（0 条） |
| 10 | **按错误码决定是否作废发送游标**：新增 `CURSOR_INVALIDATING_CODES` 白名单，未列出的码（含空 code）**保留游标**、下一轮继续发增量，不再整段重建 | `lib/index.js` 的 `relay.submit(...).catch(...)` | `test/session-continuity.test.mjs` **④**（失败一轮后第三轮仍 `fresh=false` 且字符数 < 5,000） |

### 三、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 本轮新增 5 个护栏文件 | `session-continuity` **11/11**、`marker-typo` **10/10**、`markdown-block-integrity` **5/5**、`attach-probe-contract` **5/5**、`settings-transport` **6/6** —— 合计 **37/37 全绿**（逐文件跑，2026-09-17 实跑） |
| **全量单测（逐文件跑，lead 亲跑）** | **57 个文件 / 715 项通过 / 0 项失败 / 0 个失败文件**（`Get-ChildItem test/*.test.mjs` 逐个 `node --test --test-timeout=180000 <file>`，2026-09-17 22:1x 实跑） |
| **打包与装机（lead 亲跑）** | `pnpm pack` → `dsh-webcode-bridge-0.16.4.tgz`（410,808 字节）；`verify-pack` **36/36 逐字相同 + 接线完好**；`install-profiles` 装入 `profiles/web` 与 `profiles/headless` **均为 v0.16.4**；8 个改动文件 `sha256` 前 12 位与工作树**逐一相同**（index/browser-driver/agent-preset/idle-window/web-control/settings-page/client/dsml-repair）。**运行中的进程仍是 0.16.3——重启后才加载** |
| `lint-comments.mjs` | **error 0 / warn 0**，exit 0（**109 个文件**，2026-09-17 实跑） |
| `check-repo-hygiene.mjs` | **PASS**（BOM / 索引死链 / Node 版本三条全绿） |
| `check-ledger.mjs` | **PASS**（version 0.16.4 / testFiles 57/57） |
| 反向验证（**%TEMP% 等价拷贝**，工作区 lib/ 不留任何改动） | ① `session-continuity`：把 `noteLanded` 里落盘那一行等价去掉 → **①c 与 ⑨ 变红**（「失败的一轮之后会话槽是空的」）；② `settings-transport`：删掉 `if (o.transport === 'inline') …` 那一支 → **①变红**（mode 变回 attach）；③ `marker-typo`：词形宽容回滚成只认 DSML（`(?:DSML\|DSH\|DS)` → `(?:DSML)`，2 处）→ **②③⑨ 变红**（「解出 2 条调用（应为 3）」）；④ `markdown-block-integrity`：收尾不再把末段补发成 `text-delta` → **①②③⑤ 变红**（「下标 0 的块内容与 Σ text-delta 不逐字一致」）；⑤ `session-continuity`：把重建节流条件改成恒不成立 → **⑥ 变红**（「没有拿到 WEB_SESSION_REBUILD_THROTTLED，实际 WEB_SESSION_LOST」）。五条原始输出见本轮实施报告 |
| 一条**环境**读数（不是产品缺陷） | 「真 HTTP + 真 `apply()`」的护栏在 `--test-force-exit` 下会被判**文件级红**：两条断言都 ✔，进程收尾却报 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c line 94`。实测：`wiring-roster` 带该开关 **3/3 复现**、**不带则 2/2 全绿且进程自然退出**；把收尾改成 `await` + `closeAllConnections()`、或让响应带 `connection: close`、或加一个收尾 `setTimeout` 都**不能**消除 ⇒ 触发条件是这个开关本身（Windows + Node 24 的退出路径竞态）。因此 `wiring-roster` / `session-continuity` / `attach-probe-contract` / `settings-transport` 请用 `node --test <file>` 跑，不加 `--test-force-exit` |

### 四、取证 vs 推断（分开写）

**取证**（第一节四条 + 本节读数）：457 / 8 次的标记计数、navTrace 三次同形、
`attachTransport` 与 `attach-entry` 的两组字段、脚本驱动下 `fresh` 序列 `[true,false,true]`。

**推断**（尚无直接读数）：

1. 「块内容不一致」与用户那句「有些 markdown 渲染有些不渲染」是**同一件事**——本轮只证明了
   两条通道的字节会不一致（护栏可复现），**没有**真机截图或 DOM 读数把二者对上；
2. 会话槽丢失在别的站点（GLM/z.ai）是否同形，**没有读数**：本轮只看了一个 deepseek 会话；
3. 根因 2 的「457 次」来自**一个**会话的 dump，不能外推成「模型整体漂移率」。

### 五、仍未修完（不假装通过）

1. **0.16.4 未打包、未装机、未重启**：因此本轮全部读数都是**离线**读数；
   三条根因的真机验收（`ROADMAP.md` P1）必须在装机重启之后做。
2. `README.md:88` 仍写着「根目录 `PLAN*.md`、`REPORT.md` 是本地私有留痕」——
   它们本轮已移入 `.local-plans/`；该文件不在本轮的写范围内，留给下一轮同步。
3. **`--test-force-exit` 的环境噪声**（见 §三最后一行）：它不是产品缺陷，但会让
   「真 HTTP + 真 `apply()`」的护栏在全量跑里多出文件级红。跑这些文件时**不要**加该开关。

**已修完的两条（本轮内闭环，读数在上面）**：
`session-continuity` ④（上层游标归零 ⇒ 现在按 `CURSOR_INVALIDATING_CODES` 白名单判定）与
`markdown-block-integrity` ③（调用块之后的散文只在权威全文里时被丢掉 ⇒ 收尾已补发）——
两条判据都**没有放宽期望值**，是实现在它们上面改绿的。

## 0.16.3（已打包 / 已装 / 已重启生效）—— 三条真机读数：网页原话解得出、看门狗分相位、超长文本有上限

**用户原话**：「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了你说是
没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复……另外请你解决一个问题，
现在提示词有误参考的最佳工程实践？deepseek？然后是发送的纯文本太长了！」

本轮报错（用户逐字贴出）：

```
本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished） — 本轮已中止，可重试
```

### 一、三条真机读数（**取证**：每条都写清取法与数字）

| 读数 | 取法 | 数字 |
| --- | --- | --- |
| 网页原话能解出几条调用 | `POST /__webcode/history {"sessionId":"971db3e8-7ea6-4f63-ad41-c14bb44a6d27"}` 取 assistant 消息 → 逐字落成 `test/fixtures/dsml-real-14-step5-grep-pwsh.txt` → `parseAgentReply(text, {tools})` | **1204 字符 → calls=3（grep / pwsh / pwsh）、diagnostics=[]** |
| 失败会话那一步的跨度 | 解 `.dsh/sessions/…session-dff3edf7…/session.v3.jsonl.zstd`（29 帧） | turn1 **step5：18:41:59 → 18:43:51，112s 零事件**；同行 step1-4 **每步都有事件**（工具调用 2-4 条） |
| 发进网页的纯文本 | `POST /__webcode/history` 的 user 消息 | **127,888 字符**（工具教学 38,279 + 会话 transcript 89,609） |
| 首轮提示词总量 | `GET /__webcode/preset` | **409,555 字符** |

结论：**问题 1「真实工具调用被丢」在这一条物证上已经修好**（前 13 份夹具另见 §0.16.2）；
本轮报错与它**不是同一件事**——`WEB_NO_PROGRESS` 是看门狗开火，把「网页还在 prefill、
还没开口」当成了「网页不说了」。

### 二、本轮修复清单（每条都有护栏）

| # | 修复 | 位置 | 护栏 |
| --- | --- | --- | --- |
| 1 | 看门狗窗口**分相位**：首个事件之前 + 驱动在忙 → 常规 × 倍数；已开流 / 链路没跑起来 → 照旧快报 | `lib/idle-window.js`（`idleWindowDecision`）、接线 `lib/index.js` 的 `nextWithIdle()` | `test/idle-window.test.mjs` 17 项 + `test/watchdog-first-byte.test.mjs` 9 项 |
| 1b | 相位窗口给**驱动整轮预算**留余量：`totalBudgetMs` ⇒ 窗口 ≤ 预算 − max(1s, 10%)，被压过置 `capped:true`（否则 240s 与整轮 240s 同值赛跑，报错会退化成没有页面现场的 `web turn timed out`） | `lib/idle-window.js` | `test/idle-window.test.mjs` ⑧/⑧b/⑧c/⑧d/⑧e |
| 1c | 三层超时的**源码级顺序**判据（中继外层 > 驱动整轮 > 看门狗窗口） | `lib/index.js`、`lib/relay.js` | `test/timeout-order.test.mjs` 5 项 |
| 2 | 驱动现场读数进 `/status`：`lastActivityAt`、`domReplyChars`、`attachTransport`；超时报错带出前两者 | `lib/browser-driver.js` 的 `status()`、`lib/index.js` 的看门狗文案 | `test/watchdog-first-byte.test.mjs` ⑤ |
| 3 | 附件上传函数的**结构修复**：`uploadTextAttachment` 从 `uploadImages` 的 `if` 块体内移出（0.16.2 的形状靠函数声明提升侥幸能跑，相邻重构会变成静默回落 inline） | `lib/browser-driver.js` | `test/upload-attachment-structure.test.mjs` 4 项（含扫描器自检，防「框空 body」式假绿） |
| 4 | 附件**尺寸上限**：`attachMaxChars` 默认 1_500_000；超上限保**尾部**截断并写明「已省略前 N 字符」，绝不静默丢内容 | `promptTransportPlan` + `runTurn` | `test/prompt-transport-attach.test.mjs` 9 项 + `test/attach-callsite.test.mjs` 6 项（调用点真的调到、`attachTransport` 成败都留痕） |
| 5 | 真机回复**回归夹具 14**（网页原话 1204 字符 → 3 条调用、参数逐字相等、diagnostics 空） | `test/fixtures/dsml-real-14-step5-grep-pwsh.txt` | `test/dsml-real-reply-regression.test.mjs` 11 项 |
| 6 | `DSML_BAR` 注释纠错：该常量是 `String.fromCharCode(0xFF5C) × 2`，注释按真机码点读数改写 | `lib/agent-preset.js` | 夹具 14 的首 12 码点断言（源码里用码位现造，不粘贴该字符） |

### 三、取证 vs 推断（**分开写**，别混）

**取证**（§一 的四条读数都属于这一栏，取法逐条写在表里）：网页原话 1204 字符、calls=3、
diagnostics 空；失败会话 step5 跨度 112s 零事件、step1-4 每步有事件；发进网页的纯文本
127,888 字符；首轮提示词 409,555 字符。驱动新增的三个字段可直接在 `GET /__webcode/status`
核对。

**推断**（尚无直接读数，缺哪一条写在里面）：

1. 「12.8 万字符输入 ⇒ prefill 超过 120s」是**推断**：直接量到的只有「112s 零事件 + 页面
   `busy` + 同一轮其它步骤事件正常」。**首字节第几秒到达，没有任何读数记录过**——新报错文本
   带 `最近驱动活动` / `页面已有 N 字回复未回传`，就是为了让**下一次**能量到它。
2. 「网页那侧在 18:43 之后是否真的产出了完整答复」**未被证实**：只有那一刻的**页面 DOM
   读数**（`domReplyChars` / 截图 / 网页会话里的 assistant 条目）能证实，这次没有落盘。
   桥侧「零事件」只证明**捕获链没收到东西**，不能证明网页没生成。
3. 「走附件更快/更稳」**未被证实**：0.16.3 起 `attachInlineLimitChars` 默认 **60,000**
   （超阈值即走附件），但本轮**没有真机配对数据**——「真的上传成功」「模型真的读了附件」
   两条都只能在重启后由真机读数验证（见下）。

### 四、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 新增 4 个测试文件（逐文件跑） | `dsml-real-reply-regression` **11/11**、`idle-window` **17/17**、`prompt-transport-attach` **9/9**、`upload-attachment-structure` **4/4**（四个一起跑：**36/36**，退出 0） |
| 全部测试文件（逐文件跑） | **52/52 全绿，0 个失败文件**（`node --test --test-timeout=90000 test/<每个文件>`；一轮循环跑完 51 个共 **671 项通过**，`attach-callsite` 随后单独跑 6/6；2026-09-17 实跑） |
| 反向验证（**%TEMP% 等价拷贝**，工作区不留任何 lib/ 改动） | 结构护栏：拿**已安装 0.16.2** 的原文件跑 → ①② 变红（信息含「结构被破坏」）；DSML 回归：把 `normalizeDsml` 回滚成恒等 → ②③⑤⑦⑧b 变红（`calls=0`，即用户看到的那件事）；`idle-window`：四种错误改法（mid-stream 也乘倍数 / 真值判断 firstEventAt / 驱动不忙也宽限 / baseMs 不回落）分别让 ②②b③b④⑥ / ②b③b④ / ③ / ④④b⑥⑦ 变红，另三种（忽略预算 / 去掉小预算保护 / 余量置 0 造成同值赛跑）分别让 ⑧⑧d / ⑧d / ⑧⑧e 变红；`prompt-transport-attach`：三种改法（上限参与 mode 判定 / 取消默认上限 / 非法上限当默认）分别让 ①④⑤ / ①② / ③ 变红 |
| `lint-comments.mjs` | error 0 / warn 0（104 个文件，2026-09-17 实跑） |
| `check-ledger.mjs` | **PASS**（version 0.16.3 / testFiles 52/52，2026-09-17 实跑） |
| `check-repo-hygiene.mjs` | **PASS**（无 BOM / 索引无死链 / Node 版本相容，2026-09-17 实跑） |

### 五、用户需要知道的配置项（0.16.3 新增）

- **`idleFirstByteMultiplier`（默认 2）**：首个 token 之前的看门狗窗口 = 常规窗口 × 该值
  （默认 120s → 240s）。**这不是「把超时调大」**，而是把「网页还没开口」与「网页不说了」
  分成两个相位——只有「本轮还没有任何事件」**且**「驱动报告本轮仍在忙」这一格才乘倍数。
  **设 1 即逐字恢复旧行为**；按自己网页的启动速度调即可。
- **`attachInlineLimitChars`（默认 60,000）**：超过这个字符数就把提示词改走**附件**投递
  （真机依据：127,888 字符纯文本的一轮，step5 有 112s 零事件——网页在 prefill，被 120s
  看门狗判死）。普通单轮增量（几十~几千字符）仍然逐字走 inline，行为不变。
  **写 0 = 关闭**，逐字恢复 0.16.2 行为。附件投递途中任何一步失败（没有上传入口 /
  页面没出现附件）都会**回落 inline**，并把结果记进 `/status` 的 `attachTransport`。
- **`attachMaxChars`（默认 1_500_000）**：附件投递的尺寸上限；超过就保留**尾部**再上传，
  并在文件开头写明「已省略前 N 字符」。真机最大一轮 409,555 字符，离上限还很远。
- **相位窗口与整轮超时的关系（无需配置，但要知道）**：宽限后的相位窗口原本是
  `120s × 2 = 240s`，与驱动整轮预算 `requestTimeoutMs`（默认 240s）**同值**——谁先开火由
  事件循环决定，而整轮超时的报错**没有相位、没有页面现场**。现在相位窗口被压到整轮预算的
  90%（默认 240s → **216s**），保证先开火的是信息更全的那个报错；`capped:true` 就是
  「这个窗口被预算压过」的标记。

## 0.16.2（已打包 / 已装 / 待重启）—— 三个真机问题：调用被丢、提示词教错、纯文本 40 万字符

**用户原话**：「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了
你说是没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复……另外请你
解决一个问题，现在提示词有误参考的最佳工程实践？deepseek？然后是发送的纯文本太长了！」

---

### 一、取证方法：第一次拿到「网页实际发出的字节」

本轮与以往所有修复的根本区别是**取证方向**。历史修复反复不中的共同点，是只有 harness
侧的读数（「正文停了」「只有思考」）。这轮用桥自己的**只读控制面**取网页那一侧的原话：

```powershell
POST http://127.0.0.1:8931/__webcode/history  body: sessionId
node .tmp/capture-dsml-fixtures.mjs      # 逐字落成 test/fixtures/dsml-real-*.txt
```

13 份真机夹具，网页实际发出的是 **DeepSeek 原生 DSML**（标记字符是全角竖线）。

### 二、问题 1：真实工具调用被丢（红基线可复现）

| 夹具 | 形态 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| dsml-real-13 | 闭合标签**连名字都省掉** | calls=0 | calls=2 |
| dsml-real-7 | **漏写 invoke 开标签**，直接 parameter 起写 | calls=0 | calls=2 |
| 其余 11 份 | 正常 | 正常 | 正常 |

**这正是「说有工具调用、又说没有正文」**：探测命中、解析为 0 条 → 协议被 proseSafeEnd
整段扣住 → 只剩散文或空 → 交回 TOOL_CALL_UNPARSED。

修法：新增 `lib/dsml-repair.js` 的 `resolveNamelessClosers`，在 `normalizeDsml` **之前**
跑栈式还原（无名闭合补名、缺外壳补空名壳），并让 invokeOpenRe 接受空名字。
**保守判据**：只对带 DSML 标记的标签动手；散文里的裸 parameter 一律不动。

护栏：`test/dsml-native-close.test.mjs` **22 项**（13 份夹具逐份 + 9 条判据，含 6 条反向安全线）。

### 三、问题 2：提示词在对抗模型的既有先验

旧提示词教「标签包裹 + 裸 JSON」。**13/13 份真机夹具里模型一次都没用过它**
——它用的是本网页原生的 DSML。即提示词让模型做一次格式翻译，翻译中途的形态漂移正是
问题 1 那两族的来源。

修法：deepseek 站点改教**原生 DSML 骨架**，三处同源（首轮教学 / 首轮传输协议 / 增量轮
再教学），由 DSML_ONE_LINE 与 dsmlSkeleton() 单点定义。**其它站点逐字不变**。

### 四、问题 3：纯文本 409,555 字符

实测（`GET /__webcode/preset`）：

```
TOTAL 409,555
  工具教学（preset）        38,241  ( 9.3%)
  会话 transcript         370,985  (90.6%)   ← 其中 DSH 系统指令 279,223
  传输协议                     329
```

修法：纯函数 promptTransportPlan 决定 inline / attach；超阈值且有附件能力时把长文本作为
.md 附件上传，composer 只发**短指令**；任何一步不成立（无上传入口 / 附件未确认）
→ 回落 inline。**默认 0 = 关闭**，即不配时行为与 0.16.1 逐字相同。

风险已写进代码注释：上传是有副作用的动作（可能撞风控）、模型未必读附件（因此正文里明确
要求它先读）、附件确认依赖可见预览节点（站点改版即失效，走既有 ATTACH_NOT_CONFIRMED）。

护栏：`test/prompt-transport.test.mjs` **8 项**（3 正向 + 5 反向安全线）。

### 五、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 全部 45 个测试文件（逐文件跑） | **45/45 全绿，0 失败** |
| `test/dsml-native-close.test.mjs` | **22/22**（13 份真机夹具全解析、无泄漏） |
| `test/prompt-transport.test.mjs` | **8/8** |
| `lint-comments.mjs` | error 0 / warn 0（96 个文件） |
| `check-ledger.mjs` | PASS（version 0.16.2 / testFiles 45/45） |

### 六、一次被自己的护栏抓住的漂移（记下来）

改提示词时顺手把一句**所有站点共用**的话从「多个工具调用代码块」改成「多个工具调用」，
`prompt-variants.test.mjs` 的「默认路径零位移」断言立刻变红——它逐字比对 0.14.7 基线。
**已回退**。这正是那条护栏存在的意义：默认路径的任何位移都必须是有意的、有据的。

## 0.16.1（已打包 / 已装 / 未重启）—— 桥自有 Team/任务数据层：磁盘回落让「卸载 AgentTeams」成立

**用户原话的第三件事**：「将 agent team 卸载」。0.16.0 只做完了左栏入口，这一轮做的是
**卸载的前提**——没有它，卸载等于连面板一起卸掉。

### 一、为什么「读官方服务」这一条链本身就挡住了卸载

桥的 Team / 任务板两个面板从 0.15.0 起只读官方 `agentTeams` 服务
（`lib/roster.js` 的 `projectTeam` / `projectTasks`）。这条链有一个结构性后果：
**那个包一旦不在，面板永远是空的**。于是「取代 AgentTeams」在实现上无从落地——
用户看到的是「卸载之后面板也没了」，读起来像桥坏了。

### 二、第二个来源不是「绕开官方读私有格式」

AgentTeams 自己就把磁盘当真相来源。第三方实现（`@nanmicoder/dsh-agent-teams`）的
`lib/snapshot.js` 开头逐字写着：

> read the durable team files (**the truth source**) and enrich with live subagent
> activity, so the panel always reflects the on-disk state even when a model skipped
> a tool "ritual"

即：**运行时 activity 是叠加在磁盘事实之上的**，磁盘才是底。桥读的是这份公开约定的
落盘格式（`.agent-teams/<teamId>/team.json`），与官方服务读的是同一份文件，
不存在第二套格式、也没有私有字段。

### 三、优先级与错误口径（刻意如此）

新增 `lib/team-state.js`（纯函数 + 只读 fs），`lib/roster.js` 改为**双来源分派**：

| | 行为 |
| --- | --- |
| 官方服务可用 | 用服务（它多给实时 `activity` 与官方算好的 `ready`），`source: 'service'` |
| 服务不可用、磁盘有本会话的团队 | 用磁盘行，`source: 'disk'`，另带 `serviceError` 说明服务为何不可用 |
| 两边都读不到 | 报**服务那一侧**的原因（主来源），`source: null`，磁盘原因放 `diskError` |

**为什么错误口径要这样**：既有的错误字符串（`caller-not-live` /
`agentTeams-service-has-no-listMembers` / `no-session-id` …）逐字不变，因此既有护栏与
用户读到的解释都不受影响；磁盘那一侧的细节另开字段，不覆盖主来源的结论。

### 四、三条「不造假」的具体落点

1. **不跨会话张冠李戴**。只认 `captainSessionId` 与当前会话**逐字相同**的团队；磁盘上
   有别人的团队时如实报 `no-team-for-this-session: N-other-team(s)-on-disk`，绝不拿它
   顶替——这正是 0.15.3 那个「读到别人的 lead」缺陷的同族病根。
2. **不算 `ready`**。磁盘行**不带 `ready` 键**，交给 `task-graph.js` 按官方判据现算并标
   `readySource: 'computed'`。官方给了就不重算这条判据已经在那一层，在这里再算一遍
   就是第二份真相。
3. **不猜工作区根**。`cwd` 只从 `sessions.get(sessionId).header.cwd` 取；拿不到就返回
   `no-session-cwd`，而不是 `path.join(undefined, …)` 拼出一个**看起来正常但永远读不到**
   的路径。

另外：`archive/` 被排除（那是已删除团队的归档，否则删掉的团队会重新出现在面板上）；
`inScope`/`dependencies`/`attempt`/`assignee` 分别映射成面板已有的
`writeScopes`/`blockedBy`/`revision`/`ownerName`，同一份 UI 消费两边。

### 五、界面上必须能看出「数据从哪来」（新增 `teamSource` / `tasksSource`）

磁盘回落时成员**没有实时 activity**，于是「空闲」会被读成「真的空闲」，而不是
「这里没有实时数据」。因此 `projectRoster` 新增 `teamSource` / `tasksSource` 两个标注，
两个面板各渲染一行来源说明（`来源：AgentTeams 服务` / `来源：磁盘状态（AgentTeams 未提供实时数据）`）。
来源本身也是一条状态——这是本仓库「不造假状态」纪律的直接延伸。

### 六、实际卸载动作（profile 层）

`~/.dsh/profiles/web/package.json` **两处**同时摘掉第三方 `@nanmicoder/dsh-agent-teams`
（`dependencies` + `dsh.profile.bundles`），并顺手修掉一个真隐患：
`dsh-webcode-bridge` 的依赖路径还钉在 **0.15.11 的 tgz** 上，而工作树早已 0.16.x——
那是「改了没生效」纪律下最容易复发的一处。改前已备份
（`package.json.bak-20260917-115436`）。

**保留官方三个包**（`dsh-experimental-agent-team{,-profile,-tool-agent-team}`）：
桥的回落链只在服务不可用时接手，官方服务在时仍是首选；摘掉它等于主动放弃实时
activity。用户要卸载的是**重复实现**，不是官方那一套。

### 七、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `node --check`（`team-state.js` / `roster.js` / `client.cjs`） | 三个都 exit 0 |
| 全部 41 个测试文件（逐文件跑） | **41/41 全绿，0 失败** |
| `test/roster.test.mjs` | 27/27（含新增键集断言与来源为 null 的断言） |
| `test/client-render.test.mjs` | 33/33 |
| `check-ledger.mjs` | PASS（version 0.16.1 / testFiles 41/41） |
| `lint-comments.mjs` | error 0 / warn 0（88 个文件） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / Node 版本） |
| `verify-pack` | **31/31 逐字相同** + 接线完好（新增 `team-state.js` 后从 30 涨到 31） |
| 安装 | web profile **v0.16.1**，`team-state.js` 在位，`nanmicoder` 已从 deps 与 bundles 消失 |

### 八、一次自己踩到的坑（记下来）

第一次 pack 0.16.1 之后**又改了 `client.cjs`**（加来源标注），tarball 于是落后于工作树——
正是 `doc/verify.md` 里 0.14.4 记过的那个陷阱。`verify-pack` 一跑就照出来（当时若跳过这一步
就会装上一份半旧代码）。已删除重打，第二次 31/31 通过。**结论不变：pack 之后任何改动都必须
重打 + 重验，不能只看命令退出码。**

### 九、仍未做真机验收（不假装通过）

**重启 DSH 之前，以下四件事都只是静态证据**：

1. 左栏「新开对话」下方是否真的出现任务板入口（0.16.0 的 `sidebar.panellist`）；
2. 点它是否切到中央列任务板（`main` 座位 key 与 id 同名）；
3. 卸载第三方包之后，Team / 任务板是否由磁盘回落显示出来（`来源：磁盘状态` 那一行）；
4. 官方 `agentTeams` 服务是否照旧工作（来源应显示 `AgentTeams 服务`）。

当前进程里跑的是旧代码（0.15.9），所以第 3、4 条**必须**重启后才能看到。

## 0.16.0（已打包 / 已装 / 未重启）—— 任务板进左栏：走官方 `sidebar.panellist`，不走 DOM 注入

**用户原话**：「把任务板入口放在左栏那里固定，新开对话下方，参加 task board，然后你想办法将
team 的面板保持原地，但是做到可以取代 agent team 完好设计逻辑理念，将 agent team 卸载」。

本轮先做**能做完的那一半**（左栏固定入口），并把另一半的真实阻塞点查清（见文末）。

### 一、先说清「参考实现为什么走 DOM 注入，而这里不必」

`reference/dsh-task-board` 的 `src/client/sidebar-entry-core.ts` 开头逐字写着：

> dsh's sidebar shell exposes no slot an external plugin can register into
> (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already taken),
> so the entry row is injected between the shell's New Session button and the
> workspace browser.

**那个前提在官方这一版已经变了。** 实测 slots 目录（`cordis_inspect_query` →
`client/Slots/listSubTree`）里 `sidebar.panellist` 是存在的，契约原文是：

> Global panel icons. **Each list id addresses the matching main panel**; the sidebar
> owns the button and resolves its label from list metadata.

对比两条路线：

| | DOM 注入（参考实现） | `sidebar.panellist`（本轮） |
| --- | --- | --- |
| 按钮本体 | 自己 `createElement('button')` | **shell 画**（`PanelRow`：Tooltip、`aria-current`、选中高亮） |
| 位置 | `insertBefore` 抢，靠 `[class*="newSession"]` 模糊匹配 | shell 渲染顺序即 `logoRow → New Session → panelList → workspace`，**结构保证** |
| 重渲染 | `MutationObserver` 自愈 | React 自己管 |
| 折叠态 | 自己复刻 56px 轨道样式 | shell 给 `size: wide ? 16 : 18` |
| 键盘可达 | 要自己补 | 天生正确 |
| 官方改 class 名 | 静默插错位置 | 不受影响 |

所以本轮**不引入那条路线**。「取代 agent-team 的设计理念」要保留的是「左栏固定入口 +
中央列面板」这个**交互结构**，而它现在能用官方一等公民的槽实现——比 DOM 注入更强。

### 二、两半必须成对（这是本轮唯一的真陷阱）

契约后半句是关键：「Each list id **addresses the matching main panel**」。侧栏行只是一个
指向 `main` 座位的按钮，点击走 shell 的 `selectPanel(id)`，而 layout service 会**校验该 key
是否已注册**：

```
layout.selectPanel: main panel "X" is not registered
```

只注册侧栏那一半 = 界面看起来正常、**点一下就报错**。因此两半的 id 与 key 必须逐字相同，
护栏也按「成对且同名」写（`★ 左栏入口：sidebar.panellist 与同名 main 座位必须成对注册`）。

### 三、改了什么

| 位置 | 内容 |
| --- | --- |
| `lib/client.cjs` 顶部注释 | 「三块界面」→「四块」，补第 4 条（左栏入口 + 同名 main 页面） |
| `lib/client.cjs` `TaskBoardPanelIcon` | 内联 SVG（16 viewBox / stroke-width 1.3 / currentColor）。**不引官方 primitives**：里面没有依赖图语义的图标，队列图标表达的是「排队等待」，会读成发送队列。**不自绘 button、不挂 onClick**——按钮与可访问名归 shell |
| `lib/client.cjs` `TaskBoardMain` | 主列页面容器（`.hwb-main` 滚动 + `h1` 页内标题），内部**复用同一个 `TaskBoardPanel`**——同一语义只画一次，否则「右栏说被阻塞 2、主列说被阻塞 3」迟早出现 |
| `lib/client.cjs` 注册处 | `sidebar.panellist`（`id=webcode-tasks-panel`、`order=40`、`label` 为 thunk）+ `main`（`key` 与 id 逐字相同） |
| `lib/client.cjs` 样式 | `.hwb-main` / `.hwb-main-head`；`box-sizing` 显式写，少它 padding 会把容器撑出可视区、底部永远滚不到 |
| `test/client-render.test.mjs` | 桩新增收 `sidebar.panellist` 与 `main` 两类登记并回传；新增 2 条用例（成对注册 / 图标不得自绘 button） |

### 四、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `node --check lib/client.cjs` | exit 0 |
| `test/client-render.test.mjs` | **33/33 通过**（新增 2 条） |
| `check-ledger.mjs` | PASS（version 0.16.0 / testFiles 41/41） |
| `lint-comments.mjs` | error 0 / warn 0（87 个文件） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / Node 版本） |
| `test/regression.test.mjs` | 53/53 通过（547 s，本机慢是已知的） |
| `test/mirror.test.mjs` | 7/7 通过（首轮批次里那次失败是 fetch 到本地端口的瞬时错，`git stash` 后在**干净树**上重跑仍 7/7，已排除本轮改动） |

### 五、没做完的那一半，以及它卡在哪（不假装通过）

**「将 agent team 卸载」本轮没有执行。** 查清了事实，但它不是一个「改一行配置」的动作：

1. **桥的两个面板依赖官方 `agentTeams` 服务**，不是依赖第三方包。`lib/roster.js` 的
   `projectTeam` / `projectTasks` 读的是 `ctx.agentTeams` 的 `listMembers` / `listTasks`。
   该服务的注册点是 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js:96` 与 `:1680`
   的 `super(ctx, "agentTeams")`。
2. **当前 profile 里同时装了两套重叠实现**（`profiles/web/package.json`）：
   `@deepseek-ai/dsh-experimental-agent-team*`（官方，0.1.5-alpha.2）与
   `@nanmicoder/dsh-agent-teams`（第三方，0.1.18）。两边注册的工具名**故意重叠**——
   官方 profile 层的 `cordis.patch.yml` 注释原文就是「remove the global continuable-child
   controls before the scoped Team tools register the overlapping `list_agents`、
   `send_message`、`interrupt_agent` names」。本会话的工具表里两套名字同时在场。
3. 因此**卸载第三方包之前必须先确认桥不依赖它的任何东西**。已知第三方包提供的是
   `agent_teams_*` 工具（`lib/tool-names.js`）与一个 `shell.overlay` 悬浮面板
   （`lib/client.js:3684`），**不提供 `agentTeams` 服务**；但「工具名从哪来」这条链
   在真机上还需一次核对（会话工具表里 `agent_teams_*` 与官方的 `spawn_teammate` /
   `team_task_*` 并存，两套都在）。
4. 卸载本身要改 profile 的 `dependencies` + `dsh.profile.bundles` 并重装——那是**环境
   变更**，按仓库纪律（`doc/verify.md`）应在重启后做真机验收，且要先确认左栏入口在真机
   真的渲染出来（本轮只到单测与源码闸门，**未做真机目视**）。

**下一步（下一轮该做的）**：打包 0.16.0 → `verify-pack` → 装 profile → 重启 → 目视
左栏「新开对话」下方是否出现任务板入口且点击能切到中央列 → 再据实决定卸载第三方包的
改动清单。

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

## 2026-09-17 CI 全红修复（无产品代码改动）—— 三条独立红因，一条新的机器判据

**用户报的是「CI 在 GitHub 上一直是红的」。** 实测 run `35137367183`（`6bcba7c`）四条腿
**全红**，且**红在两处不同的地方**——这是先要看清的事：

| 腿 | 红在哪一步 | 退出码 |
| --- | --- | --- |
| `ubuntu-latest, node 20` | **第 5 步「安装依赖」** | 1（测试一步都没跑） |
| `windows-latest, node 20` | **第 5 步「安装依赖」** | 1（同上） |
| `ubuntu-latest, node 22` | 第 9 步「reference 来源表一致」 | 1 |
| `windows-latest, node 22` | 第 9 步「reference 来源表一致」 | 1 |

即：Node 版本是**一个**变量，`gen-reference-index.mjs` 是**另一个**。三条根因：

### 一、Node 20 那两条腿跑不起来（`ci.yml` + `engines.node`）

日志原文（`ubuntu-latest, node 20`）：

```
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Process completed with exit code 1.
```

根因不是「Node 20 有回归」，而是**两处版本声明互相矛盾**：`package.json` 的
`packageManager` 钉的是 `pnpm@11.25.0`（要求 Node ≥22.13），矩阵里却放着 Node 20。

**这一条此前被一个错误的结论掩盖着**：`ci.yml`、`doc/ci-cd.md` §3.2、`CONTRIBUTING.md` ②
三处都写着「Node 20 上 `pnpm test` 会因 glob 失败」，并据此给 Node 20 写了一段
「用 bash 展开 glob」的专用命令。那段分流**从来没有被执行过**——失败在它之前。
一个为错误前提写的补丁，恰好让人不去看真因。三处文字已全部改正。

修法（三者对齐）：`engines.node` → `>=22.13`；矩阵 → `[22, 24]`；删掉 glob 分流，
两平台四条腿跑**同一条** `pnpm test`。

### 二、`gen-reference-index.mjs --check` 自己就是坏的（退 2，不是退 1）

本机复现：

```
[ref-index] 脚本自身失败：ReferenceError: README is not defined
    at main (scripts/gen-reference-index.mjs:179:24)
```

`--check` 分支引用了两个**从未定义过的**标识符（`REF` 与 `README`），一走到那里就抛
`ReferenceError`、以退出码 2 结束。它被 `ci.yml` 与 `ci-local.mjs` 同时当作**阻断闸门**调用，
所以那不是「少跑一道检查」，而是**每次 CI 都红一次、且红在一个与改动无关的地方**。
根因是 `refDirOf()` 写了却没人调用——`--root` 这个为测试留的入口是死代码。

修法：路径只经由 `refDir` 一个变量流动（`readme` 与存在性判断都用它），
`--root` 覆盖因此在 `--check` 路径上同样生效；顺带复用已算好的 `table`，
不再让「打印的表」与「校验的表」各算一遍。

### 三、闸门修好之后，它立刻抓到一条真漂移

修好 `--check` 后本机实跑，**它报出 3 条与磁盘不一致**（此前被 `ReferenceError` 掩盖着）：

- `dsh-file-attachment`（1.9 MB）在磁盘上、可克隆，但**没登记进来源表**；
- `dsh-task-board`（1.5 MB）、`dsh-archive-manager`（0.5 MB）是 2026-09-17 新解包的副本，
  同样没进表。

已重新生成 §4 的表写回 `reference/README.md`，并修正 §3 的两处过期计数
（「6 份 md」实为 7 份、「33 个 clone」实为 34 个）。`--check` 现在 **exit 0**
（校验 39 个本机存在的条目）。

### 四、`reference/` 下四个幻影 submodule（CI 收尾时会被 git 摸到）

实测 `reference/` 下有 **4 个 gitlink**（mode `160000`）：`deepseek-web-import`、
`dsh-deepseek-chat`、`opencode2dsh`、`webcode`——它们**入库了**，被 git 当成 submodule 条目。
而仓库**没有 `.gitmodules`**，于是任何 `git submodule foreach` 都会报：

```
fatal: No url found for submodule path 'reference/deepseek-web-import' in .gitmodules
```

这正是 `actions/checkout` 的 post 步骤在每条腿上都会打印的那条 warning。根因是某次
`git add reference/<clone>` 绕过了 `.gitignore:9` 的 `reference/*/`（README §2 已把这条陷阱写在案）。

修法：`git rm --cached` 这四个条目（**只动索引，不删磁盘上的克隆**）。
`reference/` 现在只剩 `README.md` 与 `local-refs/` 被跟踪——与 §2 的约定一致。

### 五、新增判据 C：CI 矩阵必须与 `engines.node` 相容

本次事故的形状是「改了一处人写的声明，没人去改另一处」。因此在
`scripts/check-repo-hygiene.mjs` 加了判据 C，直接比对 `ci.yml` 的 `matrix.node`
与 `package.json` 的 `engines.node`：矩阵里出现**低于最低声明版本**的大版本会红，
矩阵**没有覆盖**最低声明大版本也会红（只测更高版本会放过「最低版本上跑不起来」）。

已做**反向验证**：把矩阵临时改回 `[20, 24]`，闸门实测 `FAIL(2)` 并逐条指出问题；
改回 `[22, 24]` 后 `PASS`。**判据按大版本比较**，不试图复刻 semver 全套规则
（`>=22.13` 配矩阵 `22` 是允许的，setup-node 取最新 22.x）。

### 本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `lint-comments.mjs` | error 0 / warn 0，exit 0（85 个文件） |
| `check-ledger.mjs` | PASS（version 0.15.11 / testFiles 40/40） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / **Node 版本** 三条全绿）；`--self-test` 通过 |
| `check-commit-msg.mjs --self-test` | 10 正例 + 6 反例全部符合预期 |
| `gen-reference-index.mjs --check` | **exit 0**（修好前是 exit 2） |
| `ci-local.mjs --fast` | **7/7 PASS** |
| `bench-offline` | 14/14 通过（7 题 × 2 变体） |
| 40 个测试文件 | **40/40 全绿**。注意 `node --test` 在本机整体跑会 spawn EPERM（见「已知环境约束」），
所以这是**逐文件**跑出来的读数：`Get-ChildItem test\*.test.mjs` 逐个 `node <file>`，失败 0 |

## 2026-09-17 CI 全红修复（第二轮）—— 修完之后，**真问题才浮出来**

上一条修完后 CI 立刻跑出新结果：四条腿**仍红**，但**红的位置全变了**——这本身就是进展：
Node 20 的两条腿不再死在 `pnpm install`，`ref-index` 也不再 ReferenceError。

| 腿 | 现在红在哪 |
| --- | --- |
| `ubuntu-latest, node 22` / `node 24` | `pnpm test`：**2 条测试失败**（首次真正跑到测试！） |
| `windows-latest, node 22` / `node 24` | `ref-index`：仍报 1 条不一致 |

### 六、`ref-index` 为什么修完还红：**大小列不该参与比对**

Windows runner 报 `local-refs` 与 README 不一致，两边**只有「大小」一格不同**
（本机 1.4 MB / CI 1.5 MB）。根因是大小**不是磁盘内容的属性，而是 checkout 方式的属性**：
`local-refs/` 是唯一入库的 `reference/` 条目，里面是文本，而 `core.autocrlf` 会让同一份
文件在不同平台上落成不同字节数。于是这一格对「来源能否复现」**零信息量**，
却让闸门在干净克隆（= 只有 `local-refs` 存在）上**永远不可能通过**。

这正是文件头自己警告的那类假红。修法：`comparableLine()` 只比对**可复现的两列**
（remote 与 HEAD），大小保留在表里供人阅读但不参与判定。

已做两次验证：

- **正向**（复现 CI 条件）：只放 `local-refs` + 仓库里真实的 README → `--check` **exit 0**；
- **反向**（确认没被改瞎）：把 README 里 `local-refs` 的 remote 改成别的地址 →
  仍然 **exit 1** 并逐字打印两边差异；只改大小 → **exit 0**（正是想要的语义）。

### 七、两条 Linux 专属测试失败：**都是测试的跨平台 bug，不是产品缺陷**

这是本条最值得记的事：这两条测试**从来没有在 Linux 上跑过**（此前 CI 死在更早的步骤），
所以它们一直是「只在 Windows 上被验证过」。CI 第一次真正跑到测试，就把它们照出来了。

**① `prompt-variants.test.mjs`：零位移基线把宿主 OS 名写死了。**

断言是「模板逐字零位移」，但基线是从 Windows 抄的，里面含
`运行环境：Windows（Node v24.18.0）`。Linux 上 `platformNote()` 正确地输出 `Linux`，
断言于是报「文本发生了位移」——差异行却只有那一个词。**模板根本没变**，
变的是宿主。测试原本只归一化了 Node 版本号，漏了 OS 名。

修法：归一化**两项**（OS 名 + Node 版本）。OS 名映射在测试里**独立重写一份**，
不去调 `lib` 的 `platformNote()`——否则断言会退化成「函数等于它自己」，模板被改坏也不红。

**② `site-mount.test.mjs`：白名单测试用了 Windows 专属路径。**

它拿 `Z:\definitely\not\here` 当「白名单之外」的样本。在 Windows 上那是另一个盘符，
必然在白名单外；但在 Linux/macOS 上 `Z:\...` 只是**一个普通相对文件名**，
`path.resolve` 会把它拼到 cwd 下——**恰好落在本包树里**（= 白名单根之一），
于是先撞上「不存在」分支，报的是 `源 profile 目录不存在` 而不是 `允许范围`。

**产品行为是对的**（白名单判定本身没坏），坏的是测试选的样本路径。
修法：改用 `path.parse(os.homedir()).root` 下的同级目录，任何平台上都在 home 之外；
并加一条前提断言，防止将来有人把样本挪回 home 之内而让这条测试悄悄失去意义。

### 八、为什么这两条「测试 bug」值得单列

它们不是「CI 环境不好」，而是**跨平台承诺没有被真的验证过**：
README 说支持 Windows 与 macOS/Linux（`platformNote` 专门按平台改写指令），
但守护这份承诺的测试只在 Windows 上跑过。`doc/ci-cd.md` §7 早就写明
「两平台失败的**原因通常不同**」——这一轮正好是那句话的实例：
Windows 腿红在 `ref-index`，Linux 腿红在测试，两组原因毫无关系。

### 本轮第二轮验证读数

| 项 | 读数 |
| --- | --- |
| 40 个测试文件（本机 Windows 逐文件） | **40/40 全绿** |
| `gen-reference-index.mjs --check` | exit 0；干净克隆条件下 **exit 0**；构造漂移 **exit 1** |
| `lint-comments` / `check-ledger` / `check-repo-hygiene` / `check-commit-msg --self-test` | 全部 exit 0 |
| `ci-local.mjs --fast` | **7/7 PASS** |

### 本轮零产品代码改动

只动了 CI、脚本与文档：`.github/workflows/ci.yml`、`scripts/gen-reference-index.mjs`、
`scripts/check-repo-hygiene.mjs`、`scripts/ci-local.mjs`、`reference/README.md`、
`package/dsh-webcode-bridge/package.json`（仅 `engines.node`）、`README.md`、
`CONTRIBUTING.md`、`doc/ci-cd.md`、本文件。**插件版本号不变（仍 0.15.11）**，
因此不需要重新打包或重启。

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

---

## 0.16.3 附录：超长纯文本改走附件的取证、命令与连带发现

> 本节是上文 `## 0.16.3` 的**同一版本补充取证**（不另开版本号）。
> 计划原文见根目录 `PLAN-2026-09-17-0.16.3.md`（本地私有留痕，不入库）。

本次报错（逐字）：

```
本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished） — 本轮已中止，可重试
```

### 一、取证（三条读数，全部来自桥自己的只读面，可复核）

| # | 读数 | 取法 | 原始值 |
| --- | --- | --- | --- |
| 1 | 网页真实回复**确实存在且可解析** | `POST /__webcode/history {"sessionId":"971db3e8-…"}` → 再喂给 0.16.2 的解析器 | assistant 消息 **1204 字符**，解出 **calls=3**（grep / pwsh / pwsh），`diagnostics` 空 |
| 2 | 失败会话 turn1 **step5 跨度 112s 且全程零事件** | 解 `.dsh/sessions/…session-dff3edf7…/session.v3.jsonl.zstd`（29 帧） | step5 在 **18:41:59 → 18:43:51 无任何事件** → 看门狗开火 |
| 3 | 发进网页的纯文本 **127,888 字符** | `POST /__webcode/history` 的 user 消息 | 工具教学 **38,279** + 会话 transcript **89,609** |

### 二、取证能推出什么、不能推出什么（这两段必须分开读）

**取证**：

- 读数 1 证明「网页没返回正文」的旧结论**是错的**——网页有回复，是桥没解析出来
  （0.16.2 已修，本轮只补回归：真机夹具 14 + `test/dsml-real-reply-regression.test.mjs`）。
- 读数 3 是读数 2 的输入端：12.8 万字符一次性贴进输入框，DeepSeek 网页要**重新 prefill
  整个上下文**才吐第一个 token；而看门狗自「上一次事件」起 120s 内看不到任何新事件
  （连思考增量都没有）就把这一轮判死。
- 读数 2 里 step1-4 每步都有事件（工具调用 2-4 个），说明**捕获链是活的**，「链路坏」不成立。

**推断（标注清楚，不要当成取证）**：prefill 12.8 万字符是 step5 那 112s 无事件的**唯一可信
解释**——依据是读数 2（零事件）+ 读数 3（输入量）+「捕获链活着」三项；但我们**没有**同时抓到
「网页侧 prefill 起止时刻」与「桥侧事件流」的配对时间线，因此这是**归因推断**，不是直接观测。

> 一个与步调无关的坑：失败那一刻 `lastEndReason=finished` 是**上一轮**的收束原因（它是
> 「最近一次收束」而不是「本轮状态」），当时的复盘把它当成本轮线索用过一次。看门狗分相位
> （0.16.3）正是为了不再需要这种猜测。

### 三、修了什么（对应 `PLAN-2026-09-17-0.16.3.md` §3.1/§3.2）

- **接线缺陷（真缺陷，先修）**：`lib/browser-driver.js` 里 `uploadTextAttachment` 的定义被插在
  `uploadImages` 的 `if (!hit) { … throw err;` **之后、闭括号之前**——函数声明提升让它侥幸能跑，
  但 `if` 块被提前关掉、文件里剩下两个孤立闭括号。后果链：相邻重构 → 只在 `catch` 作用域可见 →
  调用点 `ReferenceError` → 被 runTurn 的 `catch` 吞掉 → **静默回落 inline**（界面上一切正常，
  长文本从来没走成附件）。已整体移到 `uploadImages` **完整结束之后**，`if` 块结构复原；
  护栏 `test/upload-attachment-structure.test.mjs`（源码结构断言 + 扫描器自检）钉住它不许挪回去。
- **附件上限**：`promptTransportPlan` 新增 `maxChars`（默认 1_500_000）/`payloadChars`/`truncate`/`kept`。
  **上限只影响「上传多少」，绝不影响「走不走附件」**（`mode`/`reason`/`limit`/`total` 逐字未变）；
  非法 `maxChars`（`<=0`/`NaN`/非数字/`null`）视为不设上限——配置写错只许退化成旧行为，
  不许把这一轮的消息悄悄砍成半截。护栏 `test/prompt-transport-attach.test.mjs`。
- **截断保尾部 + 留痕**：超上限时保留**尾部**（尾部才是当下要执行的那一步），文件开头写
  「已省略前 N 字符」，文件名带出 `tail<保留数>of<原文数>`，`onThink` 同步报出
  `原始 / 实际上传 / 省略` 三个数——**绝不静默丢上下文**。1_500_000 不是网页的实测上限，
  而是「真机已知最大 **409,555** 字符（`GET /__webcode/preset` 的 `promptChars`）的约 3.7 倍」
  这个余量的落点；真机两个读数（409,555 与 127,888）都远在它之下，正常轮次不会被截断（护栏 ⑥ 钉住）。
- **可核对读数**：驱动新增实例状态 `attachTransport` 并进 `status()`（`/__webcode/status`）——
  成功 `{ at, name, chars, payloadChars, truncated, evidence, total }`，回落
  `{ at, fallback: true, code, total }`。为什么必须有：附件投递的失败被 `catch` 吞掉后只留一行
  `warn`，用户侧看到的是「照样发出去了」，于是「到底有没有真的走附件」无从判断
  （这正是用户抱怨过好几次的「说做了、其实没做」）。

### 四、本轮实跑的命令（本机必须逐文件跑，`node --test <glob>` 会 `spawn EPERM`）

```
node --check lib/browser-driver.js                      → exit 0
node .tmp/probe-transport-plan.mjs                      → exit 0（4 条分支 + maxChars 非法/缺失/截断边界）
node --test test/prompt-transport.test.mjs              → 8/8 pass（0.16.2 既有判据逐字未变）
node --test test/prompt-transport-attach.test.mjs       → 9/9 pass
node --test test/upload-attachment-structure.test.mjs   → 4/4 pass
```

### 五、连带发现（同一次取证，代码不在本轮改动范围内）

- **`cfg.attachInlineLimitChars` 在 0.16.2 默认是 0（附件投递关闭）**，因此上面整条路径当时
  **从未在真机上跑过一次**——结构缺陷与「默认关」叠加，等于这条能力一直只停在纸面上。
  **0.16.3 起默认改为 60,000**（`0` = 关闭），依据是那轮 127,888 字符纯文本被看门狗判死的
  真机读数；配置面与理由见 `lib/index.js` 的 DEFAULTS 注释。
- `promptTransportPlan` 在 `mode:'inline'` 时的 `payloadChars` 口径歧义（0.16.3 已修）：
  修前 inline + 超上限会返回 `truncate:true / payloadChars:maxChars`，而 inline 路径
  **一个字符都不截**——字段名说的是「会发多少」，读数却是「假如走附件会上传多少」。
  现在 inline 一律 `truncate:false`、`payloadChars = total`、`kept:null`；「若走附件会上传
  多少」只在 `mode:'attach'` 时表达。护栏：`test/attach-callsite.test.mjs` ⑦。

