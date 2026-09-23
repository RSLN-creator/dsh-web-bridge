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

---

## 8. 专项：0.1.7-alpha.2 的插件规范（用户点名的第 1 条）

「0.1.7-alpha.2 最新不是有插件规范了嘛？」——**有，而且权威出处是一个包**：

> `@deepseek-ai/dsh-package-manifest`（源码 `packages/util/package-manifest/src/types.ts`）

它是**唯一**的公开声明面：`DshPackageManifest`（包身份）/ `DshManifest`（`package.json.dsh` 下的作者字段）/ `DshBundleManifest` / `DshProfileManifest` / `DshClientManifest` / `DshEnginesManifest`。README 写明「**每个 reader 自己负责 JSON 解析、校验与默认值**」——所以规范是**声明**，执行分散在各 reader。

### 8.1 逐字段 delta（实装 0.1.6-alpha.2 → 0.1.7-alpha.2）

比对方法：把实装包的 `lib/types/types.d.ts` 与 monorepo `src/types.ts` 逐字段对照（这是**唯一**可靠的比对方式，因为版本号本身不写规范）。

| 字段 | 0.1.6-alpha.2 | 0.1.7-alpha.2 | 本项目 | 判定 |
| --- | --- | --- | --- | --- |
| `package.json.icon` | **无此字段** | **新增**：`string`，SVG/PNG/JPEG/WebP，≤256 KiB，realpath 后必须仍在 manifest 目录内 | 未声明 | 可选；见 §8.3 |
| `locale/en.json` + `locale/<lang>.json` | 约定已存在（见下） | 约定不变，读取走 `readPluginMeta` | 未提供 | 可选 |
| `dsh.manifestVersion` | **无此字段** | **新增**：字面量 `1` | 未声明 | **官方自己 85 个包 0 个声明**，且明确「不强制」→ 不声明是**与官方一致** |
| `dsh.bundle.patch` | `string` | **`string \| string[]`**（有序列表，按序应用为一层） | `string` | **向后兼容**，仍是合法值 |
| `PluginLocalizedMeta` / `LocalizedText` | `PackageMeta`（旧名） | 改名 + `LocalizedText` 支持 `{en, ...}` 语言映射 | 不使用 | 与本项目无关 |

### 8.2 关键结论：`manifestVersion` 与 `engines.dsh` 都是**声明性**的

包 README 的「Known Limitations」原文：

