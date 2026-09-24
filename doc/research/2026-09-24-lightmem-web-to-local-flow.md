# LightMem 与「长前缀 + 短追加」网页会话线：可落地性研究（2026-09-24）

**研究问题**：`dsh-webcode-bridge` 的首轮是一份 19k–50k token 的扁平化大提示词（DSH 系统提示 + 工具表 + JSON schema + 官方工具调用协议教学 + 技能目录），后续每轮只追加增量。这条线的成本模型是「一次昂贵预填充 + 廉价追加」。LightMem 一类的记忆/上下文工程工作里，有哪些技术**真的**能改善这条线？

**范围纪律**：本文只收录能映射到「长可复用前缀 + 短追加 + 网页为唯一载体（无 API、无 cache 控制位、页面侧缓存行为未公开）」的技术。每条非显然结论都给 URL；作者自己的推测标 **推断**。本文不改动任何代码。

---

## 0. 结论先行

1. **LightMem 是记忆层，不是上下文工程层**。它解决的是「对话历史放不进窗口 / 检索不准」的问题；本桥的对话历史**由网页自己保存**，不存在这个问题。因此 LightMem 的主体（LTM、向量检索、记忆演化）对本桥**不适用**。
2. 真正可搬的只有三条：**(a) 按变更频率而非按重要性排列前缀段**；**(b) 压缩只允许在「冻结边界」做，且必须确定性可复现**；**(c) 把「离线巩固」搬到重建路径上**。其中 (a) 是零风险高收益，(b)(c) 需要配对实测。
3. 最重要的**反直觉结论**：本桥当前的首轮段序（`preset → [会话开始] → 会话正文 → transport`）把**稳定**的协议段放在**易变**的会话正文之后。按厂商公开的前缀缓存规则，这等于让 transport 段在每次整段重建时都白白冷启动。而 transport 段之所以被刻意放在最后，是因为「临出手前再看到一次形状」这一位置性收益（见 `agent-preset.js` deepseekTransport 注释）。**这是一个真实的两难，不是纯粹的疏忽**，必须先测量再动（§6 P0-1 给出不牺牲位置收益的解法）。
4. **网页版是否复用 DeepSeek 的 disk KV cache，无公开文档，本文不作断言**（推断：很可能同源，因为同一批模型与推理栈；但这是推断，必须实测）。因此下文所有改动都设计成「即使网页侧完全不缓存也不变差，只变短/变稳」的形式。

---

## 1. 「lightmem」到底指什么

同名不同源，**至少三个所指**，混用会引错结论：

### 1.1 LightMem（ICLR 2026）— 浙大 zjunlp，三阶段记忆框架

- 论文：<https://arxiv.org/abs/2510.18866>（HTML: <https://arxiv.org/html/2510.18866v1>），代码：<https://github.com/zjunlp/LightMem>。
- 动机来自 Atkinson–Shiffrin 人类记忆模型，三段：
  - **Light1 感觉记忆（sensory memory）**：先用压缩模型做**逐 token 二分类**「保留/丢弃」，阈值取保留分数的第 r 百分位；论文明确用 **LLMLingua-2** 作压缩模型，并给出基于交叉熵的替代实现（条件熵越高、越不可预测的 token 越该保留）。随后做**主题分段**：维护一个感觉缓冲区，累计到容量上限时触发「注意力边界 ∩ 相似度边界」的混合分段（`B = B₁ ∩ B₂`）。
  - **Light2 主题感知短期记忆（STM）**：把主题分组**整合、摘要**成更结构化的记忆单元——即「按语义单元而非固定窗口分块，减少记忆构建次数」。
  - **Light3 长期记忆 + sleep-time update**：新记忆先打时间戳做「软更新」保证实时响应，之后在离线时段**重组、去重、抽象**，解冲突、强化跨知识连接——把昂贵维护与在线推理**解耦**。
- 数字（注意论文自身口径不一致，两处都列）：摘要写「token 用量最多降 117×、API 调用最多降 159×、运行时间降 12×以上」；引言写「token 降 **32×–117×**、API 调用降 **17×–177×**、运行时间降 **1.67×–12.45×**，QA 准确率比最强基线高 **2.70%–9.65%**」。
- **这些数字不能搬到本桥**：它们衡量的是「用记忆系统替代把历史塞进上下文」，而本桥的历史本来就不在上下文里。**推断**：直接引用这些倍数会得出「桥能省 100 倍 token」的错误结论。

