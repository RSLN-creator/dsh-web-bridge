# 验收记录

本文件按版本追加。最新在最前。

---

# 0.15.3 重启后真机三缺陷（`POST status` / hooks 顺序 / 会话注入）

日期：2026-09-16。环境：Windows、Node v24.18.0、DSH 0.1.5-rc.1。

**触发**：用户重启 DSH 后反馈两件事——① 上一轮的交付文案 markdown 格式错乱；
② **设置界面丢失，网页桥接栏目一片空白**。

第 ① 件是模型输出层的问题（工具调用被内联进正文），不是代码缺陷，记录在案但不修代码。
第 ② 件查下去是**三个独立缺陷叠加**，其中两个同属上一轮已经定性的那一家族。

## 三缺陷与修法

### ① 设置页空白：`SiteAccounts` 的 hook 写在提前 `return` 之后

| 项 | 内容 |
| --- | --- |
| 现场 | `lib/client.cjs` 的 `SiteAccounts`：3 个 `useState` + 1 个 `useEffect` 之后是一句「站点表为空就返回加载中」，**这句之后**又写了第 5 个 `useState`（`picked`） |
| 机制 | 首屏 `sites` 未到时只跑 4 个 hook 就 return；`sites` 到达后同一次挂载走到第 5 个。真实 React 对「本次渲染比上次多 hook」是**硬错误** |
| 后果 | 错误冒泡到 `settings.section` 的 `SlotErrorBoundary`，整块栏目被替换成空占位 —— 即用户看到的「一片空白」 |
| 为何旧版没有 | 0.14.7 还没有 `picked`，没有这个 4→5 的跳变 |
| 修法 | 把 `picked` 提到提前 `return` 之前（hook 无条件、按序执行） |
| 为何原护栏全绿 | `client-render.test.mjs` 的 useState 桩是**按名字取值**的映射，结构上察觉不到顺序/数量违规；且它在切换 payload 时会清空 states，「同一次挂载内 4→5」从未被复现 |

### ② 花名册恒读不到：`status` 只注册了 GET，客户端走 POST

| 项 | 内容 |
| --- | --- |
| 现场 | `lib/client.cjs` 的 `api('status', { sessionId })` 带 body ⇒ **POST**；`lib/web-control.js` 只注册了 `'GET status'` |
| 后果 | 真机 `POST /__webcode/status` ⇒ **HTTP 405**（动作表有同名后缀、方法不匹配时，web-control 的分支会带 `Allow` 头回 405）。花名册那一栏因此永远读不到，`subAgentsError` 报 `no-session-id` |
| 修法 | `actions['POST status'] = actions['GET status']` —— **别名而非复制实现**：两个方法必须返回逐字节相同的形状，复制一份迟早漂移（那正是本次故障的同族病） |
| 为何原护栏全绿 | `client-render.test.mjs` 的 mock fetch **不看方法**，任何 URL 都回 200 + JSON。护栏自己的建模失真，把「服务端没这条路由」整个盖住 |

### ③ 会话身份错配：`settings.section` 是 root 作用域，拿不到 sessionId

| 项 | 内容 |
| --- | --- |
| 现场 | 0.15.0 给 `settings.section` 写了 `inject: (sessionId) => ({ sessionId })` |
| 根因 | 该槽在官方契约里是 **`scope: "root"`**；renderer 的 `runInject` 只对**带 binding 的会话级槽**传 `binding.key`，root 槽只拿到 `actions` 对象 |
| 后果 | 那个 actions 对象被当成会话 id 送到服务端，花名册恒回 `no-session-id` |
| 修法 | 新增 `SettingsSection` 包装层，经官方 standard prop **`useSessions`** 读 `state.current`（官方 `ui-settings-general` 自己就这么读会话），再以普通 prop 传给纯展示的 `Settings` |
| 降级 | `useSessions` 缺席（测试桩 / 会话尚未建立）时回落 `props.sessionId → null`，面板如实显示「读不到」而非崩掉 |

## 新增护栏（三条，全部先证明能抓到缺陷）

| # | 护栏 | 抓什么 | 反向验证 |
| --- | --- | --- | --- |
| 1 | `test/hooks-order.test.mjs`（2 项） | 组件体顶层「hook 出现在提前 return 之后」 | 把 `picked` 搬回 return 之后 → **红**（报「提前 return 在第 578 行，但第 579 行仍有 hook」）；搬回 → 绿 |
| 2 | `test/client-server-contract.test.mjs`（2 项） | 客户端 `api(action, body)` 推导出的方法与服务端动作表不一致 | 临时删掉别名 → **红**（精确报 `POST status ← api('status',`）；恢复 → 绿 |
| 3 | `client-render.test.mjs` 新增 2 项 | root 槽不得用 `inject` 冒充会话来源；降级链必须完整 | 三条反向用例（加回 inject / 去掉 useSessions / 破坏回落链）**全部被抓到** |

