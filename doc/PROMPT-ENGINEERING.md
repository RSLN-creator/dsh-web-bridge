# 提示词工程立场与对照方案

本文件回答一个问题：**桥给网页模型的那段教学，凭什么这么写、凭什么不能乱改。**
它是「这一轮的立场」的**唯一权威落点**——代码注释里只写与那段代码直接相关的判据，
不与本文件重复（`doc/README.md:9-10` 的既定约定）。

建立时间：2026-09-17（0.16.4 轮）。相关文献与外部证据见
[`research/prompt-engineering-evidence-2026-09-14.md`](research/prompt-engineering-evidence-2026-09-14.md)。

---

## 一、三条立场（都带真机读数，不是偏好）

### 1.1 教**网页原生**的协议形态，不教桥发明的格式

0.16.1 及以前，桥教的是「标签包裹 + 裸 JSON」。**13/13 份真机夹具里模型一次都没用过它**
（`doc/progress.md` 0.16.2 §三）——它用的是这个网页原生的 DSML 形态。也就是说，
那段教学让模型**多做一次格式翻译**，而翻译中途的形态漂移正是「调用被丢 / 协议原文漏进正文」
这两族缺陷的来源。

改法（0.16.2，已落地）：deepseek 站点改教原生 DSML 骨架，**三处同源**——首轮教学、
首轮传输协议、增量轮再教学，由 `DSML_ONE_LINE` 与 `dsmlSkeleton()` 单点定义；
其它站点逐字不变。判据在 `lib/agent-preset.js`，护栏在 `test/prompt-variants.test.mjs`
与 `test/dsml-native-close.test.mjs`。

### 1.2 标记词形必须**逐字教学**，宽容层只是补救

真机读数（2026-09-17，`session-063b0a99`）：

| 形态 | 次数 | 取法 |
| --- | --- | --- |
| `｜｜DSH`（标记名写成 DSH） | **457** | `node -e` 数 `.tmp/063b-full.jsonl`（该会话的逐帧解码 dump）里 `U+FF5C U+FF5C D S H` 的出现次数 |
| `｜｜DSML｜｜`（正确形态） | **8** | 同上，数 `U+FF5C U+FF5C D S M L U+FF5C U+FF5C` |
| 其中「标记与标签名之间**缺空格**」 | **0** | 同上，数 `｜｜DSH｜｜` 紧跟字母的形态——它在真机上**没出现过**，所以夹具里那一条是**预案形态**，不是取证 |

**桥教的是对的**：`GET /__webcode/preset` 里是标准 DSML 标记（码点含 `44 53 4D 4C`）。
因此这 457 次是**模型漂移**，不是桥的字符串 bug——这一点必须先说清，否则修法会走反方向
（去改桥的字符串）。

两件事**必须同时做**，缺一不可：

1. **教学层面**（`TRAIN_NOTE_DSML` 与 deepseek 教学）：明确写「标记必须完整写成
   `｜｜DSML｜｜`，不要写成 DSH 或其它缩写」；
2. **解析层面**（`normalizeDsml` / `findProtocolStart` / `partialProtocolAt`）：对
   `DSML|DSH|DS` 词形宽容 + 允许标记与标签名之间无空格，让**流式阶段**就拦住畸形标记，
   而不是等收尾兜底。

只做 1 是「指望模型永远不漂移」；只做 2 是**把漂移固化成合法形态**，下一次换个缩写又要加一条。
判据：`test/marker-typo.test.mjs`（三种词形各解出同名同参调用、`diagnostics` 为空）。

### 1.3 默认路径**零位移**（改提示词的纪律）

任何提示词改动都必须能回答「默认路径动了没有」。做法不是靠人回忆，而是**逐字比对基线**：
`test/prompt-variants.test.mjs` 把默认路径的输出与 0.14.7 基线逐字比对（只归一化
OS 名与 Node 版本号两项），因此模板里任何一个字的位移都会变红。

这不是理论：0.16.2 改提示词时顺手把一句**所有站点共用**的话从「多个工具调用代码块」
改成「多个工具调用」，那条断言立刻变红，**已回退**（`doc/progress.md` 0.16.2 §六）。

---

## 二、宽容层的边界（宁可少救，不可错认）

保守判据（实现与护栏都按它写）：

- 只对「**标记 + 已知标签名**（`calls` / `invoke` / `parameter` / `tool_call` / `function` …）」
  动手；
