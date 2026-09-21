# 参考项目清单（`reference/` 调研素材）

本文件记录 `reference/` 目录下 35 个第三方项目的来源、与本仓库的关系，以及**哪些被真正采用过**（连同 `local-refs/` 共 36 个目录）。这个数字不是手抄的，可用 `node scripts\gen-reference-index.mjs` 直接从磁盘生成核对——**表里的条目数应与该脚本的输出一致**。

`reference/` 是**只读调研素材**，不在运行链路里：`doc/review-guide.md` 已明确写着「`extension/`、`reference/`、`doc/` 都不是运行链路，审查时可以直接跳过」。删除整个 `reference/` 不影响任何行为。

> **本文件与 `reference/README.md` 的分工（两者不重复）**：每个条目的 **remote + HEAD SHA + 大小**（**来源与版本**）登记在 [`reference/README.md`](../../reference/README.md)——那张表由 `node scripts\gen-reference-index.mjs` 生成，可用 `node scripts\gen-reference-index.mjs --check` 与磁盘校验，**本文件不重复这几个字段**。本文件回答的是另一个问题：「**这个项目是干什么的、我们采用了哪一点**」（用途与采用记录，手写，来源是本仓库源码的出处标注与 `local-refs/` 笔记）。加入新参考仓库时两处都要更新：那一处的表跑脚本即可，这一处的手写条目要人补。

> **本文件的取证口径**：每一条「用了哪一点」都来自**本仓库源码自己的出处标注**（形如「（glm-free-api 同构）」）或 `reference/local-refs/` 下的调研笔记。凡是源码里没有引用、笔记里也没有记录的项目，一律标「仅作背景素材，未直接采用」——**不做推测性归因**。
>
> 抓取/整理时间：2026-09-07（见 `reference/local-refs/` 各笔记的抓取时间戳）；本文件复核时间：2026-09-16（补录 4 个 `dsh-*` 仓库、修正项目计数与 `local-refs/` 文件计数、改正 11 处已漂移的 `file:line`）。

## 总表