### 1.2 LightMem（ACL 2026 main）— 同名，另一批作者，SLM 驱动

- 论文：<https://arxiv.org/abs/2604.07798>（作者 Jiaquan Zhang 等，与 1.1 的作者群、机构、基准均不同）。
- 三级记忆 **STM / MTM / LTM**，**在线/离线分离**：在线在**固定检索预算**下做「向量粗召回 + 语义一致性重排」两阶段选择；离线抽象可复用的交互证据并增量并入 LTM。
- 数字：LoCoMo 上比 A-MEM 平均 **F1 +2.5**；检索中位 **83 ms**、端到端中位 **581 ms**。
- 与本桥的相关点只有一条：**「固定检索预算」**——上界在系统设计时钉死，而不是让上下文长度随会话自由增长。这正是本桥 `serializeDelta` + 游标机制已经在做的事。

### 1.3 相邻工作（只取规则，不取方法）

| 工作 | 出处 | 本文用它的哪一条 |
| --- | --- | --- |
| MemGPT / Letta 系 | 经 Letta 的 Sleep-time Compute 论文可见其传承 | 离线思考 |
| **Sleep-time Compute** | <https://arxiv.org/abs/2504.13171> | 「让模型在查询到来前离线思考上下文」——离线巩固的通用化 |
| **A-MEM** | <https://arxiv.org/abs/2502.12110> | Zettelkasten 式记忆链接与演化（对本桥**不适用**，见 §2） |
| **MemoryOS** | <https://arxiv.org/abs/2506.06326> | 分级存储 + FIFO/分段页式更新（STM→MTM→LTM） |
| **LLMLingua-2** | <https://arxiv.org/abs/2403.12968> | 任务无关提示压缩；token 分类而非熵；比既有方法快 3×–6×，端到端延迟降 1.6×–2.9×，压缩比 **2×–5×** |
| **Lost in the Middle** | <https://arxiv.org/abs/2307.03172> | 相关信息在**开头或结尾**时表现最好，在**中段**显著退化 |
| **Context Length Alone Hurts** | <https://arxiv.org/abs/2510.05381> | 即使检索完美，输入变长本身就让性能下降 **13.9%–85%** |
| **Prompt Cache** | <https://arxiv.org/abs/2311.04934> | 把可复用文本段（prompt module）的注意力状态预计算并在跨请求间复用；TTFT 报告 8×（GPU）–60×（CPU） |
| **CAG** | <https://arxiv.org/abs/2412.15605> | 把知识预装进 KV 而非实时检索——**本桥的首轮本质上就是 CAG 的 preload** |
| vLLM Automatic Prefix Caching | <https://docs.vllm.ai/en/stable/design/prefix_caching/> | 前缀缓存以 **block 为粒度**、块哈希含前缀，「只缓存整块」 |
| SGLang RadixAttention | <https://www.lmsys.org/blog/2024-01-17-sglang/> | 用 radix tree 自动复用公共前缀的 KV |

---

## 2. 适用性筛表（决定哪些**不**写进建议）

| 技术 | 它解决的问题 | 本桥能用吗 | 判据 |
| --- | --- | --- | --- |
| Light1 逐 token 压缩（LLMLingua-2 式） | 原始输入冗余 | **能，但只在首轮构造期且必须冻结** | 压缩必须在首轮一次性算定、之后字节不变；否则每次重建前缀都变，缓存永远冷（见 §4.2） |
| Light1 主题分段（注意力 ∩ 相似度） | 分块语义纠缠 | **能，但要改造成「按变更频率分段」** | 本桥需要的是**前缀边界**稳定，不是主题纯度（见 §4.1） |
| Light2 主题摘要 | 记忆单元结构化 | **能，但只作用于「重建文本」** | 只改整段重建路径，不动增量路径 |
| Light3 sleep-time 离线巩固 | 在线维护太贵 | **能，映射到重建/压缩路径** | 与 §4.3 同 |
| LTM + 向量检索 | 跨会话知识复用 | **不能** | 检索出的记忆必须注入上下文 → **改变前缀** → 冷缓存；而网页会话本身就是载体，注入是净增成本。**推断**（无直接文献，基于 §3 的缓存规则） |
| 记忆演化 / 图链接（A-MEM、StructMem） | 记忆组织 | **不能** | 同上一行，且引入新的失败面 |
| KV 预计算（LightMem README 的 todo） | 免去重复 prefill | **不能** | 无 API 句柄，KV 无法由客户端提交（见 §3.3） |
| cache breakpoint / `cache_control` | 控制缓存落点 | **不能** | 网页无此参数 |
| 「静态在前、动态在后」 | 前缀匹配最大化 | **能，直接可用** | 通用规则，见 §3.2 |
| 最小可缓存长度 / 块对齐 | 缓存生效门槛 | **能用为检查项** | 见 §3.2 |

