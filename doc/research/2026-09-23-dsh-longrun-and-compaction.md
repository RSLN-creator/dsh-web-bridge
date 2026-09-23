# DSH 长跑健全性与压缩机制：真机取证报告（2026-09-23）

本文件回答用户三个问题里的后两个（第 1 个落在代码里，见
[`doc/PROMPT-ENGINEERING.md`](../PROMPT-ENGINEERING.md) 与 `lib/notices.js` 的注释）：

> 2. 探索研究 dsh 的健全性，模式下系统长久运行方法，并记录
> 3. 探索研究压缩功能实现，以及为什么 web 端不能实现自动压缩？

**本机环境**（读数都要能自己重取，故先列全）：

| 项 | 值 |
| --- | --- |
| DSH CLI | `@deepseek-ai/dsh@0.1.7-alpha.2` |
| CLI 安装点 | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（含约 300 个运行时包） |
| profile 根 | `~/.dsh/profiles/web`（`cordis.patch.yml` + `package.json`） |
| 默认模式 | `agent-preset-registry` 的 `default: standard`（profile patch L71-75） |
| 会话落盘 | `~/.dsh/sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`（**多帧 zstd**） |
| 会话投影缓存 | `~/.dsh/storages/session_projcache/sessions/*.json`（含 `contextPressure`） |
| 本机样本量 | 304 份会话文件、272 份投影缓存、823 个 `turn/start` |

> **取证方法披露**：本报告所有数字都来自上表两处本机文件，用
> `.tmp/scan-compaction.mjs` 与 `.tmp/scan-pressure.mjs` 扫描得出（脚本留档在
> `.tmp/`，不入库——按 `doc/README.md` 的约定，`doc/` 只放入库文档）。
> 扫描会话必须解**多帧** zstd：Node 的 `zstdDecompressSync` **只解第一帧**，
> 直接用它会把 304 份文件读成 1 份——这个坑已在 `scripts/session-read.mjs:6-7`
> 记录过，本轮又踩了一次（第一次扫描得出「447 个文件里 0 个含 compaction」，
> 那个结论**是错的**，因为 444 个是 `.zstd`）。重扫后的结论见下。

---

## 一、结论先行

| 问题 | 结论 | 关键读数 |
| --- | --- | --- |
| DSH 有没有自动压缩？ | **有**，且默认开启（`compaction-basic` 的 `auto: true`） | `standard.patch.yml:63-79` 挂了完整一组 |
| 本机跑过压缩吗？ | **一次都没有** | 304 份会话里 `compaction/start` / `compaction/summary` / `compaction/end` **零命中** |
| 为什么没跑？ | **压力从没到过阈值**——最接近的一次只到窗口的 **59.4%** | 阈值 80%（或更低），最高读数 594,000 / 1,000,000 |
| 所以「web 端不能自动压缩」的真相是？ | **不是不能，是没被触发**。机制完整、装配完整，没跑过是因为没跨过触发点 | 见 §三 |
| 那为什么用户感觉「上下文不动 / 一直不压缩」？ | 声明窗口 `1,000,000` 是**乐观值**，而 transcript 实际规模远小于它；分母大 → 百分比小 → 圆环看起来不动 | `max inputTokens` 实测 594,000 |

**最重要的一句话**：桥向 DSH 声明的 `contextWindow` 不是模型规格，而是
**「本桥愿意让 transcript 长到多大」**（`lib/index.js:750-756` 的注释、
`long-term-issues.md` §1 的既定立场）。DSH 的压缩阈值是这个数的一个比例，
所以**声明值直接决定压缩何时触发**——声明 1M，就等于告诉 DSH「到 80 万再说」。
本机历史最高只跑到 59.4 万，于是永远差一口气。

---

## 二、压缩功能是怎么实现的

### 2.1 装配：谁在跑压缩

`standard` 模式（`dsh-web-app/presets/standard.patch.yml:63-79`）挂了一组四个插件：

```yaml
- id: compaction
  name: cordis:group
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
```

四条独立能力（`dsh-compaction-basic/README.md:32`）：