| 项目 | 是什么 | 我们用了哪一点 | 仍在运行链路 |
| --- | --- | --- | --- |
| `agent-browser` | Vercel Labs 的浏览器自动化 CLI（Rust，给 AI agent 用） | 未直接采用（同类思路：浏览器自动化作为 agent 能力） | 否 |
| `agentdock` | 同名多项目：并行 agent 汇诊台 / 独立工具运行时 / provider 无关 Agent 框架 | 「provider 无关适配器」的思路启发了站点契约分层 | 否 |
| `agent-team`（官方实验包，32） | **DSH 官方** `packages/experimental/*`：Team 领域服务 + 9 个 scoped 工具 + profile bundle | **实际采用（参考实现，2026-09-14 新增）**：九工具名与语义、CAS 任务板、scoped 注册、`writeScopes` 仅警告的立场；详见 `local-refs/agent-teams-reference-notes.md` | 否（已装入 web profile，但是独立插件而非本仓库代码） |
| `AIstudioProxyAPI` | 用 Camoufox + Playwright 把 Google AI Studio 网页转成 OpenAI 兼容 API | 未直接采用（同类路线佐证） | 否 |
| `browser-ai-bridge` | 本地 REST 服务，用 Playwright/CDP 驱动真实浏览器会话操作 AI 网页 | 未直接采用（同类路线佐证） | 否 |
| `chatgpt-gateway` | 浏览器扩展 + Camoufox 网关，免手动标签页访问 ChatGPT Pro | 未直接采用 | 否 |
| `chatgpt-vscode` | VS Code 里的 ChatGPT 扩展（走非官方 API） | 未直接采用 | 否 |
| `chatgpt2api-NoReverse` | ChatGPT 网页转 API 的小玩具项目（作者自称 vibe-coded toy） | 未直接采用 | 否 |
| `claude-code-reverse` | Claude Code 源码 map 逆向分析报告 | **参考实现（2026-09-14 补录）**：子代理与 Team 的面板形态、`Task`/`tasks` 的分离（子代理 worker vs 对等 teammate）——本轮 UI 要把两者分开的形态依据；`src/src/Task.ts`、`src/src/tasks.ts` | 否 |
| `cursor-2api` | 把 Cursor 网页版转成 OpenAI 标准 API | 未直接采用 | 否 |
| `deepseek-free-api` | DeepSeek 网页反向代理（Python/FastAPI，含 PoW 求解） | DSML 标记剥离的写法参考（`strip_dsml_markup`） | 否 |
| `deepseek-reverse-api` | DeepSeek 网页版 OpenAI 兼容 API（Python/Flask） | 未直接采用 | 否 |
| `deepseek-web-api` | Node.js 实现的 DeepSeek 网页 API（CI + 测试较完整） | 未直接采用（协议事实由 `local-refs` 笔记交叉验证） | 否 |
| `deepseek-web-import` | **DSH 插件**：把 chat.deepseek.com 历史对话导入 DSH 正式会话 | 两条：同源挂载模式；控制面安全立场（被我们「收紧后」沿用） | 否（同类插件，非依赖） |
| `dsh-compass` | **DSH 插件**：上下文与文件面板——目录浏览器、注入上下文与只读 git graph，一个可安装 bundle | 未直接采用 | 否（同类插件，非依赖） |
| `dsh-deepseek-chat` | **DSH 插件**：侧栏加「网页对话」按钮打开 chat.deepseek.com | 未直接采用 | 否 |
| `dsh-file-attachment` | **DSH 插件**（`@wszhoho/dsh-file-attachment` 0.5.4）：拖拽 / 粘贴 / 📎 按钮上传文件，图片与文档**统一落盘**到会话工作区 `.dsh-file-attachment/<日期>/<文件名>` 并插入 `@绝对路径` 引用；纯文本粘贴**不改写**（完全原生）。2026-09-17 补录 | **尚未采用，仅调研**：候选方案，用于补 DSH 本体缺失的「长文本粘贴落盘」能力（本体 `PASTE_COMMAND` 只对 `kind==='file'` 走附件通道，纯文本恒走 `pasteText` 内联，无长度阈值）。关键事实：它**只处理文件对象**，不处理超长纯文本——这一点直接决定了它能否解决本仓库记录的粘贴超限问题 | 否（同类插件，非依赖） |
| `dsh-flowglass` | **DSH 插件**（流镜 Flowglass）：session flowgraph，实时可视化消息、工具组、子代理分支与步骤详情 | 未直接采用 | 否（同类插件，非依赖） |
| `dsh-session-graph` | **DSH 插件**：可视化会话图——在交互式画布上浏览、排列、分枝、合并与汇总 AI agent 会话 | 未直接采用 | 否（同类插件，非依赖） |
| `dsh-task-graph` | **DSH 插件**：任务流/执行图谱——可视化单个任务的完整运行（agent、工具、skill、子任务、重试、实时状态） | 未直接采用 | 否（同类插件，非依赖） |
| `eventsource-parser` | 通用 SSE 流解析库（无传输假设） | **源码中无任何引用**，未直接采用 | 否 |
| `glm-free-api` | GLM（chatglm.cn）免费 API 反向代理 | **实际采用**：GLM 流帧形状与「同构」判断 | 否 |
| `kimi-code` | Moonshot 官方 Kimi Code CLI | 未直接采用 | 否 |
| `Kimi-Free-API` | Kimi 免费 API 反向代理 | **实际采用**：Kimi 流帧形状 + 真实流端点路径 | 否 |
| `LLMs2API` | 多站点（chatgpt/claude/deepseek/gemini/qwen）转 API | **实际采用**：Qwen 的 JSON-patch 结构帧形状 | 否 |
| `local-refs` | **本项目自己的调研笔记存档**（6 份 md + `2026-09-12-review-sources/` 11 个文件） | 协议事实交叉验证（DeepSeek 逆向/V4 事实、expert 模式、2api、Agent Teams 官方实验包） | 否（是笔记，不是项目） |
| `node-http-proxy` | 经典 Node HTTP 代理库 | 未直接采用（镜像走自研 `lib/upstream.js`） | 否 |
| `openai-stream-parser` | OpenAI 流式响应（SSE）轻量解析库 | **源码中无任何引用**，未直接采用 | 否 |
| `opencode2dsh` | **DSH 插件**：把 OpenCode Zen 模型接进 DSH | **实际采用**：LLM adapter 的纯注册形状 | 否（同类插件，非依赖） |
| `Qwen-Copilot` | VS Code 扩展：在 Copilot Chat 里用 Qwen Code 模型 | 未直接采用 | 否 |
| `qwen-free-api` | Qwen 免费 API 反向代理 | **实际采用**：Qwen 直连兜底的 JSON 形状 | 否 |
| `steel-browser-npm` | （目录为空，无 README/package.json） | 未采用，内容缺失 | 否 |
| `wabac.js` | Service Worker 版网页归档回放系统（Wayback 风格） | 未直接采用（镜像改写为自研；思路同类） | 否 |
| `WebBridge` | 让 AI 编码 agent 操作真实 Chrome（带登录态/扩展） | 未直接采用（同类路线佐证） | 否 |
| `WebChat2Api` | DeepSeek 网页 API 反代（纯 Python，无 Electron） | 未直接采用 | 否 |
| `webcode` | 另一个「驱动真实网页做编码」的项目 | **实际采用**：用**独立窗口**而非 iframe 承载站点的做法 | 否 |
| `zai-copilot-chat` | 在 GitHub Copilot Chat 里用 Z.AI GLM 模型的扩展 | **实际采用**：GLM-5.3 起「思考不可关」的方言佐证 | 否 |

