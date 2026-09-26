# dwb 插件「按站点分模块」架构审计（2026-09-26）

> 回答用户原话：「请你检查 dwb 插件架构--是否按照网址清晰分开应该分开的模块--不同单独网站适配类似的，就算有重复的也要斟酌是否需要复制隔离保证后续对于单独网点修改合适不影响别人？这个你看文档以及git查看自己思考并给出理由」
>
> 方法：只读。读 `doc/` 权威文档 + `lib/` 实测 + `git log -S` 取证。所有读数可复现。
> 工作树含未提交改动（`lib/{browser-driver,decoder,metrics,index,agent-preset}.js` 等）；引用它们时按**工作树版**标注。

---

## 一、结论摘要

**答「是否按站点清晰分开」：部分分开，且分层是真实的；但「站点知识」目前散落在 4 个文件里，没有收成一个站点一份。**

三条实测结论：

1. **分层是真的，不是摆设。** `providers.js` 是站点声明表（10 个站点 × 冻结对象），`contract.js` 把声明投影成契约（`deepseek` 有专属契约，其余走 `genericContract` 兜底），`decoder.js` 按 `decoder` 字段选解码器族（`globalThis.WebCodeStreamDecoders` 注册表）。新增站点在**声明层**确实只需加一条。

2. **但「加一个站点」实际要动 4 处，不是 1 处。** 这是仓库**自己已经记账**的结构性欠账（`doc/CODE-STRUCTURE.md` 第七节第 2 笔，逐字）：

   > | 2 | **站点知识散落在 4 个文件** | `providers.js` / `contract.js` / `decoder.js` / `browser-driver.js` | 新增站点要改 4 处；UI 改版要跨文件找 |

3. **关于「要不要复制隔离」——本项目已经有过一次正式判断，结论是「不要按站点复制，要收成每站点一个文件」。** `doc/diagnosis-2026-09-16.md` §6.1 逐字：

   > 现状**不适合推倒重来**——12k 行、39 个测试文件、无环依赖、真机证据完备，重写的期望收益为负。真正该做的是把那个结构性裂缝补上：**站点契约从「声明 + 散落 if」收成「声明 + 行为钩子」**……`lib/sites/<siteId>.js` ← 每站点一个文件，导出同一形状的对象……**这不是大重构**：可以**逐站点迁移**。

   **即：既不是「全共用」也不是「按站点复制」，而是「每个站点一个文件 + 同一个形状」。** 这份判断与本轮实测一致，本轮不推翻它，只补上证据与优先级。

**给用户的可执行答复**：

- 你担心的「改一个站点影响别人」**确实存在**，且**已经发生过**（见 §四）。
- 但解法**不是复制粘贴隔离**——本项目已有反例：`decoder.js` 里 `GlmDecoder`/`KimiDecoder`/`KimiConnectDecoder` 都是 `extends JsonLinesDecoder`，是**继承复用**而非复制；而 `finish()` 那个「失败分支丢内容」的缺陷**一次修了 4 个解码器族**（0.19.16），恰恰证明共用基类让一次修复覆盖多站点——**复制隔离会让这类修复变成 4 次**。
- 真正该做的是把散落的站点知识**收成每站点一个文件**（诊断文档 §6.1 的方案），这样「改一个站点只动一个文件」和「公共缺陷一次修」**同时成立**。

---

## 二、当前分层实测地图

### 2.1 分层（`doc/CODE-STRUCTURE.md` 第二节的 8 层，实测核对）

| 层 | 模块 | 站点相关机制 |
| --- | --- | --- |
| 第 2 层 站点知识 | `providers.js` | **站点声明表**：`SITES = [DEEPSEEK, GLM, CHATGPT, KIMI, QWEN, DOUBAO, GROK, CLAUDE, GEMINI, ZAI]`，每个 `site({...})` 冻结对象（origin/选择器/models/decoder） |
| 第 2 层 | `contract.js` | **契约投影**：`SITE_CONTRACTS = fromEntries(SITES.map(...))`，`deepseek` 走 `DEEPSEEK_WEB_CONTRACT`，其余走 `genericContract(st)` |
| 第 3 层 协议判据 | `agent-preset.js` | **按站点分支的传输形状**：`siteId === 'glm'` / `'deepseek'` / 其余（`lib/tool-transport.js` 是它的只读路由立面） |
| 第 3 层 | `prompt-variants.js` | **变体表**：`VARIANT_SPECS` 用 `only`/`excludes` 声明站点归属 |
| 第 4 层 驱动 | `browser-driver.js` | **God file**：站点差异散落其中（见 §三） |
| 第 3 层 | `decoder.js` | **解码器族**：9 个 class（实测），其中 3 个 `extends JsonLinesDecoder` 复用基类 |

