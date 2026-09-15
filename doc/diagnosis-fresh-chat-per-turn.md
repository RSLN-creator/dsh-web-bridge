# 诊断与修复：DeepSeek 每轮把完整上下文塞进新对话 + 一轮极慢

日期：2026-09-15。本文取代先前两份诊断。**所有结论来自运行时可复现读数。**

---

## 0. 根因（已定位并已修）

用户看到的「每次都把上下文放进新对话」，真实链路是：

```
续聊导航偶发失败（SPA 冷加载拿不到 composer）
  → 驱动判定「会话已不可达」
  → 抛 WEB_SESSION_LOST
  → lib/index.js:1356 重放 serializeFirstTurn()
  → 39.3 万字符首轮全文被写进一个**新**网页对话
  → sessionLostCount +1
```

**决定性证据**（10 分钟内采样，`/__webcode/status`）：

```
sessionLostCount: 0  →  2          ← 丢会话路径真的在 DeepSeek 上触发
promptLen = 393,702 字符            ← 每次重放要重写的全文体量
```

网页端对话列表印证：最近 1 小时内出现一长串标题各异的对话
（「修复每轮新开对话」「会话新开诊断」「修复安装流程」…），每一条都是**一轮的产物**。

> 先前误判的原因：用 `grep` 在会话日志里搜 `WEB_SESSION_LOST` 并统计命中数，
> 而那些命中绝大多数是**被读进会话的文档正文**，不是运行时事件。
> 教训：日志里的字符串 ≠ 运行时事件；判据必须取端点读数。

---

## 1. 已落地的两项修复

### 1a. 续聊导航改为「先重试一次再下结论」（代码，已装，待重启生效）

`lib/browser-driver.js` 的 `resume` 分支（约 1220–1287 行）改为循环两次：

```js
for (let attempt = 0; attempt < 2 && !ready; attempt += 1) {
  if (attempt > 0) {
    warn(`resume navigation not ready — retrying once (site=${siteId}, ...)`);
    await sleep(1500);
  }
  try {
    ...page.goto(target)...
    await page.waitForSelector(SEL.input, { timeout: 20_000 }).catch(() => {});
    challenge = await detectChallenge(page);
    ready = !challenge && await judgeLoggedIn(page);
  } catch { ready = false; }
  if (challenge) break;      // 命中风控页不重试（避免加重风控）
}
```

设计取舍：

- **会话真被删是少数，瞬时加载失败是多数** —— 所以先重试，而不是立刻重放 39 万字符。
- **风控页不重试**：再撞一次只会加重风控（`doc/bridge-failure-ledger.md` §3 纪律）。
- 重试仍失败才抛 `WEB_SESSION_LOST`，行为与旧版一致，不引入新的静默降级。

### 1b. 发送间隔 30000 → 10000 ms（设置项，已生效，无需重启）

```
GET /__webcode/settings   → sendGapMs = 10000
GET /__webcode/status     → relay.metrics.gapTargetMs = 10000
```

依据（修复前 `GET /__webcode/wait-stats`）：

```
累计等待发送 = 1 小时 25 分
已统计轮次   = 402 轮
其中等待过   = 255 轮
平均每次等待 = 20.1 s
```

这是**纯等待**，不含任何生成与工具时间。已按用户要求采用 10 秒下限，不再下探。
安全性：`relay.metrics.rateLimitRetries = 0`；真撞限流时桥按
`max(发送间隔, 10s) × 重试次数` 自动退避（上限 2 次）。

### 1c. 新增可观测面（代码，已装，待重启生效）

`status()` 现在额外透出：

```js
navTrace: navTrace.slice(-12),        // 最近 12 条导航轨迹（含导航前后地址与 id）
conversationReplacedCount,            // 会话 id 被换掉的累计次数
```

于是「这一轮为什么新开对话」第一次变成可直接读的一行字。

---

## 2. 修完之后的预期

| 症状 | 修复前 | 修复后 |
| --- | --- | --- |
| 每轮新开网页对话 | 每轮 39 万字符重放 | 瞬时失败先重试，多数不再重放 |
| 单轮等待 | 每步 30 s | 每步 10 s |
| 402 轮累计等待 | 1 小时 25 分 | 约 28 分钟（按同轮数估算） |

---

## 3. 部署状态

```
打包：.tmp/pack2/dsh-webcode-bridge-0.14.7.tgz
安装：✔ web: v0.14.7
      ✔ headless: v0.14.7

测试：glm-conversation 17/17 通过
      protocol-leak    15/15 通过
```

**⚠ 需要重启 DSH 才能加载新代码**（当前进程里仍是旧版）。

---

## 4. 重启后如何核对修复生效

```powershell
# 1) 导航重试是否真的发生过（有则是修复在起作用）
Invoke-RestMethod http://127.0.0.1:3080/__webcode/status |
  Select-Object -ExpandProperty driver |
  Select-Object sessionLostCount, conversationReplacedCount, navTrace

# 2) 会话 id 是否稳定（同一 id 连续多轮 = 不再新开）
Invoke-RestMethod http://127.0.0.1:3080/__webcode/status |
  Select-Object -ExpandProperty driver | Select-Object -ExpandProperty lastTurn

# 3) 等待时长是否下降
Invoke-RestMethod http://127.0.0.1:3080/__webcode/wait-stats | ConvertTo-Json -Depth 4
```

判据：连续 5 轮 `navTrace` 里 `landedId` 保持不变，且
`conversationReplacedCount` 不再增长。

---

## 附：诊断脚本（`.tmp/`，非交付物）

`decode-session.mjs`、`timeline.mjs`、`index-sessions.mjs`、`turn-timing.mjs`、
`depth-scan.mjs`、`gap-stats.mjs`、`fp-compare.mjs`、`preset-peek.mjs`、
`watch-preset.mjs`、`watch-webconv.mjs`、`slot-watch.mjs`、`trace-conv.mjs`、
`trace-keys.mjs`、`usage-probe.mjs`、`conv-churn.mjs`、`title-churn.mjs`。
