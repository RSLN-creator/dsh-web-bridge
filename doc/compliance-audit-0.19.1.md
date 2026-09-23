# 项目合规审计（0.19.1，对标 DSH 0.1.7-alpha.2）

> 用户要求：「① 全面进行项目合规——对比最新版本，插件要求进行审批，**不要改动代码文件**；② 提交 git release」。
>
> 本文件是 ① 的交付物。**代码文件（`lib/`、`bin/`、`test/`）一行未改**；本轮只写文档、补一条
> `.gitignore` 规则、修一处**文档与磁盘不一致**的生成物表（`reference/README.md`，它由脚本生成，
> 不是代码）。「审批」的落点见 §3——本项目的审批动作全部由**官方 harness** 承担，桥侧不做第二套。

## 0. 口径来源（可自行复核）

| 项 | 取值 | 怎么复核 |
| --- | --- | --- |
| 本机实装 DSH | `@deepseek-ai/dsh@0.1.6-alpha.2` | `npm ls -g --depth=0` |
| 官方发布标签 | `latest=0.1.5-rc.2` / `next=0.1.5-rc.3` / **`alpha=0.1.7-alpha.2`** | `npm view @deepseek-ai/dsh dist-tags --json` |
| 官方源码树 | `reference/deepseek-harness` HEAD `00102833d`（`release-dsh-0.1.7-alpha.2`） | `git -C reference/deepseek-harness log -1` |
| 官方独立包留档 | `reference/dsh-official-plugins/`（12 个 `.tgz`） | 见 `reference/local-refs/2026-09-23-dsh-official-plugins-and-boundaries.md` |
| 前序契约审计 | `doc/official-contract-audit.md`（0.16.38，逐条实读插槽） | 本文件补的是**跨版本**那一半 |

**版本口径说明（重要）**：官方 `latest` 标签停在 `0.1.5-rc.2`，比本机实装的 `0.1.6-alpha.2`
**更旧**。本机装的是 `alpha` 线，而 `alpha` 线的最新是 `0.1.7-alpha.2`。所以「对比最新版本」的
正确基线是 **`0.1.7-alpha.2`（源码形态）/ `0.1.6-alpha.2`（实装形态）**，不是 `latest`。

## 1. 插件声明层（`package.json` → `dsh`）

| 项 | 官方要求 | 本项目现状 | 结论 |
| --- | --- | --- | --- |
| `dsh.bundle.patch` | 组合包靠它把行插进 profile | `./cordis.patch.yml` | 合规 |
| `dsh.client.platform` | 必须是 `'web'` | `'web'` | 合规 |
| `dsh.client.inject` | 声明即「等这些服务就绪」 | `['slots','settingsScope','sidebarRightTabs','sidebarRight']` | 合规 |
| `exports['./client']` | 必须导出构建好的 bundle | `./lib/client.cjs` | 合规 |
| `exports['./cordis.patch.yml']` | 供 profile 解析 | 已导出 | 合规 |
| `files` | 白名单必须覆盖 `lib`/`bin`/patch | `['lib','bin','cordis.patch.yml','README.md','LICENSE']` | 合规 |
| `engines.node` | 与 `packageManager` 相容 | `>=22.13`（pnpm@11.25.0 要求 ≥22.13） | 合规（闸门判据 C 保证） |

### 1.1 与官方独立包的形状差异（**如实记录，不是缺陷**）

官方独立包（如 `@deepseek-ai/dsh-experimental-agent-team`）的 `package.json` 用 `exports`
的**条件对象**形态 + `./invariant` / `./typert` / `./remote` 子路径。那是 **monorepo 内部构建**
的产物形状（tsdown 输出 + typert 生成的 Remote 面）。

本插件是**单包 + 手写 CJS bundle**，不参与官方 workspace 构建，因此：

- 不需要 `./invariant`（官方规则：无可独立观测的状态投影就不发布 invariant 伴生包）；
- 不需要 `./typert` / `./remote`（那对是 typert 代码生成器的产物，本插件没有 Host↔Client Remote 面）；
- `exports` 用**字符串**形态即可，`dsh.client.inject` 里用**短名**（`slots` / `settingsScope`）
  而不是官方包里的 `@deepseek-ai/dsh-client-*` 全名。

最后一条已在前序审计里逐条实读过（`doc/official-contract-audit.md` §1、§3），结论合规。

## 2. 客户端 bundle 契约