### 2.2 站点字符串分布（实测读数，按「行数」计）

```
providers.js         157   ← 声明表（应有）
browser-driver.js     95   ← God file（问题所在）
index.js              79   ← 入口（部分合理）
decoder.js            61   ← 解码器族（部分合理）
agent-preset.js       55   ← 协议分支（部分合理）
web-control.js        30
mirror.js             29
prompt-variants.js    24
contract.js           16
accounts.js           13
metrics.js            11
settings-page.js      10
model-picker.js       10
tool-transport.js      8
upstream.js            5
openai.js              3
prompt-store.js        3
roster.js              3
image-pricing.js       2
task-ledger.js         2
其余 6 个文件各 1
```

**判读**：`providers.js` 157 行是**设计意图**（站点知识集中地）；`browser-driver.js` 95 行是**欠账**（God file 内散落站点差异）；其余多数是**合理的按站点分派**。

### 2.3 每个「站点相关」模块的机制判定

| 模块 | 是否按站点分派 | 机制 | 判定 |
| --- | --- | --- | --- |
| `providers.js` | 是 | 声明表 `SITES` + `site()` 冻结 | **(a) 表驱动** |
| `contract.js` | 是 | `SITE_CONTRACTS` + `genericContract` 兜底 | **(a) 表驱动 + (b) 兜底** |
| `prompt-variants.js` | 是 | `VARIANT_SPECS` 的 `only`/`excludes` | **(a) 表驱动** |
| `tool-transport.js` | 是 | 委托 `variantIdForSite`（不另立第二张表） | **(a) 表驱动** |
| `decoder.js` | 是 | `decoder` 字段 → `WebCodeStreamDecoders` 注册表 | **(a) 表驱动**（族内继承复用） |
| `agent-preset.js` | 是 | `if (siteId === 'glm') … if (siteId === 'deepseek') …` | **(b) 共享 + 站点逃生舱**（只有 2 个特例） |
| `browser-driver.js` | 是 | 散落 `if (siteId === 'deepseek')` ×4 + 硬编码选择器 | **(c) 危险耦合**（见 §三） |
| `index.js` | 是 | `siteId === 'deepseek'` ×5（默认驱动槽） | **(b)** 但语义是「deepseek 是默认槽」，属兼容性硬约束 |

---

## 三、耦合点清单（file:line + 风险）

### C1【高】硬编码 DeepSeek 专用选择器出现在 God file 里

**位置**（工作树版 `lib/browser-driver.js`）：

```
:210  const ANSWER_SELECTOR = '.markdown, [data-message-author-role="assistant"], .ds-markdown';
:217  const sels = ['.markdown', '.answer', '[data-message-author-role="assistant"]', '.response-container', 'main'];
```

**风险**：这是**唯一一处**「站点选择器写死在驱动里」的地方，而它服务全部 10 个站点。

**已经真实发生的后果**（2026-09-26 真机实测，`test-mock/real-probe-30-glm-dom.mjs`）：chatglm.cn 对这份串的命中读数**全为 0**——`.markdown`/`.ds-markdown`/`.answer`/`.response-container`/`[data-message-author-role]` 的 `count` **全为 0**。旧实现把「采样到空串」当成 `domAvailable=true` ⇒ `lastDomGrowthAt` 从不刷新 ⇒ `shouldSettleWip` 的「DOM 停长」**恒成立** ⇒ 收束器只凭「流静默 2.5s」就腰斩仍在生成的回复。