> **2026-09-16 补录的 4 个 `dsh-*` 仓库**（`dsh-compass`、`dsh-flowglass`、`dsh-session-graph`、`dsh-task-graph`，合计 59.4 MB）此前漏登记。它们的「是什么」一列摘自外部清单 [`awesome-deepseek-harness-README.zh-CN.md`](awesome-deepseek-harness-README.zh-CN.md)（分别在该文件的 3509 / 2182 / 1455 / 2047 行）；本仓库 `package/` 下 `grep` 不到对这四个名字的任何引用，按上文「本文件的取证口径」记「未直接采用」。

统计：35 项中 **7 项**有源码级出处标注（`glm-free-api`、`Kimi-Free-API`、`LLMs2API`、`qwen-free-api`、`deepseek-free-api`、`opencode2dsh`、`zai-copilot-chat`），另加 `agentdock`/`deepseek-web-import`/`webcode`/`claude-code-reverse` 各 1 条明确引用，共 **11 项**可确证被参考过。其余 24 项为背景素材（含上条补录的 4 个 `dsh-*` 插件）。

## 逐条：确实被采用的项目

> **行号口径（2026-09-16 复核）**：下面每条引用都带**可 grep 的原文锚点**——引号/反引号里的就是源码注释原文，**以锚点为权威**；`file:line` 只是复核时的快照，会随代码漂移。本轮核对出 11 处已漂移并改成复核值：`lib/decoder.js` 的 490→551、558→624、575→641、416→470、329→383，`lib/providers.js` 的 122→226，`lib/agent-preset.js` 的 419→493，`lib/index.js` 的 1482→1988、415→491、775→948，`lib/browser-driver.js` 的 1672→2096。行号相对**插件包根**（`package/dsh-webcode-bridge/`），不是仓库根。

### `glm-free-api` → GLM 解码器

本仓库 `lib/decoder.js` 的 GLM 解码器直接标注了帧形状来源：

- `lib/decoder.js:10`：「`{conversation_id, status, parts:[{content:[{status, type:'text'|'image'|'code'|'quote_result', ...}]}]}`（glm-free-api 同构）」
- `lib/decoder.js` 的「真实帧（glm-free-api 同构，标准 SSE）」（复核行号 551）
- `lib/decoder.js` 的「与已发内容无前缀关系 = 新片段」（复核行号 624）：增量语义也照它

采用点：chatglm.cn 的 SSE 帧结构与增量语义。**不是**代码依赖——本项目自己实现解码，只是用它作为帧形状的对照。

### `Kimi-Free-API` → Kimi 解码器 + 流端点

- `lib/decoder.js:12`：`cmpl` 才取正文、`all_done`/`error` 收尾（「Kimi-Free-API 同构」）
- `lib/decoder.js` 的「真实帧（Kimi-Free-API 同构，标准 SSE）」（复核行号 641）：`{event:'cmpl', text}` / `{event:'req', id}` 帧形状
- `lib/providers.js` 的「`/api/chat/{id}/completion/stream`」（复核行号 226）：真实流端点带动态会话 id，因此选择器用**子串匹配**

采用点：Kimi 的流事件形状与「端点带动态 id」这一事实（后者直接决定了选择器写法）。

### `LLMs2API` → Qwen 结构帧

- `lib/decoder.js:14`：`{message:{content:{parts}}}` 结构帧（「LLMs2API 同构」）
- `lib/decoder.js:15`：它实测出「qwen 浏览器端是 OpenAI 兼容 SSE」
- `lib/decoder.js` 的「JSON-patch 帧（LLMs2API 同构）」（复核行号 470）：`{o:'append', p:'/message/content/parts/0', v:'文本'}`

采用点：Qwen 的两种帧形态（结构帧 + JSON-patch 帧）。这条最有价值——单看网络流很难猜出 JSON-patch 这种形态。