> **护栏自身的两次失手也记录在案**（否则会重犯）：
> `hooks-order` 第一版扫描器不跟踪花括号深度，把嵌套回调里的 hook/return 算进组件体，
> 误报了 SiteAccounts / Conversation —— 一个会误报的护栏会被直接绕过；
> 第二版跟踪了深度但漏掉**单行守卫**（`if (cond) return x;`）这一形态，
> 正是真机缺陷用的写法，反向验证因此**静默漏过**。
> `client-server-contract` 第一版不认 `actions['X'] = …` 别名注册形态，
> 修好之后又把「已修」判成「没注册」。
> 结论：**护栏写完必须反向验证，且反向用例本身要确认「变更真的生效了」**——
> 第一版 `reverse-session-guard` 有一条正则没匹配上，报告的是「漏过」而不是「未生效」，
> 差点把没验证的护栏当成已验证。

## 离线验收（全部实跑）

| # | 判据 | 命令 | 结果 |
| --- | --- | --- | --- |
| A1 | 全量单测（逐文件） | `node test/<f>` × 35 | **35/35 全绿**（本机 `node --test` glob 仍 `spawn EPERM`） |
| A2 | 注释闸门 | `node scripts/lint-comments.mjs` | 退出 **0**，125 文件，`error 0, warn 0` |
| A3 | 打包 | `pnpm pack` | `dsh-webcode-bridge-0.15.3.tgz`（285,437 字节） |
| A4 | 发布闸门 | `node scripts/verify-pack.mjs <tgz>` | **28/28 逐字相同** + `✔ 接线完好`，退出 **0** |
| A5 | 装入真机 profile | `node scripts/install-profiles.mjs <tgz> --profiles web` | web **0.15.3**，退出 **0**，无接线告警 |
| A6 | **安装副本**真机等价复验 | `node .tmp/verify-installed-wiring.mjs` | 真实 `apply()` + 真实 HTTP：`GET 200`、**`POST 200`**（修前 405）；`subAgentsError` = `session-projections-unavailable`（不再 `no-session-id`） |

## 仍需重启后确认

| # | 核对点 | 判据 |
| --- | --- | --- |
| 1 | 版本生效 | `GET http://127.0.0.1:3080/__webcode/status` → `build.version` = **0.15.3** |
| 2 | **设置页不再空白**（缺陷 ①） | 设置 → 「网页桥接」栏目能渲染出账户、花名册、模型、提示词各卡片 |
| 3 | **花名册能读到**（缺陷 ②③） | `subAgentsError` 不再含 `no-session-id`；有子代理/Team 成员时列表真的列出；空时显示「当前没有正在运行的…」而非「读不到」 |
| 4 | 0.15.2 遗留项 | 长思考任务应在 ≤180s 内收束并交回 `THINKING_ONLY_NO_ANSWER`；正常长回复不被腰斩 |

---

# 0.15.2 只出思维链卡死修复 + LoopX 移除 + 闸门转正

日期：2026-09-15。环境：Windows、Node v24.18.0。

**范围**：用户报的「长时间后只有思维链卡住，harness 端没有任何报错，没有下一步」；
LoopX 整体移除；注释闸门转阻断；CI/CD 与审查补强；`REPORT.md` 可修项收口。

## 离线验收（本次实跑，全部退出码 0）

| # | 判据 | 命令 | 结果 |
| --- | --- | --- | --- |
| A1 | 全量单测 | `node --test "test/*.test.mjs"` | **421 通过 / 0 失败**，`duration_ms 566724` |
| A1b | 完整测试链 | `pnpm test` | 退出 **0**（含 parse / M1 / bench-ci / artifacts-check） |
| A2 | 注释闸门 | `node scripts/lint-comments.mjs` | 退出 **0**，`error 0，warn 0`（122 文件） |
| A3 | 生成物卫生 | `node test-mock/artifacts-check.mjs` | 退出 0（3 生成物被忽略、4 源文件仍可跟踪） |
| A4 | 基准离线回放 | `node test-mock/prompt-bench.mjs --offline` | 退出 0（14/14） |
| A5 | 本地入口全量 | `node scripts/ci-local.mjs` | **4/4 PASS**（lint / artifacts / bench / test，569.6s） |
| A6 | 工作流 YAML | PyYAML 解析三个 workflow | 全部 OK，触发器与 job 名符合预期 |
| A7 | 打包 | `pnpm pack` | 产出 `dsh-webcode-bridge-0.15.2.tgz`（281,632 字节） |
| A8 | 包内容一致性 | `node scripts/verify-pack.mjs <tgz>` | **27/28 逐字相同**；唯一差异是 `packageManager` 被 pnpm 规范化剥离（逐字段 diff 证明 field diffs: 1，版本一致 0.15.2） |
| A9 | 双 profile 安装 | `node scripts/install-profiles.mjs <tgz>` | web **0.15.2** / headless **0.15.2** |
| A10 | 安装标记核对 | 逐文件 grep | 两 profile 均 True：`shouldSettleStalledThinking`、`answerDomLength`、`lastAnswerAt`、`thinking-only-settled`、`THINKING_ONLY_NO_ANSWER`、`thinkingOnlyNotice`、`projectRoster`、`proseSafeEnd`、`toolcall` |
| A11 | 安装副本字节一致 | sha256 比对 | web / headless 的 `lib/bench.js` 与工作树**逐字节相同**（改完代码重新 pack 的证据） |

