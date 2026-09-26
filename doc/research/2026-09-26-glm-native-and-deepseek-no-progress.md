# 0.19.23：GLM 原生格式补齐 + `json` 正文泄漏根因 + deepseek 无进展失败取证

> 本轮只做三件事（用户 2026-09-26 指令，逐字）：
>
> 1. 「查看为什么这个会话会中断和出现 json 正文」（只查，不扩范围）
> 2. 「再加上一个他的那个原生 glm 格式的参考和调用放入新版本」
> 3. 「检查没有引入问题后才打包安装」
>
> 另加一问：「查看这个 deepseek/deepseek 失败原因真实情况：是否为问题需要解决？」
>
> **范围纪律**：不动 `doc/` 以外的既有任务清单，不动并列会话/任务板，不动 DeepSeek 官方模板分支。

---

## 一、结论摘要

| # | 问题 | 结论 | 状态 |
| --- | --- | --- | --- |
| 1 | **`json` 正文泄漏** | **根因已找到并在端到端复现**：`closingFenceAfter` 把**开启**的调用围栏当**闭合**围栏消费，只吃掉三个反引号，剩下语言标签 `json` 被当正文外发。**与增量切分粒度相关**，所以既有护栏（只跑逐字符）从没抓到它 | ✅ 已修 + 已加护栏 |
| 2 | **GLM 原生格式** | GLM 原生把代码块作为**结构化 `code` part**（`content[].type === 'code'`），而 `GlmDecoder` 此前**完全丢弃**它 —— 真机形态下**整条调用会消失** | ✅ 已补 + 已加护栏 |
| 3 | **会话中断** | 两个不同会话、两种不同中断：<br>· `session-53201b58`（glm）turn4 step3 **只出思考不出调用** → `turn/end completed`（不是报错）<br>· `session-e7056e8c`（deepseek）turn3 step58 **`WEB_NO_PROGRESS`** | 已定性；见 §四 |
| 4 | **deepseek/deepseek 失败是否要修** | **是真问题，但要分两层看**：失败本身是「网页侧 120s 没吐任何东西」的超时（复发型，近 14 个会话里 5 个出现过）；而**报错文案在其中一个分支上是假陈述**——那是确定的可修缺陷 | ✅ 文案缺陷已修；超时本身见 §四.5 |

---

## 二、GLM 原生格式：被静默丢弃的 `code` part（任务 2）

### 2.1 参考实现怎么说

`reference/glm-free-api/src/api/controllers/chat.ts:994-1013` 把 `type == 'code'` 当**一等公民**：