---

## 3. 本桥的真实缓存模型：已知、未知、可测

### 3.1 已知（本仓库代码）

- 首轮（`serializeFirstTurn`，`package/dsh-webcode-bridge/lib/agent-preset.js:536`）拼装顺序为：`buildPreset(...)` → `'[会话开始]'` → 会话正文段 → `transportNoteFor(...)`。预算路径（`maxPromptChars`）只丢弃**最旧的正文段**并插入省略标记，**preset 与 transport 恒保留**。
- 增量轮（`serializeDelta`，同文件 :644）：只发 `sent` 之后的新消息；工具结果变 `{"mcp_action":"result",...}` JSON 围栏；每 `TRAIN_EVERY = 5` 个工具结果附一次再教学 `system_note`（:17–:19）。
- 计数：`index.js` 的 `cumulativeTokens` 是**已发文本累计**（单调不减），并叠加 `outTokens`（助手输出估算）——即桥自己已经承认「网页侧真实上下文 = 首轮 + 所有增量 + 所有助手回复」。
- 重建路径与真因：`freshReason ∈ {no-cursor, contract-changed, anchor-lost, anchor-no-new-messages, account-changed}`（`index.js` :3439–:3458）。`anchor-lost`（尾部被改写）才回落整段重建。
- 站点教学落盘：`prompt-store.js` 写 `~/.dsh/webcode/prompts/<site>.md`（`buildPreset + teachFor` 全文）与 `~/.dsh/webcode/sessions/<key>.md`（最近一次首轮全文）。**该磁盘副本的头部含 ISO 时间戳**，`readPromptFile` 会剥掉 `> ` 开头的连续行——所以只要走 `readPromptFile` 就不会把时间戳投递出去。

### 3.2 已知（厂商公开的缓存规则 —— 这是本文外部证据的主干）

- **DeepSeek（disk KV cache，默认开启）** <https://api-docs.deepseek.com/guides/kv_cache/>：命中要求「**完全匹配**一个 **cache prefix unit**」；缓存单元在 **(a) 请求边界（用户输入结束 / 模型输出结束）、(b) 系统检测到的公共前缀、(c) 长输入/输出的固定 token 间隔** 三处持久化。例 1：`A+B` 后发 `A+B+C` **命中** `A+B`；例 2：`A+B` 后发 `A+C` **不命中**，但系统会把公共前缀 `A` 单独持久化，第三个请求 `A+D` 才能命中 `A`。另注明：缓存是 best-effort、不保证 100% 命中；缓存构建需要数秒；不再使用时几小时到几天内清除。
- **OpenAI** <https://developers.openai.com/api/docs/guides/prompt-caching>：缓存的是**整个已渲染前缀**的 KV；「前缀必须整体匹配」；最小可缓存长度在 GPT-5.6 及以后为 **1,024 token**；报告的 `cached_tokens` 向下取整到 **128 的整数倍**；写缓存 1.25×、读缓存 0.1× 单价。
- **Anthropic** <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>：明确给出段序指导——**「把静态内容（工具定义、系统指令、上下文、示例）放在提示词开头」**；缓存前缀的构建顺序是 `tools → system → messages`；并点名一个**常见错误**：把 breakpoint 放在「每次都变的内容」（如含时间戳的块）上，导致每次都是写、从不命中；正确做法是**把 breakpoint 放在「跨请求保持不变的最后一块」**。其示例还显示：静态块 1–5 + 每次变的块 6 时，把 breakpoint 放在块 5 才能命中。

> 注：DeepSeek 网页版是否走同一套 disk KV cache，**无公开文档**。上述规则来自 API 侧文档，本文只把它们当作「同类推理栈的通用前缀匹配语义」使用，并在 §6 的每条建议里安排实测。

### 3.3 未知（不许当结论，必须实测）