> **Compatibility is declarative.** Current installers and loaders **do not enforce** `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

两条推论：① 本项目不写 `manifestVersion` **不构成不合规**；② 本项目 `engines.dsh: ">=0.1.0-rc.6"` 目前**也不会被任何 reader 用来拒绝启动**——它是给人和工具的声明，不是闸门。

**官方采用率实证**：monorepo 里 85 个声明了 `dsh` 的包，**0 个**写 `manifestVersion`。这条实证比任何推断都硬——规范允许声明，但官方自己按需省略。

### 8.3 新增的显示元数据通道（`icon` + `locale/`）

0.1.7-alpha.2 起，插件的显示名与图标走**资源导出**，不执行插件代码（`packages/boot/app-boot/src/package-meta.ts` 的 `readPluginMeta`）：

- **标题/简介**：`locale/<lang>.json` 里的 `{ meta: { title, description } }`；英文 `locale/en.json` 是必需回落，缺字段回落 `package.json` 的 `name`/`description`；
- **图标**：`package.json.icon` 指向的文件被读成 **base64 data URL**（`data:image/svg+xml;base64,…`）；
- 全部经 **Node ESM resolver** 解析（`<pkg>/locale/en.json`），因此**必须在 `exports` 里可达**；
- 失败是**容忍**的：图标坏了只带一条 `error` 诊断，显示文本仍保留。

官方采用现状（实证）：`locale/` 目录 **7 处**（全部在 `packages/experimental/*`），`package.json.icon` **2 处**（`agent-team-profile`、`voice-input-bundle`，值均为 `./icon.svg`）。也就是**新通道刚起步，绝大多数官方包还没用**。

### 8.4 本项目要不要跟？（如实结论：本轮不改，理由三条）

| 项 | 判断 |
| --- | --- |
| `locale/` + `icon` | **可选增强，不是合规缺陷**。官方采用率 7/85 与 2/85，且失败容忍。本项目当前用 `description` 承担显示简介（`DshPackageManifest.description` 仍是回落源），功能不缺 |
| `manifestVersion: 1` | **不写**。官方 85 包 0 采用 + 明确不强制。写它只会增加一处需要跟着规范改的地方 |
| `bundle.patch` 升成列表 | **不必**。本项目只有一层 patch，用单文件正是规范里最简单的合法形态 |

**并且用户本轮要求「不要改动代码文件」**：`icon`/`locale` 都要往包里加文件、动 `exports`/`files` 白名单，属功能改动，不在本轮范围。已记录为下一轮候选。

---

## 9. 本轮唯一实质发现：`dsh.client.inject` 填的是**服务名**，而规范说它是**包名**

这是两轮审查里唯一一条「声明与规范不符」的实质项，因此单独成节。

### 9.1 规范怎么说

`DshClientManifest.inject` 的 JSDoc（`packages/util/package-manifest/src/types.ts:84-85`）逐字：

> **Informational package-name dependencies, not Cordis service injection.**

同一个字段在 `WebBootEntry.inject` 上再次定义（`client/manifest.ts:62-63`）：

> **Package-name dependency edges used for factory arrival and plugin composition.**

**官方把「不是 Cordis 服务注入」写进了字段注释**——这正是最容易混的一处。

### 9.2 官方实证：值一律是**包名**

对 monorepo 全量 `package.json` 做机检（`dsh.client.inject` 的每个值是否以 `@` 开头）：

```
@deepseek-ai/dsh-client-ui-chat :: @deepseek-ai/dsh-api-session-controller, @deepseek-ai/dsh-client-locale, …
@deepseek-ai/dsh-client-ui-plugin-manager :: @deepseek-ai/dsh-api-remotes, @deepseek-ai/dsh-client-locale, …
```

**没有一条不是 scoped 包名**（机检输出为空）。参考实现侧同样如此：`reference/dsh-market` 是 `['@deepseek-ai/dsh-client-locale', …]`，`reference/dsh-drop-caret` 是 `['@deepseek-ai/dsh-client-runtime']`。

### 9.3 本项目现状

`package/dsh-webcode-bridge/package.json`：

```json
"dsh": { "client": { "inject": ["slots", "settingsScope", "sidebarRightTabs", "sidebarRight"], "platform": "web" } }
```

四个值**全部是 Cordis 服务名**，不是包名。

### 9.4 为什么至今没炸（诚实归因）

追了三条消费路径，全部**容忍**了它：

| 消费点 | 代码 | 对非法值的反应 |
| --- | --- | --- |
| 模块到达顺序 | `client/system.ts` `arriveGraphRow`：`for (const packageName of row.inject) { const dependency = this.graphRows.get(packageName); if (dependency !== undefined) … }` | `graphRows.get('slots')` → `undefined` → **静默跳过** |
| 图排序 | `client/manifest.ts` `orderByModuleGraph` 只遍历 `entry.external` | `inject` **根本不参与** |
| 官方闸门 | `scripts/verify-client-packages.ts`：对 `inject` **只查空值与重复** | 不查「是不是真包」→ 不红 |

所以真实后果是：**这四条边是死声明**——它既不报错，也不产生任何到达顺序保证。按规范它描述的是一组不存在的依赖。

### 9.5 为什么不能简单删掉（这也是本条值得记的原因）

`lib/client.cjs` 末尾导出的是：

```js
const exports = { name: 'webcode-bridge-client', inject, apply };
```

同一个 `inject` 变量（`client.cjs:103`）**同时**被用作：① Cordis 插件的 `inject`（服务名，**这是对的**）；② 抄进了 package.json 的 `dsh.client.inject`（包名语义，**这是错的**）。

**服务等待本身是正常的**——`slots` / `settingsScope` / `sidebarRightTabs` / `sidebarRight` 确实由 Cordis 的 `inject` 正确等待。错的只是「把服务名复制进了清单里那个同名但异义的字段」。

### 9.6 处置（本轮**不改**，理由如实写）

| 项 | 内容 |
| --- | --- |
| 严重度 | **低**。无崩溃、无功能缺失、无闸门变红；是一条指向不存在依赖的死声明 |
| 正确修法 | 删掉 `package.json` 的 `dsh.client.inject`（平台种子 `react`/`react-dom/client`/primitives 由 `PLATFORM_MODULES` 保证，无需声明），或改成真实的包名依赖 |
| 为什么本轮不做 | ① 用户明确要求「**不要改动代码文件**」，而这是会改变声明语义的改动；② 它要重走 `pack test` → `verify-pack` → 装 profile 的完整发布循环，属独立一轮；③ 删它**不会**改变当前运行行为（今天就是被忽略的），所以不急 |
| 护栏建议（下一轮） | 加一条断言：`dsh.client.inject` 的每个值必须是包名（含 `/` 或 scoped），否则红。**官方闸门没查这一条**，所以这条护栏只有本仓库会有 |

### 9.7 附带核实：`packages/client/*` 专属禁令**不适用于本项目**

闸门里有一条看似相关的硬规则：

```
pkg.manifest.startsWith('packages/client/') && supplier !== undefined
  → 'client feature package requests runtime external …; import shared types only or call an injected Cordis service'
```

它只对**官方 workspace 内** `packages/client/*` 下的包生效（按 manifest 路径判）。本项目是外部单包（`dsh-webcode-bridge`），不在该前缀下，因此：**本项目的 `external`/`inject` 声明不受这条禁令约束**——如实记录，避免下一轮误把它当成自己的红线。

---

## 10. 用户第 2 问：本机**现在不是** 0.1.7-alpha.2

实测三条独立读数，结论一致：

| 检查 | 命令 | 读数 |
| --- | --- | --- |
| 全局安装版本 | `npm ls -g --depth=0` | `@deepseek-ai/dsh@0.1.6-alpha.2` |
| 包清单版本 | `node -p "require('…/@deepseek-ai/dsh/package.json').version"` | `0.1.6-alpha.2` |
| CLI 自报 | `dsh --version` | `0.1.6-alpha.2` |

**并且当前正在跑的 Web 服务也是 0.1.6-alpha.2**（进程 24400：`node …\@deepseek-ai\dsh\lib\bin.js web --host 127.0.0.1 --port 3080 --no-open`，该 bin 来自 0.1.6-alpha.2 的安装目录）。

容易造成「我以为是 0.1.7」的两个来源，都不是「已安装」：

1. `reference/deepseek-harness`（**源码克隆**）已 `git pull` 到 `release-dsh-0.1.7-alpha.2`，root `package.json` 就是 `0.1.7-alpha.2` —— 那是**参考源码**，不是本机运行时；
2. `reference/dsh-official-plugins/` 里留档的 12 个 `.tgz` 中有 `dsh-agent-preset-0.1.7-alpha.1` —— 那是**解包留档**，没有安装。

> **附带结论（与本项目声明相关）**：`engines.dsh` 写 `>=0.1.0-rc.6` 在**实装 0.1.6-alpha.2** 上是满足的；而 §8.2 已证 `engines.dsh` 当前**不被强制**，所以即使将来跑在 0.1.7-alpha.2 上也不会因为这条声明被拒。

---

## 11. 用户第 3 问：git TLS 配置已修（本轮唯一允许的修复）

### 11.1 根因（先纠正一个措辞）

用户原话是「`.gitconfig` 钉着 `http.sslBackend=openssl`」。**实测不是全局 `.gitconfig`，而是本仓库的 `.git/config`**：

```
file:C:/Program Files/Git/etc/gitconfig   http.sslbackend=schannel     ← 全局，是对的
file:.git/config                          http.sslbackend=openssl      ← 本仓库覆盖了它
file:.git/config                          http.sslcainfo=D:/…/.tmp/steamtools-ca.pem
```

全局配置本来就是 `schannel`（走 Windows 证书链，正确）。是本仓库的**局部**配置把它覆盖成了 `openssl`，并指向 `.tmp/steamtools-ca.pem`——一个 **1416 字节、只含 1 张证书**的文件，当 OpenSSL 的**唯一** CA 束用时，GitHub 的完整链自然验不过。于是首次 `git push` 报：

```
fatal: unable to access 'https://github.com/…': SSL certificate OpenSSL verify result:
  unable to get local issuer certificate (20)
```

### 11.2 修法与验证

```powershell
git config --local --unset http.sslBackend
git config --local --unset http.sslCAInfo
```

两条局部覆盖删除后，`http.sslBackend` 回落到全局的 `schannel`。**证据（不用临时覆盖、直接验）**：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 局部已无 ssl 行 | `git config --local --list \| Select-String ssl` | 空 |
| 生效值 | `git config --get http.sslBackend` | `schannel` |
| 远程可达 | `git ls-remote origin main` | `e313f507…` **exit 0** |
| 真实推送 | `git push origin v0.19.1`（**无任何 `-c` 覆盖**） | 见 §12 |

### 11.3 为什么选「删覆盖」而不是「修 CA 束」

两条路都能让 push 过。选前者的理由：

- `schannel` 是**全局已经在用的**后端（`C:/Program Files/Git/etc/gitconfig`），删掉局部覆盖只是**回到已有共识**，不引入新变量；
- 那个 CA 文件在 **`.tmp/`（已被 `.gitignore:61` 忽略）**里——**临时目录**。把 TLS 信任链钉在一个临时目录的文件上，本身就是这个 bug 的成因：`.tmp/` 会被清理，清理后 Git 就再也连不上远程，而报错信息（`unable to get local issuer certificate`）**根本不提那个消失的文件**；
- 修 CA 束（把整条链补全再指过去）保留了「依赖临时路径」这个脆弱性，只是把发作时间推后。

### 11.4 边界（如实）

- **只改了本仓库的 `.git/config`**，没有动全局 git 配置，也没有删除那个 CA 文件（它属于 `steam-tools` 那条链的留档，不在本项目职权内）；
- 该文件在 `.tmp/` 里，**不入库**，所以这次修复本身**不产生可提交内容**——它只体现在「下一次 push 不需要再手动覆盖」上；
- 本轮**没有**把它写进 `.gitignore` 之外的任何地方：`.tmp/` 规则早已存在，无需新增。