```ts
} else if (type == "code" && partStatus == "init") {
  let codeHead = "";
  if (!codeGenerating) { codeGenerating = true; codeHead = "```python\n"; }
  const chunk = code.substring(codeTemp.length, code.length);
  codeTemp += chunk;
  return innerStr + codeHead + chunk;
} else if (type == "code" && partStatus == "finish" && codeGenerating) {
  const codeFooter = "\n```\n";
  ...
}
```

即：在这条 SSE 流里，**`code` 与 `text` 是并列的两种正文载体**，参考实现为 `code` 拼围栏后交给上层。

### 2.2 本桥此前只实现了一半

`GlmDecoder.obj()` 的分支只有 `tool_calls` / `tool_result` / `think` / `text` / `image`
——`type === 'code'` **一路落到数组末尾被静默忽略**。

### 2.3 离线实证（`.tmp/probe-glm-native.mjs`）

| 用例 | 修复前 | 修复后 |
| --- | --- | --- |
| ①a 调用 JSON 放进 `type:'code'` | `deltas: []`、`text: ""` ⇒ **调用整个消失** | `deltas: ["{…}"]`、`text: "{…}"` ⇒ 出来了 |
| ①b 同一段放进 `type:'text'`（对照） | 正常外发 | 正常外发（未变） |

### 2.4 修法（`lib/decoder.js` 的 `GlmDecoder`）

- 新增 `type === 'code'` 分支，去重逻辑与相邻 `text` 分支**同形**（单槽 key `'code'`，
  前缀吸收，因为 GLM 的 finish 帧会重发全量）。
- **判据刻意收窄**：只有「含 `"mcp_action"` 或首格是 `{`」的 code part 才接进正文通道。
  普通代码块（GLM 自带代码解释器等）**维持既有行为——丢弃**。理由：把模型内部的草稿
  代码整段铺进会话，比丢一个调用是更常见的噪声；且既有行为不该在无证据时改变。
- 解析**不新开第二条通路**：emit 出去的文本仍交给既有协议解析器（`findProtocolStart`
  的裸 JSON 锚点认 `{\s*["\{]`）。

护栏：`test/multi-site-decoder.test.mjs` 新增「★ 0.19.23 glm：原生 code part 携带的调用
必须解出来（普通代码块仍不外发）」，覆盖三件事：调用形态必出、普通代码块不出、分段累积不重复。

---

## 三、`json` 正文泄漏：根因与修复（任务 1）

### 3.1 现场（真机会话 `session-53201b58`）

解会话（多帧 zstd，654 帧）后 `turn4 step1` 的助手内容形状：

```
reasoning:29262, text:62, call, text:4, call, text:4, call, call, text:4, call, text:4, call
```

那 4 个 **`len=4` 的正文块内容恰好都是 `json`**，**夹在 6 个 tool-call 之间**。
另在 `turn3 step2` / `turn4 step2` 见到缺前缀的残片 `name": "pwsh", "purpose": …`
（缺 `{"mcp_action": "call", `）。

### 3.2 根因（单元级 + 端到端双重确认）

`lib/agent-preset.js` 的 `closingFenceAfter(text, from)` 契约是「紧跟在一个**已消费调用
JSON** 之后的**闭合**围栏起点」。而它的旧判据只看「游标之后隔空白、紧接着是 ` ``` `」：

```js
while (i < src.length && /\s/.test(src[i])) i += 1;
return src.startsWith('```', i) ? i : -1;       // ← 开启围栏也满足
```

而流式循环的**增量分支**对每个增量都调它，下一个增量的开头常常正是**下一个调用的开启围栏**
`\n\n```json\n{…}`。于是调用方做 `protocolFrom = cf + 3` 时**只吃掉了三个反引号**，
后面四个字符 `json` 落在协议区间之外 → 被当正文外发。

单元级读数（`.tmp/probe-json-leak-mechanism.mjs`）：

```
acc = call1 的 JSON + "```" + "\n\n" + "```json\n" + call2 的 JSON + "```"
closingFenceAfter(acc, 70) = 72   → 指向 ```` ```json ````（**开启**围栏）
协议游标推进到 75 后，剩下首段 = "json\n{\"mcp"          ← 泄漏的正是这 4 个字符
```

### 3.3 为什么既有护栏 842 条全绿也没看见（**这是最要紧的一条**）

`test/fence-tail.test.mjs` 的 ① 已断言正文**逐字相等**，本应抓到。实测：

| 跑法 | 结果 |
| --- | --- |
| 把新判据变异掉 + 既有护栏（`sliceChars = 1`） | **10/10 仍然全绿** |
| 把新判据变异掉 + **换切分粒度穷举** | **4/10 泄漏**（含 `slice=16`） |

```
slice=16  泄漏: json,prose!=预期  正文="收到。这是一个组合任务，我先建立任务清单。\n\njson"
```

⇒ **泄漏与增量在哪儿被切开强相关**。既有护栏只跑「逐字符」一种切分，
而那些边界恰好不触发；真机 SSE 的增量边界是任意的，于是它必然偶发。
这不是「护栏写错了」，是**护栏的输入分布太窄**——一条只有单一切分粒度的流式护栏，
对「边界敏感」的缺陷天然失明。

### 3.4 修法

`closingFenceAfter` 增加一条**窄**判据，只排除真实的开启围栏形状：

```
围栏之后若「信息串非空（```json 这类）」**且**「信息串之后首个非空白字符是 `{`」
⇒ 这是一枚开启的调用围栏，返回 -1（不消费）。
```

真闭合围栏是裸 ` ``` `（信息串为空），**永远照常消费**——所以不会误伤
「闭合围栏后面紧跟一段以 `{` 开头的散文」。另补一条：围栏之后**没有换行**且信息串非空
（= 刚开、还没写完的开启围栏）同样不消费。

### 3.5 修复读数

| 跑法 | 结果 |
| --- | --- |
| 带修复 + 48 种切分粒度穷举 | **✔ 48/48 无泄漏** |
| 带修复 + 边界组 `3,4,5,6,7,8,11,12,13,16` | **✔ 10/10 无泄漏** |
| 去掉修复 + 同一组 | **✖ 4/10 泄漏** |
| 去掉修复 + `slice=1`（既有护栏） | 全绿（**证明既有护栏对边界敏感缺陷失明**） |

### 3.6 遗留（诚实标注）

- 本轮修掉的是**已复现的那一条**路径。真机会话里那 4 个 `json` 块是否**全部**由它产生，
  未能逐条对上（真机没有留存当轮的原始 SSE 增量边界）。
- 残片 `name": "pwsh", …`（缺 JSON 头）是**另一个形态**，本轮未修、也未定性。
- 下一步建议：把「切分粒度穷举」推广到其它流式护栏（它们大概率有同样的失明面）。

---

## 四、deepseek/deepseek 失败取证（用户加问）

### 4.1 现场（`session-e7056e8c` turn3）

```
turn/end  turn:3  reason: error
  WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，
    上一轮收束原因（122s 前） finished，
    判定相位=已开流后的静默，
    最近驱动活动时间 1s 前，
    页面已有 0 字回复未回传）
```

- 发生在 **turn3 step58**：step57 正常结束（`step/end` 于 `…164930`），step58 `step/start`
  于 `…164951`，**120 秒后**看门狗开火（`…284984`）。
- 该轮**没有任何工具调用产出**，是一条纯超时。
- 会话上下文压力：`surfaceTokens 80995 / contextWindow 1000000`（**8%**），
  `pressureTokens 138874`（13.9%）——**远未触顶，不是上下文超限**。

### 4.2 复发面（近 14 个会话实测）

| 会话 | WEB_NO_PROGRESS |
| --- | --- |
| session-e7056e8c（本会话） | 1 |
| session-3e4159fc | 1 |
| session-66be8df0 | 1 |
| session-0b292806 | **3** |
| session-a552eb11 | 1 |
| 其余 9 个 | 0 |

⇒ **复发型**，不是偶发；`session-0b292806` 一轮里出现 3 次。

### 4.3 定性：这是哪一类失败

看门狗的判据在 `lib/idle-window.js`，它的设计初衷（文件头有完整事故记录）就是把两件事分开：

- **prefill**（首字节未到 + 驱动在忙）⇒ 宽限 `×2`（并受整轮预算 90% 上限约束）；
- **mid-stream**（已开流后静默）⇒ 常规窗口，**不给宽限**。

本次报的是「已开流后的静默」。同时驱动侧读数齐备：`页面在`、`最近驱动活动时间 1s 前`
（WIP 巡检器还在采到页面 ⇒ 链路活的）、`页面已有 0 字回复未回传`（⇒ 网页那一侧**没写出正文**）。

⇒ 就现有证据，最贴近的定性是：**网页侧开了流却长时间不产出**，桥按设计判死。
**不是**捕获链死亡，**不是**上下文超限，**不是**账号锁（锁由活着的 pid 3296 持有且本轮无 `BRIDGE_ACCOUNT_BUSY`）。

### 4.4 但报错文案有一个**确定的缺陷**（已修）

`idleWindowDecision` 在**两种**情形都返回 `phase: 'mid-stream'`：

```js
if (firstEventAt !== null) return { …, phase: 'mid-stream', … };      // ① 真·开流后静默
if (driverBusy !== true)   return { …, phase: 'mid-stream', … };      // ② 没开流且驱动不忙
```

而报错文案只印 phase ⇒ 把 ② 印成「**判定相位=已开流后的静默**」——那是一句**假陈述**，
它紧挨着「最近驱动活动时间 1s 前」并排出现，读起来自相矛盾，排查方向当场被带偏。

**修法（加法，零行为变更）**：`idleWindowDecision` 每个返回分支多带一个显式布尔
`firstEventSeen`；文案据此把两种情形分开说：

- `firstEventSeen === false` ⇒ 「判定相位=网页还没开口且驱动不在忙（按常规窗口未宽限）」
- 否则 ⇒ 「判定相位=已开流后的静默」（原样）

`phase` 取值与窗口计算**逐字未变**（既有 `idle-window` / `watchdog-first-byte` 护栏原样通过）。

### 4.5 「是否为问题需要解决？」——分层回答

| 层 | 判断 | 依据 / 处置 |
| --- | --- | --- |
| **① 报错文案假陈述** | **是，已修** | 上面 §4.4；小、安全、可反向验证 |
| **② 120s 无产出的超时本身** | **是问题，但根因不在桥** | 桥的读数显示链路活着、页面在、0 字产出 ⇒ 是**网页侧**不产出。桥能做的是**如实报**（已在做）与**可重试**（已有） |
| **③ 是否要放宽窗口** | **不建议** | `idle-window.js` 文件头已写明：对「已开流后静默」给宽限会把真卡死从 120s 拖到 240s 才暴露，**比旧行为更糟**。要改必须拿配对数据说话 |
| **④ 复发面本身** | **值得下一步做** | 5/14 会话出现过。建议在报错里再补**当轮真实增量数**（现在只有相位标签），并在真机上复现一次拿到当轮 SSE 现场 |

---

## 五、闸门读数与交付

### 5.1 闸门

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 全量单测 | `node --test test/*.test.mjs` | **1083/1083 pass，fail 0**（exit 0） |
| 三条相关护栏 | `fence-tail` + `multi-site-decoder` + `idle-window` | **58/58** |
| 注释纪律 | `lint-comments` | PASS（扫描 201 文件，error 0 / warn 0） |
| 台账一致性 | `check-ledger` | PASS（version 0.19.23 / testFiles 96） |
| 仓库卫生 | `check-repo-hygiene` | PASS |
| 生成物卫生 | `artifacts-check` | PASS |

### 5.2 反向验证（变异测试，**两轮都真跑**）

| 变异 | 预期 | 实测 |
| --- | --- | --- |
| 去掉 `closingFenceAfter` 的开启围栏判据 | `fence-tail` 应红 | **2 条红**（单元级 + 切分粒度穷举），还原 12/12 |
| 去掉 `GlmDecoder` 的 `code` 分支 | `multi-site-decoder` 应红 | **1 条红**，还原 28/28 |
| `firstEventSeen` 恒定 `true` | `idle-window` 应红 | **8 条红**，还原 18/18 |

> ⚠️ 本轮踩到并记下一次**空转**：第一版变异工具路径写错（脚本在仓库根、命令却在包目录跑），
> 于是 `node .tmp-mutate.mjs` 报 `MODULE_NOT_FOUND` 而**变异根本没生效**，
> 两次「全绿」都是**假读数**。修正路径后变异才真正生效（`MUTATED ok` 是必须看到的回执）。
> 这正是本仓库记过的「空转的闸门比没有闸门更坏」——**变异工具必须回报它改到了**。

### 5.3 交付

| 项 | 值 |
| --- | --- |
| 版本 | **0.19.23**（仍在 0.19.x 内） |
| tarball | `dsh-webcode-bridge-0.19.23.tgz`（仓库根 + `package/dsh-webcode-bridge/`） |
| 打包核对 | `node scripts/verify-pack.mjs` → **逐字相同 48/48**、接线完好 |
| 装入 web profile | 实测 `package.json` **version=0.19.23**，声明指向新 tgz |
| 装入 headless profile | 同上，**version=0.19.23** |
| 包内改动抽验 | `decoder.js`（code 分支）/ `agent-preset.js`（开启围栏判据）/ `idle-window.js`（`firstEventSeen`）**三处都在** |

**用户需要做的一步**：**重启 `dsh web`**。安装只换了磁盘上的文件，正在跑的进程里仍是旧代码。

## 六、本轮**没有**做的事（边界）

- 不动并列会话 / 主审 / 引用 / 任务板 / 官方模板分支（用户范围约束）。
- 不修残片 `name": "pwsh", …` 那个形态（未定性）。
- 不放宽 `WEB_NO_PROGRESS` 窗口（无配对数据，且文件头已论证会更糟）。
- 不追真机 SSE 增量边界（本轮拿不到当轮原始帧）。

— 报告完 —