| 未知项 | 为什么重要 | 怎么测（见 §5 第 5 条） |
| --- | --- | --- |
| 网页每轮是**重发整段**还是**只发新增** | 决定「首轮前缀稳定性」是成本主项还是几乎无关 | 对比同一会话连续两轮的 `firstTokenMs` 与首轮长度 |
| 网页服务端是否在首轮前后**注入自己的内容**（时间戳、欢迎语、附件占位） | 若注入发生在桥的文本**之后**，前缀仍然匹配；若在之前，桥无法控制 | 回读页面 DOM 的完整消息文本，与投递文本做 diff |
| 网页是否复用 disk KV cache | 决定 §6 的收益上限 | 无法直接读 `prompt_cache_hit_tokens`（网页无此字段）→ 只能用 `firstTokenMs` 做代理 |
| 会话 TTL 与「几小时到几天」的清除窗口 | 决定「空闲后第一轮」是否必然冷启动 | `wait-stats.js` / `idle-window.js` 已有空闲统计，可与之关联 |

---

## 4. 三条真正可落地的技术（机制 → 本桥改法 → 反例）

### 4.1 按「变更频率」排序，取代按「重要性」排序

**机制**：前缀缓存的一切收益来自「共同前缀有多长」。Anthropic 的写法最直白——把静态内容放开头，breakpoint 放在「跨请求不变的最后一块」；并给出反例：静态块后面跟一个含时间戳的块，breakpoint 放在后者上，就永远写、从不读。DeepSeek 的「公共前缀检测持久化」也表明：**能被系统识别为公共前缀的，才有机会跨请求复用**。

**本桥改法**：把首轮视为三段，而非一整块——

| 段 | 变更频率 | 现状位置 | 建议位置 |
| --- | --- | --- | --- |
| `buildPreset`（系统指令 / 全局 / 本网站 / 工具表+schema / 调用格式 / 使用准则 / present） | **按天/按版本**（仅在宿主升级、工具集改变、设置改动时变） | 第 1 段 | 第 1 段（不动） |
| `transportNoteFor`（协议段，含官方 token 骨架） | **按站点+工具集**（同一站点所有会话**逐字相同**） | **最后一段** | **第 2 段** |
| `[会话开始] + 会话正文` | **每会话** | 中间 | **最后** |

**收益来源**：`prompts/<site>.md` 已经在磁盘上留下了「站点教学全文」的正本。若该文本在同一站点的不同会话间**逐字相同**，则按 DeepSeek 的「公共前缀检测持久化」规则，它有机会被持久化为**独立 cache prefix unit**，供**后续所有新会话**命中——收益是按「新会话数」放大的，不是按轮数。当前把会话正文插在 preset 与 transport 之间，恰好把这段公共前缀**切断**在工作量最大的一处。

**反例 / 风险（必须承认）**：`transportNoteFor` 现在被放在末尾不是偶然——`agent-preset.js` 注释明确写「临出手前再看到一次形状是有价值的位置」，其文献依据正是「相关信息在开头或结尾表现最好」（Lost in the Middle）。**直接前移会牺牲这条位置收益。**

**不牺牲位置收益的解法**（§6 P0-1）：把 transport 段**拆成两半**——长正文（解释、约束、警告）前移到第 2 段进入缓存前缀；**只把 1 行骨架**（`officialToolCallSkeletonFor(tools)` 那一行）留在最末尾。这样既保住了「最后一眼看到形状」，又把绝大部分字节移进了稳定前缀。该行本来就被 `teachFor`/自动续跑轮单独复用，拆分不新增第二份真相源。

### 4.2 压缩只允许在「冻结边界」做，且必须确定性可复现

**机制**：LLMLingua-2 把压缩建成**token 二分类**（保留/丢弃），压缩比 2×–5×，且比先前的熵式方法快 3×–6×（<https://arxiv.org/abs/2403.12968>）；LightMem 正是用它做 Light1（<https://arxiv.org/html/2510.18866v1> §3.1）。收益方向是明确的：**更短的输入本身就更准**——即使检索完美，输入变长也让性能下降 13.9%–85%（<https://arxiv.org/abs/2510.05381>）。本仓库已有同向的实验变体 `slim`（`prompt-variants.js:83`，工具描述上限 1200→800），依据引的正是这篇。

**但**：压缩与**前缀缓存**是同一枚硬币的两面。Anthropic 的「每次请求都在变的内容上放 breakpoint ⇒ 只写不读」是同一机制的另一种表现。**若压缩在每轮重新跑一次**（哪怕模型温度固定），只要有任何一个 token 的保留判定翻转，整个前缀哈希就变，缓存全灭。**推断**：这会把 LLMLingua-2 的 2×–5× 收益全部吃掉并倒亏。

