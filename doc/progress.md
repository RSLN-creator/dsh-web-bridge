# 进度台账（进仓库）

**为什么这个文件存在**：2026-09-14 的会话在收尾前被中断，而它的进度只写在
`PLAN*.md`（本地私有留痕、不在仓库），导致下一次会话必须从头 recon 一遍。

`doc/README.md` 已经规定了「根目录 `PLAN*.md` 是本地私有留痕」——那条约定是对的，
缺的是它的**对偶**：仓库里必须有一份「当前走到哪、下一步是什么」的台账。这就是本文件。

约定：

- 每完成一项即更新这里；跨会话恢复以本文件 + `PLAN.md` 为准，不依赖会话记忆。
- 与 `session-log-review.md` 分工：那份是**归因**（为什么失败），这份是**状态**（现在在哪）。

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 工作树版本 | **0.14.6**（已发布 / 已装 / 已验证） |
| 已装版本（web / headless） | **0.14.6**（重启已生效，PID 22184） |
| 上游 | `origin/main` = `e190257`，本地已同步 |
| 单测基线 | 249 通过（0.14.4）；0.14.5/0.14.6 新增 `composer-write`(12) 与 `protocol-leak`(+6) |
| 下一阶段 | **0.14.7 同站多账户**（设计见 `reference/local-refs/agent-teams-reference-notes.md` §7.4） |

## 0.14.6（已发布 / 已装 / 已验证）

**0.14.6 = 0.14.5 的全部内容 + `<call>` / `</call_call>` 残片修复。**

为什么要多一个版本号（发布纪律，不是洁癖）：`0.14.5.tgz` **已经打过**且内容不同，
同名同版本换内容会被 pnpm 按版本号去重而静默不更新（0.13.0 踩过这个坑）。
因此把「0.14.5 + 残片修复」合并发布为 **0.14.6** —— 用户仍然**只需重启一次**。

### 修了什么

`lib/agent-preset.js`：

1. `PROTOCOL_ANCHORS[0]` 候选集加 `call_call|call`（**只进锚点，不进 transport**）。
2. `partialProtocolAt` 前缀表补 `<call` / `<call_call`（流式半成品防线）。

`test-mock/parse-session-log.mjs`：

3. `detectProtocolLeak` **同步扩集**——检测器与被保护的正则共享盲区时，
   「日志没有泄漏告警」是**假阴性**。

`test/protocol-leak.test.mjs`：新增 4 项（残片是锚点 / 残片永不 transport /
残片不吞前面的散文 / `<calling>` 不是锚点），**15 项全绿**。

### 验证

- 全部测试文件 **26/26 通过**，`run-m1.js` **M1 PASS**。
- `verify-pack`：**24/25 逐字相同**，唯一差异是 `package.json` 被 pnpm 规范化掉
  `packageManager` 字段——已逐字段 diff 证明**其余字段零差异**（`field diffs: 0`，
  只有 `tree-only keys: ["packageManager"]`）。
- 两个 profile 均装 **0.14.6**，四个改动标记逐一核对在位：
  `call_call` 在锚点 ✓、`'<call'` 在前缀表 ✓、`PROMPT_WRITE_STALLED` ✓。
- 回滚备份：`profiles/web/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml}.bak-2026-09-14-addplugins`。

### 重启后核对点（2026-09-14 晚间已逐条实测通过）

| # | 核对点 | 实测结果 |
| --- | --- | --- |
| 1 | `build.version` 应为 0.14.6、`hash` 变化 | ✔ `build.version=0.14.6`、`build.hash=f6837b9a8cf1`；进程 PID 22184，启动 19:36:21 |
| 2 | 不再出现 `</call>` / `<call_call>` 残片 | ✔ 两个 profile 的 `agent-preset.js` 均含 `call_call|calls|call` 锚点与 `<call`/`<call_call` 前缀表；`protocol-leak` **15/15** 通过 |
| 3 | composer 分块写入生效，不再 30s `locator.fill` 超时 | ✔ 本会话即由桥接驱动，`lastEndReason=finished`、`lastRate.responseMs=952`；`--recent 3` 无 `locator.fill` 超时 |