1. **自动压缩**：对话长到接近模型上限时，把最老的一段历史压成一条摘要；
2. **溢出恢复**：确认收到 `CONTEXT_WINDOW_EXCEEDED` 后压缩并重试；
3. **`/compact` 按需压缩**：不等压力，立刻压；
4. **工具结果修剪**：压缩**之前**先把超大工具输出裁掉（`thresholdChars: 8192` 起裁，
   留头 4096 + 尾 1024）。这一步**不花模型调用**，裁完如果已经够了就完全跳过摘要。

### 2.2 触发公式（决定一切的那一行）

`dsh-compaction-basic/README.md:62` 给出默认触发点：

```
threshold = floor(min(W × 0.8, W − O − B))
```

| 符号 | 含义 | 来源 |
| --- | --- | --- |
| `W` | 上下文窗口 | **adapter 的 `resolveModel` 返回的 `context.contextWindow`** |
| `O` | 该路由为输出预留的 token | 路由 envelope 的 `maxTokens`，回落 adapter 默认，再回落 0 |
| `B` | `headroomTokens`，默认 **65,536** | 插件配置 |

保留近期历史 `retainRatio` 默认 **0.16**（占 `W − O` 的比例），其余可调项见
`dsh-compaction-basic/README.md:64-76`。

**0.1.7 相比 0.1.6 的变化**（`doc/diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md:96-121` 已记）：
新增 `B`，阈值从 `W × 0.8` 变成 `min(W × 0.8, W − O − B)`。对官方
`deepseek-official`（W=1M、O=256k、B=65,536）即从 **800,000 → 678,464**（少约 12%）。

### 2.3 `W` 从哪来——这是全部问题的枢纽

DSH 不猜窗口，它**问 adapter**。桥的实现在 `lib/index.js`：

```js
// lib/index.js:740-745（唯一取值处）
function contextWindowFor(m) {
  return cfg.contextWindowBySite?.[m?.siteId]   // ① 运维/测试覆盖（最高）
    ?? m?.budget                                 // ② providers.js 的 budget
    ?? m?.context                                // ③ providers.js 的 context
    ?? (m?.siteId === 'deepseek' ? 1_000_000 : 64_000);  // ④ 兜底
}
```

`resolveModel` 把它交给宿主（`lib/index.js:808`）：

```js
return { provider, id: model || m.id, name: m.name, context: { contextWindow }, inputModalities };
```

而 `cfg.contextWindowBySite` 的默认值就是（`lib/index.js:251`）：

```js
contextWindowBySite: { deepseek: 1_000_000 },
```

`providers.js:150` 的 deepseek 模型同样声明 `context: 1_000_000, budget: 1_000_000`。
**于是 `W = 1,000,000`，阈值 = `min(800,000, 1,000,000 − 0 − 65,536) = 800,000`**
（`O` = 0，因为桥不返回 `defaultMaxTokens`，且本机 request header 里没有 `maxTokens`
——实测 `maxTokens in headers: (none)`）。

> `O = 0` 这一条很重要：`diagnosis-2026-09-23` §2.2 说过，一旦给该模型填了
> `maxTokens`（比如 256k），阈值立刻掉到 678,464。本机**没填**，所以停在 800,000。

### 2.4 压缩怎么落地（事务形态）

`dsh-compaction-basic/README.md:107-125` 描述的是一个**先记账、后替换**的事务：

1. 校验范围与存活锁 → **同步**追加 `compaction/start`；
2. 准备并等待摘要（一次额外的模型调用，`purpose: 'compaction'`）；
3. 重新校验稳定性 → 追加 `compaction/summary` + 替换消息（一条带
   `<compacted-summary>` 标签的 user 消息）；
4. 恰好一次 `compaction/end`。

摘要调用**复用 provider 的暖前缀**：把 surface 节点 0 的 `system/message`、上一次路由请求
的 tools、被遮蔽区间的消息**逐字节**重放，只在尾部追加压缩指令——这样它是一次真正的
前缀，只有指令与摘要输出是未缓存的（`README.md:108`）。