### `qwen-free-api` → Qwen 直连兜底

- `lib/decoder.js` 的「Qwen 直连兜底（qwen-free-api 同构）」（复核行号 383）：`{sessionId, msgId, contentType, msgStatus, contents:[...]}`

### `deepseek-free-api` → DSML 标记剥离的写法

- `lib/agent-preset.js` 的 `strip_dsml_markup`（复核行号 493）：注释写明「`reference/deepseek-free-api` 的 `strip_dsml_markup` 用 ……」

采用点：DeepSeek 网页偶发产出全角/变体标记（`｜`U+FF5C、丢开头的 `<`）时的清理思路。这是**唯一一条直接点名函数名**的采用记录。

### `agentdock` → 站点契约分层

- `lib/providers.js:3`：「受 AgentDock（github.com/agentdock/agentdock）"provider 无关适配器"启发：……」

采用点：把「provider 无关」做成显式的站点契约（`lib/providers.js` + `lib/contract.js`），而不是把各站点差异散进驱动代码。`reference/local-refs/agentdock-reference-notes.md` 还记录了另两条落点：并行 agent 会话按 `sessionId::agentId` 隔离（本仓库确实如此，见 `lib/index.js` 的 `keyPath`）、工具执行交给 Harness 原生而非网页模拟。

### `deepseek-web-import` → 同源挂载 + 控制面安全立场

