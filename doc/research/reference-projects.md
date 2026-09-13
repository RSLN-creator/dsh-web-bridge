# 参考项目清单（`reference/` 调研素材）

本文件记录 `reference/` 目录下 31 个第三方项目的来源、与本仓库的关系，以及**哪些被真正采用过**。

`reference/` 是**只读调研素材**，不在运行链路里：`doc/review-guide.md` 已明确写着「`extension/`、`reference/`、`doc/` 都不是运行链路，审查时可以直接跳过」。删除整个 `reference/` 不影响任何行为。

> **本文件的取证口径**：每一条「用了哪一点」都来自**本仓库源码自己的出处标注**（形如「（glm-free-api 同构）」）或 `reference/local-refs/` 下的调研笔记。凡是源码里没有引用、笔记里也没有记录的项目，一律标「仅作背景素材，未直接采用」——**不做推测性归因**。
>
> 抓取/整理时间：2026-09-07（见 `reference/local-refs/` 各笔记的抓取时间戳）；本文件复核时间：2026-09-13（0.14.0）。

## 总表

| 项目 | 是什么 | 我们用了哪一点 | 仍在运行链路 |
| --- | --- | --- | --- |
| `agent-browser` | Vercel Labs 的浏览器自动化 CLI（Rust，给 AI agent 用） | 未直接采用（同类思路：浏览器自动化作为 agent 能力） | 否 |
| `agentdock` | 同名多项目：并行 agent 汇诊台 / 独立工具运行时 / provider 无关 Agent 框架 | 「provider 无关适配器」的思路启发了站点契约分层 | 否 |
| `AIstudioProxyAPI` | 用 Camoufox + Playwright 把 Google AI Studio 网页转成 OpenAI 兼容 API | 未直接采用（同类路线佐证） | 否 |
| `browser-ai-bridge` | 本地 REST 服务，用 Playwright/CDP 驱动真实浏览器会话操作 AI 网页 | 未直接采用（同类路线佐证） | 否 |
| `chatgpt-gateway` | 浏览器扩展 + Camoufox 网关，免手动标签页访问 ChatGPT Pro | 未直接采用 | 否 |
| `chatgpt-vscode` | VS Code 里的 ChatGPT 扩展（走非官方 API） | 未直接采用 | 否 |
| `chatgpt2api-NoReverse` | ChatGPT 网页转 API 的小玩具项目（作者自称 vibe-coded toy） | 未直接采用 | 否 |
| `claude-code-reverse` | Claude Code 源码 map 逆向分析报告 | 未直接采用 | 否 |
| `cursor-2api` | 把 Cursor 网页版转成 OpenAI 标准 API | 未直接采用 | 否 |
| `deepseek-free-api` | DeepSeek 网页反向代理（Python/FastAPI，含 PoW 求解） | DSML 标记剥离的写法参考（`strip_dsml_markup`） | 否 |
| `deepseek-reverse-api` | DeepSeek 网页版 OpenAI 兼容 API（Python/Flask） | 未直接采用 | 否 |
| `deepseek-web-api` | Node.js 实现的 DeepSeek 网页 API（CI + 测试较完整） | 未直接采用（协议事实由 `local-refs` 笔记交叉验证） | 否 |
| `deepseek-web-import` | **DSH 插件**：把 chat.deepseek.com 历史对话导入 DSH 正式会话 | 两条：同源挂载模式；控制面安全立场（被我们「收紧后」沿用） | 否（同类插件，非依赖） |
| `dsh-deepseek-chat` | **DSH 插件**：侧栏加「网页对话」按钮打开 chat.deepseek.com | 未直接采用 | 否 |
| `eventsource-parser` | 通用 SSE 流解析库（无传输假设） | **源码中无任何引用**，未直接采用 | 否 |
| `glm-free-api` | GLM（chatglm.cn）免费 API 反向代理 | **实际采用**：GLM 流帧形状与「同构」判断 | 否 |
| `kimi-code` | Moonshot 官方 Kimi Code CLI | 未直接采用 | 否 |
| `Kimi-Free-API` | Kimi 免费 API 反向代理 | **实际采用**：Kimi 流帧形状 + 真实流端点路径 | 否 |
| `LLMs2API` | 多站点（chatgpt/claude/deepseek/gemini/qwen）转 API | **实际采用**：Qwen 的 JSON-patch 结构帧形状 | 否 |
| `local-refs` | **本项目自己的调研笔记存档**（5 份 md） | 协议事实交叉验证（DeepSeek 逆向/V4 事实、expert 模式、2api） | 否（是笔记，不是项目） |
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

统计：31 项中 **7 项**有源码级出处标注（`glm-free-api`、`Kimi-Free-API`、`LLMs2API`、`qwen-free-api`、`deepseek-free-api`、`opencode2dsh`、`zai-copilot-chat`），另加 `agentdock`/`deepseek-web-import`/`webcode` 各 1 条明确引用，共 **10 项**可确证被参考过。其余 21 项为背景素材。