**新增正面证据（0.14.6 之前没有的）**：`node test-mock/parse-session-log.mjs --recent 3 --errors-only`
在 `session-ec60921d` / `session-abaa2740` 上**零 `protocol-leak` 命中**；
而修复前的 `session-b01554c3` 有 4 处命中（`</call>` @106/@103、`</call_call>` @68/@75）。

**同时发现一个新族（未归因，已入账）**：`session-ec60921d` 有一条
`tool/result isError: invalid arguments: missing required property "command"` ——
与 composer 无关，属工具调用参数缺失族，记入 `bridge-failure-ledger.md` 与
`long-term-issues.md` 第 17 条。

## 本轮（0.14.5）已完成

- **会话日志解析工具** `test-mock/parse-session-log.mjs`：按 zstd magic 切多帧
  （单帧解压只得 220 字节，这个坑上一轮踩了三次）。
- **归因报告** `doc/session-log-review.md`：最近两次会话的失败点、归因、复现命令。
- **P0 修复**：composer 分块写入 + `PROMPT_WRITE_STALLED`。真机证据是 80 万字符
  一次性 `fill` 导致 30s 超时；决策抽成纯函数 `composerWritePlan` / `stallStep`。
  护栏 `test/composer-write.test.mjs` 12 项。
- **P1 修复**：`<tool_result>` 加进协议边界锚点（但**不**加进 transport 判定）。
  护栏 `test/protocol-leak.test.mjs` +2 项。

## 下一阶段（0.14.7 同站多账户）

用户明确「team 最后实现，优先解决前面问题」。0.14.6 收口后，下一阶段是
**同站多账户**，设计要点已备好（`reference/local-refs/agent-teams-reference-notes.md` §7.4）：

1. **账户槽数据模型**：站点级单份登录态 → 「站点 × 槽」（`<siteId>#<slot>`）；
   **默认槽保持 `<siteId>`**，历史设置值必须仍可解析。
2. **模型 id**：`site:model` → `site@slot:model`，保留别名解析与 `MODEL_ALIAS_IDS` 唯一定义处纪律。
3. **显示**：非默认槽追加 `(账户N)`；默认槽**不加后缀**（既有断言与既有下拉不变）。
4. **发送间隔**：定为**槽级**（不同登录态风控独立）。
5. **风控前提**：每槽独立限流、探针串行化、**默认不并发探测**。

再下一阶段是 **Team 面板**（消费官方 `agentTeams` Remote + 自建面板；
官方三个包已装但**不含 client 入口**，故不能照抄官方面板）。

## 已装入 web profile 的两个新插件（2026-09-14，重启已生效）

| 插件 | 版本 | 状态 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.1.5-rc.1 | 已装，bundle 层已注册 |
| （其依赖）`@deepseek-ai/dsh-experimental-agent-team` | 0.1.5-rc.1 | 已装（**必须钉 rc.1**，见教程 §2） |
| （其依赖）`@deepseek-ai/dsh-experimental-tool-agent-team` | 0.1.5-rc.1 | 已装 |
| `dsh-local-link` | 1.1.1 | 已装，bundle 层已注册 |

- 四个包安装副本与 tarball 逐文件 SHA256：`8/8`、`43/43`、`7/7`、`22/22` **零差异**。
- `dsh --profile web --dump-config` 已确认两个新层存在，原有 11 个 bundle 一个不少。
- 教程：[agent-teams](tutorial-agent-teams.md) / [phone-access](tutorial-phone-access.md)。
- **重启后要做的两件**（状态更新）：① 侧栏出现 `Local access` —— 用户已确认**二维码没问题**，本条关闭；
  ② 对 Lead 说「创建一个名为 reviewer 的 teammate 检查 diff」确认 9 个 Team 工具已注册 —— **待做**，属阶段 C。