## 本次新增护栏 `test/stall-settle.test.mjs`（15 项 = 12 判据 + 3 接线）

| 类别 | 用例 |
| --- | --- |
| 正向 | 到硬上限即收束；上限可配置；`>=` 而非 `>`；计时文案剥完长度为 0；计时文案后跟真实回答只算回答长度 |
| **反向安全线** | 正文持续产出 → **永不命中**（长回复不被腰斩）；上限 0/非法 → **判据关闭**（不是「立刻收束」）；缺 `lastAnswerAt` 基线 → 不收束；正文里出现「思考中」三个字是内容、不被剥掉；空输入不产生 NaN |
| **接线护栏**（3 项） | driver 把构造时的 `answerTimeoutMs` 透出到 status；缺省回落 180s（**不是 `undefined`**）；`0` 被保留为「显式关闭」而非被 `\|\| 默认值` 吃掉 |

> 其中「缺基线」一条抓到一个真 bug：`Number(null)` 是 `0` 且 `Number.isFinite(0)` 为真，
> 只判 `isFinite` 会把缺失时间戳读成「epoch 0」＝「已等一万年」，于是每轮缺字段时
> 第一个 tick 就判死——**比不修更坏**。已改为同时挡 `<= 0`。
>
> 三项接线护栏的来历：复查时发现 0.15.2 **最初漏接了配置** —— 只在
> `browser-driver.js` 加了默认值，而 `index.js` 既没在 `DEFAULTS` 声明、也没在两个
> `createBrowserDriver` call site 传进去。行为恰好是对的（driver 内部默认也是 180s），
> 但**配置层够不着它**：想调这个上限的人会发现自己改的值没有任何效果。
> 这类「静默不生效」不会让任何断言变红。判据因此刻意选「传进去能不能读到」，
> 而不是「默认值等于多少」——前者抓「加了配置项但忘了接」这一整类。

## 顺带修复（读码时发现，非本次目标）

| 缺陷 | 后果 | 修法 |
| --- | --- | --- |
| `index.js` 收尾分支 `assertNonEmpty(out, '', [])` 第二实参写死空串 | 「思考全文都在、正文为空」被判成 `empty response`，**归因线索被抹掉** | 改为交回带现场的 `THINKING_ONLY_NO_ANSWER` 提示，与 `TOOL_UNKNOWN` 同型，任务继续而非整轮作废 |
| `emitText` 写死 `index: 0` | 工具轮里思考块已占用 0，收尾再写 0 与**已关闭**的 reasoning 块撞下标 | 改为显式传 `nextIndex` |
| `scripts/ci-local.mjs` 的 `test` 步在 Windows 上从未跑通 | `spawnSync pnpm.cmd EINVAL`（Node 修 CVE-2024-27980 后 `shell:false` 不能 spawn `.cmd`）——**安静地坏了很久**，因为该脚本不在 CI 里跑 | 该步配 `shell:true`；**并把 `ci-local --fast` 加进 CI**，使这类问题当天就暴露 |
| `answerTimeoutMs` 只在 driver 一侧有默认值，`index.js` 没声明也没传 | 行为恰好正确（内部默认也是 180s），但**配置层够不着**——想调这个上限的人会发现改的值毫无效果 | `DEFAULTS` 声明 + **两个** `createBrowserDriver` call site 都传；补 3 项接线护栏钉住 |

## LoopX 移除（已执行并核对）

删除清单（全部在仓库外，本仓库零代码引用、零活动配置引用）：

| 项 | 体积 |
| --- | --- |
| `~/.agents/runtime/dsh-loopx-plugin`（2272 文件） | 104.92 MB |
| 7 个 `loopx*` skill | 0.31 MB |
| 3 个锁/安装记录文件 | ~2 KB |
| **合计** | **约 105.22 MB** |

**删除后核对**：`skills/` 下 loopx 条目 **0**；运行时目录**不存在**；
**其余 85 个 skill 目录完好**（证明未误删）；会话技能目录里 7 个 `loopx*` 已消失。

## 重启后的真机核对（2026-09-15 22:50）——**查出一个 P0，已修并复验**

重启后按上表逐项核对，**第 1 项就不过**：`build.version` 确实是 0.15.2，但 `/__webcode/status` 同时返回

```json
{ "subAgents": [], "team": [],
  "subAgentsError": "roster-threw: projectRoster is not defined",
  "teamError":     "roster-threw: projectRoster is not defined" }
```

### 缺陷：`lib/index.js` 引用了 `projectRoster` 却从未 import 它

| 项 | 内容 |
| --- | --- |
| 现场 | `lib/index.js:1755` `rosterOf: (sessionId) => projectRoster(ctx, sessionId)` |
| 根因 | 全文**没有** `import { projectRoster } from './roster.js'`；`git log -S "from './roster.js'"` 为空，即该文件**从未**导入过 roster 模块 |
| 引入点 | 0.15.0 主体 `ecd3e31`（feat(bench+roster)）加的花名册注入，import 漏了 |
| 为何不报错 | `projectRoster` 在**箭头函数体**里，创建时不求值 → 模块加载成功、33/33 测试文件全绿、`node -e "import(...)"` 也不炸 |
| 真实后果 | 只有真机 `/status` **真的调用**时才抛 `ReferenceError`，被 `web-control.js` 的 `try/catch` 降级成 `roster-threw: …` → `subAgents`/`team` 恒为空数组，**右栏面板永久空白**（与 0.14.9「写死空数组」的可见后果完全一致） |
| 修法 | 补 `import { projectRoster } from './roster.js';`（含一段说明为什么这行不能删） |