## 逐条：确实被采用的项目

### `glm-free-api` → GLM 解码器

本仓库 `lib/decoder.js` 的 GLM 解码器直接标注了帧形状来源：

- `lib/decoder.js:10`：「`{conversation_id, status, parts:[{content:[{status, type:'text'|'image'|'code'|'quote_result', ...}]}]}`（glm-free-api 同构）」
- `lib/decoder.js:490`：「真实帧（glm-free-api 同构，标准 SSE）」
- `lib/decoder.js:558`：增量语义也照它（「与已发内容无前缀关系 = 新片段」）

采用点：chatglm.cn 的 SSE 帧结构与增量语义。**不是**代码依赖——本项目自己实现解码，只是用它作为帧形状的对照。

### `Kimi-Free-API` → Kimi 解码器 + 流端点

- `lib/decoder.js:12`：`cmpl` 才取正文、`all_done`/`error` 收尾（「Kimi-Free-API 同构」）
- `lib/decoder.js:575`：`{event:'cmpl', text}` / `{event:'req', id}` 帧形状
- `lib/providers.js:122`：真实流端点带动态会话 id `/api/chat/{id}/completion/stream`，因此选择器用**子串匹配**

采用点：Kimi 的流事件形状与「端点带动态 id」这一事实（后者直接决定了选择器写法）。

### `LLMs2API` → Qwen 结构帧

- `lib/decoder.js:14`：`{message:{content:{parts}}}` 结构帧（「LLMs2API 同构」）
- `lib/decoder.js:15`：它实测出「qwen 浏览器端是 OpenAI 兼容 SSE」
- `lib/decoder.js:416`：JSON-patch 帧 `{o:'append', p:'/message/content/parts/0', v:'文本'}`

采用点：Qwen 的两种帧形态（结构帧 + JSON-patch 帧）。这条最有价值——单看网络流很难猜出 JSON-patch 这种形态。

### `qwen-free-api` → Qwen 直连兜底

- `lib/decoder.js:329`：「Qwen 直连兜底（qwen-free-api 同构）：`{sessionId, msgId, contentType, msgStatus, contents:[...]}`」

### `deepseek-free-api` → DSML 标记剥离的写法

- `lib/agent-preset.js:419`：「`reference/deepseek-free-api` 的 `strip_dsml_markup` 用 ……」

采用点：DeepSeek 网页偶发产出全角/变体标记（`｜`U+FF5C、丢开头的 `<`）时的清理思路。这是**唯一一条直接点名函数名**的采用记录。

### `agentdock` → 站点契约分层

- `lib/providers.js:3`：「受 AgentDock（github.com/agentdock/agentdock）"provider 无关适配器"启发：……」

采用点：把「provider 无关」做成显式的站点契约（`lib/providers.js` + `lib/contract.js`），而不是把各站点差异散进驱动代码。`reference/local-refs/agentdock-reference-notes.md` 还记录了另两条落点：并行 agent 会话按 `sessionId::agentId` 隔离（本仓库确实如此，见 `lib/index.js` 的 `keyPath`）、工具执行交给 Harness 原生而非网页模拟。

### `deepseek-web-import` → 同源挂载 + 控制面安全立场

