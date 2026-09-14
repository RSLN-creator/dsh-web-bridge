# 文档索引（doc/）

本目录是**长期可维护知识**的唯一去处。约定（2026-09-14 规范化）：

- `doc/` 下只放**入库**文档：改代码时应当一并改的那些。
- 根目录的 `PLAN*.md` 是**本地私有留痕**（`.gitignore` 已排除），不属于文档体系——
  它们是「当前这一轮怎么走」的工作底稿，不进仓库、不对外。
- 调研资料一律进 `doc/research/`，包括外部逆向证据、真机 dump、HTML/SSE 样本。
- 一个事实只写一处。若某条结论同时属于「验收」和「长期问题」，写在验收里、
  在台账里给一条带链接的索引，不要复制粘贴两份（副本必然漂移）。

## 常读

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| [verify.md](verify.md) | 真机验收矩阵：每个版本要核对的项、取证命令、已知结论 | 发版前；改动驱动/解码/镜像之后 |
| [long-term-issues.md](long-term-issues.md) | 长期问题台账：已知缺陷、为什么不现在修、若要修从哪下手 | 决定「这个要不要一起修」时 |
| [security-review.md](security-review.md) | 安全审查：攻击面清单、已做的防护、待办 | 动控制面、cookie、镜像转发时 |
| [comment-style.md](comment-style.md) | 注释风格：为什么这么写、避免什么；错误码与交付规范 | 写新模块或重构前 |
| [review-guide.md](review-guide.md) | 评审指南：怎么审这份代码、常见陷阱 | 接手评审时 |
| [progress.md](progress.md) | **进度台账**：当前走到哪、下一步是什么、已知环境约束 | 会话开始 / 中断恢复时 |
| [tutorial-agent-teams.md](tutorial-agent-teams.md) | 官方 Agent Teams 插件教程：身份、版本锁定理由、安装、9 个工具用法、边界 | 想用/升级/排查 agent team 时 |
| [tutorial-phone-access.md](tutorial-phone-access.md) | 手机连接 DSH 教程：选型对比、`dsh-local-link` 安装、配对、安全边界、**二维码位置（§3.5）** | 想从手机/平板访问 DSH 时 |
| [bridge-failure-ledger.md](bridge-failure-ledger.md) | **桥接失败台账**：错误码 × 已做适配 × 残留风险；含 `<call>` 泄漏根因 | 排查桥接问题；决定先修哪个时 |

## 与账户槽（0.14.7）相关的代码位置

| 代码位置 | 该读的文档 |
| --- | --- |
| `lib/accounts.js` | [progress.md](progress.md) 的「0.14.7」一节（数据模型与回落链） |
| `lib/providers.js`（`listAllModels` / `resolveWebModel`） | `test/accounts-integration.test.mjs`（默认槽零位移的硬证据） |
| `lib/browser-driver.js`（`slot`） | [long-term-issues.md](long-term-issues.md) 第 7 条（profile 锁与孤儿 Edge） |

## 专题

| 文档 | 用途 |
| --- | --- |
| [deepseek-longrun.md](deepseek-longrun.md) | 长跑可靠性专题：无外部干扰连续跑真实任务的判据与踩坑 |
| [incident-2026-09-11.md](incident-2026-09-11.md) | 事故复盘（含根因、时间线、改进项） |
| [session-log-review.md](session-log-review.md) | 会话日志归因：最近两次会话的失败点、归因、复现命令 |

## 调研（doc/research/）

外部证据与一次性资料。**结论要回写到上面的常读文档**，这里只留原始素材：

- `deepseek-web-behavior.md`、`deepseek-newui-2026-09-10.md` — 站点前端行为与改版记录
- `reference-projects.md` — 参考实现清单与来源
- `real-probe-*.json`、`sse-samples/` — 真机探针输出与 SSE 样本
- `autonomous-marathon-vs-official-api-*.md`、`thinking-trace-*.md` — 专题调研
- `awesome-deepseek-harness-README.zh-CN.md` — 外部资料留档

## 与代码的对应关系

| 代码位置 | 该读的文档 |
| --- | --- |
| `lib/cookies.js` | [security-review.md](security-review.md)（凭据流转）+ `test/cookies.test.mjs` |
| `lib/metrics.js`、`lib/wait-stats.js` | `test/metrics.test.mjs`、`test/wait-stats.test.mjs` |
| `lib/browser-driver.js` | [verify.md](verify.md)、[long-term-issues.md](long-term-issues.md) 第 3/7 条 |
| `lib/mirror.js` | [long-term-issues.md](long-term-issues.md)、`test/mirror.test.mjs` |
| `lib/client.cjs` | `test/client-render.test.mjs`（渲染契约） |