**为什么单测全绿却没抓到**：`test/site-mount.test.mjs` 直接 `createWebControl()`，没有走 `apply()`，
于是 `rosterOf` 缺省为 `null`，命中「roster-not-wired」分支——**没有任何测试跑过
「`apply()` → 真实 HTTP → `/__webcode/status`」这条路**。

### 新增两道护栏（先证明能抓到这个 bug，再修）

| # | 护栏 | 位置 | 反向验证 |
| --- | --- | --- | --- |
| B1 | 端到端接线测试：真实 `apply()` + 真实 HTTP + `/__webcode/status`，断言 `subAgents`/`team` 是数组且无 `roster-threw` | `test/wiring-roster.test.mjs`（新增，2 项） | **先跑出红**：错误文本与真机 `status` 完全一致（`roster-threw: projectRoster is not defined`），修复后转绿 |
| B2 | 安装时接线核对：装完当场用正则确认跨模块 `import` 真的在 | `scripts/install-profiles.mjs` 的 `verify()` | 用未修的旧 tarball 实测 → `⚠ web: v0.15.2 ✖ 接线断裂` + **退出码 1** |
| B3 | 发布闸门接线核对：pack 后确认 tarball 内的 import 存在 | `scripts/verify-pack.mjs` 的 `WIRING` 表 | 用 0.14.7 旧包实测 → `✖ 接线断裂：projectRoster 未从 ./roster.js 导入` + 退出码 1 |

> **顺带修掉一个「永远为红」的闸门**：`verify-pack` 此前对 `package.json` 恒报差异——
> `pnpm pack` 会剥掉 `packageManager` 字段。一个永远为红的闸门等于没有闸门，
> 真正的差异会藏在同一片红色里活下来（这次正是如此）。现改为**只豁免 `packageManager`
> 一个字段**（逐字段比对，其余任何差异照旧失败），并在输出里显式打印豁免项。

### 修复后的复验（全部实跑）

| # | 判据 | 命令 | 结果 |
| --- | --- | --- | --- |
| C1 | 新增护栏转绿 | `node test/wiring-roster.test.mjs` | **pass 2 / fail 0** |
| C2 | 全量单测 | 33 个测试文件逐文件跑 | **33/33 全绿**（本机 `node --test` glob 仍 `spawn EPERM`，故逐文件） |
| C3 | 重新打包 | `pnpm pack` | `dsh-webcode-bridge-0.15.2.tgz`（282,801 字节，23:47:45） |
| C4 | 包内容一致性 | `node scripts/verify-pack.mjs <tgz>` | **28/28 逐字相同**；`✔ 接线完好（1 项跨模块引用已钉住）`；退出 **0** |
| C5 | 装入真机 profile | `node scripts/install-profiles.mjs <tgz> --profiles web` | web **0.15.2**，退出 **0**，无接线告警 |
| C6 | **安装副本**真机等价复验 | `node .tmp/verify-installed-wiring.mjs` | 在 `~/.dsh/profiles/web/node_modules/…` 上真实 `apply()` + HTTP → `HTTP 200`，`subAgents: []`、`team: []`，`subAgentsError: "session-projections-unavailable"`、`teamError: "official-team-package-not-loaded"` ——**`roster-threw` 消失**，退出 **0** |

C6 是关键：它验的不是源码目录，而是 **DSH 重启后真正会加载的那份文件**。

### 仍需用户在重启后确认的项

| # | 核对点 | 判据 |
| --- | --- | --- |
| 1 | 版本生效 | `build.version` = **0.15.2** |
| 2 | **花名册不再空白**（本次修复的目标） | `subAgentsError` / `teamError` **均不含** `roster-threw`；右栏面板能列出成员而不是空白 |
| 3 | 本故障是否真修 | 复现原场景（长思考任务）。若再出现「只出思维链」：**不应**无限转圈，而应在 ≤180s 内收束并交回一条 `THINKING_ONLY_NO_ANSWER` 提示；`status` 里 `thinkingOnlyTurns` ≥1、`lastStalledSettle.reason` = `thinking-only-settled` |
| 4 | 未误杀正常长回复 | 正常长回答应完整输出，`thinkingOnlyTurns` **不增长** |
| 5 | 收束原因可读 | `status.driver.lastEndReason` 能区分 `finished` / `thinking-only-settled` / `partial-wip-settled` / `timeout` |
| 6 | 重启后无回退 | `conversationReplacedCount` 与 `sessionLostCount` 均为 0 |

### 重启前实测的当前真机状态（2026-09-15 19:53，**仍是 0.14.7**）

重启前的对照基线，重启后请拿同一组字段比对：

