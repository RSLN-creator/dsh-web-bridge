# 诊断：为什么「每个对话都新开一个对话」且时间极长

日期：2026-09-15。方法：离线解压最近会话日志 + 已装包源码核对 + 运行中桥接实时状态。**未新增任何真机探针**（沿用风控纪律）。

被查会话：

| 会话 | 事件 | 解出字符 | zstd 帧 | 时长 | 结局 |
| --- | --- | --- | --- | --- | --- |
| `session-abaa2740`（最近一次完整工作会话） | 1368 | 5,704,820 | 733 | 4h03m | turn 1 ✔ / turn 2 ✖aborted / turn 3 ✔ / turn 4 ✖ / turn 5 ✖aborted / turn 6 ✖ |
| `session-ec60921d` | 158 | 850,413 | 84 | 16m | ✔ |
| `session-b01554c3` | 855 | 4,451,756 | 456 | 3h12m | ✔×3 |
| `session-f9010b75`（本次诊断会话） | 171 | 424,073 | 92 | — | 进行中 |

---

## 结论（一句话）

**不是上下文变大了，是「网页会话槽（slot）反复丢失」+「30 秒发送间隔」两个独立缺陷叠加。**

- 「每轮新开对话」= `WEB_SESSION_LOST` → 上层 `fresh: true` 整段重建。
- 「时间极长」= 每轮发送前被 `sendGapMs = 30000` 强制等待 30 秒。

两者互不相关，必须分别修。

---

## 一、机制：会话是怎么被复用的

正常路径（`lib/index.js` `buildTurn`，第 1675–1776 行）：

```js
const keyPath = options.sessionId && cfg.contextMode === 'session' && !options.purpose
  ? [String(options.sessionId), keyAgentId].filter(Boolean).join('::')   // "<dsh-session-id>::<agentId>"
  : null;
const fresh = !st;                       // 游标在内存里 → 增量轮
else prompt = delta.text;                // 只发新消息
```

即 **一个 DSH 会话 ↔ 一个网页对话**（`contextMode: 'session'`）。首轮发全文，之后只发增量。

丢失路径（`lib/index.js` 第 1356–1359 行）：

```js
if (err?.code === 'WEB_SESSION_LOST' && typeof m.rebuild === 'function') {
  log('web session lost — replaying the full first-turn prompt into a fresh web chat');
  await drive.resetConversation(m.sessionKey).catch(() => {});
  return drive.sendTurn(m.sessionKey, m.rebuild(), { ...turnOpts, fresh: true });  // ← 新开一个网页对话
}
```

`lib/browser-driver.js` 第 1196–1254 行，`navigate === 'fresh'` 时执行 `gotoFreshChat()` —— **这就是用户看到的「新开一个对话」**。

---

## 二、根因 A：「每轮新开对话」

### 定位：站点没有会话地址形状 → `unsupported` → 必然丢

`lib/contract.js` 第 79–85 行：

```js
export function conversationNav({ siteId, origin, fresh, sessionId } = {}) {
  if (fresh) return { state: 'fresh', ... };
  if (!sessionId) return { state: 'unsupported', url: null, reason: 'no-stored-session' };
  const url = conversationUrlFor(siteId, origin, sessionId);
  if (!url) return { state: 'unsupported', url: null, reason: 'site-has-no-conversation-url-shape' };
  return { state: 'resume', url, reason: null };
}
```

`lib/providers.js` 第 45–65 行的 `CONVERSATION_URL_SHAPES` **只声明了两个站点**：`deepseek`、`glm`。

`zai` 被**故意**排除（源码注释逐字）：

> zai **故意不在这里**：真机探针在 chat.z.ai 上拿到的地址是裸根 `https://chat.z.ai/`，而 real-probe-23 在 zai 上跑一轮直接 120s 超时（captureAlive=true、replyChars=0）——**没有取到任何会话地址形状的证据**。

后果（源码注释已写明）：

> → 每一轮都 `WEB_SESSION_LOST` → 上层 fresh 重开 → 用户看到「同一会话却每轮新开对话」。

**实测槽文件确认**：

```
webcode-sessions-zai.json          →  {}          （2 字节，恒空）
webcode-sessions-glm.json          →  2 条探针条目
webcode-sessions-deepseek.json     →  6896 字节，50 个槽
```

### 第二个来源：深链被风控页拦截

