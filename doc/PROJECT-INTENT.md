# 项目意图：把「你已经登录的网页 AI」变成 Harness 的模型

本文件回答一个问题：**这个项目到底要做什么、不要做什么。**
每条都附用户原话与出处；凡属归纳的，标注「归纳」，不与原话混排。

建立时间：2026-09-17。基线：工作树 0.16.3（运行中进程与两个 profile 均为 0.16.3）。

---

## 一、一句话意图

把**已经登录的网页版 AI**（DeepSeek / GLM / Kimi / 通义千问 / 豆包 / …）接进 DeepSeek Harness：
**网页模型产生工具调用 → 由 Harness 原生权限系统执行本地工具 → 结果回传同一网页会话。**

出处：`README.md:3` 首段。包名 `dsh-webcode-bridge` 与 provider `webcode` 保留兼容。

---

## 二、意图的五个来源（逐条原话）

| # | 用户原话（逐字） | 出处 | 这条在说什么 |
| --- | --- | --- | --- |
| 1 | 「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了你说是没有返回，**但是我看 web 是真实有的啊！**你可以去看网页端真实对话回复」 | `doc/progress.md` 0.16.3 段 | **网页侧才是事实来源**——桥说「没有」不等于网页没有 |
| 2 | 「现在提示词有误参考的最佳工程实践？deepseek？然后是**发送的纯文本太长了**！看看怎么做到解决：通过文本发送文件发送过长内容，glm 和 deepsek，**同样注意风险，先规划再执行，反复单独无外部干扰后进行解决再打包安装**」 | 同上 | 三件事：提示词要对齐模型先验、超长输入要有出路、**先规划 → 隔离验证 → 再打包安装** |
| 3 | 「**team 最后实现，优先解决前面问题**」 | `doc/progress.md:1233`（0.14.7 段） | 优先级：缺陷修复 > 新功能面板 |
| 4 | 「完成 dsh-webcode-bridge 路线图 0.14.8–0.14.9：阶段 R 参考落地；阶段 P 提示词基准实验；阶段 U 界面简化；阶段 D 注释/文档规范增强；阶段 C Team 面板」 | `REPORT.md:33`（`session-abaa2740` seq=1150，goal/change op=create） | 五阶段路线图的原始定义 |
| 5 | 「长时间后只有思维链卡住，harness 端，**没有任何报错，没有下一步**」 | `doc/review-guide.md:78` | 最贵的一类故障是**不报错** |

---

## 三、意图分解

### 3.1 核心意图（不可动摇）

1. **网页 AI 当作 Harness 的模型用**，且工具调用走 Harness 原生权限与审批——不自己造一套执行器。
   出处：`README.md:3`、`README.md:82`（「不保证模型审查结论正确……必须保留 Harness 的工具权限与审批」）。
2. **会话连续性**：同一网页会话连续多轮，工具结果回注同一会话；网页会话被删/过期时**不静默降级**，只能「重放整段」或「抛错」。
   出处：`doc/review-guide.md:70-71`（三条不可越界约束之一）。
3. **网页侧是事实来源**：任何「网页没返回」的结论都必须能指向网页那一侧的实际字节（见来源 1）。

### 3.2 交付形态

- **DSH 插件**（profile bundle），不是独立应用：`package.json` 的 `main: ./lib/index.js`、
  `exports` 含 `.client` 与 `./cordis.patch.yml`；另有 `bin/bridge-standalone.js` 作为无 DSH 时的独立入口。
- 装机路径固定：`pnpm pack` → `verify-pack` → 装进 `profiles/{web,headless}` → **重启 DSH 才生效**。
  出处：`README.md:5-15`、`doc/review-guide.md:128`（「装完不重启 = 等于没修」）。
- 右栏 UI 走**官方** `@deepseek-ai/dsh-client-ui-sidebar-right`，**不依赖任何第三方侧栏插件**。
  出处：`README.md:12-13`。

### 3.3 质量立场（本项目最强的自我约束）

| 立场 | 具体含义 | 出处 |
| --- | --- | --- |
| **证据优先** | 「凡写『实测』的，命令与读数在正文里；凡写『推断』的，明确标注」 | `doc/diagnosis-2026-09-16.md:7-8` |
| **取证 vs 推断分开写** | 两段必须分开读，不许把归因推断当直接观测 | `doc/progress.md` 0.16.3 §三 |
| **反向验证（先红后绿）** | 新护栏写完必须先证明它能红（把修复回滚 → 必须变红） | `doc/comment-style.md` §9.3，多处测试头注释引用 |
| **不制造假红/假绿** | 「空转的闸门比没有闸门更坏」；`artifacts-check.mjs` 在本机如实打印 SKIP 而非 PASS | `doc/progress.md:1358-1361` |
| **不许假修复** | 缺陷台账里每条「已修」claim 必须有真实实现 + 真实护栏 | `doc/diagnosis-2026-09-16.md:394` |

