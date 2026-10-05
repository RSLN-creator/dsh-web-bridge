# 文档索引（doc/）

本目录是**长期可维护知识**的唯一去处。约定（2026-09-14 规范化）：

- `doc/` 下只放**入库**文档：改代码时应当一并改的那些。
- 根目录的 `PLAN*.md` 与 `REPORT.md` 是**本地私有留痕**（`.gitignore` 已排除），不属于文档体系——
  它们是「当前这一轮怎么走」的工作底稿，不进仓库、不对外。
  **2026-09-17 起它们移到 `.local-plans/`**（`PLAN-0.14.0-HANDOFF.md`、`PLAN.md`、
  `PLAN-2026-09-17-0.16.3.md`、`REPORT.md` 等）：堆在仓库根会让 `git status` 长期挂着未跟踪记录，
  也容易让人误以为它们是入库文档。本文档体系里对旧根的引用（写作 `PLAN.md` / `REPORT.md` 的那些
  **历史记录**）指的就是 `.local-plans/` 下的同名文件——历史叙述不改写，落点在这里写清一次。
- 调研资料一律进 `doc/research/`，包括外部逆向证据、真机 dump、HTML/SSE 样本。
- 一个事实只写一处。若某条结论同时属于「验收」和「长期问题」，写在验收里、
  在台账里给一条带链接的索引，不要复制粘贴两份（副本必然漂移）。