**本桥改法**：压缩**只发生在首轮构造期**，产物**冻结**：

1. 对 `buildPreset` 产出的**工具 schema 与技能目录**做一次确定性压缩（见 §6 P1-1），结果按 `hash(siteId, toolNameKey, presetVersion)` 缓存到本地，之后**读缓存**而不是重算。
2. **压缩白名单/黑名单**：
   - **禁压**：官方工具调用骨架、`transportNoteFor` 全文、`# 工具调用格式` 段、「必填字段」那句、`[系统指令]` 全部。理由：这些是**逐字形状约束**，删一个 token 就可能把模型教坏（仓库历史上已有多次此类真机事故，见 `agent-preset.js` 的 TRAIN_NOTE 存档注释）。
   - **可压**：工具 `description` 的冗长散文、schema 里非 `required` 的字段说明、技能目录的描述文字、重复的礼貌性表述。
3. **压缩产物落盘**（复用 `prompt-store.js` 的每站点文件），使「此刻真实在教什么」与投递内容同源，可 diff、可回归。

**反例**：No Free Lunch——压缩丢掉的可能正是那一条救命的硬约束（仓库注释已记为「旧实现的 300 字符截断会把这些约束截掉一半」，故有 `MAX_TOOL_DESC_CHARS = 1200`）。因此压缩必须走 `EXPERIMENT_SPECS` 的实验通道（`prompt-variants.js:71`），带配对判据，不拿默认路径做实验——这是仓库既有的纪律。

### 4.3 把「离线巩固」搬到重建路径（sleep-time → rebuild-time）

**机制**：LightMem 的 Light3 把昂贵的记忆维护从在线推理中**解耦**到离线时段，在线只做带时间戳的「软更新」（<https://arxiv.org/html/2510.18866v1> §1、§3）。Letta 的 Sleep-time Compute 是同一思想的独立表述：让模型在查询到来**之前**离线思考上下文（<https://arxiv.org/abs/2504.13171>）。

**本桥改法**：本桥的「离线时段」天然存在，就是**会话空闲**与**整段重建发生的那一刻**。当前重建路径 `rebuild(hint) → serializeFirstTurn({maxPromptChars})` 只做「丢最旧段 + 插省略标记」，**不做任何摘要**。可改为：

- 在空闲窗口（`idle-window.js` / `wait-stats.js` 已有统计）为每个活动会话生成一份 **digest**：已完成工作的结论、关键文件路径、未决事项、下一动作。产出落 `sessions/<key>.digest.md` 或写入现有会话文件的一个新段。
- 重建时优先投递 `preset(冻结) + transport前段 + digest + 最近 K 轮原始消息`，而不是「预设 + 最旧段被砍的全文」。
- **判据**：重建后首轮是否仍能正确续接（用 `task-ledger.js` / `task-plan.js` 的既有状态作客观对照），以及重建文本长度。

**反例**：摘要会**替换**被重建的尾部 → `reanchorSent` 必然失败 → 走整段重建（`anchor-lost`）。这是**预期行为**而非故障，但必须在 `freshReason` 的语义里与真实故障区分开，否则会污染现有的排障读数（`index.js` :3435–:3458 的注释专门为「四个真因长得一样」做过一次修正）。

---

## 5. 测量方法（不测不许改）

本仓库已有全部所需钩子，**不需要新建测量设施**：

1. **首轮 token 分解**：用 `metrics.js` 的 `estimateTokens`（唯一真相，三类单价 `TOKEN_DENSITY = {cjk:0.75, word:0.3, other:0.7, margin:0.1}`，见 `doc/research/2026-09-23-token-density-calibration.md`）分别估算 `buildPreset` / `transportNoteFor` / 会话正文 三段，得「稳定前缀 token 数 / 总 token 数」。
2. **站点教学字节稳定性**：对 `buildPreset(...) + teachFor(...)` 取 SHA-256，写进 `meta`（与 `siteId`/`slot`/`accountKey` 同级）。跨会话、跨账户比对。**这是判断「新会话能否共享站点前缀」的唯一直接证据。**
3. **首 token 延迟**：`relay.js` 已产出 `firstTokenMs` 与 `responseMs`（:265–:274）。按「同站同模型、首轮长度分桶」做对照。
4. **重建成本 = Σ(重建次数 × 重建文本长度)**：`freshReasons` 已有分因计数；把每次重建的 `prompt.length` 一并记账即可。
5. **页面侧实际收到的全量文本**：回读 DOM 消息文本，与投递文本 diff（用以回答 §3.3 的未知项）。注意 `MAX_OUTPUT_CHARS = 16_000`（`agent-preset.js:17`）已在工具结果上生效，diff 时需扣除该截断。
6. **配对实验通道**：一律走 `prompt-variants.js` 的 `EXPERIMENT_SPECS`（`experiments: true` 才出现），并由 `test/prompt-variants.test.mjs` 的 `ZERO_DRIFT_BASELINE`（:194）钉死默认路径零位移。`bench.js` 的 `judgeRun`/`summarizeRuns` 已刻意**只输出计数与分布、不输出百分比提升**（:221–:232 注释：「样本 ≤3 次时百分比是把噪声包装成结论」）——新实验沿用这条口径。