`browser-driver.js` 第 1210–1253 行：导航回既有会话时，`detectChallenge` 在 `judgeLoggedIn` 之前判定；命中风控页则 `navReason='challenge-page'` → 同样抛 `WEB_SESSION_LOST` → 同样 fresh 重开。

注释里点明了这条路径的代价：

> 站点自己会把地址补成 `?lang=zh&cid=X`，而桥拼的目标是 `?cid=X`——`startsWith` 判为「不同」，于是**白白整页重载一次**，而重载正好会撞上风控验证页。

### 量化证据（`session-abaa2740`）

| 标记 | 出现次数 |
| --- | --- |
| `WEB_SESSION_LOST` | 29 |
| `web session lost`（warn） | 8 |
| `replaying the full first-turn`（**实际新开对话**） | 3，位于 T+3514s / T+4423s / T+4515s |
| `challenge-page` | 10 |
| `conversation-gone` | 0 |

即**丢会话的原因是风控页，不是会话过期**。三次重放平均间隔 500 秒。

### 已缓解的部分（不是没做）

`browser-driver.js` 第 274–287 行新增 `sessionLostCount` / `lastSessionLost`，把原先完全静默的丢会话变成面板上可核对的数字；第 2285 行起改为「地址与流两个来源都认」的 `turnSessionId()`，修掉了 GLM 恒 null 的旧缺陷。

### 会话数量确实偏多（但不是「每轮」）

116 个会话目录：

```
depth=0（用户主会话）  99
depth=1（子代理）      10
depth=2（子代理的子代理） 2
```

按 15 分钟间隙聚类成「工作块」后：**57 个工作块中有 26 个含多个会话，110 个有轮次的会话里 79 个落在多会话工作块中**。典型如 2026-09-13 05:54–06:24 半个小时内 7 个会话。

> 注意口径：这 79 个里包含用户自己开的多个会话、以及 `subagent`/`Agent Teams` 派生会话。**不能全部算作丢会话导致**。真正可归因于 `WEB_SESSION_LOST` 的是上面那 3 次重放。

---

## 三、根因 B：「时间极长」

### 定位：发送间隔被设为 30 秒，且按槽生效

实测设置文件 `C:\Users\rsyhn\.dsh\webcode-edge-profile\webcode-settings.json`：

```json
{ "sendGapMs": 30000, "subAgentSite": "glm", "subAgentMode": "own", "siteId": "kimi" }
```

`lib/metrics.js` 第 68–80 行 `computeSendGap`：本轮距上次**发出**不足 `gapMs` 就补满等待。

`lib/index.js` 第 1369–1381 行在**每次** `attempt()` 前执行该等待，语义是 **send-to-send**：

```js
const gapPlan = computeSendGap({ lastSendAt: lastSendByAccount.get(accountKey) ?? null, now: Date.now(), gapMs: sendGapMs });
if (gapPlan.waitMs > 0) { log(`send gap: waiting ...`); await sleepSignal(gapPlan.waitMs, opts.signal); }
```

### 实时状态确认

```
GET http://127.0.0.1:3080/__webcode/status
  build.version     = 0.14.7
  relay.metrics.sendWaitMs  = 19558      ← 本轮发送前已等 19.6 秒
  relay.metrics.gapTargetMs = 30000      ← 目标 30 秒
  relay.metrics.sincePrevSendMs = 10442
```

### 累计代价

```
GET http://127.0.0.1:3080/__webcode/wait-stats
  累计等待发送 = 1 小时 25 分
  已统计轮次   = 402 轮
  其中等待过   = 255 轮
  平均每次等待 = 20.1 s
```

**402 轮 × 20.1 秒 ≈ 1 小时 25 分，全部是纯等待，不含任何生成或工具时间。**

### 与 `turn 2` 那 2 小时 6 分的关系

`session-abaa2740` 逐轮拆解（按 step/start→step/end 计）：

| turn | 墙钟 | step | tool-call | step ≥30s | step ≥60s | step 中位数 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 673s (11m) | 21 | 59 | 10 | 2 | 29.2s |
| **2** | **7586s (2h06m)** | **99** | **252** | **74** | **20** | 36.9s |
| 3 | 110s | 2 | 2 | 2 | 0 | 53.7s |
| 4 | 711s (12m) | 8 | 40 | 8 | 8 | 73.2s |
| 5 | 2705s (45m) | 28 | 54 | 28 | 27 | 83.2s |
| 6 | 120s | 1 | 0 | 1 | 1 | 120.1s |

