# 并列三列的「沙箱机制」· 第一轮思考（只调查、零代码改动）

> 用户 2026-09-26 指令：「然后进行沙箱啊完成任务**两轮非代码思考**」。
>
> 本文是**第一轮**：把「并列三列到底有没有文件效果」这件事查清，因为**沙箱的意义
> 完全取决于这个答案**。本文与下一轮**都不改一行代码**。
>
> 版本 0.19.29。所有结论都带取证位置；读不到的地方如实写「读不到」。

---

## 一、这一轮必须先回答的问题

用户 Q5 的原话（逐字，已记录在 [`user-voice-log`](../../doc/user-voice-log.md) 与
`column-context.js` 文件头）：

> 「……3 者独立，但是**考虑做好沙箱适配**——可能对于同一文件进行思考/修改，
>  怎么做到**选定一个模型进行主要审查**？怎么选定模型进行**同时互不影响的方案探索**」

「同一文件并发修改」是这个需求的全部前提。所以在设计任何沙箱之前，必须先证明：

> **并列三列今天到底能不能改工作区的文件？**

如果不能，那么「按列改写 workdir / 拒绝越界写」这套设计就是**为不存在的问题造的机器**
——它会有测试、有代码、有注释，却保护不了任何东西。这是本轮唯一的目标。

---

## 二、决定性取证：同一个模型有**两条**完全不同的路径

`webcode` 这个 provider 在本插件里有两条互不相干的通路。这是整件事的关键。

### 路径 ①：provider 通路（**会执行工具**，会改文件）

`lib/index.js` 把网页模型当作 **DSH 的 LLM provider** 供主会话使用。这条路上：

- 输出经过 `findProtocolStart` / `parseAgentReply` / `stripProtocolText`
  （`lib/index.js:26` 逐个 import，`lib/index.js:1457/1518/1893` 逐个消费）；
- 解析出的工具调用交给 **Harness 的工具执行器**落地 ⇒ **文件真的被改**；
- 沙箱是 **Harness 的**：`ctx.sandboxPolicy.resolve()` 按 `session.header.cwd` 定
  `workspaceRoot`（下节给官方逐字证据）。

### 路径 ②：控制面通路（**不执行工具**，只回文本）

并列三列走的是这条。`lib/client.cjs` 的 `sendCol` 调 `api('chat', …)`
（`client.cjs:2555` 附近），而 `api()` 打的是 **`/__webcode/*` 控制端点**
（`client.cjs:153` `fetch('/__webcode/' + action, …)`）。

服务端那一跳的**全部行为**（`lib/web-control.js` 的 `'POST chat'`，1414-1427 行）：

```js
const sessionKey = String(body?.sessionKey || `chat-${siteId}-…`);
const target = relay?.config?.siteConnect?.(accountKeyOf(body)) || driver;
const fresh = !stored?.webSessionId;
if (typeof target?.sendTurn === 'function') {
  const res = await target.sendTurn(sessionKey, promptText, { fresh, model: body?.model });
  return { ok: true, reply: res?.text || res || '', sessionKey, fresh, resumed: !fresh };
}
return { ok: false, error: `no-driver-for-site: …` };
```

三个读数，每一个都指向同一个结论：

| 读数 | 位置 | 含义 |
| --- | --- | --- |
| 返回的是 `reply`（字符串） | 1422 | 交给前端**显示**，不是交给执行器 |
| **没有** `session.append(...)` | 整块 1414-1427 | 不进会话日志 ⇒ 不成为模型历史 ⇒ 不参与 agent 循环 |
| **没有**任何工具派发 | 整块 1414-1427 | 没有 `edit` / `pwsh` 被执行的可能 |
| `stripProtocolText` **不在** `web-control.js` 的 import 里 | 该文件 import 段 | 协议解析只属于 provider 通路 |

前端那一跳同样只显示：`client.cjs` 的 `sendCol` 把 `res.reply` 写进该列的
`messages` 数组渲染出来，**没有**再把任何东西送回 agent 循环。

---

## 三、结论（本轮的核心事实）

> **并列三列今天对工作区没有任何文件效果。它们的产出是屏幕上的文本。**

进一步说：网页站点（chatglm.cn / kimi / deepseek 网页版…）是**普通聊天页**，
它们**根本没有文件工具**。本插件的 `columnGuidance` 又明确「不复述工具协议」
（`column-context.js:112`）。所以那一列背后的模型**在能力上就不具备**写文件的可能。

这直接改变了沙箱问题的形状：

| 原本的想象 | 实际情况 |
| --- | --- |
| 三列并发改同一个文件，需要按列隔离工作区 | 三列**都不改文件**，无冲突可言 |
| 需要「列级 workdir 改写 + 越界写拒绝」 | 没有可改写的写入方；这条链路上无写入 |
| 主审列要「合并」三列的产出 | 三列的产出是**文本片段**，不是文件差异 |

---

## 四、由此暴露的一个**真缺陷**（不是设计问题，是现在就在撒谎）

既然那一列的模型没有文件工具，那么 `columnGuidance` 里这句话：

> `你的产出请写入 \`.hwb/cols/<列键>/\`（工作区内该目录归本列使用），**不要直接修改主工作树**。`
> —— `lib/column-context.js:133`