---

## 6. 可落地到 dsh-webcode-bridge 的具体改动建议

> 每条：**改什么 → 期望效果 → 怎么测 → 风险**。P0 = 低风险高收益，先做；P1 = 需配对实测；P2 = 明确不做（见 §7）。

### P0-1　首轮段序重排：稳定段进前缀，只把 1 行骨架留在末尾

- **改什么**：`serializeFirstTurn`（`agent-preset.js:536`）的拼装顺序改为 `buildPreset → transportNoteFor 的正文部分 → '[会话开始] + 会话正文 → 工具调用骨架行`。等价做法：给 `transportNoteFor` 增加一个「正文 / 骨架」的切分返回值，骨架复用既有的 `officialToolCallSkeletonFor(tools)`。
- **期望效果**：同一站点跨会话的共同前缀从「preset 长度」提升到「preset + transport 正文 长度」，且**末尾骨架行是常量**，不引入新的易变点。按 DeepSeek 的公共前缀持久化规则，收益按新会话数放大。
- **怎么测**：§5 第 1 条（稳定前缀 token 占比）+ 第 2 条（站点教学哈希跨会话一致）+ 第 3 条（新会话首轮 `firstTokenMs` 对照）。
- **风险**：位置收益被削弱。缓解：只保留 1 行骨架在末尾（而非整段），并在配对实验里用「协议泄漏 / 调用形状错误率」作判据（`bench.js` 的 `expectCalls` / `expectNoLeak`）。**必须走实验通道，默认路径零位移。**

### P0-2　站点教学段字节冻结 + 哈希外露

- **改什么**：把 `buildPreset(...) + teachFor(...)`（`index.js:3491` 已有 `siteText` 变量，落盘与续跑教学共用同一字符串）的 SHA-256 加进 `meta` 与 status 输出；并加一条启动期自检：`readPromptFile(sitePromptPath(...))` 的正文与本次 `siteText` 是否逐字相等。
- **期望效果**：把「跨会话共享前缀」从猜测变成可观测量；任何导致站点教学漂移的改动（工具描述措辞、`process.version`、schema 字段序）会立刻显形，而不是等到「新会话莫名其妙变慢」。
- **怎么测**：同一站点连续开 3 个会话，比对哈希；故意改一个工具描述，确认哈希变化被报出。
- **风险**：几乎无（只增加观测）；但要注意 `platformNote()` 含 `process.version`（Node 版本变了就打散全站前缀），应把 Node 版本变化的日期与哈希变化日志关联，避免误判为故障。

### P0-3　首轮 token 预算三分账

- **改什么**：`serializeFirstTurn` 返回或旁路一个 `breakdown = { preset, transport, session }` 的 `estimateTokens` 结果，经 `index.js` 的 `meta`/`lastPresetInfo` 透出到设置页（`web-control.js` 已有 `sendBudget` 展示逻辑可挂）。
- **期望效果**：把 19k–50k 的首轮拆开，回答「到底是谁占的」——目前只有总量，没有分项，任何优化都无从定优先级。
- **怎么测**：真机会话读一次分项即可（一次性取证），后续可在设置页常驻。
- **风险**：无（纯观测）。

### P1-1　工具 schema 按需加载（把最重的一段移出常驻前缀）

