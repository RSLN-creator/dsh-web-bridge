# `reference/` —— 第三方逆向参考仓库（**故意不入库**）

> **如果你是克隆本仓库的人：这个目录在你机器上几乎会是空的，这是设计如此，不是克隆失败。**
> 只有 `local-refs/` 被跟踪；其余每个条目都是一个**独立的 `git clone`**，
> 由 `.gitignore` 排除在本仓库之外（`.gitignore:9` `reference/*/`）。
> 下文的「来源与版本」表给出每个条目的 remote 与 HEAD——**按它就能把目录原样拿回来**。

## 1. 这个目录是什么

第三方**逆向工程参考实现**：把已登录的网页 AI 接成 OpenAI 兼容 API 的项目、
浏览器自动化与 CDP 工具、SSE 解析器、以及别的 DSH 插件。它们的作用是**证据与对照**——
本项目若干站点的解码器与请求契约是照着它们的实现对齐的（见
[`doc/research/reference-projects.md`](../doc/research/reference-projects.md)）。

**它不在运行链路里。** 审查或改代码时可以整个跳过
（`CONTRIBUTING.md` §〔入口表〕、`doc/review-guide.md`）。实测插件源码对
`reference/` 的引用**只有注释**，没有一行运行时依赖。

## 2. 约定

| | |
| --- | --- |
| 每个条目 | 一个**纯 `git clone`**（带自己的 `.git`） |
| 是否入库 | **不入库** —— `.gitignore:9` `reference/*/` 排除 |
| 唯一例外 | `reference/local-refs/`（`.gitignore:10` 显式重新打开）：**本项目自己的笔记**，入库 |
| PDF | `.gitignore:13` `reference/*.pdf` 排除（见 §5 的待决项） |
| 为什么 | 本机 `reference/` 实测 **978.9 MB** 第三方代码（含 `deepseek-harness` 349.3 MB、`qwen-code` 255.7 MB），不该进本仓库历史 |

> **陷阱**：`git add -f reference/<某个 clone>` 会**绕过** gitignore 把它提交进去。
> 不要这么做——需要引用某段实现时，把结论写进 `local-refs/`，而不是把那棵代码树搬进来。

## 3. 克隆者看到什么

```
reference/
├── README.md          ← 本文件（入库）
└── local-refs/        ← 入库：本项目自己的笔记（7 份 md + 2026-09-12-review-sources/ 11 文件）
```

其余 37 个第三方 clone **不会出现**。要拿回来，按 §4 的表执行。

## 4. 来源与版本（**本表由脚本生成，不要手改**）

重新生成 / 校验：

```powershell
node scripts\gen-reference-index.mjs            # 打印本表
node scripts\gen-reference-index.mjs --check    # 与本节比对，不一致退 1
node scripts\gen-reference-index.mjs --missing  # 只列「不是 clone」的条目
```

`⚠️镜像` 表示该 remote 前面挂了 `ghfast.top` 加速前缀（本机网络环境所致），
**它不是上游作者的真实地址**——换成直连时要去掉该前缀。