**它压不动什么**（`README.md:12`）：系统提示词、工具定义、会话前缀
（session prefix）都压不掉；单个不可分割的大单元（比如一次巨大的工具调用）也压不掉。
所以「压缩能解决上下文爆炸」是有上限的——**能压的只有历史消息**。

---

## 三、为什么本机从来没压缩过——真机读数

### 3.1 事件级证据：零命中

扫 304 份会话（多帧 zstd 全解），统计全部事件类型：

```
   24058 tool/result
   24042 tool/call
   17530 step/start
   17520 step/end
   17236 assistant/message
    2253 agent/inbox/spliced
    1805 user/message
     823 turn/start
     812 turn/end
     571 request/header
     506 session-log-deepseek/delivery-accepted
```

**`compaction/start`、`compaction/summary`、`compaction/end`、`compaction/summary-error`
一个都没有。** 823 个 turn、24,000 次工具调用，压缩零次。

（能搜到的少数「compaction」字样全是**工具结果里的文本**——比如某次 `read`
读到了 `doc/deepseek-longrun.md` 里讨论 compaction 的段落——不是压缩事件本身。）

### 3.2 压力级证据：最接近的一次是 59.4%

读 272 份投影缓存的 `contextPressure.val`：

| 百分比 | pressureTokens | contextWindow | 会话 |
| --- | --- | --- | --- |
| **59.4%** | 594,000 | 1,000,000 | `session-0f9fe6cf…` |
| 54.2% | 542,158 | 1,000,000 | `session-537cb0d6…` |
| 48.0% | 480,227 | 1,000,000 | `session-4d1486c3…` |
| 46.6% | 465,799 | 1,000,000 | `session-28d6164b…` |
| 46.3% | 463,365 | 1,000,000 | `session-054f1744…` |

```
max pressure ratio        : 59.4%
sessions >= 60% of window : 0
sessions >= 80% of window : 0
distinct contextWindow    : 1000000, 64000, 262144, 65536, 200000, 66560, 53248
```

**阈值是 80%（=800,000），历史最高 594,000。差了 20.6 个百分点、约 206,000 token。**
压缩一次都没触发，是因为**从没靠近过**触发点——不是因为机制坏了。

### 3.3 三个被排除的替代解释

| 假设 | 为什么被排除 |
| --- | --- |
| 「web 端没挂压缩插件」 | 排除。`standard.patch.yml:63-79` 明确挂了 `compaction-basic` + `command-compact` + `tool-result-pruner`；profile patch L71-75 明确 `default: standard` |
| 「插件加载失败静默降级」 | 排除。配置不合法会**加载期就拒**（`README.md:78`：未知设置、重复 per-model 覆盖、非法 token 数、两种保留形式并用、`retainRatio >= thresholdRatio`，任一都让插件挂载失败） |
| 「是 `minimal` 模式所以没压缩」 | 排除。`minimal` 确实**没有**压缩（`dsh-client-ui-agent-preset/lib/client.js:119`），但本机默认已是 `standard`。`doc/deepseek-longrun.md:33-46` 记过历史上曾配成 `minimal`——那是**过去**的状态，已修 |

---

## 四、「web 端不能自动压缩」的更正

用户感受到的现象是真的（圆环长期不动、transcript 只增不减），但**归因不对**。
真实因果链：

```
桥声明 W = 1,000,000（乐观值，不是模型规格）
        ↓
DSH 压缩阈值 = 800,000
        ↓
网页桥的实际单轮 transcript 规模远小于此
（实测历史最高 pressure = 594,000，多数会话在 40% 上下）
        ↓
压缩永不触发 → transcript 只增不减 → 圆环百分比看起来「不动」
```

**这不是 web 端独有**——任何把 `contextWindow` 声明过大的 provider 都会有同样表现。
它在 web 桥上特别突出，是因为桥的声明值**没有权威规格可依据**：网页 composer 的
真实上限是网页端实现细节、没有对外契约（`long-term-issues.md:127-128`）。
桥选了「保守声明 + 越界明确报错」而不是「猜一个精确值」。

### 4.1 三条可自证的方法（一分钟）