> ⚠️ **本节证据的时效性修正（同日后续复测）**：用 `real-probe-31-glm-dom-deep.mjs` 复测时发现，**裸 playwright 深链导航** `goto(chatglm.cn/main/alltoolsdetail?cid=…)` 现在会被 chatglm.cn 的**阿里云滑块**拦住（页面 title 变成「滑动验证页面」，DOM 里只有 `capture-container` / `aliyunCaptcha-*` / `nc-container`，`main` count=0）。
>
> ⇒ 上面那批「count 全为 0」的读数是在**滑块页**上读的，不是在真实会话页上读的。**该读数不能证明「选择器对 GLM 瞎」**。
>
> 但**结论方向不变**：只要 `ANSWER_SELECTOR` 里的串**不含任何 GLM 真实类名**，就仍是一处「服务 10 个站点却只写 DeepSeek 类名」的耦合——这一点从源码可直接判定，不依赖那批读数。**待办**：改用「驱动路径」（打开站点首页 + 正常发消息，实测不受滑块影响）重采一次 GLM 的节点读数，才能给出「命中/不命中」的定论。
>
> 佐证「驱动路径不受影响」：`real-glm-e2e.mjs` 与 `real-glm-tool-loop.mjs` 走驱动路径**双双真机 PASS**（见 `doc/session-2026-09-26-requirements-and-progress.md` §4.2）。

**注意**：该处的注释**已经写出**「契约层（`providers.js` 的 `answerSelector`）一旦给出站点专属选择器，这里就是它唯一的消费者」——但实测 `grep answerSelector lib/providers.js` **零命中**，即**该契约字段尚不存在**，声明与实现不同步。

**建议**：把 `answerSelector` 真正加进 `providers.js` 的站点声明（GLM 用实测命中的选择器），`ANSWER_SELECTOR` 降级为「声明缺省时的兜底」。成本低（一个字段 + 两处消费点），收益直接（消除 C1）。

### C2【中】`agent-preset.js` 的站点分支是 if 链，不是表

**位置**（工作树版）：

```
:315  const base = key === 'deepseek' ? trainNoteOfficialFor(tools) : (TRAIN_NOTES[key] || TRAIN_NOTE);
:421  if (siteId === 'glm') return GLM_TRANSPORT + presentTransportNote(tools);
:422  if (siteId === 'deepseek') return deepseekTransport(tools) + presentTransportNote(tools);
:470  ...(options.siteId === 'glm' ? [...] : options.siteId === 'deepseek' ? [...]
:513  options.siteId === 'deepseek'
:598  const resolved = mode === 'auto' ? (options.siteId === 'deepseek' ? 'slim' : 'full') : mode;
```

**风险**：新站点若需要第三种传输形状，必须**改这个文件**（而不是加一行声明）。

**但**：`doc/CODE-STRUCTURE.md` 第四节的判据明确说 `agent-preset.js` **不该拆**：

> `agent-preset.js` 不满足（它的 5 代分支服务同一个协议，拆开会制造两套协议漂移）。

**建议**：**维持现状**。站点分支只有 2 个特例，且协议文本必须与解析器同源（拆开就是三次泄漏事故的老路）。若未来出现第 3 个传输形状，再加一层 `TRANSPORT_BY_SITE` 表，但仍留在本文件内。

### C3【中】`index.js` 的 `siteId === 'deepseek'` 是兼容性硬约束，不是可随意改的分支

**位置**：`:874`、`:2422`、`:2475`、`:3154`、`:3167`。

**语义**：deepseek 用**注入的** `driver`（测试桩）与默认 `profileDir`，其余站点走 `drivers` Map 懒创建。

**风险**：看似站点分支，实为**测试注入契约**。`index.js:2422` 的注释已说明「`driverFor('deepseek')` 必须仍返回注入的 driver；若默认槽改走 createBrowserDriver，测试全断」。

**建议**：**保持**，但应把判据从「`siteId === 'deepseek'`」抽成「是否默认注入槽」的具名谓词，让下一个读代码的人不会误以为这是可改的站点特例。

### C4【低】`decoder.js` 的族内继承是**正向**耦合，不是欠账

实测 11 个 class，其中：

```
:115  class DeepSeekStreamDecoder
:359  class OpenAiSseDecoder
:425  class ChatGptDecoder
:505  class JsonLinesDecoder          ← 基类
:579  class GlmDecoder      extends JsonLinesDecoder
:728  class KimiDecoder     extends JsonLinesDecoder
:835  class KimiConnectDecoder extends JsonLinesDecoder
:781  class ClaudeSseDecoder
:860  globalThis.WebCodeStreamDecoders = Object.freeze({ ... })
```

**这是「共用基类 + 按站点子类」，正是「既不复制、又隔离」的形态。** 0.19.16 实证其价值：`finish()` 的「失败分支丢弃已解内容」缺陷**一次修了 4 个族**（`JsonLinesDecoder`/`OpenAiSseDecoder`/`ChatGptDecoder`/`ClaudeSseDecoder`）。