| 字段 | 值 | 判读 |
| --- | --- | --- |
| `build.version` | **0.14.7** | 旧版本，符合预期（安装不生效直到重启） |
| `recoveredTurns` | **6** | ⚠️ 本轮会话期间从 4 涨到 6 |
| `lastRecovered.reason` | **`stream_ended_before_finished`**，`status=WIP`，`chars=296` | ⚠️ 正是 0.15.2 要处理的那一族 |
| `conversationReplacedCount` | **2** | ⚠️ 本轮从 0 涨到 2 |
| `sessionLostCount` | 0 | 会话槽未丢 |
| `lastEndReason` | `finished` | 最近一轮正常收尾 |
| `landedId`（最近 12 条 navTrace） | 恒为 `c94e5f35…`，`replaced=false` | 落点稳定 |

### 22:50 复核（**安装了修复版之后、重启之前**）

| 字段 | 值 | 判读 |
| --- | --- | --- |
| `build.version` | 0.15.2 | 版本号已生效 |
| `subAgentsError` | `roster-threw: projectRoster is not defined` | **旧代码仍在进程里**——安装不生效直到重启，与预期一致 |
| `recoveredTurns` | 1 | 较 19:53 的 6 **归零后重新计**（进程重启过一次） |
| `thinkingOnlyTurns` | 0 | 期间未出现「只出思维链」 |
| `lastEndReason` | `finished` | 正常收尾 |
| `conversationReplacedCount` | 1 | 较 19:53 的 2 **减少**——同样是进程重启后的新计数，非回归 |
| `sessionLostCount` | 0 | 会话槽未丢 |
| `loginBasis` / `needLogin` | `input-fallback` / `false` | 登录态正常，无需重新登录 |
| `transport` | `playwright-edge` | 驱动形态符合预期 |

> **LoopX 移除的持久性复核**：`pnpm-workspace.yaml` 无 `patchedDependencies`、
> `state.json` 无 loopx 条目、`package.json` 无 loopx 依赖、`patches/` 下补丁已 `.disabled`——
> 重启后未回退。隔离副本里跑 `pnpm install` 退出 **0**，**未再出现 `ERR_PNPM_UNUSED_PATCH`**。

**两条必须说清楚的口径**：

1. **`recoveredTurns` 增长不必然是缺陷。** 它统计的是「网页没送 FINISHED、
   但正文已经解出来」的轮次，驱动把已有内容当本轮结果交出去（`stream_ended_before_finished`）
   并让下一轮续写。这是 0.13.x 就有的**有意的自愈**。它涨到 6 说明这个形态在真机上
   **相当常见**——这正是 0.15.2 要把「只出思维链」和「正文写完了没送 FINISHED」
   分开计数的原因：混在一起时，前者的现场会被后者的正常计数淹没。

2. **`conversationReplacedCount=2` 不等于「每轮新开对话」回归。**
   该计数只统计 `storedBefore && result.sessionId && storedBefore !== result.sessionId`
   （`browser-driver.js:1638`），即「导航回既有会话，但落到的 id 与存的不同」。
   最近 12 条 navTrace **全部 `replaced=false` 且 landedId 恒定**，说明当前落点稳定。
   两次发生在更早（保留窗口只覆盖 2.5 分钟），其现场已随 navTrace 环形缓冲滚出，
   **本轮无法归因** —— 如实记为「发生过 2 次，现场不可得」，不猜。

**未验证/不归因项**（不谎报，见 `REPORT.md` §F）：`no_response_frames` 逐字复现的根因
（需真机 SSE 抓包）、两次 `edit status=error` 的根因（日志错误体是 `[object Object]`）、
B-4 那条 29,650 字符消息的归因（`turn/end` 是 `aborted by user`，无法判定）、
豆包掉登录的真机复验（受风控约束，需人工择时）、GitHub Actions 的实际运行结果
（需一次真实 push）、以及上面第 2 条那两次 `conversationReplaced` 的具体现场。

**一条方法学教训（值得单独记住）**：这次漏接线能活到真机，靠的是三个恰好同时成立的巧合——
(1) 引用写在**箭头函数体**里（延迟求值）、(2) 唯一会触发它的路径是**真机 HTTP 调用**、
(3) 发布闸门**恒为红**（`package.json` 差异），于是真正的差异被淹没。
「有测试」「有闸门」都不等于「有覆盖」：**必须有人问一句「这条路有没有被真的走一遍」**。

---

# 0.14.5 会话日志归因修复 + 右栏对齐官方

日期：2026-09-14。环境：Windows、Node v24.18.0。

**范围**：由最近两次 harness 会话日志定位出的两个缺陷（超长提示词写入卡死、
`<tool_result>` 外壳漏进正文）、右栏按官方实测尺寸重排、发布流程收进仓库。

## 归因（先说结论从哪来）

新增 `test-mock/parse-session-log.mjs` 解析会话日志。**关键坑**：DSH 的
`session.v3.jsonl.zstd` 是**多帧拼接**的 zstd，`zstdDecompressSync(buf)` 只解第一帧
——1.3 MB 的文件解出 220 字节（那条 `{"type":"session"}` 头），看起来「日志是空的」。
上一轮会话连踩三次。工具按 zstd magic（`28 B5 2F FD`）切帧后逐帧解压。