- `lib/index.js:1482`：「same pattern deepseek-web-import uses」（同源挂载，无 CORS）
- `lib/web-control.js:9`：「Security posture (mirrors deepseek-web-import's, **tightened**)」

采用点：把控制面挂在宿主 web server 的同源路径上（`/__webcode/*`），而不是另起跨域服务；安全立场沿用并收紧（本项目额外加了 Host 回环族校验与 `Sec-Fetch-Site` 拒绝，见 `doc/security-review.md`）。

### `opencode2dsh` → adapter 注册形状

- `lib/index.js:415`：「Pure adapter registration (the shape opencode2dsh's adapter mode uses)」

采用点：**只**注册 adapter，不额外调用 `registerConfigurableProviders`——本仓库注释里写明：两处都声明会让 GUI 把 provider 当成「需要 endpoint 配置」的 provider，模型反而不出现在主选择器里。

### `zai-copilot-chat` → GLM-5.3 强制思考

- `lib/index.js:775`：「GLM-5.3 强制思考（reference/zai-copilot-chat 的 dialect 佐证：5.3 起思考不可关）」

采用点：GLM-5.3 会把工具调用写进**思考流**而不是正文。这条佐证促成了「正文解析不到调用时，从思考全文兜底解析一次」的实现（并明确限制：正文已有可用调用时不看思考，避免把预演草稿当真）。

### `webcode` → 用独立窗口而非 iframe

- `lib/browser-driver.js:1672`：「（DeepSeek 等站点 CSP 拒绝 iframe，参考 webcode 也用独立窗口承载）」

采用点：承载站点页面的方式选择。这条直接影响右栏与登录链路的设计（`windowOpener` / 有头 Edge 窗口）。

> 备注：`reference/webcode` 的目录名与本插件的命名（`webcode-bridge`、`/__webcode/*`、`window.__webcodeCaptureInstalled`）**同名不同物**。全仓库 grep `webcode` 有数百处命中，其中绝大多数是插件自身命名，**只有上面这一处**是对该参考项目的引用。本文件不把同名命中当作采用证据。

### 背景素材（未直接采用，但有间接影响）

- `AIstudioProxyAPI`、`browser-ai-bridge`、`WebBridge`、`chatgpt-gateway`：都走「Playwright/Camoufox 驱动真实浏览器 + 持久登录 profile」这条路。它们佐证了**这条路可行**，但没有代码或协议被采用。当时被否掉的是**浏览器扩展**路线（见下节），而这些项目多是独立进程/扩展两种形态混杂。
- `deepseek-web-api`、`deepseek-reverse-api`、`WebChat2Api`、`chatgpt2api-NoReverse`、`cursor-2api`：DeepSeek 及其他站点「网页转 API」的同题项目。协议事实以 `reference/local-refs/` 的交叉验证笔记为准（见下节），未从这些代码取用。
- `wabac.js`、`node-http-proxy`：镜像/反代相关。本仓库的镜像（`lib/mirror.js`）与上游抓取（`lib/upstream.js`）都是自研，**未引入**这两个依赖。
- `eventsource-parser`、`openai-stream-parser`：SSE 解析库。**源码中零引用**——本项目 `lib/decoder.js` 自己解析 SSE。曾作为「通用 SSE 解析应该长什么样」的对照，但没有任何引用点，因此不能算采用。
- `agent-browser`、`claude-code-reverse`、`kimi-code`、`Qwen-Copilot`、`chatgpt-vscode`、`dsh-deepseek-chat`：浏览/了解，未见任何采用痕迹。
- `steel-browser-npm`：**目录为空**（无 README、无 package.json），无法判断内容。

## `reference/local-refs/` —— 真正的事实来源

这个目录是**本项目自己的调研笔记**（不是第三方项目），5 份文件：

| 文件 | 内容 |
| --- | --- |
| `deepseek-web-逆向与V4事实-cross-verified.md` | DeepSeek 网页协议与 V4 事实的交叉验证 |
| `deepseek-expert-mode-reverse-engineering.md` | 「专家模式」的逆向分析 |
| `deepseek-2api-README.md` | DeepSeek 转 API 路线摘录 |
| `deepseek-free-api-README.md` | 上述反代项目的能力摘录 |
| `agentdock-reference-notes.md` | AgentDock 三个同名项目的关联度整理与落点 |

抓取时间 2026-09-07。它们比 `reference/` 下的代码更重要：**模型类型/请求元数据的期望值**（`lib/metrics.js` 的 `MODEL_TYPES_BY_UI`）与**「深度思考」开关语义**这些判断，依据是这些笔记的交叉验证，而不是某个项目的代码。

## `reference/` 顶层的 PDF

`赋能 dsh-webcode-bridge：基于逆向工程的 DeepSeek 功能闭环实现蓝图.pdf`

**未能解析其内容**（本仓库没有 PDF 解析链路，本次也没有读取它）。从文件名判断它是**立项背景文件**（描述「基于逆向工程实现 DeepSeek 功能闭环」的蓝图），但**本文件不对它的章节或结论做任何断言**。若日后需要引用，请先用 PDF 工具解析后再写进这里。

## 这些素材带来的教训

1. **浏览器扩展路线被放弃**。`chatgpt-gateway`（扩展 + 网关）、`chatgpt-vscode`、`Qwen-Copilot`、`zai-copilot-chat` 这类扩展形态，需要用户额外安装、受扩展商店与站点 CSP 限制、且难以与 DSH 的登录态/profile 统一。现在走的是**插件内置驱动**（`lib/browser-driver.js` + playwright-core + 系统 Edge + 持久 profile），登录一次长期有效，不需要任何扩展。
2. **「网页转 API」项目的价值在协议事实，不在代码**。`deepseek-free-api` 之类项目大多带 PoW 求解、服务端反代、token 池，与本项目「驱动本机真实浏览器」的形态不同。真正复用的是它们**记录下来的帧形状与端点路径**——这也是为什么本项目把它们标成「同构」而不是「依赖」。
3. **必须自己实现的部分**：SSE 解析（`lib/decoder.js`）、资源改写（`lib/mirror.js`）、上游抓取（`lib/upstream.js`）。这三个都没有引入第三方库，原因是要贴合各站点差异极大的帧结构，通用库反而增加一层翻译。

---

本文件是调研记录，**不是运行链路的一部分**；改动或删除本文件不影响任何行为。