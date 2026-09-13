# 验收记录

本文件按版本追加。最新在最前。

---

# 0.14.2 打包与安装记录（B/C/F 三组）

日期：2026-09-14。环境：Windows、Node v24.18.0、pnpm 11.25.0。

**范围**：0.14.1 全部内容 + B（窗口声明/预算闸/可见性）、C（会话身份/三态导航/可见性）、
F（OpenAI 前端绕过发送间隔）。**未重启**，真机矩阵仍待补。

## 产物

| 项 | 值 |
| --- | --- |
| tarball | `package/dsh-webcode-bridge/dsh-webcode-bridge-0.14.2.tgz`（208335 B） |
| 包内文件数 | 23 |
| 逐文件 SHA256 | **22/23 与工作区逐字相同** |
| 唯一差异 | `package.json` —— pnpm 打包时移除 `packageManager` 字段（逐行 diff 确认仅此一行，内容等价） |

## 真机取证（B-0 / C-0：三个新探针）

| 探针 | 问题 | 结论 |
| --- | --- | --- |
| `real-probe-23-glm-budget.mjs` | GLM 会话 id 形状 + composer 长度 | URL = `?lang=zh&cid=6aa6f08454b3a5a4e4f64a77`；**SSE 首帧 `conversation_id` 与之逐字相同**；`result.sessionId=null`（旧实现读不到）；composer 200000 字符未触顶 |
| `real-probe-24-glm-ceiling.mjs` | composer 上限（GLM / Z.ai） | GLM **1,200,000** 字符、Z.ai **1,000,000** 字符全部逐字回读、**无截断** |
| `real-probe-25-zai-url.mjs` | Z.ai 地址形状 | 只拿到裸根 `https://chat.z.ai/`（query 键为空、页面无会话链接）→ **证据不足，不声明形状** |

证据：`test-mock/out/glm-budget-*.json`、`glm-ceiling-*.json`、`zai-url-*.json`；
GLM 原始 SSE 帧：`.tmp/sse-glm-probe/sse-glm-*.log`（2177 B，`conversation_id` 出现 4 次）。

## 测试（逐文件跑）

| 项 | 结果 |
| --- | --- |
| `test/*.test.mjs`（23 个文件） | **全绿，0 失败** |
| 新增 `test/context-budget.test.mjs` | 11/11（含 3 条边界 + 4 条接线） |
| 新增 `test/glm-conversation.test.mjs` | 17/17（含真机帧解析、三态导航、zai 不猜形状） |
| `test/regression.test.mjs` | 47/47（+2：F 修复接线、B-3 可见性接线） |
| `test/control-routes.test.mjs` | 5/5（+`GET context-windows` 内容断言） |
| `test/parse.test.mjs` | 22 passed, 0 failed |
| `test/run-m1.js` | **M1 RESULT: PASS** |

## 安装结果

| profile | 已装版本 | 23 文件比对 | 备份 |
| --- | --- | --- | --- |
| `web` | 0.14.2 | **23/23 与 tarball 逐字相同** | `package.json.bak-0142` |
| `headless` | 0.14.2 | **23/23 与 tarball 逐字相同** | `package.json.bak-0142` |

## 本轮踩到的坑（重要，下次直接照做）

