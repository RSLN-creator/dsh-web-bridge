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
| 工作树版本 | **0.14.5**（未发布，改动中） |
| 已装版本（web / headless） | 0.14.4（需重装 0.14.5） |
| 上游 | `origin/main` = `e190257`，本地已同步 |
| 单测基线 | 249 通过（0.14.4）；本轮新增 `composer-write`(12) 与 `protocol-leak`(+2) |

## 本轮（0.14.5）已完成

- **会话日志解析工具** `test-mock/parse-session-log.mjs`：按 zstd magic 切多帧
  （单帧解压只得 220 字节，这个坑上一轮踩了三次）。
- **归因报告** `doc/session-log-review.md`：最近两次会话的失败点、归因、复现命令。
- **P0 修复**：composer 分块写入 + `PROMPT_WRITE_STALLED`。真机证据是 80 万字符
  一次性 `fill` 导致 30s 超时；决策抽成纯函数 `composerWritePlan` / `stallStep`。
  护栏 `test/composer-write.test.mjs` 12 项。
- **P1 修复**：`<tool_result>` 加进协议边界锚点（但**不**加进 transport 判定）。
  护栏 `test/protocol-leak.test.mjs` +2 项。

## 本轮待办

1. **右栏 UI 对齐官方**（用户明确要求）：按 AI-IDE 浏览器布局重排站点栏/动作组/空态，
   尺寸与 token 以官方包实测值为准（28px 控件、`.5px` 边框、24px 卡片圆角、
   `15px/13px` 排版），状态改用色点 + tooltip。
2. **文档收口**：`doc/README.md` 补新文件索引；`doc/comment-style.md` 补错误码与
   交付（`present` ≤8 文件）规范。
3. **安全审查复核**：`lib/cookies.js` 与镜像 cookie 短缓存。
4. **发布**：版本 0.14.5 → pack → 双 profile 安装（先删旧目录再解，绕开
   pnpm 同版本缓存不重解）→ 逐文件哈希核对 → 推送 → `present`。

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