## 常读

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| [PROJECT-INTENT.md](PROJECT-INTENT.md) | **项目意图**：要做什么、不要做什么，每条附用户原话与出处 | 判断「这算不算这个项目该做的事」时 |
| [CODE-STRUCTURE.md](CODE-STRUCTURE.md) | **代码结构归类**：`lib/` 48 个模块（+`lib/sites/` 2 个 = 索引口径 50）的分层、依赖方向、God file 清单、测试分布 | 改动跨模块、决定新模块放哪一层时 |
| [ROADMAP.md](ROADMAP.md) | **未来框架**：阶段划分、每阶段判据与退出条件、与官方 AgentTeams / 外部调度插件的关系 | 决定下一轮做什么、按什么顺序做时 |
| [REQUIREMENTS-TASKBOARD.md](REQUIREMENTS-TASKBOARD.md) | **任务面板需求**（用户原话逐条）：项目化、graph、审批闸门、参考实现对照 | 动任务面板 / 任务数据层之前 |
| [PROMPT-ENGINEERING.md](PROMPT-ENGINEERING.md) | **提示词工程立场**：教原生协议、标记词形逐字教学、默认路径零位移；含真机对照读数与「不宣称最优」的元纪律 | 改提示词 / 改协议教学 / 改解析宽容度之前 |
| [verify.md](verify.md) | 真机验收矩阵：每个版本要核对的项、取证命令、已知结论 | 发版前；改动驱动/解码/镜像之后 |
| [long-term-issues.md](long-term-issues.md) | 长期问题台账：已知缺陷、为什么不现在修、若要修从哪下手 | 决定「这个要不要一起修」时 |
| [security-review.md](security-review.md) | 安全审查：攻击面清单、已做的防护、待办 | 动控制面、cookie、镜像转发时 |
| [comment-style.md](comment-style.md) | 注释风格：为什么这么写、避免什么；错误码与交付规范 | 写新模块或重构前 |
| [review-guide.md](review-guide.md) | 评审指南：怎么审这份代码、常见陷阱 | 接手评审时 |
| [progress.md](progress.md) | **进度台账**：当前走到哪、下一步是什么、已知环境约束 | 会话开始 / 中断恢复时 |
| [UNDERSTANDING.md](UNDERSTANDING.md) | **用户意图理解文档**：逐条写「用户原话 + 我的理解 + 核实 + 结论」，未定项集中在一节 | 动手前；对需求有疑问时 |
| [user-voice-log.md](user-voice-log.md) | **用户原话记录**（脚本自动汇总）：用户本人发出的每一条消息，按时间去重排列；判断意图时的第一手依据 | 判断「这算不算本项目的意图」时；接手本项目前 |
| [diagnosis-2026-09-16.md](diagnosis-2026-09-16.md) | **全局诊断报告**：进度核对、文档卫生、#19 真根因、#22 前提推翻、#9 重定性、代码质量量化、未来框架与排期 | 想一次掌握「当前状态 + 下一步 + 已证结论」时 |
| [tutorial-agent-teams.md](tutorial-agent-teams.md) | 官方 Agent Teams 插件教程：身份、版本锁定理由、安装、9 个工具用法、边界 | 想用/升级/排查 agent team 时 |
| [tutorial-phone-access.md](tutorial-phone-access.md) | 手机连接 DSH 教程：选型对比、`dsh-local-link` 安装、配对、安全边界、**二维码位置（§3.5）** | 想从手机/平板访问 DSH 时 |
| [bridge-failure-ledger.md](bridge-failure-ledger.md) | **桥接失败台账**：错误码 × 已做适配 × 残留风险；含 `<call>` 泄漏根因。⚠ 开头的 2026-10-02 提示：**那些码在 harness 侧已全部退化成 `UNKNOWN`** | 排查桥接问题；决定先修哪个时 |
| [session-cleanup-2026-09-26.md](session-cleanup-2026-09-26.md) | **会话清理记录**：257 条会话按「有没有跑完一轮」分类（19 条零产出已删 + 52 条待复核）、71 条失败的错误码分布、「没跑成 ≠ 没价值」的三条判据修正、备份与还原步骤 | 清理会话前；想知道某条会话为什么失败时 |
| [ci-cd.md](ci-cd.md) | **CI/CD 与代码审查**：流水线分工、刻意不在 CI 里跑的东西、本地复现、发版、必需检查 | 改流水线 / 提 PR / 发版前 |
| [settings-copy.md](settings-copy.md) | **设置界面文案总表**：每句界面提示对应的完整解释（被精简掉的部分全在这里）、以及「哪张卡属于全局页/站点页」的作用域表 | 改设置页文案或卡片归属前 |
| [review-0.17.x.md](review-0.17.x.md) | **0.17.x 审查报告**：基线核验、0.17.0 等待占比 `100%` 真缺陷、0.17.1 台账归因不成立、交付卫生（零提交/零 tag）、三份交付物不一致、计划完成度 | 接手 0.17 之后的版本前 |
| [official-contract-audit.md](official-contract-audit.md) | **官方契约审计**：`dsh.client` 声明、懒 CJS bundle 形状、六个插槽契约（实读结果）、主题 token、可访问性、primitives 回退、本地闸门；含「renderer-v2」这个名字在本机的查证结论 | 对齐官方写法、评审「这算不算偏离官方」时 |
| [architecture-vs-official-plugins.md](architecture-vs-official-plugins.md) | **本项目架构 vs 官方适配插件体系对照审计**：声明面逐字段对照（结论：一致）、`inject` 可选依赖纪律的双仓库交叉验证、**`registerConfigurableProviders` 该不该调的源码级判定**（决定性证据 `catalog.ts:20`）、本项目独有的 12 类东西、6 条待办与未决项；含 0.1.7-alpha.2 源码 vs 0.2.0-rc.2 实装的代际差 | 判定「这算不算偏离官方」时；改 adapter 注册 / `dsh` 字段 / 客户端 bundle 前 |
| [diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md](diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md) | **DSH 升到 0.1.7-alpha.2 后的诊断（0.19.2）**：① `settingsScope` → `configForms` 改名（阻断级：Cordis `inject` 永不就绪 → 客户端半侧整块不挂载）；② primitives 图标导出改名（`IconXxxOutline14` → `…Regular`，致底部等待药丸渲染期抛错消失）；③ 官方 compaction 新增 `headroomTokens` 把 deepseek 压缩阈值从 800k 压到 678k 的口径解释；含装机不一致与三条自证方法 | 排查「升级后插件不见 / 药丸不见 / 上下文变小」时 |
| [compliance-audit-0.19.1.md](compliance-audit-0.19.1.md) | **项目合规审计（对标 DSH 0.1.7-alpha.2）**：发布标签口径（`latest` 比实装更旧）、插件声明层、客户端 bundle 契约、**审批的官方落点**（本插件零自造）、能力差逐条理由、本轮发现的不合规项与修法、闸门读数 | 对齐最新官方版本、回答「审批在哪」时 |
| [permissions-and-boundaries.md](permissions-and-boundaries.md) | **依赖、权限、外部服务与失败边界**（DSH STORE 收录契约的声明面）：运行依赖实测面（含 `ws` 死声明的更正）、四类权限逐条、十个外部站点域、七个响亮失败的边界码，以及「声明本身不保证自动批准」的口径 | 回答「装这个插件会碰我机器上的什么」时；DSH STORE 复检前 |

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
- `task-board-vs-agentteams-graph.md` — **Graph Engineering 对照分析**：`dsh-task-board`（cron 驱动的执行台账，无依赖边）与官方 AgentTeams 任务图（`blockedBy` DAG + 全图环检测，但**无调度器**）的逻辑拆解，以及落地一张可自动推进的任务图还需要考虑什么
- `prompt-engineering-evidence-2026-09-14.md` — **提示词工程实测证据与差评**（NeurIPS/ACL/arXiv 五篇；含「不能宣称最优」「必须披露 harness」两条立场）
- `agent-ui-design-references.md` — **UI 设计语言**（Apple HIG 可执行约束、Fluent 4px 间距全表、Harness 官方 token 实测清单、teammate 面板信息架构）
- `2026-09-26-dwb-site-modularity-audit.md` — **按站点分模块架构审计**：`lib/` 站点字符串分布实测（`providers.js` 157 行 vs `browser-driver.js` 95 行欠账）、四个耦合点 C1–C5 逐条判定、`git log -S` 跨站点影响取证、以及「不要为隔离而复制，要收成 `lib/sites/<siteId>.js`」的正面回答
- `2026-09-26-glm-native-and-deepseek-no-progress.md` — **0.19.23 三件事**：① **`json` 正文泄漏根因**（`closingFenceAfter` 把**开启**围栏当**闭合**围栏消费，只吃三个反引号、漏出语言标签 `json`；决定性读数：去掉修复 **24 种切分粒度里 15 种泄漏**、带上 **24/24 干净**；并记下「既有护栏只跑 `sliceChars=1` 因而对边界敏感缺陷**天然失明**」这一课）② **GLM 原生 `code` part 补齐**（`content[].type === 'code'` 此前被静默丢弃 ⇒ 真机形态下整条调用会消失；参考 `glm-free-api:994-1013`）③ **deepseek `WEB_NO_PROGRESS` 取证与分层结论**（5/14 会话复发、8% 上下文压力排除超限、报错相位标签假陈述的加法修法）
- `2026-09-26-headless-call-tail-fragment.md` — **0.19.24 GLM 无头调用残片泄漏的修复取证**：真机 `session-c20f43e9` 的 364 字符残片（`name":"pwsh"…` 缺 JSON 头）如何穿过围栏/标签/裸 JSON 三道锚点、`headlessCallTailAt` 的语法判据与流式键前缀扣留、1341 个真实正文块的误伤扫描（3 处命中全为真残片）、逐字符模式的诚实边界
- `2026-09-26-glm-goal-round1-investigation.md` — **GLM 六问第一轮（调查，零改动）**：① 真实消耗来源（无任何智谱 API key，走网页桥）② 引用会话内容「已有一半缺另一半」③ `mcp_action` 原文三源 ④ GLM 真机适配现状（正文 + 工具循环双 PASS）⑤ 并列多会话方案 ⑥ 其余问题全景 8 条
- `2026-09-26-glm-goal-round2-implementation.md` — **GLM 六问第二轮（实施 + 验证）**：**移除「同时发送」+ 三个独立底部对话框 + 主审/探索分工 + 跨列引用**（Q2+Q5）、`answerSelector` 契约补齐（审计 C1）、全量 **1064/1064**；含**列级沙箱的诚实边界**与 `ref-index` 既有红的如实说明
- `2026-10-02-dsh-official-error-and-repair.md` — **DSH 官方对「对话报错」的约束与修正机制（0.2.0-rc.2 实读）**：错误码是唯一路由判据（`HarnessError.code`，route on this / never by parsing message）、`agent/request-error` 瀑布（`llm-retry` 退避重试 + `compaction-basic` 超限自动压缩重试 + `image-offload`，**本机 profile 全部已挂载**）、`threshold = floor(min(W×0.8, W−O−65536))`、超限修复的重试判据是「表面真的前进了」而非「处理函数返回了」；**并确证一个真实缺陷**——本插件抛普通 `Error` 而官方只认 `HarnessError` 实例，导致**错误码全部退化成 `UNKNOWN`**（284 份会话实测：归因本插件的 137 条 error finishes **137/137 全是 UNKNOWN**、官方 provider 丢码 **0** 条；同码 `CONTEXT_WINDOW_EXCEEDED` 在官方活、在本插件死），官方自动重试与自动压缩修复**对本插件从未生效**且**不报错**；含 `RATE_LIMITED` ≠ 官方 `RATE_LIMIT` 的码名不符、UI 一律显示 `UNKNOWN` 的读数，以及分四步的修法建议。**✅ 同轮已修（0.19.54）**：新增 `lib/error-codes.js` 错误码真源、24 处抛点全部改走它、空回复对齐官方 `EMPTY_RESPONSE`、`providerRetryPolicy` 从 `undefined` 改为显式策略；端到端 + 反向变异已验证（§7 有实施记录）。⚠ 基线数字 137/137 **不会因此改变**（历史会话是既成事实），本轮声称的是「机制已接通」而非「丢码率已下降」。基线可复现：`node scripts/scan-error-codes.mjs`
- `2026-10-02-codearts-auth-vs-webcode-bridge.md` — **`dsh-codearts-auth`（Gitee）与本插件的实现对照**：它怎么实现的（12 个 provider、HTTP 打厂商私有端点、原生 `tools`、两套协议族、账号池 + per-ref 串行续期、`/api/jet-hub` JSON-RPC 控制面），以及与本插件的**十个不同之处**（网页驱动 vs 端点客户端、正文解析 vs 结构化 `tool_calls`、自定 `mcp_action` 协议 vs OpenAI/Anthropic 标准、浏览器是后端 vs 一次性验证码工厂……）；含本次更新到 `c74e0c2` 的实测记录、18 个新增模块清单，以及**一处与对方 README 不符的实测读数**（pnpm 11.25.0 下纯包名 `allowBuilds` 键可用）
- `2026-10-02-dsh-browser-kernel-reuse.md` — **复用 DSH 自带浏览器内核：设想、现状与「先不改」结论**：插件浏览器来源四级链 + 本机 `ms-playwright` 1.6 GB 实况 + 官方内嵌浏览器机制（web 版沙箱 iframe / 桌面版主进程租约 `<webview>` + `dshDesktop.browser.acquire` 唯一正门）；**决定性探针**：playwright 驱动 `DeepSeek Harness.exe` 在 `Target.createTarget` 处 Not supported + 三个独立否决项；省资源的正解是「来源偏好可配 + 系统优先档」（本机有 Edge 150，立省 428 MB），触发条件与捡起路径在案
- `2026-09-28-think-effort-readback.md` — **0.19.49「思考等级回读读不到档位」取证与修复**：用户报障 `THINK_EFFORT_UI_CHANGED … 判定 no-readback` 并说「其余都是类似原因」——**这句话被证实为真**。逐站点真因：kimi 把**模型名**当锚点（触发控件的 `triggerText: '快速'` 而 `快速` 是模型名，换 `K3` 后锚点不在文本里 ⇒ token 匹配池为空 ⇒ 每轮抛错）；glm 模型名与档位**无缝拼接**（`GLM-Flash极致`）；qwen 触发文本**就是**档位 id（`自动`）；zai/doubao 本轮未发现缺陷。**取证方法本身是一条教训**：`probe-think-effort-live.mjs` 的「拷 profile 副本」对 kimi 不成立（登录态在 localStorage 而非 cookie ⇒ 副本是游客页，读数里 title 是官网首页、有「登录以同步历史会话」）——本轮改走**只读 CDP**（顺 profile 的 `DevToolsActivePort` 连线上已登录页面 `Runtime.evaluate`，不点击不填框不发消息）。另含一个顺带修掉的真 bug：带槽的兼容别名解析不了（`zai@work:auto` 报错而 `zai:auto` 正常）
- `2026-09-26-column-sandbox-round1-thinking.md` — **并列三列沙箱·第一轮思考（零代码改动）**：决定性取证「同一个模型有两条路径」—— provider 通路（`lib/index.js`，会执行工具、真改文件）vs 控制面通路（`web-control.js` 的 `POST chat`，**只回文本**）；结论是**并列三列今天对工作区没有任何文件效果**，故「按列改写 workdir」是为不存在的问题造机器；并指出 `columnGuidance` 那句「你的产出请写入 `.hwb/cols/…`」**是在要求该路径做不到的动作**（真缺陷）；附官方 `sandboxPolicy.resolve()` 只认 `session` 的逐字证据
- `2026-09-26-column-sandbox-round2-thinking.md` — **并列三列沙箱·第二轮思考（零代码改动）**：四个候选方案判定 —— A 只留约定（保留但改掉谎话）/ **B 桥侧产物围栏（采用）** / **C 让产出目录真的存在（采用）** / D 每列独立 DSH 会话（**不做**，要改产品且跨层改造，只写进文档）；围栏口径**照抄官方 `dsh-fs-sandbox`** 的 `canonicalize-then-contain` + 身份回退 + 委托前再解析；含「不声称什么」五条与 15 条成对判据的验证计划
- `2026-09-25-compact-aux-delta.md` — **手动 /compact 失效的取证与修复（0.19.14）**：压缩调用的真实形状、无键整包重放撞 1M 预算闸的病因链、真机 A/B/阶梯探针读数（网页输入框上限已 ≥320k）、游标命中只发增量的修法与「辅助轮不碰主游标」的边界
- `2026-09-25-mirror-real-viewer-research.md` — **镜像路线「真实查看器」方案研究**：图片/文件查看失效的机理（陌生域 + referer 403 真机二分实锤）、/wr/ 带 cookie 转发 + bootstrap 补钩的 0.19.14 交付记录、SW 拦截层暂缓的裁量理由
- `2026-09-23-longrun-two-rounds-thinking.md` — **长跑健全性两轮思考**（纯文档，零代码）：第一轮从「什么会杀死长会话」落到「压缩路径从未被行使」；第二轮换起点从「桥凭什么相信网页」落到「防护全是单轮闭环」；两轮独立成立并给出共同结构与可检验的下一步
- `2026-09-23-dsh-longrun-and-compaction.md` — **DSH 长跑健全性与压缩机制真机取证报告**：`threshold = floor(min(W×0.8, W−O−headroom))` 的完整推导、`W` 来自 adapter 的 `resolveModel`、304 份会话里 `compaction/*` **零命中**的取证、最高压力只到 **59.4%**（阈值 80%）→「web 端不能自动压缩」的更正、四个可调旋钮与长跑姿势；含六条未证实项
- `2026-09-23-longrun-rounds-3-4.md` — **长上下文第三、四轮思考**（纯文档）：第三轮从「压力读数量的是谁」落到**两个上下文账本从未对账**（分子分母都是桥的自述；`index.js:844` 注释承诺 128k、代码给出 1M）；第四轮从「auto_continue 是不是免费的」落到**每次救活都在给下一次加长**（完整提醒 = 26,264 字符常驻），给出两条可检验的解决方向（对账探针 / 恢复预算 + 重建而不是加长）与 10 条文献引证
- `2026-09-23-token-density-calibration.md` — **token 密度标定（官方真实数据）**：官方文档给的是平均密度（中文 0.6 / 英文 0.3），本文用本机凭据对**官方端点实测**六类样本，先修掉「上下文缓存让同一段文本两次差 1.86 倍」的测量陷阱，再拟合出「每类都不低于实测」的三类单价（CJK 0.75 / 散文 ASCII 0.30 / 其余 ASCII 0.70）——**旧口径 0.7/0.25 在源码上低估 33%、数字符号低估 63%**，正是编码 agent 的日常流量
- `2026-10-05-dsh-multi-session-and-client-hot-swap.md` — **官方「多会话」的真实实现 + 客户端插件热换契约（0.2.0-rc.2 实读 + 真机）**：① `main` 是 keyed 槽一次一个 key、面板与单个会话互斥、任何官方导航都 `selectPanel(null)` ⇒ **官方没有多会话同屏**；官方支持的等价构造 = 面板声明 session 子槽 + `sessions.retain` + `SessionProvider` + `renderFactorySlot('conversation.content',{variant:'embedded'})`（`ui-subagent` / `ui-sidebar-right` 在产范例）；② 「面板全空」的两类形状（抛错空盒 vs 塌高）与各自读数；③ `dsh-client-hmr` 热换契约（产物路径 = `exports["./client"]`、内存快照 + `&rev=` 破缓存、`/plugins*` 免 token、宿主半边必须重启）与**正确姿势：原地覆盖**（`Move-Item` 替换会 404，实测）；④ 真页面验证通道——`dsh web` 启动横幅就打印带 token 的 URL，「token 只在内存里 ⇒ 开不了真页面」这个旧判断只对了一半；⑤ 本轮两个真根因（`layout` 未进 inject / `warn` 声明在 `apply()` 里）与「正则判据看不见作用域」这一课
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
| `.github/workflows/`、`scripts/lint-comments.mjs`、`scripts/check-ledger.mjs`、`scripts/check-long-term-issues.mjs`、`scripts/ci-local.mjs` | [ci-cd.md](ci-cd.md)（流水线分工、刻意不跑的东西、本地复现、台账闸门 §7.1.1）、[CONTRIBUTING.md](../CONTRIBUTING.md) |