1. `GET http://127.0.0.1:8931/__webcode/context-windows` — 桥声明的窗口与来源；
2. 会话投影缓存里的 `contextPressure.val`：`pressureTokens / contextWindow` 就是圆环读数；
3. GUI 模型选择器里该模型的 context 值 —— 应与 ① 逐字一致。

### 4.2 想让压缩真的跑起来，有四个旋钮

| 旋钮 | 位置 | 效果 | 代价 |
| --- | --- | --- | --- |
| **调小声明窗口** | `cfg.contextWindowBySite.deepseek` | 最直接。改成 100,000 → 阈值 80,000，长会话里立刻触发 | 声明小于真实能力时压缩**偏早**，多花压缩调用（不丢内容） |
| **调低 `thresholdRatio`** | `compaction-basic` 插件 config | 全局提前触发，如 `0.5` | 对所有 provider 生效，包括官方 API 模型 |
| **`/compact` 手动压** | 聊天框输入 | 不等压力立刻压，报告条数与省下 token | 只在 agent 空闲时可用（`dsh-command-compact/README.zh.md:141`） |
| **调大 `headroomTokens`** | `compaction-basic` config | 阈值下降，更早触发 | 需同时保证 `maxTokens` 为正 |

> **务必先读这条**：调小声明窗口会让桥**更早**拒绝越界轮（`CONTEXT_WINDOW_EXCEEDED`，
> `lib/index.js:761-780`）。这个闸只拒 `ratio > 1`，所以把窗口调到低于真实需求会
> **直接打断长会话**。声明值是「本桥愿意让 transcript 长到多大」的运维决定，
> 不是模型规格——改它之前先看清这一点。

---

## 五、DSH 长跑健全性：有哪些机制

### 5.1 内置的长跑支撑

| 机制 | 包 | 作用 |
| --- | --- | --- |
| **自动压缩** | `dsh-compaction-basic` | 压力过阈值时压历史；溢出后压缩重试（`maxOverflowRetries` 默认 1） |
| **工具结果修剪** | `dsh-compaction-tool-result-pruner` | 压缩前先裁超大工具输出，**不花模型调用**；裁完够了就跳过摘要 |
| **会话持久化** | `dsh-session-persistence-jsonl` | 每个事件一行 JSONL，多帧 zstd 落盘；崩溃后可重放 |
| **检查点策略** | `dsh-session-checkpoint-policy` | 决定何时写检查点 |
| **投影缓存** | `dsh-session-projection-cache` | 缓存 surface/pressure 投影，重启不必全量重算 |
| **LLM 重试** | `dsh-llm-retry` | 请求级重试 |
| **后台作业** | `dsh-jobs-local` | 长命令转后台，不阻塞回合 |
| **目标续跑** | `dsh-goal` + `dsh-goal-round-driver` + `dsh-tool-goal` | 跨回合的目标推进 |
| **`/compact`** | `dsh-command-compact` | 手动压缩入口 |

### 5.2 桥自己这一侧的长跑防护

桥在网页模型前面，它**必须**假定网页会漂移。已在位的（每条都有真机依据与护栏）：

| 防护 | 位置 | 真机依据 |
| --- | --- | --- |
| **自动续跑** | `lib/index.js` 的 `autoContinueRound` | session cd997dd3：UNPARSED 连三轮，两次靠用户手动催活 |
| **再教学只走补发通道** | 同上 | 0.16.29 用户指令「直接隐藏」 |
| **`WEB_SESSION_LOST` 整段重放** | `prompt-store.js` + `index.js` | 网页会话被删/过期时重放首轮 |
| **重建节流（60s）** | `index.js` | 会话槽空 → 每轮重放 40 万字符 → 雪崩 |
| **`PROMPT_TRUNCATED` 回读校验** | `browser-driver.js` + `prompt-compact.test.mjs` | 输入框静默截断 11 个字符、整轮作废 |
| **`PROMPT_TRUNCATED` 压缩重试** | `serializeFirstTurn({maxPromptChars})` | 超预算时丢最旧消息段 + 显式省略标记 |
| **发送前预算闸** | `assertContextBudget` / `CONTEXT_WINDOW_EXCEEDED` | 发出前拦下越界轮，网页端未被写入 |
| **发送间隔 + 限流退避** | `sendGapMs` / `RATE_LIMITED` | 站点滑窗限流 |
| **提示词落盘** | `prompt-store.js` | 整段重建时**以磁盘为准**，不是内存 |

