# 提示词工程：实测证据与差评（2026-09-14 调研）

**为什么这个文件存在**：用户要求「尽可能先找真实提示词工程进行真实实验效果，用同一基准性能测试问题，找到的别人测评的提示词先拉取参考，然后找差评，看真实情况以及适配」。

本文件是那一次检索的**入库结论**，供 `test-mock/prompt-bench.mjs` 的实验设计与 `doc/comment-style.md` §10 引用。

> 口径纪律（沿用 `reference/local-refs/agent-teams-reference-notes.md` 已立的规矩）：
> 凡「文献结论」都给出可复核链接与逐字数字；凡「本报推断」单独标注。**不做推测性归因**。

抓取时间：2026-09-14。

---

## 1. 差评方：提示词工程被实证质疑的三条

### 1.1 无法提前识别「坏提示词」，且既有技巧提升有限

[On the Worst Prompt Performance of Large Language Models](https://neurips.cc/virtual/2024/poster/95497)（NeurIPS 2024，RobustAlpacaEval）。摘要逐字：

- 「a difference of **45.48%** between the worst and best performance for the Llama-2-70B-chat model, with its worst performance dipping as low as **9.38%**」
- 「the **difficulty in identifying the worst prompt** from both model-agnostic and model-dependent perspectives, emphasizing the **absence of a shortcut** to characterize the worst prompt」
- 「We also attempt to enhance the worst prompt performance using existing prompt engineering and prompt consistency methods, but find that their **impact is limited**」

对本项目的含义：**不能承诺某个提示词一定更好**。任何「换了这段提示词就提升 X%」的说法在文献层面站不住。

### 1.2 语义等价改写的波动很大，且模型自己判断不了哪个变体更好

[Benchmarking Prompt Sensitivity in Large Language Models](https://arxiv.org/html/2502.06065v1)（arXiv 2502.06065）。

- 方法：从 TriviaQA / HotpotQA 取 11,469 个问题，用 LLaMA 3.1 8B 与 Mistral-nemo 各生成 **9 个语义等价的变体**（共 114,690 个变体），逐一测正确率。
- 逐字结论：「Small variations in the phrasing, structure, or even punctuation of prompts can often lead to substantially different outputs」。
- 逐字结论：「LLMs can autonomously generate different prompt variations, they **cannot assess which variations are most effective**」。

对本项目的含义：**「让模型自己改提示词再自评」不是解法**——本实验因此不做模型自评。

### 1.3 「叫它专家 / think step by step」这类技巧没有稳定收益

[Why Prompt Engineering Should Not Be Taken Seriously](https://msukhareva.substack.com/p/why-prompt-engineering-should-not)（Maria Sukhareva，2025-09-25）。逐字：

- 「There is nothing meaningful about tips like calling an LLM an "expert," telling it to "think step by step," or wrapping your prompt in elaborate templates.」
- 「it has too much impact. An impact that is **inconsistent and difficult to control**」

（该文为付费墙，正文可读部分已含上述结论与引用清单；付费部分列 6 篇论文，本报**未获取**，不引用其结论。）

---

## 2. 支持方：两条可落地且有实测支撑的改进

### 2.1 长上下文里「周期性重述指令」显著优于「只靠一次系统提示」

[Improving Long Context Instruction Following](https://aclanthology.org/2026.findings-eacl.254.pdf)（ACL Findings）。

表中的对照（三列是三种上下文长度设置，最后一列是均值）：

| 策略 | 均值 |
| --- | --- |
| `none`（不重述） | 49.64 / 54.88 / 49.05 |
| `follows`（只重述「跟随」） | 56.79 – 77.74 |
| `Reinstruct`（重述指令） | 63.33 – 77.62 |

对本项目的含义：**这是本项目已有做法的实证支持**——`agent-preset.js` 的 `TRAIN_NOTE` 每 5 个工具结果重贴一次，方向正确。

**但本报发现一个具体缺口**：现有 `TRAIN_NOTE` 只重述**格式**（「请保持工具调用格式」），没有重述**关键约束**（平台、required 字段、present、不要虚构）。文献里的 `Reinstruct` 是重述**指令**，不只是格式。→ 这构成本轮候选变体 V1 的依据。

### 2.2 长上下文本身会损害性能，即使检索完美

[Context Length Alone Hurts LLM Performance Despite Perfect Retrieval](https://arxiv.org/html/2510.05381v1)（arXiv 2510.05381）。摘要逐字：「long-context language models suffer a common performance degradation when solving long-context tasks, **even with perfect retrieval**」。

对本项目的含义：**首轮 preset 不是越长越好**。现有 `buildPreset` 在工具多时会把每条工具描述截到 1200 字符、schema 截到 4000 字符，全量注入首轮——这正是「长上下文」的来源。→ 构成本轮候选变体 V2 的依据。

---

## 3. 方法论批评：harness 必须披露（这条对本项目特别重要）

[Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/html/2605.23950v1)（arXiv 2605.23950）。摘要逐字：

- 「Every benchmark score is **jointly produced by a model and a harness**, but the harness is **rarely disclosed** and almost never held constant across」

对本项目的含义（**本报推断，非文献原话**）：本项目的独特位置是**它就是 harness 的作者**。因此本项目的基准实验能做别人做不到的一件事：**把 harness 固定并逐条披露**。这既是方法论要求，也是可以对外讲清的东西。

`doc/comment-style.md` §10 因此把「必须披露 harness」写成硬规定。

---

## 4. 综合结论（本项目的立场）

| 能承诺 | 不能承诺 |
| --- | --- |
| 在**固定 harness、固定站点、固定判据**下做配对比较 | 某个提示词「一定更好」或「提升 X%」 |
| 如实报小样本、标注有效期、原始数据落盘 | 显著性检验（样本量根本不够） |
| 披露 harness 全貌（模型/版本/会话模式/判据/限制） | 跨 harness 的横向比较 |
| 两条有文献支撑的具体改动：重述关键约束、首轮精简 | 「提示词工程能稳定提升效果」这类总体宣称 |

---

## 5. 这些结论落到哪

| 结论 | 落点 |
| --- | --- |
| 不能宣称最优 → 只做配对比较 | `test-mock/prompt-bench.mjs` 的设计；`doc/comment-style.md` §10 |
| 不做模型自评 → 用确定性判据 | `test-mock/prompt-bench/cases.json` 每题带机器可判的判据 |
| 重述关键约束有支撑 → 候选变体 V1 `reinstruct` | `lib/prompt-variants.js` 扩 VARIANT_SPECS（`default`/`glm` 逐字不动） |
| 长上下文有害 → 候选变体 V2 `slim` | 同上 |
| harness 必须披露 | `doc/comment-style.md` §10 + bench 报告模板 |
| 真机实验受风控约束 | bench 默认 `--offline`；`--live` 需显式批准、串行、≤3 次/变体、≥20s 间隔 |

---

本文件是调研记录，**不是运行链路的一部分**；改删本文件不影响任何行为。
