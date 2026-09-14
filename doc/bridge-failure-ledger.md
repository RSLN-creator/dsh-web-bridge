# 桥接失败台账（错误码 × 已做适配 × 残留风险）

生成时间：2026-09-14。依据：`doc/long-term-issues.md`（13 条 + 第 14 条）、`PLAN.md` 的 0.14.x 各节，
以及本轮对 `session-698700ea` / `session-c710ef6e` 两份会话日志的**离线**分析。

> 本轮**未新增任何真机探针**（风控纪律）。所有结论来自离线会话日志 + 已装包源码。

## 0. 本轮会话日志分析（离线，两份）

| 会话 | 大小 | 事件 | step/start=end | turn/end |
| --- | --- | --- | --- | --- |
| `session-698700ea-abc4-4783-bdac-18a7b18093e2` | 978 KB | 807 | 115 = 115 | 1 个，`completed` |
| `session-c710ef6e-fca7-4b26-83c4-12103d5d6dfa` | 756 KB | 1020 | 46 / 51 | 2 个：`completed` + **`error`** |

`c710ef6e` 的 turn 2 终局（逐字）：

```
turn/end reason = {"kind":"error","error":{"message":"locator.fill: Timeout 30000ms exceeded.\n
  - waiting for locator('textarea.ds-scroll-area').first()\n
  - locator resolved to <textarea rows=\"2\" name=\"search\" a…"}}
```

这正是 `PLAN.md` 0.14.5 记录的 **P0 缺陷**：把 80 万字符一次性交给 `fill()` → 网页侧整段卡住 → 30s 超时，
**卡住期间没有任何中间态可读**，界面表现就是「思维链卡住、一直没进度」。

**当时的关键事实**：`doc/progress.md` 记着「工作树版本 0.14.5（未发布）／**已装版本 0.14.4**」，
即 **`composerWritePlan` 分块写入修复还没装到运行的 DSH 里** —— 所以这个症状在当时**必然**复现。

> **状态更新（2026-09-14 晚间）**：0.14.6 已装入 web + headless 并重启生效（PID 22184）。
> 本会话即由桥接驱动，`lastEndReason=finished`、`lastRate.responseMs=952`，
> `--recent 3` 无 `locator.fill` 超时 —— 本症状**未复现**。

## 1. 错误码台账

| 错误码 | 已做的适配 | 当前状态 | 残留风险 |
| --- | --- | --- | --- |
| `PROMPT_WRITE_STALLED` | 0.14.5：`composerWritePlan`（single/chunked，clamp `[1000,200000]`）+ `stallStep`（连续两块回读长度不增才判死）；错误码带**已写/总长度**与元素现场 | **已修，已装，已验证**（v0.14.6，重启生效） | 残留：仅网页端本身卡死（非写入量）时仍会走看门狗。**重启后实测**：`lastEndReason=finished`、`lastRate.responseMs=952`、`--recent 3` 无 `locator.fill` 超时 |
| `WEB_NO_PROGRESS` | 0.14.0：适配器无进展看门狗 `nextWithIdle`（默认 120s，`webcode.idleTimeoutMs`），把「无限挂起」变成带驱动现场（`captureAlive`/`replyChars`）的报错 | 已装 | 必须 > WIP 窗口，否则看门狗先开火 |
| WIP 稳态收束 | 0.14.0：`startWipWatch` **双条件**——流停 ≥ `wipIdleMs` **且** DOM 助手消息长度停止增长；任一在动就不收束 | 已装 | 只看流停会把长回复腰斩（已有反向单测钉住） |
| `WEB_SESSION_LOST` | 0.14.2：按站点声明地址形状（三态 `fresh`/`resume`/`unsupported`），`unsupported` **必须报错**不再静默新开 | 已装 | `zai` 故意不声明形状，落 `unsupported` 并如实透出 |
| `CONTEXT_WINDOW_EXCEEDED` | 0.14.2：纯函数 `metrics.checkContextBudget`，在 `buildTurn` 之后、`attach` **之前**拦下——越界时网页端完全未被写入 | 已装 | 窗口是「本桥愿意让 transcript 长到多大」，**不是**模型规格 |
| `PROMPT_TRUNCATED` | 填写**之后**的回读校验；只报长度差 | 已装 | 是兜底，不是主防线 |
| `TOOL_PROTOCOL_INVALID` | 0.14.1：mismatch 改为**修复**（同名第 k 个流式块与第 k 个同名权威调用配对，未覆盖的补发新块）；只有块连 `raw` 都没有才抛错 | 已装 | 大幅降低整轮作废 |
| `RATE_LIMITED` | 站点级 `sendGapMs` 节流 + 识别专用错误按 `max(间隔,10s)` 自动退避重试 | 已装 | 探针要节制（见 §3） |
| `NEED_LOGIN` | `visibleComposerCount` 逐元素检查可见性，且**遍历全部候选选择器**（GLM 真实 composer 是裸 `<textarea>`） | 0.14.3，已装 | 只数个数会把 WAF 隐藏 textarea 判成已登录 |
| `challenge-page` | 0.14.3：`detectChallenge` 认验证页文案与 WAF 指纹（`CF_APP_WAF`/`aliyun_waf`），在 `judgeLoggedIn` **之前**调用；`navReason='challenge-page'` 与「会话过期」分开报 | 0.14.3，已装 | 否则用户按「会话过期」去查，永远查不到风控 |
| 协议残片（`<call>` 家族） | 0.14.6：锚点候选集补 `call_call|call`（**只进锚点、不进 transport**）；`partialProtocolAt` 前缀表同步补 `<call`/`<call_call`；`detectProtocolLeak` **同步扩集**（否则仍是假阴性） | **已修，已装，已验证**（v0.14.6） | `<calling>` 由 `\b` 保护不误伤；护栏 **15/15** 通过。**重启后正面证据**：`session-ec60921d` / `session-abaa2740` 零 `protocol-leak` 命中（修复前 `session-b01554c3` 有 4 处） |
| `TOOL_ARGS_MISSING_REQUIRED`（新族，**未归因**） | 无 | **未修** | `session-ec60921d` 实测：`tool/result isError: invalid arguments: missing required property "command"`。与 composer 无关；待判是 `fillMissingRequired` 覆盖不到这一层，还是网页模型本身漏参 |