| 目录 | remote | HEAD | 大小 |
| --- | --- | --- | --- |
| `agent-browser` | https://github.com/vercel-labs/agent-browser.git | `8c15ff9f71ae60c7e99e66afe1e2d4b9bf414fe2` | 11.9 MB |
| `agent-team` | **不是 clone**（见 §6「约定违例」） | — | 0.4 MB |
| `agentdock` | https://github.com/uvwt/agentdock | `84abde28b7e331fd15fce0a44421104f7fbf9dc7` | 10.3 MB |
| `AIstudioProxyAPI` | https://github.com/CJackHwang/AIstudioProxyAPI.git | `044c3db48e956097d4c509c87ebf0ecadb4e79e2` | 7.5 MB |
| `browser-ai-bridge` | https://github.com/jeffrey-nz/browser-ai-bridge.git | `2ea7654796aee688d2be049f338d636922e82bbe` | 3.2 MB |
| `chatgpt-gateway` | https://github.com/Draivix/chatgpt-gateway.git | `e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31` | 0.3 MB |
| `chatgpt-vscode` | https://ghfast.top/https://github.com/mpociot/chatgpt-vscode.git ⚠️镜像 | `4cae69732fbb0f7e3a80be3592829ab771b6ba9d` | 2.5 MB |
| `chatgpt2api-NoReverse` | https://ghfast.top/https://github.com/pinatsu/chatgpt2api-NoReverse.git ⚠️镜像 | `fe967830da52e71c313480f6087a47587a8b683d` | 0.2 MB |
| `claude-code-reverse` | https://ghfast.top/https://github.com/ghboke/claude-code-reverse.git ⚠️镜像 | `570324dac73ef43bdcd36660188f3cb66524e572` | 95.3 MB |
| `cursor-2api` | https://github.com/lza6/cursor-2api.git | `70c6af8b74eea1683f02462a90d458781eccc18d` | 0.1 MB |
| `deepseek-free-api` | https://ghfast.top/https://github.com/Httyhu1314/deepseek-free-api.git ⚠️镜像 | `989c7a9049f8083d8763d4af0ce7869132c245f9` | 0.5 MB |
| `deepseek-harness` | https://github.com/deepseek-ai/deepseek-harness.git | `00102833dfaee1da9f48a3a8eae9d34005a75218` | 349.3 MB |
| `deepseek-reverse-api` | https://github.com/Wu-jiyan/deepseek-reverse-api.git | `1ffacb796e545393615c4b7db0467befcf22bc42` | 1.4 MB |
| `deepseek-web-api` | https://github.com/kittors/deepseek-web-api.git | `9b62d6a17ba502fa6aefa2dceb527d1e925aa6ce` | 0.5 MB |
| `deepseek-web-import` | https://github.com/wpc0323/deepseek-web-import | `8780b8c80addf9f6519a02106f6a28d2ebaedb99` | 0.1 MB |
| `doubao2api` | https://ghfast.top/https://github.com/wangchuxiaoji-oss/doubao2api.git ⚠️镜像 | `95beb0788338ba268e13ca4c80890ceeae6ff055` | 49.8 MB |
| `dsh-archive-manager` | **不是 clone**（见 §6「约定违例」） | — | 0.5 MB |
| `dsh-compass` | https://github.com/Happy2Git/dsh-compass.git | `2676d15afb2b9d5a4a62715ea4c83fa7619081e0` | 2.2 MB |
| `dsh-deepseek-chat` | https://github.com/zerorigin-studio/dsh-deepseek-chat | `5ed9d07b732ac997d0c3afbc15e7b2e46bb15bee` | 0.1 MB |
| `dsh-drop-caret` | **不是 clone**（见 §6「约定违例」） | — | 0 MB |
| `dsh-file-attachment` | https://ghfast.top/https://github.com/wszhoho/dsh-file-attachment.git ⚠️镜像 | `de4456a06883544fef7bc57a195c369036b02a4e` | 1.9 MB |
| `dsh-flowglass` | https://github.com/Iwctwbh/dsh-flowglass.git | `a815bc7ee14a15008358e1c0a49aa0e6757377e4` | 3.4 MB |
| `dsh-market` | **不是 clone**（见 §6「约定违例」） | — | 2 MB |
| `dsh-official-plugins` | **不是 clone**（见 §6「约定违例」） | — | 0.4 MB |
| `dsh-session-graph` | https://github.com/benz-ai-x/dsh-session-graph.git | `d999061007dc3465c997fcaddbe2ab31cb8ecb2d` | 39.5 MB |
| `dsh-task-board` | **不是 clone**（见 §6「约定违例」） | — | 1.5 MB |
| `dsh-task-graph` | https://github.com/KevinZhangNothing/dsh-task-graph.git | `7c230e0fe0af8103cfc2d1ee6ecf74a4f0c872aa` | 14.3 MB |
| `eventsource-parser` | https://github.com/rexxars/eventsource-parser.git | `6519a0f70dfeb22f829e5c696da2cb4988d64c6a` | 0.7 MB |
| `glm-free-api` | https://github.com/RapidAI/glm-free-api.git | `3237198289d8c672cbac065bec4d6dceca62deae` | 5.6 MB |
| `kimi-code` | https://ghfast.top/https://github.com/MoonshotAI/kimi-code.git ⚠️镜像 | `f12d59e089e2531a33fbca30b26ffeabd5862b45` | 93.1 MB |
| `Kimi-Free-API` | https://ghfast.top/https://github.com/xiaoY233/Kimi-Free-API.git ⚠️镜像 | `04fe21fee63c843caedff12a2b6e6b07a7a844a6` | 3.6 MB |
| `LLMs2API` | https://github.com/Kirazul/LLMs2API.git | `cc0e1b4d0bf7d1c426567bf9bb860afa46ef7287` | 0.3 MB |
| `local-refs` | **不是 clone**（见 §6「约定违例」） | — | 2 MB |
| `node-http-proxy` | https://github.com/http-party/node-http-proxy.git | `9b96cd725127a024dabebec6c7ea8c807272223d` | 0.7 MB |
| `openai-stream-parser` | https://github.com/jy02140251/openai-stream-parser.git | `3f4ee58d4310de93b02182fee84e775cc2c51367` | 0 MB |
| `opencode2dsh` | https://github.com/FishBottle7/opencode2dsh.git | `dd8d0b1f06c55723928e535c853d20a4100bd970` | 1.2 MB |
| `qwen-code` | https://ghfast.top/https://github.com/QwenLM/qwen-code.git ⚠️镜像 | `1ac097163389b7b85b21bf74c396052fc2fcc59f` | 255.7 MB |
| `Qwen-Copilot` | https://ghfast.top/https://github.com/zelosleone/Qwen-Copilot.git ⚠️镜像 | `6e33880263d5946c496d8385de7ec3451ec5687f` | 0.5 MB |
| `qwen-free-api` | https://ghfast.top/https://github.com/LNpks/qwen-free-api.git ⚠️镜像 | `bf42bce60f2b1eea3801f9f6f3277ebf64226816` | 3.8 MB |
| `steel-browser-npm` | **不是 clone**（见 §6「约定违例」） | — | 0 MB |
| `wabac.js` | https://github.com/webrecorder/wabac.js.git | `281e9bc7affba4ce520301b10723b01f661aa7e5` | 2.8 MB |
| `web-login` | **不是 clone**（npm 包解包，见 `local-refs/web-login-notes.md`）：`dsh-login@0.1.1` / `@islibaodong/dsh-login@0.2.1` / `dsh-auth-gate@0.13.0` | — | 1.4 MB |
| `WebBridge` | https://github.com/kxdds/WebBridge.git | `0256c4590846e4e5d67bbe50283df8c2f18dd229` | 0.4 MB |
| `WebChat2Api` | https://github.com/MOSSVENC/WebChat2Api.git | `57fc2c2e6840c1f68d3e81adb8fc00250feca279` | 0.3 MB |
| `webcode` | https://github.com/three-water666/webcode.git | `2f32151bc021204575e726578813f83a4c1e117c` | 6.5 MB |
| `zai-copilot-chat` | https://github.com/ltmoerdani/zai-copilot-chat.git | `d56b81ef2911b864677b476e2bc5b27f041133f1` | 1.2 MB |
### 怎么把某个条目拿回来

