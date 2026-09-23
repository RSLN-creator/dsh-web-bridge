# 长上下文：第三、四轮思考（对账 · 恢复成本账）

**为什么这个文件存在**：用户指令（0.19.3）——「还有长上下文继续思考两轮新增角度，这次还有不要忘记就是提供解决方向/拉取论文参考！」。前两轮已落盘在 [`2026-09-23-longrun-two-rounds-thinking.md`](2026-09-23-longrun-two-rounds-thinking.md)：

| 轮次 | 起点问题 | 落点 |
| --- | --- | --- |
| 第一轮 | 什么会杀死长会话？ | 压缩这条安全网**从未被验证过**（304 份会话 0 次 compaction 事件），风险是「第一次触发时会发生什么」 |
| 第二轮 | 桥凭什么相信网页？ | 桥的六条假设里前五条可验证、第六条（模型是否真读了内容）原理上不可验证；且防护**全是单轮闭环**，没有跨轮累积计数 |

**本轮（三、四）刻意换起点**，且两轮都要求「提供解决方向」与「可复核的文献」。

**证据纪律**（沿用 [`prompt-engineering-evidence-2026-09-14.md`](prompt-engineering-evidence-2026-09-14.md) 立的规矩）：凡「真机读数」给出文件与行号；凡「文献结论」给出链接与逐字数字；凡「本报推断」单独标注。**不做推测性归因**。

> **本轮与前两轮的关系**：第一轮发现「安全网没被验证」，第二轮发现「防护是单轮闭环」，第三轮发现「**仪表本身是桥的自述**」，第四轮发现「**每次救活都在给下一次加长**」。第三轮不是第二轮的重复：第二轮问的是「桥信不信网页」，第三轮问的是「**桥的量尺量的是谁**」。

---

## 第三轮：两个上下文账本，从来没对过账

### 3.1 起点问题：桥报出去的那个百分比，量的是谁？

DSH 的压力读数（GUI 里那个圆环、压缩阈值比对的那个数）来自 token meter，而 token meter 的分母是 **adapter 的 `resolveModel` 返回值**。webcode 这一侧：