## 2. `<call>` / `</call_call>` 泄漏（0.14.6 已修）

> **状态：已修，已装，已验证（web + headless，v0.14.6，重启已生效）。**
> 护栏 `test/protocol-leak.test.mjs` 新增 4 项，**15 项全绿**。
> 重启后正面证据：`--recent 3 --errors-only` 在 `session-ec60921d` / `session-abaa2740` 上
> **零 `protocol-leak` 命中**；修复前 `session-b01554c3` 有 4 处（`</call>` @106/@103、`</call_call>` @68/@75）。

### 症状

用户报告「harness 显示出现 `<>call` 类似的问题」。

### 逐字证据（`session-698700ea`，assistant/message 的 **text** 块）

```
seq=91  step=11  </call_call>
seq=119 step=15  </call>   （同一步 3 次）
seq=179 step=23  </call> <call_call> {"mcp_action…
seq=289 step=37  </call>
seq=326 step=42  </call_call>
seq=569 step=80  </call_call>
seq=779 step=113 </call_call>
```

`session-c710ef6e`：`seq=548 step=69  </call_call>`（1 次）。

### 根因（源码级确证）

`package/dsh-webcode-bridge/lib/agent-preset.js`：

```js
const PROTOCOL_ANCHORS = [
  /<\s*\/?\s*(?:tool_call|tool_calls|tool_result|tool_results|calls|function|stories|invoke)\b/i,
  …
];
```

**`call` 与 `call_call` 都不在这个候选集里。**

- `<call>` → 候选里有 `calls`（复数），但 `<call>` 后面跟 `>`，`calls` 匹配不上；`\b` 也救不了。
- `</call>` → 同上，不匹配。
- `<call_call>` / `</call_call>` → 完全不在集合里。

于是边界探测（`findProtocolStart`）返回 `index = -1`，**这些残片被当作正文 text-delta 外发并持久化**。

### 附带发现：检测器本身也有同样盲区

`test-mock/parse-session-log.mjs` 的 `detectProtocolLeak` 只认
`<tool_call>`、`{"mcp_action":"call"`、DSML、`<tool_result>`——
**认不出 `<call>` / `</call_call>`**。所以「日志里没有泄漏告警」并不等于「没有泄漏」。
本轮是靠**直接扫 text 块**才抓到的。

### 修法（0.14.6 已实施）

1. `PROTOCOL_ANCHORS[0]` 候选集加 `call_call|call`：
   `(?:tool_call|tool_calls|tool_result|tool_results|call_call|calls|call|function|stories|invoke)`。
   安全性：`\b` 之后 `call` 只在标签形（`<call>`、`</call>`、`<call `）命中；
   `<calling>` 里 `call` 后跟 `i`（都是词字符）→ `\b` 不成立，**不会误伤**（有专门护栏）。
2. **只加进边界锚点，不加进 transport 判定**——残片不是待执行调用，与 0.14.5 对
   `tool_result` 的立场一致。
3. `partialProtocolAt` 的前缀表同步补 `<call` / `<call_call`：流式途中 `<cal` / `<call`
   这类半成品若不在前缀表里，仍会被当正文发出（`partialProtocolAt` 是第二道防线）。
4. `detectProtocolLeak` **同步扩集**——本轮最重要的方法论修正：检测器与被保护的正则
   共享同一个盲区时，「日志没有泄漏告警」是**假阴性**。以后再扩锚点，必须同时问
   「检测器认得吗」。
5. 护栏 4 项：真实残片形状是锚点 / 残片永不 transport / 残片不吞前面的散文 /
   `<calling>` 不是锚点。

### 为什么这值得优先修

这是**用户直接可见**的 UI 污染（与 0.14.5 已修的 `</</` 同族），
且现有护栏完全够不着——因为它们的正则和被保护的正则共享同一个盲区。

## 3. 风控纪律（不可协商）

- **反复深链同一会话地址会触发站点风控**（0.14.3 事故已实证）：探针**间隔 ≥20s、最多 3 次**。
- **风控页 ≠ 未登录**：`detectChallenge` 必须在 `judgeLoggedIn` **之前**；两者分开报。
- 探针一律用 `WEBCODE_PROFILE_DIR` 覆盖到独立 profile，**与正在运行的 DSH 隔离**。
- **本轮零真机探针**：全部为离线日志分析 + 已装包源码阅读。
- 后续若做同站多账户，风控风险**成倍**——必须每槽独立限流、探针串行化、默认不并发探测。

## 4. 与 `long-term-issues.md` 的分工

本文件是**错误码视角**的横向台账；`long-term-issues.md` 是**问题条目**视角的纵深台账。
一个事实只写一处：错误码的「已做什么适配」写在这里，问题的「为什么不现在修 / 从哪下手」
写在 `long-term-issues.md`，两边互相索引，不复制。
