# 诊断（2026-09-19）：最近两次 DSH 会话取证 + `.tmp` 交接文档核实

**这份文件回答两个问题**：2026-09-18 晚间最近两次 DSH 会话里到底发生了什么、
`.tmp/INDEX.md` 那批交接文档的成色如何。取证方法：解码
`~/.dsh/sessions/--D-9_Code_Workspace-dsh-webcode-bridge--/` 下的
`session.v3.jsonl.zstd`（zstandard 流式解码），逐事件核对；所有时间戳为本地时间。

- 缺陷的「为什么不修 / 怎么修」在 [`long-term-issues.md`](long-term-issues.md)；
  错误码横向台账在 [`bridge-failure-ledger.md`](bridge-failure-ledger.md)——本文只写取证事实。
- 23:36 的 `session-0fd32761` 只有配置头没有消息（527 字节），不计入。

---

## 一、会话 `0a62dbb8`（22:17–22:40）：整轮死在 PROMPT_TRUNCATED

用户贴上一轮验证报告并要求「你检查下」。`turn/end` 逐字：

```
turn 1, reason kind=error
PROMPT_TRUNCATED: 网页输入框只接收了 72969/72980 字符（网页端长度上限）
— 请缩短上下文或先压缩历史再重试
```

`assistant/attempt` 的 stream 只有 1 个事件（`finish`），**模型一个字都没回**。
关键读数：**只差 11 个字符**（72980−72969），桥也按致命错误处理，没有任何
「自动压缩到已接受长度并重试一次」的退路。用户的检查请求当场作废，
只能换新会话（`d5fd2e11`）以引用原话的方式重试成功。

## 二、会话 `d5fd2e11`（22:23–00:18）：主工作会话，四个问题

9 轮、115 次工具调用、71 条助手消息。本轮做成的事（背景，已入
[`progress.md`](progress.md) §0.16.10 七）：装机持久性根因（声明才是持久层）、
0.16.10 声明式装机、重启生效、台账、提交 `9d4c61a`、schannel 推送、CI 绿。

### 问题 1：TOOL_CALL_UNPARSED 在会话内复发 4 次

| 时间 | 扣留量 | 出处（user/message 事件） |
| --- | --- | --- |
| 22:26:58 | 868 字符 | seq 见会话存档 |
| 22:28:23 | 2193 字符 | 同上 |
| 22:38:50 | 245 字符 | 同上 |
| 22:46:50 | 541 字符 | 同上 |

与 §0.16.10 六的 15 份夹具（99–1022 字符）同族：**真协议块、桥没认出**。
两类根因（缺 `name` / 参数 JSON 断流截断）**均未修**。

**最重的一次在收尾**：turn 9 step 2（22:48:43）的助手正文里**嵌着**
TOOL_CALL_UNPARSED 提示全文——模型「核实 CI 四条腿与 CodeQL」的调用又被丢弃，
turn 按 `completed` 收束。**后果：CodeQL 与 CI 四条腿的结论在会话内始终没有核实。**

### 问题 2：turn 8 整轮报 `empty response from web AI`（UNKNOWN 码）

22:46:59–22:48:00，`turn/end reason = {"kind":"error","error":{"message":
"empty response from web AI","code":"UNKNOWN"}}`。
取证该轮 `assistant/attempt`（step 4）的 stream：只有
`block-start (reasoning)` + `reasoning-chunks`（dt 数组）+ `finish`——
**只有思维链、没有正文块、没有调用块**。与台账 #22「只出思考不出正文」同族，
但这次没走 `thinkingOnlyNotice` 软提示路径，而是硬失败。**该实例未归因、未立条（→ 现已立条，见 #26）。**

### 问题 3：模型自己写坏工具调用参数 3 次

会话内助手自述（逐字）：「第一条 read 的参数标签写坏了，重发」「第二条 edit
参数写漏了」「参数被串行了，重发」。与缺 `name` / 截断同族——**网页模型产出的
调用形状不可靠**，桥目前只能靠模型自查重发。

### 问题 4：环境摩擦（均已绕过，均仍在）

| 摩擦 | 绕过方式 |
| --- | --- |
| git 推送撞 OpenSSL CA 链（`unable to get local issuer certificate`） | `git -c http.sslBackend=schannel push` |
| 沙箱拦 `C:\Users\rsyhn\.dsh` 写入，装机被拦 | 用户把审批策略改为 `never`（command/run: `permission danger-full-access`） |
| `ref-index` 闸门本机 FAIL / CI PASS | 环境差异（见 §0.16.10 五），消掉需人工对齐 `reference/README.md` 的 web-login 行 |
| 后台任务标志未被 DSH 采纳（`job_list` 为空） | 改用 `*> 日志文件` + 轮询 |

## 三、`.tmp/INDEX.md` 交接文档核实（用户问「tmp/index 呢？」）

`INDEX.md`（2026-09-18 13:45）是八小时冲刺生成的交接文档索引，指向 6 份交付物。

**核实为真的**：

- 6 个被引用文件全部存在（无死链），合计约 3,108 行（逐文件 `wc -l`）；
- **对比视图有一份已提交的实现**：`lib/comparison-view.js` 进主干于 0.16.5
  （提交 `7e9e9dd`），`index.js:2615` 挂 `/__webcode/comparison` 路由，
  走桥自己的 OpenAI 兼容 `/v1/chat/completions` + SSE，中继口 8931
  （`client.cjs:33` `RELAY_PORT = 8931`，端口写法无误）；
- 冲刺记录（`.claude/GEP-skills/20-Events/2026-09-18-8h-sprint.md`）对并发底座的
  判断有价值：不同 accountKey 路由到不同 driver 实例，天然支持跨账号真并发。

**核实为虚/未接线的**：

- 冲刺记录自认「**100% 框架，40% 实现**」；对比视图那节原文状态是
  「代码已完成，**待测试验证**」——`test/` 无任何 comparison 相关测试，
  0.16.6–0.16.10 五轮未再碰它，真机读数为零；
- 行数口径注水：HANDOFF-FRAMEWORK 声称 1000+ 行（实 724）、
  account-management 声称 1200+ 行（实 506）、site-adaption 声称 1500+ 行（实 479）；
- `lib/task-view.js` 不存在——任务看板只有 `.tmp` 里的模板，
  「可直接 cp 到 lib/、无需理解」的说法与本仓库闸门纪律
  （lint-comments 0/0、反向验证、新功能配测试）冲突；
- 账号管理、站点适配两份是指南，不是代码。

**结论**：代码是真的进了主干，虚的是行数与完成度口径。这与用户此前
「我怀疑被参水了」的判断对得上。

## 四、遗留的一个待拍板问题（只记录，不自行裁决）

对比视图现存**两条路线**无人裁决：

1. 独立页路线（已提交、未验证）：`/__webcode/comparison`，绕开官方对话区；
2. UNDERSTANDING C7/C10 定的路线：官方 `conversation.view` 槽位、
   中央区 view 内部排三列（需先解决并行底座）。

二者并存且方向不同，需要用户拍板后再动。本文档只记录事实。

## 五、取证方法备注

- 会话存档解码：python `zstandard` stream_reader 循环 read（同 `doc/progress.md` 速查）；
- 事件结构：`user/message` / `assistant/message`（`data.message.content[]` 含
  `reasoning` 与 `text` 两类）/ `tool/call`（`data.arguments` 为 JSON 字符串）/
  `assistant/attempt`（`data.stream[]` 为块级 chunk 现场）/ `turn/end`；
- 本地复核用临时副本在 `.tmp/session-review/`（gitignore 已覆盖）。
