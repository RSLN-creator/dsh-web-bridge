# 会话日志归因（2026-09-14）

本文件回答一个问题：**最近两次 harness 会话里，哪些问题已经解决、哪些还没有、每一条的证据在哪。**

它不是叙事复盘（那是 `incident-2026-09-11.md` 的职责），而是**可复核的归因台账**：每条结论都附一条可直接粘贴的复现命令。

工具：`test-mock/parse-session-log.mjs`（0.14.5 新增，见 `doc/README.md`）。

```powershell
cd package\dsh-webcode-bridge
node test-mock/parse-session-log.mjs --recent 3 --errors-only
```

---

## 1. 会话清单

| 会话 | 事件 | 解出字符 | zstd 帧 | tool-call | 结局 |
| --- | --- | --- | --- | --- | --- |
| `session-c710ef6e` | 1020 | 5,819,954 | 569 | 272 | turn 1 ✔ / **turn 2 ✖ error** |
| `session-e02c4195` | 37 | 179,828 | 17 | 4 | turn 1 ✔（无产出） |
| `session-698700ea` | 本次 | — | — | — | 进行中 |

**`session-e02c4195` 的性质**：与 `c710ef6e` 同一句用户输入、只有 4 步就 `completed`，无任何交付。它是同一请求的重开副本，**不含独立结论**——不必从中找证据（本报告已核对：其失败项为空、无 tool/result isError）。

---

## 2. 已解决（有证据链）

| 项 | 证据 |
| --- | --- |
| 7 个本地提交已推送 | `git fetch` 后 `origin/main...main = 0 0`；`git ls-remote origin refs/heads/main = e190257` |
| 豆包掉登录（cookie RFC 6265 + merge） | 提交 `3f5a24c`：`lib/cookies.js` 新增 + `test/cookies.test.mjs`；三处根因（删除指令被当空值写回、`__Secure-`/`__Host-` 被剥 Secure、镜像转发「请求带 cookie 就只用请求里的」） |
| wait-stats 纯层 + 台账 + 路由 + composer 行 + 设置累计 | 提交 `3f5a24c`：`lib/wait-stats.js`、`/__webcode/wait-stats`、`client.cjs` 的 `WaitLine`/`WaitStats` |
| 右栏滚轮 / 统一动作 / 分屏浮动多开 | 提交 `3f5a24c`：`client.cjs` 原生非被动 `wheel` + `.hwb-act-btn` 四按钮同形 + `ctx.sidebarRight.split/.float` |
| 0.14.4 装入 web + headless | 两个 profile 的 `package.json` 均 `0.14.4`；`lib/client.cjs` 含 wheel、`lib/mirror.js` 含 cookie 缓存、`lib/wait-stats.js` 存在 |
| Item 4 真机长跑（部分） | 子代理实测 5 轮同会话：`RATE_LIMITED=0`、`sessionLostCount=0`、`sameConversation=true`、`deltasMatch=true`、recall 轮答出 `9698 == truthTotal` |
| 安全：导入目录白名单 + 0o600 | 提交 `1e7c7f4`；`test/site-mount.test.mjs` 内/外两条分支用例 |

---

## 3. 未解决 / 本轮发现（逐条给修法）

### P0 · `locator.fill` 30s 超时：80 万字符一次性写入（**已修，0.14.5**）

**证据**（`session-c710ef6e` 的 turn 2 终局，逐字）：

```
locator.fill: Timeout 30000ms exceeded
  - waiting for locator('textarea.ds-scroll-area').first()
  - locator resolved to <textarea rows="2" name="search" … placeholder="给 DeepSeek 发送消息 ">
  - fill("# 可用本地工具…(+807789)
```

**归因**：`fill()` 一次性接收 807,789 字符时，Playwright 在网页侧的执行整段卡住；卡住期间**没有任何中间态可读**，事后只留一个光秃秃的超时。旧实现唯一的预兆是一句 `large prompt: … consider trimming context` 的 warn（用户看不到）。

**修法**：`composerWritePlan`（纯函数，决定 single/chunked）+ `stallStep`（纯函数，连续两块回读长度不增即判死）+ 新错误码 `PROMPT_WRITE_STALLED`（带已写/总长度与元素现场）。