- 散文里裸写的 `<calls>` / `<invoke name="x">` 示例**不得**被改写、也不得被当成调用；
- 空串 / 纯空白 / 只有标记没有调用 ⇒ 0 条调用且不抛错；
- 截半的调用块**不得**被拼成完整调用（把不完整的东西当调用执行 = 在用户机器上真的跑一条命令）。

理由是不对称的：**丢一条调用**的代价是这一轮白跑；**把散文当调用执行**的代价是
在用户机器上执行了模型没打算执行的东西——后者严重得多。

判据：`test/marker-typo.test.mjs` 的 ⑥/⑥b/⑦/⑧。

---

## 三、真机对照读数（表：每条都能自己取）

| 读数 | 数字 | 取法 |
| --- | --- | --- |
| 畸形标记 / 正确标记 | 457 / 8 | 数 `.tmp/063b-full.jsonl` 的码点（见 §1.2 表） |
| 桥的教学形态 | 正确的标准 DSML | `GET /__webcode/preset` 里搜标记码点 |
| 教自有格式时的命中率 | **0/13** | 13 份真机夹具逐份跑解析（`doc/progress.md` 0.16.2 §三） |
| 畸形标记修复后的解析 | 三种词形各 1 条调用、`diagnostics` 空 | `node --test test/marker-typo.test.mjs` |
| 块内容与增量的字节一致 | 见 `test/markdown-block-integrity.test.mjs` | 脚本驱动构造「权威全文多于增量通道」 |

**未证实**的部分（不许当成结论用）：

1. 「畸形标记出现率」与「模型版本/负载」的关系**只有相关性**，本轮没有任何对照实验；
2. 真机最长一轮的提示词是 409,555 字符（`GET /__webcode/preset`），
   但**「提示词多长会开始掉工具调用」没有读数**——附件投递解决的是 prefill 时间，
   不是「提示词该有多长」这个更根本的问题；
3. 「模型真的读了附件」**未证实**：`attachTransport` 只能证明上传被页面确认，
   不能证明模型读了内容（见 `long-term-issues.md` 的相关条目）。

---

## 四、对照方案（考虑过、以及为什么没选）

| 方案 | 为什么没选 |
| --- | --- |
| A. 只加宽容层，不改教学 | 会把漂移固化成合法形态：下一个缩写（`DS`、`DSm`…）又要加一条词形，而**桥永远慢一步**；且它掩盖了「模型没按协议输出」这个事实 |
| B. 教桥自己的简单格式（标签 + 裸 JSON） | **已经试过**：13/13 真机夹具里模型一次都没用（§1.1）。它把「按协议输出」变成「先做一次格式翻译」，翻译中途的漂移就是那两族缺陷的来源 |
| C. 桥侧做「协议重写」：把畸形统一规范化后**当作正常**，不报案 | 需要模型侧真的接受重写结果（没有证据）；且它会让「模型漂移」变成静默事件，下一次漂移更晚被发现——违背本项目「不许静默降级」的立场 |
| **D. 现行方案（教学逐字 + 流式认词形 + 收尾彻底剔除协议 + 块内容与增量一致）** | 三层各管一件事：教学管「尽量别漂移」、解析管「漂了一点也救回来」、收尾管「救不回来的部分**一个字节都不许外发**」 |

---

## 五、护栏清单（哪条判据保护哪条立场）

| 立场 | 护栏 |
| --- | --- |
| 教原生 DSML | `test/prompt-variants.test.mjs`（默认路径零位移）、`test/dsml-native-close.test.mjs`（13 份真机夹具）、`test/dsml-real-reply-regression.test.mjs`（真机原话 1204 字符 → 3 条调用） |
| 词形教学 + 宽容 | `test/marker-typo.test.mjs`（三种畸变词形 + 反向安全线） |
| 协议原文零外发 / 块内容一致 | `test/markdown-block-integrity.test.mjs`、`test/protocol-leak.test.mjs`、`test/fence-prose.test.mjs` |
| 超长提示词有出路 | `test/prompt-transport.test.mjs`、`test/prompt-transport-attach.test.mjs`、`test/attach-callsite.test.mjs`、`test/attach-probe-contract.test.mjs` |

---

## 六、一条元纪律（引用外部证据时的自我约束）

引用文献时**不得宣称「最优」**，且**必须披露 harness**
（`research/prompt-engineering-evidence-2026-09-14.md` 的两条立场）。本文件里所有的
「改法更好」都是**相对读数**（同一 harness、同一站点、同一批夹具的前后对比），
不是「业界最优提示词」。任何一条结论要升级成「更优」，都必须先有**配对读数**
（同轮、同站点、只改一个变量），这也是本项目反复使用的取证方式。