- **改什么**：默认路径保留「工具名 + 描述 + `required` 字段名清单」（这是 `agent-preset.js:493` 那句真机事故换来的教训，不能删），把**完整 JSON schema 的属性级细节**移到首轮之后的一小段（或一个 `describe_tool` 类工具的按需结果）。`MAX_TOOL_SCHEMA_CHARS = 4000` 的存在说明 schema 确实是主要体积项。
- **期望效果**：首轮体积按 schema 占比下降（需先由 P0-3 量出占比）；同时符合「长上下文本身有害」（<https://arxiv.org/abs/2510.05381>）。代价是多一次往返：只有当某工具真被调用且参数报错时才需要补 schema。
- **怎么测**：`prompt-variants.js` 新增 `EXPERIMENT_SPECS` 条目（如 `lazy-schema`），判据用 `bench.js` 的 `expectCalls` / `requireArgs`（缺必填参数是与 schema 直接相关的失败类别）与首轮 token 分项。
- **风险**：**高**——必填字段缺失是本仓库最高频的工具失败类别（`agent-preset.js:490–493` 有真机取证）。因此这条**必须在实验通道里先跑出配对数据**，且 `arguments 必须含 required 每个字段` 那句逐字保留在首轮。

### P1-2　重建期 digest（sleep-time 的最小可用形态）

- **改什么**：新增一条**只在重建路径**上的摘要：由空闲窗口触发生成会话 digest，重建时投递 `preset(冻结) + transport正文 + digest + 最近 K 轮`。实现落在 `serializeFirstTurn` 的预算路径（`agent-preset.js:559–578`）旁，不触碰增量路径。
- **期望效果**：把「重建 = 重放几十万字符」压到「重建 = 稳定前缀 + 少量 digest + 最近上下文」，直接降低成本与「长上下文有害」的暴露面。这是本文中 LightMem 唯一值得搬的主体思想（Light3 / sleep-time）。
- **怎么测**：重建文本长度、重建后首轮是否续接正确（对照 `task-ledger.js` 的任务状态是否推进）、以及**新建一个与原 `anchor-lost` 区分开的 `freshReason`**（见风险）。
- **风险**：① 摘要替代尾部 → `reanchorSent` 必失败 → 触发整段重建，属预期；② 摘要丢细节导致长跑跑偏；③ 污染现有 `freshReason` 排障语义。缓解：新真因命名（如 `rebuild-digest`）、digest 版本落盘可回滚、K 值保守。**先只对发生 `anchor-lost` 的会话启用，与默认路径并存。**

### P1-3　再教学成本显式计量

- **改什么**：`TRAIN_EVERY = 5`（`agent-preset.js:19`）意味着每 5 个工具结果重贴一次 `trainNoteFor(...)`。这条文本是**每轮全额重复**的固定成本，却从未被单独计数。把它计入 `st.tokens` 的一个子项。
- **期望效果**：给出「再教学占增量总量的百分比」。若占比可观，则可评估「首轮已教 + 骨架已在末尾」是否让再教学可以降频——但这是**需要实测的方向性候选**，不是结论（Reinstruct 一侧的证据支持重述，`prompt-variants.js:73` 的 `reinstruct` 变体正是这个方向）。
- **怎么测**：连续工具型会话（如 20+ 工具结果）计出子项占比；与 `reinstruct` 变体做对照。
- **风险**：降频可能让模型漂回错误形状（仓库有多次此类真机事故）。因此本条**只做计量，不先改频率**。

### P2　（明确不做）

- **不做 LTM / 向量检索记忆层**：本桥的载体是网页会话本身；检索出的记忆必须注入上下文，即**改变前缀**，在冷启动成本与失败面上都是净负。**推断**（无正面对照实验，基于 §3.2 的前缀匹配语义）。
- **不做 KV 预计算**：无 API 句柄，客户端无法提交 KV。LightMem README 的 todo 里有「Offline/Online Pre-computation of KV Cache」（<https://github.com/zjunlp/LightMem>），但那是**在其框架内**的能力，本桥不具备该接口。
- **不做逐轮压缩**：见 §4.2 的反例。

---

## 7. 明确不要做的事（踩坑清单）

