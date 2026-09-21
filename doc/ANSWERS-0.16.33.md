# 三问答案（0.16.33 取证）

> 本轮**未动**任何解析 DeepSeek 协议的逻辑，也**未动**账号底层连接。

## A. 为什么新对话里 DeepSeek 还用 DSML？

DSML 是 **DeepSeek 网页端的原生格式**，不是桥教的。0.16.23 起 DSML 解析已
**退役**（只扣留、不执行，见 `agent-preset.js:39-49`）。模型在首轮没读到桥的
教学、或只读到增量轮那一句再教学时，按训练先验吐 DSML，桥不认 → `TOOL_CALL_UNPARSED`。

完整教学**只在 fresh 首轮**注入（`lib/index.js:3171-3193`）：

```js
const fresh = !st;
if (fresh) prompt = serializeFirstTurn(...);   // 完整教学
else prompt = delta.text;                      // 增量 + 一句再教学
```

`fresh` 四个真因（`index.js:3151-3170`，透出到 `status.driver.freshReasons`）：
`no-cursor`（正常）/ `contract-changed`（正常，工具名或系统提示一变就整段重建
= **开新对话**）/ `anchor-lost`、`anchor-no-new-messages`（**真故障**）。

真机漂移读数（`PROMPT-ENGINEERING.md` §1.2）：`｜｜DSH` 写错 **457 次**，正确
形态 **8 次** —— 漂移是常态，桥的教学字符串本身是对的。

解析层现状：`normalizeOfficialToolCalls` 只做官方改写；DSML 词形只剩两个锚点
（`agent-preset.js:185-188`，用于 `1014/1016`）把词形**扣住不外发**；命中扣留 +
0 调用 → 报 UNPARSED 并自动再教官方格式。宽容实现在分支 `backup/dsml-protocol`。

**定位手段**：读 `/__webcode/status` 的 `driver.freshReasons`，键名即真因。

## B. 系统提示词与 @上下文真的传了吗？

**都传了**，但传的是**文本快照**，不是原生消息结构。

`buildPreset`（`agent-preset.js:403-408`）把 DSH 系统提示词拼成 `[系统指令]` 段：

```js
if (system) parts.push('[系统指令]\n' + system);
if (extraPrompt) parts.push('[全局指令]\n' + extraPrompt);
```

@上下文（文件引用）由 DSH 展开进消息内容后，经 `serializeFirstTurn`
（`agent-preset.js:512-521`）逐条序列化成 `[system]` / `[assistant]` 前缀的文本；
没有独立附件通道（附件通道只用于**图片**，`index.js:798-802`）。

实测体量（`GET /__webcode/preset`，见 `.local-plans/PLAN-2026-09-17-DSML-FILE-SEND.md:103-107`）：

```
TOTAL 409,555
  tool teaching (preset)      38,241   9.3%
  conversation / transcript  370,985  90.6%   ← 其中 DSH 系统指令 279,223
  transport protocol             329
```

**系统指令 279,223 字符 = 全部文本的 68%**，它确实传了，而且是最大一块。

与官方 API 路径的差别：

| 维度 | 官方 API | 本桥（网页路径） |
| --- | --- | --- |
| 系统提示词 | 独立 `system` 字段 | **拼进首轮正文** |
| 上下文 | 结构化 messages | **文本快照** |
| 增量 | 每轮全量 | **只发 `sent` 之后的新消息** |
| 压缩 | 服务端自动 | **无等价机制**（见 C） |

这是网页路径的结构性限制：只有一个输入框，没有 `system` 角色。推论：每次
`fresh` 都要**重发全文**，这是 prefill 时间的主要来源。

## C. 为什么做不到压缩？

**能做截断，不能做压缩** —— 压缩需模型参与改写，而桥没有任何位置放摘要。

已有的是**截断**（`agent-preset.js:534-549`）：预算路径丢最旧的消息段、保留最新
后缀与全部教学/协议头，插入 `[系统] （早期上下文已省略 N 条消息…）` 标记，
绝不静默截断字符串。

三条硬约束：

1. **没有位置放摘要**。上下文就是输入框里的文本，桥每轮只发全文或增量；已发出去
   的原文**撤不回来**。要压缩只能开新对话重灌摘要 —— 那就是 `fresh` 重建，代价是
   全量重发。
2. **输入框有真实上限，附件又未必被读**。判定点唯一：`promptTransportPlan`
   （`browser-driver.js:249-291`）。阈值 `attachInlineLimitChars` 默认 **60,000**
   （`index.js:205`），依据是 0.16.3 真机事故（127,888 字符纯文本、112 秒零事件被
   看门狗判死）。但 `PROMPT-ENGINEERING.md:95` 如实记着：附件**只证明被页面收下**，
   不能证明模型读了内容。
3. **站点风控**。上传有副作用（`PLAN-2026-09-17-DSML-FILE-SEND.md:113`），不能
   做成「每轮都传附件」。

另有一层：`index.js:773-778` 的注释说明，桥**故意**把 `contextWindow` 报小
（deepseek 128k、其余 64k，见 `contextWindowFor`，`index.js:720-723`），目的是让
**DSH 宿主的压缩机制早点触发** —— 即压缩在这个架构里是**委托给宿主**的。

**减少 40 万字符最直接的杠杆不在桥这边，而在系统提示词本身的长度（占 68%）**，
那是宿主给的，桥只负责转发。