```powershell
cd package\dsh-webcode-bridge
node test-mock/parse-session-log.mjs --recent 3 --errors-only
```

归因全文见 [session-log-review.md](session-log-review.md)。要点：

| 会话 | 事件 | 结局 |
| --- | --- | --- |
| `session-c710ef6e` | 1020 | turn 1 ✔ / **turn 2 ✖ error**（`locator.fill` 30s 超时） |
| `session-e02c4195` | 37 | turn 1 ✔，无产出（同题重开副本，无独立结论） |

## 离线测试

全套 **259 通过 / 0 失败**（逐文件 `node test/<f>`；`node --test` 在本机沙箱下
`spawn EPERM`）。本轮新增/扩充：

| 测试 | 例数 | 钉住什么 |
| --- | --- | --- |
| `test/composer-write.test.mjs` | 12 | 分块计划边界（恰好等于上限仍是 single、0 长度 0 块、非法配置走默认而非 clamp）；停滞判定（单块不涨**不得**判死富文本站点、连续两块才判死、回读 null 不计数不判死） |
| `test/protocol-leak.test.mjs` | +2（共 11） | `<tool_result>` 是**边界锚点**但**不是** transport 调用；不得被 parse 成 call |
| `test/client-render.test.mjs` | 6（改写 1） | 状态改色点后，四态仍必须能从 `title`/`aria-label` 读到；长状态文案**不得**再出现在可见文本里 |

## 真机取证（写进代码注释的原始证据）

### P0 超长提示词写入卡死

`session-c710ef6e` 的 turn 2 终局，逐字：

```
locator.fill: Timeout 30000ms exceeded
  - waiting for locator('textarea.ds-scroll-area').first()
  - locator resolved to <textarea rows="2" name="search" … placeholder="给 DeepSeek 发送消息 ">
  - fill("# 可用本地工具…(+807789)
```

807,789 字符一次性交给 `fill()` → 网页侧整段卡住 → 30s 超时，且卡住期间无中间态可读。
修法：`composerWritePlan`（single/chunked）+ 块间回读 + `stallStep` + 错误码
`PROMPT_WRITE_STALLED`（带已写/总长度与元素现场）。

### P1 `<tool_result>` 漏进正文

同一会话 `assistant/message` seq=587，三个 text 块逐字带外壳：

```
block 9  len=198  <tool_result>\n{"mcp_action":"result","name":"edit",…
block 11 len=200  </tool_result>\n{"mcp_action":"result","name":"write",…
block 13 len=891  </tool_result>\n{"mcp_action":"result","name":"read",…
```

修前/修后探针（`findProtocolStart`）：

```
"<tool_result>"       -> index=-1   →   index=0
"</tool_result>"      -> index=-1   →   index=0
"普通正文"            -> index=-1        index=-1（不变）
"if (a) { return; }" -> index=-1        index=-1（不变）
```

## 发布流程（本轮新增，都是真实踩过的坑）

| 脚本 | 解决什么 |
| --- | --- |
| `scripts/verify-pack.mjs` | 0.14.4 曾「改了 mirror.js 但没重新 pack」，装上去是旧代码；现在逐文件 sha256 比对并打印「N/M 逐字相同」 |
| `scripts/install-profiles.mjs` | pnpm 对**同版本号** tarball 判「Already up to date」不重解；现在先删旧目录再解包 |
| `scripts/tar.mjs` | 沙箱拦 spawn（`EPERM: spawnSync tar`），发布脚本不能依赖系统 `tar`；纯 Node 解 ustar（含 pax） |

本轮实测：

```
[verify-pack] 逐字相同 25/25   ✔ tarball 与工作树一致
web:      version=0.14.5 same=25/25 diff=0 missing=0
headless: version=0.14.5 same=25/25 diff=0 missing=0
  lib/browser-driver.js contains "PROMPT_WRITE_STALLED": true
  lib/agent-preset.js   contains "tool_result|tool_results": true
  lib/client.cjs        contains "hwb-toolbar": true
  lib/index.js          contains "composerChunkChars": true
```

tarball：`dsh-webcode-bridge-0.14.5.tgz`，232,637 B，25 个文件。

## 待真机确认（本轮未做，需人工择时）

1. **重启 DSH 后**右栏新布局目视核对（官方尺寸：28px 控件 / `.5px` 边框 / 24px 卡片圆角 / 15px·13px 排版）。
2. **composer 分块写入**在真机上不再出现 30s `locator.fill` 超时；若仍超时，应给出
   `PROMPT_WRITE_STALLED` 与已写进度（而不是光秃秃的超时）。
3. 豆包掉登录的真机复验（0.14.4 修复项；间隔 ≥20s、最多 3 次，避免触发风控）。

---

# 0.14.4 掉登录修复 + 等待时长 + 右栏多开

日期：2026-09-14。环境：Windows、Node v24.18.0、pnpm 11.25.0。