**若改成按站点复制**：同一个缺陷要修 4 次，且必然漏修（本项目记过同型事故：三份并存的 `ANSWER_SELECTOR` 字面量「修一处、忘两处」）。

**建议**：**保持并推广这个形态**。

---

## 四、git 与文档证据：跨站点影响**确实发生过**

### 4.1 仓库自己记的结构性欠账（权威）

`doc/CODE-STRUCTURE.md` 第七节第 2 笔（逐字）：

> | 2 | **站点知识散落在 4 个文件** | `providers.js` / `contract.js` / `decoder.js` / `browser-driver.js` | 新增站点要改 4 处；UI 改版要跨文件找 |
>
> 第 2 笔是**结构性**的，也是 `doc/diagnosis-2026-09-16.md` 第 6.1 节给出的唯一框架级建议。

### 4.2 框架级建议（权威，且与本轮结论一致）

`doc/diagnosis-2026-09-16.md` §6.1 逐字给出目标形态：

```
lib/sites/<siteId>.js      ← 每站点一个文件，导出同一形状的对象
   { meta,           // origin/选择器/模型目录（现 providers.js）
     decoder,        // 解码（现 decoder.js 的按站点分支）
     modelSelect,    // 选模型（现 browser-driver.js::selectModelDeepSeek）
     teaching,       // 教学立场与传输判定（现 agent-preset.js 的 GLM 特例）
     nav,            // 会话地址三态（现 contract.js::navContractFor）
     capabilities }  // antiBot/rootPathForSpa/staticOrigins/experimental
```

并明确：「**这不是大重构**：可以**逐站点迁移**，DeepSeek 先迁（它已有最多特例），其它站点先走 `genericContract` 兜底，行为不动。风险可控、可回退。」

排期表里这件事的优先级是 **P2**，状态「⬜ 待做（框架建议见 §6）」。

### 4.3 `git log -S` 取证：站点知识的实际改动轨迹

```
e828f20  feat: GLM 会话身份/三态导航 + 上下文预算闸 + 修 OpenAI 前端绕过发送间隔（0.14.2）
9f80524  fix: 右栏根相对资源改写（GLM/z.ai 打不开根修）+ 限流截断帧识别（0.12.8）
6b95cf2  feat(accounts): 同站多账户槽（0.14.7）
```

**判读**：`e828f20` 与 `9f80524` 都是**单站点驱动的修复**（GLM/z.ai），但提交里同时改了「上下文预算闸」「限流截断帧识别」「OpenAI 前端绕过发送间隔」——即**一次站点修复把公共链路一起改了**。这正是「改一个站点，影响所有人」的形状。

### 4.4 反向证据：共用基类让一次修复覆盖多站点（0.19.16 实证）

`doc/progress.md` 0.19.16 节逐字：

> **修法（4 个解码器族一次落齐）** | 失败分支一律带出 `{text,thinking,images}` + `partial`。……覆盖 `JsonLinesDecoder` / `OpenAiSseDecoder` / `ChatGptDecoder` / `ClaudeSseDecoder`。

**若按站点复制隔离，这一次要改 4 份代码，且 0.19.16 的「附带修残缺尾帧」只改了 `GlmDecoder` 一族——另三族的同型缺陷会各自潜伏。**

### 4.5 三份并存字面量的漂移教训（0.19.16）

`lib/browser-driver.js` 工作树版 `:195-209` 的注释逐字：

> 0.19.16 之前这两处各写一份**逐字相同**的字面量（原先还有第三处）。三份并存的代价不是冗余而是**漂移**：修一处、忘两处，于是「判据用的节点」与「兜底交出去的节点」不是同一个，读数自相矛盾且看不出来。

**这是「复制隔离」在本仓库的**实测反例**：复制没有带来隔离，带来了漂移。

---

## 五、建议（逐耦合点给「保持共用 / 加站点覆写表 / 完全隔离」+ 理由与成本）