1. **`pnpm install` 会被无关依赖整死，并顺带删掉我们的包。** 本机 `web` profile 的
   `dsh-loopx-plugin` 指向 GitHub release tarball，安装时报
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` → `TypeError: fetch failed`，整体失败；而我们
   先 `Remove-Item node_modules/dsh-webcode-bridge` 再装，于是包被删掉却没装上
   （`node_modules/dsh-webcode-bridge` 消失）。**解法**：
   `$env:NODE_OPTIONS='--use-system-ca'`（Node 24 用系统证书库），一次通过。
   这是本机 Node 证书链与 GitHub 的兼容问题，**与本插件无关**。
   教训：清目录 + 安装这条路径在依赖坏了的时候会把「已装」变成「没装」，
   失败后必须**立刻核对 `node_modules`**，不能只看退出码。
2. **验证必须落到文件哈希**：`pnpm install` 退出码为 0 也可能装出旧内容
   （0.14.1 记录的第 2 条）。本轮改为「解包 tarball → 与工作区逐文件比 → 与安装副本
   逐文件比」，三处一致（22/23 + package.json 等价、安装副本 23/23）才算过。

## 待做（重启后）

按 `PLAN-0.14.0-HANDOFF.md` §4 的 P2-2 矩阵逐项验收，本轮重点：

1. `build.version === '0.14.2'` 且 `build.hash` 变化（旧 `ab0fdf766a5d`）。
2. **A-4b：重启后第一轮发送间隔**（放最后做）——杀进程重启后立刻发一轮，
   看 `sincePrevSendMs` 是否仍遵守设置值（基准落盘 `webcode-send-state.json`）。
3. **C 的真机复验**：GLM 连发两轮，看 `webcode-sessions-glm.json` 是否**不再是 `{}`**、
   `/status` 的 `driver.conversations` 是否出现 glm 会话、`sessionLostCount` 是否保持 0。
4. **F 的真机复验**：走 `:8931`（OpenAI 兼容路径）发一轮，`gapTargetMs` 应为设置值而非 0。
5. `GET /__webcode/context-windows` 返回各站点声明值与来源。
6. zai 会话行为确认：应如实计入 `sessionLostCount` 并显示原因，**不得**假装续聊。

---

# 0.14.1 打包与安装记录

日期：2026-09-14。环境：Windows、Node v24.18.0、pnpm 11.25.0。

**范围**：0.14.0 全部内容 + 工具协议分叉修复与标签残片拦截（即 HANDOFF §3.5 的 ZCode
补充）。**未重启**，真机矩阵仍待补。

## 产物

| 项 | 值 |
| --- | --- |
| tarball | `package/dsh-webcode-bridge/dsh-webcode-bridge-0.14.1.tgz`（197793 B） |
| 包内文件数 | 23 |
| 逐文件 SHA256 | **22/23 与工作区逐字相同** |
| 唯一差异 | `package.json` —— pnpm 打包时移除 `packageManager` 字段（逐行 diff 确认仅此一行，内容等价） |

## 测试（逐文件跑）

| 项 | 结果 |
| --- | --- |
| `test/*.test.mjs`（21 个文件） | **全绿，0 失败** |
| `test/regression.test.mjs` | 通过（含分叉两方向 + 标签残片 3 条新增断言） |
| `test/parse.test.mjs` | 22 passed, 0 failed |
| `test/tool-loop.test.mjs` | 12 passed, 0 failed |
| `test/glm-session-replay.test.mjs` | 19 passed, 0 failed |
| `test/run-m1.js` | **M1 RESULT: PASS** |

## 安装结果

两个 profile 都指向 `...dsh-webcode-bridge-0.14.1.tgz` 并重装完成：

| profile | 已装版本 | 23 文件比对 | 备份 |
| --- | --- | --- | --- |
| `web` | 0.14.1 | 22 IDENTICAL + `package.json`(去 packageManager) | `package.json.bak-0141` |
| `headless` | 0.14.1 | 22 IDENTICAL + `package.json`(去 packageManager) | `package.json.bak-0141` |

## 本轮踩到的坑（重要，下次直接照做）

1. **改了工作区文件却没重新打包**：首次 pack 之后我又改了 `package/.../README.md`，
   于是包内 README 是旧字节（哈希 `223BA654C0A3`），而工作区已是 `4E7B6EA95A33`。
   **顺序铁律：所有文件改动（含文档）必须在 pack 之前完成**；pack 之后任何改动都要重打。
2. **同版本号 + pnpm store 缓存 = 静默装旧包**。第二次 pack 后执行 `pnpm install`，
   lockfile 的 integrity 已是新 tarball 的哈希，但 store 复用了**第一次** pack 的内容，
   装出来的 README 仍是 0.14.0。`pnpm install --force` 第一次也因瞬时 lockfile 写入
   冲突以退出码 `-4048` 失败（重跑即成功）。**可靠办法是 `remove` 目录再装**：
   删掉 `node_modules/dsh-webcode-bridge` 后 `pnpm install`，已装 README 立刻变成 0.14.1。
   即 0.13.0 记录的应急办法（`plugin remove` + `add`）在文件系统层面同样有效。
3. **验证必须落到文件哈希**：只看 `pnpm install` 退出码（两次都是 0）会漏掉上面第 2 条。

## 待做（重启后）

按 `PLAN-0.14.0-HANDOFF.md` §4 的 P2-2 矩阵逐项验收，重点是：`build.version === '0.14.1'`
且 `build.hash` 变化；工具协议分叉修复的真机复验（此前高频暴露的是「流式已开块 / 解析
结果无」与「回复夹杂 `</</`」两种症状）。

---

# 0.14.0 验收记录（Phase 1：离线部分）

日期：2026-09-13。环境：Windows、Node v24.18.0、DSH `0.1.5-rc.1`、系统 Edge（已登录 profile）。

**本轮范围说明**：本记录覆盖**不依赖重启**的全部验收项。真机矩阵（重启后）单独记录在
下一节，并在完成后补齐。

## 产物

| 项 | 值 |
| --- | --- |
| tarball | `package/dsh-webcode-bridge/dsh-webcode-bridge-0.14.0.tgz`（195787 B） |
| 包内文件数 | 23 |
| 逐文件 SHA256 | **22/23 与工作区逐字相同** |
| 唯一差异 | `package.json` —— pnpm 打包时移除 `packageManager` 字段（逐行 diff 确认内容等价，非缺漏） |

哈希比对方式：解包 tarball → 对包内每个文件与工作区对应文件做 `Get-FileHash -Algorithm SHA256`
逐文件比对。**不是**只看打包命令退出码（0.13.1 的记录已证明那样会漏掉「同名同版本不同内容」）。

## 测试

| 项 | 结果 |
| --- | --- |
| `test/*.test.mjs`（21 个文件） | **全绿** |
| 新增 `test/send-gap.test.mjs` | 8/8 |
| 新增 `test/wip-settle.test.mjs` | 6/6 |
| `test/regression.test.mjs` | 42/42（含 3 条新增「接线」断言） |
| `test/model-labels.test.mjs` | 8/8 |
| `test/prompt-variants.test.mjs` | 7/7 |
| `test/client-render.test.mjs` | 6/6 |
| `test/parse.test.mjs` | 22 passed, 0 failed |
| `test/run-m1.js` | **M1 RESULT: PASS**（status 投影里已出现 `gapTargetMs`/`sincePrevSendMs`/`endReason`） |

> 注：`npm test` 的 `node --test "test/*.test.mjs"` 在本机沙箱下会 `spawn EPERM`，
> 本轮改为**逐文件** `node test/<file>.mjs` 执行。这是环境限制，不是测试失败。

## 本轮修掉的两个真机问题（离线可验证部分）

### ① 发送间隔

- 判定纯函数 `metrics.computeSendGap` 的 8 项断言覆盖：补满差额、已满足不等待、
  无基准、间隔为 0、边界差 1ms、时钟回拨、垃圾输入不抛错、返回整数毫秒。
- 接线断言（`regression`）：基准必须落盘到 `webcode-send-state.json`、必须走
  `computeSendGap`、metrics 必须带 `gapTargetMs`/`sincePrevSendMs`/`sendWaitMs`、
  旧的 turn-end 基准注释不得残留。
- **未能离线验证的部分**：真实重启后第一轮是否真的遵守间隔（需 Phase 2 真机）。

### ② 网页已回复但 Harness 卡住

- 稳态判定 `metrics.shouldSettleWip` 的 6 项断言覆盖：流停+DOM 停 → 收束；
  流还在动 → 不收束；**流停但 DOM 仍在增长 → 不收束**（安全线）；边界；页面不可采样
  的退路；窗口可调。
- 接线断言（`regression`）：`startWipWatch` 存在且必须在发送动作**之后**、
  `await done` **之前**启动；`finishActive` 必须清理巡检器；`lastEndReason` /
  `lastTimeoutScene` 必须进 `driver.status()`；适配器侧必须有 `nextWithIdle` 且
  两个消费点都走它、不得再直接 `await ch.next()`；看门狗超时必须大于 WIP 窗口。
- **未能离线验证的部分**：真实 WIP 轮次是否真的在秒级收束（需 Phase 2 真机）。

## 本轮发现并修掉的两处「空转护栏」

这两项不是 0.14.0 的功能改动，但**没有它们，0.14.0 的新面板根本测不出来**：

1. `test/client-render.test.mjs` 的 fetch mock 只提供 `json()`，而真实
   `lib/client.cjs` 走 `response.text()` + `response.headers.get('content-type')`。
   `text()` 抛错被 `.catch(() => '')` 吞掉、`headers` 为 `undefined` →
   **所有**数据路径静默失败；旧断言只看「不抛错」和「fetch 被调用过」，因此是空转的。
   已换成忠实 Response（含 `ok`/`status`/`headers.get`/`text`/`json`）。
2. 同文件的 `instantiate()` 只在元素**自身**是函数组件时才递归，而根节点是
   `<section>` → 递归当场终止，嵌套组件（`PromptSection` → `PromptPanel`）的
   `useState`/`useEffect` 从未注册，它们的请求从未发出。已改为「函数组件展开返回值
   + 普通节点递归 children」。

## 文档

| 文件 | 状态 |
| --- | --- |
| `doc/research/reference-projects.md` | 新建（31 项总表 + 10 项确证采用 + 教训） |
| `doc/security-review.md` | 扩写至约 26KB（含「与原文冲突」一节、Windows `0o600` 限定、15 条未修项） |
| `doc/long-term-issues.md` | 新建（13 条台账，每条四段式） |
| `doc/comment-style.md` | 新建（六种必写场合，全部配真实正例） |

抽查：文档中引用的代码位置经抽样复核为真（例如 `lib/index.js:1476` 确为会话槽
LRU 512 淘汰、`lib/web-control.js:78` 确为孤儿注释）。子代理报告的三条「与原文冲突」
结论（镜像仍在链路、错误文案并非全部固定、`0o600` 在 Windows 不生效）均由本人独立
复核后才写入。

---

# 0.14.0 真机验收（Phase 2）

日期：2026-09-14。环境：Windows / Edge / DSH 0.14.0（`build.hash 379dd8bbe0a3`，
重启前为 `32e693a98fc7`）。装好后**未改任何代码**先跑矩阵。

| 项 | 通过标准 | 结果 |
| --- | --- | --- |
| 版本核对 | `build.version === '0.14.0'` 且 `build.hash` 变化 | **PASS** — `version=0.14.0`、`hash=379dd8bbe0a3`（旧 `32e693a98fc7`）；`/__webcode/diagnostics` HTTP 200 / 2081 B |
| DeepSeek 未回归（无工具） | 短问正常回 | **PASS** — `POST :8931/v1/chat/completions`（`deepseek:deepseek`）1.7–2.1s 返回；正文为块数组 `[{"type":"text","text":"7"}]`，`endReason='finished'`、`recoveredTurns=0` |
| DeepSeek 未回归（带工具） | 一轮正常闭环 | **PASS（结构性证据）** — 本会话自身即走适配器带工具路径：`/status` 的 `driver.conversations` 含 `session-c7c7a03c-…`→`webSessionId 9769f585-…` 且该槽全程稳定；本轮所有工具调用均完成闭环，`recoveredTurns` 恒为 0 |
| 模型切换矩阵 | 五站各切一次，`/diagnostics` 相符；未校准站点如实报 unverified | **部分 PASS** — `GET :8931/v1/models` 列出 `deepseek:deepseek`/`glm:glm-5.3`/`glm:glm-5.3-flash`/`glm:auto`/`chatgpt:auto`… 目录正确；**逐站 GUI 切换需人工操作**（见下「待人工」） |
| 发送间隔（适配器路径） | 设 10s：`sincePrevSendMs ≥ 10000` | **PASS** — 首轮读数 `gapTargetMs=10000`、`sincePrevSendMs=3683`、`sendWaitMs=6317`，**3683+6317=10000**，即 send-to-send 语义生效；`webcode-send-state.json` 已落盘 `{"deepseek":1789317375833}` |
| 发送间隔（重启后第一轮） | 杀进程重启后第一轮也遵守 | **待测** — 需重启，按 §A-4 纪律放最后 |
| 发送间隔（OpenAI 前端路径） | 同应遵守 | **FAIL（新发现）** — `lib/openai.js:167,191` 构造 `meta` 时**没有传 `sendGapMs`**，于是 `lib/index.js:1089` 的 `clampSendGapMs(undefined)=0` → 实测 `gapTargetMs=0`、`sendWaitMs=0`。即设置页的发送间隔在 `:8931` 这条路径上被整体绕过 |
| 问题②（WIP） | 复现一轮不再卡 240s；`endReason` 与右栏提示可见 | **未触发** — 本次矩阵未复现 WIP；可见性字段已确认就位（`lastEndReason`/`lastRecovered`/`lastTimeoutScene` 均在 `/status`） |
| 控制面 | 每个按钮都有结果（非 405/静默失败）；`GET prompt-variants` 有真实 `text` | **PASS** — 19 条路由全部挂载（`DELETE` 一律 405 而非 404）；实调 `status`(200,9755B) `diagnostics`(200) `models`(200,4442B) `settings`(200) `preset`(200,379836B) `prompt-variants`(200,7137B) `login-sites`(200) `window`(200) `workspaces`(200)；`POST site-probe`(glm,`reachable:true`)/`verify-login`(`loggedIn:true`)/`window close`(`open:false`)/`sessions` 全 200 |
| `GET prompt-variants` 内容 | 有真实 `text` | **PASS** — `toolsSource=session`，两个变体均有正文：`default` 2722 字符 / `glm` 2878 字符，`active.variantId=default` |
| 右栏键盘 | tablist 方向键、动作菜单、无全白 | **待人工**（见下） |

## 待人工（需在 GUI 内操作，机器不可替代）

1. **模型切换五站**：依次切 `deepseek:deepseek` / `glm:glm-5.3` / `zai:glm-5.3` / `kimi:k3` /
   `doubao:chat`，每切一次记 `http://127.0.0.1:3080/__webcode/diagnostics` 的 `selectedModel`
   与 `requestMetadata`；无 `modelPicker` 契约的站点**应如实显示 unverified**，不得记成成功。
2. **右栏键盘**：tablist 上按 ←/→/Home/End 是否切换、动作菜单（刷新/独立窗口）是否弹出、
   整页是否无全白。
3. **WIP 复现**：跑一轮会触发 `status:'WIP'` 的长回复，看是否秒级收束而非卡到 240s，
   以及右栏是否出现「网页流未收尾但内容已保住 N 次」。

## 本次矩阵附带发现（已定位，未修）

- **OpenAI 前端绕过发送间隔**：`lib/openai.js:167` 与 `:191` 的 `meta` 缺 `sendGapMs`，
  两条分支（流式/非流式）都中。修法是把设置里的 `sendGapMs` 注入该 `meta`（与
  `buildTurn` 的 `lib/index.js:1455` 同源）。
- **OpenAI 前端不支持工具调用**：`lib/openai.js` 无 `tool_calls` 相关代码，
  因此带工具的端到端回归只能走 DSH 适配器路径（本次以本会话自身为证）。

---

# 0.4.1 验收记录

日期：2026-09-06。环境：Windows、Edge、DSH 0.1.1-rc.2、本机已有登录 profile。未使用 API 密钥，也未切换供应商配置。

最终 0.4.1 tgz 已生成并同步安装，profile 依赖已指向 0.4.1，运行源码哈希匹配；重启后 Flash 算术返回 9，并再次通过原审查会话续聊及 reload 检查。实际用时超过最初半小时限制，保留这一限制未达成的事实。

## 真实任务

输入：实际调用本地只读工具，读取 `D:/9_Code_Workspace/dsh-webcode-bridge/package/dsh-webcode-bridge/lib/providers.js`，列出三模型并审查，不修改文件。

首次成功会话 `session-0f3bb674-e208-4db4-b506-f61c4f7bd4bf`：

- `tool/call` seq 19：`str_replace_editor`，`command=view`，路径为目标绝对路径。
- `tool/result` seq 20：`isError=false`，内容含实际文件 19 行以及三模型配置。
- 后续 assistant 回答列出 flash、vision、deepseek，结束标记 `HARNESS_REVIEW_OK`。
- 浏览器关闭重开后仍显示输入、工具行及结果。续问获得三个 id 和 `PERSISTENCE_OK`，再次 reload 仍在。
- 日志位于 `~/.dsh/sessions/--D-9_Code_Workspace-dsh-webcode-bridge--/<sessionId>/session.jsonl.zstd`，采用多个 zstd frame，需逐帧读取。

流式修复后会话 `session-e21502a4-4700-42a2-a92b-dffdaf89d1d9` 再次运行同一绝对路径任务：1 轮 2 步完成，原生约 68 tok/s，替代旧缓冲实现的 43250 tok/s；控制面报告 outputTokens=215（估算）、durationMs=4815、firstTokenMs=1217、tps=44.7（含等待时间）。不同采样会变化。

模型实际请求：Flash `default`、DeepSeek `expert`、Vision `vision`；三者 `search_enabled=false`。Vision 文本算术返回 15。专家模式的一次英文标记请求被模型拒答，模型切换已成功，但不把该次拒答计为内容验收通过。

## 自动化

`pnpm test`：7 项回归、8 项解析、M1 契约全通过。`node test-mock/run-m2b-driver.js` 和 `node test-mock/run-m2c-webapi.js` 通过。

Playwright 脚本 `package/dsh-webcode-bridge/test-mock/inspect-harness.mjs` 支持 `task`、`resume`、`settings`、`panel`、`mobile`。截图在包内 `output/playwright/`：原生设置含网页桥接，右侧复用现有侧栏，390x844 下预览图片正常加载。`PREVIEW_IMAGE_PASS`、`RIGHT_PANEL_COLLAPSE_PASS`、`PERSISTENCE_RELOAD_PASS` 均实际出现。

## 失败尝试及限制

此前模型只输出 `Calling:` 文本，未执行工具；增加严格实际输出格式解析后恢复。相对路径任务曾因极简预设缺少工作目录而读取失败，模型收到真实错误后纠正；正式验收使用绝对路径。

模拟站点曾因缺少模型选择器失败，补充原生 select 后通过。测试结果不代表其他网站、图片上传或旧网页导入 API 已完成。模型自行提出的别名风险属于模型审查输出，不作为本项目代码缺陷的独立证据。