```powershell
# 以 glm-free-api 为例（镜像地址要先去掉 ghfast.top/ 前缀）
git clone https://github.com/RapidAI/glm-free-api.git reference/glm-free-api
git -C reference/glm-free-api checkout 3237198289d8c672cbac065bec4d6dceca62deae
```

表里的 SHA 是**当时取证的那个版本**——本项目引用它的结论是基于该版本的。
重新克隆后若 SHA 不同，`lib/decoder.js` 等处的注释引用可能已经对不上，需要复核。

## 5. 待决项（**需要人拍板，尚未执行**）

| 项 | 现状 | 选项 |
| --- | --- | --- |
| `reference/赋能 dsh-webcode-bridge：…蓝图.pdf`（341.8 KB） | 是**本项目的立项蓝图**，但被 `.gitignore:13` 排除，**换机器就没了**；且它是本目录唯一**不可从 remote 复现**的资产（没有 URL 可克隆） | ① 移到 `reference/local-refs/`（那里入库，能活过克隆）；② 不入库，改为在文档里记 sha256 + 外部位置。**倾向 ①**，代价是 git 历史里多一个 342 KB 二进制 |
| `steel-browser-npm/` | **空目录**（0 文件），是个中断的克隆 | 删掉，或重新克隆 |
| `agent-team/` | **没有 `.git`**，是 3 个 DSH 官方实验包的手工拷贝（`service/package.json` 显示 `@deepseek-ai/dsh-experimental-agent-team@0.1.5-rc.1`） | 重新按上游 URL 克隆（拿到 URL 后补进 §4 表），或在旁加一份来源说明 |
| 体积 | 本机实测 **978.9 MB**（46 个条目）；9 个目录 ≥10 MB（`deepseek-harness` 349.3、`qwen-code` 255.7、`claude-code-reverse` 95.3、`kimi-code` 93.1、`doubao2api` 49.8、`dsh-session-graph` 39.5、`dsh-task-graph` 14.3、`agent-browser` 11.9、`agentdock` 10.3） | 可选：`--depth 1` 重新克隆，或删内层 `.git`（**会丢掉 §4 的取证能力**，不推荐） |