---

## 七、0.19.3：deepseek 分支的两处优化（用户指令 + 配对读数）

用户指令（本轮原话）：「我是让你现在在"标准模式模板（standard）"模板下结合提示词进行优化！
不是让你改原来已有官方！」「结合考虑，然后确保性能更优！自己去学习提示词工程最佳实践来参考！
deepseek 的提示词先只改」。

### 7.1 只动 deepseek 分支（不碰官方模板）

`standard` 模式模板本体在 `dsh-web-app/presets/standard.patch.yml`（DSH 安装目录内，
**未被本版改动**）。本版改的是**桥给 deepseek 站点现算的那一段**：
`lib/agent-preset.js` 的 `deepseekTransport()` 与 `buildPreset` 的 deepseek 分支。
其余站点（glm / 默认标签立场）**逐字不动**。

### 7.2 改动一：删掉与同一份首轮逐字重复的两句（501 → 376 字符）

真机实测（同一份 deepseek 首轮）：`# 工具调用格式` 段与末尾的 `[本地工具传输协议]` 段
**共重复 202 字符**，其中这两句是**逐字**重复：

- 「标记必须逐字完整：竖线、词间连接符（▁）、begin/end 一个都不能少…」；
- 「sep 之后是完整 JSON 对象…无参数的工具 arguments 写 {}；不要加 ```json 围栏」。

删的是**重复的句子**，保留的是：骨架本身（骨架是自动续跑轮**唯一**的形状来源——
`teachFor → transportNoteFor` 在续跑轮单独调它，那时没有 preset 在场）、以及协议段
独有的内容（`Calling:` 不执行工具、立即发起调用、不要继续无谓思考）。

| 读数 | 值 |
| --- | --- |
| deepseek 协议段（改前） | 501 字符 |
| deepseek 协议段（改后） | **376 字符（−25%）** |
| 与首轮重复的字符 | 202 → 0 |

**依据**：arXiv 2510.05381「长上下文本身损害性能，即使检索完美」
（`research/prompt-engineering-evidence-2026-09-14.md` §2.2）。
重复的约束不增加信息量，只增加上下文长度。

### 7.3 改动二：措辞纠错（自相矛盾的一处）

同一份 deepseek 首轮里，前一段刚教「不要加 ```json 围栏」，后一段却说
「一次回复可以包含多个工具调用**代码块**」——把一个**不是**代码块的形状叫成代码块。
真机里模型据此产出裸 ```json 块（与教学目标相反的形状）的风险不值得留着。

**改法是站点感知的单句替换**：deepseek 说「多个工具调用」，其余站点（含 default/glm）
**逐字保留**「多个工具调用代码块」——因为那一句在 `ZERO_DRIFT_BASELINE` 里逐字存在
（`test/prompt-variants.test.mjs`），改它会让零位移断言变红。

### 7.4 护栏

`test/deepseek-prompt-slim.test.mjs`（8 条）钉住：

| 断言 | 防的是 |
| --- | --- |
| ① 协议段不含「标记必须逐字完整」/「不要加 ```json 围栏」 | 重复句被悄悄加回来 |
| ①b 协议段 ≤ 420 字符 | 精简成果被后续改动吃掉 |
| ② 骨架仍在（calls-begin/call-end/真实工具名） | 误删续跑轮唯一的形状来源 |
| ②b 独有内容仍在（Calling:/立即发起/不要继续无谓思考） | 精简连带删掉非重复内容 |
| ③ deepseek 不再出现「工具调用代码块」 | 措辞自相矛盾复发 |
| ③b 非 deepseek 站点逐字保留「工具代码块」 | **零位移**被破坏 |
| ③c glm/default 协议段不受影响 | 改动越界到别的站点 |
| ③d 端到端首轮里措辞已纠正 | 只在单测层生效、真实链路没跟上 |

### 7.5 元纪律（§六仍然适用）

本节的「更优」全部是**相对读数**（同一 harness、同一站点、同一份输入的前后对比）：
501 → 376 字符、重复 202 → 0、自相矛盾一处 → 0。
**不宣称**这是「业界最优提示词」，也**没有**配对性能读数证明「模型守约率提升」。
要升级成后者，需要同轮、同站点、只改这一个变量的配对实验。