**是在要求一个该路径做不到的动作。** 三个后果，每个都真实：

1. **模型做不到**：话后面没有工具，它只能答「我无法写文件」或干脆无视；
2. **用户被误导**：界面上看不到 `.hwb/cols/<键>/` 这个目录（因为从没有人写它），
   而提示词却说产出在那里 —— 用户去找会发现是空的；
3. **轮次 2 文档已如实记过边界**（「本插件**只做约定，不做拦截**」，
   `2026-09-26-glm-goal-round2-implementation.md` §2.4），但这句话本身连
   「约定」都算不上 —— 它是对**能力的错误断言**，不是对**行为的约定**。

按本仓库一贯纪律（`column-context.js` 设计纪律第 2 条「**不撒谎**」），
这一条必须在实施轮改掉：要么让产出目录**真的存在**（插件自己写），
要么把话改成不涉及文件的形式。

---

## 五、真正的隔离面在哪（逐个取证）

「列没有文件效果」不等于「不需要沙箱」。真实的隔离面是下面四处，
每一处的**归属者**不同 —— 这决定了本插件能做什么、不能做什么。

| # | 隔离面 | 归属者 | 本插件能否作为 |
| --- | --- | --- | --- |
| 1 | 主会话的工具执行（`edit` / `pwsh` 真改文件） | **Harness** 工具执行器 + `sandboxPolicy` | ❌ 无插槽（见下） |
| 2 | 桥自己的产物（提示词日志、列草稿） | **本插件** | ✅ 唯一能真正设围栏的地方 |
| 3 | 并列三列之间（会话身份、草稿、产物目录） | **本插件** | ✅ 已由 0.19.23 的 scope+列键命名空间承担 |
| 4 | `.hwb/` 是否进版本库 | `.gitignore` | ✅ 已覆盖 |

### 5.1 为什么 #1 本插件插不进去（官方逐字证据）

官方 `dsh-sandbox-policy` 的解析只有**一个**会话维度（`packages/sandbox/sandbox-policy/src/index.ts:164-171`）：

```ts
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
  const { session } = request
  return {
    mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
    workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
    ...session === undefined ? {} : { sessionId: session.id },
  }
}
```

三个事实卡死了「按列隔离」：

1. **`workspaceRoot` 来自 `session.header.cwd`** —— 每个 **DSH 会话**一个根，且注释
   明说是 **immutable**（「its immutable cwd becomes the workspace boundary」）；
2. **`session.append('sandbox/mode', …)` 是唯一的写路径**
   （`sandbox-policy/src/session-mode.ts:53`），它写在 **session** 上 ——
   **没有「列」这个维度**；
3. 官方围栏是 `SandboxedFileSystem.checkedTarget()` 的
   **canonicalize-then-contain 到 `workspaceRoot`**（`dsh-fs-sandbox` 的
   `types/index.d.ts` 文件头）：「列」不在这个围栏的词汇表里。

而并列三列**共享同一个 DSH 会话**（compare 视图是中央对话区的一个 view，
三列各持自己的 `sessionKey`，但那是**网页会话**键，不是 DSH 会话）。所以：
三列共享一个 `cwd` ⇒ 共享一个 `workspaceRoot`。这是结构性的。

### 5.2 官方围栏的设计口径值得照抄（这是轮次 2 的素材）

官方把围栏的诚实边界写在自己的类型文档里，逐字：

> 「The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
>  **NOT a kernel boundary** … This is **containment, not a security boundary**;
>  kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job.」
> —— `dsh-fs-sandbox/lib/types/index.d.ts` 文件头

以及它接受的残留风险：

> 「The residual TOCTOU (an ancestor symlink swapped between the containment
>  re-check and the syscall) is narrowed by re-canonicalizing immediately before
>  delegating and **is accepted for this threat model**.」

这两段是轮次 2 设计「桥侧产物围栏」时的直接依据：**containment 而不是内核边界**，
re-canonicalize 后再委托，TOCTOU 如实标注为接受。

---

## 六、本轮**没有**得出的结论（留给轮次 2，不在此臆测）

1. 「让产出目录真的存在」具体怎么做：是插件把每列回复落盘？还是只落「围栏代码块」？
2. 围栏的判据要不要照抄官方 `isPathUnder` 的**文件系统身份回退**
   （Windows 8.3 短名与大小写别名）？本机就是 Windows，这条大概必须。
3. UI 上要不要明写「三列共享一个工作区、未隔离」？写在哪里（列内 / 视图头）？
4. `.hwb/cols/<scope>-<key>/` 的清理策略（运行期产物会不会无限增长）。
5. 主审列「统一审查」吃什么：把探索列的草稿**文件**列给它？还是继续用引用通道（现状）？

---

## 七、本轮的一句话结论

> **并列三列今天不改文件**，所以「按列改写 workdir / 拒绝越界写」是**为不存在的问题
> 造的机器**；真正该做的是三件事 ——
> ①**桥自己产物**的围栏（唯一真实的写入面）、
> ②让「产出目录」**真的存在**（否则那句提示词是撒谎）、
> ③把「三列共享一个工作区」**如实告诉用户**。

— 第一轮思考完，零代码改动 —