**范围**：豆包「登录后右侧打开网页会掉登录」的根因修复（`Set-Cookie` 两个消费方向
按 RFC 6265 重写）、等待发送时长的本会话与累计统计、右栏滚轮/多开/风格统一、
两项安全审查欠账（导入白名单、状态文件权限）。

## 离线测试

全套 **249/249**（`node --test "test/*.test.mjs"`）。新增两套：

| 测试 | 例数 | 钉住什么 |
| --- | --- | --- |
| `test/cookies.test.mjs` | 25 | 删除指令不得写成空值；`__Secure-`/`__Host-` 必须保住 `Secure`；镜像合并时 profile 优先 |
| `test/wait-stats.test.mjs` | 18 | 本会话与累计同口径；未等待的轮次不进平均值分母；时长格式四档 |

同时修掉两处**测试自身**的问题：

1. `test/mirror.test.mjs` 的旧断言 `doesNotMatch(setCookie, /Domain=\|Secure\|SameSite=None/i)`
   把「剥掉 Secure」钉成了期望行为——**它锁的正是本次修的 bug**。已改为
   「Domain 去掉、SameSite=None 收敛、Secure 必须保留」。
2. `test/tool-loop.test.mjs` 不传 `profileDir`，于是读**用户真实**设置
   （`sendGapMs: 30000`），退避取 `max(sendGapMs, backoffMinMs)` 变成 30s+30s+60s，
   撞上 120s 适配器看门狗 → 用例报 `WEB_NO_PROGRESS` 而不是 `RATE_LIMITED`，
   即**看环境脸色**。已改用一次性临时 profile。

## 真机长跑（新会话，未干扰本对话）

在**复制出来**的 profile 上跑 `test-mock/run-real-longrun.mjs`（1.19 GB 副本，
原 profile 由运行中的 DSH 持有，全程未杀任何 `msedge.exe`）：

```
LONGRUN RESULT: PASS
turns: 5（4 轮工具循环 + 1 轮无工具回忆）
sessionKey 五轮恒为 longrun-mu0d39jz
fresh 逐轮 = [true, false, false, false, false]  → sameConversation: true
轮1 tool-calls list_dir（1 调用）
轮2 tool-calls 19× count_lines（真实文件）
轮3 tool-calls write_report → written 675 bytes
轮4 stop（最终答复）
回忆轮 答出 9698 == truthTotal 9698  → 同一网页对话内的跨轮记忆成立
deltasMatch 四轮全 true（无 STREAM_REWRITE、无协议文本泄漏）
RATE_LIMITED 0 次 · WEB_SESSION_LOST 0 次 · sessionLostCount 0 · 超时 0 次
发送间隔实际生效：waiting 29s / 25s / 27s / 29s（目标 30000ms，send-to-send）
```

这是「已有登录状态可长期无外部干扰跑真实任务且不触发风控」的**本轮直接证据**。
报告：`package/dsh-webcode-bridge/.tmp/longrun-report.md`（675 B，由网页模型自己
通过真实 `write_report` 工具写出）。

## 待重启核对

当前运行的 DSH 仍是内存里的 **0.14.3**（`hash ad4bf2efa6e0`）；两个 profile
（web / headless）都已装 **0.14.4** 并逐项核对（`cachedProfileCookies` 与
`permittedImportRoots` 均在）。重启后应核对 `build.version === '0.14.4'`。

> 安装踩坑（本轮新增）：**同版本号重打包后 pnpm 会判「Already up to date」而不重新解包**，
> 于是 `node_modules` 里留的是旧 tarball 的内容（`mirror.js` 缺 cookie 缓存）。
> 必须显式删掉 `node_modules/dsh-webcode-bridge` 再 add，或改版本号。

---

# 0.14.3 真机复验与两个新 bug 修复

日期：2026-09-14。环境：Windows、Node v24.18.0、pnpm 11.25.0、DSH 已重启。

**范围**：0.14.2 全部内容 + 真机复验暴露的两个 bug（登录判定只看个数不看可见性、
「已在目标会话上」用 URL 前缀判断），外加风控页单独成一态。

## 复验怎么暴露的问题（0.14.2 → 0.14.3 的关键一课）

0.14.2 装了、重启了、**单测 23 文件全绿**，`build.version=0.14.2`、
`hash=2c3d4df106c3`（旧 `ab0fdf766a5d`）——但 GLM 第二轮**仍然失败**，
只是失败方式换成了 `locator.fill: Timeout 30000ms exceeded`。

| 复验项 | 0.14.2 当时 | 结论 |
| --- | --- | --- |
| 版本核对 | `version=0.14.2`，hash 变化 | PASS |
| B-3 窗口可见性 | `glm/zai: window=1000000 consistent=true sources=declared` | PASS |
| C 会话身份 | `result.sessionId` 非 null、store 非 `{}` | PASS（身份部分） |
| C 续聊 | ✖ `fill` 超时 30s | **FAIL → 0.14.3 修** |
| F（`:8931` 间隔） | `gapTargetMs=10000`（修前 0） | PASS |
| A-4b（重启后首轮） | `sincePrevSendMs=183820`，基准时刻早于重启时刻 | PASS |

## 两个新 bug（probe-26/27 定位）