---

## 八、0.19.3 续：自动续跑的「整会话累计」与完整提醒升级

用户指令逐字：「加"整会话累计"：超过 N 次就改为发完整提醒，优先保证长上下文循环问题！解决！」
「A+C：但是不能停！继续后续需要 auto！！我说我需要真实长上下文你不理解吗？？能够做到！！不要停！」

### 8.1 语义边界：这是**形态切换**，不是刹车

| 累计补发次数 | 模型侧收到什么 | 续跑是否继续 |
| --- | --- | --- |
| ≤ N（默认 3） | 短提示：再教学提示 + 该站点协议段（`teachFor`） | 是 |
| > N | **完整提醒**：再教学提示 + 该站点**会话教学正本**（工具清单＋调用格式＋使用准则） | **是**（用户明确要求不停手） |

判据的唯一来源是 [`lib/continue-budget.js`](../package/dsh-webcode-bridge/lib/continue-budget.js) 的纯函数 `continueFormFor({ cumulative, after })`：
`after = 0` 或非法值 = **不升级**（不是「立即升级」）；`cumulative > after` 才升级。
`autoContinueRound` 里只有一个 `disabled` 出口，且只由 `rounds < 1 || !sessionKey` 决定——**累计永远不会让它停手**（护栏 ③c 钉住）。

### 8.2 计数的口径与「整会话」的落地

- **只在补发确认送出后 +1**：形态判据用 `peek + 1`（预期序号），`continueCounter.bump()` 放在 `relay.submit` 返回之后。发送抛错不占额度，界面读数与事实一致（护栏 ③b）。
- **落盘**：`<~/.dsh/webcode>/continuations/<sessionKey>.json`。理由是「整会话」必须跨进程——本项目常态操作就是重启 `dsh web`，只放内存会把「整会话」悄悄降级成「每进程」，长期会话永远到不了升级点。
- **失败静默**：读不到/损坏/不可写一律退化成内存计数（护栏 ②e），绝不因为计数把回合搞挂。

### 8.3 完整提醒为什么取「会话教学正本」

`buildTurn` 的 fresh 分支里，站点教学全文（`buildPreset({...}) + teachFor(siteId, tools)`）**只算一次**：既落盘（`prompts/<site>.md`），又存进 `siteTeachingBySession`。续跑升级时优先读它——于是「升级后重发的教学」与「首轮真实教过的教学」**不可能分叉**；这是机制保证，不是两边照着写对的约定。正本缺失（桥重启后接手已有网页会话）时回落现算，用的还是同一组 builder（护栏 ③d）。

**成本已经算清**：webcode 真实工具目录下这份教学是 **26,264 字符**；把它贴进同一个网页会话意味着此后每轮 prefill 都要重复吃下它。成本账与两条解决方向见
[`research/2026-09-23-longrun-rounds-3-4.md`](research/2026-09-23-longrun-rounds-3-4.md) §4.2/§4.4。

### 8.4 界面文案（`lib/notices.js`）

升级形态必须同时说清三件事，缺一件都会让人误判：**第几次**（`累计补发 **4** 次`）、**已改用完整提醒**、**不停手**（「自动续跑照常继续，不停手」）。八处出口共用 `continueNoticeFields(cont)` 一处口径，避免某一处静默漏掉升级状态（护栏 ③e）。

### 8.5 护栏

`test/continue-budget.test.mjs`（12 条）+ `test/auto-continue-notice.test.mjs`（7 条，出口集合扩到 6 个）：

| 断言 | 防的是 |
| --- | --- |
| ①/①b `> N` 才升级；`after=0` 是不升级 | 「关掉策略」被读成「立即升级」 |
| ②/②b 计数自增、跨实例（=重启）读回同值 | 「整会话」退化成「每进程」 |
| ②c 会话键消毒后不逃出 `continuations/` | 路径逃逸 |
| ②d `NODE_TEST_CONTEXT` 下不写真实存储根 | 跑一次测试污染用户累计值 |
| ②e 损坏/不可写退化成内存 | 计数把回合计挂 |
| ③b bump 在 `relay.submit` 之后 | 发送失败也占额度 → 读数与事实不符 |
| ③c 唯一 disabled 出口与累计无关 | 功能被做成用户明确否掉的样子 |
| ③d 完整提醒取会话正本 | 续跑另拼一份教学 → 与首轮分叉 |
| ⑥ 升级文案含次数/完整提醒/不停手 | 界面少一条归因 |
| ⑦ 未升级与 disabled 支不得出现升级文案 | 与事实相反 |