**护栏**：`test/composer-write.test.mjs` 12 项（含「单块不涨不得误杀富文本站点」「配成 -5 必须等价于没配」）。

**复现**：`node test/composer-write.test.mjs`

### P1 · `<tool_result>` 外壳漏进正文（**已修，0.14.5**）

**证据**（`session-c710ef6e` 的 `assistant/message` seq=587，逐字）：

```
block 9  text len=198  <tool_result>\n{"mcp_action":"result","name":"edit","status":"success",…
block 11 text len=200  </tool_result>\n{"mcp_action":"result","name":"write",…
block 13 text len=891  </tool_result>\n{"mcp_action":"result","name":"read",…
```

**归因**：`PROTOCOL_ANCHORS` 只认 `tool_call`/`calls`/`function`/`stories`/`invoke`，**没有 `tool_result`**。于是边界落在外壳**之后**的 JSON 上，`<tool_result>\n`（13 字符）与 `</tool_result>\n`（14 字符）被当作正文发出并持久化。

探针实测（修前 → 修后）：

```
"<tool_result>"      -> index=-1           →  index=0
"</tool_result>"     -> index=-1           →  index=0
"普通正文"           -> index=-1 (不变)     →  index=-1
"if (a) { return; }" -> index=-1 (不变)     →  index=-1
```

**修法**：把 `tool_result|tool_results` 加进**边界锚点**，但**故意不加进 transport 判定**——工具结果不是工具调用，绝不能被当成待执行的调用。

**护栏**：`test/protocol-leak.test.mjs` 新增 2 项（含「result 不得被判成 transport」与「不得被 parse 成 call」）。

**复现**：`node test/protocol-leak.test.mjs`

### P1 · 中断后没有可恢复的工作台账（**已修，0.14.5**）

**证据**：`session-c710ef6e` 在 turn 2 被中断，而它的进度只存在于 `PLAN*.md`——那些文件在 `.gitignore` 里（`doc/README.md` 的口径是「本地私有留痕」），**不在仓库**。于是本次会话开头必须重新 recon 一遍工作区。

**修法**：新增 `doc/progress.md`（进仓库的进度台账）；`.gitignore` 补 `PLAN*.md`，让「私有留痕 vs 入库文档」的边界由机制保证。

### P1 · `present` 有 8 文件上限（**操作约束，非代码缺陷**）

**证据**（`session-c710ef6e` 的 `tool/result`，逐字）：

```
Error: present accepts 1 to 8 files
```

**归因**：上一轮会话在**收尾的最后一步**试图一次声明多于 8 个交付物，被工具拒绝——而那一轮随后就因 P0 的 `locator.fill` 超时而结束，于是「交付物未声明」成了可见后果。

**处置**：这是工具契约，不是桥的缺陷。**约束己方行为**：交付物多于 8 个时拆成多次 `present` 调用（每次 ≤8），并在 `doc/comment-style.md` 的交付规范里写明。

### P2 · 无效重复读取

**证据**：`session-c710ef6e` 的 272 次 tool-call 里有大量「同一文件的不同区间」`read`（本次会话开头亦复现同一模式）。

**归因**：读大文件时逐段试探，缺少「先看行数再定区间」的收敛动作。**不修代码**——这是提示词/工作习惯问题，记在此处作为后续约定改进的依据。

---

## 4. 结论

- 上一轮会话**不是**「代码没做完」，而是**在收尾前被一个可修的驱动缺陷打断**：P0 的 `locator.fill` 超时。
- 那个缺陷与它派生出的 P1（`<tool_result>` 漏网）都已在 0.14.5 修掉并加了护栏。
- 真正让「中断 = 全部重来」的是缺少入库台账——已由 `doc/progress.md` + `.gitignore` 收口。

## 5. 复现命令汇总

```powershell
cd package\dsh-webcode-bridge
node test-mock/parse-session-log.mjs --recent 3 --errors-only   # 归因
node test/composer-write.test.mjs                               # P0 护栏
node test/protocol-leak.test.mjs                                # P1 护栏
```