## 本轮（2026-09-14 下午）新增结论

### 二维码「找不到」已定位（后端正常，前端触发点隐蔽）

- 实测 **3088 端口在监听**（`OwningProcess=36232`，与 3080 **同一个 node 进程**），
  `POST http://127.0.0.1:3080/__dsh-local-link/admin/pairing` 返回 **201**，
  body 里带 `qrDataUrl`（base64 PNG）与一次性 `url`。**后端完全正常。**
- 前端入口注册在 DSH 官方侧栏槽位 **`sidebar.footer.action`**（id `local-link-connect`，`order: -10`），
  渲染在侧栏 **footArea**（`sidebar.settings` 之上）。
- **两个「找不到」的原因**：① 文字标签只在**侧栏展开时**渲染
  （`wide && <span>{t(\"footer.trigger\")}</span>`）——折叠时只剩一个图标；
  ② 该入口与 `settings.section` 的 `Local access` 分区都受 `desktopOrigin()` 约束
  （hostname 必须是 `localhost`/`127.0.0.1`/`::1`），用局域网 IP 打开桌面页时**两者都隐藏**。
- 已写进 `doc/tutorial-phone-access.md` **§3.5「二维码到底在哪」**（含验证命令与诊断读法）。

### 卡住的直接根因：0.14.5 未装（**已由 0.14.6 解决**，见上方「重启后核对点」）

`session-c710ef6e` turn 2 终局逐字：

```
turn/end reason = {\"kind\":\"error\",\"error\":{\"message\":\"locator.fill: Timeout 30000ms exceeded…\"}}
```

这正是 0.14.5 修的 P0（80 万字符一次性 `fill()`）。当时运行的 0.14.4 上**必然**复现。
→ 已通过发布并安装 **0.14.6** 解决；重启后实测 `lastEndReason=finished`、无 `locator.fill` 超时。

### `<call>` / `</call_call>` 残片漏进正文（**已在 0.14.6 修复并验证**）

`lib/agent-preset.js` 的 `PROTOCOL_ANCHORS[0]` 候选集**不含 `call` 与 `call_call`**，
于是 `findProtocolStart` 返回 -1，残片被当正文外发并持久化。
真机证据 13 处（`session-698700ea` seq=91/119/179/289/326/569/779）。
**且 `detectProtocolLeak` 共享同一盲区** → 日志不告警是假阴性。
0.14.6 已把锚点、前缀表、检测器三处同步扩集（`doc/long-term-issues.md` 第 15 条），护栏 **15/15 通过**。

### 本轮零真机探针

全部结论来自**离线会话日志 + 已装包源码**。风控纪律（间隔 ≥20s、最多 3 次、
风控页 ≠ 未登录）不变；同站多账户会成倍放大风控风险，实现时须每槽独立限流、
探针串行化、默认不并发探测。

## 已知环境约束（不要重新踩）

- `pnpm install` 会因无关依赖 `dsh-loopx-plugin`（GitHub tarball）证书校验失败而整体失败
  → 安装走手动解包。
- git 远端 HTTPS 证书校验失败 → 推送/拉取用 `GIT_SSL_NO_VERIFY=1`（仅本机网络问题的
  绕过，不改全局 git 配置）。
- **反复深链同一会话地址会触发站点风控**（0.14.3 事故）：探针要节制，间隔 ≥20s、
  最多 3 次；风控页 ≠ 未登录。
- 真机长跑用 `WEBCODE_PROFILE_DIR` 覆盖，与正在运行的 DSH 隔离。

## 真机验收矩阵

见 `doc/verify.md`。本轮新增待验项：

- composer 分块写入在真机上不再出现 30s `locator.fill` 超时（或失败时给出
  `PROMPT_WRITE_STALLED` 与已写进度）。
- 右栏新布局在重启 DSH 后目视核对官方尺寸。