**真机读数**：`test/auto-continue.test.mjs` 11/11 通过（exit 0，约 300s，含两次 60s 发送间隔），日志逐字出现
`auto-continue round: 149 chars, 1 call(s) parsed, form=short, cumulative=1`。

**升级分支的行为护栏**：`test/auto-continue-complete.test.mjs`（1 条，约 60s）。它在临时根里预置
`continuations/<sessionKey>.json` 的 `cumulative: 3`（＝「本会话已连续失败 3 轮」的同构现场），于是这一轮是第 4 次、越过默认升级点，
逐条断言：① 发进网页会话的文本带 `[完整提醒·本会话累计第 4 次补发，已超过升级点 3 次]` 与 `# 可用本地工具`（完整教学段）；
② 调用照旧被派发且 `finish=tool-calls`（**升级 ≠ 停手**）；③ 界面文案同时给出累计次数、形态升级与「不停手」；④ 计数文件落到 4。
真机日志逐字：`auto-continue round: 149 chars, 1 call(s) parsed, form=complete, cumulative=4`。

### 8.6 已知代价（必须先读，再决定要不要保留这个默认值）

真机全量读数（303 份会话，`AUTO_CONTINUED` 作为助手正文逐字落在会话日志里）：

| 读数 | 值 |
| --- | --- |
| `AUTO_CONTINUED` 出现总次数 | **157**（分布在 **26** 个会话里） |
| 单会话单轮最高 | **42 次**（`session-84a9a24f…`，该会话 199 次工具调用） |
| 其余高值 | 14 / 13 / 13 / 10 / 9 / 8 / 7 … |

按本轮上线的规则（累计 > 3 起**每一轮**都用完整提醒），上表那个 42 次的会话意味着：
第 4…42 轮各注入一份 26,264 字符的完整教学 ⇒ **约 1.02 M 字符**被追加进**同一个网页会话**，
而真机已知能收下的最大单轮提示是 **409,555 字符**（`doc/progress.md` §0.16.3）。
也就是说：**这条规则在「漂移成灾」的会话上会自我放大到超出网页容量**——这与用户
「我需要真实长上下文」的目标相反，虽然它逐字实现了「超过 N 次就改为发完整提醒」。

**处置：本轮按用户原话实现（每一轮都升级，且不停手），把这个代价如实记账，不擅自加刹车。**
可选的三个旋钮（都是一行）：

| 选项 | 改法 | 效果 |
| --- | --- | --- |
| 提高升级点 | `autoContinueCompleteAfter: 5`（设置页可改） | 升级更晚，峰值降到 (42−5)×26k ≈ 0.96 M——**没解决量级问题** |
| 关掉升级 | `autoContinueCompleteAfter: 0` | 永远短提示（仍是 0.19.3 之前的形态） |
| 只升级一次 | 把判据从「累计 > N」改成「累计 > N 且本会话尚未发过完整提醒」 | 峰值 26k，**且仍然不停手** |

第三条在 [`research/2026-09-23-longrun-rounds-3-4.md`](research/2026-09-23-longrun-rounds-3-4.md) §4.4 被推广成 D4（恢复预算 + 重建而不是加长）。

### 8.7 元纪律

「完整提醒更有效」**没有收益读数**——本轮只给出成本（26,264 字符/次）与机制（同源）。要升级成「提升收敛率」，需要配对实验：同一失效形状，一半走短提示、一半走完整提醒，比「下次漂移前的步数」。

---

## 九、0.19.3 续：新增「WebCode 真实模式」agent preset

用户指令逐字：「我让你新增模式！保留必要webbridge需要调用工具！！以标准模式，ptc模式，简单模式等等平级的！agents预设！适合webcode的真实模式：可以查看长对话里面调用和没调用的真正工具！然后提示词优化懂不懂？真实学习参考已有的工程实践提示词！！」

### 9.1 工具面按**真实调用读数**裁剪（不是按感觉）

真机取证（`scripts/session-read.mjs` 多帧 zstd 全解，2026-09-23）：

| 读数 | 值 |
| --- | --- |
| 会话 / 轮 / 工具调用 | **303 / 817 / 23,636** |
| 其中 webcode 路由 | **15,296 次（64.7%）** |
| webcode 真实工具目录 | 35 项，实际被调用 32 项 |
| `workflow` / `subagent_fork` 命中次数 | **0 / 0** |
| 这两项的每轮教学成本（差集法，桥自己的 `buildPreset` 现算） | 2,651 + 1,466 = **4,117 字符** |
| 首轮教学全文 | 30,381 → **26,264 字符（−13.6%）** |