| 要求 | 依据 | 现状 | 结论 |
| --- | --- | --- | --- |
| 惰性 CJS：只 `window.__ModuleLoader__.load({id, factory})` 注册 factory | `docs/subsystems/client-modules.md` | `lib/client.cjs` 单文件 bundle | 合规 |
| 模块副作用必须在 factory 闭包内 | 同上 | 已如此 | 合规 |
| 不得同步 `require` 另一个相对 `client*.js` 产物 | 同上 | 只 `require` `react` / `react-dom/client` / primitives（全是平台种子） | 合规 |
| 每次 `GET /plugins/...` 请求 URL ≤ 3 KiB（UTF-8 字节） | client-modules「The bundle route and index injection」 | 单资源 combo，远低于上限 | 合规 |
| `external` 只写基座（React / Cordis / 静态 UI 库）之外的精确模块请求 | `WebBootEntry.external` | 未声明（只用基座 + primitives） | 合规 |

## 3. 审批（用户明确点名的那一条）

用户原话：「插件要求进行审批」。**关键结论：审批是本项目最合规的一块，因为它一行都没有自己实现。**

### 3.1 官方审批的完整语义

| 概念 | 官方定义（`docs/subsystems/approval.md` + `dsh-plugin-manager` README） |
| --- | --- |
| 结果词汇 | `allowed-once` / `rejected` / `cancelled` / `unavailable`，**闭合且 fail-closed**；只有 `allowed-once` 是放行 |
| 会话策略 | `ask`（默认，委托应答链，无人应答即 `unavailable`）/ `never`（**确定性地**返回 `rejected`，不派发任何应答者） |
| 强制点 | `never` 在服务内部、**waterfall 派发之前**执行，后注册的 `prepend` 应答者也绕不过 |
| 审计 | `approval/asked` + `approval/decided` 成对写入会话日志，**log-only、不进模型转写** |
| 工具侧 | 调用方（`dsh-tools` / `dsh-tool-bash`）消费闭合结果，非 `allowed-once` 一律当拒绝 |

### 3.2 本插件的落点

| 本插件的动作 | 谁在审批 | 证据 |
| --- | --- | --- |
| 任何本地工具执行（`pwsh` / `edit` / `write` …） | **官方** `ctx.approval` | 本会话的系统提示即显示当前策略为 `never`（需审批的动作被自动拒绝） |
| 插件管理（装/卸/启停组合包） | **官方** `dsh-plugin-manager`，工具动作要求 `danger-full-access` 或逐次审批；低于该沙箱模式时 `ask` 求审批、`never`/拒绝/取消/无通道一律不执行 | `dsh-plugin-manager/README.md`「Use this package」 |
| 依赖构建脚本（pnpm 11 拦截） | **官方** 构建授权：待批名单落在 profile 的 `pnpm-workspace.yaml`，界面给「Allow these scripts and retry」；服务**校验名字但不校验对话中的批准**（如实记录这条边界） | `dsh-plugin-manager/README.md` + `lib/types/build-approval.d.ts` |
| 浏览器自动化 | **本插件自有**的 `requireConsent` 同意闸 + 官方设置页承载 | `cordis.patch.yml` 的 `requireConsent: true`；`lib/index.js` 的设置面 |

**结论：本插件没有自造任何审批词汇或审批旁路。** 用户可见的「审批」全部由官方承担；
桥只额外做了「网页自动化必须先同意」这一条**自己领域的**同意闸（它不是工具权限审批，
而是对「这个进程可以驱动浏览器」的部署级开关，走官方设置页）。

### 3.3 与本项目自身的历史一致

本项目在 `doc/REQUIREMENTS-TASKBOARD.md` 里记录过用户要的「审批闸门」是**任务板**语义
（人审任务/批注），与 §3.1 的工具权限审批是**两件事**，不应混为一谈——本文件把这条
边界写清，避免下一轮把任务板审批误当成工具权限审批去接。

## 4. 本轮发现的不合规项（3 条，前两条已修；**均未动代码**）

### 4.1 阻断：`reference/README.md` 的来源表与磁盘不一致（`ref-index` 闸门红）