| # | 耦合点 | 建议 | 理由 | 成本 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **C1** | `browser-driver.js` 硬编码 `ANSWER_SELECTOR` | **加站点覆写表**（`providers.js` 新增 `answerSelector` 字段，驱动侧降级为兜底） | 声明与实现不同步已被实测抓出（注释说有、`grep` 无）；一个字段就能消掉唯一一处「选择器服务全站点」 | 低（1 字段 + 2 消费点 + 护栏） | 低（缺省回落到现串，行为不动） |
| **C2** | `agent-preset.js` 站点 if 链 | **保持共用**（不加隔离） | 仅 2 个特例；协议文本必须与解析器同源，拆开就是三次泄漏事故的老路（`CODE-STRUCTURE.md` 第四节明确说它不该拆） | 零 | 零 |
| **C3** | `index.js` 默认槽分支 | **保持共用**，但抽成具名谓词 | 它是测试注入契约而非站点特例；具名后不会被下一个读者误改 | 极低（改名） | 极低 |
| **C4** | `decoder.js` 族内继承 | **保持并推广** | 0.19.16 实证：一次修 4 族；复制隔离会让它变 4 次 | 零 | 零 |
| **C5** | 站点知识散落 4 文件（结构性） | **收成 `lib/sites/<siteId>.js`**（诊断 §6.1 方案），**逐站点迁移，DeepSeek 先行** | 这是仓库自己给的**唯一框架级建议**，且已论证「不是大重构、可回退」；它同时满足「改一个站点只动一个文件」与「公共缺陷一次修」 | **中高**（P2 级，需分阶段 + 每阶段全量测试） | **中**（迁移期两套路径并存，必须靠护栏钉住行为不变） |

### 关于「要不要为了隔离而复制」的正面回答

**不要复制。** 三条实测理由：

1. **复制在本仓库已经产生过漂移而不是隔离**（§4.5：三份 `ANSWER_SELECTOR` 字面量，修一处忘两处）。
2. **复制会让公共缺陷的修复成本乘以站点数**（§4.4：0.19.16 一次修 4 族）。
3. **真正提供隔离的是「每站点一个文件 + 同一形状」**，而不是「同一段代码抄 N 份」。前者改一个站点只动一个文件；后者改一个公共判据要动 N 个文件、且必然漏改。

**正确的目标形态**（诊断 §6.1 已给出）：`lib/sites/<siteId>.js`，每站点一个文件、导出同一形状对象，公共引擎留在 `browser-driver.js`。这样「站点差异」与「公共机制」在**文件边界**上就分开了。

---

## 六、未决问题（本轮没能确认的）

1. **`lib/sites/` 迁移的真实工作量未评估。** 诊断 §6.1 说「不是大重构」，但没给行数/文件数读数。本轮未做该评估（属 P2 排期，不是本轮范围）。
2. **`real-probe-30-glm-dom.mjs` 的实测结论只覆盖 GLM。** 其余 8 个站点（chatgpt/kimi/qwen/doubao/grok/claude/gemini/zai）的选择器命中情况**没有实测**——C1 的「一处选择器服务全站点」对其余站点同样可疑，但无证据。
3. **`doc/ROADMAP.md` 第 2 节的指向已失效。** `CODE-STRUCTURE.md` 两次引用「见 `ROADMAP.md` 第 2 节」，而该文件当前的分节是「一、当前坐标 / 二、阶段划分（P0→P5）」，**没有**对应的「站点差异外移」节。该引用需修正或 ROADMAP 需补节。
4. **`answerSelector` 契约字段是否曾存在过。** `browser-driver.js` 注释以「`providers.js` 的 `answerSelector`」为前提，但工作树 `grep` 零命中。未能确认它是「计划中」还是「曾经有后被删」。
5. **本轮未运行真机探针。** §四 的跨站点影响证据全部来自 git 历史与文档，未经真机复现。

---

## 附：复现命令

```powershell
# 站点字符串分布
Get-ChildItem package\dsh-webcode-bridge\lib -Filter '*.js' | ForEach-Object { $m=(Select-String -Path $_.FullName -Pattern 'deepseek|glm|zai|chatgpt|kimi|qwen|doubao|grok|claude|gemini' -AllMatches | Measure-Object).Count; if ($m -gt 0) { [PSCustomObject]@{File=$_.Name; Lines=$m} } } | Sort-Object Lines -Descending

# 硬编码 DeepSeek 选择器
Select-String -Path package\dsh-webcode-bridge\lib\*.js -Pattern 'ds-markdown|data-message-author-role'

# 站点分支 if 链
Select-String -Path package\dsh-webcode-bridge\lib\agent-preset.js -Pattern "siteId === '"

# 解码器族
Select-String -Path package\dsh-webcode-bridge\lib\decoder.js -Pattern '^class '

# 结构性欠账
Select-String -Path doc\CODE-STRUCTURE.md -Pattern '站点知识散落'
Select-String -Path doc\diagnosis-2026-09-16.md -Pattern '6\.1 框架判断'
```