preset 声明在 [`cordis.patch.yml`](../package/dsh-webcode-bridge/cordis.patch.yml)（随包发布，装 profile 即生效）：
`id: webcode`、`order: 4`、展示名「WebCode 真实模式」。与官方 standard 的差异**只有两处**（YAML 真解析逐项比对）：
删掉 7 行（`tool-subagent-fork`、`tool-subagent-codex`、`tool-subagent-claude-code`、`workflow-ptc`、`tool-workflow`、`tool-ralph`、`tool-plugin-manager`），persona 多一句传输事实。**官方三个 preset 一行未动。**

删工具本身就是提示词优化，不止省字符：
1. 本项目最贵的失效形状是模型写出**本会话不存在的工具名**（`TOOL_UNKNOWN` 收尾）。每多一个从未被选中的入口，就多一个被判错的名字。
2. 长上下文本身损害性能，即使检索完美（arXiv 2510.05381，[`research/prompt-engineering-evidence-2026-09-14.md`](research/prompt-engineering-evidence-2026-09-14.md) §2.2）。

### 9.2 persona 里那一句「传输事实」的依据

```
This session runs through the DSH WebCode bridge: the model answering you is a web AI,
and your tool calls are parsed out of your visible reply text by the bridge, then executed
locally; their results come back to you as user messages. Write each call in exactly the
shape this session teaches, in the visible reply text — a call that exists only inside
reasoning is never executed.
```

- **为什么放在开头**：Lost in the Middle（arXiv 2307.03172）的 U 形曲线说明模型对**开头与结尾**最敏感；而 webcode 唯一的结构性事实今天只出现在**末尾**的协议段里。同一约束同时占住 U 形两端。
- **为什么必须点名「只在思考里的调用不会被执行」**：这是真机最顽固的失效形状（`THINKING_ONLY_NO_ANSWER`，见 [`long-term-issues.md`](long-term-issues.md) 第 22 条），而它靠的是「把此刻就落笔写成可判定的动作」这一类可执行约束，不是鼓励性措辞（IFScale，arXiv 2507.11538：最强前沿模型在 500 条指令下也只有 68%，且**偏向更早出现的指令**）。

### 9.3 护栏

`test/webcode-preset.test.mjs`（7 条）：

| 断言 | 防的是 |
| --- | --- |
| ① 声明行形状（id / `@deepseek-ai/dsh-agent-preset` / `config.id` / `order: 4` / 展示名） | patch 结构错 → 模式在列表里静默消失 |
| ② 删掉的行正是那 7 个「0 次命中」的 | 有人随手删了别的入口 |
| ③ 留下的行一个不少 | **删多了 = 静默砍能力**，比删少了严重 |
| ④ 引用到的包名必须全部出现在官方预设里 | 拼错一个包名 → 整个模式装不起来 |
| ⑤/⑤b persona 两句原文仍在 + `!!js` 守卫与 plan-mode 官方 section 逐字保留 | 顺手把配置丢了 |
| ⑥ 桥自身挂载行未被动过 | 新增预设波及桥本体 |

### 9.4 组合层取证（不必等重启）

`dsh --profile web --dump-config` **exit 0**，组合树里四个 preset **平级并列**：
`preset-standard` / `preset-ptc` / `preset-minimal` / **`preset-webcode`**（第 1372 行），
且渲染块与源码逐项一致（`id: webcode`、`order: 4`、展示名、persona 传输事实、裁剪后的工具行）。
`dsh --profile headless --dump-config` 同样 **exit 0**（含该行、无 error）——headless 没挂
`agent-preset-registry`，而 `@deepseek-ai/dsh-agent-preset` 是 `static inject = ["agentPresets"]`，
按官方注册表文档「等待 Host 服务的行保持挂载」，该行在那里应当是惰性无害（**挂载层待重启确认**）。

### 9.5 元纪律

**没有配对性能读数。** 「工具面裁到 26,264 字符」是**相对读数**（同 harness、同目录、差集法），不等于「漂移率下降」。要升级成后者需要：同站点、同任务、两套工具面各跑 N 轮，比 `TOOL_UNKNOWN` / `THINKING_ONLY_NO_ANSWER` 的发生率。