step 时间占墙钟 100%，**inter-step idle 只有 1–6 秒** —— 说明时间全部花在「模型步」内，而不是工具执行。而每个 step 内至少要发一次网页请求，每次都吃 30 秒 gap。252 次 tool-call 对应的 99 个 step，**光 gap 一项就是 99 × 30s ≈ 50 分钟**。

turn 2 里最长的四个 step 分别是 **593s / 581s / 573s / 573s**，合计约 39 分钟 —— 这些是「多轮工具调用循环」的 step，每轮循环都重新吃一次 gap。

### 另一个放大项：重放首轮的体量

三次重放发生在 T+3514s / T+4423s / T+4515s。每次重放都要把**首轮全文**重新 `fill()` 进网页输入框。该会话 assistant/message 共 155 条，总计 820,360 字符，单条最大 38,286 字符。这正是 0.14.5 修掉的 P0（80 万字符一次性 `fill()` → 30s 超时）的同一量级场景；0.14.5 已改为分块写入（`composerWritePlan`），本会话未复现 `locator.fill` 超时，但**重放本身的耗时仍存在**。

---

## 四、次要失败（同样拉长时间）

`session-abaa2740` 的 6 个 turn 有 4 个异常结束：

| turn | 结局 | 逐字原因 |
| --- | --- | --- |
| 2 | `aborted` | 用户中断（已跑 2h06m） |
| 4 | `error` | `web capture ended incomplete: no_response_frames \| 流首段: event: ready data: {"request_message_id":1,...}` |
| 5 | `aborted` | 用户中断（goal 被 pause） |
| 6 | `error` | `WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在） — 本轮已中止，可重试` |

turn 4 的 `no_response_frames`（T+11254s）尤其关键：流开了 `event: ready` 就再没有响应帧，属于站点侧未产出，**不是桥的写入缺陷**。

---

## 五、结论与建议（按性价比排序）

| # | 动作 | 依据 | 风险 |
| --- | --- | --- | --- |
| 1 | 把 `sendGapMs` 从 30000 调低（或按站点分槽设） | 累计已白等 1h25m；`wait-stats` 可核对 | **低**。30s 是防限流的保守值，DeepSeek 实测 `rateLimitRetries=0`，说明当前远未触限 |
| 2 | 给 `zai` 补会话地址形状，或明确把 zai 从常用路径移出 | `webcode-sessions-zai.json` 恒为 `{}`，每轮必 fresh | 中。需一次真机探针确认地址形状（探针间隔 ≥20s、最多 3 次） |
| 3 | 降低深链重载触发风控的概率 | 10 次 `challenge-page` 命中是丢会话主因 | 中。已用 `alreadyThere` 的 id 比对修掉「白重载」，但仍需减少深链次数 |
| 4 | 把「重放首轮」的体量压下来 | 单条 assistant/message 最大 38KB，155 条累计 820KB | 中。属于桥的会话策略调整 |

**不建议**动 `contextMode: 'session'`：增量模式本身是对的，问题在槽丢失后走了 fresh 重建，而不是增量策略有误。

---

## 六、复现命令

```powershell
# 实时状态（含 sendWaitMs / gapTargetMs / sessionLostCount）
Invoke-RestMethod http://127.0.0.1:3080/__webcode/status | ConvertTo-Json -Depth 4

# 累计等待台账
Invoke-RestMethod http://127.0.0.1:3080/__webcode/wait-stats | ConvertTo-Json -Depth 4

# 会话日志归因（项目自带）
cd package\dsh-webcode-bridge
node test-mock\parse-session-log.mjs --recent 4 --errors-only

# 槽文件
Get-Content C:\Users\rsyhn\.dsh\webcode-edge-profile\webcode-sessions-zai.json
Get-Content C:\Users\rsyhn\.dsh\webcode-edge-profile\webcode-settings.json
```

---

## 附：本次诊断用到的临时脚本

均在 `.tmp/` 下，非交付物：`decode-session.mjs`（zstd 多帧解压）、`timeline.mjs`（轮次时间线）、`index-sessions.mjs`（会话索引）、`turn-timing.mjs`（逐轮拆解）、`depth-scan.mjs`（委派深度分布）、`gap-stats.mjs`、`evidence.mjs`。