- [`lib/index.js:778`](../package/dsh-webcode-bridge/lib/index.js#L778) `contextWindowFor(m)` 的取值链是
  `cfg.contextWindowBySite[siteId] ?? m.budget ?? m.context ?? (deepseek ? 1_000_000 : 64_000)`；
- 而 [`lib/index.js:263`](../package/dsh-webcode-bridge/lib/index.js#L263) 的 `DEFAULTS.contextWindowBySite = { deepseek: 1_000_000 }` **排在链首**。

于是 deepseek 站点向 DSH 声明的窗口是 **1,000,000 token**，压缩阈值 = ⌊min(W×0.8, W−O−headroom)⌋ = **800,000**（口径见 [`2026-09-23-dsh-longrun-and-compaction.md`](2026-09-23-dsh-longrun-and-compaction.md) §2）。

分子同样是桥自己的估算：[`lib/index.js:3441`](../package/dsh-webcode-bridge/lib/index.js#L3441) `cumulativeTokens = fresh ? estimateTokens(prompt) : (st.tokens||0) + deltaTokens`，再由 [`lib/index.js:3448`](../package/dsh-webcode-bridge/lib/index.js#L3448) 的 `usageInput()` 加上 `outTokens`（助手输出估算）。

**所以那个百分比 = 桥对自己发过多少字的估计 ÷ 桥自己声明的窗口。** 它从头到尾没有网页参与。

### 3.2 真机读数：分子的口径里有一个已知缺口，分母是个乐观值

- **分子缺口**：`cumulativeTokens` 累加的是「首轮全文 + 每轮增量」。网页那一侧的上下文还包含**网页自己注入的东西**（系统提示、UI 框架、它自己的开场语）以及**桥没记进去的附件投递内容**（`promptTransport: 'attach'` 走的是上传文件，正文里只有一个短占位）。这些都不在 `cumulativeTokens` 里。
- **分母乐观**：1,000,000 不是任何实测值。真机已知最大一轮是 **409,555 字符**（`GET /__webcode/preset` 的 `promptChars`，见 [`doc/progress.md`](../progress.md) 的 0.16.3 段），按 CJK≈0.7 token/字符折算约 **287k token**——比声明值小三倍多。
- **两者叠加的后果**：上一轮扫描得到「历史最高压力 59.4%、没有任何会话到过 60%」——**这个结论量的是桥的信念，不是网页的状态**。它不证明网页还很空。

### 3.3 同一个文件里的自相矛盾（可直接复核，应当修）

[`lib/index.js:844`](../package/dsh-webcode-bridge/lib/index.js#L844) 的注释逐字写着：

> 「网页 composer 的真实上限未知（历史欠账），声明 1_000_000 会让 DSH 的上下文压缩永远不触发、transcript 只增不减……按站点给一个诚实的保守值：DeepSeek 网页实测能稳定收下十万级字符，按 CJK≈0.7 token/字符折算留出余量**取 128k**；其余站点 64k」

而它下面第 849 行调用的 `contextWindowFor(m)` 对 deepseek 返回的是 **1,000,000**。**注释承诺 128k，代码给出 1M。** 这正是 [`doc/comment-style.md`](../comment-style.md) §10.2 点名的第二类代价——「注释描述的实现已不存在」——只是这次它恰好压在长上下文的命门上：**注释说的那个行为（压缩会触发）从来没生效过**。

（这一条不是本轮推断，是逐字对照两处代码得到的。修法是把 1M 改成注释承诺的值，或把注释改成事实；两者都改行为或改文档，**本轮不动**，因为它会改变自动压缩是否触发。）

### 3.4 反驳自己：能不能真的对账？

能，而且通路已经存在：

- 桥自己就有一条读回网页会话的路：`POST /__webcode/history`（真机用过，见 [`doc/progress.md`](../progress.md) 的会话 971db3e8 读数）。
- 网页回复长度也已经在采：驱动实例状态里有 `domReplyChars`（[`lib/index.js:498`](../package/dsh-webcode-bridge/lib/index.js#L498) 一带的 `scene` 结构）。
- 唯一从**网页侧**回来的地面真值是 `PROMPT_TRUNCATED` 回读校验——而它是**失败信号**：等到它出现，那 一轮已经发出去并被截断了。

所以现状是：**桥有一个可以随时对账的探针，却在只有出事时才用它。**

### 3.5 文献：为什么「自述的压力」不够

| 文献 | 逐字/关键数字 | 对本轮的含义 |
| --- | --- | --- |
| [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://www.trychroma.com/research/context-rot)（Chroma，2025-07） | 「NIAH is fundamentally a simple retrieval task」；输入越长性能退化越显著且**非均匀** | 网页在自己的输入变长时退化不是阶跃式的：不代表「没到 80% 就没事」 |
| [Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://arxiv.org/html/2510.05381v1)（arXiv 2510.05381） | 「even with perfect retrieval」 | 压力读数的**分母是窗口、不是性能**：59% 的窗口占用不等于 59% 的能力 |
| [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/html/2605.23950v1)（arXiv 2605.23950） | 「Every benchmark score is jointly produced by a model and a harness, but the harness is rarely disclosed」 | 本项目**就是** harness 的作者：自述读数必须连同量尺一起披露，否则读者会把「59%」当成事实 |

### 3.6 解决方向 D3（对账探针，可检验）

**目标**：把「桥的信念」升级成「桥的信念 + 网页的实测」，并让两者之差成为一等读数。

1. **`ledgerDriftRatio`**：复用 `POST /__webcode/history`，每 N 轮（或每次整段重建后）读回网页会话的 user+assistant 字符数，与 `usageInput()` 相比，差值比落进 `/__webcode/status` 与 reply-log。判据：正常会话里该比值应稳定；**它一旦单调上升，就说明桥在系统性低估**。
2. **压缩压力取上界**：把 token meter 的分母（或桥自己那条预算闸的输入）改成 `max(自述累计, 实测网页字符)`——宁可早压缩，也不要等到 `PROMPT_TRUNCATED` 才第一次知道真实水位。
3. **`PROMPT_TRUNCATED` 升级为水位刻度**：现在它只报「长度差」；把它记成「本次真实水位下界」，累积成一张「网页到底能收多少」的表——这是 1M 这个数唯一可能的实证来源。

**为什么可检验**：第 1 步只需要一个读数，不改任何行为；若 `ledgerDriftRatio` 长期接近 1，则本轮的核心怀疑被证伪——那时应当把它写进文档并在下一版删掉这条方向，而不是留着当装饰。

---

## 第四轮：恢复的成本账——每次救活都在给下一次加长

### 4.1 起点问题：auto_continue 是免费的吗？

前面所有轮次（含本轮 W1 的改动）都把「补发一轮再教学提示」当成**免费的**救活动作：失败了就再来一轮，反正"不能停"。

它不是免费的。每补发一轮，就把一段**新的用户消息**永久写进**同一个网页会话**。于是：

```
漂移 → 补发提示（+N 字符）→ 网页上下文变长 → 下一轮更难守约束 → 更容易漂移 → 补发更多
```

这是一个正反馈。今天刚上线的「累计超过 N 次改用完整提醒」把这件事放大成了可测量的量：短提示是「提示 + 协议段」，而**完整提醒会把整份站点教学（本轮实测 26,264 字符）再贴一次**——而且它落进的是同一个网页会话，此后每一轮 prefill 都要重新吃下它。

### 4.2 真机读数：本轮可复算的两端

| 读数 | 值 | 取法 |
| --- | --- | --- |
| webcode 真实工具目录首轮教学 | **26,264 字符** | `.tmp/probe-preset-diff.mjs`，用桥自己的 `buildPreset` 现算 |
| 其中从未被调用的入口占用 | 4,117 字符（13.6%） | 同上（`workflow` 2,651 + `subagent_fork` 1,466） |
| 真机已知最大一轮 | **409,555 字符** | `doc/progress.md` 0.16.3 段的 `GET /__webcode/preset` |
| 303 份会话里 `workflow` / `subagent_fork` 被调用次数 | **0 / 0** | `.tmp/tool-usage-segmented.json`（23,636 次调用全量） |
| `AUTO_CONTINUED` 出现总次数 / 有它的会话数 | **157 / 26** | `.tmp/probe-autocontinue-count.mjs`（303 份会话全解） |
| 单会话单轮最高补发次数 | **42 次**（`session-84a9a24f…`） | 同上 |

最后一行是本轮论证的关键实测：**42 次补发不是假想**。若每一轮都走本轮上线的完整提醒，
那一个会话就要被追加 39 × 26,264 ≈ **1.02 M 字符**（真机已知能收下的最大单轮提示只有 409,555 字符）。
第一轮发现「压力到不了 80%」，而**恢复动作自己就能把它推过任何一个阈值**——这正是 D4
必须存在的理由，也是「重建而不是加长」比起「换个更大的提醒」更根本的地方。

把 26,264 放进 409,555：**一次完整提醒 = 真机已知最大单轮提示的 6.4%**，而且这部分在会话余下的每一轮里都被重复 prefill。若一个长会话触发 4 次升级，就凭空多出约 105,000 字符的常驻上下文——**正是第一轮发现「压力到不了 80%」的那个压力，被恢复动作自己推上去的**。

### 4.3 文献：多轮不是「长上下文」的同义词，它是另一种退化

| 文献 | 逐字/关键数字 | 对本轮的含义 |
| --- | --- | --- |
| [LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120)（arXiv 2505.06120） | 六项生成任务平均降 **39%**；退化分解为「aptitude 的小幅损失 + **unreliability 的大幅上升**」；「when LLMs take a wrong turn in a conversation, they get lost and **do not recover**」；降低 temperature **无效** | 桥最顽固的失效形状（思考里打转、正文不落笔、下一轮又拿到 THINKING_ONLY_NO_ANSWER）与「get lost and do not recover」是同一现象；关键推论：**再教学属于同一类输入**，多给一份不改变不可靠性，只加长上下文 |
| [How Many Instructions Can LLMs Follow at Once?](https://arxiv.org/abs/2507.11538)（arXiv 2507.11538，IFScale） | 500 条关键词包含指令，**最强前沿模型最高密度下也只有 68%**；发现「**bias towards earlier instructions**」与 3 种退化模式 | ① 把 26k 字符的教学贴在**末尾**，是在与真正的任务抢位置；② 约束放**前**更有效——这正是新增的 webcode 模式把「传输事实」同时写进**开头系统指令**的理由（U 形两端的另一半见下） |
| [Probing LLMs' Limits on Multi-Turn Instruction Following](https://arxiv.org/html/2511.03508v1)（arXiv 2511.03508） | 「benchmarks a model's ability to maintain context and adhere to instructions across multiple conversational turns」 | 跨轮的指令守约本身是被单独测量的能力，不能拿单轮守约率外推 |
| [ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615)（arXiv 2510.00615，ICML 2026） | 峰值 token 用量降 **26–54%**，同时**任务成功率上升**；靠「缓解长上下文干扰」让小模型提升最多 **46%** | 支持「压缩/重构」而不是「追加」：本轮的 26,264 字符教学，正确处置是**结构上不该常驻**，而不是写得更好 |
| [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)（arXiv 2307.03172，TACL 2023） | 性能呈 **U 形**：开头与结尾最好，中段显著退化，即使显式长上下文模型也如此 | 长会话里最关键的约束若只出现在**末尾一次**、而任务数据在中段，被忽略的概率最高——这解释了「首轮教过、续跑重申过，模型仍然漂移」 |
| [Parallel Context Compaction for Long-Horizon LLM Agent Serving](https://www.alphaxiv.org/abs/2605.23296)（arXiv 2605.23296） | 「Parallel compaction gives the operator fine-grained, predictable control over summary volume」 | 压缩要**可控**（体积可预测），而不是「到阈值就整段换掉」 |

### 4.4 解决方向 D4：把恢复记成支出，超预算就「重建」而不是「加长」

这一条的关键是：**桥已经有一半机器了**。

- 每轮 fresh 首轮全文都落盘在 `prompts/sessions/<sessionKey>.md`（[`lib/prompt-store.js:157`](../package/dsh-webcode-bridge/lib/prompt-store.js#L157) `writePromptFiles` 的 `sessionText`），读回入口 `readSessionPrompt(sessionKey)` 也在（[`lib/index.js:66`](../package/dsh-webcode-bridge/lib/index.js#L66)）；
- 网页会话丢失时的整段重放已经走 `meta.rebuild()`（[`lib/index.js:3399`](../package/dsh-webcode-bridge/lib/index.js#L3399) 一带）。

**D4 的三步**：

1. **把「重发教学」记成一次支出**：每轮补发按实际注入的字符数累进会话条目（短提示还是完整提醒，两者差一个数量级），透出 `recoveryChars` 到 `/__webcode/status` 与 reply-log。今天只有「第几次」，没有「花了多少」。
2. **升级判据从「累计次数」换成「恢复预算」**：当 `recoveryChars` 越过预算时，**不再在同一个网页会话里追加**，改为走已有的整段重建路径——**用磁盘上的正本开一个新网页会话**。用户的「不要停」仍然成立（续跑继续），但**上下文不再被污染后的长会话拖着走**。
3. **判据**：同一种失效形状再现时，比较「继续补发」与「重建」两条路在**下一次漂移之前的步数**与 `ledgerDriftRatio`。这是一个可以做配对的实验（同站点、同工具面、同任务）。

**为什么这不是「停手」**：重建是继续的一种形态。它保留正本（磁盘上那一份就是上一轮真实发出去的正本，见 `prompt-store.js` 头注），只是把「起点」从被污染的会话换成干净的正本——按 ACON 的读数，这一步同时降低峰值 token 并提高成功率。

**为什么它不是「压缩」**：压缩作用于 DSH 侧的 transcript；D4 作用于**网页会话**。第一轮已经证明 DSH 侧的压缩在 1M 声明下够不着，而网页侧至今没有任何主动手段——这两件事今天被同一个误区混在一起。

### 4.5 两轮为什么独立成立

- **第三轮**的命题是「读数量的是桥的信念、没有对账」。即使恢复动作完全免费、上下文永不增长，这条依然成立。
- **第四轮**的命题是「恢复会加长下一次」。即使读数精确到字节，正反馈依然存在——它说的是上下文变长，不是读数变准。
- 反向也成立：修好任一轮会让另一轮**更容易被发现**。有对账以后，恢复带来的增长会立刻显形（`ledgerDriftRatio` 单调上升）；有预算以后，对账漂移更容易被归因到具体动作（是哪个恢复动作把它推上去的）。
- 两轮指向同一个抽象形状：**今天所有关于「上下文有多大」的判断，都发生在桥这一侧、并且只基于桥自己写下的东西。** 第三轮指出「量尺的量的是自己」，第四轮指出「被量的东西会被自己的动作改大」。

### 4.6 可检验的下一步（按成本排序）

| # | 动作 | 判据 | 成本 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | 采一次 `ledgerDriftRatio`（读回 `POST /__webcode/history`，与 `usageInput()` 比） | 得到一个数；接近 1 则第三轮核心怀疑被证伪 | 一个只读读数，不改行为 | 无 |
| 2 | 把每次补发的注入字符数记进会话条目并透出 | `recoveryChars` 随补发单调增长，且完整提醒那几次明显跳档 | 小（沿用现有 status 通道） | W1 已上线 |
| 3 | 把 `PROMPT_TRUNCATED` 记成「网页真实水位下界」并累积成表 | 得到 ≥1 个真实水位样本，可与 1M 声明对照 | 小 | 需要真机撞一次截断 |
| 4 | 把升级判据从次数换成预算，并按 D4 第二步改成「重建」 | 配对实验：重建后的「下次漂移前的步数」不差于继续补发，且 `recoveryChars` 不再累积 | 中（要动 executor 的重建分支） | 1、2 |
| 5 | 报告里把「压力百分比」标注为**桥自述**，并同时给出量尺 | 报告不再单独出现一个没有量尺的百分比 | 零代码 | 无 |

### 4.7 未证实项（必须跟着结论一起读）

1. **第三轮的核心读数一次都没采过**：`ledgerDriftRatio` 是设计，不是测量。它的真实值可能长期接近 1（那第三轮的怀疑就被证伪），也可能一开始就很大（那过去的压力读数全部要重读）。
2. **409,555 字符是「历史最大」，不是网页上限**；「1M 声明比真实水位大三倍」是本报按 CJK≈0.7 token/字符的**折算推断**，不是实测。
3. **26,264 字符的完整提醒对收敛率的实际影响未知**：本轮只算了**成本**，没有任何**收益**读数。「完整提醒更有效」目前只是设计意图。
4. **「重建优于继续补发」是推断**：真机上没有做过 A/B 配对。它有一个明确的失败可能——重建会丢掉网页会话里那些**只有模型自己写过、桥没落盘**的推理中间态。
5. **文献结论来自公开摘要与正文**，本报未复现其中任何一项实验；跨 harness 外推不成立（见 `references/rules` 与 arXiv 2605.23950 的方法论批评）。
6. **`doc/comment-style.md` §10.2 的那处矛盾**（注释承诺 128k、代码给出 1M）已逐字对照确认，但**它到底应当改哪一侧**不是本轮能定的：改代码会改变自动压缩是否触发，属于用户决策。

### 4.8 引用清单

- Chroma (2025-07). *Context Rot: How Increasing Input Tokens Impacts LLM Performance*. <https://www.trychroma.com/research/context-rot>
- Hong et al. (2025). 同上 techreport 形式，见该页 BibTeX。
- Laban et al. (2025). *LLMs Get Lost In Multi-Turn Conversation*. arXiv:2505.06120. <https://arxiv.org/abs/2505.06120>
- Liu et al. (2023). *Lost in the Middle: How Language Models Use Long Contexts*. TACL. arXiv:2307.03172. <https://arxiv.org/abs/2307.03172>
- Jaroslawicz et al. (2025). *How Many Instructions Can LLMs Follow at Once?* arXiv:2507.11538. <https://arxiv.org/abs/2507.11538>
- Kang et al. (2025/2026). *ACON: Optimizing Context Compression for Long-horizon LLM Agents*. ICML 2026. arXiv:2510.00615. <https://arxiv.org/abs/2510.00615>
- (2025). *Context Length Alone Hurts LLM Performance Despite Perfect Retrieval*. arXiv:2510.05381. <https://arxiv.org/html/2510.05381v1>
- (2025). *Probing LLMs' Limits on Multi-Turn Instruction Following*. arXiv:2511.03508. <https://arxiv.org/html/2511.03508v1>
- (2026). *Parallel Context Compaction for Long-Horizon LLM Agent Serving*. arXiv:2605.23296. <https://www.alphaxiv.org/abs/2605.23296>
- (2026). *Stop Comparing LLM Agents Without Disclosing the Harness*. arXiv:2605.23950. <https://arxiv.org/html/2605.23950v1>
- 提升长上下文指令跟随：ACL Findings 2026, *Improving Long Context Instruction Following*. <https://aclanthology.org/2026.findings-eacl.254.pdf>（已入库于 [`prompt-engineering-evidence-2026-09-14.md`](prompt-engineering-evidence-2026-09-14.md) §2.1）

---

本文件是调研记录，**不是运行链路的一部分**；改删本文件不影响任何行为。第三、四两轮的原始读数落在 `.tmp/`（`tool-usage.json`、`tool-usage-segmented.json`、`teaching-cost.json`、`modsearch-*.json`），需要复算时按文中的命令重跑。