### 3.4 记账立场（失败过 4 次之后的机制）

- 台账「每完成一项即更新这里」这条约定**已失败 4 次**（`doc/diagnosis-2026-09-16.md:34` 记第 4 次）。
- 正确反应不是「下次注意」，而是**换机制**：`scripts/check-ledger.mjs` 把「机器可判的两格」（`工作树版本`、`单测基线`）从事实来源现读、逐字比对，不一致就退出 1。
- 该闸门**只覆盖两格**，所以它自己在输出里明说「全绿不等于台账完整」。
- **本文件的作用正是补上它判不了的那部分**：意图、结构、排期。

### 3.5 风险纪律（不可协商）

- **站点风控节制**：探针间隔 ≥20s、最多 3 次；风控页 ≠ 未登录。出处：`doc/progress.md:1375-1376`。
- **默认离线**：提示词基准 harness 默认不敲真机，真机跑需人为批准。出处：`test-mock/prompt-bench.mjs:17`。
- **绝不静默降级**（三条不可越界约束）：模型不符即报错、上下文不丢、工具协议只有一处定义。
  出处：`doc/review-guide.md:64-73`。

---

## 四、明确**不做**的事（边界）

| 不做 | 依据 |
| --- | --- |
| 不重写整个桥 | 15k 行、52 个测试文件、依赖无环、真机证据完备，「重写的期望收益为负」（`doc/diagnosis-2026-09-16.md:407-408`） |
| 不依赖浏览器扩展 | `lib/relay.js:12` 明言无扩展；旧 `extension/` 9 文件已归档（零代码引用） |
| 不为特定沙箱改测试脚本 | `spawn EPERM` 是本机沙箱限制，不是仓库问题（`doc/long-term-issues.md:598-600`） |
| 不在真机上跑探针作为合并门禁 | 真机验收走人工矩阵，由维护者按发版节奏跑（`doc/ci-cd.md:426`） |
| 不囤积历史 tgz | 2026-09-16 用户决定不再囤积；回滚改为基于 git 历史 / GitHub Release（`.gitignore:37-44`） |
| 不保留 LoopX | 用户决定整体舍弃（`doc/progress.md:1371-1372`） |

---

## 五、意图 → 代码的对应（一页速查）

| 意图 | 主要落点 |
| --- | --- |
| 网页 AI 当模型（含工具闭环） | `lib/index.js`（provider 适配器）、`lib/agent-preset.js`（工具协议唯一定义）、`lib/browser-driver.js`（真实浏览器驱动） |
| 会话连续性 / 不静默丢上下文 | `lib/browser-driver.js` 的会话槽与导航三态、`lib/contract.js` 的 `navContractFor` |
| 多站点 | `lib/providers.js`（站点目录）、`lib/contract.js`（契约）、`lib/decoder.js`（流解码）、`lib/model-picker.js`（选模型） |
| 同站多账户 | `lib/accounts.js`（纯函数身份层，0.14.7） |
| 右栏真站点 iframe | `lib/mirror.js` + `lib/upstream.js` + `lib/cookies.js` + `lib/loopback.js` |
| 对外 OpenAI 兼容接口 | `lib/openai.js` + `lib/flatten.js` |
| 控制面与设置页 | `lib/web-control.js` + `lib/settings-page.js` + `lib/client.cjs` |
| 队列与单槽执行 | `lib/relay.js` + `lib/wait-stats.js` |
| 看门狗与收束 | `lib/idle-window.js` + `lib/metrics.js` + `lib/zero-progress.js` |
| 花名册 / 任务图 | `lib/roster.js` + `task-graph.js` / `task-plan.js` / `task-ledger.js` / `task-split.js` / `team-state.js` |

代码分层与依赖方向的完整版见 [`CODE-STRUCTURE.md`](CODE-STRUCTURE.md)；
下一步怎么走见 [`ROADMAP.md`](ROADMAP.md)。

---

## 六、这份文档怎么维护

- **只写意图，不写状态**。状态在 [`progress.md`](progress.md)，缺陷在 [`long-term-issues.md`](long-term-issues.md)，
  验收在 [`verify.md`](verify.md)——一份事实只写一处（`doc/README.md:9-10` 的既定约定）。
- 用户说出**新的意图**或**推翻旧意图**时改这里；版本推进不改这里。
- 每条意图必须能追到原话或代码；追不到就删掉，不要留「大概是这个意思」。