## 6. 约定违例（`--missing` 会列出）

跑 `node scripts\gen-reference-index.mjs --missing`：

- `local-refs` —— **故意**不是 clone（它是本项目自己的笔记，入库）。**不是违例**。
- `agent-team`、`steel-browser-npm` —— 见 §5，确实需要处理。
- `dsh-task-board`、`dsh-archive-manager`（2026-09-17 新增） —— 与 `agent-team` 同级：**不是 clone**，
  而是从 npm 取源的**已发布包解包**（`npm pack` 后 `tar -xzf --strip-components=1`）。
  入库理由与 `agent-team` 相同：它们是**本机曾安装、现已卸载**的第三方 DSH 插件，
  留档是为了让后续审查能对照它们的插槽注册方式与 UI 写法。

  | 目录 | 来源包 | 版本 | 解包日期 |
  | --- | --- | --- | --- |
  | `dsh-task-board` | `@linxin666/dsh-client-ui-task-board` | 0.3.23 | 2026-09-17 |
  | `dsh-archive-manager` | `@chushiz/dsh-archive-manager` | 0.5.0 | 2026-09-17 |

  重新取回（**本机已从 web profile 卸载**，不要在运行链路里引用它们）：

  ```powershell
  npm pack @linxin666/dsh-client-ui-task-board@0.3.23   # → linxin666-…-0.3.23.tgz
  tar -xzf linxin666-dsh-client-ui-task-board-0.3.23.tgz -C reference/dsh-task-board --strip-components=1
  ```

  这两个包**没有上游 git 仓库可克隆**（npm 上的发布物就是唯一来源），
  因此 §4 的表里没有它们——§4 只登记可从 remote 复现的 clone。

  `dsh-file-attachment` 属于第三类：它有上游 git 仓库，因此**照常登记在 §4**
  （`https://ghfast.top/https://github.com/wszhoho/dsh-file-attachment.git`）。

  `dsh-official-plugins`（2026-09-23 新增）属于第二类：**官方独立包 ⚠️ 解包原样留档**
  —— 12 个 `@deepseek-ai/*` npm 包的原样 `.tgz`（**未解包展开**，便于与官方发布物逐字节对照）。
  它是本项目的 **0.19.0 能力边界参考基线**（Chromium 持久登录 / 任务板·并行界面 UI 对齐 harness），
  所以不在 `local-refs/`（那里只存本项目笔记），而独立成目录。来源与版本见
  `reference/local-refs/2026-09-23-dsh-official-plugins-and-boundaries.md`；
  monorepo 源码形态（更权威，已 `git pull` 到 master 最新 0.1.7-alpha.2）在
  `reference/deepseek-harness/packages/**`。

  `dsh-market`（1.47.0 解包）、`dsh-drop-caret`（0.2.3 解包）与 `dsh-official-plugins` 同属这一类。

  也就是说 §6 的违例清单（`--missing` 实测 9 条，去掉故意不算的 `local-refs` 是 **8 条**）：
  `agent-team`、`dsh-archive-manager`、`dsh-drop-caret`、`dsh-market`、`dsh-official-plugins`、
  `dsh-task-board`、`steel-browser-npm`、`web-login`（`web-login` 是 npm 解包，表里已带注记）。
  §4 的表 46 行里 **37 行是可复现的 clone**，其余 9 行是上述非 clone 条目。

## 7. 权威清单在哪

- **本文件**：`reference/` 的约定 + 来源与版本（机器生成，与磁盘一致性可用 `--check` 验证）。
- [`doc/research/reference-projects.md`](../doc/research/reference-projects.md)：
  **每个仓库的用途与「本项目采用了什么」**——那才是决策记录。
  本文件只回答「它是什么、从哪来、哪一版」，两者不重复。

> 历史提醒：那份用途清单曾经落后于磁盘（少登记 4 个 `dsh-*` 仓库，且计数自相矛盾）。
> 已于 2026-09-16 补齐并改为可核对的口径——**加入新参考仓库时，两处都要更新**：
> 本文件的表（跑生成脚本即可）与那份用途清单（手写）。