1. **不要在首轮里放任何每轮/每会话变化的东西**：日期、时间戳、会话 id、随机数、计数器。Anthropic 文档点名的「breakpoint 放在含时间戳的块上 ⇒ 只写不读」就是这个坑（<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>）。
2. **不要把磁盘副本的头部当投递文本**：`writePromptFile` 写的 `> 更新时间：<ISO>` 必须经 `readPromptFile` 剥除。若哪天有代码路径直接读文件原文去投递，就会让每次重建都带上一个变化的时间戳——静默的前缀杀手。
3. **不要为了「压缩」动协议骨架与官方 token 形状**：`<｜tool▁calls▁begin｜>` 家族必须逐字完整。压缩白名单里这条是硬禁。
4. **不要在增量轮重发首轮内容**：`serializeDelta` 的设计前提正是「网页自己保存了对话」。重发 = 把前缀变长，且很可能不再匹配已有的 cache prefix unit。
5. **不要把「重建」当成纯故障**：它同时是 sleep-time 的天然触发点（§4.3）。但也别把真故障（`anchor-lost`）和预期重建混在一个计数里——`index.js` 已为这个教训付过一次代价。
6. **不要引用 LightMem 的 32×–117× 来宣称本桥能省同等量级**：口径不同（§1.1）。

---

## 8. 参考来源（全部真实可访问）

**LightMem 及其同名项**
- LightMem (ICLR 2026)：<https://arxiv.org/abs/2510.18866> ｜ HTML：<https://arxiv.org/html/2510.18866v1> ｜ 代码：<https://github.com/zjunlp/LightMem> ｜ OpenReview：<https://openreview.net/forum?id=dyJ0GWpjJB> ｜ ICLR 幻灯片：<https://iclr.cc/media/iclr-2026/Slides/10008366.pdf> ｜ 官方博客：<https://huggingface.co/blog/xzwnlp/lightmem>
- LightMem (ACL 2026, SLM 版，同名不同作者)：<https://arxiv.org/abs/2604.07798>
- 相邻：A-MEM <https://arxiv.org/abs/2502.12110> ｜ MemoryOS <https://arxiv.org/abs/2506.06326> ｜ Sleep-time Compute <https://arxiv.org/abs/2504.13171>

**前缀缓存 / KV 复用**
- DeepSeek Context Caching：<https://api-docs.deepseek.com/guides/kv_cache/>
- OpenAI Prompt caching：<https://developers.openai.com/api/docs/guides/prompt-caching>
- Anthropic Prompt caching：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Prompt Cache (MLSys 2024)：<https://arxiv.org/abs/2311.04934>
- vLLM Automatic Prefix Caching：<https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/> ｜ 设计文档：<https://docs.vllm.ai/en/stable/design/prefix_caching/>
- SGLang RadixAttention：<https://www.lmsys.org/blog/2024-01-17-sglang/>
- Cache-Augmented Generation：<https://arxiv.org/abs/2412.15605>

**长上下文 / 压缩**
- Lost in the Middle：<https://arxiv.org/abs/2307.03172> ｜ TACL 版：<https://aclanthology.org/2024.tacl-1.9/>
- Context Length Alone Hurts：<https://arxiv.org/abs/2510.05381>
- LLMLingua-2：<https://arxiv.org/abs/2403.12968>

**本仓库内部依据**
- `package/dsh-webcode-bridge/lib/agent-preset.js`（`buildPreset` :417、`serializeFirstTurn` :536、`serializeDelta` :644、`MAX_OUTPUT_CHARS`/`TRAIN_EVERY` :17–:19、`MAX_TOOL_DESC_CHARS`/`MAX_TOOL_SCHEMA_CHARS` :337–:339、`trainNoteFor`/`transportNoteFor` :300/:408）
- `package/dsh-webcode-bridge/lib/index.js`（游标与 `freshReason` :3408–:3477、`siteText` 与落盘 :3484–:3493、累计口径 :3496–:3523）
- `package/dsh-webcode-bridge/lib/metrics.js`（`TOKEN_DENSITY` :315、`estimateTokens` :333、`checkContextBudget` :274）
- `package/dsh-webcode-bridge/lib/prompt-store.js`（`writePromptFile`/`readPromptFile` :82/:118）
- `package/dsh-webcode-bridge/lib/prompt-variants.js`（`EXPERIMENT_SPECS` :71、`SLIM_TOOL_DESC_LIMIT` :95）
- `package/dsh-webcode-bridge/lib/relay.js`（`firstTokenMs` :265）
- `package/dsh-webcode-bridge/lib/bench.js`（`judgeRun` :141、`summarizeRuns` :232、「不只输出百分比」纪律 :221–:232）
- `package/dsh-webcode-bridge/test/prompt-variants.test.mjs`（`ZERO_DRIFT_BASELINE` :194）
- `doc/research/2026-09-23-token-density-calibration.md`、`doc/research/2026-09-23-dsh-longrun-and-compaction.md`、`doc/research/prompt-engineering-evidence-2026-09-14.md`
