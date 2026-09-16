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
| [diagnosis-2026-09-16.md](diagnosis-2026-09-16.md) | **全局诊断报告**：进度核对、文档卫生、#19 真根因、#22 前提推翻、#9 重定性、代码质量量化、未来框架与排期 | 想一次掌握「当前状态 + 下一步 + 已证结论」时 |
| [tutorial-agent-teams.md](tutorial-agent-teams.md) | 官方 Agent Teams 插件教程：身份、版本锁定理由、安装、9 个工具用法、边界 | 想用/升级/排查 agent team 时 |
| [tutorial-phone-access.md](tutorial-phone-access.md) | 手机连接 DSH 教程：选型对比、`dsh-local-link` 安装、配对、安全边界、**二维码位置（§3.5）** | 想从手机/平板访问 DSH 时 |
| [bridge-failure-ledger.md](bridge-failure-ledger.md) | **桥接失败台账**：错误码 × 已做适配 × 残留风险；含 `<call>` 泄漏根因 | 排查桥接问题；决定先修哪个时 |
| [ci-cd.md](ci-cd.md) | **CI/CD 与代码审查**：流水线分工、刻意不在 CI 里跑的东西、本地复现、发版、必需检查 | 改流水线 / 提 PR / 发版前 |

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
| [diagnosis-2026-09-16.md](diagnosis-2026-09-16.md) | **全局诊断（进度/文档/缺陷/框架排期）**：#19 真根因、#22 前提推翻、#9 重定性、代码质量量化、站点契约收口建议。读完本文件即可掌握「当前状态 + 下一步」的全貌 |

### 2026-09-16 清理：哪些文档被删了、知识去哪了

按用户指示删除**一次性与已过期**的文档，避免「过期结论被下一个会话当成现状引用」。
下表是删除清单与**知识的落点**——凡是仍有效的结论都已回写进常读文档，不是直接丢掉：

| 已删除 | 原用途 | 知识现在的落点 |
| --- | --- | --- |
| `integration-audit.md` | 独立审计（只读调查） | 「装完不重启 = 等于没修」这条教训 → [review-guide.md](review-guide.md) 收尾清单第 5 条 |
| `status-audit-2026-09-16.md` | 项目状态审计 | 当前状态 → [progress.md](progress.md)；同族缺陷 → [long-term-issues.md](long-term-issues.md) |
| `subagent-vs-team.md` | 子代理 vs Team 官方契约核对 | 结论（两者是不同层级概念）→ [long-term-issues.md](long-term-issues.md) 与 [tutorial-agent-teams.md](tutorial-agent-teams.md) |
| `subagent-spawn-diagnosis.md` | 成员无法开工的归因 | → [long-term-issues.md](long-term-issues.md) #17 |
| `diagnosis-fresh-chat-per-turn.md`、`diagnosis-new-conversation-per-turn.md` | 一次性诊断 | 结论已进代码注释与 [long-term-issues.md](long-term-issues.md) |
| `incident-2026-09-11.md` | 事故复盘 | 根因与改进项 → [bridge-failure-ledger.md](bridge-failure-ledger.md) |
| `session-log-review.md` | 会话日志归因 | 错误码与归因 → [bridge-failure-ledger.md](bridge-failure-ledger.md) |

**判据**（下次再要删文档时照这条判，不要凭「看起来旧」）：
留 = 改代码时应当一并改的（规范/契约/台账/教程）；删 = 某一次调查的快照
（它的结论应已回写进上面那几份，没回写的先回写再删）。

## 调研（doc/research/）

外部证据与一次性资料。**结论要回写到上面的常读文档**，这里只留原始素材：

- `deepseek-web-behavior.md`、`deepseek-newui-2026-09-10.md` — 站点前端行为与改版记录
- `reference-projects.md` — 参考实现清单与来源
- `prompt-engineering-evidence-2026-09-14.md` — **提示词工程实测证据与差评**（NeurIPS/ACL/arXiv 五篇；含「不能宣称最优」「必须披露 harness」两条立场）
- `agent-ui-design-references.md` — **UI 设计语言**（Apple HIG 可执行约束、Fluent 4px 间距全表、Harness 官方 token 实测清单、teammate 面板信息架构）
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
| `lib/client.cjs` | `test/client-render.test.mjs`（渲染契约）、[agent-ui-design-references.md](research/agent-ui-design-references.md)（样式取值来源） |
| `lib/prompt-variants.js`、`lib/agent-preset.js` | [prompt-engineering-evidence-2026-09-14.md](research/prompt-engineering-evidence-2026-09-14.md)（变体的文献依据）、`test/prompt-variants.test.mjs` |
| `package/dsh-webcode-bridge/test-mock/prompt-bench.mjs` | [prompt-engineering-evidence-2026-09-14.md](research/prompt-engineering-evidence-2026-09-14.md)（变体的文献依据）+ [comment-style.md](comment-style.md) **§9**（实验与取证纪律、报告模板）+ `test/prompt-bench-harness.test.mjs` |
| `package/dsh-webcode-bridge/lib/bench.js` | [comment-style.md](comment-style.md) **§9.3**（判据先于实现）+ `test/bench.test.mjs` |
| 全部源码注释与文档 | [comment-style.md](comment-style.md) **§10**（注释与文档是能力放大器） |
| `.github/workflows/`、`scripts/lint-comments.mjs`、`scripts/check-ledger.mjs`、`scripts/ci-local.mjs` | [ci-cd.md](ci-cd.md)（流水线分工、刻意不跑的东西、本地复现、台账闸门 §7.1.1）、[CONTRIBUTING.md](../CONTRIBUTING.md) |