| 项 | 内容 |
| --- | --- |
| 现象 | `node scripts/gen-reference-index.mjs --check` 退 1，`ci-local --fast` 因此 6/7 步通过 |
| 差异 | ① `deepseek-harness` HEAD 表里写 `ddefc45…`、磁盘是 `00102833…`（已 `git pull` 到 0.1.7-alpha.2）；② 表里**没有** `dsh-official-plugins` 这一行，但目录在磁盘上 |
| 根因 | 表是**脚本生成物**，磁盘变了而没人重跑生成器；这是本项目记为「生成物漂移」的同一形状 |
| 修法 | 按生成器口径回写表格（含 9 条非 clone 行的位置修正），并同步更正三处**人写**的汇总数字：`34 个 clone` → **37**、`316 MB` → **978.9 MB**、§6 违例清单 5 条 → **8 条**（`local-refs` 故意不算） |
| 复核 | `node scripts/gen-reference-index.mjs --check` → **exit 0**（校验 46 个存在的条目） |

### 4.2 一般：`.trae/` 未被忽略，长期挂在 `git status` 里

`.trae/documents/*.md` 是本轮对账的**本地工作底稿**（性质与 `.local-plans/` 相同：本地私有
留痕、结论一律回写 `doc/`）。它没有被 `.gitignore` 覆盖，于是 `git status` 长期挂着未跟踪条目，
一次 `git add -A` 就会把草稿提进历史——本项目已经因同型问题踩过两次（`.webcode-tasks/`、
`.local-plans/`）。已补规则 `.trae/`，并写下理由。

### 4.3 记录（**不修**，需产品决定）：站点的「浏览器插件」语义

用户说「插件要求进行审批」时，官方侧还有一层与**浏览器扩展**相关的审批语义
（`dsh-plugin-manager` 的 dependency build-script approval 与浏览器插件的宿主授权是两条）。
本插件不使用浏览器扩展链路（`extension/` 已于 2026-09-16 归档），因此**本轮不改**。
如实记录：本插件与「浏览器插件审批」这一层没有交集。

## 5. 与最新版的**能力差**（对齐但不必实现，逐条说明理由）

对比 `0.1.7-alpha.2` 的官方包清单，本插件**有意不实现**的能力：

| 官方能力 | 为什么本插件不做 |
| --- | --- |
| `dsh-client-ui-approval`（浏览器审批面板，接管 composer 呈现放行/拒绝） | 它是**官方**的审批呈现层，本插件不产生审批请求（§3），因此没有可呈现的东西 |
| `dsh-authorization`（人引导的凭据获取 flow 注册表） | 本插件的「凭据」是**站点登录态**（浏览器 profile 里的 cookie），拿它靠的是真实登录窗口，不是一次性码/账号选择；映射过去只会造出一层假的 flow |
| `dsh-experimental-auto-review`（Auto 权限预设下的逐工具 LLM 授权评审） | 它是**权限预设**的消费者；本插件让官方管工具权限，自己再判一次等于第二套审批 |
| `dsh-client-ui-plugin-manager`（侧栏「插件」页：装/卸/启停） | 用户装本插件走的是**本地 tarball + `dsh plugin`**（README 第 7-8 行），这是官方支持的路径；在插件内部再做一套管理器会与官方页面抢同一个 profile 写锁 |
| `./invariant` 伴生包 | 官方规则：只有存在**可独立观测**的状态投影才发布 invariant。本插件的状态投影（花名册/任务板）都直接读官方服务或自己的台账文件，没有独立生命周期可断言 |

## 6. 闸门读数（本文件写就时的实测）

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 注释纪律 | `node scripts/lint-comments.mjs` | PASS（error 0 / warn 0） |
| 台账一致性 | `node scripts/check-ledger.mjs` | PASS |
| 仓库卫生（编码/索引/engines） | `node scripts/check-repo-hygiene.mjs` | PASS |
| 提交信息判据自检 | `node scripts/check-commit-msg.mjs --self-test` | PASS |
| reference 来源表 | `node scripts/gen-reference-index.mjs --check` | **PASS**（本轮修复前为 FAIL，见 §4.1） |
| 生成物卫生 | `node test-mock/artifacts-check.mjs` | PASS |
| 离线基准回放 | `node test-mock/prompt-bench.mjs --offline` | PASS（21/21） |
| 全量单测 | `pnpm test` | **PASS（exit 0）** |

## 7. 本轮刻意不做的事

- **不改任何代码文件**（用户明确要求）：`lib/`、`bin/`、`test/`、`cordis.patch.yml` 全未触碰。
- **不动官方版本声明**：`engines.dsh` 仍写 `>=0.1.0-rc.6`。升到 `0.1.7-alpha.2` 需要一次真机
  验收（插槽/token/primitives 三项），属独立的版本升级轮，不在「不改代码」的前提下完成。
- **不追 `latest` 标签**：`latest=0.1.5-rc.2` 比本机实装的 `0.1.6-alpha.2` 还旧，追它等于回退。