- `lib/index.js` 的「same pattern deepseek-web-import uses」（复核行号 1988）：同源挂载，无 CORS
- `lib/web-control.js:9`：「Security posture (mirrors deepseek-web-import's, **tightened**)」

采用点：把控制面挂在宿主 web server 的同源路径上（`/__webcode/*`），而不是另起跨域服务；安全立场沿用并收紧（本项目额外加了 Host 回环族校验与 `Sec-Fetch-Site` 拒绝，见 `doc/security-review.md`）。

### `opencode2dsh` → adapter 注册形状

- `lib/index.js` 的「Pure adapter registration (the shape opencode2dsh's adapter mode uses)」（复核行号 491）

采用点：**只**注册 adapter，不额外调用 `registerConfigurableProviders`——本仓库注释里写明：两处都声明会让 GUI 把 provider 当成「需要 endpoint 配置」的 provider，模型反而不出现在主选择器里。

### `zai-copilot-chat` → GLM-5.3 强制思考

- `lib/index.js` 的「GLM-5.3 强制思考（reference/zai-copilot-chat 的 dialect 佐证：5.3 起思考不可关）」（复核行号 948）

采用点：GLM-5.3 会把工具调用写进**思考流**而不是正文。这条佐证促成了「正文解析不到调用时，从思考全文兜底解析一次」的实现（并明确限制：正文已有可用调用时不看思考，避免把预演草稿当真）。

### `webcode` → 用独立窗口而非 iframe

- `lib/browser-driver.js` 的「参考 webcode 也用独立窗口承载」（复核行号 2096）：原文备注「DeepSeek 等站点 CSP 拒绝 iframe」

采用点：承载站点页面的方式选择。这条直接影响右栏与登录链路的设计（`windowOpener` / 有头 Edge 窗口）。

### `claude-code-reverse` → 子代理与 Team 的面板形态（2026-09-14 补录）

- 采用点：**不是代码**，是**信息架构**——官方把「子代理（worker，结果回报给调用方）」与「Team（对等成员，互相发消息 + 共享任务板）」在界面上分成两种形态：前者从属于发起它的会话，后者平级成行。
- 依据：本仓库 `reference/claude-code-reverse/src/src/Task.ts`、`src/src/tasks.ts` 的存在（子任务与任务分离），配合 [Claude Code Agent Teams 官方文档](https://code.claude.com/docs/en/agent-teams) 的对比表。
- 落点：0.14.9 右栏 team 标签页内部**两个区**——子代理区缩进在本会话之下，Team 区平级。详见 [agent-ui-design-references.md](agent-ui-design-references.md) §4.5。

> 备注：`reference/webcode` 的目录名与本插件的命名（`webcode-bridge`、`/__webcode/*`、`window.__webcodeCaptureInstalled`）**同名不同物**。全仓库 grep `webcode` 有数百处命中，其中绝大多数是插件自身命名，**只有上面这一处**是对该参考项目的引用。本文件不把同名命中当作采用证据。

### `zcode` / `qwen-code` / `doubao2api` → 国内五站协议转换的官方/逆向对照（2026-09-21 补录）

> 这三个是**本轮为 `doc/plans/2026-09-21-domestic-sites-protocol.md` 新拉的参考**，是后续国内站适配（GLM 打样）的对照基准，**尚未写入任何代码**。按本文件「不伪造采用痕迹」的立场，这里登记它们的既定用途与理由，具体采用点等实现任务落地后回填。

- `reference/zcode`（`zai-org/ZCode`，智谱官方 ADE，总部 HEAD `872ad96`）：GLM 的第一方 Agent 运行时 + 工具调用协议。已确认 `apps/zcode-cli/packages/adapters/src/model/` 下存在对本项目最相关的实现：`streaming-tool-call-assembler.ts`、`tool-call-validation.ts`、`tool-input-normalization.ts`、`reasoning-history-normalization.ts`、`tool-result-media-projection.ts`——这正是「带状态机的工具调用解析」「推理/思考归一」「工具结果回注」三个设计要点的官方参照。计划用来对齐 Task 1 的 `lib/tool-transport.js`/`lib/tool-parser.js` 与 GLM 打样（Task 2）。
- `reference/qwen-code`（`QwenLM/qwen-code`，千问官方 ADE，总部 HEAD `1ac0971`）：千问官方 agent，`packages/core` 有 provider 接入（OpenAI/Anthropic/Gemini 多协议）、`packages/cli` 有 `qwen serve` HTTP/SSE daemon 协议、`packages/acp-bridge` 有 ACP 通道。用于对齐千问站的模型切换、流协议与上下文投影。**值得注意的是：它不暴露 Qwen 网页端私有协议本身**，价值在 Agent 语义层。
- `reference/doubao2api`（`wangchuxiaoji-oss/doubao2api`，豆包网页端第三方逆向，总部 HEAD `95beb07`）：Playwright 驱动 doubao.com、自动注入 `a_bogus`+`msToken` 签名、兼容 OpenAI Chat Completions、支持多轮/深度思考/联网/文生图。用于对齐豆包站（`decoder:doubao`）的请求体签名与会话形状——是豆包站当前唯一可参照的网页逆向实现。

- `AIstudioProxyAPI`、`browser-ai-bridge`、`WebBridge`、`chatgpt-gateway`：都走「Playwright/Camoufox 驱动真实浏览器 + 持久登录 profile」这条路。它们佐证了**这条路可行**，但没有代码或协议被采用。当时被否掉的是**浏览器扩展**路线（见下节），而这些项目多是独立进程/扩展两种形态混杂。
- `deepseek-web-api`、`deepseek-reverse-api`、`WebChat2Api`、`chatgpt2api-NoReverse`、`cursor-2api`：DeepSeek 及其他站点「网页转 API」的同题项目。协议事实以 `reference/local-refs/` 的交叉验证笔记为准（见下节），未从这些代码取用。
- `wabac.js`、`node-http-proxy`：镜像/反代相关。本仓库的镜像（`lib/mirror.js`）与上游抓取（`lib/upstream.js`）都是自研，**未引入**这两个依赖。
- `eventsource-parser`、`openai-stream-parser`：SSE 解析库。**源码中零引用**——本项目 `lib/decoder.js` 自己解析 SSE。曾作为「通用 SSE 解析应该长什么样」的对照，但没有任何引用点，因此不能算采用。
- `agent-browser`、`kimi-code`、`Qwen-Copilot`、`chatgpt-vscode`、`dsh-deepseek-chat`、`dsh-compass`、`dsh-flowglass`、`dsh-session-graph`、`dsh-task-graph`：浏览/了解，未见任何采用痕迹（最后 4 个 `dsh-*` 是 2026-09-16 补录，`package/` 下 `grep` 零命中）。
  （`claude-code-reverse` 已从本行移出——2026-09-14 它有了明确采用点，见上方逐条。）
- `steel-browser-npm`：**目录为空**（无 README、无 package.json），无法判断内容。

## `reference/local-refs/` —— 真正的事实来源

这个目录是**本项目自己的调研笔记**（不是第三方项目）：**根级 6 份 `.md` + 两个归档子目录（`2026-09-12-review-sources/` 11 个文件、`2026-09-21-zcode-docs/` 4 个 HTML 快照）**。计数口径可直接核对：

```powershell
Get-ChildItem reference\local-refs                    # 6 份 md + 2 个归档目录
Get-ChildItem reference\local-refs\2026-09-12-review-sources   # 11 个文件
Get-ChildItem reference\local-refs\2026-09-21-zcode-docs       # 4 个 HTML（ZCode 官方文档快照）
```

`reference/*/` 被 `.gitignore` 排除，只有本目录（与 `reference/README.md`）入库——**换机器后活下来的参考材料只有这些**，所以这里的记录比 `reference/` 下的代码树更重要。

| 文件 | 内容 |
| --- | --- |
| `deepseek-web-逆向与V4事实-cross-verified.md` | DeepSeek 网页协议与 V4 事实的交叉验证 |
| `deepseek-expert-mode-reverse-engineering.md` | 「专家模式」的逆向分析 |
| `deepseek-2api-README.md` | DeepSeek 转 API 路线摘录 |
| `deepseek-free-api-README.md` | 上述反代项目的能力摘录 |
| `agentdock-reference-notes.md` | AgentDock 三个同名项目的关联度整理与落点 |
| `agent-teams-reference-notes.md` | DSH 官方实验包 `agent-team` 的取证笔记（发布 tarball 的 SHA1 逐字核对、rc.1 与 rc.2 的兼容结论）。**承重文档**：`lib/accounts.js` 的注释直接引用它（复核行号 18） |
| `2026-09-12-review-sources/`（11 个文件） | 右栏一致性评审的原始快照：9 份 HTML（Playwright Screencast、CDP Page domain、ReplayWeb 嵌入、MCP-UI 与 MCP Apps、Cloudflare / Browserbase Live View、ChatGPT 双 iframe 沙箱、SO 低 FPS 问答）+ 评审结论 `external-review-2026-09-12.md` + 来源清单 `README.md` |
| `2026-09-21-zcode-docs/`（4 个 HTML） | 智谱官方 ZCode 文档快照（2026-09-21 拉取），用于 GLM 站适配的官方口径：`welcome.html` / `agents.html` / `configuration.html` / `skill.html`。`thought-level.html` 404 未取到 |

> 2026-09-16 复核：`agent-teams-reference-notes.md`（2026-09-14 新增）与 `2026-09-12-review-sources/` 此前都漏登记，本表已补齐。

抓取时间 2026-09-07。它们比 `reference/` 下的代码更重要：**模型类型/请求元数据的期望值**（`lib/metrics.js` 的 `MODEL_TYPES_BY_UI`）与**「深度思考」开关语义**这些判断，依据是这些笔记的交叉验证，而不是某个项目的代码。

## `reference/` 顶层的 PDF

`赋能 dsh-webcode-bridge：基于逆向工程的 DeepSeek 功能闭环实现蓝图.pdf`（341.8 KB）

**未能解析其内容**（本仓库没有 PDF 解析链路，本次也没有读取它）。从文件名判断它是**立项背景文件**（描述「基于逆向工程实现 DeepSeek 功能闭环」的蓝图），但**本文件不对它的章节或结论做任何断言**。若日后需要引用，请先用 PDF 工具解析后再写进这里。

注意：它**当前被 `.gitignore` 的 `reference/*.pdf` 规则排除**，**不会随 clone 出现在别的机器上**——它是 `reference/` 下唯一**没有 URL 可克隆**的资产。是否把它移到 `reference/local-refs/`（那里入库）**尚未拍板**，见 `reference/README.md` §5「待决项」第 1 行。

## 这些素材带来的教训

1. **浏览器扩展路线被放弃**。`chatgpt-gateway`（扩展 + 网关）、`chatgpt-vscode`、`Qwen-Copilot`、`zai-copilot-chat` 这类扩展形态，需要用户额外安装、受扩展商店与站点 CSP 限制、且难以与 DSH 的登录态/profile 统一。现在走的是**插件内置驱动**（`lib/browser-driver.js` + playwright-core + 系统 Edge + 持久 profile），登录一次长期有效，不需要任何扩展。
2. **「网页转 API」项目的价值在协议事实，不在代码**。`deepseek-free-api` 之类项目大多带 PoW 求解、服务端反代、token 池，与本项目「驱动本机真实浏览器」的形态不同。真正复用的是它们**记录下来的帧形状与端点路径**——这也是为什么本项目把它们标成「同构」而不是「依赖」。
3. **必须自己实现的部分**：SSE 解析（`lib/decoder.js`）、资源改写（`lib/mirror.js`）、上游抓取（`lib/upstream.js`）。这三个都没有引入第三方库，原因是要贴合各站点差异极大的帧结构，通用库反而增加一层翻译。

---

本文件是调研记录，**不是运行链路的一部分**；改动或删除本文件不影响任何行为。