1. **`judgeLoggedIn` 回退判定只数个数、不看可见性**。导航到 `?cid=` 时 GLM 返回阿里云
   滑块验证页（title「滑动验证页面」），页面上 3 个 textarea 全是**隐藏**的 WAF 脚本
   模板（`CF_APP_WAF` / `renderData` / `aliyun_waf_*`）→ `count() > 0` 判成
   「已登录 + 输入框在」→ 继续 `fill` → 30s 超时。
2. **「是否已在目标会话上」用 URL 字符串前缀**。站点把地址补成 `?lang=zh&cid=X`
   （首轮真实落点），桥拼的目标是 `?cid=X` → `startsWith` 判为不同 → **白白整页重载**，
   而重载正好撞风控页。

修法：`visibleComposerCount()`（逐元素查可见性，且**遍历全部候选选择器**——GLM 的真实
composer 是裸 `<textarea>`，只认第一个候选会漏掉它、把正常页判成未登录）；
`detectChallenge()`（认验证页文案 + WAF 指纹，在登录判定**之前**）；
resume 分支改用**会话 id** 比较；新增 `navReason='challenge-page'` 把风控与
「会话过期」分开报。

## 0.14.3 真机复验结果

```
GLM 连续性（probe-26，修复后）：
  第一轮  sessionId = 6aa6ff186112d633ae83e731   会话槽已写入
  第二轮  ✔ 未抛 WEB_SESSION_LOST，正文「好的」
          cid 首轮 = 次轮（逐字相同）→ 同一会话 ✔
          sessionLostCount = 0

A-4b（重启后第一轮发送间隔）：
  重启后首轮 sincePrevSendMs=183820 → 基准时刻 03:43:19 < 重启时刻 03:43:55
  → 证明基准确实从 webcode-send-state.json 读回（不是进程内存）

F（OpenAI 兼容路径）：
  POST :8931/v1/chat/completions（glm:glm-5.3）→ HTTP 200，gapTargetMs=10000
```

## 产物

| 项 | 值 |
| --- | --- |
| tarball | `package/dsh-webcode-bridge/dsh-webcode-bridge-0.14.3.tgz`（211106 B） |
| SHA256 | `FA013F1176DB7D11CB3FAF301435BAB5BFFE994DA40CE59DF264B6B6F38520BC` |
| 包内文件数 | 23 |
| 逐文件 SHA256 | **22/23 与工作区逐字相同** |
| 唯一差异 | `package.json` —— pnpm 打包时移除 `packageManager` 字段（内容等价） |
| `web` profile | 0.14.3，**23/23 与 tarball 逐字相同**，备份 `package.json.bak-0143` |
| `headless` profile | 0.14.3，**23/23 与 tarball 逐字相同**，备份 `package.json.bak-0143` |

## 测试

| 项 | 结果 |
| --- | --- |
| `test/*.test.mjs`（23 个文件） | **全绿，0 失败** |
| `test/regression.test.mjs` | **51/51**（+4：可见 composer、候选遍历、风控页顺序、会话 id 比较） |
| `test/parse.test.mjs` | 22 passed, 0 failed |
| `test/run-m1.js` | **M1 RESULT: PASS** |

## 本轮事故（已恢复）

probe-26/27 反复深链同一个 `?cid=` 之后，GLM 对该 profile 的**根路径**也开始返回风控页，
probe-26 第二次重跑在 fresh 分支就 `NEED_LOGIN`。probe-28 诊断：

- **登录态完好**：`chatglm_token` / `chatglm_refresh_token` / `chatglm_user_id` 均在（cookie 共 9 枚）；
- **风控是暂时的**：20s 间隔重试三次，三次都回到正常的「智谱清言」页（可见 textarea 1 个）。

教训：**反复深链同一会话地址会触发站点风控**，探针要节制；且风控页 ≠ 未登录。

## 待做

重启后按 0.14.3 再核对一次 `build.version === '0.14.3'`，并按
`PLAN-0.14.0-HANDOFF.md` §0.0 的短清单收尾（GLM 连发两轮、`:8931` 间隔、A-4b）。

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

1. **`pnpm install` 曾被一个无关依赖整死，并顺带删掉我们的包。** 该依赖指向 GitHub
   release tarball，安装时报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` → `TypeError: fetch failed`，
   整体失败；而我们先 `Remove-Item node_modules/dsh-webcode-bridge` 再装，于是包被删掉却没装上
   （`node_modules/dsh-webcode-bridge` 消失）。**解法**：
   `$env:NODE_OPTIONS='--use-system-ca'`（Node 24 用系统证书库），一次通过。
   这是本机 Node 证书链与 GitHub 的兼容问题，**与本插件无关**。
   教训：清目录 + 安装这条路径在依赖坏了的时候会把「已装」变成「没装」，
   失败后必须**立刻核对 `node_modules`**，不能只看退出码。
   > 0.15.0 更新：那个无关依赖（`dsh-loopx-plugin`）已被用户决定**整体舍弃**并从
   > web profile 移除，证书问题随之消失。本条保留作为**通用教训**——只要还有任何一个
   > 依赖走 GitHub tarball，同一条路径就会再踩一次。
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