### 5.3 长跑推荐姿势

综合本机读数与既有台账（`doc/deepseek-longrun.md` §四）：

1. **别用 `minimal` 跑长任务** —— 它没有压缩、只有 2 个工具
   （`dsh-client-ui-agent-preset/lib/client.js:119`）。本机已是 `standard`，保持。
2. **长会话主动 `/compact`** —— 既然自动阈值（800k）在正常使用下够不着，
   手动压就是**唯一实际生效**的压缩路径。这是本报告最可操作的一条建议。
3. **别给 webcode 模型填 `maxTokens`** —— 填了会把阈值从 800k 拉到 678k，
   同时提高压缩频率与成本。除非确实需要那个输出上限。
4. **发版/长跑前跑一次 `pnpm doctor`** —— `test-mock/real-verify.mjs` 校验
   模型 `model_type` 与工具闭环；网页改版时这是最快的报警器。
5. **长任务留轨迹** —— `real-probe-17-autonomous-marathon.mjs` 单任务、零干预、轨迹落盘。
6. **别把「压缩没触发」当成故障** —— 先量 `pressureTokens / contextWindow`，
   没到 80% 就是没到，不是坏了。

---

## 六、未证实 / 开放问题（不许当结论用）

1. **「网页 composer 真实上限」仍是未知数**。桥声明 1M 是乐观值，真机只验证过
   「十万级字符能稳定收下」。上限只能靠二分探测得出，且会随网页改版失效
   （`long-term-issues.md:149-160`）。
2. **没有做过「压缩触发」的正向实验**。本报告的结论是**观察性的**：历史数据里
   压力最高 59.4%，所以没触发。**没有**跑过一次「把会话撑过 80% 看压缩是否真的工作」
   的对照实验。要补，需要一个刻意撑大的会话。
3. **`pressureTokens` 与阈值分母是否严格同源**，未逐行核对。`contextPressure` 来自
   投影缓存，而 `compaction-basic` 判定压力走 `ctx.tokenMeter`；`README.md:106` 说
   「同一个读数服务给所有决策定价」，但本轮**没有**读 `dsh-token-meter` 的实现去
   验证两者在数值上逐字一致。
4. **`doc/progress.md:102` 里「webcode/deepseek 未设 maxTokens 时仍是 800k」这条**，
   本轮用「request header 里 `maxTokens: (none)`」间接佐证，但没直接打印解析出的阈值。
5. **其它 provider（official / pi-ai）的压缩行为未测**。本报告只覆盖 webcode/deepseek。
6. **`contextWindow` 分组里的 64000 / 66560 / 53248** 等值来自未校准站点或别的
   provider，本轮没有逐一会话归因（只知道 64000 那批历史上全是 `webcode/glm:glm-5.3`，
   见 `diagnosis-2026-09-23` §2.1）。

---

## 七、与用户第 1 个问题的接口

第 1 个问题（改标准模式模板 / 精简优化提示词 / 优化 auto_continue 提示词 +
好看的 markdown + 与正文区分）落在代码与既有文档里，不在本报告：

- **提示词工程的立场与纪律** → [`doc/PROMPT-ENGINEERING.md`](../PROMPT-ENGINEERING.md)
  （三条立场、宽容层边界、真机对照读数、「不宣称最优」的元纪律）；
- **标准模式模板本体** → `dsh-web-app/presets/standard.patch.yml`
  （`persona` 的 `prefix`/`suffix` 是唯一可直接改的两行；`plan-mode.section` 是另一段长提示词）；
- **auto_continue 提示词与展示文案** → `lib/index.js` 的 `autoContinueRound`
  （补发提示）+ `lib/notices.js` 的 `autoContinuedNotice`（外发文案），
  护栏在 `test/auto-continue-notice.test.mjs`。








