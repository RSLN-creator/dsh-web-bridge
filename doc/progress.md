# 进度台账（进仓库）

**为什么这个文件存在**：2026-09-14 的会话在收尾前被中断，而它的进度只写在
`PLAN*.md`（本地私有留痕、不在仓库），导致下一次会话必须从头 recon 一遍。

`doc/README.md` 已经规定了「根目录 `PLAN*.md` 是本地私有留痕」——那条约定是对的，
缺的是它的**对偶**：仓库里必须有一份「当前走到哪、下一步是什么」的台账。这就是本文件。

约定：

- 每完成一项即更新这里；跨会话恢复以本文件 + `PLAN.md` 为准，不依赖会话记忆。
- 状态以本文件为准，**缺陷与「为什么不现在修」以 `long-term-issues.md` 为准**。
  一份写「现在在哪」，一份写「还欠什么」——两边都不复制对方的结论。
  （2026-09-16：原先这条写的是与 `session-log-review.md` 的分工，那份归因报告已按
  用户指示删除；错误码与归因现落在 `bridge-failure-ledger.md`。）

---

## 0.19.0 第四轮（用户三点复查，2026-09-22 晚）

用户原话：「① 质谱清言等网站的登录没问题，但是回点击直接打开 deepseek? ② 请你全面
审查 0.19.0 的逻辑修改！确保功能正常！③ 请你看看任务版那里为什么没有设置开始时间
等功能的？」

| 项 | 内容 |
| --- | --- |
| **① 根因已定位并修复（阻断级，用户可见）** | 「点开站点直接变成 DeepSeek」的机制是 `client.cjs` 的 `Conversation` 挂载副作用：`winState().then(w => { const open = Object.keys(w?.windows || {}); if (alive && open.length && !open.includes(siteId)) setSiteId(open[0]); })`——**无条件**把当前站点换成「第一个开着独立窗口的站点」。DeepSeek 的窗口是常驻的（`GET /__webcode/window` 实测 `windows.deepseek.open=true`），于是挂载任何别的站点标签都会被顶成 DeepSeek（`siteBase('deepseek')` 就是中继根）。**登录一直是好的**（走的是另一个控制面动作 `POST window {action:'open'}`，与这条无关），两者组合正是用户观察到的现象。这段是 0.11.0 单站点时代的遗留：那时面板只显示一个站点、跟着窗口走是对的；0.16.35 起站点由标签自己的 `navigation.params` 决定，它就从「合理」变成了「推翻用户明确的选择」。**修法**：只在 `!controlledSite`（不受控用法：首屏网格 / 分屏）时才采纳窗口站点；受控标签一律尊重自己的 `siteId`。护栏加在 `client-render.test.mjs`（含反向验证：恢复旧写法 → fail 1）。 |
| **② 阻断级真缺陷：`MultiModelCompareView` 的 `pendingRef` 写在事件处理器里（0.19.0 自己引入）** | 第三轮为修「发送锁永不解开」引入的 `const pendingRef = React.useRef(0)` 被写在 **`handleSendAll` 的函数体内**——那是**事件处理器**，不是渲染期。真实 React 在渲染之外调用 hook 会抛 `Invalid hook call`：**点一次「同时发送」整块并列多会话视图就炸，一列都发不出去**，比它要修的「按钮锁死」更重。**887 条单测为何全绿**：`client-render.test.mjs` 的 React 桩是 `useRef: (init) => ({current: init})`（在任何位置都工作，结构上察觉不到 hooks 规则），而 `team-compare.test.mjs` 的判据只断言源码**文本存在** `const pendingRef = React.useRef(0)`——写在事件处理器里同样满足。**修法**：声明移到组件体顶层（与 `seqRef`/`aliveRef` 并列）。**取证**：`.tmp/prove-pendingref.cjs` 按花括号深度走查，修复前 `pendingRef` 深度 **2**（嵌套函数体内），`seqRef`/`aliveRef` 深度 **1**；修复后 **1**。**护栏改为按「位置」判**（深度必须为 1，并附 3 条对照：其它 ref 在 1、`handleSendAll` 定义在 1、累加语句在 2——判据自身必须能区分「顶层」与「嵌套」，否则是恒真的装饰品）。**反向验证**：搬回事件处理器 → **FAIL(1)**，还原 → 10/10 PASS。 |
| **③ 任务板没有「设置开始时间」的根因：从来没做，不是坏了** | 参考实现 `reference/dsh-task-board` 的 `NewTaskModal` 有 schedule(cron) / mode / permission / model / reuseSession 一整套，`TaskDetail` 还有执行历史（`execution.startedAt`）；而本桥 0.17.3 移植任务板时**只搬了 subject/description/model/projectId/writeScopes**：`lib/task-ledger.js` 的 `mintTask` 行里**没有任何排期字段**，`client.cjs` 里 `开始时间`/`schedule`/`cron` 全文零命中——界面没有输入框、台账没有落脚字段，所以「设置开始时间」无处可设、也无处可存。用户 2026-09-22 的原话本来就把这条列为需求：「功能我要能够实现 graph 布置任务，**设置接任务智能体和时间**，以及**模式，权限**等等等详细的」。 |
| **③ 已补：开始时间 / cron / 模式 / 权限 / 复用会话（三跳齐全）** | 用户 2026-09-22 原话：「功能我要能够实现 graph 布置任务，**设置接任务智能体和时间**，以及**模式，权限**等等等详细的」。**落地**：<br>· `task-ledger.js` 新增 `scheduleOf()`（`schedule.{enabled,cron,startAt,nextRunAt,lastTriggeredAt}` + `mode`/`permission`/`reuseSession`），`mintTask` 与 `applyUpdate` **共用同一个归一函数**（各写一份必然漂移）；`rowsOf` 把新字段与一直存在但**从未被界面渲染**的 `createdAt`/`updatedAt` 一并透出。<br>· `web-control.js` 的 `POST task-create` 透传这 5 个键（不透传 = 界面填了、服务端丢掉 = 静默失败）。<br>· `client.cjs`：新建弹窗加原生 `<input type="datetime-local">` + cron/模式/权限/复用会话；**详情页同样可改**（只在新建时能设 = 半个功能），并显示创建/更新/下次触发时间。<br>**踩到并修掉两个自己写的坑**：① `Number.isFinite(Number(null))` 为真 ⇒ `nextRunAt:null` 被读成 **0**（界面会显示 1970/1/1）——改用 `msOrNull()` 同时挡 `<= 0`（与本项目 `stall-settle` 上记过的 `Number(null)` 陷阱同源）；② `applyUpdate` 的合并若把旧 `enabled:true` 一起摊进去，用户清空开始时间与 cron 之后那条任务会**永远停在「有排期」**（一个再也关不掉的排期）——改为 `enabled` 由合并后的 `startAt`/`cron` **重新算**。<br>**护栏**：`team-compare.test.mjs` 新增「界面 → 路由 → 台账**三跳齐全**」（本仓库记过多次「说做了、其实没做」，只钉一跳时另两跳断掉照样全绿）与「本地时间回显不得用 `toISOString`（会把时间漂 8 小时）」；`task-ledger.test.mjs` 新增 4 条（建时存住 / 改时存住 / 行带得出去 / 非法值回落而非抛错）。**反向验证**：路由去掉 `schedule` 透传 → **FAIL(1)**；回显改 `toISOString` → **FAIL(1)**；还原 → 全绿。 |
| **② 独立审查（server 侧）抓到的一条 HIGH：任务台账有两份「根」** | `task-*` 路由原先各自内联 `body?.workspaceRoot \|\| config.workspaceRoot \|\| process.cwd()`（**7 处**），而任务投影那一侧（`roster.js projectTasks`）用的是 `cwdOf(ctx, sessionId)`＝**会话的工作目录**。两者可指向两个不同的 `.webcode-tasks/ledger.json`，同一块界面上任务板与花名册各拿一份、互不可见。且 `config.workspaceRoot` 在仓库里**从未被赋值**、`workspaceRoot` 也**从未被任何随包客户端发送**，所以路由侧恒定落到**宿主进程 cwd**。**已收口**：新增唯一解析器 `taskRootOf()`（显式 → config → `resolveWorkspaceRoot()` 注入 → cwd），新增 `roster.workspaceRootOf` 导出供 index.js 注入同源解析器，`GET task-ledger` 增加 `workspaceRoot` 字段**如实回显实际读的那一份**（把「读的是哪份台账」变成可核对读数）。护栏加在 `control-routes.test.mjs`（源码不得再内联该表达式，且写出/读回必须落在同一个根）。**遗留收口项**：控制面请求里**没有**会话身份（客户端调 task 族端点不带 body），因此 index.js 只能用「最近一次被投影的会话」做根——**「客户端把 sessionId 传上来」尚未做**，在它落地前两侧仍可能不同源。 |
| **③ 独立审查（server 侧）另两条已核实但未改** | ① `roster.js` 的 `if (svc.tasksError === null && svc.tasks.length > 0)`：新增的 `length > 0` 让「官方服务可用但确实没有任务」这一**权威空答案**跌进台账分支，一份陈旧 `ledger.json` 会静默盖住它（旧行为是短路显示「没有任务」）。② `roster.js` 新发的 `source: 'ledger'` 在客户端 `sourceText()` 里**没有映射**（只认 `service`/`disk`，其余回 null = 不渲染），因此最常见的那条来源反而没有出处标注。两条都是真实的口径缺口，处置属产品决定，本轮**如实记录未改**。③ 另：`index.js` 的 `transportNoteFor` 现为**死导入**（`teachFor` 已取代两处调用）——与 0.19.0 自己删掉 `tool-parser` 死导入的判据同源，建议下一轮一并清掉。 |

---

## 0.19.0 对账 262 原始诉求（2026-09-23 晚）

| 项 | 内容 |
| --- | --- |
| **对账前全量基线（T0 取真读数）** | 改动落地后串行跑 `node --test test/*.test.mjs`：**898 项、897 通过、1 失败**。失败为 `control-routes.test.mjs:216`（真实 HTTP 端点 `fetch failed`），**单独重跑 14/14 全绿** —— 并发下真实 HTTP/计时用例争用误报，非代码缺陷（本文件已记同型判据：全量须串行独占，并发红不算）。改动相关测试（client-render 81 + control-routes 14）**95 项全绿**。 |
| **T1 对账 262 点 3：任务展开面板「按评论派发」完整闭环** | 逐链核对 `client.cjs` `onImplement`（L1252）→ `POST task-implement` 组装 prompt（web-control.js:1245）→ `POST chat` 投递（带 `task.sessionKey` 落到该任务自己的会话）→ `verdictOf` 如实分派。`pendingRef`（L2385 组件体顶层声明、L2480/2515-2517 计数）与详情页 `boardNotice`（L1082/1190/1364）两处出口均在。**结论：闭环完整，只记读数不改**（plan 要求）。 |
| **T2 对账 262 点 2：风控纪律穷尽性** | 风控纪律「探针间隔 ≥20s、单站 ≤3 次、命中风控页立即停」**权威出处是 `doc/bridge-failure-ledger.md §3`**（0.14.3 事故实证），`PROJECT-INTENT.md` / `UNDERSTANDING.md:258` / `ROADMAP.md:63` 均有记录；README 讲的是「风控页单独成一态」（识别逻辑）。**更正本 plan 一处笔误**：plan 写「README 已写死」，实际纪律在 doc 层。多站点真机矩阵 3/5 已登录、逐站 20s 间隔已跑。**跨站优先级队列=独立功能，按 plan 明确不做**。 |
| **T3 落地两处小改（对账列出的历史缺口）** | ① `client.cjs sourceText()` 补 `src==='ledger'` 映射（roster.js `projectTasks` L352 落库回落发 `source:'ledger'`，此前无映射 → 路基任务板**最常见来源反而无出处标注**）；② `index.js` 第 25 行删死导入 `transportNoteFor`（已被 `tool-transport.js teachFor` 纯委托取代）。**护栏**：client-render.test.mjs 补「ledger 映射 + 服务端 source 键」双断言（含反向验证；三刀提交前子 agent 独立审查确认两处改与护栏均正确、无误匹配）。 |
| **T4 分刀入库 0.19.0（git status 清零）** | 刀1 `feat(bridge)`（b4c7ec3，lib 12 文件 +2548/-378）；刀2 `test(bridge)`（cad8d2a，6 文件 +1426）；刀3 `docs(bridge)`（71ad794，doc/reference 6 文件 +644）。每刀独立可 `git revert` 单刀回滚；提交前过 `lint-comments`（0 error/0 warn）。`.trae/` 为 gitignore 私有留痕，不入库。 |
| **对账声明的本轮不做项** | ① 跨站优先级队列（独立功能扩展，需单独一轮）；② 控制面 task 请求带 sessionId 上传（遗留收口项）；③ 官方 agentTeams「有权限但空任务」被旧台账盖住的权威语义修正（产品决定）。均已记录不越界。 |

## 0.19.1 打包安装（2026-09-23）

| 项 | 内容 |
| --- | --- |
| **范围** | 0.19.0 的边界1/2 澄清落地（未登录放开闸 `shouldGuide` 恒 false、设置页浏览器区纯内置 Chromium 文案、登录动作收口 `POST window {action:'open'}`、并列多会话/任务板对齐官方 primitives）+ 用户「这两个你没做啊！！做了打包安装！」的明确指示。 |
| **全量回归** | `node --test "test/*.test.mjs"` **exit 0 全绿**（898 项基线；本轮复跑 602 项零失败时无残留 node 进程争用）。先清掉了上一会话遗留的 node 进程（2:51 启动、会争用真实 HTTP 端口造成 `control-routes` 并发误报——本文件 §0.19.0 对账行已记同型判据：全量须串行独占）。 |
| **打包** | `pnpm pack` → `dsh-webcode-bridge-0.19.1.tgz`（package.json version 已从 0.19.0 升 0.19.1）。 |
| **安装** | `scripts/install-profiles.mjs` 装入 **web / headless 两 profile 均 v0.19.1**。 |
| **声明回退防护（关键）** | `install-profiles` 绕开 pnpm、不改声明 → 启动期 reconcile 会按 lockfile 把 `node_modules` 回退成声明里的旧版本（本文件 §0.16.10 七已记第三次踩坑）。**本轮已手工把两 profile 的 `package.json` 依赖与 `pnpm-lock.yaml` 的 specifier/version 全部同步到 0.19.1**，核对三方一致：声明=0.19.1.tgz / 已装=0.19.1 / lockfile=0.19.1.tgz。重启 DSH 后不会回退。 |
| **未完成项** | 需重启 DSH 才生效（当前进程仍是旧代码）。重启后按 `doc/verify.md` 真机核对：未登录站点直接挂载网页（不再引导页）、设置页浏览器卡片只显示「桥内置浏览器」、登录窗口入口统一。 |

## 0.19.1 合规审计 + git release（2026-09-23 第二轮）

| 项 | 内容 |
| --- | --- |
| **范围（用户原话）** | 「① 全面进行项目合规--对比最新版本，插件要求进行审批，**不要改动代码文件**；② 提价 git realse」。①的交付物是 `doc/compliance-audit-0.19.1.md`；**代码文件一行未改**（`lib/` / `bin/` / `test/` / `cordis.patch.yml` 全未触碰）。 |
| **对标基线的真读数（修正一个容易踩的口径）** | `npm view @deepseek-ai/dsh dist-tags` 实测：`latest=0.1.5-rc.2` / `next=0.1.5-rc.3` / **`alpha=0.1.7-alpha.2`**。**官方 `latest` 比本机实装的 `0.1.6-alpha.2` 更旧**——「对比最新版本」的正确基线是 alpha 线的 `0.1.7-alpha.2`（源码形态，`reference/deepseek-harness` HEAD `00102833d`），不是 `latest`。追 `latest` 等于回退。 |
| **「审批」的审计结论：本插件零自造** | 官方审批是一个**闭合且 fail-closed** 的接缝：结果词汇 `allowed-once`/`rejected`/`cancelled`/`unavailable`（只有 `allowed-once` 放行）、会话策略 `ask`/`never`（`never` 在服务内部、waterfall 派发**之前**强制，后注册的 `prepend` 应答者也绕不过）、`approval/asked`+`approval/decided` 成对写会话日志且 log-only 不进模型转写。**本插件的所有工具执行与插件管理都走官方**，桥侧唯一的「同意」是浏览器自动化的部署级 `requireConsent`（自家领域开关，走官方设置页），不是工具权限审批。 |
| **抓到并修掉的不合规项 ①（阻断）** | `reference/README.md` 的来源表与磁盘不一致：`node scripts/gen-reference-index.mjs --check` 退 1 → `ci-local --fast` **6/7 步**（唯一红步）。差异两处：`deepseek-harness` 的 HEAD 写 `ddefc45…` 而磁盘是 `00102833…`（已 pull 到 0.1.7-alpha.2）；表里**缺** `dsh-official-plugins` 行（目录在磁盘上）。表是生成物，磁盘变了没人重跑生成器——本项目记为「生成物漂移」的同型事故。已按生成器口径回写，并同步更正三处**人写**汇总：`34 个 clone` → **37**、`316 MB` → **978.9 MB**、§6 违例 5 条 → **8 条**（`local-refs` 故意不算）。复核 **exit 0**（校验 46 个存在的条目）。 |
| **抓到并修掉的不合规项 ②（一般）** | `.trae/documents/*.md`（本轮对账草稿，性质同 `.local-plans/`）**没有** `.gitignore` 规则，`git status` 长期挂着未跟踪条目——本项目已因同型问题踩过两次（`.webcode-tasks/`、`.local-plans/`）。已补规则 `.trae/` 并写下理由（gitignore 按路径匹配，父目录规则不覆盖嵌套同名路径）。 |
| **记录不修 ③（产品决定）** | 官方「浏览器插件审批」与 dependency build-script approval 是两条不同语义；本插件不用浏览器扩展链路（`extension/` 已于 2026-09-16 归档），与这一层无交集，如实记录不越界。 |
| **能力差逐条给了理由（不是漏做）** | `dsh-client-ui-approval`（本插件不产生审批请求，没有可呈现的东西）、`dsh-authorization`（本插件的凭据是站点登录态，映射过去只会造出假 flow）、`dsh-experimental-auto-review`（它是权限预设消费者，本插件再判一次＝第二套审批）、`dsh-client-ui-plugin-manager`（内部再做一套会与官方页面抢 profile 写锁）、`./invariant`（无可独立观测的状态投影）。 |
| **闸门读数（本轮实测）** | `ci-local --fast` 全部步骤 PASS（修完 ① 后）；全量 `pnpm test` **exit 0**（前台 9 分钟级长跑，含真机 mock 与 bench 负向对照）；`gen-reference-index --check` exit 0。 |
| **发版（②）** | 提交工作树 → 打 tag `v0.19.1`（tag 必须等于 `v` + package.json 的 version，`release.yml` 有硬校验）→ 推 `main` 与 tag。`release.yml` 只发 tarball 到 GitHub Release，**绝不 publish 到任何 registry**（带守卫）。Release 已发布：`v0.19.1`（run 35816681233，**success 16s**），资产 `dsh-webcode-bridge-0.19.1.tgz`（569,447 B，`sha256:abf22073…87fe`）；流水线内三道护栏全绿（无 publish 命令 / `tag=v0.19.1 version=0.19.1` 一致 / `verify-pack 逐字相同 42/42`）。 |

## 0.19.1 二轮追问：0.1.7-alpha.2 插件规范 + git TLS 修复（2026-09-23 第三轮）

| 项 | 内容 |
| --- | --- |
| **范围（用户原话）** | 「① 0.1.7-alpha.2 最新不是有插件规范了嘛？继续调查；② 本机现在难道不是 0.1.7-alpha.2？；③ **只修复**：推送时本仓库的 .gitconfig 钉着 `http.sslBackend=openssl` 指向已失效 CA 文件导致 push 失败。然后给出 1.2 的结论，继续**不要改动代码**，循环两轮思考审查」。**代码文件再次零改动**（`lib/` / `bin/` / `test/` / `cordis.patch.yml`）。 |
| **① 规范确实存在，权威出处是一个包** | `@deepseek-ai/dsh-package-manifest`（源码 `packages/util/package-manifest/src/types.ts`）：`DshPackageManifest` / `DshManifest` / `DshBundleManifest` / `DshProfileManifest` / `DshClientManifest` / `DshEnginesManifest`。README 明确「**每个 reader 自己负责 JSON 解析、校验与默认值**」——规范是**声明**，执行分散。 |
| **① 逐字段 delta（用实装包 d.ts 与 monorepo types.ts 对照，不靠版本号猜）** | `package.json.icon` **新增**（SVG/PNG/JPEG/WebP ≤256 KiB，realpath 后必须在 manifest 目录内）；`locale/en.json` + `locale/<lang>.json` 约定（`{meta:{title,description}}`，英文必为回落）；`dsh.manifestVersion` **新增**（字面量 `1`）；`dsh.bundle.patch` 从 `string` 变 **`string \| string[]`**；`PackageMeta` → `PluginLocalizedMeta`（+ `LocalizedText`）。 |
| **① 关键结论：新字段全是可选、且官方自己极少用** | 包 README 原文「**Compatibility is declarative.** Current installers and loaders **do not enforce** `dsh.manifestVersion` or `engines.dsh`」。机检实证：monorepo **85 个**声明 `dsh` 的包，**0 个**写 `manifestVersion`；`locale/` 只 **7 处**、`package.json.icon` 只 **2 处**（全在 `experimental/*`）。⇒ 本项目不写这些**与官方一致**，不是缺陷。`bundle.patch` 单文件仍是合法值（向后兼容）。 |
| **① 本轮唯一实质发现（两轮审查的产出）** | `dsh.client.inject` 填了**服务名** `['slots','settingsScope','sidebarRightTabs','sidebarRight']`，而规范逐字写「**Informational package-name dependencies, not Cordis service injection**」，官方全量机检**无一例外**都是 scoped 包名（参考实现 `dsh-market` / `dsh-drop-caret` 同样）。**为什么至今没炸（诚实归因）**：三条消费路径全部容忍——`system.ts arriveGraphRow` 对 `graphRows.get('slots')` 得 `undefined` **静默跳过**；`orderByModuleGraph` **只遍历 `external`**，`inject` 根本不参与；官方闸门对 `inject` **只查空值与重复**。⇒ 真实后果是**四条死声明**（既不报错也不产生任何顺序保证）。**根因**：`client.cjs:103` 那个 `inject` 变量被同时用作①Cordis 插件 `inject`（服务名，**对的**）与②`package.json` 的 `dsh.client.inject`（包名语义，**错的**）。**服务等待本身正常**，错的只是把服务名抄进了那个同名异义字段。 |
| **① 为什么本轮不修该发现** | ① 用户明确「**不要改动代码**」，而这是改变声明语义的改动；② 它要重走 `pack test` → `verify-pack` → 装 profile 的完整发布循环；③ 删它**不改变当前运行行为**（今天就是被忽略的），不急。已记正确修法（删该字段或改真包名）与护栏建议（**官方闸门没查这条**，只有本仓库能加）。 |
| **① 附带核实：`packages/client/*` 禁令不适用本项目** | 官方闸门那条「client feature package requests runtime external …」按 **manifest 路径**前缀 `packages/client/` 判；本项目是外部单包（`dsh-webcode-bridge`），不在该前缀下 → **不受该禁令约束**。如实记录，避免下一轮误当红线。 |
| **② 本机现在不是 0.1.7-alpha.2（三条独立读数一致）** | `npm ls -g --depth=0` → `0.1.6-alpha.2`；`node -p require(…/@deepseek-ai/dsh/package.json).version` → `0.1.6-alpha.2`；`dsh --version` → `0.1.6-alpha.2`。**正在跑的 Web 服务同样是它**（进程 24400：`dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open`，bin 来自 0.1.6-alpha.2 安装目录）。误以为「已是 0.1.7」的两个来源都不是「已安装」：`reference/deepseek-harness`（**源码克隆**已 pull 到 0.1.7-alpha.2）与 `reference/dsh-official-plugins/` 里的 `dsh-agent-preset-0.1.7-alpha.1.tgz`（**解包留档**）。 |
| **③ git TLS 修复（本轮唯一允许的修复，已完成）** | **先纠正措辞**：不是全局 `.gitconfig`，而是**本仓库 `.git/config`**——全局 `C:/Program Files/Git/etc/gitconfig` 本就是 `http.sslbackend=schannel`（正确），是本仓库的**局部**覆盖把它改成了 `openssl` 并指向 `.tmp/steamtools-ca.pem`（**1416 字节、仅 1 张证书**，当唯一 CA 束用必然验不过 GitHub 完整链）。**修法**：`git config --local --unset http.sslBackend` + `--unset http.sslCAInfo`，回落全局 `schannel`。**验证**：局部已无 ssl 行 / 生效值 `schannel` / `git ls-remote origin main` **exit 0** / 真实 push **无任何 `-c` 覆盖**也成功。**为什么选删覆盖而不是修 CA 束**：CA 文件在 `.tmp/`（**临时目录**、已被 `.gitignore:61` 忽略）——把 TLS 信任钉在临时路径上正是本 bug 成因，`.tmp/` 一被清理 Git 就再也连不上，而报错**根本不提那个消失的文件**。**边界**：只改本仓库 `.git/config`，不动全局配置、不删该 CA 文件；因它在 `.tmp/` 不入库，**本修复不产生可提交内容**。 |

---

## 0.19.2 修 DSH 0.1.7-alpha.2 升级后的两个真故障（2026-09-23 第四轮）

| 项 | 内容 |
| --- | --- |
| **范围（用户原话）** | 「A+B 一起走，顺带加上：底部发送等待时间也没了一起修复」——A=修 `dsh.client.inject` 并重打包装机；B=把诊断落成文档并回写台账；外加修等待药丸消失。 |
| **口径更正（本轮第一件事）** | 上一轮记的「本机实装 0.1.6-alpha.2」**已过期**：`dsh --version` 实测 `0.1.7-alpha.2`，安装目录 mtime `2026-09-23 14:54:13`，Web 服务（pid 22164）起于 `18:27:25`。上一轮结论在当时是对的，错的是它被当成长期事实。**教训：版本口径每轮重读，不从台账沿用。** |
| **阻断级真故障①：`settingsScope` 在 0.1.7 已被改名** | 官方客户端设置服务从 `ctx.settingsScope`（`SettingsScopeBinder`）改为 **`ctx.configForms`**（`ConfigForms`）；`packages/client` 下 `settingsScope` 在 0.1.7 出现 **0 次**（只剩 `.agents/notes/` 历史文本）。本插件 `client.cjs` 的 Cordis `inject` 里仍列着它 ⇒ Cordis「服务全部就绪才 apply」⇒ 该 fiber **永停 PENDING** ⇒ 设置页/右栏/并列多会话/任务板**全部不出现**。 |
| **① 的处置：删等待，不迁服务** | 本插件**从不调用** `settingsScope`（只等它；装机的 `.bak-settingsscope-20260923` 里该词只出现 1 次，就是那行 `inject`），所以删掉零功能损失；真要改用 `configForms` 是另一轮功能工作。同时**整条删掉 `dsh.client.inject`**——它与 Cordis `inject` 同名异义，规范逐字写「Informational package-name dependencies, **not** Cordis service injection」，而这里填的三条**全是服务名**（上一轮已记为死声明）。 |
| **装机不一致（上轮遗留的真问题）** | profile 依赖 `file:.../dsh-webcode-bridge-0.19.1.tgz`，manifest 是**打包那一刻**的，而 `lib/` 是被手工拷进 profile 的（mtime 15:45）——两边不同源：**代码已删 `settingsScope`、声明仍含它**。必须重打包 + 重装才能消掉，本轮已做。 |
| **阻断级真故障②：primitives 图标导出改名 → 等待药丸消失** | 0.1.7 把 `IconXxxOutline14/16` 整批改为 `IconXxxOutlineRegular`（同族 `…Medium`）——**同一颗图标、同一尺寸**，只是名字不再带像素后缀；旧名在 0.1.7 **一个都不剩**。而 `client.cjs` 的 `const { IconCodeOutline16, IconQueueOutline14 } = primitives;` 是**无兜底解构** ⇒ `IconQueueOutline14` 为 `undefined` ⇒ `IconWait` 渲染 `h(undefined)` ⇒ React 抛错 ⇒ **整个 dock 条目消失**，控制台里没有本插件自己的告警。这正是用户报的「底部发送等待时间没了」。 |
| **② 的修法：按两代名字依次取** | 新增 `iconOf(...names)`，**七处取值全部改用它**（含原来已带 `|| (()=>null)` 的五个——它们不崩，但在 0.1.7 下会**静默少图标**）。这与 0.16.21「无回退解构 + 桩缺导出 → 6 条渲染测试全崩」是同一形状：当时立的「降级不是崩溃」只覆盖了后加的写法，`IconCodeOutline16/IconQueueOutline14` 留在了无兜底解构里，于是这一轮成为唯一没被兜住的两个。 |
| **顺带修：会话身份两条来源都要归一** | 等待药丸的 `inject` 形参经 `sessionIdOf` 归一后再用（字符串 / 带 `key` 的绑定对象 / 带 `sessionId` 的对象三种形态）；设置页那条 `useCurrentSessionId` 同样两条来源都过归一（官方 standard prop `useSessions` 与槽 inject 的绑定键）。**真机对照读数**（`POST /__webcode/wait-stats`）：sessionId 为字符串 → `label`「29 分 39 秒 · 等待占比 67%」；为**对象 / null / 缺省** → `label` 为空 ⇒ 组件 `if (!label) return null` ⇒ **整行静默不渲染**。设置页那条同族路径 0.15.3 已踩过一次同样的形状漂移。 |
| **护栏（新增，含桩侧改造）** | `test/client-render.test.mjs` 的 `renderPane` 新增 `iconNaming` 开关：`'current'` 把桩里的旧名**整批换成新名（不留旧名）**，模拟真机 0.1.7；新增用例「药丸在 primitives 改名后仍必须渲染出来」断言药丸**真的渲染出读数**（不是「源码里有兜底」的转述式断言）。设置页那条既有判据改为钉**归一后的回落链**，并新增「`sessionIdOf` 必须同时认字符串与绑定对象形态」——否则 wait-stats 拿到对象、label 为空、药丸整行不渲染。 |
| **闸门读数（本轮实测）** | `test/client-render.test.mjs` **58/58 PASS**（含新回归）；`test/*.test.mjs` 75 个文件逐个跑 74 PASS + `reply-log` 需 `NODE_TEST_CONTEXT` 前提（本沙箱 `node --test` spawn EPERM，设该变量后 **4/4 PASS**）；`parse.test.mjs` 22/22；`run-m1.js` **M1 RESULT: PASS**；`bench-ci.mjs` PASS；`lint-comments` PASS（150 文件，error 0/warn 0）；`check-repo-hygiene` PASS；`check-ledger` PASS（版本 0.19.2、75 个测试文件）。 |
| **「上下文窗口变小了」的结论（与代码无关，如实写）** | 桥声明值**没变**（`contextWindowBySite: {deepseek: 1_000_000}`，`GET /__webcode/context-windows` 实测 1M）。变的是**官方 compaction 的触发点**：0.1.7 新增 `headroomTokens`（默认 65,536），阈值从 `window×0.8` 改为 `min(window×0.8, window−reservedCompletionTokens−headroom)`；对官方 deepseek（1M 窗口 / 256k 输出预留）即 **800,000 → 678,464**，少约 12%。webcode/deepseek 未设 `maxTokens` 时仍是 800k，设了才同样掉下来。 |
| **本轮刻意不做** | 不迁移到 `configForms`（本轮只是不再等一个不存在的服务）；不动 `engines.dsh` 声明（已证当前不被强制）；不动 `contextWindowBySite` 的取值（那是运维声明，不是模型规格）。 |

---

## 0.19.3 用户五点（2026-09-23 第五轮）

| 项 | 内容 |
| --- | --- |
| **范围（用户原话）** | 「1.能够在标准模式 只看本插件deepseek……能够触发多少论auto_continued完整重发首轮提示词嘛？因为这个会话已经后面全是提醒auto重发。2.我让你新增模式！保留必要webbridge需要调用工具！！以标准模式，ptc模式，简单模式等等平级的！agents预设！适合webcode的真实模式：可以查看长对话里面调用和没调用的真正工具！然后提示词优化懂不懂？真实学习参考已有的工程实践提示词！！3.关于网络搜索，modlens设置好咧嘛？4.还有长上下文继续思考两轮新增角度……提供解决方向/拉取论文参考！5.压缩每次手动触发就会：`this.adapters.get(...)?.adapter.imageRequestPricing is not a function`报错！压缩功能webcode做不到！你可以自己验证！」 |
| **口径先问后做（用户要求「优先问我问题」）** | 两轮澄清后锁定的语义：① auto_continue 的「整会话累计」**不是刹车**——用户原话「A+C：但是不能停！继续后续需要 auto！！我说我需要真实长上下文」，因此超 N 只**升级形态**；② 新增**一个** preset（webcode 真实模式），官方三个一行不动；③ 改工作区 + 装 profile，**重启由用户手动做**；④ 联网搜索按 modsearch 验证（modlens 是视觉插件，未装）；⑤ 压缩要**真计价**，不止补空实现。 |
| **⑤ 根因（用户报「压缩功能 webcode 做不到」）——不是压缩实现的问题** | DSH 运行时取路由图片计价用的是**可选链取方法再接调用**：`this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)`（`dsh-llm/lib/index.js:1964`）——`?.` 只护住两个**取值**，护不住方法本身。桥注册的 adapter 是对象字面量、在 0.19.3 之前**没有实现它**，于是 `adapter` 存在而方法为 undefined，调用即抛 `TypeError`。而 token meter 的 `measure()` **每次测量**都经 `_routeImagePricing`（`dsh-token-meter/lib/index.js:644→689`）走到那一行，手动 `/compact` 拿的正是 `ctx.tokenMeter.measure(...)` ⇒ **每次都炸**，与压缩实现无关。**装机复现前提已取证**：已装 0.19.2 的 `lib/index.js` 里 `imageRequestPricing` 出现 **0** 次。 |
| **⑤ 修法：不是补空实现，而是真计价** | 新增 [`lib/image-pricing.js`](../package/dsh-webcode-bridge/lib/image-pricing.js)：三条占位文案与 DSH 真函数**逐字同源**（`textOnlyImageText` / `offloadedImageText` / `requestImageHandleText`），但**不 import**（profile 里没有 `@deepseek-ai/dsh-llm`，且契约要求同步返回）——漂移风险由 `test/image-pricing.test.mjs` 从 DSH 安装目录 import 真函数做逐字比对兜住。逐出现位置返回 `{ visualTokens: 0, text: 占位文本 }`：`visualTokens` 恒 0 是因为 **webcode 各站点没有公开任何视觉计量规则，桥不编造数字**；`text` 才是真改进——它替掉了 token meter 对图片的「引用 JSON 字符数」启发式（`dsh-token-meter/lib/types/estimate.js:22-28` 明写「image references … request price is route-owned rather than fixed」）。契约三条硬约束全部防御：**同步返回、绝不抛、一个出现位置一条价**（长度不等调用方会主动抛）。 |
| **⑤ 被官方 meter 真实消费的取证（不只是形状对）** | 「形状对但没人消费」正是本项目记过多次的失败形状，因此额外取证了**消费端**：直接 import 官方 `dsh-token-meter/lib/types/route-pricing.js` 的 `priceSurface`（它不在 package exports 里，只能按安装路径取），对同一个带图 surface 节点算两次——`pricing=undefined` ⇒ **500**（保留固定启发式，即 0.19.3 之前的 webcode 行为）；`pricing=webcodeImageRequestPricing(...)` ⇒ **485**（图片改按模型真正看到的那句 ~43 字符占位计价：减去结构化启发式 39、加上文本估算）。差值方向是**下修**，这正是「按模型可见文本计价」的含义（旧启发式数的是附件引用 JSON 的长度，不是任何视觉计价）。同时证明官方的**错位判据真实存在**（`answered 0 prices for 1 occurrences` 会抛），而本实现返回等长数组、永不触发它。这一跳已冻结为护栏 `test/image-pricing.test.mjs` ⑥，不再是 `.tmp/` 里的一次性探针。 |
| **① 新增：整会话累计 + 完整提醒升级（形态切换，不是刹车）** | 新增 [`lib/continue-budget.js`](../package/dsh-webcode-bridge/lib/continue-budget.js)：纯函数 `continueFormFor({cumulative, after})`（`after=0`/非法 = **不升级**；`cumulative > after` 才升级，默认 N=3），计数落盘 `~/.dsh/webcode/continuations/<sessionKey>.json`（**「整会话」必须跨进程**——本项目常态操作就是重启 dsh web）。`autoContinueRound` 里 **bump 放在 `relay.submit` 返回之后**（发送抛错不占额度，读数与事实一致），且**唯一一个 `disabled` 出口只由 `rounds < 1 \|\| !sessionKey` 决定**——累计永远不会让它停手。升级形态取**会话教学正本**（`buildTurn` fresh 分支里 teaching 只算一次：既落盘 `prompts/<site>.md`，又进 `siteTeachingBySession`），因此「升级后重发的教学」与「首轮真实教过的教学」**不可能分叉**。 |
| **① 界面与读数** | [`lib/notices.js`](../package/dsh-webcode-bridge/lib/notices.js) 的进度说明加三枚读数（累计次数 / 是否已升级 / 升级点），八处出口共用 `continueNoticeFields(cont)`；升级文案必须同时说清「第几次」「已改用完整提醒」「**不停手**」——只说前者会让人读成桥收手了，与事实相反。 |
| **② 新增：WebCode 真实模式 agent preset（`order: 4`，与 standard/ptc/minimal 平级）** | 声明在随包发布的 [`cordis.patch.yml`](../package/dsh-webcode-bridge/cordis.patch.yml)。**真机取证**（`scripts/session-read.mjs` 多帧 zstd 全解）：303 份会话 / 817 轮 / **23,636 次工具调用**，其中 **webcode 路由 15,296 次（64.7%）**；webcode 真实工具目录 35 项、实际被调用 32 项；`workflow` 与 `subagent_fork` 命中 **0 / 0**。与官方 standard 的差异**只有两处**（YAML 真解析逐项比对）：删 7 行（`tool-subagent-fork`/`tool-subagent-codex`/`tool-subagent-claude-code`/`workflow-ptc`/`tool-workflow`/`tool-ralph`/`tool-plugin-manager`），persona 多一句「传输事实」。**教学成本**（差集法，桥自己的 `buildPreset` 现算）：**30,381 → 26,264 字符（−13.6%）**。删工具本身也是提示词优化：本项目最贵的失效形状是模型写出**本会话不存在的工具名**，每多一个从未被选中的入口就多一个被判错的名字（依据 arXiv 2510.05381 / 2507.11538）。 |
| **② persona 那一句的依据** | 放在**开头**（系统指令）而非只放末尾协议段：Lost in the Middle（arXiv 2307.03172）的 U 形曲线说明模型对开头与结尾最敏感，同一约束占住两端。必须点名「**只在思考里的调用不会被执行**」——那是真机最顽固的失效形状（`THINKING_ONLY_NO_ANSWER`）。 |
| **③ 联网搜索实测（modlens 是视觉插件，未装；用户问的搜索 = modsearch）** | 本机安装：`@liustack/modsearch@5.10.3` 在 web profile，`searchProvider: modsearch` 已生效。实测三件：`doctor` → web/fetch 两角色 **`resolved: firecrawl`（keyless ready）**、social 角色 `resolved: null`（无 `grok` CLI，**X 搜索不可用**）；真查询 → `engine=firecrawl status=ok items=8`，**1.8s**；单页抓取 → `status=ok`，20 条出链、**50,000 字符**正文。读数落 `.tmp/modsearch-{doctor,search,fetch}.json`。**未装 `modlens`**（视觉：图片→JSON），如需要另起一轮（要网络 + 写 profile + 重启）。 |
| **④ 长上下文第三、四轮** | [`doc/research/2026-09-23-longrun-rounds-3-4.md`](research/2026-09-23-longrun-rounds-3-4.md)。**第三轮**从「压力读数量的是谁」落到**两个上下文账本从未对账**：分子是桥自己的估算（`index.js:3441/3448`），分母是桥自己声明的 1M（`index.js:263`），而 `index.js:844` 的注释逐字承诺「取 128k」——**注释与代码互相矛盾**，且注释承诺的那个行为（压缩会触发）从未生效过。**第四轮**从「auto_continue 是不是免费的」落到**每次救活都在给下一次加长**：完整提醒 = **26,264 字符常驻**（真机已知最大单轮提示 409,555 字符的 **6.4%**）× 每次升级。两条独立成立，各给解决方向（对账探针 `ledgerDriftRatio` / 恢复预算 + 「重建而不是加长」），附 **10 条**文献（2505.06120 多轮平均降 39%、2507.11538 IFScale 68% 与前偏、2510.00615 ACON 峰值 token −26~54%、2510.05381、2307.03172、2511.03508、2605.23296、2605.23950、Chroma Context Rot、ACL Findings 2026）。 |
| **① 用户原问的实测答复（「能够触发多少轮 auto_continued…这个会话已经后面全是提醒 auto 重发」）** | 全量 303 份会话里 `AUTO_CONTINUED` 共 **157 次**，分布在 **26** 个会话；**单会话单轮最高 42 次**（`session-84a9a24f…`，该会话 199 次工具调用），其余高值 14/13/13/10/9/8/7。口径更正：0.19.3 之前**没有任何累计概念**，每步至多补发 1 轮（`autoContinueRounds=1`），因此「后面全是提醒」是**同一会话内多步各自触发**的叠加；而补发出去的是「再教学提示 + 该站点协议段」，**不是**完整首轮教学——**用户问的那件事当时并没有发生**，现在（超 N 后）才真的会发完整教学。**代价已记账**：若按那个 42 次的会话套用新规则，第 4…42 轮各注入 26,264 字符 ⇒ 约 **1.02 M 字符**追加进同一个网页会话，远超真机已知能收下的最大单轮 409,555 字符——本轮**按用户原话实现（每轮升级 + 不停手），不擅自加刹车**，三个一行旋钮与 D4 方向见 `PROMPT-ENGINEERING.md §8.6` / `research/2026-09-23-longrun-rounds-3-4.md §4.4`。 |
| **闸门读数（本轮实测）** | 新增 5 条护栏文件：`image-pricing` **8/8**、`continue-budget` **12/12**、`auto-continue-notice` **7/7**（出口集合扩到 6 个）、`webcode-preset` **7/7**、`auto-continue-complete` **1/1**。**端到端**：`test/auto-continue.test.mjs` **11/11 PASS，exit 0**（约 300s，含两次 60s 发送间隔；本轮共独立跑过两次，两次都 exit 0），日志逐字出现 `auto-continue round: 149 chars, 1 call(s) parsed, form=short, cumulative=1`；`test/auto-continue-complete.test.mjs` 造出「本会话已补发 3 次」的现场，日志逐字出现 `form=complete, cumulative=4`——**升级分支在真实链路里跑通**（完整教学在场、提示自述第 4 次、调用照旧派发 `finish=tool-calls` = 不停手）。**全量**：`test/*.test.mjs` **81/81 文件逐个跑全绿、退出码 0**（`NODE_TEST_CONTEXT=1`；唯一一次 exit=1 是 `reply-log` 未设该变量时的已知沙箱前提，设后 **4/4 PASS**）。`lint-comments` **PASS（158 文件，error 0 / warn 0）**、`check-repo-hygiene` **PASS**、`check-ledger` **PASS（0.19.3 / 81）**、`verify-pack` **逐字相同 45/45 + 接线完好**。 |
| **自我更正：我自己的护栏曾经依赖环境变量（本轮第二轮自审发现）** | `test/continue-budget.test.mjs` 初版用 `createContinueCounter({ dir })` 走落盘路径，而模块的守卫是「`NODE_TEST_CONTEXT` 在场且未指定 `WEBCODE_CONTINUE_STATE_DIR` ⇒ 只走内存」。于是这条用例**在不设该变量时绿、在设了（= CI 条件）时红**——第一次「81/81」是在「前 29 个不带该变量、后 51 个带」的混合条件下取得的，那个绿**不可复现**。修法不是放宽判据，而是把条件写进入参：新增 `persistentCounter(dir) = createContinueCounter({ dir, env: {} })`（显式 env ⇒ 不受环境摆布），并把「测试进程守卫」那条用例改成同样显式传 env、不再改全局 `process.env`（用例之间不再互相影响）。修后 **12/12 在两种条件下都绿**，并重跑全量在**统一条件**（`NODE_TEST_CONTEXT=1`）下复核。教训与 `check-ledger` 反复判红的同一条：**读数的取得条件必须写进读数本身**，否则「全绿」只是一次观测，不是一条判据。 |
| **本轮刻意不做 / 遗留** | ① `index.js:844` 那处**注释与代码矛盾**已逐字取证但**未改**：把 1M 改成注释承诺的 128k 会改变「自动压缩是否触发」，属用户决策（用户同时要「真实长上下文」，两侧拉扯），留作下一轮的一个一行政动项。② 未安装 `modlens`。③ 新 preset 与完整提醒**都没有配对性能读数**（只有相对读数与成本读数），已在 `PROMPT-ENGINEERING.md §8.6/§9.4` 写明。④ 装机后需**用户手动重启** `dsh web`，重启前模式列表里不会出现「WebCode 真实模式」。 |
| **装机正确性已复核到「组合层」（不必等重启）** | ① 两个 profile 的声明都指向 `0.19.3.tgz`，装后 `version=0.19.3`；工作区与 profile 的五个关键文件 **SHA256 全部 SAME**（`lib/index.js`、`lib/image-pricing.js`、`lib/continue-budget.js`、`lib/notices.js`、`cordis.patch.yml`）。② `dsh --profile web --dump-config` **exit 0**，组合树里四个 preset **平级并列**（`preset-standard` / `preset-ptc` / `preset-minimal` / **`preset-webcode`**，webcode 在第 1372 行），且渲染出的块与源码逐项一致（`id: webcode`、`order: 4`、展示名、persona 传输事实、裁剪后的工具行）。③ **headless 的风险已排除到组合层**：`dsh --profile headless --dump-config` **exit 0**（543 行、含 `- id: preset-webcode`、无 error）——headless 没挂 `agent-preset-registry`，而 `@deepseek-ai/dsh-agent-preset` 是 `static inject = ["agentPresets"]`，按官方注册表文档「等待 Host 服务的行保持挂载」，该行在 headless 里应当是**惰性无害**。**仍未验证的是挂载层**（需要重启后看日志），重启后一并确认。 |

---

## 0.19.4 计费口径 + 账号下拉 + 按账号并发（2026-09-23 第六轮）

| 项 | 内容 |
| --- | --- |
| **范围（用户原话）** | 「我已经重启，然后增加任务，现在还有的问题：1.计费token的问题--关于真实计费，做不到就保险往高报 2.右侧tab网址浏览问题：右侧要能够获取真实登录状态登录后就会显示下拉选择（像新建终端的下拉选择）……下拉取后显示已登录头像和昵称，以及额外加一行登录选择：新给空白等登录状态……关于多调用模型的约束和真机实践：已有使用账号不允许同时再使用！！一个网址可以多个账号，多个对话！但是必须每个对于唯一账号！……不能同时发过多请求，错分！但是不是让你只留一个协议进行转接意思！还是多账户并发多会话那样需要真实多个转接！然后都修复好了打包安装 3.理解我的意思，向我询问，然后记录我这个会话的真实提问语言和你的理解！」 |
| **Ⓐ 计费：不拍系数，先用官方真实数据标定** | 官方文档给的是平均密度（[中文 0.6 / 英文 0.3 token 每字符](https://api-docs.deepseek.com/quick_start/token_usage)）。本轮更进一步：用本机凭据对**官方 Messages 端点实测**六类样本（纯中文/纯英文/混排/源码/JSON/数字符号），方法、陷阱与原始 `usage` 全落 [`research/2026-09-23-token-density-calibration.md`](research/2026-09-23-token-density-calibration.md)。**先修掉一个测量陷阱**：DeepSeek 的自动上下文缓存让同一段 JS 文本两次跑出 277 与 149 token（差 1.86 倍）——没有「随机 nonce + input+cache_read」这两道保险，整组系数都是错的。 |
| **Ⓐ 实测推翻了直觉：被低估的不是中文** | 旧系数（CJK 0.7 / 其余 0.25）在同一批实测样本上：中文 **0.90×**、英文 1.07×、混排 0.99×、**源码 0.67×、JSON 0.96×、数字符号 0.37×**——四类低估，而**代码/JSON/标点正是编码 agent 的日常流量**（用户怀疑的是中文，中文那侧旧值其实偏高）。根因是旧实现把「英文散文」与「代码符号」混成同一个 0.25，两者实测差 2.9 倍。 |
| **Ⓐ 新口径：三类实测单价 + 保留余量（`TOKEN_DENSITY`）** | CJK **0.75** / 散文 ASCII **0.30** / 其余 ASCII **0.70**，再叠 10% 余量；系数由网格搜索取「六类样本**全部 ≥ 实测**」里超额最小的可行解。**单一真相**：`lib/metrics.js` 一处定义，usage 事件、OpenAI 前端两处 usage、右栏 TPS、发送前预算闸全部经 `estimateTokens` 生效。护栏 `test/token-density.test.mjs`（5 条）把六类样本与**官方实测 token 数写进断言**，要求「估算 ≥ 实测」——「绝不低估」是可失败的判据，不是承诺。 |
| **Ⓐ 输入侧固定开销** | 新增 `usageFixedOverheadTokens`（默认 2048）：补的是「桥报的 inputTokens 一直只是我发出去的文本，而网页那侧还有它自己的系统提示/界面框架/站点前言」这个缺口。**按一次性偏移计入**而不是逐轮累加——网页自己的系统提示在上下文里只有一份，累加会重复计数、把压缩压力虚推高；用户要的是「不低估」，不是「虚高」。2048 是**标注过的上界猜值**（实测办法＝ D3 对账探针）。 |
| **Ⓑ 右侧站点目录：统一成「新建终端」那种账号下拉** | 改的是**右栏 Web Bridge 标签页的站点目录每一行右侧**（用户确认的正是这一处）。原先单账号站是一颗「登录」按钮、多账号站是箭头菜单且菜单项写的是桥生成的槽名、底部还有一行「登录（打开桥自己的浏览器窗口）」；现在**每一行都是同一种下拉**（官方 `Menu`，`portal/align:end`，与 `dsh-client-ui-sidebar-terminal` 的「选择 Shell」同构）：菜单项 = **真实头像 + 真实昵称**，昵称抓不到就**回落槽名**（用户口径），头像抓不到就回落站点矢量标记；底部固定一行 **「新账号」**（三个字、无括号），点它→服务端新增一个槽→立刻打开该槽的登录窗口，登录后面板轮询把新账号行读回来。 |
| **Ⓑ 服务端：真实昵称/头像的采集与回落** | `browser-driver` 新增 `readAccountIdentity()`：站点自己声明 `accountProbe` 优先（本轮只给**已有真机证据**的 GLM 声明——依据是它 `loginProbe` 注释里那句 `<p class="sidebar-user-name">RSYHN</p>`），否则用一组通用猜测；读到的值要过「长度 ≤ 40、不是登录入口文案、含至少一个字母数字」三道过滤。**读不到就是 null**，绝不拿槽名冒充昵称。触发点：登录成功、`verify-login` 成功、以及**打开下拉那一下**（新路由 `POST account-identity`）——最后这一条是给「用户在站点网页里手动登录」准备的。 |
| **Ⓑ 文案纪律（C23）** | 把界面可见文案按用户要求压短：「登录（打开桥自己的浏览器窗口）」→ 整行删除；「4 个账户可选」→「4 个账号」；「窗口已存在——已聚焦弹到最前。」→「窗口已在，已置前」；「已打开「X」的桥窗口，请在该窗口内登录；登录态会被保存并用于自动化。」→「已打开 X 登录窗口」。括号补充一律进 `title`/`aria-label`。 |
| **Ⓒ 并发：relay 从「一个全局槽 + 一条 FIFO」改成「按账号分通道」** | 现状取证：`relay.js` 是**一个全局 `busy` 标志 + 一条 FIFO 队列**，所以不存在真并发——这正是用户否掉的那件事（「不是让你只留一个协议进行转接」）。改法：并发单位＝ **accountKey**（同账号同时只允许一个在途，第二个在它自己的通道里排队并透出位置）；不同账号**真并发**；全局仍有 `maxConcurrentLanes`（默认 2）与 `minSendIntervalMs`（默认 1000ms）**错峰**；端口与协议**不变**（用户口径：「端口不变、内部多通道」）。`status()` 新增 `lanes` 明细与两个新旋钮。护栏 `test/relay-lanes.test.mjs`（6 条，毫秒级）：同账号不重叠、不同账号必重叠、上限压到 1 必须串行、错峰生效、通道明细透出、**无 accountKey 的调用彼此串行**。 |
| **Ⓒ 「一个对话对应唯一账号」落到结构上** | 会话键从 `<sessionId>::<agentId>` 扩成 `<sessionId>::<agentId>::<accountKey>`：切账号 = **另一条网页对话**（游标、落盘文件、发送账本各自分开），于是「对话 ↔ 账号」是结构性 1:1，而不是靠运行期比对维持。同时把「换账号导致的整段重建」的真因写成 `account-changed`（否则读日志的人会把一次**预期内**的重建当成「游标丢了」）。已知代价：升级后每个会话会整段重建一次，之后稳定。 |
| **自我更正两处（本轮自审抓到）** | ① `test/context-budget.test.mjs` 的「恰好等于窗口」用例把窗口**按旧系数手算**成 770（`ceil(0.7n×1.1)`），换单价表后它把一个**正确**的实现判成了红——改成用 `estimateTokens` 自己算，并补「少 1 token 就必须拦下」；判据从「绑系数」变成「绑边界」，更强也更稳。② `test/session-continuity.test.mjs` ⑩ 断言写死会话文件名 `<sessionId>.md`，会话键带账号段后失配——改成按前缀找文件并**额外钉住账号段在名字里**；另 ⑥b 断言「abort 时已发几次」，被本轮新增的全局错峰（与中止语义正交）扰动，显式关掉该用例的错峰。 |
| **闸门读数（本轮实测）** | 新增 2 条护栏 + 3 条扩写：`token-density` **5/5**、`relay-lanes` **6/6**、`client-render` 扩到 **59/59**、`control-routes` 扩到 **16/16**（含 `account-add` 槽位分配与 `account-identity` 的「读不到就说读不到」）、`settings-transport` **7/7**（⑥⑦ 的判据按用户新语义从「按站点」改成「按账号」）。**全量 83/83 文件逐跑全绿、退出码 0**（`NODE_TEST_CONTEXT=1`，串行独占）；`lint-comments` **PASS（161 文件，0 error / 0 warn）**、`check-repo-hygiene` **PASS**、`check-ledger` **PASS（0.19.4 / 83）**、`verify-pack` **逐字相同 45/45 + 接线完好**。**一次真失败并按根因修掉**：`auto-continue-complete` 预置的计数文件名没带本轮新增的账号段（会话键格式变了），修法是按 `continuationFilePath` 构造键并**故意写死形状**——键再变就响亮失败，而不是退化成短提示还全绿。 |
| **本轮刻意不做 / 遗留** | ① 「新账号」只做**加槽 + 开登录窗口**，不做删除账号（用户没要求；删槽还牵涉历史 profile 目录归属）。② 真实头像走站点 CDN 原始 URL，跨域拒热链时回落站点标记——**没有**为此在桥里加图片代理。③ `usageFixedOverheadTokens` 的 2048 仍是猜值（已写明实测办法）。④ 计费口径变保守 ⇒ 同一段文本的 token 读数普遍上升、压缩触发点变早；这与「我要真实长上下文」的拉扯记在标定文档 §8。 |

---

## 0.19.5 DeepSeek 图片/附件投递修复 + 长文本写入根因（2026-09-24 第七轮）

**用户原话**：「请你以事实为依据，将图片发送还有附件发送都维护好 deepseek」+「还有长文本桥接失败问题，请你一并解决后打包安装新版本给我」。

| 项 | 内容 |
| --- | --- |
| **① 附件确认判据假阳性（阻断级，真机取证）** | `POST /__webcode/attach-probe`：`ok:true, evidence:"text:webcode-probe.md"`，而同一次返回里 10 条类名候选**全部 count:0/visible:0**，`nameHit` 是一个**无 class 的 `<code>`**——页面会话正文里的同名文本。旧 `filenameEvidence` 扫 `querySelectorAll('body *')`，只按「文本长度 ≤ 文件名+80」与「取最深命中」过滤，挡不住正文同名文本；而桥自己的投递指令就写着 `webcode-context.md`，于是从第二轮起判据恒为真。后果：文件真没上去却报成功，正文被替换成「请先读取该附件全文」，上下文一个字都没进网页。 |
| **① 修法（判据由真机层高读数决定，不猜类名）** | 新增 [`lib/attach-scope.js`](../package/dsh-webcode-bridge/lib/attach-scope.js) 的 `pickAttachEvidence`（唯一判定实现，驱动侧以源码注入页面执行，保证「页面里跑的」与「护栏驱动的」逐字同一）。两条收紧：**排除正文节点**（`closest(transcriptSel)`）+ **限定 composer 作用域**（从输入框往上、最高的「含文件入口且不含正文节点」的祖先）。层高实测：第 5 层 `div._871cbca` 含 2 个真 chip、0 个正文节点；第 6 层起正文节点出现（3 个）⇒ 作用域必须停在正文之下。**不依赖任何站点类名**（构建期哈希会随发版漂）。 |
| **② 图片投递两处硬伤** | ① `uploadImages` 调用时**不传 name** ⇒ 只剩类名清单，而该清单在 DeepSeek 上真机零命中（代码注释自己记着 2026-09-17 反证）⇒ 图片永远确认不了；已改为逐图给名字证据。② 调用点 `await uploadImages(images)` **没有 try** ⇒ 确认失败直接判死整轮（「一发图就整轮失败」）；已改为失败**如实落 `imageTransport` 读数并回落纯文本**，与文字附件那条路径的纪律对齐。 |
| **③ 长文本桥接失败的真根因（真机测量）** | 逐块 `insertText` 的写入成本是 **O(n²)**，实测：100k=4.5s、200k=16s、**400k=72s**（复刻桥算法，含每块全量回读；把回读换成只读长度几乎不变 ⇒ 瓶颈是插入本身，不是回读）。72 秒已吃掉整轮 240s 预算的近三分之一，再叠网页 prefill 就会撞超时。**修法**：表单控件首选**原生 value setter + 冒泡 input 事件**——实测 100k=10ms、200k=15ms、400k=28ms、**800k=57ms**；时序已验证（写后立即回读长度相等，等 500ms 仍相等，React 未回写覆盖），且该元素无 `maxLength`（`maxLength:-1, hasMaxLengthAttr:false`）。原生路径拿不到长度时回落既有分块路径，`PROMPT_TRUNCATED` 回读校验照旧。 |
| **④ 顺带修掉的两个真缺陷** | ① `attach-probe` 的 `cleanup` **从未透传**给驱动——返回里写着 `cleanupRequested`，实际照样清理（读数与事实不符，且把取证悄悄变成副作用）；已透传。② `cleanupAttachment` 的全页扫描同样会命中正文节点（会去点正文里同名文本旁边的控件）；已加正文排除。 |
| **⑤ 护栏（行为级，含 5 条变异反向验证）** | 新增 `test/attach-evidence-scope.test.mjs` **10/10**。**首版是装饰品**：判据只查源码字符串，把 `if (inTranscript(el)) return false;` 短路掉**仍然全绿**。因此把判定抽成纯函数并用小 DOM 适配器**直接驱动**，另加两个「唯一防线」用例（只留作用域能拦 / 只留正文排除能拦）。**变异反向验证**：正文排除短路 → FAIL(1)；作用域短路 → FAIL(1)；候选改全页计数 → FAIL(1)；不取最深命中 → FAIL(1)；`closest` 判据去掉 → FAIL(1)；全部还原 → 10/10。 |
| **⑥ 本轮自己写错并修掉的一处** | `imageTransport` 一度声明在 `runTurn` 里，而 `status()` 是另一个闭包 ⇒ 整个 status 抛 `ReferenceError`。由 `stall-settle` / `settings-transport` 抓住，已移到驱动级（`runTurn` 里只做重置）。这正是「声明位置是契约的一部分」的又一例。 |
| **⑦ 端到端真机验证** | 把新判据注入运行中的 3080 页面：① 正文里确有 `webcode-context.md` 但没有附件时 ⇒ `nameHit:null, scoped:true, scopeDesc:div._871cbca`（假阳性消除）；② 真上传唯一名文件 ⇒ `nameHit:{tag:div, cls:e70accd6}`（真 chip 能认出）。探针残留已清理（`chips found: 0`）。 |
| **⑧ 闸门读数** | 全量 `test/*.test.mjs` 84 个文件逐个跑：**仅 `reply-log` 1 个文件红**，且是台账已记的环境前提（未设 `NODE_TEST_CONTEXT=1`）；设后 **4/4 通过**。其余 83 文件全绿（含新增 10 条）。`node --check` 全部 exit 0。 |

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 工作树版本 | **0.19.10（已打包并装入 web/headless 两 profile，声明=已装=lockfile 三方一致；待用户手动重启生效）**：0.19.10 修**真机复现的「图片有，但加载不出来」**——用户会话 `62f74e98`（附图 1086×1425 / 942,941 字节）里，桥自己的回复日志留下 `⚠ 图片未能附加到网页（ATTACH_NOT_CONFIRMED），本轮将以纯文本发送`，于是该轮**静默退化成纯文本**，模型只能去翻 `read_image` 的元数据、最后如实回答「看不到像素内容」。真机复现（同一张图、同一路径）：一次 `imageTransport.ok=true`、端到端 **37 秒**、模型正确描述画面 ⇒ **15s 窗口不是「失败」而是「缩略图还没渲染」**。修法：`uploadImages` 证据窗口 15s → **90s**、`uploadTextAttachment` 20s → **90s**（证据一出现就返回，只影响失败时的等待）。护栏 `attach-callsite` ⑥c。0.19.9 修**真机复现的「有图 + 超长正文时正文没走附件」**——用户原话「deepseek 明明在附件投递模式下，看的还是完整上下文」。真机复现（一轮里同时有一张图与 81,004 字符正文）：页面上的用户消息 `userMsgChars=81139`、`mentionsFullHistory=true`（正文整段进了输入框），而 `attachTransport` 停在**上一轮**读数 —— 面板显示「当前生效：附件投递」而用户看到全文。根因是调用点的 `if (!attachEvidence)` 守卫：`attachEvidence` 已被 `uploadImages` 置位，于是**整块投递判定被跳过**。改法：判据换成 `plan.mode`（正文是否需要附件），不再看「有没有用过附件」。同时修掉一个**假阳性陷阱**：`waitForAttachment` 的类名候选判据（`img[src^='blob:']`）分不出附件是谁的 —— 带图轮里会被图片命中，把「.md 没落地」误判成「已确认」；文本附件现在只认文件名（`allowCandidates:false`）。护栏 `attach-callsite` ⑥/⑥b（原⑥那条**判据说反了**，已改写并写明真机反证）。0.19.8 修**真机复现的「图片轮发不出去」**：带图的一轮上传证据命中却整轮 240s 超时，22 秒后页面仍停在站点首页、正文还躺在输入框里（程序化 Enter 没有提交）；根因是发送**只调用不确认**，修法为按页面事实确认（输入框清空 / 地址栏切会话）+ 三条发送路径 + `SEND_NOT_CONFIRMED`。0.19.7 落用户 UI 三条 —— ① 修「设置界面输入框超出卡片框」：控件 CSS 缺 `box-sizing:border-box`（旧版按内容盒算，加上 padding/边框比容器宽约 22px），补齐并加护栏；② 设置界面标题行右端加 **GitHub 项目主页链接**（原生面板 + 独立设置页两处）；③ 统一控件风格（模型下拉/文本框统一「填满可用宽度、上限 340px」；任务板弹窗 `.hwb-input/.hwb-select` 补上此前缺失的盒模型与刻度）。0.19.6 落用户界面文案与预设两条要求 —— ① 等待占比不再输出「（覆盖 n/N 轮）」（`waitRatio` 只给纯百分比，零覆盖仍 `未记录`）；② agent preset 展示名 `WebCode 真实模式` → **`wecode模式`**，description 与 persona 压成简短声明（去掉 303 份/23,636 次的统计叙述）；③ 设置页与右栏文案按「官方解释长短」精简：删掉「正在运行（子代理 / Team）」整卡（含 7.9KB 的 `AgentRoster` 组件、`rosterStateOf`、`.hwb-roster*` 样式）、「附件探针」与「最近一次实际投递」、限流退避与真机事故叙述、会话隔离的机制句、「全局指令」重复句；④ 「首轮提示词（只读）」卡重排美化（信息面不变）。另修**插件市场整页崩溃**：`dshmarket` 1.55.0 直接解构 primitives 的 `Icon*Outline14/16`，而 DSH 0.1.7-alpha.2 已把该族改名为 `…Regular/Medium` → `h(undefined)` → React error #130；已把 web profile 的 `dshmarket` 升到 **1.59.0**（其 bundle 带 `ICON_ALIASES` 两代名字回落）。0.19.5 修 DeepSeek 附件确认判据假阳性（正文同名文本被当成附件证据）、图片轮缺名字证据且失败判死整轮、长文本写入 O(n²)（400k 需 72s）三件，见下节。0.19.4：0.18.0 曾真机生效（线上 3080 实测 `build.version=0.18.0`、`hash a86bce573e0b`）；0.19.0 落三项用户要求；0.19.1 边界1/2 澄清落地 + 打包安装；0.19.2 修 DSH 升到 0.1.7-alpha.2 后的两个真故障（`settingsScope` 改名致整块不挂载、primitives 图标改名致等待药丸消失），诊断见 [`diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md`](diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md)；0.19.3 落用户五点（自动续跑整会话累计 + 完整提醒、WebCode 真实模式 preset、modsearch 实测、长上下文三/四轮、`imageRequestPricing` 修复）**并已真机重启生效**（3080 实测 `build.version=0.19.3`、`hash c6365c4acbbd`）；**0.19.4 落用户三点**（计费三类实测单价 + 绝不低估、右栏站点目录统一账号下拉含真实头像/昵称与「新账号」、relay 按账号多通道并发 + 会话绑定唯一账号） |——用户原话「deepseek 明明在附件投递模式下，看的还是完整上下文」。真机复现（一轮里同时有一张图与 81,004 字符正文）：页面上的用户消息 `userMsgChars=81139`、`mentionsFullHistory=true`（正文整段进了输入框），而 `attachTransport` 停在**上一轮**读数 —— 面板显示「当前生效：附件投递」而用户看到全文。根因是调用点的 `if (!attachEvidence)` 守卫：`attachEvidence` 已被 `uploadImages` 置位，于是**整块投递判定被跳过**。改法：判据换成 `plan.mode`（正文是否需要附件），不再看「有没有用过附件」。同时修掉一个**假阳性陷阱**：`waitForAttachment` 的类名候选判据（`img[src^='blob:']`）分不出附件是谁的 —— 带图轮里会被图片命中，把「.md 没落地」误判成「已确认」；文本附件现在只认文件名（`allowCandidates:false`）。护栏 `attach-callsite` ⑥/⑥b（原⑥那条**判据说反了**，已改写并写明真机反证）。0.19.8 修**真机复现的「图片轮发不出去」**：带图的一轮上传证据命中却整轮 240s 超时，22 秒后页面仍停在站点首页、正文还躺在输入框里（程序化 Enter 没有提交）；根因是发送**只调用不确认**，修法为按页面事实确认（输入框清空 / 地址栏切会话）+ 三条发送路径 + `SEND_NOT_CONFIRMED`。0.19.7 落用户 UI 三条 —— ① 修「设置界面输入框超出卡片框」：控件 CSS 缺 `box-sizing:border-box`（旧版按内容盒算，加上 padding/边框比容器宽约 22px），补齐并加护栏；② 设置界面标题行右端加 **GitHub 项目主页链接**（原生面板 + 独立设置页两处）；③ 统一控件风格（模型下拉/文本框统一「填满可用宽度、上限 340px」；任务板弹窗 `.hwb-input/.hwb-select` 补上此前缺失的盒模型与刻度）。0.19.6 落用户界面文案与预设两条要求 —— ① 等待占比不再输出「（覆盖 n/N 轮）」（`waitRatio` 只给纯百分比，零覆盖仍 `未记录`）；② agent preset 展示名 `WebCode 真实模式` → **`wecode模式`**，description 与 persona 压成简短声明（去掉 303 份/23,636 次的统计叙述）；③ 设置页与右栏文案按「官方解释长短」精简：删掉「正在运行（子代理 / Team）」整卡（含 7.9KB 的 `AgentRoster` 组件、`rosterStateOf`、`.hwb-roster*` 样式）、「附件探针」与「最近一次实际投递」、限流退避与真机事故叙述、会话隔离的机制句、「全局指令」重复句；④ 「首轮提示词（只读）」卡重排美化（信息面不变）。另修**插件市场整页崩溃**：`dshmarket` 1.55.0 直接解构 primitives 的 `Icon*Outline14/16`，而 DSH 0.1.7-alpha.2 已把该族改名为 `…Regular/Medium` → `h(undefined)` → React error #130；已把 web profile 的 `dshmarket` 升到 **1.59.0**（其 bundle 带 `ICON_ALIASES` 两代名字回落）。0.19.5 修 DeepSeek 附件确认判据假阳性（正文同名文本被当成附件证据）、图片轮缺名字证据且失败判死整轮、长文本写入 O(n²)（400k 需 72s）三件，见下节。0.19.4：0.18.0 曾真机生效（线上 3080 实测 `build.version=0.18.0`、`hash a86bce573e0b`）；0.19.0 落三项用户要求；0.19.1 边界1/2 澄清落地 + 打包安装；0.19.2 修 DSH 升到 0.1.7-alpha.2 后的两个真故障（`settingsScope` 改名致整块不挂载、primitives 图标改名致等待药丸消失），诊断见 [`diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md`](diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md)；0.19.3 落用户五点（自动续跑整会话累计 + 完整提醒、WebCode 真实模式 preset、modsearch 实测、长上下文三/四轮、`imageRequestPricing` 修复）**并已真机重启生效**（3080 实测 `build.version=0.19.3`、`hash c6365c4acbbd`）；**0.19.4 落用户三点**（计费三类实测单价 + 绝不低估、右栏站点目录统一账号下拉含真实头像/昵称与「新账号」、relay 按账号多通道并发 + 会话绑定唯一账号） |——用户要求「真实调用 webcode/deepseek、查看网页界面/内核」后，用桥自己的 OpenAI 前端 + CDP 直连在用浏览器取证：不带图的一轮 1.6s 正常回答；带图的一轮上传证据命中（`imageTransport.ok=true`、`img[src^='blob:']`）却整轮 240s 超时，22 秒后探活发现**页面仍停在站点首页、正文还躺在输入框里**（程序化 Enter 没有提交），而同页面手工按 Enter 立刻发送成功、模型正确读出图里的字符 `7QK-42`。根因是发送**只调用不确认**：「没发出去」与「发出去但网页不回」在读数上同形。修法：发送后按**页面事实**确认（输入框被清空 / 地址栏从根切到会话），未确认依次重试「契约按钮 → 聚焦输入框末位回车」，三条都不成立就抛 `SEND_NOT_CONFIRMED`，不再伪装成超时；护栏 `test/send-confirmed.test.mjs`。另：接用户指令把 `promptTransport` 从 `inline` 改为 **`attach`**（`~/.dsh/webcode-edge-profile/webcode-settings.json`），附件投递通道因此真正被走到。0.19.7 落用户 UI 三条 —— ① 修「设置界面输入框超出卡片框」：控件 CSS 缺 `box-sizing:border-box`（旧版按内容盒算，加上 padding/边框比容器宽约 22px），补齐并加护栏；② 设置界面标题行右端加 **GitHub 项目主页链接**（原生面板 + 独立设置页两处）；③ 统一控件风格（模型下拉/文本框统一「填满可用宽度、上限 340px」；任务板弹窗 `.hwb-input/.hwb-select` 补上此前缺失的盒模型与刻度）。0.19.6 落用户界面文案与预设两条要求 —— ① 等待占比不再输出「（覆盖 n/N 轮）」（`waitRatio` 只给纯百分比，零覆盖仍 `未记录`）；② agent preset 展示名 `WebCode 真实模式` → **`wecode模式`**，description 与 persona 压成简短声明（去掉 303 份/23,636 次的统计叙述）；③ 设置页与右栏文案按「官方解释长短」精简：删掉「正在运行（子代理 / Team）」整卡（含 7.9KB 的 `AgentRoster` 组件、`rosterStateOf`、`.hwb-roster*` 样式）、「附件探针」与「最近一次实际投递」、限流退避与真机事故叙述、会话隔离的机制句、「全局指令」重复句；④ 「首轮提示词（只读）」卡重排美化（信息面不变）。另修**插件市场整页崩溃**：`dshmarket` 1.55.0 直接解构 primitives 的 `Icon*Outline14/16`，而 DSH 0.1.7-alpha.2 已把该族改名为 `…Regular/Medium` → `h(undefined)` → React error #130；已把 web profile 的 `dshmarket` 升到 **1.59.0**（其 bundle 带 `ICON_ALIASES` 两代名字回落）。0.19.5 修 DeepSeek 附件确认判据假阳性（正文同名文本被当成附件证据）、图片轮缺名字证据且失败判死整轮、长文本写入 O(n²)（400k 需 72s）三件，见下节。0.19.4：0.18.0 曾真机生效（线上 3080 实测 `build.version=0.18.0`、`hash a86bce573e0b`）；0.19.0 落三项用户要求；0.19.1 边界1/2 澄清落地 + 打包安装；0.19.2 修 DSH 升到 0.1.7-alpha.2 后的两个真故障（`settingsScope` 改名致整块不挂载、primitives 图标改名致等待药丸消失），诊断见 [`diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md`](diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md)；0.19.3 落用户五点（自动续跑整会话累计 + 完整提醒、WebCode 真实模式 preset、modsearch 实测、长上下文三/四轮、`imageRequestPricing` 修复）**并已真机重启生效**（3080 实测 `build.version=0.19.3`、`hash c6365c4acbbd`）；**0.19.4 落用户三点**（计费三类实测单价 + 绝不低估、右栏站点目录统一账号下拉含真实头像/昵称与「新账号」、relay 按账号多通道并发 + 会话绑定唯一账号） |
| **0.19.0 用户三项要求（原话，2026-09-22）** | ① 「已经登录网站实现和登录网站参考官方浏览器本地实现能原生打开」+「设置界面和右侧本插件带来的登录必须落实一处，必须脱离本机浏览器可用（零外部？就是自带浏览器完整实现）」；② 「优化任务板的 UI 统一官方 harness 审美！另外我想要的任务板是人能够手动添加任务的！然后是审批界面，参考 office 左正文，右划线编辑评论并合理显示：完全参考 office 实现」；③ 「删除参考官方用的 team 面板，和我设想的 team 不同，参考错误了……重构 team 功能，本插件的并列多会话组成的 team」。 |
| **0.19.0 ③ 关键依据：用户对「Team」的定义（逐字，`doc/user-voice-log.md:3670`）** | 「**team 不是指的官方 team 那样，我想更多指的是能够充分发挥本多站点（如果实现）的优势，能够做到中心对话区域做到：并列不同模型对话进行回复**」。⇒ 本插件的 Team = **若干条各自独立的网页会话并排**（每列一个站点、各持稳定 `sessionKey`、各自接着聊），落点是**中央对话区**；**不是**官方 `agentTeams` 的右栏花名册。0.17.3 那份「参考官方 agentTeams」的实现是**参考错了**。 |
| **0.19.0 ③ 已落地：删除官方花名册 Team 面板，Team 收敛为并列多会话** | 删掉 `client.cjs` 的 `TeamPanel` 组件（原 `:996`，读官方 `agentTeams.listMembers`）与其右栏标签页注册 `sidebarRightTabs.register`（`kind 'webcode-team'` / `id 'dsh-webcode-bridge/team'`）+ `slots.inject('sidebar.right.pane.tab')`，连同 `TEAM_ID`/`TEAM_KIND` 两个常量。**保留** `roster.js` 对官方 `agentTeams` 的读取：它仍是**任务板** `listTasks` 的官方来源与设置页花名册的数据源——删的是「把它当成本插件的 Team」这一层呈现。正解 `MultiModelCompareView` 保留并强化，注册在 `conversation.view`（中央对话区）；其 `label` 由「三列模型对比」改为「**并列多会话**」——该视图按数组驱动支持 2~4 列，旧名在用户加到第四列时就是一句**假陈述**。 |
| **0.19.0 ③ 护栏（含反向验证）** | `test/team-compare.test.mjs` 新增 2 条：① 「官方 agentTeams 花名册面板不得复活」（`TeamPanel` 函数名 / `'dsh-webcode-bridge/team'` / `'webcode-team'` 三处字面量皆不得出现 + 正判据「必须注册到 `conversation.view`」——**只删不加 = 用户再也找不到 Team**，是另一种失败）；② 「视图必须自述『并列多会话 Team』且列数自适应」。`test/client-render.test.mjs` 的标签页用例**反转为反向断言**（`webcode-team` 不得再被注册、`dsh-webcode-bridge/team` 座位不得存在），并新增「并列多会话必须注册在 `conversation.view`」用例（为此给测试桩加了 `conversation.view` 注册收集，断言**注册位置**而不只是「源码里有这个组件」）。同时删掉 3 条验证已删面板的旧用例（成员角色/状态渲染、inactive 措辞、只有 lead 的说明）——用例随被验证对象一并删除。**反向验证**：把 `TEAM_ID` 加回 → `team-compare` **fail 1**；还原 → **7/7**。 |
| **0.19.0 ② 已落地：任务板 UI 统一官方 harness 审美** | 逐条对照参考实现 `reference/dsh-task-board/src/client/board.module.css`（用户指定以它为基准）改：① 主按钮底色 `brand-primary` → **`--dsw-alias-button-info-fill`**（官方**按钮语义** token 才有配套 hover 档），hover 换 `--dsw-alias-button-info-hover`，**不再**整块 `opacity:.9`（那会把文字一起调淡）；② 按钮字色写死的 `#fff` → `--dsw-alias-label-primary-foreground`；③ 危险按钮写死的 `#dc2626` → `--dsw-alias-state-error-primary`；④ 卡片 hover 的 `transform:translateY(-1px)` **删除**（官方列表行 hover 不位移；位移会让整列文字随鼠标扫过抖动），阴影改走 `--dsw-elevation-prominent`，不再写死 `rgba(0,0,0,.08)`；⑤ 看板 `repeat(5,1fr)` → `repeat(auto-fit,minmax(180px,1fr))`（写死五列时窄面板下五列一起被压到读不出字）；⑥ 圆角收敛到官方 8/12 刻度（原为 6/8/10 混用）；⑦ 表单输入走 `--dsw-specific-input-major` + 聚焦色 `--dsw-alias-state-business-primary`（同参考实现 `.input`/`.input:focus`）。 |
| **0.19.0 ② 抓到的真缺陷：任务板用 `alert()` 做反馈（11 处，已全部修掉）** | `alert`/`confirm` 是**阻塞式**浏览器模态：弹出期间 JS 主线程停住，5 秒轮询的下一拍与所有在途 fetch 回调全部被卡住——用户看到的是「点一下保存，整个面板僵住」。它也不属于官方 harness 的任何一种反馈形态（参考实现一律用内联 `.formError` 文案）。已把 6 条链路（更新/删除/批注/解决/实施/创建）与新建弹窗的校验全部改为**内联反馈**：任务板级 `boardNotice` 横幅（`role=alert`/`status`，走 `--dsw-alias-state-error-primary` / `state-success-primary`）+ 弹窗字段级 `hwb-form-error`。**保留**唯一的 `confirm`（删除为不可逆动作，官方同样要一次确认）；并在 `onUpdate` 里补上「服务端 CAS 拒绝必须如实报出来」——这正是两人同时改同一条任务时用户唯一的线索。**护栏**：新增「不得用 alert 做反馈」用例（只查三个任务板组件体，且**先去注释**；正判据要求 `boardNotice` 状态与两个渲染出口都在）。**反向验证**：放回一处 `alert` → **fail 1**；还原 → **pass**。 |
| **0.19.0 ② 审计发现的坑：官方 token 白名单护栏 + 我自己写错过一次** | 新增护栏「CSS 只许用官方已有的 dsw token」。**为什么需要白名单而不只是「禁十六进制」**：只禁十六进制会放过 `var(--dsw-alias-label-inverse)` 这种**看起来像官方 token、实际不存在**的写法——它会静默落到 CSS 回落值，浅色主题下看不出任何异常，只有换主题才暴露。**而本轮 Lead 自己就写错过这一次**（凭直觉编了 `label-inverse`），是护栏先红才发现的；正确名称为 `--dsw-alias-label-primary-foreground`（参考实现 `board.module.css:393`）。白名单逐条取自参考实现，共 31 项。**反向验证**：把正确 token 换成不存在的名字 → **fail 2**；还原 → **pass**。 |
| **0.19.0 ② 已落地：Word 范式审批界面（补上「正文侧留痕」这一环）** | 已有左右分栏（`hwb-review-split`，正文占主区、批注走右侧页边、两者各自滚动、窄屏 <720px 回落上下）。本轮补上**此前缺失的那一环**：正文侧「已批注片段」锚点清单（`hwb-review-anchors`）——Word 正是靠**正文里被底纹标出的那段文字**回答「这几条批注到底说的是正文哪一段」，此前只有一条临时「当前选中」提示，刷新或点开后用户就说不出锚在哪了。锚点可点、点击把对应批注卡滚进视野。**刻意不改 `contenteditable`**：那会把「编辑正文」从原生控件换成自绘富文本，光标/输入法/撤销栈都要自己实现，收益只是着色而代价是整块编辑体验。**踩到并修掉一个自己写的错**：锚点原本用过滤后的数组下标去指第 i 张批注卡，只要有一条**无引用片段**的批注夹在中间，后面的锚点就全部错位一格、点到别的批注上，而界面上完全看不出来（跳转目标看起来同样合理）——改为 `map` 时带上原始下标再 `filter`。**护栏**：「Word 范式三件套（划词/页边独立滚动/正文侧留痕）」用例，含「锚点必须自带原始下标后再过滤」这条。 |
| **0.19.0 ① 抓到的真缺陷：站点目录仍把官方 iframe 浏览器 / `window.open` 当登录入口** | 0.18.0 修掉了设置页「打开网站」按钮与工具条 🌐 按钮，但**漏了站点目录的账户菜单项**：它写着「🌐 在内置浏览器打开/登录」，实际调 `ctx.sidebarRight.openTab('browser')`（拿不到就回落 `window.open`）——前者是官方 `ui-sidebar-browser` 的 **iframe**（另一个进程、另一份 cookie 罐），后者是**用户的日常浏览器**。**在这两处登录，桥永远不知道**，正是用户「登录必须落实一处」要根治的那个缺陷在同一文件里的第二处。已改为调 `POST window {action:'open'}`——与工具条 🌐、账户卡片「登录窗口」**同一个控制面动作、同一个 profile**（入口可以有多个，**落点只有一个**）。同时补上单账户站点的登录入口：原先账户菜单只在 `multi`（>1 账户）时渲染，于是「登录」对绝大多数站点**根本不可达**。 |
| **0.19.0 ① 护栏（加强 ⑦ 号，含反向验证）** | `test/settings-transport.test.mjs` ⑦ 号（0.18.0 立的「登录入口不得指向桥以外的浏览器」）此前只钉住了工具条某个 `aria-label` **字面量**，这正是上面那条缺陷漏网的原因。本轮按**组件体**（`SiteCatalogBody`）钉住：`openTab('browser')` 与 `window.open(` 都不得出现，且正判据要求它必须走 `apiSoft('window', {…action:'open'})`。**反向验证**：把 `openTab('browser')` 那路加回 → **fail 1**；还原 → **7/7**。 |
| **0.19.0 测试基础设施的真缺陷：CRLF 让「去注释」一直空转** | 本仓库文件是 **CRLF**（`\r\n`），而两处护栏用 `split('\n')` 去注释：切分后每行尾部残留 `\r`，`^\s*\/\/.*$` 的 `.*` 会退回空串、`$` 对不上行尾，于是**整行注释根本没被去掉**。已用最小复现证明（同一段 CRLF 文本：`split('\n')` 结果仍含注释串，`split(/\r?\n/)` 才去掉）。**后果**：`client-render.test.mjs` 那条「轮询不得覆盖用户输入」的「先去注释」承诺一直在**空转**，它通过只是因为目标串 `}, [task]);` 恰好没出现在注释里——换一个确实出现在注释里的串（如 `openTab('browser')`）就会当场误报。两处判据已改为 `split(/\r?\n/)` 并各自写明这条教训。 |
| **0.19.0 第一轮独立审查（teammate `reviewer-1`，对抗式，含 8 条反向验证）** | 报告 `.tmp/review-round1.md`。**全量读数 886/886 exit 0**（其自行复跑，与交接的 885 不符——交接写于更早一刻，已按实测更正）。**4 条发现，3 条为真并已修**：<br>① **【阻断，Lead 同轮自查也已抓到并已修】** 站点目录登录调用了**另一个组件的局部函数**：`siteSlot` 定义在 `SiteAccounts` 函数体内，而调用点在 `SiteCatalogBody`——两个顶层函数无词法包含，**点击必抛 `ReferenceError`**，登录窗口根本不会打开。**关键点：`node --check` 与 `new vm.Script()` 都判 SYNTAX OK，语法检查抓不到，只有查作用域才发现**。修法：本组件内自定 `slotOf`（语义与 `siteSlot` 逐字一致，两侧各注明对偶关系）。<br>② **【严重，已修】** 防连点用了**全局锁** `if (busySid) return;`，而该请求要等浏览器起来（最长 120s）——期间点**其它站点**被**静默丢弃**，用户只看到上一个站点的成功回执、自己这次点击零反馈（正是本项目记为「说做了、其实没做」的那类）。且多账户菜单项**只有文案变化、没有 `disabled`**。修法：改按站点判定（`busySid === sid`）、两个入口都加 `disabled: busySid === sid`、解锁改为条件式 `setBusySid(cur => cur === sid ? '' : cur)`（无条件清空会抹掉后来那次点击的忙碌态）。官方 `Menu` item 的 `disabled?: boolean` 已核实存在（`reference/dsh-market/src/client/primitives.d.ts:57`）。<br>③ **【一般，已修】护栏逃逸**：我写的 ⑤ 号判据是 `if (!/const slotOf/…) { assert.ok(!/siteSlot\(/…) }`——只要**保留** `slotOf` 定义而把**调用处**改回 `siteSlot(...)`，`if` 分支不进，缺陷回来了却**不变红**（reviewer-1 反向验证 I 实测「不变红」）。修法：改为**无条件**断言且不依赖具体函数名（判据是「本组件不得出现定义在别处的 siteSlot 调用」这一性质），并补正判据「自定义的拆解函数必须真的被调用」。<br>④ **【建议，已修】零护栏**：多账户忙碌文案此前无任何护栏（反向验证 F 不变红）。已随 ② 一并纳入 ⑥ 号判据组。 |
| **0.19.0 第一轮审查的反向验证（Lead 复跑，证明新护栏不是装饰品）** | 逐条改坏再跑，**三条此前「不变红」的逃逸形态现已全部变红**：I（保留 `slotOf` 定义、调用改回 `siteSlot(`）→ **fail 1**；F（删掉菜单项 `disabled`）→ **fail 1**；G2（改回全局锁 `if (busySid) return;`）→ **fail 1**；全部还原后 **7/7 pass**。reviewer-1 独立跑出的 8 条判据中原本 6 条有效、2 条逃逸（I/F），本次修完 8 条全有效。 |
| **0.19.0 reviewer-1 自身的两条方法论教训（如实记，本项目同类坑第 N 次出现）** | ① 它的反向验证脚本用 `\n` 拼字面量做 `replace`，而 `client.cjs` 是 **CRLF** → 替换**静默失效**，于是把两条其实有效的护栏（E/G）误报成「装饰品」；改用 `\r\n` 后两者正确变红。**这正是本项目刚记过的那个 CRLF 空转缺陷，在审查脚本里又复现了一次**——说明「换行符」在本仓库是一个反复出现的真陷阱。② 它的沙箱是 17:19 拷的，而某条护栏 17:35 才写入 → 导致该条被判无效。教训：**反向验证必须同时冻结 lib 与 test 两侧，并对每次替换断言「确实生效」**（只比较「跑完的结果」，无法区分「护栏失效」与「替换没生效」）。 | 验证版本证据：`GET /__webcode/status` 起止各读一次均为 `build.version=0.18.0` / `hash a86bce573e0b`（仅代表当前线上进程，不含尚未重启生效的本轮 `client.cjs`）。**① 五站可用性**（单站 1 次、零重试、站间实测最小 32s）：`glm` **通过**（`reply:"9"` 5.2s）、`kimi` **通过**（`reply:"9"` 5.9s，此前 `probe-fallback` 弱判据此次为真阳性）、`doubao` **失败但理由真实**（502 `NEED_LOGIN`；发送前缓存的 `loggedIn=true/probe-fallback` 是弱判据**假阳性**，失败后 `/status` 自我更正为 `probe-bad/needLogin=true`，per-site store 为 `{}` 互证——桥**没有谎报成功**）、`qwen` **失败但理由真实**（502 `NEED_LOGIN`，与已知 `loggedIn=false` 一致）、`zai` **失败、根因未定位**（502@241.1s；网络可达、页面已开新会话说明消息送达，但会话未落地；**未取得 502 正文、未观察到 captcha 证据，故不归因验证码**——按纪律记「读不到」）。**② 并列多会话语义通过（强证据）**：轮 1「只回一个数字：7」→ 轮 2「上一个数字加 1」答 `"8"`——答对只有**真续上同一对话**才可能；`fresh:true→false`、`webSessionId 6ab24430…` 前后一致且与页面 cid 互证。**③ 任务板全链路通过**（6 端点全 ok），两条诚实性核对均过：过期 CAS 被真实拒（`revision-mismatch: expected 0, actual 1`）、`task-implement` 如实回 `dispatched:false, dispatchBy:"client"`。**④ 清理通过**：其造的探针可见行归零。 |
| **0.19.0 由真机验证暴露的两条口径问题（已验证，需存档以免下次踩坑）** | ① **`/status` 的 `conversations` 是「默认 deepseek 站点」的映射**（128 键已满额裁剪），**不含**发往其它站点的 key；`session-slot` 端点也**不按传入 `siteId` 路由**（实测传 `siteId=zai` 仍回 `siteId:"deepseek"`）。⇒ 跨站核对**必须**读该站 `profileDir` 下的 `webcode-sessions-<siteId>.json`，用 `/status.conversations` 做跨站验证会得到错误结论。② **任务台账的存储根**取 `body.workspaceRoot || config.workspaceRoot || process.cwd()`：不传 `workspaceRoot` 时线上落到**宿主 cwd 工作区**（实测 `…\competition\A0-Robocup\.webcode-tasks\ledger.json`）而**不是本仓库**，且两份**互不可见**——那才是任务看板 UI 读的那一份。 |
| **0.19.0 第二轮独立审查（teammate `reviewer-2`，全局一致性与回归视角）—— 部分完成，如实记** | 该 teammate **中途失败退出、未产出报告文件**（`.tmp/review-round2.md` 不存在），只留下若干探针脚本（`.tmp/reviewer2-probe-*.mjs`，其 seats 探针自带 harness 缺陷、无法运行）。**它在退出前给出的唯一结论是精确的**：「`teamSource` 是本轮**可证明**失去唯一消费者的那个字段」——已核实为真并已修（见下行）。其余角度（删 Team 后的死代码、登录入口全局清点、sessionKey 语义一致性、回归契约）**由 Lead 自己逐条复核并留痕**，不因 teammate 失败而跳过。 |
| **0.19.0 第二轮发现（真，已修并验证）：`teamSource` 链路断裂** | 核实：`roster.js:571` 一直在算 `teamSource`、`web-control.js:550` 一直在透出它，而**唯一渲染过它的就是被删掉的 `TeamPanel`** → 删面板后这条链路断了（服务端算、前端不读），正是本项目记过的「只声明不接线」形态。**处置不是删服务端字段**：`roster.test.mjs:391/400` 把 `teamSource`/`tasksSource` 钉为 `projectRoster` 的**公开契约**（并以「两个来源都没读到时不得谎报来源」为断言），删字段会破坏契约、也会让「读不到 ≠ 没有」失去依据。改为**把断掉的消费端接回来**：`useRoster` 取回两个字段（含异常兜底分支），存活的花名册渲染来源标注。**接线时又抓到一处自己写的问题**：只加渲染、没在 `useRoster` 里捕获字段，`rows.teamSource` 恒为 `undefined`——看着像接上了、实际什么都不显示（同一个缺陷形态的第二次出现），已一并修掉。**护栏**：「teamSource/tasksSource 必须『服务端透出 → 客户端取 → 界面渲染』三段齐全」，三段缺一即红。**反向验证**：把 `useRoster` 里那两行去掉 → `fail 1`；还原 → **54/54**。 |
| **0.19.0 第二轮：Lead 自行复核的四个角度（teammate 失败后不跳过）** | ① **删 Team 后的死代码**：逐个追 `projectTeam`/`teamSource`/`membersError`/`rosterStateOf`/`useRoster`/`sourceText` 的消费者——**结论：都不是死代码**。`useRoster` 仍被设置页花名册用（第 1004 行），`rosterStateOf`/`taskStatusOf` 被任务板与花名册共用，`roster.js` 的官方 `agentTeams` 读取仍是**任务板 `listTasks`** 的官方来源（**不能**当死代码删）。唯一真断链的 `teamSource` 见上行。② **登录入口全局清点**：现存入口四处（设置页账户卡片「登录窗口」、站点工具条 🌐、站点目录单账户「登录」按钮、站点目录多账户菜单项），**逐一对齐到同一个控制面动作 `POST window {action:'open'}`**，落点唯一。③ **`sessionKey` 语义一致性**：任务派发（`task-implement` → `chat`）与并列多会话（每列一个 `sessionKey`）走的是**同一个 `POST chat` 端点、同一套「槽里确实存着才 resume」判据**（`web-control.js:1243-1246`），**不存在两套语义**。④ **右栏座位契约**：实测删 Team 后 `sidebar.right.pane.tab` 座位集合为 `{dsh-webcode-bridge, dsh-webcode-bridge/site}`、`sidebarRightTabs` 类型集合为 `{webcode-bridge, webcode-site}`，已把这两个**实测值**写死为判据（挡住「删过头」与「删不干净」两种失败）。 |
| **0.19.0 删除后全局一致性：清理过时注释（6 处）** | 删掉 Team 面板后，多处注释仍把它描述成**存活**的兄弟消费者，属于「与代码不符的过时注释」（`doc/comment-style.md` §3.3）。已逐处更正：`client.cjs:219`（`rosterStateOf` 的共用方）、`:852`（花名册）、`:934`（`useRoster` 的消费者清单）、`:971`（状态词共用方）、`:4280`/`:4294`（面板类名共用方）、`:4534-4536`（右栏 kind 清单仍写「**两个**标签页」）。**做法**：不是简单删掉旧句，而是把「它曾经是什么、何时因何被删」写清楚——本仓库的注释纪律要求保留历史（同 `progress.md` 不改写历史行的约定）。**用户可见文案**：`README.md` / 包内 `README.md` 全文无「Team」字样，无需改动；`settings-page.js` 无残留。 |
| **0.19.0 自查抓到的第三个真缺陷（第一轮修复自身引入的形态）：单值忙碌态无法表示多站点在途** | 第一轮审查发现「全局锁 `if (busySid) return;` 会静默吞掉其它站点的点击」后，我把它改成按站点判定 `busySid === sid`——**但仍是单值**，于是引入了一个新的、更隐蔽的缺陷。**用状态机模拟逐步复现**：`点A`（busy=`A`）→ `点B`（busy=`B`）→ **B 先返回** ⇒ `setBusySid(cur => cur === 'B' ? '' : cur)` 把忙碌态**清空**，而 **A 其实还在开窗**（这条请求要等浏览器起来，最长 120s）⇒ **A 的按钮重新可点** ⇒ 再点一次就拉起**第二个窗口**，覆盖同一个 profile —— 正是这个忙碌态本来要防的那件事。修法：换成**集合** `busySids`（`isBusy(sid)` 判据、入集合去重、解锁只 `filter` 掉自己那一站）。这正是「用一个状态位表达两种事实」的经典错误。 |
| **0.19.0 上一条的护栏与反向验证** | ⑥ 号判据组从「钉某个比较表达式」改为**钉集合语义**：必须有 `busySids` 数组状态、有 `isBusy(sid)`、**不得**再出现单值 `setBusySid(`、两个入口都要 `disabled: isBusy(sid)`、入集合去重、解锁按站点 filter。**反向验证**（用脚本做变异并**先断言替换确实生效**——上一轮 reviewer-1 正是栽在「替换静默失效导致误判」上）：把集合改回单值 → `FAIL(1)`；还原 → `PASS`；还原后与原文件**逐字一致**。 |
| **0.19.0 第二轮的 `regression.test.mjs` 假失败（如实记，避免下次误判）** | 一次全量跑出现 `regression.test.mjs` 超时（400,668ms）+ 1 fail，而**单独跑该文件 54/54 通过**。根因：该文件含多条**真实驱动计时**用例（单条 20s / 40s / 60s），当时机器上**并发跑着多个 `node --test` 进程**（我的后台全量 + teammate 的验证/审查复跑），进程争用把某条推过了文件级超时。**判据**：全量测试**必须串行、独占**跑；并发跑出的红不是代码缺陷。已在独占状态下复跑得 **887/887 exit 0**。 |
| **0.19.0 第三轮对抗审查（子代理，独立于前两轮）：抓到 2 条真缺陷 + 3 条护栏逃逸** | 前两轮看的是「新代码对不对」与「全局一致不一致」；第三轮专查**测试套件看不见的**东西（动态驱动真实组件、变异测试）。**当时全部 887 条单测是绿的**，下面这些都逃过了它。 |
| **0.19.0 第三轮·阻断级真缺陷：`MultiModelCompareView` 一次挂载只能发一句话** | `setSending(false)` 是全文件**唯一**的解锁点（`setSending` 仅出现两次），而它被写在**微任务**里的一个 `setCols` updater 内：`Promise.resolve().then(() => setCols((prev) => { if (prev.some(c => c.status === 'streaming')) return prev; setSending(false); return prev; }))`。那段微任务排进队列时，上面**刚把每一列设成 `streaming`**，而 `api('chat')` 的网络往返**还没回来** ⇒ 判定「仍有 streaming」⇒ 提前 `return prev`，**解锁行永不执行**。后果：三列最终都显示「已完成」，而发送按钮**永远停在「发送中…」且 disabled** —— 用户的整个 Team 功能**一次挂载只能问一句**；而 `conversation.view` 是中央**常驻**视图、不随交互卸载，**不会自愈**。子代理动态复现（从已注册的 `conversation.view` 槽取出真实组件、驱动表单提交、再解析 chat 请求）：提交后 `disabled:true`，三列回复到达后**仍是** `disabled:true`。**修法两条**：① 用 `pendingRef` **计数**在途列数（发出 `+= jobs.length`、`finally` 里 `-= 1`、归零才解锁）——`finally` 保证失败也减，不存在「一列异常就永久锁死」；② **把 `setSending` 移出 updater**：在 `setCols` 的 updater 里调另一个 setState 是**不纯的 reducer**，StrictMode 双调用下行为未定义，即便修好提前返回也不该这么写。 |
| **0.19.0 第三轮·严重真缺陷：详情页的写操作反馈一条都渲染不出来（本轮自己引入的回归）** | 16 处 `notify(...)` **全部**位于 `TaskDetailNotionView` 的写回调（保存/删除/批注/解决/按批注派发），而 `boardNotice` 横幅只在**看板/列表那一支**渲染；`TaskBoardPanel` 在 `if (selectedTaskId)` 里就 `return h(TaskDetailNotionView, …)` 了，**永远走不到**那个渲染点。于是用户在详情页（这些操作的**唯一**入口）做的每一次写都**没有任何反馈**：没有「已保存。」、没有「批注已写入。」，更看不到「**保存被拒: revision-mismatch**」与「**派发失败**」。子代理动态复现：`task-update` 真的发出、`task-implement`→`chat` 真的发出，而「已保存。」/「已按批注派发」在任何渲染树里**都不存在**。**这是本项目反复记过的「说做了、其实没做」——写入确实到了服务端，但用户看不到任何结果，包括被拒绝的结果。** 旧实现用 `alert()` 时不会有这个问题（阻塞弹窗与挂载分支无关），所以这是**本轮把 alert 换成内联横幅时丢掉的那一半**。修法：把 `notice`/`onDismissNotice` 传进详情页并在其体内渲染（两处渲染点：看板 + 详情页）。 |
| **0.19.0 第三轮·3 条护栏逃逸（子代理在沙箱副本里逐条变异验证，均已修）** | ① **`onImplement` 忽略 chat 结果**：把成功/失败分支换成一句无条件成功 ⇒ 派发失败被报成成功，**没有任何断言覆盖 chat 结果的消费**。② **`verdictOf` 的 `ok === false` 分支被反转**（改成 `return { ok: true }`）⇒ **服务端明确拒绝被报成成功**，正是该判据 docstring 声称要防的「假成功」；漏网原因：上一版**只钉了白名单那一支**（`ok === true`），黑名单分支从未被钉。③ **按站点忙碌锁退回全局锁**（`if (isBusy(sid)) return;` → `if (busySids.length) return;`）⇒ 重新引入「其它站点点击被静默吞掉」；漏网原因：判据只禁止**单数**字面量 `if (busySid) return;`，只断言 `isBusy` **被定义**、从未断言它**被用作守卫**。（子代理另跑了一条对照变异 `const __unused = null;`——照样存活，说明其方法能区分「真缺陷」与「无害噪音」，不是见变异就红。） |
| **0.19.0 第三轮修完的反向验证（Lead 复跑，每条都断言「变异确实生效」）** | 4 条新/改判据逐条变异：发送锁退回「微任务扫 streaming」→ **FAIL(1)**；`verdictOf` 黑名单分支反转 → **FAIL(1)**；详情页横幅渲染点删除 → **FAIL(1)**；忙碌锁退回全局锁 → **FAIL(1)**。全部还原后**逐字一致**并复跑 PASS。**方法论要点**：脚本每次都先断言「替换确实生效」再判定（前两轮各栽过一次「替换静默失效 → 误判护栏无效」），因此本次没有假阴性。 |
| **0.19.0 第三轮：明确「无发现」的类别（子代理逐项核实，不是略过）** | ① **跨作用域/未定义标识符 —— 干净**：用大括号配对的作用域走查，解析五个组件里每一个被调用的标识符；此前报的 `siteSlot` 跨组件引用**确已修好**（`slotOf` 现在本地定义）。仅有的「未解析」命中都只出现在**注释里**（如 `openTab`）或关键字/内建。② **hooks 规则 —— 干净**：逐组件枚举每个 hook 调用与非表达式 `return`，五个组件里**每个 hook 都在每个提前 return 之前**。③ **`busySids` 并发逻辑 —— 干净**（改成数组后）：解锁按发起站点 `filter`，且 `apiSoft` 不抛异常，不存在「永久忙碌」或「永久空闲」的交错；此前单值版本那个 `点A→点B→B先返回清空A` 的交错**确已消失**。 |
| **0.19.0 第三轮逃逸 #1 已补判据（`onImplement` 消费 chat 结果）** | 子代理指出逃逸 #1（把 chat 的成败分派换成无条件成功）**零覆盖**。核实：代码本身是**对的**（`ok` → 成功、否则 → 「派发失败」），缺的是断言。已把这一段与其它写链路统一走 `verdictOf`，并新增判据「按批注派发：chat 的真实结果必须决定成败」——要求两步都经判定、失败分支必须存在且带真实原因、且**禁止** `api(chat)` 之后无条件 `notify('ok')`。**反向验证**（脚本先断言变异生效）：把成败分派换成一句无条件成功 → **FAIL(1)**；还原逐字一致 → PASS。**方法论**：该脚本第一版用字面量拼锚点、被 **CRLF** 挡住（「锚点未命中」），改用正则后一次命中——**这已是本仓库同一陷阱的第 N 次出现**，故脚本一律按正则/按行处理，并在锚点未命中时明确报「本次验证无效」而不是「护栏无效」。 |
| **0.19.0 第三轮顺带修掉：注释被契约测试当成真实调用** | 修完上面两条后 `client-server-contract.test.mjs` 报 **`GET chat` 未在服务端注册**（真机是 405）。核查：`chat` 服务端**只有 POST**；触发者是**我写的注释**——它在解释旧缺陷时逐字引用了「不带第二个参数」的 `api('chat')`，而契约测试按**源码文本**解析调用（**不剥注释**），于是把「说明」读成了「GET 调用」。这与本仓库记过多次的坑同源。修法：注释改写成散文措辞（「下面那句 POST chat」），不再出现可被解析为调用的字面量。**可复用教训**：本仓库有三处判据直接按源码文本解析（契约测试、护栏、变异脚本），它们**都不剥注释**——注释里不要写可被解析成真实调用的代码字面量。 |
| **0.19.0 第三轮顺带修掉：注释闸门 §3.6 抓到「逐字引用旧代码」** | `lint-comments` 报 **CS005 WARN**：「连续 18 行行注释中有 3 行像代码，疑似被注释掉的代码块」。触发者是我在 `client.cjs` 里**逐字引用旧缺陷写法**（那段 `Promise.resolve().then(...)`）来解释成因。**按闸门提示改判据而不是绕过它**（该脚本自己的纪律）：把引用改写成散文描述（「原先的做法是『排一个微任务…扫一遍列状态…』」），并在注释里注明**为何刻意不逐字引用**（本仓库多处判据按源码文本解析且不剥注释）。改后闸门 PASS（149 文件 error 0 / warn 0）。 |
| 0.17.3 落地文件 | `package/dsh-webcode-bridge/lib/tool-transport.js`（注释状态更新为已接线）、`package/dsh-webcode-bridge/lib/tool-parser.js`（支持 opts 并更新状态）、`package/dsh-webcode-bridge/lib/browser-driver.js`（`detectChallenge` 扩充国内风控特征）、`package/dsh-webcode-bridge/lib/index.js`（接线 `teachFor`；**`parseToolFence` 实为死导入，见「更正 C」**）、`package/dsh-webcode-bridge/lib/task-ledger.js`（新增字段与评论状态机）、`package/dsh-webcode-bridge/lib/web-control.js`（注册看板/批注/实施/chat 控制动作）、`package/dsh-webcode-bridge/lib/roster.js`（`projectTasks` 优先聚合台账）、`package/dsh-webcode-bridge/lib/client.cjs`（看板、Notion 展开页、三列对比视图及配套 CSS）、`package/dsh-webcode-bridge/test/task-ledger.test.mjs`（新增批注断言）、`doc/user-voice-log.md`、`doc/UNDERSTANDING.md`。 |
| 0.17.3 测试与闸门（本轮实跑） | 核心全量单测 **112/112 通过、exit 0**：`client-render.test.mjs` (48/48)、`client-server-contract.test.mjs` (2/2)、`task-ledger.test.mjs` (25/25)、`tool-transport.test.mjs` (10/10)、`roster.test.mjs` (27/27)。 |
| **0.17.3 第二轮（GLM 审查）与第三轮（真机/端到端）实测**（2026-09-22，用户要求「完整三轮」） | **第二轮**：用户明确「gemini 现在做不到，请你用 glm」，故审查子代理改用 `webcode/glm:glm-5.3`（`list_subagent_models` 实测可用；`little-gemini/gemini-3.8-flash` 连续两次未产出结论即中止）。GLM 子代理给出可核实结论：`client.cjs` 的 `refreshLedger` 只有 `clearInterval`、**没有**在途请求写回保护 → 卸载后仍 `setState`。**第三轮**：全量单测 **867/867 exit 0**（399s）；真机 `/status` 实测线上 3080 仍是 **0.17.2**（`build.hash dd9a81a82725`），新任务端点 `POST task-*` 全部 **405**（路由不存在）⇒ 0.17.3 **未生效**，需重启。**本轮自审另抓到两处真缺陷并已修**（见下两行）。 |
| **0.17.3 自审缺陷 A：批注写路径的 CAS 被静默吞掉**（真缺陷，已修） | `web-control.js` 的 `POST task-comment`（:1106）与 `POST task-comment-resolve`（:1117）**一直在传**第五个参数 `expectedRevision`，而 `applyAddComment` / `applyResolveComment` 的签名**没有这个形参** —— 传进去的值被静默丢弃。实测取证（修前）：同一份台账连调两次、第二次带过期 `expectedRevision=999`，**两次都返回 `error = null`**。这不是「少了个校验」，是**假成功**：两个成员同时批注同一条任务，后到的覆盖前者而双方都收到 ok，且与本模块头注第 28 行把 CAS 列为「三道防线」之一的声明直接矛盾。修法：两函数补 `expectedRevision = null` 形参 + `revision-mismatch` 判定。护栏 `test/task-ledger.test.mjs` 新增「★ 批注写路径必须吃 CAS」（删掉判定即变红，实测 26/26 通过）。 |
| **0.17.3 自审缺陷 B：`task-implement` 谎报已派发，而客户端根本不发**（真缺陷，已修） | 服务端 `POST task-implement` 只**组装** prompt 就返回 `{dispatched: true}`；客户端 `onImplement`（`client.cjs`）拿到后**只弹一句「已向 AI 发起实施指令！请在任务会话或右栏中关注进展。」**，从不把 prompt 投出去 —— 按钮是死的，而用户被告知已经发送。这正是本项目反复记过的「说做了、其实没做」。修法：① 服务端如实标 `dispatched: false` + `dispatchBy: 'client'`（可核对的字段，不是注释里的一句话）；② 客户端真派发：拿 `res.prompt` 调 `POST chat`，并带 `res.sessionKey`；③ `POST chat` 新增 `sessionKey` 支持且**指定会话时不 fresh**（fresh 会把任务上下文每轮清掉，「以任务为核心实现会话」就断了）。护栏同下条。 |
| **0.17.3 第三轮：任务看板端点此前零路由级测试**（已补） | 全量 867 条里**没有任何一条**真的 POST 到 `/__webcode/task-*`；`control-routes.test.mjs` 里 `task-` 零命中。已补一条端到端用例，真实 HTTP 走通 建→批注→解决→改(CAS)→实施→删除：断言建任务**真写盘**（`.webcode-tasks/ledger.json` 存在）、空评论拒、过期 revision 拒、`task-implement` 标 `dispatched: false` 且**组装阶段不得替用户发消息**、`chat` 真投递到 driver 且 `sessionKey`/`fresh` 语义正确、软删后不进面板行、`task-ledger` 只许注册 GET（多注册 POST 会被 `client-server-contract` 判死路由）。`control-routes.test.mjs` **13/13 通过**。 |
| **0.17.3 自审更正 C：`tool-parser.js` 是死导入，而它的头注谎称「已正式接线」**（已更正） | `lib/index.js` 原先 `import { parseToolFence, createToolParser } from './tool-parser.js'`，但**全文件零调用**；`tool-parser.js` 头注却写着「经过 2026-09-22 接入：已在 lib/index.js 正式接线」。两者都是假话。实际接线的是 **`teachFor`**（`index.js:1146` 续跑重申、`:3290` 首轮落盘）——那才是计划 Task 1.4 要的「教学提示按 teachShape 选支」。已删掉死导入（连同同样零调用的 `transportShapeForSite`）并把 `tool-parser.js` 头注改回「未接线、只被单测引用」。**这与 `doc/review-0.17.x.md` §6「未接线」的判定一致**，是第三轮把它落到代码与文档的事实上。 |
| **0.17.3 真机缺陷 D：全新任务会话被 url-heal 采纳成「用户当前正开着的对话」**（真机抓到、已修、有反向验证） | **这是本轮最严重的一条，且是我自己上一行的修复引入的。** 重启后真机复验时发现：`POST chat` 带上**全新**的 `sessionKey`（`task-session-t3-muc2xo2n`）后，`/status` 的 `navTrace` 显示它被 `conversationNav` 判成 **resume**，`landedId` 与**本 DSH 会话**（`session-0f9fe6cf-…`）**同为 `37820be9-1286-4934-9b37-92001068d2ec`**。后果：任务指令被发进**用户当前正在看的那个对话**里，而 `chat` 返回的「回复」其实是用户上一条消息的原文（真机实测：reply = 我自己那句探针文本 + 我准备发的两条工具调用原文）。根因链：我写了 `fresh = !body?.sessionKey`（「传了会话键就不 fresh」），而 `browser-driver.js:2624` 的 url-heal 分支在「槽为空 **且 fresh=false**」时，会把**页面此刻所在的会话**采纳为本轮会话（`rememberConversation(key, fromUrl, 'url-heal')`）。url-heal 本身是对的（它救的是「失败轮次没落盘」的历史槽，见该处长注释），**错的是调用方把一个从未建立过的会话键当成可续会话递给了它**。修法：`fresh` 的判据改为「驱动槽里**确实存着** `webSessionId`」—— `const stored = target.conversationFor(sessionKey); const fresh = !stored?.webSessionId;`，并新增 `resumed` 字段供调用方核对。同时把末尾那句编出来的「成功」删掉：原先无驱动时回 `{ok:true, reply:'[已向 X 投递: …]'}`，改为 `{ok:false, error:'no-driver-for-site: …（消息未发出）'}`。**反向验证**：把判据改回旧写法 → `control-routes.test.mjs` **fail 1**；还原 → **13/13 pass**。护栏现在分开验两条路径（槽里有→resume、全新键→fresh=true 且不得采纳当前页）。 |
| **0.17.3 真机复验读数**（2026-09-22 用户重启后，全部为线上 3080 实跑） | `GET /__webcode/status` → **`build.version = 0.17.3`**、`build.hash = ed0d0bae4777`、`driver = deepseek / loggedIn=true`、`relay running=true consent=true` ⇒ **重启已生效，0.17.3 真的在跑**（重启前同一探针读到 0.17.2 / `dd9a81a82725`，且 `POST task-*` 全部 405）。任务看板五端点实测可达：`GET task-ledger` → 200；`POST task-create` → 200 且返回带 `assignedModel.siteId=glm`、`projectId=r3`、`sessionKey` 的完整任务；`POST task-comment` → 200（`resolved=false`）；**`POST task-comment` 带过期 `expectedRevision=999` → `{ok:false, error:'revision-mismatch: expected 999, actual 1'}`**（缺陷 A 的修复在真机上确认生效）；`POST task-comment-resolve` → `resolved=true`；`POST task-update`（status→in_progress）→ `rev=3`；`POST task-implement` → `{dispatched:false, dispatchBy:'client', prompt:'【任务执行指令】…'}`（如实标注，不再谎报）；`POST task-delete` → `status=deleted` 且面板行归零。**探针任务已全部清理**（`before: tasks=2` → `after: tasks=0`）。 |
| **0.18.0 范围（用户 2026-09-22 三条新要求）** | 用户原话：「① 我用的 gemini 做到 0.17.0 之后的任务，都严重掺水/未实现理想要求，请你真实实现……尤其注意除了 deepseek 之外已登录网站实现和登录网站参考官方浏览器本地实现能原生打开；② 请你优化任务板的 UI 统一官方 harness 审美！另外我想要的任务板是人能够手动添加任务的！然后是审批界面，参考 office 左正文，右划线编辑评论并合理显示：完全参考 office 实现；③ 删除参考官方用的 team 面板，和我设想的 team 不同，参考错误了……重构 team 功能，本插件的并列多会话组成的 team」。**判据**：从本轮起一切改动必须真机读数 + 护栏，不许把「写了代码」当「做成了」。 |
| **0.18.0 澄清（三条，避免做偏）** | ① 「dsh3」不是仓库里的参考目录——全仓库 grep 零命中；用户澄清是「dsh + 第 3 点」的连写，指让我自己找参考实现。② 审批界面 = **Word 批注栏范式**（左正文可划词高亮、右侧批注卡列出评论/回复/解决）。③ 官方右栏「浏览器」**不能**用于自动化——它是 `ui-sidebar-browser` 的 iframe 载体（自述「在 sandbox 中访问 HTTP(S) 页面」，不注入任何能力、不暴露 CDP），只适合预览；真正对应的是官方 `packages/browser-use` + Playwright MCP 的 `mode: attach`（明文支持「接入已有浏览器，使用其现有标签页和登录状态」）。另：OCS Desktop 是刷课用的、与本项目无关；登录态在 Firefox + 本项目内。 |
| **0.18.0 第一批（已完成并真机验证）：浏览器「零外部依赖」** | **发现**：驱动原先只认系统 Edge/Chrome/Brave（`defaultChromiumPath` 的候选表），而 `playwright-core` 是插件的**直接依赖**、它自带的 Chromium 本来就在本机却从没被用过。后果两层：① 没装浏览器的机器直接抛「Chromium-based browser not found」；② 登录态长期与用户日常浏览器混淆。**改法**：新增 `bundledChromiumPath()`，**自带 Chromium 优先、系统浏览器兜底**。**为什么必须自己扫目录**：真机实测 `chromium.executablePath()` 返回 `ms-playwright/chromium-1243/…`，而 **1243 根本不存在**（`exists:false`）——那是 playwright-core `browsers.json` 声明的**期望版本**，与磁盘实际版本（本机 1217/1232）可以不一致；直接采信它等于把「版本漂移」伪装成「浏览器没装」。故按 `chromium-<rev>` **revision 降序**取第一个真实存在的可执行文件。找不到回 `null` 由调用方回落系统浏览器，**绝不抛错**。 |
| **0.18.0 真机验证（自带 Chromium 驱动 GLM）** | 探针实测（跑完已删，不发任何消息以守风控纪律）：构造后 `executablePath = …\ms-playwright\chromium-1232\chrome-win64\chrome.exe`、`browserSource = bundled`；启动后 **`loggedIn = true`、`loginBasis = probe-ok`（强证据，不是回退判定）**、`needLogin = false`；`RESULT: BUNDLED-DRIVES-GLM-OK`、exit 0。即**自带 Chromium 真能驱动国内站点**，不是纸上谈兵。 |
| **0.18.0 真回归（我的改动引入、已修、有反向验证）** | `killOrphanEdgeForProfile` 原先用 WMI 过滤 `Name='msedge.exe'`。切到自带 Chromium 后实际进程名是 **`chrome.exe`**，过滤器**一个都匹配不到** → 孤儿浏览器继续持有 profile 单实例锁 → 下一次 launch 报 `ProcessSingleton`/`SingletonLock`；而自愈路径（`clearStaleProfileLocks` 的 EPERM 分支）**恰好也调用这个函数**，两条路一起失效。修法：按 `cfg.executablePath` 取 `path.basename` 作进程名。**反向验证**：改回写死 `msedge.exe` → `browser-source.test.mjs` **fail 1**；还原 → **2/2 pass**。 |
| **0.18.0 新增护栏与读数** | 新增 `test/browser-source.test.mjs`（2 条）：① `status()` 必须透出 `executablePath` 与 `browserSource`（三取值 `bundled`/`system`/`null`），且**自带 Chromium 在场时必须选它**；② 源码结构断言「孤儿清理不得写死 msedge、必须按 `cfg.executablePath` 取进程名」（与 `upload-attachment-structure.test.mjs` 同一纪律）。两条**都做过反向验证**。**全量 → 872/872 通过、exit 0**（399s）。台账闸门另抓到漂移（实际 74 个测试文件、台账写 73），已同步。 |
| **0.18.0 第二批（已完成）：浏览器解析/安装抽成单一模块 + 控制面入口** | 上一批把「自带优先」写进了 `browser-driver.js`，但**面板要报状态、缺浏览器要能装**这两件事也得有同一份判据。新增 `lib/browser-runtime.js` 作为**唯一真相**：`findBundledChromium()`（扫 `chromium-<rev>` 按 revision 降序）、`findSystemChromium()`（系统兜底）、`resolveBrowserExecutable()`（返回 `{path, source, revision}`）、`isBundledChromiumPath()`、`playwrightCliPath()`（用 `require.resolve` 而非拼 `node_modules`——包管理器会 hoist）、`installBundledChromium()`。`browser-driver.js` 里那份重复实现**已删除并改为复用**（删掉 2,799 + 461 字符，行为不变：`browserSource` 仍为 `bundled`）。 |
| **0.18.0 「人人下载安装可用」的兑现路径** | 426.7 MB 的 Chromium **打不进 npm 包**（当前 tarball 543 KB，会变成 400 MB+），因此走「自带优先 + 缺时下载」。新增两个控制面入口：`GET browser-runtime`（报 `ready`/`source`/`executablePath`/`revision` + 一句可直接显示的话，**不启动浏览器**）、`POST browser-install`（调 `playwright-core/cli.js install chromium`）。**关键纪律**：① 安装前先查是否已有浏览器，有就直接返回，不重复下载 150 MB；② 模块级 promise 复用同一次进行中的安装（连点两次不该拉两份）；③ **退出码为 0 还不够**——必须复查磁盘上真的出现了可执行文件（「命令说成功但文件不在」是本仓库记过的那类假成功）；④ 只装 chromium，不装 ffmpeg/headless-shell/winldd（对登录+页面交互都不是必需）。 |
| **0.18.0 本轮测试读数** | 新增第 3 条护栏（`browser-source.test.mjs`）：「浏览器能力可查询、可安装」——断言 `resolveBrowserExecutable()` 形状、返回路径必须**真的存在**、控制面两个入口在、且安装前必须先查已有。`control-routes.test.mjs` **15/15**、`client-server-contract.test.mjs` **2/2**（新路由未破坏契约）。**全量 `node --test test/*.test.mjs` → 872/872 通过、exit 0**（399s）。 |
| **0.18.0 第三批（已完成）：设置页浏览器卡片 —— 让能力真的能点到** | 只加控制面路由不够：用户**点不到**就等于没做。设置页新增「浏览器（内置，无需外部依赖）」卡片：显示 `line` + **完整可执行文件路径**（「到底跑的是哪个文件」是可核对的）、「刷新状态」按钮、以及仅在缺浏览器时才出现的「下载浏览器」按钮。下载前先 `window.confirm` 征得同意（约 150 MB 的外部动作，与附件探针同一条纪律）；**失败时把真实原因显示出来**（含命令输出尾部），不编一句「安装失败」。 |
| **0.18.0 发布读数（本轮实跑）** | 打包 `dsh-webcode-bridge-0.18.0.tgz`（549,865 字节）；`verify-pack` **逐字相同 42/42**（比 0.17.3 多 1 个文件 = 新增 `lib/browser-runtime.js`）+ 接线完好 + tarball 与工作树一致；`install-profiles` 装入 web / headless 均 **v0.18.0**；回读四个关键文件（`browser-runtime.js` / `browser-driver.js` / `web-control.js` / `settings-page.js`）× 两 profile **全部 SAME**；两 profile 的 `package.json` 与 `pnpm-lock.yaml` 已同步到 0.18.0，integrity `sha512-MxelZIrP…` 与工作树 tarball 一致。**注意：需重启 DSH 才生效**（当前 3080 进程仍是 0.17.3）。 |
| **0.18.0 第四批：登录态持久化真机验证（目标 ① 的核心承诺）** | 探针实测（跑完已删，全程只读不发消息）：用自带 Chromium 打开 GLM → 读登录态 → **关闭驱动（浏览器进程退出）** → 重新创建驱动 → 再读一次。两段读数：`loggedIn=true` / `basis=probe-ok` **完全一致**，`RESULT: LOGIN-PERSISTS-ACROSS-RESTART`、exit 0。即「登录一次，之后跨重启一直有效」不是承诺而是**实测事实**。 |
| **0.18.0 第五批（已修，含反向验证）：登录入口误导 —— 登了不算数** | 用户指出「设置界面和右侧本插件带来的登录必须落实一处」。核实到**真问题**：桥跑在**自己独占的 Chromium profile** 里，而界面上有两个入口把人带到别处登录 —— ① 设置页「打开网站」按钮调 `window.open(url)`（开的是**用户日常浏览器**，如 Firefox）；② 面板站点工具条的 🌐 按钮调 `ctx.sidebarRight.openTab('browser')`（开的是**官方 iframe 浏览器** `ui-sidebar-browser`，另一个进程、另一份 cookie 罐）。**在这两处登录，桥永远不会知道** —— 这正是长期「探针说未登录、用户说我登了」而两边都是真的根因。修法：删掉设置页「打开网站」按钮与其死代码（`SITE_NAMES_MAP` / `SITE_ORIGINS_MAP`），🌐 按钮改为打开**桥自己的登录窗口**（`toggleWindow`），并把按钮标题/提示文案里的「Edge 窗口」改为准确措辞（现在跑的是自带 Chromium，不再依赖 Edge）。护栏 `settings-transport.test.mjs` ⑦「登录入口不得指向桥以外的浏览器」——**反向验证**：把按钮加回去 → fail 2；还原 → 7/7 pass。 |
| **0.18.0 五站登录态真机矩阵（目标 ② 的前提读数）** | 探针实测（跑完已删；守风控纪律：≥22s 间隔、单站 1 次、只读不发消息）。**读数 3/5 已登录**：<br>`glm` **true** / `probe-ok`（强证据）<br>`kimi` **true** / `probe-fallback`（弱结论：特征未命中、回退输入框判定）<br>`qwen` **false** / `probe-bad`<br>`doubao` **false** / `probe-bad`<br>`zai` **true** / `probe-ok`（强证据）<br>五站 `browserSource` 全为 **`bundled`**（自带 Chromium 真的在驱动全部站点）。**结论**：GLM 与 Z.ai 可直接进入 ② 的真机可用验证；Kimi 需先定性弱结论；**qwen / doubao 需要你在桥的窗口里登录**（点该站点的「登录窗口」），否则 ② 对这两站无从谈起。 |
| **0.18.0 本轮测试读数** | 全量 `node --test test/*.test.mjs` → **873/873 通过、exit 0**（399s，比上轮 +1 = 新增 ⑦ 号护栏）；`settings-transport` 7/7；台账闸门 **PASS**（0.18.0 / 74）。 |
| **0.18.0 发布读数（本批重打包）** | `dsh-webcode-bridge-0.18.0.tgz`（550,355 字节）；`verify-pack` **42/42 逐字相同**；`install-profiles` 两 profile 均 v0.18.0；`settings-page.js` / `client.cjs` / `browser-runtime.js` × 两 profile **全部 SAME**；两 profile 的 `pnpm-lock.yaml` integrity 已同步为 `sha512-wHA2V0S6…`、version 0.18.0。**需重启 DSH 才生效**。 |
| **0.18.0 第六批（真机读数）：五站真实一轮验证 —— GLM 通过、Z.ai 触发风控** | 探针真实发送（守风控：站间 ≥25s、极短 prompt、不重试）：<br>**GLM：通过** —— 13,719 ms 拿到真实回复「收到」，会话 id `6ab20c75bee383f60b72cbb9`、`endReason=finished`、`RESULT: REAL-REPLY-OK`。**这是「五站真实可用」的第一个硬证据。**<br>**Z.ai：失败** —— 180s 超时，现场 `{captureAlive:true, replyChars:0}`（与 `long-term-issues.md` §14 记的形态逐字一致）。<br>**根因（本批新查清，带证据）**：带 `WEBCODE_SSE_DEBUG` 抓包**零文件** ⇒ 捕获链一个 chunk 都没收到；再用 `page.on('request'/'response')` 观察真实网络，得到确凿结论 —— `POST /api/v1/chats/new` **成功**（会话建了），但**没有任何** `POST /api/chat/completions`，同时出现一批**阿里云验证码**请求：`no8xfe.captcha-open.aliyuncs.com`、`no8xfe-verify.captcha-open.aliyuncs.com`、`upload.captcha-open.aliyuncs.com`、`cloudauth-device-dualstack.cn-shanghai.aliyuncs.com`。**即：Z.ai 是风控拦截，不是解码器缺陷、不是选择器漂移。** |
| **0.18.0 由上一条暴露的桥自身缺陷：风控识别漏了阿里云 captcha** | `detectChallenge`（`browser-driver.js:675`）的指纹里有 `aliyun_waf`，但**没有** `captcha-open` / `cloudauth-device` 这一类 —— 于是 Z.ai 命中验证码时桥判不出「这是风控」，只报「捕获链在，页面无回复文本」。**后果**：用户与排查者会被引向「解码器对不上」的错误方向（`long-term-issues.md` §14 的「zai 是独立问题，属于网页 UI 漂移」这个判断，本批被推翻）。**这正是「报错必须指向真因」那条纪律的落点。** |
| 0.17.2 范围（修 0.17.0 等待占比 100% 假读数 + 更正 0.17.1 归因） | 审查 0.17.x 时在**真机**上复现的缺陷：`POST /__webcode/wait-stats` 的「平均会话等待时长占比」读出 **99–100%**，即“这台机器上的时间几乎全花在节流等待上”。根因不是公式，是**分母的覆盖范围与分子不一致**——`totalDurationMs` 是 0.17.0 才引入的字段，而账本**落盘且跨版本延续**（`webcode-wait-stats.json`），升级那一刻磁盘上 8600+ 轮的历史耗时全是 0，分母只覆盖最近几轮。修法：① 账本新增 `durationTurns`（只有 `durationMs > 0` 的轮次才 +1），作为**覆盖率判据**；② `sanitizeWaitStats` 对旧账本**不向后推断**（绝不能因 `totalDurationMs > 0` 就认定“这些轮次都有耗时”——那正是 100% 的来源）；③ 新增 `waitRatio` 作为占比的**唯一计算入口**，三种读数：全覆盖 `61%` / 零覆盖 `未记录` / 部分覆盖 `61%（覆盖 40/57 轮）`；④ 药丸是 13px 单行，只在**纯百分比**时附占比，`未记录` 与覆盖率尾巴一律交给点开的面板。同一轮内**更正 0.17.1 的台账归因**（见下行）。 |
| 0.17.2 落地文件 | `lib/wait-stats.js`（`emptyWaitStats`/`accumulateWait`/`sanitizeWaitStats` 三处新增 `durationTurns`、新增 `waitRatio`、六个调用点改走它）、`test/wait-stats.test.mjs`（新增 5 条护栏钉住覆盖率判据）、`test/control-routes.test.mjs` 与 `test/client-render.test.mjs` 的账本夹具补 `durationTurns`、`doc/review-0.17.x.md`（审查报告）。 |
| 0.17.2 测试与闸门（本轮实跑） | `wait-stats.test.mjs` **39/39**（原 34 + 新 5）、`control-routes.test.mjs` **12/12**、`client-render.test.mjs` **48/48**；全量 `node --test test/*.test.mjs` **866/866 通过、exit 0**。**真机验证**：拿真实落盘账本（`totalWaitMs=115033353` / `totalDurationMs=1056232` / `turns=8676`）跑修复后的 `waitRatio` → `未记录`（修复前同一份数据算出 **99%**）。 |
| 0.17.1 归因**更正**（2026-09-22） | 原文写着「真机 session-2411bccd 实锤 `<arg_value>`」。审查时把该会话日志（`session.v3.jsonl.zstd`）解出来逐串统计：**`arg_value = 0`、`arg_key = 0`**，而 `AUTO_CONTINUED = 15`。即自动续跑确实发生了，但**那条会话里根本没有 `arg_value` 形状**，归因缺证据。修复本身是对的（GLM 开源模板确产 `<arg_key>/<arg_value>`，我独立喂四种形状全部解析正确），但性质是**预防性加固**，不是「真机缺陷修复」。历史叙述保留不改写，更正记于此。 |
| 0.17.1 范围（GLM 原生 arg_value 解析 + read 路径纠偏 + 0.18.0 内安全发布） | 诊断 session-2411bccd 真机会话中 GLM 连出五次 `AUTO_CONTINUED` 最终丢失上下文重置为打招呼的根因并修复：① **GLM 原生 `<arg_value>` 格式解析**：GLM-4/5 在网页端原生吐出 `<tool_call>tool_name\narg1\nval1</arg_value>\narg2\nval2</arg_value></tool_call>` 语法，旧解析器只支持 JSON 体导致每轮判 UNPARSED 触发自动续跑；在 `parseAgentReply` 中新增对 `<arg_value>` 标签体的原生提取，无需续跑即可直接派发工具调用，将往返轮次减半并消除刷屏。② **read 工具参数别名纠偏**：GLM 频繁将 `file_path` 误写为 `path`，在 `coerceArguments` 中对声明了 `file_path` 的工具自动将 `path` 别名映射为 `file_path`，防止 DSH 直接拒执抛错。③ 版本号严格控制在 0.18.0 以内（定为 0.17.1）。**注：归因见上一行的更正。** |
| 0.17.1 落地文件 | `lib/agent-preset.js`（`parseAgentReply` 增加 `<arg_value>` 提取、`coerceArguments` 增加 `path`→`file_path` 别名纠偏）、`test/glm-session-replay.test.mjs`（新增 2 条回归断言：GLM 原生 `<arg_value>` 形状解析 + read 参数别名纠偏）。 |
| 0.17.1 测试与闸门 | `glm-session-replay.test.mjs` 22/22 PASS、`parse.test.mjs` 22/22 PASS、`check-ledger.mjs` PASS（0.17.1 / 73 个单测文件）。 |
| 0.17.0 范围（网站选择居中 + 等待发送确认与时长占比 + 打包发布） | 用户三项要求：① **网站选择界面样式居中**：在右栏点击 Web Bridge 标签进入站点目录后，`.hwb-catalog` 样式完全参考官方 `GuideBody`（`min-height: 100%` + `justify-content: center` + `align-items: center` + `:after` 10% 弹性留白），解决之前顶部贴着的问题。② **等待发送消息口径确认**：明确记录“等待发送消息”统计的是执行工具后、发送给模型之前，由于配置的发送间隔（send gap）及限流退避（rate limit backoff）所产生的主动等待时间，纯属插件策略引入的延迟，不含模型思考、生成或本地工具执行耗时。③ **药丸与面板显示等待时长占比**：底部药丸格式改为「n秒 · 等待占比x%」（参考官方药丸中间间隔点 ` · `），占比以本次会话等待总量（含在途）除以会话总活跃耗时（等待总量 + 模型耗时 `totalDurationMs`）计算并在在途中平滑单调增长；展开面板与设置界面分别新增「本次会话占比」与「平均会话等待时长占比」展示。全量测试通过，打包发布为 0.17.0。 |
| 0.17.0 落地文件 | `lib/wait-stats.js`（`emptyWaitStats`/`sanitizeWaitStats` 扩展 `totalDurationMs`、`waitOfTurn`/`accumulateWait` 累加 `durationMs`、新增 `formatPercent`、`composerWaitPillLabel` 改为 `n秒 · 等待占比x%`、`waitStatDetailRows`/`waitStatBlocks`/`waitStatRows` 增加「本次会话占比」与「平均会话等待时长占比」）、`lib/web-control.js`（`detailRows` 透传 `live, now` 保持与药丸同源）、`lib/client.cjs`（`.hwb-catalog` 对齐官方 `GuideBody` 垂直居中与 10% 留白）、`test/wait-stats.test.mjs`、`test/control-routes.test.mjs`、`test/client-render.test.mjs`。 |
| 0.17.0 测试与闸门 | `wait-stats.test.mjs` 34/34 PASS、`control-routes.test.mjs` 12/12 PASS、`client-render.test.mjs` 48/48 PASS、`parse.test.mjs` 22/22 PASS、`run-m1.js` PASS（73 个单测文件基线）。 |
| 0.16.40 范围（Kimi Connect-RPC + GLM 残留 + 切帧三缺陷） | 2026-09-21 网页会话所做、**尚未进任何 tarball** 的两项真机协议适配：① **Kimi 迁 Connect-RPC**——真机 CDP 确证 kimi 网页已从旧 SSE 全面迁到 `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`（`application/connect+json`，响应是二进制帧 `[flags(1)][len(4BE)][json]`）。`providers.js` 的 KIMI 补新端点进 `completionPaths` + `streamTransport:'connect'`；`browser-driver.js` 的 `captureInit(paths,{transport})` 在 fetch tee 路径上加 connect 字节切帧器，逐帧 JSON 以一行 emit 给行式解码器；`decoder.js` 新增 `KimiConnectDecoder`（注册名 `kimi-connect`：会话 id 取 `chat.id`、正文取 `block.text.content`、思考取 `block.think.content`、`done` 判收尾）。② **GLM 工具轮后正文残留/加倍**——真机抓帧（`execute_sandbox_code` 工具轮）证实 GLM 的 text 帧既非纯增量也非纯累积，而是「增量碎片 → 工具轮 → 完整段落快照（连续两帧原样重发）」混合；旧 `GlmDecoder` 把两帧都判 NEW → 同一段播两遍。现在遇工具帧（`tool_calls`/`tool_result`）清零段落累积、快照等于累积则丢弃、快照以累积为前缀且更长则只补发剩余。 |
| 0.16.40 落地文件 | `lib/providers.js`（KIMI 端点 + `streamTransport`）、`lib/browser-driver.js`（`captureInit` connect 切帧 + `judgeLoggedIn` 对声明了 bad 特征的站点做 2s 有界 SPA 水合重探）、`lib/decoder.js`（`GlmDecoder` 段累积去重 + `KimiConnectDecoder`）、新增 `lib/tool-transport.js` 与 `lib/tool-parser.js`（计划 Task 1 的「站点 → 传输形状」薄路由，**目前只被单测引用、尚未接线到调用点**）、`test/multi-site-decoder.test.mjs`（+3 条 kimi-connect）、新增 `test/glm-tool-snapshot-dedup.test.mjs`、新增 `test/tool-transport.test.mjs`（10 条）、`test-mock/` 新增 13 个真机/解析探针脚本（`login-probe` / `real-probe-26-glm-frames` / `real-probe-28,29-kimi-*` 等）。 |
| 0.16.40 本轮新修三缺陷（`test/capture-connect.test.mjs` 的真实执行用例抓到） | 该文件当天写出、当天红，抓到的**不是**测试写法问题，是注入脚本的真缺陷：① **中文被解成 mojibake**——切帧器用逐字节 `String.fromCharCode` 拼 JSON，而 `JSON.parse` 对 mojibake 是**合法**的，于是 `你好` 一路静默变成乱码串（不抛错、不留痕）；改用 `TextDecoder('utf-8')`。② **假长度头卡死**——长度头落在合法区间（真机噪音里见过 33MB 这种值）时，只看长度会让切帧器死等一个永远凑不齐的帧，**后面所有真帧全被扣住**；补「载荷首字节必须是 `{`」做重同步。③ 顺带自查：在模板串的注释里写反引号把整个文件截断（`node --check` 抓到），已把这条教训写进那段注释。 |
| 0.16.40 测试与闸门（本轮实跑） | 全量单测 `node --test test/*.test.mjs` **860/860 通过、exit 0**（73 个测试文件，399s）；新增 `capture-connect` 7/7、`tool-transport` 10/10；`lint-comments` 144 文件 error 0 / warn 0；`repo-hygiene` PASS；`ref-index` PASS（45 条目）；`check-ledger` PASS（0.16.40 / 73）。**未跑**：`ci-local` 整条（本机 `spawnSync` 全被挡，见 §0.16.34 五），八步均以逐条命令等价复核。 |
| 0.16.40 发布闸门与装机（本轮实跑） | `pnpm pack` → `dsh-webcode-bridge-0.16.40.tgz`；`scripts/verify-pack.mjs` **逐字相同 41/41 + 接线完好**（比 0.16.39 多的 2 个文件即新增模块与护栏）；`install-profiles.mjs` 装入 web / headless（均 v0.16.40）；**另手工把两个 profile 的 `package.json` 与 `pnpm-lock.yaml` 声明改到 0.16.40 + 写入真实 integrity**——`install-profiles` 绕开 pnpm，不改声明的话任何一次 pnpm 通道都会静默回退（§0.16.10 七）。回读：两 profile 的 `lib/browser-driver.js` sha256 前 12 位均 **4A3066286D3C**，与工作树逐字相同。 |
| 0.16.40 未完成项（如实记） | **需重启 DSH 才生效**——重启前 3080 上跑的仍是 0.16.39。重启后要真机验两件事：① Kimi 用新 Connect-RPC 通路能否真跑通一轮工具闭环（此前只有切帧层与解码器层的离线证据）；② GLM 工具轮之后正文不再加倍。未真机跑通不宣布这两项完成。 |
| 0.16.39 范围 | 用户五项 UI 对齐 + 打包安装（事实基础均为本轮实测读官方产物）：① 站点选择框宽度对齐官方 `guide` 胶囊（`width:380px;max-width:100%`，首屏整块靠 `.hwb-firstrun` 居中，恒 380px、窄于 380 收缩并留左右 12–20px）；② 等待时长显示改中文单位（`wait-stats.js` 的 `formatDuration`/`formatElapsed`：`42 秒` / `3 分 05 秒` / `1 小时 02 分 09 秒`），药丸面板改**左边缘对齐 + 视口夹紧 + 随 token 字号缩放**（`useAnchoredPosition({side:'top',gap:8,margin:12})` + `createPortal(document.body)`，`position:fixed`；createPortal / hook 缺位回落内联面板，降级不崩溃）；③ 选站点**替代本标签页**（`CatalogBody` 经 `useTabInfo()` 取 `tab.actions.openTab(kind,{replaceTab:true,params})`，与官方「新建终端」同路径；取不到 hook 回落 `ctx.sidebarRight.openTab` 新开）；④ 网页标签工具条四颗动作按钮换官方 primitives 图标（IconRefreshOutline14 / IconRightUpOutline16 / IconFullscreenOutline16 / IconPanelLeftOutline16），`.hwb-act-btn` 28×28 圆角 14。工具条走官方 height 38px。hover 才上底色，`.on` 用 color + aria-pressed）；⑤ 设置页「速度与等待」加只读累计统计块（label 左 / 数值右，tabular-nums，12px 圆角 dl 网格，数据来自服务端 `statBlocks`——与药丸同一份 `waitStatBlocks` 现算，前端不再各算一套）。**未触碰**协议解析、账号底层连接、右栏镜像与窗口逻辑。 |
| 0.16.39 落地 | `lib/client.cjs` `.hwb-picker-surface.bare` 改 `width:380px;max-width:100%;margin:0 auto`、`.hwb-catalog-list` 同步 380px 居中；`WaitLine` 接 `useAnchoredPosition` + `createPortal(document.body)` + `position:fixed` 面板（z-index 1100、border-radius 12px、padding 16px、`--dsw-specific-menu`/`--dsw-elevation-prominent`、min/max-width 视口夹紧、dt/dd 网格），字号全走 token；`openSiteTab` 走 `useTabInfo()`→`tab.actions.openTab(replaceTab:true)`；工具条四钮换官方 primitives 图标 + `.hwb-act-btn` 官方口径；`web-control.js` 输出 `statBlocks`（`waitStatBlocks({session,total,metrics})` 服务端现算）+ `client.cjs` 的设置页 `WaitTotals` 渲染（两处字段命名与口径已在客户端注释写明对应，前后端同源）；`wait-stats.js` 全中文单位、秒级不补小数、`formatElapsed` 与 `formatDuration` 合流。 |
| 0.16.39 测试 | 全量 **836/836 通过**（`node --test test/*.test.mjs`，exit 0）；`wait-stats` 33/33；`client-render` 48/48（改写 2 条等待药丸短读数断言 `3 s`→`3 秒` / `12 s`→`12 秒`，更新 `liveWaitPayload` 缺省夹具为中文单位口径）；`control-routes` 断言同步 `15 s`→`15 秒` / `12 s`→`12 秒` / liveValue `3 s`→`3 秒`。 |
| 0.16.39 装机 | **已完成**：`pnpm pack` → `dsh-webcode-bridge-0.16.39.tgz`；`verify-pack` **39/39 逐字相同 + 接线完好**；`install-profiles.mjs` 装入 web / headless 两 profile（均 v0.16.39）；三处 `lib/client.cjs` sha256 前 12 位 **F1DAEBA4AB3E**（286,290 字节）逐字相同。 |
| 0.16.39 未完成项（如实记） | **需重启 DSH 才生效**（本项目反复踩过的一条：当前进程仍是旧代码）。重启后按 `doc/verify.md` 的 0.16.39 段逐条真机核对：① 目录站点行 380px 居中；② 药丸面板左对齐且不被裁、字号缩放跟随；③ 选站点后 Web Bridge 标签被替代；④ 工具条图标与官方一致；⑤ 设置页统计块数值与药丸一致。未通过不宣布完成，按 diagnose 流程定位。 |
| 0.16.39 风险与边界 | `replaceTab` 走 `tab.actions` 依赖标签 hook；hook 缺位回落新开标签（可解释，不白屏）。portal 后测试桩若未提供 `createPortal`，按回退分支断言「内联渲染」而不是崩溃（本文件既有纪律）。面板改 `position:fixed` 后滚动/resize 由官方 hook 重算，窄面板下不再因 `right:0` 溢出。 |
| 0.16.38 范围 | 用户七点（原话见 §0.16.38）：① 右栏站点选择框适配 tab 长短、与左右边界留间隔、居中；② 输入框底下「等待发送」药丸要在缩小后跟着适配（对齐官方）；③ 设置界面按作用域拆开——全局页删「账户与登录管理 / 首轮提示词」，站点页删「正在运行 / 模型管理 / 提示词投递 / 会话与子代理」，两者各管各的；站点页提示词改为**指向本地提示词文件并可打开**，且「每个网站只能改自己的」；tab 条改**横排单行 + 滚轮滚动 + 无滚动条**；文案学术精简（完整解释移入 `doc/settings-copy.md`）；DeepSeek 图标不再超出框；④ 全站「Z.ai (GLM 海外版)」改为「Z.ai」；⑤ 参考官方审美规范设置页 UI；⑥ 做官方契约审计并落文档（`doc/official-contract-audit.md`）；⑦ 安装并配置 modsearch。**未触碰**协议解析、账号底层连接、右栏镜像与窗口逻辑。 |
| 0.16.38 落地 | `lib/providers.js` + `lib/client.cjs` 的 `Z.ai` 改名；`SiteGlyph` 鲸鱼分支补 `scale`（越界根因）；设置页卡片按作用域分组（`settingsTab` 判据），新增「本网站默认模型 / 本网站指令 / 提示词文件」三行；新增后端字段 `defaultModelBySite` 与 `extraPromptBySite`（归一化：未知站点丢弃、跨站点模型丢弃、空指令删键）；`POST prompt-file`（路径只由 siteId 派生，argv 打开系统默认程序）；`buildTurn` 的站点内模型覆盖 + 站点指令注入（进契约指纹与内容指纹两处）；等待药丸逐项等于官方 `StatsPills`（字号/行高挂在 wrap，pill 不再声明 height），wrap 改 `flex:0 1 auto` 可收缩；tab 条横排单行 + 非 passive 滚轮 + 隐藏滚动条；首屏网格/目录加左右内边距与居中；modsearch 全局安装并实测可用。 |
| 0.16.38 修复的隐性缺陷 | ① `PromptSection` 与「全局指令」卡同时渲染 `GlobalPrompt` → 同一设置两个输入框（本轮自查时发现，已拆开并加护栏）；② 测试桩 `useState` 不执行函数式初值，导致 `settingsTab` 变函数对象、全局页被当站点页渲染（改用普通初值，并在注释里写明约束）；③ 站点页账户卡只列 `onlySiteId`，原先「三态头像」用例把不同站点混在一起、在作用域拆分后必然失败（夹具改为同站点三槽，更贴近真机）。 |
| 0.16.38 测试 | 全量 **70/70 文件通过**（`ci-local` 的 `test` 步 exit 0，396s）；`client-render` 47/47（新增 1 条作用域用例）；`control-routes` 11/11（新增 3 条：站点级字典归一化 / GET 回空对象 / prompt-file 路径只由 siteId 派生）；`prompt-variants` 新增 1 条（站点指令只注入自己那一支）；`session-anchor` 扩 1 条（站点指令进契约指纹）；`regression` 新增 1 条（站点级模型覆盖 + 站点指令只进本站点首轮） |
| 0.16.38 其他闸门 | 注释闸门 PASS；文件规范闸门 PASS；生成物卫生 PASS；基准离线回放 PASS；`check-ledger` 与 `ref-index` 的两处**既有**漂移已按闸门自身提示修正（台账版本号 0.16.37→0.16.38；`reference/README.md` 补 `dsh-drop-caret` / `dsh-market` 两行——它们入库时漏了重生成索引） |
| 0.16.38 装机 | **已完成**：`npm pack` → 0.16.38 tarball → `install-profiles.mjs` 装入 web / headless 两 profile（均 v0.16.38）；三处 `lib/client.cjs` sha256 前 12 位 **C9BBBE8B87C1**（270,430 字节）逐字相同。 |
| 0.16.38 闸门 | `ci-local` **8/8 PASS**：lint-comments / check-ledger（0.16.38 + 70/70）/ repo-hygiene / commit-msg / ref-index / artifacts-check / bench-offline / 全量单测（396s，exit 0）。 |
| 0.16.38 未完成项（如实记） | **运行中的 3080 仍是 0.16.37**（实测 `build.version = 0.16.37`），需重启 DSH 才加载 0.16.38，因此「设置页新布局 / 药丸缩放 / 站点 tab 横排」等 10 项界面验收**尚未真机核对**。逐项清单见 `doc/verify.md` 的 0.16.38 段。 |
| 0.16.38 用户原话要点 | 「设置界面……两者逻辑上单独适配全局和单独站点！你却全都有放置，请你按照我的要求删除对应 UI」「首轮提示词，每个单独模型都只能改自己的！以及请你将全部都变为指向对应网站本地提示词文本的存储文件且可以点击链接打开文件」「将这个变为横排而不是两行，然后可以通过鼠标滚轮滚动而不用显示进度条」「请你参考官方审美和借鉴苹果人类为本？理念」「做 renderer-v2 契约检查」（该名称在本机三处检索 0 命中，已按官方 client 插件契约执行，见 `doc/official-contract-audit.md` §0） |
| 0.16.37 范围 | 用户：「① z.ai 和 glm 看搜索 zcode 看看有没有图标；② 让你**完全参考**「新建终端」做，你现在只是在半路……将 deepseek 等网站做出和他一样的**胶囊和排版**放在 web bridge 点击进去后」。落地：站点目录从「左栏 `panelRow` 数值」改成官方 **`TerminalGuide`（右栏「新建终端」）同款胶囊**——官方 `Button variant:'ghost'` 主区 + 44px 官方 `Button` 触发器 + 官方 `Menu` 账户下拉，尺寸逐项抄它的 module.css；GLM / Z.ai 拿到真实矢量（simple-icons 实测八个 slug 全 404，改取 lobehub）。 |
| 0.16.37 测试 | `client-render` **46/46 通过**（新增 1 条：胶囊几何 + 官方原语 + 左栏旧口径不得复活；改写 2 条：SiteMenu 那条从「Menu 解构不得残留」改成「必须存在」、GLM 图标断言从「文字标记原因」改成「lobehub 来源 + 矢量真被渲染」）。**另修一处测试桩失真**（详见 §0.16.37 三） |
| 0.16.37 已装 | 见下行「已装版本」 |
| 0.16.36 范围（历史） | 删面板内横向站点条 + 目录改左栏 `panelRow` 排版 + 八个站点取回 simple-icons 矢量 —— **③ 的排版已被 0.16.37 推翻**（用户：「只是在半路」），① ② 保留 |
| 0.16.36 范围（原始记录） | 用户四点（原话见 §0.16.36）：① 去掉「DeepSeek 为官方矢量；其余站点品牌方未发布…」那行脚注，把官方图**上网找来**；② 面板内**顶部那一行横向站点胶囊再删**，只留「官方多开一级 + Web Bridge 并列」那行（即 DSH 官方右侧栏自己的标签条）；③ 站点目录按**官方左栏行**排版（文件夹 / 新建终端 / 浏览器 那一套，`panelRow` 尺寸）；④ 每行**右侧**做账户展开（多账户站点）。**未触碰**任何解析 DeepSeek 协议的逻辑与账号底层连接。 |
| 0.16.36 测试 | `client-render` **45/45 通过**（新增 1 条：面板内不得再有自建站点条；改写 1 条：目录行必须带官方 `panelRow` 尺寸口径 + 多账户站点必须有右侧展开按钮） |
| 0.16.35 范围（历史） | 站点目录（一级）+ 每站点一个标签 + 横向站点条恢复 —— **横向条已被 0.16.36 删除**；目录与每站点标签保留 |
| 0.16.35 范围（原始记录） | ① **恢复**横向站点标签条（0.16.34 删错了：用户要的「一行并列显示不同网址栏目」就是它），并按用户要求**去掉登录态**；② 工具条上的站点下拉按钮**删除**（「你现在的 deepseek 上面那点击排列多个网点就不要了」），`SiteMenu` 组件与 `Menu` 解构随之删干净；③ 新增**站点目录**：右栏「Web Bridge」标签页里从上往下的站点列表（图标 + 名称，多账户站点缩进列出子行，**不显示登录态**），点一行 = 为该站点**新开一个独立标签**（`multiple: true`，标题按 `navigation.params.siteId` 现算）——于是顶部标签条上就是「DeepSeek / 智谱清言 / …」一行并列，点回「Web Bridge」即回目录。**未触碰**任何解析 DeepSeek 协议的逻辑与账号底层连接。 |
| 0.16.35 测试 | `client-render` **45/45 通过**（含 `slot` 接通后复跑）（新增 3 条：站点目录从上往下且无登录态、点一行会 `openTab` 并带 siteId、站点标签从自己的 `navigation.params` 取身份；掉头改写 1 条：横向标签条**在位**且不含状态点；删 1 条：`SiteMenu` 已删不得复活）。护栏升级：`sidebarRight.openTab` 桩改为**记录调用**（此前「点站点会发生什么」完全没有证据） |
| 0.16.35 已装 | 见下行「已装版本」 |
| 0.16.34 范围（历史） | 删除横向站点标签条 + 站点选择收敛为工具条竖排菜单 —— **① 已被 0.16.35 推翻**（标签条恢复），② 的菜单已被删除 |
| 0.16.33 范围（历史） | 右栏 Web Bridge 二级站点菜单（官方 `Menu` 原语的 `submenu`）+ 账户行状态点；设置页**站点 tab 条**（形态对齐 dsh-market）+ 站点级排队间隔（`sendGapMsBySlot`，后端既有档位）；账户头像改用站点矢量标记 `SiteGlyph` |
| 参考入库 | `reference/dsh-market/`（dshmarket 的 `src/` + `client/`，用户要求「放入插件参考文件夹」） |
| 工作树版本（上一版） | **0.16.33**（待提交） |
| 0.16.33 范围（历史） | 右栏 Web Bridge 二级站点菜单（官方 `Menu` 原语的 `submenu`）+ 账户行状态点；设置页**站点 tab 条**（形态对齐 dsh-market）+ 站点级排队间隔（`sendGapMsBySlot`，后端既有档位）；账户头像改用站点矢量标记 `SiteGlyph` |
| 已装版本（profile） | web = **0.16.40**、headless = **0.16.40**（2026-09-21 实读两个 profile 的 `node_modules/dsh-webcode-bridge/package.json`；两 profile 的 `lib/browser-driver.js` sha256 前 12 位均 **4A3066286D3C**，与工作树逐字相同；`package.json` + `pnpm-lock.yaml` 的声明与 integrity 已一并改到 0.16.40，**不是**只写 `node_modules` 的易回退装法） |
| 运行中的进程 | 3080 实测 `/__webcode/status` 的 `build` = `{hash:'f7e3cc76d4e8', version:'0.16.39'}`（2026-09-21 17:16 实读）⇒ 磁盘已是 **0.16.40**，**进程仍跑 0.16.39，待重启** |
| 上游 | `origin/main` = `fb7cd6e`（0.16.31 文档收口）；本轮 0.16.32–0.16.40 待提交/待推（0.16.38 / 0.16.39 / 0.16.40 **均已打包装机**） |
| 单测基线 | **85/85 测试文件全绿**（2026-09-24 逐文件实跑；85 个里 `reply-log` 需 `NODE_TEST_CONTEXT=1`，未设时该文件按设计判红一次，设后 4/4 通过）。本轮（0.19.8）新增 1 个护栏文件 `send-confirmed`，故从 84/84 升到 85/85；全量 `node --test test/*.test.mjs` 本轮实跑 **968/968 通过、exit 0**。本行上一次写的是 **84/84**（2026-09-24）。台账曾写 83/83（0.19.3 读数）、81/81、80/80、75/75（当时 886 条断言）、74/74、72/72、70/70——数值随新护栏文件过期，`check-ledger` 每次都把它判红（这正是该闸门存在的意义）。<br>**复核方式必须写清（本轮踩过一次）**：全量必须**串行独占**——本轮曾让两个作业并发跑测试，结果 `empty-response` 挂住 53 分钟、`regression` 从 8 分钟涨到 19 分钟；单独复跑 `empty-response` **69.8s / 5/5 通过**。并发下的红/慢**不算读数**（本文件 0.19.0 行已记过同型判据）。 |
| 注释闸门 | **PASS**（0.16.34 实跑：126 文件 error 0 / warn 0） |
| 文件规范闸门 | **PASS**（0.16.34 实跑：无 BOM + 索引无死链 + Node 版本相容） |
| 发布闸门 | **PASS**（2026-09-21 实跑 0.16.40：`verify-pack` 逐字相同 **41/41** + 接线完好）。**注意顺序**：README 版本行改完后**重新 pack 了一次**并重跑了 verify-pack（否则「tarball == 工作树」当场失真），两个 profile 的 lock integrity 也随新 tarball 重写。此后再改任何入库文件，都要重跑 `pnpm pack` + `verify-pack` + `install-profiles` + 声明/integrity 同步这四步 |
| 记账闸门 | **PASS**（2026-09-21 实跑：version 0.16.40 / testFiles 73/73） |
| 已装包核对 | 见下行「已装版本」 |
| 真机验证（0.16.31） | 附件探针实测 `ok:true`（见 §0.16.31 一）；**「模型是否读到附件内容」尚未验证**，如实记 |
| 下一阶段 | ① **重启 DSH** 加载 0.16.40（磁盘已就位，进程仍是 0.16.39）；② 重启后真机验两件事：Kimi 新 Connect-RPC 通路能否真跑通一轮工具闭环、GLM 工具轮后正文不再加倍；③ 0.16.39 的界面五项也可一并看（380px 居中 / 药丸面板左对齐不被裁 / 选站点替代本标签 / 工具条图标 / 设置页统计块）；④ **发布闸门与装机已完成**（`verify-pack` 41/41、两 profile v0.16.40、声明与 integrity 已同步），因此重启即可生效，不再有打包欠账；③ 真机门禁见 `doc/research/2026-09-21-login-probe-matrix.md` 末节。**2026-09-21 用户反馈后当场定性**：用户说「除 qwen 外我都登录了」；定向取证（`test-mock/doubao-login-detail.mjs`）显示**桥自己的 profile 里 doubao 就是游客页**（可见「登录」按钮、头像 0、与公开未登录页逐字同构）——探针没假阳性，用户登的是**他自己的 Edge**，而桥用独立 profile 目录，两者互不相通。要修只能走设置页该站点的「登录」按钮。qwen 经用户确认未登录，探针正确。其中**五站「已登录」态 loginProbe 已在本机真机跑完第一轮**（2026-09-21，逐站 20s 间隔）：glm 强证据 `probe-ok`；kimi / zai 是**弱结论**（`probe-fallback`，等于「有输入框」的语义歧义）；qwen / doubao 判 `probe-bad` 与「已登录」矛盾，**待人工目视定性**（真失效 or 特征假阳性）。cookie 名扫描五站零命中，如实记作「本机无法用这条通路复核」而非「未登录」。仍待办：GLM 工具轮 SSE 帧重新落盘、独立登录窗 ⇄ 右栏窗 accountKey 复核；④ 遗留：`parseAgentReply().text` 的语义缺口（§0.16.32 三，已挂账不修）、`tool-transport.js` / `tool-parser.js` **尚未接线**到任何调用点（目前只被单测引用，接线与否需你决定） |

> **§0.16.10 真机判据（重启后逐条核）**：① `GET /__webcode/status` 的 `build.version` = **0.16.10**；
> ② 让模型回复一段含 `<b>`、`<foo>`、`Array<T>` 或字面 `<tool_call>` 示例的正文，**逐字对比** harness
> 收到的块内容与网页端原文——0.16.9 及以前会静默少掉那个 `<`。

> **⚠ 台账更正（2026-09-19）**：本表此前一行写着「已装版本（profile）**0.16.7**（web + headless
> 两个 profile 的 `package.json` 实测均为 0.16.7）」与「运行中的进程 **0.16.7**」。**这两条对 `web`
> 是错的**：审计实测 web profile 当时是 **0.16.5**（`lib/index.js` sha256 `14A87102DAFB…`），
> 只有 headless 是 0.16.7（`C9D096EBF8AB…`）。台账把两个 profile 混成了一句，于是「已装 0.16.7」
> 掩盖了「web 落后两个版本」这个真因，直接导致用户按台账以为装好了、重启后仍然不变。
> **教训记在这里而不是删掉**：凡是「已装/已重启/已验证」这类状态行，**必须逐 profile 写、并附
> sha256 前 12 位**，否则它会把「一个 profile 装了」读成「都装了」。 |

> **本轮实证（2026-09-21）**：0.16.40 那批改动**从未打包装机**，而 0.16.38 / 0.16.39 是打过包
> 并装进两个 profile 的 —— 这两件事此前混在同一句「本轮 0.16.32–0.16.37 待提交/待推」里，
> 读起来像是都装过。现按本表纪律拆开写：**「已打包/已装机」只认到 0.16.39，0.16.40 只有工作树**。
> 判断依据是逐 profile 的 `package.json` 版本 + `pnpm-lock.yaml` 的 tarball 指向 +
> `lib/client.cjs` 的 sha256 三项实读，不是按提交信息推的。 |

## 0.16.37（2026-09-21，**未提交**）—— 站点目录改成官方「新建终端」同款胶囊；GLM / Z.ai 拿到真实矢量

用户两点（逐字）：「1.z.ai 和 glm 看搜索 zcode 看看有没有图标，然后是让你完全参考「新建终端」做，
你现在只是在半路，继续将 deepseek 等网站做出和他一样的胶囊和排版放在 web bridg 点击进去后，
和 web 自身在的那里排版一样！」

### 一、图标：GLM / Z.ai 也拿到了真实矢量（第 1 点）

**先把结论与上一轮的关系说清楚，因为 0.16.36 的记载容易被读成「查过了，没有」：**

- simple-icons 里**确实没有**。本轮逐条实测 `zhipu` / `chatglm` / `zai` / `z-ai` / `zhipuai` /
  `bigmodel` / `zcode` / `glm` **八个 slug**，jsDelivr 与 unpkg 两个源全部 404。0.16.36 那句是**对的**。
- 但它们并非没有矢量。`@lobehub/icons-static-svg` 同时收录两家的标记，本轮取回并**逐字**落库
  （`zai.svg` / `chatglm.svg`，取件 2026-09-21，unpkg `@latest`）。用户提到的 **zcode** 也查了：
  它是 z.ai 的官方 harness 产品（zcode.z.ai），**没有**独立图标条目，其品牌归属就是 Z.ai。

**许可与来源必须分开说，这是本轮最容易被含糊过去的一处**：lobehub 是**社区图集**，
不是品牌方发布的资产，与 simple-icons（CC0-1.0）也不同许可。它满足「真实矢量、透明底、随
currentColor」，**不满足「官方发布」**。0.16.36 那份调研（`doc/brand-icons-research.md`）
把这一点写得很死；本轮改用它，是权衡后的选择（用户明确要求这两站也要有图标，而官方渠道
确实没有可直接引用的透明底符号），不是忽略。

因此 `SITE_ICON_TIER` 从两档扩成**三档**，新增的档位专门用来装这种「真实但非官方发布」：

| 档位 | 含义 | 谁在这一档 |
| --- | --- | --- |
| `official` | 官方发布的矢量 | DeepSeek（本机 primitives 的 `FISH_LOGO_PATH`）+ 八个 simple-icons（CC0） |
| `vector` | **真实但非官方发布**的矢量 | GLM、Z.ai（lobehub 社区图集） |
| `missing` | 没有矢量，退回文字标记 | **当前一个站点都不属于这档**（保留该档，供将来新增站点使用） |

顺带把散在四处的 `siteTier(sid) === 'official'` 收敛成 `hasBrandVector(sid)`（`!== 'missing'`）：
判据只有一个来源，否则新档位会被那四处漏掉，GLM / Z.ai 就会「有图标却按没有图标渲染」。

### 一之二、顺手结清了 §27：九条路径已与上游**逐字符**核对

0.16.36 在 [`doc/long-term-issues.md`](long-term-issues.md) §27 挂过一条未解决项：「八条
simple-icons 路径的来源无法在本机复核」（当时外网被挡，只做了一个已被判定不可采信的
形状审计）。**本轮外网通了，这条结清了**：改用「取回上游 SVG → 原样贴进复核脚本 →
逐字符比对」，`.tmp/icon-source-verify.mjs` 一次跑通，**九条全部 `IDENTICAL`**
（七条 simple-icons + 两条 lobehub）。

核对过程本身查出一条**必须记下来的事实**：`openai` 在 simple-icons **latest 里已经 404**，
只在 **14.5.0** 还能取到——该图标后来被图集移除。因此那条路径的来源必须钉版本；
下一个人拿 `@latest` 复核会得到 404，然后**误判成「路径是编造的」**。这一条已写进
`client.cjs` 的图标表注释与 §27 的表格里。

> 边界仍然分开：脚本证明的是「**字节与上游一致**」，**不是**「它属于官方发布」。
> zai / glm 来自 lobehub **社区图集**，这一条不因核对而改变——它由 `vector` 档承载。

### 二、胶囊：从「抄 panelRow 的数值」改成「抄官方的**结构**」（第 2 点）

用户说「你现在只是在半路」——**这个判断是对的**。0.16.36 我只把左栏 `.panelRow` 的行高与
圆角抄了一半，行内是裸 `<button>`、右侧是自绘箭头 + 自管展开态。看着像，但壳子、触发器、
键盘行为都不是官方的。而「新建终端」在官方是另一个组件：
`@deepseek-ai/dsh-client-ui-sidebar-terminal` 的 **`TerminalGuide`**。

本轮按它的结构重写（尺寸逐项取自 `TerminalGuide.module.css`）：

| 部件 | 官方的做法 | 本插件的落点 |
| --- | --- | --- |
| 外壳 | `.entry`：`border:.5px solid border-l4` / `background:bg-layer-1` / `border-radius:24px` / `display:flex` / `overflow:hidden` | `.hwb-site-card` |
| 主区 | `Button variant:'ghost'` + `.main`：`flex:1` / `gap:14px` / `min-height:56px` / `padding:14px 20px` / `border-radius:24px 0 0 24px` | `.hwb-site-main`（官方 `Button`） |
| 文字 | `.title` 15px/1.4 + `.description` 13px/1.4（`label-primary` / `label-caption`） | `.hwb-site-title` / `.hwb-site-desc` |
| 触发器 | `Button variant:'ghost'` + `.trigger`：`width:44px` / `align-self:stretch` / `border-radius:0 24px 24px 0`，内容是 `IconChevronDownOutline14` | `.hwb-site-trigger`（官方 `Button` + 官方 chevron） |
| 下拉 | 官方 `Menu`（`portal:true` / `autoFocus` / `align:'end'`），开合由调用方的 `useState` 管 | 同款，条目 = 该站点的各账户槽 |

**说明行只在多账户时出现**：官方 `TerminalGuide` 也是 `description !== undefined && …` 才画第二行，
单账户站点给一句「1 个账户」是噪音。**单账户站点不给触发器**——给一个点了没东西的箭头是骗人的。

`Button` / `Menu` / `IconChevronDownOutline14` 都按本文件既有的「降级不是崩溃」取（0.16.23 立的规矩）：
旧版 primitives 缺位时回退成空组件，面板照常渲染。

### 三、修了一处**测试桩失真**（本轮最值得记的一条）

写胶囊时冒出一条看着莫名其妙的失败：目录里「找不到『智谱清言』行」，但页面渲染**没有任何错误**。

真因不在产品代码，在测试桩：`client-render.test.mjs` 里的假 `React.createElement` 写的是

```js
(type, props, ...children) => ({ type, props, children })
```

——**只把 children 挂在返回节点上，没有放进 `props`**。而真 React 两者都给（单子给单值、多子给数组），
官方 `primitives.Button` 恰恰是从 **`props.children`** 取内容的（签名 `({variant, children, ...rest})`）。
于是「官方原语包着的图标与文字」在桩里被整块丢掉：**渲染不报错、errors 为空、断言却看不到那行字**。

这与本文件上方 `primitiveOmit` 注释里记着的 0.16.21 教训同族——**桩的建模失真会把整类 bug 盖住**，
区别只是上次是「缺导出」，这次是「导出在、但喂进去的 props 形状不对」。修法即让 `createElement`
与真 React 同形。这条要留着：**下一批用官方原语的 UI 代码会越来越多，桩不同形就会持续假绿。**

> 附带纠正一次我自己的误判：我一度以为是 harness 的 `instantiate` 吃掉了组件 children，
> 改成「只摊平、由外层递归」——结果立刻撞 `Maximum call stack size exceeded`（外层再 instantiate
> 一个非函数节点就会无限自套）。原来的 `map(instantiate)` 是对的，已原样恢复，并把原因写进注释，
> 免得下一个人再走一遍。

### 四、本轮实跑的读数

| 项 | 读数 |
| --- | --- |
| `client-render.test.mjs` | **46/46 通过**（新增 1 条：胶囊几何 + 官方原语在位 + 左栏旧口径不得复活；改写 2 条） |
| 注释闸门 | PASS（126 文件 error 0 / warn 0） |
| 文件规范闸门 | PASS |
| 记账闸门 | PASS（version 0.16.37 / testFiles 70/70） |
| 发布闸门 | PASS（tarball 与工作树逐字相同 + 接线完好） |

---

## 0.16.36（2026-09-20，**未提交**）—— 站点目录改官方左栏行排版；面板内横向站点条再删；官方图上网取回

用户四点（逐字）：「1.图标：DeepSeek 为官方矢量；其余站点品牌方未发布透明底矢量，按「官方优先」
暂用文字标记。这行字去掉，然后把官方图上网找来 / 2.页面内顶部那一行去除，顶部一行那个去除，
只留下官方多开一级和 web bridge 并列那行（独立标签保留就是）/ 3.上下排并列叫你参考现在官方：
工作区文件 / 新建终端 / 浏览器 / Web Bridge 这样的排列你不懂吗？？？一样布局啊！格式！/
4.叫你然后是每行右边能够选择登录账号（有多个账号的）做的类似“新建终端”右边点击拉取时候的
展开你不懂吗？？参考官方布局 ui 设置代码啊！」

### 一、图标：从「文字标记」改成真实品牌矢量（第 1 点）

**来源是 simple-icons（CC0-1.0 公有领域）**，理由不是「随便找了个图集」，而是**跟随官方口径**：
官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `siteGlyph` 用的就是它——本机在
`lib/index.js` 里实读到 `SITE_HOSTS`（44 条 host → 标记映射）与注释「simple-icons artwork set
(CC0-1.0)」，逐字核对过（`grep -c 'SITE_HOSTS'` = 2 处命中）。

八个站点取到真实矢量（DeepSeek 本来就有的官方鲸鱼不动，仍走 `FISH_LOGO_PATH`）：

| 站点 | 图标 slug | 站点 | 图标 slug |
| --- | --- | --- | --- |
| ChatGPT | `openai` | 通义千问 | `qwen` |
| Claude | `anthropic` | Kimi | `moonshotai` |
| Gemini | `googlegemini` | 豆包 | `bytedance`（豆包属字节系，品牌方未单独发布豆包矢量） |
| Grok | `x` | | |

**GLM 与 Z.ai 确实没有**：`zhipu` / `chatglm` / `zai` 三个 slug 都取不到（404）。按本仓库
「不造假状态」的既有纪律，这两站继续用文字标记（`GL` / `ZA` + 圆环），并在逐行 `title` 里写明
「simple-icons 无 … 条目」。**一个站点的图标缺失是如实，不是遗漏**。

顺带删掉首屏网格底部那行脚注（第 1 点明确要求「这行字去掉」）。删它不只是少一行字：
那句话在 0.16.36 之后**已经不成立了**——八个站点现在都有真实矢量。

> **取证边界（如实记）**：本轮本机沙箱下 `web_fetch` 取 simple-icons 返回
> `TypeError: fetch failed`（外网被挡），因此**这八条路径的字节来源本轮无法在机内复核**。
> 我写过一个形状审计脚本 `.tmp/icon-path-audit.mjs`，但它**本身不可靠、结论不可采信**：
> 数字抽取是朴素正则，会把 `a` 命令的标志位与相对坐标混进同一串数字，报出的 `min/max`
> 是解析产物而非几何事实（例如 `max=7948` 来自多个 token 相接，不是真实坐标）。因此它
> **连证伪都做不到**。坐实来源的唯一办法是在能联网的环境里逐条比对 slug 文件。
> 这一条已挂账，见 `doc/long-term-issues.md` §27。

### 二、面板内横向站点条**再删**（第 2 点）

0.16.34 删过 → 0.16.35 我按「一行并列显示不同网址栏目」**恢复** → 0.16.36 用户明确说
「页面内顶部那一行去除」。**这是我上一轮把他的话读错了**：他要的「一行并列」是
**DSH 官方右侧栏自己的标签条**（Web Bridge / DeepSeek / 智谱清言 …），不是面板内自建的一条。

删除的同时清掉只为它存在的代码：`tabsRef` + 滚轮横向滚动 effect、`onTabKey`（tablist 方向键
漫游）、`siteIds`，以及 `.hwb-sitebar*` / `.hwb-site-tab*` / `.hwb-tab-glyph` 六条样式。
面板内站点入口因此只剩两处，且都在更合适的位置：右栏 Web Bridge 标签页里的**站点目录**
（新建站点标签的入口），与官方标签条本身（切换）。

### 三、目录改官方左栏行排版（第 3 点）

尺寸**逐项**抄自官方 `@deepseek-ai/dsh-client-ui-sidebar` 的 `.panelRow`：
`min-height:36px` / `border-radius:12px` / `padding:7px 8px` / `gap:8px` / `margin:0 2px` /
`font-size:14px` / `line-height:22px`。于是「站点目录」与官方的「工作区文件 / 新建终端 / 浏览器」
是同一套排版，而不是自创一套（这正是用户说的「一样布局啊！格式！」）。

### 四、每行右侧账户展开（第 4 点）

多账户站点在主行**右侧**给一颗展开按钮，形态照官方 `DisclosureRow` 的做法
（`.row:hover .iconIdle{opacity:0}` / `.chevronHover{opacity:1}`）——本仓库的落点是：
默认 `opacity:0`，行 hover / 按钮 focus / 展开态才显形；尺寸取官方图标按钮的 28px 家族。
**单账户站点不给这颗按钮**（给一个点了没东西的箭头是骗人的）。
展开后缩进列出各账户槽（`padding-left:36px`），点某账户 = 用那个槽开该站点的标签。

### 五、本轮实跑的读数

| 项 | 读数 |
| --- | --- |
| `client-render.test.mjs` | **45/45 通过**（新增 1 条钉子：「面板内不得再有自建站点条」，防止这条又被我恢复；改写 1 条：目录行必须带官方 `panelRow` 尺寸口径 + 多账户站点必须有右侧展开按钮） |
| 注释闸门 | PASS |
| 文件规范闸门 | PASS |
| 记账闸门 | PASS（version 0.16.36 / testFiles 70/70） |
| 发布闸门 | PASS（tarball 与工作树逐字相同） |

---

## 0.16.35（2026-09-20，**未提交**）—— 站点目录 + 每站点一个标签；横向站点标签条恢复

用户原话：「我现在是重启了吗？你怎么完全没有改变？？？你看：文件夹，新建终端，浏览器，这几个
是怎么排列？从上往下！我希望是点击 web bridg 后能够实现，一样的 deepseek，智谱，等这样排列！
而不是一点进去就是 deepseek，然后你现在的 deepseek 上面那点击排列多个网点就不要了！登录态
不要看！我只是想要能够实现然后新开 web 再次选择不一样的能够像现在一级跳转回去一样，跳回
webbridge 一级，一行并列显示不同网址栏目！！！你这个现在还切换不了了选择后！！」

先把两条事实摆清楚，因为用户的第一个问题就是它们：

- **「重启了吗」**：3080 当时实测 `build.version` = **0.16.34**，即 0.16.34 已经加载了。用户
  「完全没有改变」的观感**不是没重启**，而是 0.16.34 改的方向与他想要的相反（我删了他要的那排）。
- **「切换不了了」**：一条**真缺陷**，且不在菜单本身（见下）。

### 一、`Select` 点了没反应：`useDismissOnOutsidePointer` 的 rootRef 没挂上

真因（真机行为可推、代码可读）：`SitePicker` 里 `useDismissOnOutsidePointer(rootRef, open, setOpen)`
是**无条件调用**的（hooks 顺序纪律，`test/hooks-order.test.mjs` 钉着），而 0.16.33 写的那条
「有 Menu 就用 SiteMenu」的分支**没有把 `rootRef` 挂到任何节点**。官方判据是：

```js
root.current?.contains(event.target) !== true   // client-ui-primitives: useDismissOnOutsidePointer
```

`root.current` 恒为 `null` → 这个表达式在**每一次** pointerdown 上都为真（**包括点在菜单行上**）。
pointerdown 先于 click 派发，于是 `setOpen(false)` 先落地、列表先卸载，随后那一下 click 已经没有
目标，`onSelect` **永远**不被调用——菜单能开、点不动。

本轮按新方向把那条分支整个删了，缺陷随之消失；**教训写进代码注释与护栏**：将来再用
「自绘下拉 + 官方 dismiss 钩子」，rootRef 必须挂在**同时包住触发按钮与列表**的那层元素上。

### 二、删了什么、恢复什么

| 动作 | 对象 | 依据 |
| --- | --- | --- |
| **恢复** | 横向站点标签条（`.hwb-sitebar` / `.hwb-site-tab` / 滚轮横向滚动 / `onTabKey` / `siteIds`） | 用户：「一行并列显示不同网址栏目」——0.16.34 我删错了，原样恢复 |
| **去掉** | 站点标签里的登录态（状态点） | 用户：「登录态不要看」 |
| **删除** | 工具条上的站点下拉按钮 | 用户：「你现在的 deepseek 上面那点击排列多个网点就不要了」 |
| **删除** | `SiteMenu` 组件 + `Menu` 解构 + 六条菜单样式 | 失去全部调用方；死代码会让人以为还有入口 |

### 三、新增：站点目录（一级）+ 每站点一个标签

**站点目录**（`SiteCatalogBody`）＝右栏「Web Bridge」标签页的全部内容：从上往下的站点行
（`SiteGlyph` 图标 + 站点名），**不显示登录态**；多账户站点把各槽作为缩进子行列在其下
（这是「同站点多账户也能选」的落点，账号底层一行未改）。

点一行 = `ctx.sidebarRight.openTab('webcode-site', { params: { siteId, slot } })`。官方契约
（`sidebar-right/lib/client.js:5875`）在 `definition.multiple === true` 时生成
`` `${pageAddress(kind)}/${randomUUID()}` `` 作为地址 —— **每次开都是独立标签**，`params` 随
标签记入 `navigation`。于是顶部标签条上就是「DeepSeek / 智谱清言 / Kimi …」一行并列，点回
「Web Bridge」标签就是回到这份目录。

站点标签的正文与标题都从**自己的** `navigation.params.siteId` 读（官方 Browser 面板同款做法：
`tab.navigation.params?.url`）。不这么做就只能靠「最后一个挂载的面板」猜站点，那正是「两个标签
互相改对方」的根因。

### 四、护栏与测试

- `client-render`：**45/45 通过**。新增 3 条行为断言（目录从上往下且无登录态、点一行真的调
  `openTab` 且带 `siteId`、站点标签从自己的 `params` 取身份），掉头改写 1 条（标签条**在位**
  且不含状态点），删 1 条（`SiteMenu` 不得复活）。
- 顺手修掉一条**空转的旧断言**：0.16.34 那条「站点条样式已删除」写的是 `/^\\.hwb-sitebar\\{/m`，
  而样式表里的行是 `".hwb-sitebar{…}",`（带引号、带缩进）——它**永远为假**，所以「已删除」永远
  成立。这是「护栏必须证明自己不是空转」的又一例，两边都改为带引号字面量。
- `sidebarRight.openTab` 的测试桩从 `{}` 改为**记录调用**：此前「点站点会发生什么」在护栏里
  完全没有证据，只能测出目录画得像不像。
- 逐文件 `node test/<file>` 实跑：**69/70**（改动前基线与改动后一致），唯一红的 `reply-log.test.mjs` 是跑法产物（前提断言读
  `NODE_TEST_CONTEXT`，补上后 4/4 绿），与本次改动无关。

---

## 0.16.34（2026-09-20，**未提交**）—— 右栏站点选择改竖排二级菜单（横向站点标签条删除）

用户原话：「我要图一的菜单样式：tab 右侧栏目，上下排列选择，放二级菜单选择，而不是现在的
二级菜单：一行过去，换成加个上下的选择！然后右侧参考现在官方终端右侧展开：是能切换账号
（同站点多账户）能选择！」

### 一、删了什么（这是本轮的主要动作，不是加东西）

右栏面板里那条**常驻的横向站点标签条**整体删除：

| 删除项 | 位置 | 为什么连它一起删 |
| --- | --- | --- |
| `.hwb-sitebar` / `.hwb-sitebar-tabs` / `.hwb-site-tab` / `.hwb-site-tab.active` / `.hwb-site-tab-name` / `.hwb-tab-glyph` | `client.cjs` 样式表 | 标签条没了，规则就是死规则；留着只会让下一个人以为它还在 |
| 标签条渲染块（`role="tablist"` + 十个胶囊） | `Conversation` 渲染体 | 用户要的「上下排列」 |
| 滚轮横向滚动 effect（`tabsRef`） | `Conversation` | 只为「标签溢出时横向滚」存在；宿主元素已不存在 |
| `onTabKey`（tablist 左右方向键漫游）+ `siteIds` | `Conversation` | 同上，键盘走行改由官方 `Menu` 原语承包 |

**随删除消失的一条能力，必须点名**：标签条上的 `Ctrl/⌘+点击` 与中键 = 在新分屏打开该站点。
这是**只存在于标签条上**的隐形快捷键（0.16.22 的注释自己就写着「用户无从发现」），删掉它
不丢分屏能力——工具条上的「在新面板中打开」按钮与首屏网格里的同一颗按钮都还在。

### 二、留下来的形态

工具条上的站点按钮弹出**竖排二级菜单**（0.16.33 已建，本轮起是唯一入口）：

- 一行一个站点：`SiteGlyph` 图标 + 站点名 + 8px 状态点 + 状态词（名左、状态右，行撑满菜单宽）；
- 该站点**有多个账户槽**时，行右侧展开子菜单列出各账户（**默认槽也在子菜单里**——单账户站点
  不挂子菜单是官方 `Menu` 契约要求：`onSelect` 对「只展开子菜单的父行」不调用，挂上去会让
  「切到 DeepSeek」这个最高频动作点不动）；
- 账户行数据来自 `/status` 的 `driver.sites`（按槽一行），连接仍走既有的 `{siteId, slot}`，
  **未新增也未改动**账号底层任何逻辑。

### 三、一处信息搬家（不丢）

「这个站点画的是官方矢量还是文字标记」的说明（`siteIconWhy`）原先挂在标签条每个 tab 的
`title` 上；标签条删除后改挂在**菜单行的图标挂点**上（`.hwb-menu-glyph` 的 `title`）。
断言也跟着从「tab 里有」改成「菜单行里有」——钉的是信息不丢，不是 DOM 位置。

### 四、护栏：`Menu` 桩从「挂 props」升级为「真渲染行」

`test/client-render.test.mjs` 里官方 `Menu` 的桩此前只把 `items` 原样挂成 props，于是
「菜单打开后长什么样」在护栏里**整块是空白**——而本轮恰恰把站点选择全收进了这个菜单。
桩现在渲染 `anchor` + （`openMenu` 时）逐行渲染 `items`（含前导图标），子菜单仍不伪造
（真机靠 hover/focus 展开，桩拿不到这两个事件；账户行的护栏走源码静态检查）。

同时新增钉子「横向站点标签条已删除，且配套代码不残留」（查带引号的活代码与 `^\\.hwb-sitebar\\{`
这类样式规则，不查注释里解释性的提及）。

### 五、本轮读数

- `node test/client-render.test.mjs`：**43/43 通过**；
- `node scripts/check-ledger.mjs`：PASS（version 0.16.34 / testFiles 70）；
- `node scripts/lint-comments.mjs`：PASS（126 文件 error 0 / warn 0）；
- `node scripts/check-repo-hygiene.mjs`：PASS（无 BOM / 索引无死链 / Node 版本相容）；
- `pnpm test` 在本会话沙箱下 **`spawn EPERM`**（`node --test` 起子进程被沙箱拒绝），
  与 0.16.9 记过的那次同因。改逐文件 `node test/<file>` 实跑：**69/70 绿**，唯一红的
  `reply-log.test.mjs` 是**跑法的产物而不是产品缺陷**——它的第一条用例自带前提断言
  「本用例跑在测试进程里」（读 `NODE_TEST_CONTEXT`），裸跑该文件时这个环境变量不存在，
  于是前提断言先红；按真实跑法补上该变量再跑，该文件 **4/4 通过**。两条读数都记在这里，
  不合并成一句「70/70 全绿」。

---

## 0.16.32（2026-09-20，**未提交**）—— 官方闭 token 缺位/漂移成 DSML 时的整条调用归零

### 一、病灶与修法（上一轮会话完成，本轮复核）

**真机现场**（`~/.dsh/logs/webcode-bridge-replies.log`，会话
`session-01df83cf-7878-4963-b6b6-1985d1dd861a`，13 轮）：断点 `08:27:37.345Z` 起
`calls` 由 2 掉到 1、再到 **0**，且**零诊断**。病灶不在开 token（双竖线已被 0.16.30
收编），而在 `RE_OFFICIAL_CALL` 的**端锚**：它只认 `tool-call(s)-end` 一族 token，
而真机模型把闭 token 写成了 **DSML 形状**，官方端锚永远配不上。端锚必需 ⇒
`calls=0`（不是「少解析一点」，是**整条归零**）。

**修法**（`lib/agent-preset.js`）：

- 抽出 `END_ANCHOR_SRC`（端锚源，复用而非各写一份），并把端锚由**必需**放宽为
  **可选**（`(?:END_ANCHOR_SRC)?`）。
- 端锚可选后必须给参数体补**右边界** `BODY_STOP_SRC`（纯前瞻，不进匹配体）：
  ① 下一个官方 token；② 任何 DSML 开标记；③ 文末。没有它，`([\s\S]*?)` 会一路
  吃到文末，把**下一条调用连体吞掉**（run-10「三调用只出 2 条」在无闭 token 场景重演）。
  **闭 token 必须在此收手**，否则懒匹配会把 `call▁end` 吃进参数体，归一化产物变成
  `<invoke>{"…"}<｜｜tool▁call▁end｜｜></invoke>`——0.16.30 护栏
  `official-double-bar.test.mjs`「no double bar may survive」当场抓到。

### 二、复核读数（本轮实跑）

| 项 | 读数 |
| --- | --- |
| 全量测试文件 | **70/70 通过，退出码 0**（串行逐个跑，`NODE_TEST_CONTEXT=1` 与 CI 同条件） |
| 新增护栏 | `test/official-truncated-close.test.mjs` **11/11** |
| **真机回复原文重放** | 该会话 **13 轮**：`recovered=8 / same=5 / worse=0`——修复后多解析出调用的 8 轮，**没有一轮变差** |
| 断点轮直达对照 | `08:27:49.586Z` live `calls=0` → 修复后 `calls=1`（正是本次故障现场） |
| 注释闸门 | PASS（126 文件 error 0 / warn 0） |
| 记账闸门 | PASS（version 0.16.31 / testFiles 70） |

重放脚本 `.tmp-replay.mjs` 把 reply-log 里**原始回复逐字**喂回修复后的 `parseAgentReply`，
与该轮 live 运行时记下的 `calls=` 逐轮对照——这是端到端判据，不是夹具自证。

### 三、复核发现的一条**未修**缺口（如实记，不修）

`test/official-truncated-close.test.mjs` 的注释写着「DSML 残骸由退役语义扣住不外发」。
**这句话对，但只对流式外发路径成立**；`parseAgentReply()` 返回的 `text` 字段**不扣**：

```
norm = '<calls><invoke name="grep">{…}</invoke><｜｜DSML｜｜ parameter …>…</invoke>'
```

**边界在哪里**（三条实测，本轮逐条跑过）：

| 判据 | 读数 | 结论 |
| --- | --- | --- |
| `findProtocolStart(norm)` | `index=0` | 流式探测**认得出**，`proseSafeEnd` 实测 0 ⇒ 残骸**不会**当正文外发 |
| `stripProtocolRegions(finalText)` | 只留 `PROSE_A ` | 正文挖洞正确，残骸被挖掉 |
| `parseAgentReply(raw).text` | **含 DSML 残骸**（逐字等于归一化串） | 返回值里的 `text` **不扣** |

所以缺口**不在用户可见的会话正文**：`lib/index.js` 的外发路径走
`proseSafeEnd` / `stripProtocolRegions`（第 1572、1627、1789 行），两处都拦得住。
缺的是 `parseAgentReply().text` 这个**返回值**的契约——它叫 `text`，却是「归一化后的
完整串」而不是「干净散文」。当前**没有任何调用方拿它当正文用**（`lib/index.js` 三处调用
只取 `calls` / `diagnostics`，第 1151、1379、1421 行），因此**今天不构成泄漏**。

**为什么不现在修**：改这个字段的语义会动到三个调用方的既有契约，而它当前无消费者、
无真机读数支持、也无用户报障——属于「改对了没人受益、改错了全线回归」。
按 `long-term-issues.md` 的纪律记为**挂账**，等真出现「谁把 `.text` 当正文用」的场景再动。
本条**不是**本轮引入的回归：它随 0.16.32 的端锚放宽一起出现（端锚可选 ⇒ 残骸留在了
替换产物里），但泄漏面被上面两条外发判据挡住。

### 四、打包与装机（本轮实跑）

| 步 | 读数 |
| --- | --- |
| `pnpm pack` | 产出 `dsh-webcode-bridge-0.16.32.tgz` |
| `verify-pack` | tarball 与工作树**逐字相同 39/39** + 接线完好（跨模块引用已钉住） |
| 装 web profile | `dsh plugin --profile web add <tgz>` 退出 0，实测 `package.json` = 0.16.32 |
| 装 headless profile | `dsh plugin --profile headless add <tgz>` 退出 0，实测 = 0.16.32 |
| 已装副本核对 | 两处 `lib/agent-preset.js` 含 `END_ANCHOR_SRC` / `BODY_STOP_SRC` / 可选端锚，且 sha256 `EE9AD8B7EAC7141C…` 与工作树**相同**——修复随包落地，不是「装了个旧副本」 |

**走的是 `dsh plugin add`（pnpm 通道），不是 `install-profiles.mjs`**：后者绕开 pnpm
只写 `node_modules`、不改 profile 声明，任何一次 pnpm 通道都会把版本静默回退（该脚本
自己的注释已第 3 次记下这个坑）。本轮实测 `dsh plugin add` 两条均退出 0。

**装机 ≠ 生效**：3080 当前进程仍是 0.16.31，需重启才加载 0.16.32。

## 0.16.31（2026-09-20）—— DeepSeek 附件投递解禁 + 间隔 `end-to-start` 口径 + 药丸跳动修复

**用户指令（逐字）**：「1.你做得到就解禁更新文档！并修改 2.是 reply-to-send」（前一轮：
「1.那你尝试实现，先验证后有保障再修复，放入参考文件夹复制 dsh-drop-caret，然后真实单独实现
完善本机 deepseek 投递 2.请你看下等待发送时间逻辑：1.感觉底下框的时间会有跳动？2.我需要的是
web 思考后调用时间后不立即回复而是间隔多少秒回复，不是现在好像是的那个距离上传里面回复时间？
注意是为了隔开和他发消息我立马回复的规避点！」）

### 一、DeepSeek 附件投递解禁（静态禁令清空）

**先复制参考**：`dsh-drop-caret` 完整正本（host `lib/index.js` + client + `cordis.patch.yml`
+ README）落到 `reference/dsh-drop-caret/`。它的做法是「Host 注册 HTTP 路由 → 客户端 drop
事件 POST → 落盘到该会话 cwd 的 `.dsh-drop/<sessionId>/` → 把路径回填输入框」。本仓库早已
用同一模式做过提示词落盘（§0.16.28/§0.16.29 的 `prompt-store.js`），因此**没有新建上传通道**，
而是把力气花在真正缺的那一环：**附件投递本身能不能用**。

**先验证（只上传、绝不发送）**：`POST /__webcode/attach-probe` 对运行中的 3080 实测：

```json
{ "ok": true, "evidence": "text:webcode-probe.md", "ms": 105, "chars": 78, "sent": false,
  "domSnippet": "<div class=\"e70accd6\">webcode-probe.md</div>",
  "candidates": [ {"sel":"[class*='attachment']","count":0,"visible":0}, … 十条全 0 ],
  "cleaned": false, "cleanedBy": "none",
  "cleanupNote": "未找到清除入口（只试了 setInputFiles([]) 与附件节点自身容器内的删除控件）" }
```

**四条结论**：

| # | 读数 | 能推出什么 |
| --- | --- | --- |
| 1 | `ok:true` + `domSnippet` 实拍 chip | DeepSeek 页面**收得下 `.md` 并渲染出可见附件**（105ms） |
| 2 | `candidates` 十条全 0，命中靠 `nameHit`（文件名证据） | 当年 `ATTACH_NOT_CONFIRMED` 的直接原因是**类名清单零命中**，而文件名证据 0.16.3 才实现——旧禁令的前提已不成立 |
| 3 | `cleaned:false` | 清理路径**确实失效**（这是真缺陷，见下） |
| 4 | `sent:false` | 探针零副作用，可反复跑；但它**回答不了**「模型读不读」 |

**先保障，再修复**（用户要求的次序）：

- **清理路径重写**（阻塞项：附件留在输入框 → 下一条消息莫名带上它）。旧实现只沿**祖先链**
  找删除控件，而真机 chip 的最深节点是文本 div（`<div class="e70accd6">webcode-probe.md</div>`），
  控件不一定在祖先里。现在两段式：① 先按**语义标签**找（`aria-label`/`title`/`data-testid`/`class`
  命中 删除|移除|remove|close|clear|取消|×|✕|✖|trash|delete，且排除 `type=submit`）；
  ② 语义全落空时按**位置**找（与文件名同容器、位于其右侧、尺寸 ≤ 48px 的可点元素），
  且**多附件时不按位置猜**——点错会删掉别人的附件。
- **运行期自愈网已在役**（0.16.28）：`DYNAMIC_ATTACH_BLOCKS` 对「附件轮整轮零回复」的两个
  签名（空结果 / 超时）自动降级并记住，当轮即回落 inline，`/__webcode/status` 的
  `attachBlocked` 如实报出。
- **解禁**：`ATTACH_FORBIDDEN_SITES` 从 `Set(['deepseek'])` 改为**空集**。取舍写在源码注释里：
  静态禁令用**永久走不了附件**换**一轮风险**，不划算。

**护栏同步更新**（钉的判据从「deepseek 必须在表里」翻成「表必须为空」，机制断言逐字保留）：
`test/attach-selfheal.test.mjs` ①、`test/prompt-transport.test.mjs` ⑨/⑨b/⑩（⑩ 新增
「运行期自愈命中时面板必须报『永不使用附件投递』」一条）。

**如实记（未验证的部分）**：探针**不发送**，因此「模型是否真的读到了附件内容、会不会零回复」
**本轮没有真机读数**。派出的子代理因本机沙箱 `spawn EPERM`（连 `msedge.exe` 都起不来）
未能产出证据，它自报的「两轮确认标记」没有落盘文件、**不作为依据**。这条只能由下一次
真实首轮（超过 60,000 字符）自行判定，判据：若自愈记下 `ATTACH_ZERO_REPLY`，
`/__webcode/status` 的 `attachBlocked` 会有现场，届时按读数决定是否恢复静态禁令。

### 二、发送间隔新增 `end-to-start`（距上次回复完成）

用户要的是「隔开和他发消息我立马回复的规避点」。这与 `send-to-send`（0.14.0 默认）**防的不是
一件事**，因此并存为选项（命名沿用 `doc/long-term-issues.md` §8「若要修，从哪下手」里的
`'send-to-send' | 'end-to-start'`，那条挂账本轮结清）：

| 口径 | 基准 | 防什么 | 上一轮跑很久时 |
| --- | --- | --- | --- |
| `send-to-send`（**默认**） | 上次**发出** | 站点滑窗限流（按请求到达计） | 本轮**无需再等**（已满足） |
| `end-to-start` | 上次**回复完成** | 对话节奏贴太紧（「刚答完我立刻回」） | **不影响**本轮，答完起重新数满 |

落点（五处 + 两个设置面）：

- `computeSendGap({ lastSendAt, lastEndAt, basis, now, gapMs })`，返回值新增 `basis` 回显；
  非法值一律退回 `send-to-send`（配置写错只许退化成旧行为）；基准缺失时返回 0 等待且
  `sincePrevSendMs: null`——**不拿另一个基准凑数**（凑出来的等待无从解释）。
- 落盘 `webcode-send-state.json` 的值从**裸数字**升成 `{ send, end }`；**旧格式照样读**
  （裸数字即 send、end 缺失），升级不丢基准。`rememberTurnEnd()` 在**真正收束之后**打点
  （不是 `finally`——`finally` 在抛错时也跑，会把基准提前）。
- metrics 新增 `gapBasis`；`relay.js` 原样透出；面板明细行文案随口径切换
  （「距上次发出」/「距上次回复完成」），**`gapBasis` 缺失时保持历史文案**（缺字段 ≠ 口径变了）。
- 设置页两个面都加了口径下拉：HTML 页（`settings-page.js`）与右栏 React 面板
  （`client.cjs`，与间隔共用「草稿/已保存/提示」三件套）；`POST/GET settings` 双向归一化。
- OpenAI 兼容前端（`:8931`）同步传 `sendGapBasis`——0.14.0 那次「gapTargetMs 恒为 0」
  的同型缺陷，这次一并堵住。

### 三、等待药丸的跳动（真缺陷）

用户报「底下框的时间会跳动」。根因不是取整，是**在途读数被提前清空**：
`clearLiveWait` 原先放在等待 `sleepSignal` 的 `finally` 里，于是等待一结束读数就消失，而账本
要等**整轮生成跑完**（`relay` 的 `onMetrics` → `recordWaitMetrics`）才吸收——中间那几十秒药丸
掉回**上一轮**的旧值，收束时再跳上去。修法：正常路径**保留**在途记录（`endsAt` 已把时长冻结在
满值），账本吸收时由 `recordWaitMetrics` 里的 `clearLiveWait` 收尾（同一份增量从 live 搬进账本，
数字原地不动）；只有**中途 abort** 才在 catch 里清（那时本轮不会有 metrics，留着会让药丸停在
一个不动的假数上）。发送间隔等待与限流退避等待**两处同修**。

### 四、验证（本机实跑读数）

本机 `node --test` 会 `spawn EPERM`（沙箱），但**直接 `node test/xxx.test.mjs` 可跑**（进程内）。
本轮全部改用后者，并设 `NODE_TEST_CONTEXT=1`（与 CI 同条件——不设它时 `reply-log` 的测试进程
守卫用例会假失败，实测确认）。

| 项 | 读数 |
| --- | --- |
| 全量测试文件 | **69/69 通过**（串行逐个跑，`test/parse.test.mjs` 与 `test/run-m1.js` 亦 0） |
| 新增护栏 | `test/send-gap-basis.test.mjs` **12/12**（含 8 条纯函数 + 4 条源码结构） |
| 纯函数探针 | `.tmp/probe-gap-basis.mjs` **16/16**（既有 `send-gap` 八条回归 + 新口径八条） |
| 模块加载探针 | `.tmp/probe-imports-1631.mjs` **11/11**（改过的模块全部 import 成功） |
| 结构断言 | 11/11（`basis`/`lastEndAt`/`gapBasis`/`rememberTurnEnd` 接线 + 两处等待无 `finally`） |
| 文件规范闸门 | PASS（改名后用 `Set-Content` 批量重写，逐个核对 CRLF 保留、无 BOM、尾换行完好） |
| 附件探针（真机） | `ok:true`、`evidence:text:webcode-probe.md`、105ms |

**已知既有 flake（如实记）**：`test/control-routes.test.mjs` 在**并行负载**下会读到端口为
`null` 而红两条（台账早前记过同款）；本轮串行重跑**全绿**，确认与本轮改动无关。

### 五、本次改名事故（记下来，不只修掉）

把 `reply-to-send` 统一改名为 `end-to-start` 时用了 PowerShell 的
`(Get-Content -Raw) -replace 'reply-to-send','end-to-start'`。**`-replace` 默认大小写不敏感**，
于是测试数据里作为「非法值样例」的 `'REPLY-TO-SEND'` 也被替成了合法的 `'end-to-start'`，
断言随即变红（期望退回默认口径、实际收到合法值）。
**教训**：批量文本替换工具**不是**重构工具——它不区分「标识符」与「字符串字面量里故意写错的值」。
凡是要替换的串同时出现在**正例与反例**里，必须逐处改（或用区分大小写的替换并核对 diff）。
最终该用例补上了三个变体样例（`END-TO-START` / `end_to_start` / 带尾空格），把「逐字相等」
这个判据钉得更死。

## 0.16.30（2026-09-20）—— 官方 token 双竖线 `<｜｜tool▁…` 全族解析归零（自动化流程被打断的根因）

**用户指令（逐字）**：「请你查看最近两个对话！看看版本更新后为什么自动化流程被打断了？明明
你好中还可以，但是新版本就一直错误调用！改了什么？你快速更改修复！」

### 一、症状与现场

用户报「自动化流程被打断、每轮都错，之前还好」。真机现场是每轮一条：

```
TOOL_CALL_UNPARSED: 网页这一轮发出了工具调用，但桥没能把它变成可执行的调用…
AUTO_CONTINUED: 已自动补发提醒，网页已重新发起 N 条调用。
```

即**每轮调用数为 0**，补发再教学后下一轮照旧失败（模型无条件收敛的形状可改）。

### 二、根因（已在真机取证，不是推断）

回复原文落盘（`~/.dsh/logs/webcode-bridge-replies.log`）里，失败轮的工具调用长这样——
包裹竖线是**两枚** U+FF5C：

```
<｜｜tool▁calls▁begin｜>
<｜｜tool▁call▁begin｜>pwsh<｜｜tool▁sep｜>{"command":"pwd"}<｜｜tool▁call▁end｜>
<｜｜tool▁calls▁end｜>
```

而 0.16.18–0.16.29 的全部解析正则都写成 `'<' + 单枚 OFFICIAL_BAR + '\\s*'`。
**`\s*` 吃不下第二枚竖线**，于是整族一条正则都不命中：

| 层 | 修复前对双竖线的结果 |
| --- | --- |
| `findProtocolStart` | `index = -1`（边界探测认不出，协议原文有泄漏窗口） |
| `normalizeOfficialToolCalls` | 原文**逐字不变**（改不动，不产生 `<invoke>`） |
| `parseAgentReply` | `calls = 0` ⇒ 每轮 UNPARSED、自动化整轮空转 |
| `partialProtocolAt` | 半截 token 返回 `-1` ⇒ **不扣留**，半截标记当散文外发并写进会话 |

**「改了什么」的形状学答案**：协议从 DSML 族换成官方 token 族（0.16.18 教学、0.16.23 成为
唯一协议）时，**DSML 族一直有的那条竖线宽容没有跟过来**。DSML 词形源写的是
`DSML_BAR_CLS + '{1,3}'`（容 1~3 枚竖线，见 `DSML_MARK_SRC`），官方族从引入起就只有
一枚。日志计数坐实两族都在写双竖线：全日志 **9,803** 处 —— DSML 时代 9,764 处
（`<｜｜DSML｜｜ invoke …>`，当年被 `{1,3}` 容下、照常执行），官方 token 族 **25** 处
（本次故障现场，一条都不认）。所以「之前还好、新版本一直错」不是玄学：**换协议族时
丢掉了一条宽容**。

### 三、修法

新增 `OFFICIAL_BAR_CLS = OFFICIAL_BAR + '{1,3}'`（与 `DSML_BAR_CLS` 同纪律、同字符、
同 1~3 上界，两份不各写一套），替换官方族**全部五条**正则的包裹竖线：

- `RE_OFFICIAL_CALL`（调用段改写，含端锚）
- `RE_OFFICIAL_CALLS_BEGIN` / `RE_OFFICIAL_CALLS_END`（包裹 token 映射）
- `RE_OFFICIAL_CALLS_BEGIN_AT`（补发 `<calls>` 的判定）
- `PROTOCOL_ANCHORS` 里的官方 token 锚点（流式边界）

外加 `partialProtocolAt` 的**精确前缀表**补双竖线族（前缀表是精确字符串，归一化对
"标记不完整"一格都不改，所以归一化救不了它——与 0.15.0 空格族同一条教训的第三次生效）。

上界取 3 而不是无界 `+`：锚点与改写要在流式途中被每个 delta 反复调用，无界量词会让
`<｜｜｜｜｜…` 这类噪声串被整段吞进协议判定（会给噪声发奖励）。**只放宽竖线，不放宽
别的**——单竖线既有行为逐字不变。

再教学提示（`trainNoteFor` 的官方版尾段 + `unparsedCallNotice`）点名真实病灶：
「包裹竖线是一枚全角竖线（｜），左右各一枚，不要写成两枚（｜｜）」。与 0.16.20 / 0.16.25
同一条纪律：提示必须指出模型**实际写错的那一处**，否则模型自查「name 在、JSON 合法」
后无处可改，只能原样重发。

### 四、验证

**红基线（对已发布的 0.16.28 代码）**：新增 `test/official-double-bar.test.mjs` 11 条，
对着 `8689ad7` 的 `lib/agent-preset.js` 实跑 **8 红 3 绿** —— 红的正是双竖线全族
（单/多/无参调用、改写、边界、三竖线、半成品扣留、再教学文案），绿的正是「不许回归」
的三条（单竖线仍可解析、四竖线仍不认、普通散文仍不扣）。修复后 **11/11 全绿**。

**真机回复原文重放**（把 reply-log 里 live 运行时记为 `calls=0` 的原始回复逐字喂回修复后
的解析器，只取正文含双竖线官方 token 的那些轮）：

| 读数 | 值 |
| --- | --- |
| 双竖线官方 token 的轮次 | **6** |
| 其中 live 运行时记为 `calls=0` | **6**（6/6 全部失败） |
| 修复后解析出 ≥1 条调用 | **6**（6/6 全部恢复） |
| 修复后可执行调用总数 | **13** |

逐轮样本（会话 `session-d8e01269`，`chars` 与边界下标为实跑读数）：
`00:01:31` → pwsh×2 + glob×3；`00:02:41` → pwsh + grep×2；`00:02:51` → pwsh；
`00:03:38` → pwsh；`00:03:58` → grep×2 + pwsh；`00:05:22` → pwsh + read。

**全量**：68/68 测试文件通过、退出码 0；注释闸门 0/0（124 文件）；文件规范闸门 PASS；
记账闸门 PASS（version 0.16.30 / testFiles 68/68）。

### 五、装机状态与遗留

0.16.30 **已打包并装进 web + headless 两个 profile**（`pnpm pack` → `dsh plugin --profile <p> add
<绝对路径 tgz>`；两条 install 均退出 0，两处 `package.json` 实测均为 0.16.30，且已装副本的
`lib/agent-preset.js` 内含 `OFFICIAL_BAR_CLS`，确认修复随包落地）。

**运行中的 `dsh web`（3080）已重启并加载 0.16.30**（2026-09-20 重启）。装机只换文件、
进程要重启才加载，这一步用户已完成。实测重启前 `build.version=0.16.28`，重启后 `0.16.30`。

**真机判据：三条逐条已核通过。**① `GET /__webcode/status` 的 `build.version` = `0.16.30`；
② 新开一轮带工具调用的对话，**不再出现** `TOOL_CALL_UNPARSED`——即使模型仍写双竖线
`<｜｜tool▁calls▁begin｜>`，调用也应照常执行（这正是本轮修的目标）；③ reply-log 里
新轮次的 `calls=` 计数不再为 0。

③ 的实测对照（同一条 reply-log、同一台机器）：重启前故障现场 6 轮双竖线**全部 `calls=0`**；
重启后 19 轮原始回复 **`calls` 全部 > 0**（每轮 1~4 条），且无新增 `TOOL_CALL_UNPARSED`。

**最强证据：重启后真机又写出双竖线，且被成功解析。** `03:42:10.102Z` 与 `03:42:30.115Z`
两轮原始回复的正文里仍含 `<calls>` 双竖线形状（`doubleBar=true`、
`calls_end=true`），live 运行时读数 **`calls=1`** —— 与修复前同形状 6/6 轮 `calls=0`
形成直接对照。修复目标「即使模型仍写双竖线，调用也照常执行」在真机上逐字达成。

**已知的、与本修复无关的另一种失败（如实记，不混为一谈）**：同一时段另有一轮
（`03:41:22.090Z`，`chars=564`）`calls=0`，但它的形状**不是**双竖线——正文在被截断处
结束（`calls_end` 缺失、参数 JSON 未闭合），属于**回复被截断**这一类，与竖线宽容无关。
本轮的 `OFFICIAL_BAR_CLS` 修的是「形状认不出」，不修「内容没发完」。

headless 侧已装 0.16.30，下次启动 `dsh --profile headless` 时生效（本轮未启动该 profile）。

## 0.16.29（2026-09-20）—— 再教学提示隐藏 + 节流窗文案更正 + 文件投递（落盘升格为投递源）

**用户指令（逐字）**：「1.你先设置真实尝试后：能够实现投递再发送文件尝试，看看官方做法，再试下实现：
「把上下文通过文件发送」2.现在返回提示时候只需要保留：AUTO_CONTINUED: 已自动补发提醒，网页已
重新发起 4 条调用。，关于 TOOL_CALL_UNPARSED: 直接隐藏 3.声明好节流窗是 60 秒 4.最好我是想做到：
将提示词保存为本地的单独文件-每个网址一个，然后每轮发送过去，然后是每轮会话单独本地地址--如果
新开会话-web端，就一样把这个当上下文通过文件发送！--以此对抗新开会话：然后反复丢失，搞清楚为什么
会新开web端对话！文件投递参考：dsh-drop-caret，然后以官方定义/ui/规范为主」

### 一、② 再教学提示隐藏（三处出口统一）

`TOOL_CALL_UNPARSED` / `TOOL_UNKNOWN` / `THINKING_ONLY_NO_ANSWER` 三处出口的再教学提示**不再
铺进正文**——它仍逐字作为**补发的用户消息**发给模型（`autoContinueRound`，落 reply-log），
界面上只留一句 `AUTO_CONTINUED: 已自动补发提醒，网页已重新发起 N 条调用。`

唯一例外是**补发根本没发生**（`autoContinueRounds=0` 或无会话键的无状态轮）：此时提示是唯一
归因通道，必须照旧当正文交回——「隐藏」的前提是它已经逐字送达模型。`autoContinueRound`
因此返回 `{disabled:true}` 而不是裸 `null`，把「没补发」与「补发没救回来」分开处置。

护栏：`auto-continue` / `unparsed-notice-head` / `nameless-call` / `recovered-dispatch` /
`stream-tail` 五处判据从「正文含提示」改为「补发的 prompt 含提示」。

### 二、③ 节流窗文案更正：60 秒

`SESSION_REBUILD_THROTTLE_MS` 自 0.16.6 起就是 **60_000ms**（0.16.28 注释里的「30 秒」是引
0.16.6 提交里用户对**更早**版本的描述）。注释已更正并写明上界（等待 ≤ 60s）。
真机佐证：reply-log 里 `上一次整段重建在 19.962s 前…节流窗还剩约 40.038s` = 60.0s。

### 三、④ 文件投递：落盘从**副本**升格为**投递源**

用户要的是「新开会话时把上下文通过文件发送」。0.16.28 只落了盘（写而不读），本轮补上读回：

- 新增 `readPromptFile`（剥头部元信息、兼容旧格式、失败静默返回 null）；
- `index.js` 新增 `readSessionPrompt`（与写入端严格对称的测试进程守卫 + 'off' 一并关闭）；
- 整段重建处 `const rebuildText = readSessionPrompt(m.sessionKey) ?? m.rebuild();`
  ——**优先读磁盘正本**，读不到才回落内存序列化。发出去什么、重建用什么，从此同一份字节。

**顺带修掉一个 0.16.28 的真缺陷**：`writePromptFile` 用 `[..., ''].filter(Boolean).join('\n')`
拼头部，那个空串被 `filter` **删掉**，于是头部末行与正文首行**没有换行**、粘成一行；
真机实测读回只剩第二行之后——正文首行被吞。修法：头部改显式 `+ '\n\n'`；读回端兼容
旧粘行格式（从 ISO 时间戳后取回正文首行并补回换行），保证升级后磁盘上的旧文件仍完整可读。

### 四、④ 第二半：「为什么会新开 web 端对话」逐因可查

用户第 4 问的后半句是「搞清楚为什么会新开 web 端对话」。此前 status 只有 `fresh` 一个
布尔量，于是**四种完全不同的真因在界面上长得一模一样**——其中两种是正常行为、两种是真故障：

| freshReasons 键 | 含义 | 是否故障 |
| --- | --- | --- |
| `no-cursor` | 该会话还没有游标（首轮，或游标被作废过） | 正常 |
| `contract-changed` | 模型 / 系统提示词 / 工具名集合 / 全局指令变了 | 正常（但宿主升级改 system 措辞会频繁触发，值得盯） |
| `anchor-lost` | 尾部被真正改写（如压缩摘要替换），锚点全部失配 | **真故障** |
| `anchor-no-new-messages` | 锚点找到了但没有新消息可发（宿主把这一轮当重放） | **真故障** |

实现：`buildTurn` 里逐因赋值 `freshReason` 并计数，透出 `/__webcode/status` 的
`driver.freshReasons`（两个 status 入口都带——本文件反复记过的那条纪律）。
每条 fresh 同时写一行 `fresh web chat (reason=…, sessionKey=…)` 日志。

护栏：`session-continuity` ⑪（首轮记 `no-cursor`、system 改写记 `contract-changed`）。
判据刻意用 **system 改写**而不是换模型来逼出契约变化——换站点会去起一个真实浏览器
（本机 spawn EPERM），而 system 与工具名集合同属契约四项，改了契约又留在同一站点。

### 五、真机判据（重启 `dsh web` 后核）

1. **提示隐藏**：再遇解析失败，会话里只见 `AUTO_CONTINUED: …N 条调用。`，不再见
   `TOOL_CALL_UNPARSED:` 全文；模型侧仍收到完整再教学提示（reply-log `auto-continue reply` 可查）。
2. **文件投递**：整段重建那一轮发出去的文本 = `~/.dsh/webcode/sessions/<key>.md` 的正文
   （可逐字对比）；`prompts/<site>.md` 头部与正文之间有空行。
3. **节流窗**：日志写「60 秒」量级的剩余窗口，与 `sessionRebuildThrottleMs` 默认值一致。
4. **新开对话可归因**：`GET /__webcode/status` 的 `driver.freshReasons` 直接给出各真因计数；
   日志里每行 `fresh web chat (reason=…)` 可与之一一对应。

### 六、§0.16.28 归因复核（用户问题 2 / 问题 4 的证据补全）

会话 `session-4f236a51` 的 `session.v3.jsonl.zstd` 逐帧解压（**133 帧**；`zstdDecompressSync`
只解第一帧，这正是此前「spliced=0」误判的成因），930,247 字符、266 行，逐字取得：

```
seq 29: agent/inbox/spliced target=next-turn start=0 inserted=[<goal_round> Round: 1/256] source.kind=goal
seq 31: agent/inbox/spliced target=next-step start=0 removedCount=1
seq 32: agent/inbox/spliced target=next-turn start=0 removedCount=1
seq 169 / 188: … start=0 inserted=[Round: 2/256] / [Round: 3/256]
```

**结论：0.16.28 的根因叙述成立**——goal 自动化每轮确实对 `next-turn` 做 `start=0` 的插入/移除，
即消息数组头部增删，与「已发前缀整体指纹必然失配」的推断逐字吻合。§0.16.28 的归因从
「推断」正式升格为「已取证」。

### 七、装机命令（用户在终端执行；沙箱不允许写 `~/.dsh/profiles`）

打包已完成：`package/dsh-webcode-bridge/dsh-webcode-bridge-0.16.29.tgz`（471,936 字节，
`verify-pack` 39/39 逐字相同 + 接线完好）。剩三步：

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge

# 1) 装入两个 profile（脚本先删旧目录再解包，免疫 pnpm「同版本不重解」）
node scripts/install-profiles.mjs

# 2) 关键：同步**声明**。install-profiles 只写 node_modules，不改
#    package.json / pnpm-lock.yaml —— 声明不跟上，任何一次 pnpm 通道
#    （dsh plugin / dshmarket / 启动期 reconcile）都会静默回退到旧版本。
#    真机踩过三次（见 §0.16.10 七）。两个 profile 都要：
dsh plugin --profile web add package/dsh-webcode-bridge/dsh-webcode-bridge-0.16.29.tgz
dsh plugin --profile headless add package/dsh-webcode-bridge/dsh-webcode-bridge-0.16.29.tgz

# 3) 核对（应当两行都是 0.16.29）
foreach ($p in @('web','headless')) { $j = "$env:USERPROFILE\.dsh\profiles\$p\node_modules\dsh-webcode-bridge\package.json"; "$p = " + (Get-Content $j -Raw | ConvertFrom-Json).version }

# 4) 重启 dsh web（会断开当前 GUI 会话，刷新页面接回）
```

重启后核 §五 的四条真机判据。

### 八、验证

- 全量测试：**67/67 测试文件通过，退出 0**（新增 `prompt-store` 读回 4 条、
  `session-continuity` ⑩ 文件投递哨兵 + ⑪ fresh 逐因 2 条，并更新 5 个受契约变更影响的文件）。
- 注释闸门 error 0 / warn 0；`check-repo-hygiene.mjs` PASS；`check-ledger.mjs` PASS。
- 真机附件探针（`POST /__webcode/attach-probe`）：`ok:true, evidence:"text:webcode-probe.md"`。

---

## 0.16.28（2026-09-20）—— 会话游标内容锚定 + 节流改等待重建 + 提示词落盘 + 附件自愈

**用户指令（逐字）**：「1.怎么做到传输文件？参考已有插件dsh-drop-caret？将提示词保存为本地的单独文件-每个网址一个，然后每轮发送过去，然后是每轮会话单独本地地址--如果新开会话-web端，就一样把这个当上下文通过文件发送！ 2.为什么网页会话会被随机重开？然后就死循环导致无法继续会话！被前面好心只是想要提醒而不是中断的提示内容完全打断！请你参考已有协议自动化以及官方的自动化流程优化这里的逻辑！」（只看 DeepSeek；先确认路线再执行）

### 一、取证：两问同源，根因在会话游标（真机日志逐字核实）

会话 `session-4f236a51`（2026-09-20 01:29–01:31）的 reply-log + 会话 jsonl 帧取证：

1. **DSH goal 自动化**（`<goal_round> Round: 2/256…7/256`）每 30–60 秒自动续一轮；
2. 宿主信箱机制每个 turn 把 goal 提示**拼进消息数组头部**（`agent/inbox/spliced` start=0
   inserted=1）、turn 结束**从头部移除**（removed=1），本会话各 12 次；
3. 桥的会话游标是对「已发消息前缀」做**整体哈希**（lib/index.js buildTurn fingerprint）。
   头部一有增删，已发前缀窗口内容整体位移，哈希必然失配 → 判 fresh → 要求**整段重建**
   （重放 245,486 → 251,726 字符逐轮膨胀、每轮开新网页对话）——用户看到的「网页会话被随机重开」；
4. 30 秒节流窗（0.16.6）把第二次重建拦下，SESSION_SWITCHED 提示**当正文交回**——agent
   循环把纯文本轮当最终答复收场，goal 轮被空转烧掉 30 秒、任务零进展——「被好心提示完全打断」。
   该会话 reply-log 里 **52 次 SESSION_SWITCHED**，与真实工具轮交替出现。

### 二、修法（四条，全在桥侧）

| # | 修法 | 落点 | 护栏 |
| --- | --- | --- | --- |
| A | **会话游标内容锚定**：指纹拆两层——「契约指纹」（模型/系统提示词/工具名集合/extraPrompt，变了才重建，0.16.4 的名字集合修正原样保留）+「内容锚」（已发尾部 6 条消息哈希；失配时从尾部逐条丢弃做连续段匹配，命中即重定位游标**续同一网页会话发增量**，找不到才回落重建）。头槽轮转、历史尾部删改从此不再触发重建；匹配取最后一次出现 + 段长 ≥2 压误配风险；len-2 锚（会话第 2 轮）有窄域单条救援 | 新 `lib/session-anchor.js`（messageHash/contractFingerprintOf/reanchorSent）+ buildTurn/sessionState/commit | `test/session-anchor.test.mjs` 7 条（纯函数 5 + 行为级 2：goal 头槽轮转不得 fresh、历史被改写必须 fresh） |
| B | **重建节流改等待重建**：撞 30/60s 节流窗时，本轮内 `sleepSignal` 等完剩余窗口后照常重建并交回**重建轮的真实回复**；提示只在 abort 兜底（relay 在调用方 abort 时先 reject，executor 的提示返回本就到不了调用方——它的价值是「中止后绝不发起重建发送」的资源护栏）。节流记录时间戳在等待后刷新 | `lib/index.js` executor WEB_SESSION_LOST 分支 | `session-continuity.test.mjs` ⑥ 重写为「等完窗口→重建→交回重建内容→游标正常前进」，新增 ⑥b「abort 收场且第 4 次发送绝不发生」 |
| C | **提示词落盘**：`~/.dsh/webcode/prompts/<site>.md`（站点教学/协议全文，fresh 首轮逐轮覆盖）+ `~/.dsh/webcode/sessions/<sessionKey>.md`（该会话最近一次首轮/整段重建全文，重建点同步落盘）。借 dsh-drop-caret 的消毒/隔离模式（token 白名单、`::` 折叠、防穿越），借 reply-log 的测试进程守卫与静默失败纪律。`dir:'off'` 显式关闭。这是 D 的投递源：无论 inline 还是附件，磁盘上必须有「这一轮真实发了什么」的正本 | 新 `lib/prompt-store.js` + buildTurn fresh 分支 + executor 重建分支 | `test/prompt-store.test.mjs` 6 条 |
| D | **附件零回复自愈降级**（0.16.7 台账「仍未做 §2」挂账的理想形态）：该轮真走了附件且正文/思考/图片全空（emptyWebResponseError 判定，与 0.16.7 真机签名同源）→ 按站点记录运行期禁令（进程生命周期，重启清零=自然复验），promptTransportPlan 与 status 立即回落 inline；status 新增 `attachForbiddenStatic`/`attachBlocked` 两格把「为什么这站不走附件」拆开可查。**静态禁令表不动**——deepseek 的解除必须先真机复验（见 §五） | `lib/browser-driver.js`（DYNAMIC_ATTACH_BLOCKS/markDynamicAttachBlock/attachForbiddenFor） | `test/attach-selfheal.test.mjs` 5 条 |

连带（E）：自动续跑提示加**框架前置**——`[桥·系统提示] 本条是桥发出的自动化续跑提示，不是用户发言：不要回应、解释或复述它…`。真机里模型会停下来「回应提醒」而不是「按提醒行动」；协议段（transportNoteFor）保留不动——0.16.25 的红线（续跑轮格式指引必须与首轮逐字同源）优先于省字符。护栏：auto-continue.test.mjs 新增 2 条断言。

### 三、明确不做的（与用户确认过的边界）

- **「每轮发送过去」收窄为「首轮/重建时落盘、超阈值时附件投递」**（用户在四问确认中选择的语义）：普通增量轮保持短文本 inline；漂移再教轮保持 inline——它只有 2–4k 字符且有 0.16.25 红线保护，附加上下文反而多一次「附件不被读」的风险面。
- **deepseek 不移出静态附件禁令**：必须先真机复验（`POST /__webcode/attach-probe` 只传不发 + 受控实发一轮），复验通过才解除；自愈判据（D）是解除后的安全网，不是解除的替代。

### 四、验证

- 全量 `pnpm test`：**782/782 通过**（67 个测试文件，退出 0）。
- 注释闸门 error 0 / warn 0；`check-repo-hygiene.mjs` PASS；`verify-pack` 39/39 逐字相同 + 接线完好。

### 五、DeepSeek 附件真机复验（2026-09-20 02:5x，`dsh web` 已重启加载 0.16.28 实测）

| 步骤 | 读数 | 结论 |
| --- | --- | --- |
| `GET /__webcode/status` | `build.version=0.16.28`、`attachForbiddenStatic` 读数在场 | 新版加载确认（新读数字段生效） |
| 连接 + `POST attach-probe` | `ok:true, evidence:"text:webcode-probe.md"`，DOM 出现附件卡 | 上传通道完好（只传不发） |
| 受控实发 ①（62,496 字符，transport 当时=inline） | **回复 `ATTACH_VERIFY_MARKER_7281=42` 逐字命中**，`lastEndReason=finished` | 62.5k 级 inline 投递健康；也说明用户此前把投递形态设成 inline 后长文照常可达 |
| 受控实发 ②（同文，transport 切 attach） | `attachTransport={transport:'attach', evidence 命中, 62,596 字符, truncated:false}`，**240s 整轮超时、页面零回复文本**（`lastEndReason=timeout`） | **0.16.7 结论维持：DeepSeek 附件「传得上、不读、不回」**。静态禁令不解除 |
| 复验后收尾 | 设置 `promptTransport` 已恢复用户原值 `inline`；实验补丁清除、以正式 tarball 重装两 profile、`dsh web` 重启后 `attachForbiddenStatic:true` | 现场无残留 |

**复验的副产品——自愈判据补了第二个签名**：实发 ② 的零回复走的是**整轮超时**路径（不经 `emptyWebResponseError`），运行期禁令最初没触发。已在超时处理器补位：附件轮 + 超时 + `replyChars===0`（页面真无回复）→ 记运行期禁令；`captureAlive 但 replyChars>0`（页面有字未回传）是捕获/回传问题，**不**降级。护栏：attach-selfheal 第 5 条（源码结构钉子）。

**遗留（下一版候选）**：① DeepSeek 将来修好附件解析时，解除路径 = 真机复验通过 → 从 `ATTACH_FORBIDDEN_SITES` 删 'deepseek'（运行期自愈兜底）；② 「漂移再教轮带附件」因附件通道不可用（deepseek）暂缓；③ 会话文件（C）目前是落盘正本与排障来源，真正当**投递**附件用要等某个附件可读站点（如 GLM）先跑通「新会话=发上下文文件」链路。

### 六、真机判据（重启 `dsh web` 后核）

1. **重建风暴熄灭**：goal 自动化长跑里 `GET /__webcode/status` 的 `sessionSwitchNotices` 不再增长，navTrace 无连续 `fresh`，DeepSeek 侧栏不再逐轮新增对话；
2. **节流窗内不再出现 SESSION_SWITCHED 提示**：即便撞窗，本轮也会等完窗口后重建并交回真实回复（日志应见 `本轮内等完剩余窗口后照常重建`）；
3. **落盘可查**：`~/.dsh/webcode/prompts/deepseek.md` 与 `~/.dsh/webcode/sessions/<sessionId>__.md` 存在且与 `/__webcode/preset` 同源；
4. **附件自愈**：若某站点附件轮再现「传得上、零回复」（空结果或超时零回复两条签名），日志应见 `auto-degraded: this site stays inline until the bridge restarts`，且 status `attachBlocked` 有现场；下一轮自动 inline 不再白传；
5. **DeepSeek 附件禁令维持**：`attachForbiddenStatic:true`（复验结论见 §五）；62.5k 级 inline 长文投递可达（复验实发 ① 逐字命中标记）。

---

## 0.16.27（2026-09-19）—— 三处「文本告知即断链」出口全部接通自动续跑

**用户指令（逐字）**：「请你参考官方 Harness完善自动化流程序，尤其是意外错误工具调用引起的-web 端调用技能因为是文本告知会有偏移！」

### 一、发现：同一种病有三处出口，只修了两处

0.16.25 修了 UNPARSED、0.16.26 修了 thinking-only，但第三处 **TOOL_UNKNOWN**
（模型调了本会话没有的工具名 / 把教学骨架的占位名当真）仍是旧行为：
交回「可用工具清单 + 官方模板」后 `emitText` 以 `finish='stop'` 收场 —— **循环已停**，
模型没有下一次机会改。用户点名的「意外错误工具调用…文本告知会有偏移」正是这一支。

### 二、修法（与既有两处逐字同型）

`lib/index.js` 的 TOOL_UNKNOWN 分支接上同一套 `autoContinueRound`：把提示补发进
**同一个网页会话**收第二轮 —— 解析出真实工具名的调用就照常派发
（`finish=tool-calls`，**循环存活**）；有散文按最终答复收场；两头落空才回落旧的 `emitText`。

至此三处出口行为一致：**任何「交回文本让模型改正」的分支，都先把改正机会真正发出去。**

护栏：`test/zero-progress.test.mjs` 新增「TOOL_UNKNOWN 必须自动续跑」。

### 三、验证

- `pnpm test`：**762/762 通过**（64 个测试文件，退出 0）。

---

## 0.16.26（2026-09-19）—— 等待读数不跳变 + thinking-only 不再断链

**用户指令（逐字）**：「审查现在的等待发送计时逻辑，为什么我看是跳的？具体例子：1-8s缓慢增长正常，然后跳到两分钟多少秒」「请你解决deepseek的这类吧问题，让会话deepseek能够长期跑」。

### 一、等待读数跳变（真根因：两个不同的量拼在一枚药丸里）

**症状**：药丸从 1 s 缓慢涨到 8 s，然后**一跳**到「2 分多」。

**根因**（lib/wait-stats.js 的 composerWaitPillLabel，0.16.24 引入的语义切换）：live 与账本被当成两个可互换的显示源 —— 等待期间显示 liveWaitLabel「这一轮等了多久」，等待一结束 recordWaitMetrics 清掉 live，回落到 s.totalWaitMs「本会话一共等了多久」。**两次读数都真，但它们不是同一个量**，拼接处就是那个假跳变。

**修法**：读数改为**一个来源的连续投影** —— s.totalWaitMs + liveWaitMs(live, now)。等待中逐秒增长；等待结束账本已被本轮结算补上、相加项归零，**读数不变**。新增纯函数 liveWaitMs。面板「正在等待发送」那一行仍只给在途增量，不受影响。

护栏：test/wait-stats.test.mjs 三条（投影值 15 s 而非旧 3 s、**等待结束瞬间读数连续** during === settled、续等 baseMs 连续）；连带更新 test/control-routes.test.mjs 的药丸断言。

### 二、thinking-only 断链（deepseek 长跑的真阻断点）

**症状**（本轮会话内**真实复现**）：THINKING_ONLY_NO_ANSWER，收束原因 partial-wip-settled —— 会话就此停住。

**取证**：~/.dsh/logs/webcode-bridge-replies.log 里那一轮是 chars=0 | calls=0（session-181c23b1，2026-09-19 15:17:46）。WIP 稳态收束在模型**刚想完、还没落笔调用**时把这一轮截断。

**根因**：这与 0.16.25 修的 UNPARSED 是**同一个病** —— 交回纯文本提示后 agent 循环当最终答案收场。0.16.25 只给 UNPARSED 出口接了自动续跑，thinking-only 出口漏了。

**修法**：lib/index.js 的 decision === 'thinking-only' 分支接上同一套 autoContinueRound：把提示补发进**同一个网页会话**收第二轮 —— 解析出调用就照常派发（finish=tool-calls，**循环存活**）；有散文按最终答复收场；两头落空才回落旧行为。红线沿用 0.16.25。

### 三、思考通道落盘（归因第四次断链的补链）

0.16.17 的原始回复日志**只记正文通道**，上面那种轮次在磁盘上只剩「这轮是空的」。现在 thinkAcc 非空时同样落盘（note: 'raw thinking, verbatim'）。

护栏：test/zero-progress.test.mjs 新增「thinking-only 必须自动续跑」；既有的「必须发归因提示」改为扫**整段分支**（续跑两个出口落空后才 emitText，窗口不能再切 400 字符）。

### 四、验证与交付

- pnpm test：**761/761 通过**（64 个测试文件，退出 0）。
- verify-pack：逐字相同 37/37 + 接线完好。
- 打包 dsh-webcode-bridge-0.16.26.tgz，装入 **web + headless** 两个 profile，并同步两处 package.json 声明（否则 pnpm 通道会静默回退，见 §0.16.10 七）。
- 装机核对（逐项在场）：liveWaitMs 导出 / projectedMs 投影 / auto-continued after thinking-only round / raw thinking, verbatim，两 profile 均 ✔。
- **需重启 dsh web 才生效**。

### 五、真机判据（重启后核）

1. 药丸在等待开始与结束的**瞬间数字连续**，不再出现「1→8 s 后跳 2 分多」。
2. 再遇 partial-wip-settled 截断时会话**不再停住**：应看到 AUTO_CONTINUED 且随后有工具调用继续执行。
3. 若仍停住，reply log 里应同时有 note=raw reply 与 note=raw thinking 两条记录可离线归因。

---

## 0.16.23（2026-09-19）—— DSML 协议退役（只留备份）+ 站点图标半成品接手做绿

**用户指令（逐字）**：「请你查看git分支意图！然后继续！删除dsml，这个协议只备份！然后记录！正式使用完全按照官方来！！」「确保是全面去除影响，全面实现官方适配deepseek以及harness！一定再检查是否根处解决！」

### 一、DSML 退役（根处方案，不是再加容错）

战略转向：0.16.18–0.16.22 追形状式宽容（官方 token 容错 + DSML 词形链）在 0.16.22 取证
证明**追不完**（40 条失败中 32 条是新一代 DSML 斜杠闭家族）。0.16.23 起：

| 环节 | 0.16.22 | 0.16.23 |
| --- | --- | --- |
| 教学 | 官方模板（0.16.18 已切） | 官方模板（不变，唯一格式） |
| 解析 | 官方改写 + DSML 词形链（剥标记/补括号/参数简写/熔接标签六条 replace） | **只保留官方改写**（`normalizeDsml` 收缩改名 `normalizeOfficialToolCalls`） |
| 修复 | `lib/dsml-repair.js` 无名闭合/缺开标签栈式还原 | **删除文件**（两个真机形态都是 DSML 教学时代产物；官方模板参数体是裸 JSON，无 parameter 可闭合） |
| DSML 教学常量 | `dsmlSkeleton`/`DSML_ONE_LINE` 留而未用 | **删除** |
| 锚点/扣留 | DSML 锚供改写 | **保留**——退役 ≠ 撤哨：DSML 词形唯一入口变成「扣留防泄漏」，0 calls 走 TOOL_CALL_UNPARSED 自动再教官方格式（0.16.19 机制） |
| 恢复派发 | DSML 块里能读出只读调用就代派发 | **DSML 形状不恢复**——恢复派发给漂移形状发「奖励」，模型永远收敛不到官方格式；恢复层继续服务在役形状（半角 invoke 残片、mcp_action 围栏、glm 协议） |

**备份**：分支 `backup/dsml-protocol`（= 0.16.22 逐字）+ git 历史；退役前的词形链证据
（063b0a99 155 处 DSH 畸形逐码点读数、probe-marker-variants 枚举、夹具 13/7）都在其中。

**为什么这是根处解决**：漂移被奖励（宽容解析成功/恢复派发成功）→ 模型没有信号要改；
退役后 DSML 形状**零收益**（扣住不执行 + 自动再教官方）→ 唯一出路是官方格式。预期真机
表现：切换初期 UNPARSED 通知上升（模型还在漂），随后官方形状占比收敛。

### 二、站点图标 + 一级选择框（接手 15:00 网页会话半成品，分支意图）

wip/web-session-site-picker 的意图（ SITE_ICON_TIER 档位表 + SitePicker）：
DeepSeek 用官方 FishLogo 矢量（primitives 自带，零新增资产）；其余站点如实标
「官方矢量未找到」画文字标记（**不用第三方图集冒充官方**，brand-icons-research §4.1
B 档留补件入口）；站点栏 tab 加图标 + Ctrl/⌘ 点击分屏交接 sid（修「分屏得到两个
DeepSeek」）；未初始化首屏加 SitePicker。

接手时它还差三块（0.16.21 误打包事故的后半段）：
1. **防御回退解构**：网页会话 15:16 那条「defensive fallbacks」edit 恰好解析失败没执行，
   无回退解构 + 测试桩缺导出 → 6 条 client-render 崩。本版补上（回退语义 = 降级不白屏：
   缺图标导出 → 空组件/官方真实 viewBox/no-op，旧版 primitives < 0.1.6 也可用）。
2. **测试桩补齐**：primitives 桩按真机 0.1.6-alpha.2 契约补齐五个导出。
3. **两条新钉子**：档位说明进 title（official/missing 如实）+ 缺导出降级不白屏。

### 三、测试

- 删 4 个 DSML 宽容回归文件：`dsml-native-close`、`dsml-param-shorthand`、
  `dsml-real-drift-2026-09-19`、`dsml-real-reply-regression`（夹具与逐字断言都在备份分支）。
- 退役钉子：`regression`（2026-09-10 真机第 2–6 跑六形状 0 calls + 扣留 + 不恢复派发；
  死壳内在役 mcp_action JSON 仍收——壳不加分）、`marker-typo`（整文件翻转为退役语义，
  反向安全线逐字保留）、`protocol-leak`（SHAPES 分在役/退役两组）、`official-tool-calls`
  （备案不回归 → 退役不回归）、`recovered-dispatch`（夹具换半角在役形状 + DSML 不恢复钉子）、
  `parse`（形态一致断言 → 逐字原样通过 + 锚点仍认）。
- 夹具换在役形状：`markdown-block-integrity` / `markdown-whitespace` 的调用素材从 DSML
  换官方 token（这两个文件测块完整性/空白保真，与协议形状无关）。
- `client-render` +2 钉子（档位说明、缺导出降级），桩补齐导出。
- `markdown-whitespace`/`markdown-block-integrity` 不再引用 `MARK` 常量者已清理。

### 四、连带修正

- `findProtocolStart` 的 markdown 敏感锚点排除从**下标**（`i !== 3 && i !== 5`）改为
  **按 source** 判断——锚点数组增删条目时下标是隐形耦合（删一条 DSML 锚就会错位漏过围栏）。
- `normalizeDsml` 全部 21 处引用（lib 2 处 + test 若干）改名为 `normalizeOfficialToolCalls`。

### 五、真机验收判据（重启后）

1. `GET /__webcode/preset` 教的仍是官方模板（DSML 零提及）；
2. 让模型复述一个 DSML 形状示例（散文）→ 不执行、正文外发长度停在锚点、
   下一轮收到 TOOL_CALL_UNPARSED + 官方格式再教学；
3. 官方格式调用照常执行（回归）；
4. 右栏站点栏出现图标（DeepSeek 官方鲸鱼、其余文字标记），title 有档位说明；
5. 未初始化首屏出现站点选择框；Ctrl/⌘+点击站点 tab 新分屏落在被点的站点。

## 0.16.22（2026-09-19）—— 上下文计算三修 + 工具调用残余失败取证（reply-log 全量重放）

**用户指令（逐字）**：「1.请你修复：上下文计算可能有的问题 2.请你查看最近的dsh会话！看下：为什么用的官方工具格式！但是比起官方api现在这个老是出问题？工具调用不行？长上下文？是他那里还是我这里问题？？快速不更改！」

### 一、上下文计算修了什么（对照官方 deepseek-harness token-meter 结论）

官方链路（`reference/deepseek-harness` 的 `contextPressure` 投影 + `ContextMeter`）：分子优先
provider 真实 usage 样本（不含输出），分母来自路由注册容量；网页桥拿不到真实 usage，分子只能
由桥上报、分母由桥声明。三处修复：

| # | 问题 | 落点 | 修法 |
| --- | --- | --- | --- |
| ① | 预算闸按 `chars × 0.7` 平铺折算——CJK 档密度套在英文/代码/JSON 主体上，高估近 3 倍，长英文轮被**误拒** `CONTEXT_WINDOW_EXCEEDED` | `lib/metrics.js` `checkContextBudget` | 改收 `text` 原文，内部直接走 `estimateTokens`（CJK 0.7 / ASCII 0.25，自带 +10% 余量，不再双重加成）；`assertContextBudget` 传原文 |
| ② | `contextWindowFor` 把模型自带 `context` 排在 `cfg.contextWindowBySite` 之前，而内置模型全部声明了 context → 设置覆盖**永远不生效**，报错里「在设置里调大窗口声明」是空头支票 | `lib/index.js` | cfg 提到最高优先级（「运维覆盖」语义本就如此） |
| ③ | 累计分子只算「已发出去的文本」，网页会话的真实上下文还含**每轮助手回复**（增量序列化刻意不发它们）→ 官方圆环/GUI 上下文表系统性低估 | `lib/index.js` buildTurn | 会话条目新增 `outTokens`：`finishChunks`/`emitText` 收尾经 `noteOutput()` 累计输出估算，`usageInput()` = 已发累计 + 输出累计；fresh 重建开新网页会话时归零；`commit()` 重建条目必须延续 `outTokens`（两种时序都对） |

**没动的**：deepseek/glm 声明的 1M 乐观窗口本身——那是「声明偏大 → DSH 压缩不触发 → 由
预算闸 + PROMPT_TRUNCATED 兜底」的既定取舍，调小要真机校准，不在本轮。

### 二、工具调用残余失败取证（第二问，只查不改）

方法：`~/.dsh/logs/webcode-bridge-replies.log` 全量 452 条 → 40 条「有工具 token 但 calls=0」
→ 用**当前（0.16.21）解析器**原样重放全部 40 条。结论：**8 条现在已能解析（run-10 修复生效），
32 条仍失败，且 32 条全部含 DSML 斜杠闭 token**。

按天：09-18 失败率 28/188 ≈ 15% → 09-19 12/264 ≈ 4.5%（在降，但没归零）。
最新会话（`session-375c497c`，本地 15:01–15:16，36 条中 5 条失败）逐条重放：

| 形状（模型漂移） | 例（本地时间） | 当前解析器 |
| --- | --- | --- |
| **DSML 斜杠闭**：官方 begin + `</｜｜DSML｜｜ parameter>` 收参、`</｜｜DSML｜｜ calls>` 收块（闭 token 以 `>` 结尾、非 `｜>`，且带 `/`） | 15:12（9996 字符大 edit，begin 完全规范，仅闭 token 漂移）；15:16（`<｜｜DSML｜｜ calls▁begin｜>` 开 + DSML 闭） | **仍失败**（31 条主家族） |
| **双 begin**：`calls▁begin`⏎`call▁begin` 或 `call▁begin`⏎`call▁begin`（外层多写一个 begin，内层调用本身规范），收尾 `call▁end` 也双写 | 15:13、15:14、15:15 | **仍失败**——0.16.20「禁止 begin 类 token 起配」让外层起配失败后**不重试内层**，整条放弃 |
| token 内斜杠闭 `</｜tool▁call▁end｜>` + `calls▁begin` 逐条起配 | 凌晨 04:55 ×3、05:56 | **已恢复**（0.16.20 容错覆盖） |

**归因（「他那里还是我这里」）**：两边都有。**他**（DeepSeek 网页服务栈）：同一模板教下去，
网页侧采样出的 token 词表混入内部 DSML 词汇（`｜｜DSML｜｜`），begin/end 双写——官方 API 走
原生 tool_calls 字段、根本不过文本协议，所以「官方 API 没这毛病」。**我**（桥解析器）：32/40
残余失败集中在「DSML 斜杠闭」一族 + 「双 begin 后不重试内层」，两条容错都不难加（收参/收块锚点
加 DSML 斜杠形；begin 类起配失败后从下一个 token 重扫）。**与长上下文无关**——失败与回复长度
相关（长 edit 更容易漂移、9KB 大调用更显眼）但不是窗口溢出；04:55 的失败是 273 字符的小调用。

**本轮不改**（用户明示）：上述两条容错留待下一版，取证已钉在 test 夹具可用的逐字形状上
（reply-log 条目可直喂 `parseAgentReply`）。

### 四、连带事故与恢复：0.16.21 误扫入网页会话半成品（2026-09-19 15:14）

**事故**：15:00 DSH 会话（`session-375c497c`）正由网页 AI 实施第三步（站点图标+一级选择框），
编辑**直接落在工作树**；15:14:56 本会话推送 0.16.21 时 `git add -A` 把当时**未完成**的
231 行一并扫进了 a3ae211（tag v0.16.21）——已发布的 0.16.21 里 client.cjs 含半成品，
`client-render` 6 条失败。前一会话留下的「784 条绿」结论在网页会话开始前成立，
被 15:01 起的并发编辑作废，而打包在前、失败在后。

**恢复**：以 **已装 profile 的 0.16.21 正本**（`~/.dsh/profiles/{web,headless}/node_modules/
dsh-webcode-bridge/lib/client.cjs`，打包于网页会话开始前，SitePicker 引用 = 0）回写工作树，
`client-render` 恢复 35/35。网页会话完整半成品（15:16 状态）保全在分支
`wip/web-session-site-picker`（d0145bb）。

**教训**：桥的网页会话与本仓库共用同一工作树，**任何 `git add -A`/提交前必须先查
`git status` 是否出现非本会话的改动**（尤其 client.cjs）；这一点已记入操作纪律。

### 五、测试

- `test/context-budget.test.mjs`：全部改按 `text` 口径重写；新增「英文/代码主体不再被 CJK 档高估」钉子（10000 ASCII 字符 ≈ 2750 token，旧实现 ≈ 7700 会误拒）；「折算与 estimateTokens 严格同源」升级为逐字相等（混合构成也不例外）。
- `test/regression.test.mjs`：累计口径测试的网页回复改长（120 字符），新增断言「分子必须把上一轮回复也算进去」（旧实现 u2 = u1 + 增量，新实现 u2 ≥ u1 + 回复估算）。

## 0.16.19（2026-09-19）—— run-9 占位符照抄事故：教学示例改真实工具名 + 围栏示例守卫 + TOOL_UNKNOWN 自动再教学


**用户指令（逐字）**：「？？？你提示词还没有改啊！我想要出现这个时候自动返回提示词！好让会话继续！」

### 一、run-9 取证（0.16.18 验收轮，`session-897d07bb`，reply-log 逐字）

用户问「官方怎么做」，模型回答时把 0.16.18 教学骨架**原样抄进 ``` 代码块**举例
（骨架占位名是「工具名 / 工具名二」），桥把围栏里的占位名当真执行 → 2 次
TOOL_UNKNOWN。模型下一轮自己道破：「占位符不是调用，只有真实工具名才会执行」，
并学会用 `_` 代替 ▁ 自保——教学缺陷与解析缺陷各占一半。

### 二、修了什么

| 改动 | 落点 | 说明 |
| --- | --- | --- |
| 教学示例改**真实工具名** | `officialCallExampleFor(tools)` / `officialToolCallSkeletonFor(tools)`；buildPreset、serializeFirstTurn transport、trainNoteFor（新增第三参 tools，三个调用方都传入） | 示例名+参数样例取自会话工具表（required 优先，number→1/boolean→false/array→[]/其余→"…"）；占位符只在无工具表的纯测试场景兜底 |
| **围栏示例守卫** | `parseAgentReply` invoke 扫描 | 已配对 ``` 区内的 invoke 一律视为示例不执行（真机逐字夹具 `official-echo-1-run9-fenced-template.txt` → 0 calls）；未配对 ``` 保守不守卫（宁可执行示例也不吞真调用）；参数值内嵌 ``` 的 write（fence-nested-call 家族）不受影响——判据只看 invoke 起点 |
| **TOOL_UNKNOWN 自动再教学** | `lib/index.js` | 通知自动附官方模板示例（真实工具名）+ 点名「骨架占位符/文档示例不是调用」——用户要求「出现时自动返回提示词，好让会话继续」；UNPARSED 重发指引同步改真实工具名 |

### 三、护栏

`test/official-tool-calls.test.mjs` 9 条（新增 run-9 围栏夹具 0 calls、骨架真名、
未配对围栏边界、参数内嵌围栏不受影响）；全量 774 条绿。

### 四、装机与验收（用户执行）

打包装机流程同前；验收判据：① 再问「官方怎么做」类问题不再触发 TOOL_UNKNOWN；
② 万一触发，通知自动带正确格式示例、会话继续；③ reply-log 全文照常落盘。

## 0.16.18（2026-09-19）—— 教学切官方 tool-call 训练模板（DSML 转备案），无参调用修复

**用户指令（逐字）**：「战略实验：把教学格式换成/并测 DeepSeek 官方训练先验的 tool-call 模板
（<｜tool calls begin｜> 家族），可能从根上止血——直接改复刻！这个保留成备案不删除
只是现在新增官方做法优先」

### 一、官方模板逐字依据（不是推测）

HF `deepseek-ai/DeepSeek-V3.1` tokenizer_config.json 的 chat_template（2026-09-19 核对）：
`<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>NAME<｜tool▁sep｜>{ARGS}<｜tool▁call▁end｜>…<｜tool▁calls▁end｜>`
（连接符 U+2581 ▁、竖线 U+FF5C）。这是模型**被训练时见过的形状**；0.16.2 起教的 DSML
在官方仓库 grep 全库 **0 命中**——模型对它无先验，长跑必然持续漂移。

### 二、修了什么（DSML 全套宽容一字不动，教学改指官方形状）

| 改动 | 落点 | 说明 |
| --- | --- | --- |
| 官方模板常量与示例（`officialToolCallSpecimen/Skeleton`） | `lib/agent-preset.js` | 教学与 UNPARSED 重发指引共用一份 |
| 官方 → 规范 invoke 形改写 | `normalizeDsml` 首步 | 全调用段收编 + 孤立 calls 包裹映射；旧代空格词形、`function` 前缀、```json 围栏漂移都收；恢复层/流式探测三层受益 |
| 协议锚点 + 流式前缀补官方家族 | `PROTOCOL_ANCHORS`、`partialProtocolAt` | 红基线：0.16.17 代码对官方模板 0 calls 且 proseSafeEnd=全长（整段漏正文）——锚点是先决条件 |
| **无参调用不再整条丢弃** | 主解析 takeObj 条件 | run-8 FAIL#3/4/5 真机逐字形状（cordis_inspect_list，properties:{}）连续 3 次被丢；收紧条件=名字非空 + 非包装壳 + 体为空/完整 JSON |
| deepseek 站点三处教学同形状 | buildPreset / serializeFirstTurn transport / TRAIN_NOTE | DSML 教学文本全部退役（git 历史留档），解析备案保留 |

### 三、护栏（`test/official-tool-calls.test.mjs` 7 条全绿）

官方单调用/多调用/旧词形+前缀+围栏/无参两种形态/教学骨架自洽/DSML 备案不回归/
两种格式同轮混写；`glm-session-replay` 的 deepseek 三格断言同步切官方。

### 四、装机与真机验收（用户执行）

- 打包 `dsh-webcode-bridge-0.16.18.tgz`（verify-pack 39/39），走 `dsh plugin add`
  声明持久层通道装 web + headless；逐 profile 核对三处声明 + sha256。
- **验收判据（战略实验）**：同任务重跑，对比「UNPARSED/isError 次数」与 0.16.15–0.16.17
  轮（每轮 4–9 条）——官方模板下漂移族应显著下降；`~/.dsh/logs/webcode-bridge-replies.log`
  照常全文落盘，模型若仍回退 DSML 备案形状，逐字夹具继续反哺。

## 0.16.17（2026-09-19）—— 网页原始回复全文落盘：取证断链第三次后的补链

**用户指令（逐字）**：「刚才这个又是怎么回事》？有无保留原接收内容日志？没有请你新增」

### 一、run-8 取证（0.16.16 真机验收，`session-0fd32761`，04:08–04:56）

99 次调用、2 isError、**4 次 TOOL_CALL_UNPARSED（扣留 693/1003/1470/1474 字符，
四种形状全部不同）**、0 恢复派发：

| 时间 | 扣留量 | 头 200 字符可见的形状 |
| --- | --- | --- |
| 04:24:01 | 693 | 读 `dsh-client-ui-conversation` 类型文件；畸形在 200 字符之外 |
| 04:27:24 | 1003 | `client.cjs` 参数正常闭合、下一参数开标签正常起头；畸形在 200 之外 |
| 04:28:08 | 1470 | `<invoke>` 后出现 `parameter name="pwsh">`（参数名写成工具名）再接 `command` |
| 04:56:28 | 1474 | edit 调用：`file_path` 完全正常，其后 `<｜ olds_string`——简写漂移（夹具 15 同族）**且参数名拼错**、old_string 值是含 `<` 的代码（0.16.12 改写的安全线「值内不得再出现 `<`」在此拒绝改写） |

2 条 isError 均 `missing required property "file_path"`（read 只带 limit/offset）——
`TOOL_ARGS_MISSING_REQUIRED` 同族在 0.16.16 后仍以新形状复现。

### 二、根因（运维侧，不是解析侧）

**四种形状的 1474/1470/1003/693 字符全文在磁盘上都不存在**。0.16.13 的
「扣留全文进日志」走 `console.warn`（lib/index.js `warn`）→ DSH 进程 stderr →
运行时不持久化。会话存档只有提示里那 200 字符头。归因第三次断链
（15/16 只存头 200 → 19/20 靠残片重构 → run-8 连重构依据都没有）。

### 三、修法（`lib/reply-log.js` + `lib/index.js` 接线）

- 每轮收尾（`parseAgentReply` 之后、分支之前）把**原始回复全文**（未归一化、未截断）
  追加到 `~/.dsh/logs/webcode-bridge-replies.log`：头行定界 + 时间/会话/字符数/调用数，
  尾行定界；超 10 MB 轮转一代 `.1`；
- 写失败静默返回 null，绝不影响回合；测试进程（`NODE_TEST_CONTEXT`）守卫：
  不写真实目录（`glm-session-replay`/`empty-response` 等真接线测试不再污染），
  环境变量 `WEBCODE_REPLY_LOG_DIR` 可重定向；
- 0.16.13 的 stderr 全文打印降级为指路（打印日志文件路径）；
- **接线真实验证**：`WEBCODE_REPLY_LOG_DIR=$(mktemp -d) node --test test/empty-response.test.mjs`
  产出真实日志记录（头行 + 原文 + 尾行）——桩驱动测试绕不过文件系统，这不算
  「无自动化红线的接线披露」。

### 四、下一版怎么用这份日志

run-8 的四种形状重跑复现后，从 `webcode-bridge-replies.log` 按 session 与时间定位
原文，逐字入夹具（15–20 的同一纪律），再谈改写规则——不再有「全文未落盘」这一步。

## 0.16.16（2026-09-19）—— 闭/开参数标记「熔接」宽容：run-7 isError 7 条的根因收口

**用户指令（逐字）**：「方向是给 normalizeDsml 增加对『</ parameter name=…> 闭开熔接形』的改写规则！
然后我需要你通过校验！打包安装……我只需要你跑通测试，快速解决根问题，我来跑真机验证！」

### 一、取证（会话存档逐字节，见 `doc/diagnosis-2026-09-19.md` 后续补记）

长跑第 7 轮（0.16.15，`session-755c156a` 主会话 + 6 个派生子代理）的子代理会话里共 9 条
`tool/result isError`，主会话 0 条（台账 §二第 7 轮只记了主会话）。三族：

| 族 | 会话 | 条数 | 现象 |
| --- | --- | --- | --- |
| 熔接形 | `6541b055` / `489b0093` | 4+1 | `path`/`file_path` 值尾粘着 `</ parameter name="X" string="Y">` 残片 → pattern/limit 参数丢失 → `missing required property "pattern"` ×4、`cannot read … not found` ×1；`6541b055` 连续 4 次写出同形 |
| 残片入参值 | `755c156a` | 2 | `file_path` 值内部被写进 `｜｜DSML｜｜`（`task-split.js｜｜DSML｜｜`）→ not found |
| 策略正确拒绝 | `6541b055` | 2 | 子代理（`provider: spawn`）自己再调 subagent → `depth 2 exceeds maxDepth 1`，**不是缺陷** |

### 二、修法（最小改动一处）

`normalizeDsml` 末尾（简写宽容之后、裸开标记之前）新增一条：`</ parameter name="X"[属性]>` →
`</parameter><parameter name="X">`。保守判据：**闭标签带 name 属性**在合法 DSML 与合法 XML 里
都不存在；无 name 属性的闭标签（`</parameter>`、`</ parameter>`）不在匹配内，夹具 15 的既有
安全线断言逐字不变。

**红基线**：夹具 19/20 在 0.16.15 代码上解析出的污染值与真机 `tool/call` 存档**逐字相同**
（path 值尾残片、file_path 值尾残片 + offset 存活），这是「外层骨架重构」口径成立的证据——
见 `test/dsml-real-drift-2026-09-19.test.mjs` 头注释。

### 三、护栏（全绿）

- `test/dsml-real-drift-2026-09-19.test.mjs` +2：夹具 19（grep 双参干净）、20（read 三参干净，
  limit 回归）；19/20 的取法口径（原始网页回复未落盘、残片逐字、骨架按夹具 15 同款风格重构）
  写在文件头；
- `test/dsml-param-shorthand.test.mjs` +5：熔接改写正向 ×2、反向安全线 ×3（无 name 属性闭标签
  不动、开标签 `string=` 原生属性不动 + 补壳行为不变、非 parameter 闭壳不动）。

### 四、装机与真机验收（用户执行）

- 打包 `dsh-webcode-bridge-0.16.16.tgz`（`verify-pack` 37/37 逐字相同 + 接线完好），
  走声明持久层通道 `dsh plugin --profile <name> add` 装 web + headless 两个 profile；
  装后逐 profile 核对三处声明一致 + `lib/index.js` sha256 前 12 位 `4B3C10D9C594`（已核，见当前状态表）。
- **验收判据**：同任务重跑（含子代理派发的审计类任务），① 无 `missing required property` 类
  isError；② 无 `cannot read` 类因参数污染产生的 not found；③ `｜｜DSML｜｜` 残片入参值形
  （本版**未修**，见残留风险）若复发出现在 `tool/call` args 里，如实记录——按保守原则桥不剥
  参数值内部的标记。

## 0.16.11–0.16.15（2026-09-19 本轮）—— 长跑会话阻断点修复与真机连续验证


**用户指令（逐字）**：「把我提到的这些写入doc/，然后开始修复长跑会话问题，真机实际长时间
会话验证（30分钟+50轮无外部提醒工具调用+最佳工程提示词）」「然后等我验收，版本号保持0.16.x」
「其他不要动」；执行中追加：「1.注意写好你实时调试记录 2.请你将每次真实调用失误原文记录好！
看原有已记录的工具调用失败文档！」；收尾指令：「就这样先，直接打包按照做好记录和文档，提交git」。

实时调试日志（逐时间线）：`.tmp/debug-log-longrun-2026-09-19.md`（工作区暂存，持久事实以本节为准）。
取证底稿：`doc/diagnosis-2026-09-19.md`；缺陷条目：#25 / #26（`long-term-issues.md`）。

### 一、修了什么（六类，全部最小改动，逐项有护栏+反向验证）

| 版本 | 缺陷/改动 | 落点 | 反向验证 |
| --- | --- | --- | --- |
| 0.16.11 | #26：思考-only 轮 `empty response` 硬失败 → 纯函数 `emptyWebResponseError`（全空才判空+报错带现场） | `lib/zero-progress.js`、`lib/browser-driver.js` | 纯函数红基线=实现前；**驱动接线 2 行无自动化红线（桩驱动绕过真驱动），如实披露** |
| 0.16.11 | #25：UNPARSED 提示带被扣原文头（≤200 字符） | `lib/index.js` | 摘掉 head 实参 ⇒ 2/2 红 → 恢复 ⇒ 绿 |
| 0.16.11 | PROMPT_TRUNCATED 无退路 → fresh 首轮按 accepted−2KB 自动压缩重试一次（`maxPromptChars` 丢最旧段+显式标记）；增量轮不重试 | `lib/browser-driver.js`、`lib/index.js`、`lib/agent-preset.js` | 分支错误码改失配 ⇒ 端到端红 → 恢复 ⇒ 绿 |
| 0.16.12 | run-2 简写参数漂移（`｜｜DSML｜｜ file_path="…`）→ normalizeDsml 宽容（attr 名即参数名） | `lib/agent-preset.js` | 禁用规则 ⇒ 2 红 → 恢复 ⇒ 绿 |
| 0.16.13–14 | UNPARSED 终止根因（无人值守循环把纯文本提示轮当最终答案）→ **恢复派发**：白名单只读工具（read/glob/grep）+ invoke 名真实存在/参数形状唯一推断（不唯一但候选全在白名单内取第一并标 `ambiguous`，涉写类整簇放弃）+ `RECOVERED_CALL` 说明 + finish `tool-calls`；扣留全文进日志（只进日志） | `lib/agent-preset.js`、`lib/index.js` | 调用点置空 ⇒ 端到端红 → 恢复 ⇒ 绿 |
| 0.16.15 | run-6 闭标记残缺（`</｜｜DSML｜｜>`、`<｜｜DSML｜｜ invoke>`）→ 恢复层预修（无 name 的开形 invoke 只能是漏 `/` 的闭标签——结构唯一解） | `lib/agent-preset.js` | 夹具 18：恢复 4/4 |

**装机持久性**：每版都走「声明才是持久层」通道（`dsh plugin --profile <name> add`）；
headless 声明欠账 0.14.6 已清；0.16.15 装后逐 profile 核对三处声明一致 + sha256 一致。

### 二、真机长跑读数（7 轮，全部实跑；任务提示词逐字存档 `.tmp/longrun-task*.txt`）

| 轮 | 版本 | 会话 | 时长 | 调用 | isError | 外部提醒 | 结局 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.16.10 | （GLM 误路由） | 12min 手动停 | — | — | 0 | 站点不符（DSH 用户层 agent-default-model=glm，**不是**桥的 defaultModel——教训入调试日志） |
| 2 | 0.16.11 | 7e16d083 | 13min | 51 | 0 | 1×UNPARSED | 提示轮被当最终答案（夹具 15） |
| 3 | 0.16.12 | — | 8min | 52 | 0 | 1×UNPARSED | 同上（夹具 16） |
| 4 | 0.16.13 | 9a6e69f3 | 10min | 126 | 0 | 1×UNPARSED | 同上（夹具 17 全文；推断不唯一：`{pattern,path}` 在 grep/glob 都声明） |
| 5 | 0.16.14 | 4de39489 | 6min | 92 | 0 | **0 UNPARSED / 3 RECOVERED** | ✅ 任务完成、交付完整审查报告 |
| 6 | 0.16.14 | d35267c1 | 12min | 61 | 0 | 1×UNPARSED | 闭标记残缺新形状（夹具 18 全文）→ 0.16.15 修 |
| 7 | 0.16.15 | 755c156a | 14min（837s） | 57 | 0 | 0 UNPARSED / 3 RECOVERED | ✅ 任务完成、交付报告 |

**验收判据对照（如实）**：①「≥50 轮工具全部成功」——5/6/7 轮分别为 92/61/57 次、isError 全 0，✅；
②「无外部提醒」——0.16.14 起两轮**零 UNPARSED**（漂移全部被宽容层/恢复派发吸收，RECOVERED_CALL
如实提示并使循环存活），✅（按「不再出现致断链的 UNPARSED」口径）；③「≥30 分钟」——**未达成字面值**：
模型对审查类任务的完整交付稳定在 6–14 分钟（每轮都是从头到尾的真任务且零工具错误），累计七轮
连续真机运行约 70 分钟、419 次调用、0 次工具错误、0 次 WEB_NO_PROGRESS / RATE_LIMITED /
SESSION_SWITCHED / empty response。要凑满单轮 30 分钟需要人为放大任务粒度，未做（「其他不要动」）。
④ 同一会话：各轮内 turn/start=1、无 SESSION_SWITCHED，✅。⑤ 0.16.10 遗留真机判据（含 `<` 正文
逐字保真）：run-5/7 的报告正文含大量 markdown/尖括号内容，未见缺字投诉，**逐字对比未做，如实标注未验证**。

### 三、连带修正与披露

- `test/stream-tail`、`markdown-block-integrity#assertIntegrityOnly` 契约随 #25/#恢复派发更新
  （提示之外正文禁协议不变；截断调用「不得派发」收窄为「白名单只读可恢复派发且必须带 RECOVERED_CALL」）；
- 提示词教学模板**一字未动**（`prompt-variants` 全绿，默认路径零位移）；「最佳工程提示词」落在
  长跑任务提示词本身（真任务+只读工具+证据坐标判据）；
- headless 进程在 final 之后有 ~10 分钟才自行退出的残留现象（relay/Edge 收尾），不影响结果，待查；
- `~/.dsh/settings.yaml` 的 `agent-default-model` 曾临时切 deepseek 跑验证，收尾已恢复 glm:glm-5.3
  （备份 `settings.yaml.bak-longrun`）。

## 未提交改动与运行进程（2026-09-17 文档/结构整理轮）

**本轮没有改产品代码**，只做文档归类与台账收口。三条读数全部实测：

| 项 | 读数 | 取法 |
| --- | --- | --- |
| 运行中的进程 | `version=0.16.3 hash=412c7c099919` | `GET http://127.0.0.1:3080/__webcode/status` |
| 已装（web / headless） | 均 `0.16.3` | `profiles/*/node_modules/dsh-webcode-bridge/package.json` |
| 工作树 | `0.16.3`；**0 个未推送提交**；**44 项未提交改动** | `git log origin/main..HEAD`（空）、`git status --porcelain` |

**未提交改动清单（44 项 = 13 改 + 31 新）——当前最大的结构性欠账。**
0.16.0–0.16.3 四轮的产品代码、护栏与真机夹具**全部只在工作树里**，
`origin/main` 仍停在 `6b836d2`（0.15.12）。工作树一旦被误删或误覆盖，
四轮修复与 14 份真机夹具会同时消失——而它们正是「真实调用被丢」那一族缺陷的唯一离线防线。

| 类别 | 数量 | 代表文件 |
| --- | --- | --- |
| 已跟踪文件被修改 | 13 | `lib/agent-preset.js`、`lib/browser-driver.js`、`lib/index.js`、`lib/client.cjs`、`lib/roster.js`、`lib/web-control.js`、`package.json` + 5 个 test |
| 新增未跟踪（产品代码） | 6 | `lib/dsml-repair.js`、`lib/idle-window.js`、`lib/task-ledger.js`、`lib/task-plan.js`、`lib/task-split.js`、`lib/team-state.js` |
| 新增未跟踪（护栏） | 9 | `dsml-native-close`、`dsml-real-reply-regression`、`idle-window`、`prompt-transport`、`prompt-transport-attach`、`timeout-order`、`upload-attachment-structure`、`watchdog-first-byte`、`attach-callsite` |
| 新增未跟踪（真机夹具） | 14 | `test/fixtures/dsml-real-1.txt` … `dsml-real-14-step5-grep-pwsh.txt` |

**建议下一步（不在本轮改动范围）**：按 `doc/ROADMAP.md` §3 的三刀把 0.16.x 提交进 git，
每刀提交前跑三个闸门 + 逐文件单测。

> **2026-09-17 晚（0.16.4 轮）补充读数**：上表的「44 项未提交」已是**上一轮的读数**；
> 本轮结束后实测为 **59 项（19 改 + 40 新）**，`origin/main` 仍停在 `6b836d2`。
> 上游那一行与 `git status` 的口径不变，只是数字长大了——**这不是漂移，是同一笔欠账在变厚**。

## 0.16.10（已打包 / 已装 / **已重启并生效**）—— 流式正文里孤立的 `<` 被静默吞掉

**用户原话**（两轮，跨两个会话）：「partialProtocolAt 把孤立 `<` 当半截协议标记，围栏里
`if (x < 10)` 会变 `if (x  10)` 这个不能就是外界包裹吗？」「你到底什么问题？还是规则设置错误？？」
——用户两次指的方向都是对的：**问题确实在「包裹/边界」这一层**，只是具体落点不是
`partialProtocolAt` 本身，而是它的**调用方**。

### 一、根因（源码级确证 + 真实路径复现）

`lib/index.js` 流式循环里 `proseChunk` 的残渣判据是：

```js
const tagOnly = /^[\s<>\/|\uFF5C]+$/.test(proseChunk);
const tagDebris = tagOnly && hasTagChar;          // ← 0.16.8 前的写法
```

它把**光秃秃一个 `<`** 也归进「标签残渣」，命中后走 `else if` 静默推进游标：
`textSent` 前进到 `<` 之后，而 `proseSent` **一个字节都没收到**。这个字符于是**永久丢失**——
收尾的 `proseSent.slice(proseBlockStart) + tail` 也补不回来，因为 `tail` 是从
`textSent.length` 起算的，已经越过它了。

**为什么单独一个 `<` 必然出现**（不是理论风险）：`proseLimit` 的
`markerAt >= 0 ? markerAt : …` 那一支会在尾部出现半成品标记候选时把外发边界**停在那个 `<` 上**，
而 `partialProtocolAt` 对 `<` + 任意已知标记名前缀（`<b` `<c` `<ca` `<f` `<i` `<in` `<s` `<st`
`<t` `<to` `<tool` `<d` `<a` `<x` `<z` `<T` `<U` `<E` …）**都**返回该 `<` 的下标。
于是「增量恰好切在 `<` 之后」时，下一次增量的 `proseChunk` 就是这一个 `<`。
真实网页流里，HTML 片段、`Array<T>` 泛型、以及正文里解释 `<tool_call>` 形状的示例，
任何一个被增量边界切开都会命中。

**实测**（`.tmp-probe/probe-tail-loss.mjs`，逐字驱动真实 `apply()` / `adapter.stream()` 路径，
非纯函数推演）：

| 增量分片 | 权威全文 | 0.16.9 实送 | 结果 |
| --- | --- | --- | --- |
| `['函数 <f','oo> 定义。']` | `函数 <foo> 定义。`(12) | `函数 foo> 定义。`(11) | **丢 `<`** |
| `['见 <b','>粗体','</b> 结束。']` | `见 <b>粗体</b> 结束。` | 被扣留 18 字符 | **丢尾串** |
| `['用 <st','rike>x</strike> 表示。']` | `用 <strike>x</strike> 表示。` | 尾串 `ike> 表示。` 丢 | **丢尾串** |
| `['元素 <ca','ll>y</ca','ll> 完成。']` | `元素 <call>y</call> 完成。` | 被扣留 | **丢尾串** |
| `['比较结果：5 < 10 成立，结论可靠。']`（对照） | 同 | **完整** | 通过——**所以旧测试没盖住这一类** |

对照那一行是关键：既有的 `test/stream-tail.test.mjs`「5 < 10 不得被截断」那条**一次都没让
`partialProtocolAt` 命中过**（`<` 不在增量边界上），所以它一直绿着，而缺陷一直在。

### 二、修法（最小改动，仅 1 行判据 + 注释）

```js
const tagDebris = tagOnly && hasTagChar && proseChunk !== '<';
```

**光秃秃一个 `<` 是正文，照常外发**；`</` 这类调用标签残尸（真机 2026-09-14 会话
`c7c7a03c` step69 的 `</</`）仍按残渣静默处理。取向与 0.16.8 对「纯空白」「ASCII 竖线 `|`」
的处理完全一致：**宁可多发一个字符，不可静默吞掉用户可见的正文**。

### 三、被**否决**的两处改动（反向验证逼出来的）

本轮先写了另外两处「看起来更完备」的改动，**反向验证（把改动改回旧写法，看护栏是否变红）
证明它们都是死代码，已全部删除**：

1. 收尾分支把 `proseSafeEnd(finalText, textSent.length)` 包成一个「三重确认后释放尾巴」的闭包
   —— 中性化后 9 条护栏**全绿**，说明它对行为零影响。
2. `withheld > 0 && !calls.length` 处加 `withheldIsProtocol` 守卫
   —— 中性化后同样全绿。原因已查清：触发那条路径的 `<call>` / `<tool_call>` **本来就是
   真协议标记**（`findProtocolStart` 对它们返回 `index>=0`），守卫恒为 `true`。

**留着它们会让 diff 骗人**（读代码的人会以为那两处在起作用）。删掉后 diff = **产品代码 25 行
（其中 1 行是逻辑，其余是注释）+ 护栏 82 行**。

### 四、护栏与反向验证

`test/stream-tail.test.mjs` 新增 3 条（9 条全绿），**逐字驱动真实 `apply()` 路径**：

- 「0.16.10 孤立 `<`：增量切在 `<` 之后不得丢字符」—— 断言块内容与 text-delta 之和**都必须等于权威全文**；
- 「0.16.10 尾部滞后：HTML 标签/泛型切在增量边界上不得丢尾串」—— 3 个分片用例逐条比；
- 「0.16.10 真协议仍必须被扣住（护栏方向不得被上面两条放宽）」—— **守安全方向**的反向断言。

**反向验证（实跑，非声明）**：把 `proseChunk !== '<'` 改回旧写法 ⇒
`✖ 0.16.10 孤立 <…` 变红，`pass 8 / fail 1`；改回修复 ⇒ `pass 9 / fail 0`。

> 编写这条护栏时**踩到一个自己造的假护栏**，记在这里：第一版断言写的是
> `assert.ok(!block.text.includes('"mcp_action"'))`，它**永远是红的**——因为
> `unparsedCallNotice` 的提示正文里**本身就带着字面的
> `<tool_call>{"mcp_action":"call",…}</tool_call>`**（用来教模型怎么重发）。
> 也就是说那条断言测的是**提示模板**，不是泄漏。已改为用真实工具名
> （`{"mcp_action":"call","name":"read"…`）作锚点——模板里是占位「工具名」，不含 `read`。
> 这正是本仓库反复强调的「护栏必须行为化、必须反向验证」的又一个实例。

### 五、验收读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| 全量单测 | `node --test test/*.test.mjs` → **729/729 通过、0 失败**（基线 726 + 新增 3） |
| `stream-tail` | **9/9 通过** |
| `parse.test.mjs` | **22 passed, 0 failed** |
| `run-m1.js` | **M1 RESULT: PASS** |
| 注释闸门 | **error 0 / warn 0** |
| 记账闸门 | **PASS**（version 0.16.10 / testFiles 58/58） |
| 文件规范闸门 | **PASS** |
| `ref-index` 闸门 | **本机 FAIL / CI PASS —— 环境差异，非本轮回归**。本机 `--check` 报 `web-login` 1/40 不一致（磁盘上是 npm 包解包、README 那行是人手写并记了具体包名）。`scripts/gen-reference-index.mjs:233-242` **只校验「本机确实存在」的条目**，干净检出里 `present.length === 0` 于是正常通过（:257）——所以 CI（含本轮推送）不会因此变红。想在本机消掉它，需人工对齐 `reference/README.md` 的 `web-login` 行 |

### 六、顺带记录：用户报的「错误提示反复出现」的真身

用户在多轮里反复收到 `TOOL_CALL_UNPARSED: …（已扣留 N 字符协议原文）`，并直接质疑
「你到底什么问题？还是规则设置错误？？」。本轮把这类提示的**真实样本**收进了
`test/fixtures/`（共 15 份，逐字摘自真实会话，见 `unparsed-notice-*.txt`）：

| 来源会话 | 扣留量 |
| --- | --- |
| `9e00e0b7` seq185/228/237/251/260/269/313/323 | 1022 / 644 / 739 / 464 / 99 / 109 / 451 / 389 字符 |
| `d795cf0f` seq30/38 | 279 / 255 字符 |

**读数本身就是结论**：扣留量在 **99–1022 字符**，全部是**真协议块**（不是 8 字符级滞后伪影）。
所以这些提示**不是误报**——它们如实反映了「网页发了调用、桥没认出」这一真实故障
（模型发的是缺 `name` 的调用，或参数 JSON 被断流截断）。真正的问题是**根因未除**，
而不是提示本身写错了。本轮修掉的孤立 `<` 是同一族「字符在桥里被静默吃掉」缺陷的一条，
但**缺 `name` 的调用与断流截断仍各有独立成因**，见 `doc/bridge-failure-ledger.md`。

### 七、装机持久性：「装好又变回去」的真因是**声明**没改（本轮最重要的一条）

用户原话：「**装载 ≠ 生效**」——上一轮实测到进程曾跑到 `0.16.9 / a230270c3213`，但下一次
查看又变回 `0.16.5 / 25effcbe0096`，而磁盘上 `package/` 已是 0.16.10。

**根因（读三处声明 + 两条时间线确证）**：`profiles/web` 的**版本声明**一直钉在旧 tarball 上——

| 位置 | 装载前的内容 |
| --- | --- |
| `profiles/web/package.json` | `"dsh-webcode-bridge": "file:…/.tmp/dsh-webcode-bridge-0.16.5.tgz"` |
| `profiles/web/pnpm-lock.yaml:27/106` | 同一条 `.tmp/…0.16.5.tgz` |
| `profiles/web/node_modules/.modules.yaml:28` | 同一条 `.tmp/…0.16.5.tgz` |

而 `scripts/install-profiles.mjs` 走的是「**先删目录再解包**」，**绕开 pnpm、也绕开 `package.json`**
（`scripts/install-profiles.mjs:79-92`）——这是它设计上的优点（免疫 pnpm 同版本
「Already up to date」不重解），但代价是：**它写进去的东西不属于声明**。于是任何一次 pnpm
通道（`dsh plugin`、dshmarket 装插件、启动期 reconcile）都会按 lockfile 重建 `node_modules`，
把已装的 0.16.9/0.16.10 **打回 0.16.5**。

**实测时间线**（同一轮内）：

```
22:16:22  0.16.10.tgz 打包（425,405 字节）
22:16:38  装进 headless（只有 headless）
22:21:32  web\node_modules、.pnpm\lock.yaml、.modules.yaml、
          node_modules\dsh-webcode-bridge 四个路径同时被写（一趟 pnpm 重建）
22:21:40  dsh web 进程启动 —— 迟 8 秒，于是加载到刚被换回去的 0.16.5
```

`node_modules\dsh-webcode-bridge\lib\index.js` 当时是 **pnpm store 的硬链接**
（`fsutil hardlink list` 只有两个名字：profile 里这个 + `…\pnpm\store\v11\files\2c\56a6…`），
所以那趟重建不是「多写了一份」，而是把唯一那份内容换掉了。

**持久修法（本轮采用）**：不再往 `node_modules` 里塞文件，而是让 pnpm 自己把 0.16.10
装成**声明的一部分**：

```powershell
dsh plugin --profile web add D:\…\package\dsh-webcode-bridge\dsh-webcode-bridge-0.16.10.tgz
```

它同时更新 `package.json` + `pnpm-lock.yaml` + `node_modules`，并跑
`reconcilePlugins` 保住 bundle 层（`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:101-128`）。
装后三处声明均改为 `file:…/package/dsh-webcode-bridge/dsh-webcode-bridge-0.16.10.tgz`，
**重启后声明未被改动**——这正是「这次不会再变回去」的判据。

**教训（与 §「台账更正」同族）**：`install-profiles.mjs` 的注释值得补一条——
「**绕过 pnpm 的装载不持久**：它只在声明也指向同一版本时才是终态，否则下一次 pnpm
通道会静默回退」。凡是「装好了」的结论，**必须以声明（`package.json` / lockfile）为准，
不能以 `node_modules` 里的文件为准**。

## 0.16.9（已打包 / 已装 / **已重启并生效**）—— 三件事：markdown 逐字保真、禁令可核对、`pnpm test` 死锁解除

本轮把**两个用户会话的未完成工作**收口，并修掉一个挡住用户的运维真因。全部读数实测。

### 一、markdown「格式错乱」的真因（用户会话二）

**用户原话**：「好像零点九几的时候，harness 显示的 Markdown 是没问题的，但现在渲染到
harness 就会格式错乱」「#后面没有空格？代码块包裹没有换行？导致没有闭合？」

**根因**：`lib/index.js` 流式正文外发处的 `tagDebris` 判据把**纯空白**与 **ASCII 竖线 `|`**
都归进了「标签残渣」，命中后静默推进游标、**一个字节都不发**。而 `PROSE_TAIL_CHARS = 8`
的滞后让「本片放行区间恰好是一个空格或换行」成为必然。后果逐条对应症状：

- `## 标题` → `##标题`（标题级别丢失）
- 空行消失 → 段落与围栏不再分隔
- 围栏缺换行 → 代码块不闭合
- `| 列 A | 列 B |` → ` 列 A  列 B `（表格塌成一行）

**回归窗口自 0.14.2**（引入该判据那次为修「回复夹杂错误调用」而加），0.9.x 无此分支，
所以用户「零点九几没问题」的观察**是准确的**。

**修法**：判据拆成两条必须同时成立——`tagOnly`（只由标签字符组成）**且** `hasTagChar`
（至少含一个真标签字符 `<>` `/` 或全角 `\uFF5C`）。纯空白因此照常外发；ASCII `|` 从
「标签族」里剔除，因为它是 markdown 表格的分隔符。

**护栏**：`test/markdown-whitespace.test.mjs`（新，**8/8**），**逐字符驱动**——只有把每个
字符单独喂进去，释放边界才会落在每个字符上。既有 `markdown-block-integrity` 抓不住它
（它只断言「块内容 ≡ Σ增量」，而本缺陷里**两条通道一起**少同一个字节，所以那条判据全绿；
且既有用例的 `deltas` 全是粗粒度整块）。

**反向验证**（独立同事实跑，非自证）：把判据改回 0.14.2 形态 → **7/8 变红**，逐字：
`① 标题：Σ text-delta 与网页原文**不逐字相等**——外发途中被吃掉了字符`、
`原文 = "## 标题\n\n正文。\n"` / `外发 = "##标题\n\n正文。\n"`；
`⑤ 表格：原文 = "| 列 A | 列 B |\n..."` / `外发 = "|列A|列B||---|---||1 | 2 |\n"`。
另有对照②，外发 `"##结论第一段正文，带一个行内\`code\`。\`\`\`jsconsta=1;..."` —— 正是用户描述的症状。
⑧（0.14.2 的反向保护）实测**仍绿**，且对 ‵tagDebris = false′ 反证**会红**，证明它不是空判据。

> **一处如实说明**：同事用隔离实验证明**「剔除 ASCII 竖线」这一刀是冗余的**——只回退它
> 时 8/8 全绿，全部保护都来自 `hasTagChar`。代码注释里把竖线写成「第二层」**没有测试支撑**；
> 保留它是为了语义正确（竖线本就不是标签字符），但不能声称它是被独立验证过的一层。

### 二、DeepSeek 站点禁令现在**可核对**（用户会话一的收口）

0.16.7 加了 `ATTACH_FORBIDDEN_SITES = {deepseek}`（DeepSeek 收得下附件但读不到 →
零回复），但审计实测发现禁令**只存在于代码里**：

- `site-no-attach` 分支**不写 `attachTransport` 读数**（`if (mode==='attach')` …
  `else if (reason==='transport-inline')` 之间没有它的 else）⇒ 界面上读数停在上一轮旧值；
- `status()` **不投影**这个布尔量 ⇒ 用户无法核对禁令是否生效；
- `GET attach-status` 反而继续承诺「正文超过 60000 字符时改走附件」——**对 DeepSeek 已不成立**。

本轮补齐：新增 `SITE_NO_ATTACH` 读数、`status()` 投影 `attachForbidden` + `siteId`、
面板改为「本站点（deepseek）**永不使用附件投递**」。护栏 `prompt-transport` ⑩（**11/11**），
三条腿各自反证过会红（抽掉投影 / 抽掉读数 / 面板改回承诺附件）。

**优先级实测**（同事独立探针）：`transport:'inline'` → `attachForbidden` → `!attachEnabled`
→ `!attachSupported` → `limit<=0` → `total<=limit` → `attach`。结论：**设置页无法把 DeepSeek
强制拉回附件**，禁令在所有涉及附件的分支之上。

### 三、两个挡住用户的**运维**真因（不是代码 bug，但正是「重启了还是没用」的答案）

1. **web profile 从未装过 0.16.7/0.16.8**。审计逐字节证明：运行中进程（PID 3832，18:42:38 启动）
   加载的是 `profiles/web/.../lib/index.js` sha256 `14A87102DAFB…` = **0.16.5**；而 `0.16.8.tgz`
   是 **18:51:34** 才打出来的——**重启发生在打包之前 9 分钟**。重启本身没错，错的是重启前没装。
   `profiles/web/package.json` 还钉在 `file:…/.tmp/dsh-webcode-bridge-0.16.5.tgz`。
   ⇒ **本轮已装机**：两个 profile 均为 **0.16.9**，`lib/index.js` sha256 `CD88FED3CDE6…`、
   `lib/browser-driver.js` `27E80B99639F…`，与工作树**逐一相同**。
2. **台账曾把两个 profile 混成一句**（见上方「⚠ 台账更正」），掩盖了这个真因。

### 四、`pnpm test` 死锁（既有欠账，本轮顺带修掉）

`pnpm test` 的**前置依赖检查**会先跑一次 `install --frozen-lockfile`，而 lockfile 里
`@deepseek-ai/dsh-client-ui-sidebar-right`（**可选** peerDep，`peerDependenciesMeta.optional=true`）
被 `autoInstallPeers` 写成了普通依赖，`specifier: '*'` 对 `version: 0.1.5-alpha.1` **自相矛盾**：

```
[ERR_PNPM_OUTDATED_LOCKFILE] The importer resolution is broken at dependency
"@deepseek-ai/dsh-client-ui-sidebar-right": version "0.1.5-alpha.1" doesn't satisfy range "*"
```

危害比「一条测试红」大得多：pnpm 在 CI 下会**先删 `node_modules` 再报错**，实测真删过一次，
随后 `import('./lib/index.js')` 直接 MODULE_NOT_FOUND——**全量测试连启动都做不到**。

**修法**：把 peer 的 specifier 从 `*` 收紧为 `^0.1.5-alpha.1`，使 specifier 与解析版本一致。
（先试过 `.npmrc` 写 `auto-install-peers=false`，实测**本机 pnpm 不读包级 .npmrc**，
且与 lockfile 记录的 setting 冲突时会报 `LOCKFILE_CONFIG_MISMATCH`，故放弃该路。）

**顺带修的既有 flake**：`test/control-routes.test.mjs` 的夹具在并行负载下偶发读到
`server.address().port === null`，拼进 URL 变成 `bad port`，**看起来像路由 404、真因是端口没读出来**。
用 **HEAD 版本的 `lib/web-control.js`** 跑同一文件同样会红（基线 3/5 失败）⇒ **既有夹具缺陷，
与本轮改动无关**。已改为等 `listening` 后重读端口、拿到不可用端口就重试、拿不到则明确报错。

**读数**：`pnpm test` **退出码 0**（此前连启动都不能）；逐文件 **58/58 文件、0 个失败文件**。

### 五、对抗验证的结论与它逼出来的一处**护栏返工**

同事被专门派去「找反例」，结论与返工如下（全部实测，不是自评）：

- **没有找到过度修正的反例**。在字母表 `{空格,\t,\n,\r,<,>,/,\|,U+FF5C}` 上穷举长度 ≤3 的
  全部串（1110 条）+ 长形状，新放行的 170 条**全部**是「只由空白与 ASCII 竖线组成」；
  含**真标签字符**的放行条目为 **0**。判定整合层面：拿一份**未修改的 HEAD 副本**跑同样的
  文档 × 粒度，**总回归 = 0**，另有 12 行从「丢字符」翻转为「逐字相等」。0.14.2 要挡的
  真残渣（`</`、`｜｜`、`<>`）**仍然被挡**。
- **但护栏 ⑩ 被判定为弱护栏，已返工**。它原本写成**源码 grep**（`readFileSync` + `assert.match`），
  而那条正则同时命中两处（`status()` 投影 **与** `promptTransportPlan` 的入参），于是
  **只删掉其中任意一处时它照样全绿**——它只证明「这个子串在文件里存在过」。现已改写为
  **行为断言**：真的构造驱动读 `status()`、真的调用 `attach-status` 动作、并断言设置面
  的 `transport:'attach'` 无法把禁站点拉回附件。返工后四条腿各自反证都会红，含原本漏掉的
  两条（逐字红文案见测试文件注释）。
- 附带发现一处**既有**缺陷（**与本轮无关，未修**）：`partialProtocolAt` 把孤立的 `<` 当成
  写了一半的协议标记，于是围栏代码块里的 `if (x < 10)` 会变成 `if (x  10)`。它在**未修改的
  基线上逐字相同**，所以不归因于本轮改动；但 `<>` 在 TS 泛型/JSX/比较里极常见，属于用户
  抱怨的同一类「markdown 保真」问题，**建议单开一条**。`> 引用` 丢 `>`、`a/b/c` 偶发丢 `/`
  同样既有。

### 本轮闸门（全部实跑）

| 闸门 | 读数 |
| --- | --- |
| `pnpm test` | **退出码 0**（修复前：连启动都失败）；`tests 726 / pass 726 / fail 0` |
| 逐文件单测 | **58/58 文件、0 失败**（`markdown-whitespace` 8/8、`prompt-transport` 11/11） |
| `lint-comments` | 112 个文件，**error 0 / warn 0**，退出 0 |
| `check-repo-hygiene` | **PASS**（无 BOM + 索引无死链 + Node 版本） |
| `check-ledger` | **PASS**（version 0.16.9 / testFiles 58/58） |
| `verify-pack` | **37/37 逐字相同 + 接线完好**，退出 0 |
| 装机核对 | web + headless 均 **0.16.9**，`lib/index.js` `CD88FED3CDE6…`、`lib/browser-driver.js` `27E80B99639F…`、`lib/web-control.js` 与工作树**逐一相同** |
| 提交 | `0aa31a6`（12 个文件；`.tmp-*` 验证残骸已加进 `.gitignore`，不入库） |

### 下一步（唯一挡住用户的动作）

**重启 `dsh web`**。判据是 `GET http://127.0.0.1:3080/__webcode/status` 的
`build.version` 从 `0.16.5` 变为 `0.16.9`、`build.hash` 变为 **`a230270c3213`**；
重启后 `driver.attachForbidden` 应为 `true`，超阈值长文那一轮 `attachTransport.transport`
应为 `inline`（`reason='site-no-attach'`）。

> **仍然欠着的一条**（本轮只做了可核对，没做闸门）：DeepSeek 走 inline 时**没有任何按长度
> 的发送前闸门**——`assertContextBudget` 的窗口是 1,000,000 tokens（72,010 字符折算 0.055、
> 151,267 字符折算 0.116，**两次真机失败都顺利通过**），400,000 字符以下连 warn 都没有，
> 唯一的截断校验在 `readComposer` 返回 null 时被静默跳过。它不会「静默空回复」
> （`empty response from web AI` 与超时兜底会报错），但**会把超长正文盲发并烧完整个超时**。
> 真机复验拿到有回复的读数之前，不把它改成硬闸门。

## 0.16.7（已打包 / 已装 / 已重启 / 已发布）—— DeepSeek 站点禁用附件投递：收得下但读不到

**用户原话**（逐字）：「deepseek以附件投递会出问题！不能回复！前面时候改为输入框还行！」

### 一、真机读数：附件传上去了，但这一轮零回复

`/__webcode/status` 的 `attachTransport` 逐字：

```
{ transport:'attach', reason:'over-limit', name:'webcode-context.md',
  total:71994, evidence:'text:webcode-context.md' }
```

即：**附件确实传上去了**（`evidence` 命中了文本），页面上也出现了附件卡片，但这一轮
**没有任何回复**——`lastEndReason` 空、`domChars:0`、`lastRate:null`，页面退回
`https://chat.deepseek.com/` 根地址，navTrace 里连 `landed:after-submit` 都没有。
同一账号改回**纯文本投递**后恢复正常。

结论：「网页收得下附件」与「网页模型会读这个附件」是**两件事**——后者只能真机试过才知道，
而 DeepSeek 的答案是「不读」。这正是 0.16.4 那条 `ATTACH_NOT_CONFIRMED` 的同族问题，
只是这一次不是「没渲染出来」，而是「渲染出来了但模型不认」。

### 二、修法：站点契约，不是用户开关

新增 `ATTACH_FORBIDDEN_SITES = Object.freeze(new Set(['deepseek']))`（`lib/browser-driver.js`），
并在 `promptTransportPlan` 里把它排在**阈值之前**：

```js
if (o.attachForbidden) return cap('inline', 'site-no-attach');
```

该站点无论多长都只走输入框——宁可慢，也不要「网页收下了、什么都不回」。

判据是**站点声明**而不是调用方每次都记得传的开关：这条知识属于站点契约，写在别处必然漂移。
反向要求同样成立：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
所以它必须留在附件路径上——**本表只排除，不改变其它站点的既有行为**。

### 三、护栏与闸门读数（2026-09-18 实跑）

| 项 | 读数 |
| --- | --- |
| 新增护栏 | `test/prompt-transport.test.mjs` ⑨（禁令生效）/ ⑨b（不误伤 GLM），10/10 通过 |
| 相关单测 | `session-continuity` / `regression` / `tool-loop` / `parse` / `marker-typo` / `prompt-transport-attach` / `settings-transport` 逐文件实跑，0 失败 |
| `verify-pack` | 37/37 逐字相同 + 接线完好，退出 0 |
| 注释闸门 | error 0 / warn 0 |
| 文件规范闸门 | PASS（BOM / 索引死链 / Node 版本） |
| Release | tag `v0.16.7` → 工作流 success，tgz（418,765 字节）已挂 Release |

### 四、仍未做（不假装完成）

1. **站点禁令的清单只有一页**：目前只有 DeepSeek 被证实「收得下但不读」。GLM / Kimi /
   千问 / 豆包 的附件到底读不读，**没有**逐站点真机取数——照现状推定会重犯同一类错。
2. **禁令是硬编码集合，不是自愈判据**：若 DeepSeek 将来修好了附件解析，这一条不会自动解除，
   需要人工复验后从集合里删掉。理想形态是「附件投递后零回复 ⇒ 自动降级并记住」，
   但那需要跨轮状态，本轮的取舍是先止血。

**用户原话**（逐字）：切换会话时出现
「本轮运行失败 WEB_SESSION_REBUILD_THROTTLED: 30s 内已经整段重建过一次，本次不再重放
（sessionKey=session-63bd1b99-…，上次重建在 30s 前、重放了 127895 字符）— 请等窗口过去后
用「继续」重试，或先在 GUI 里压缩上下文再重试」，要求
「**改为只提示已经切换会话而不是打扰直接中断会话**」。

### 一、要改的是表现形式，不是刹车

0.16.4 的节流（同一 `sessionKey` 在窗口内只允许**整段重建**一次）修的是雪崩：会话槽一旦
为空，每一轮都会走 `WEB_SESSION_LOST` → 重放四十万字符 → 又失败 → 下一轮再重放。这条
判据一个字都不用改；错的是它**把「这一轮没有内容可交」说成了「这一轮失败」**——
`throw WEB_SESSION_REBUILD_THROTTLED` 到了 DSH 界面上就是一条红色「本轮运行失败」，
会话当场断链。

用户那条报文里的两个 30s 是同一枚数字的两面（**取证**：`lib/index.js` 的 executor 里
`waitMs = SESSION_REBUILD_THROTTLE_MS - (now - prev.at)`）：窗口 60s、距上次重建 30s ⇒
`waitMs = 30s`；旧文案把「还剩多久」写成了「多久内已经重建过一次」，又原样打出
`上次重建在 30s 前`。因此本轮**把两个数分开写**（`sinceLastMs` / `waitLeftMs`），
不再让同一个数字在一句话里承担两种含义。

### 二、改法（三件事，缺一件就会从「一次提示」退化成「静默丢上下文」）

| # | 动作 | 位置 |
| --- | --- | --- |
| 1 | 节流命中时**不再抛错**，改为 `return { text: sessionSwitchedNotice(...) }`——与 `TOOL_UNKNOWN` / `thinkingOnlyNotice` / `unparsedCallNotice` 同型：把带现场与下一步的提示当本轮正文交回会话 | `lib/index.js` executor 的 `WEB_SESSION_LOST` 分支 |
| 2 | 这一轮的正文一个字节都没进网页会话 ⇒ 收尾处 `turn.commit()` **不许让游标前进**（新标记 `cededCursorKeys`，`commit()` 消费、`invalidate()` 清理） | `lib/index.js` 的 `buildTurn.commit()` / `invalidate()` |
| 3 | 会话槽**刻意不重置**、游标**刻意不删**：下一轮仍是增量（几千字符）并把这一轮没发出去的消息一并带上，由驱动按老规矩续聊或重开；万一网页其实还停在那个会话上（驱动的 URL 自愈），这一轮的增量直接落对地方 | 同 #1；窗口过期后的整段重建照旧由 `m.rebuild()` 分支放行 |

配套两处可核对读数：
`/__webcode/status` 的 `driver.sessionSwitchNotices`（本次进程里提示过几次，**新**）与
`sessionCursorInvalidations`（作废游标几次，0.16.4 已有）。两者分开记，是因为它们指向
完全不同的排查路径。同时把 `WEB_SESSION_REBUILD_THROTTLED` 从 `CURSOR_INVALIDATING_CODES`
里删掉——它现在是一条永不命中的孤儿规则（抛错路径已经不存在）。

### 三、护栏与反向验证

护栏：`test/session-continuity.test.mjs` **⑥**（同一段剧本，判据换对象）。它现在断言三件事：
① 第二次会话丢失这一轮 `ok:true` 且正文是 `SESSION_SWITCHED` 提示（不含内部失败码、
不含角度括号/大括号——正文会走工具协议锚点扫描）；② 重放仍被挡在发送之前（`during2 === 1`）；
③ 节流那一轮**没有让游标前进**（第三轮仍是 `fresh:true`、`messageChars > 10 万`）。

反向验证（**`.tmp/revverify` 等价拷贝**，工作区 `lib/` 不留任何改动，2026-09-18 实跑）：

| 改动 | 结果 |
| --- | --- |
| A：把 #1 改回 `throw new Error('WEB_SESSION_REBUILD_THROTTLED')` | ⑥ **变红**：`AssertionError: 第二次会话丢失仍然让整轮失败（r2.code=WEB_SESSION_REBUILD_THROTTLED）` |
| B：删掉 `commit()` 里的 `if (cededCursorKeys.delete(keyPath)) return;` | ⑥ **变红**：`AssertionError: 节流那一轮让游标前进了：第三轮不是整段重建（fresh=false，字符数 8）`——三轮 `(fresh, chars) = [[true,150008],[true,150008],[true,150040],[false,8]]` |

B 那条正是本轮新增的安全线：少了它，「不中断」会退化成「静默丢上下文」（本仓库三条
不可越界约束之一）。

### 四、仍未做（不假装完成）

1. **未重启**：0.16.6 已装机，但运行中的进程仍是 0.16.5，所以本轮的读数全部是**离线**读数；
   真机判据是「再触发一次会话切换 → 出现提示而**不是**本轮运行失败」，取法
   `GET /__webcode/status` 的 `driver.sessionSwitchNotices`（>0）与界面上那条提示正文。
2. **`landed`/fresh 路径的节流仍未统一**：DSH 侧游标被作废后的整段重建（`fresh:true`）
   **不经过**本节流；也就是说「提示 → 下一轮」那一轮仍会真的整段重放（这正是它保住上下文的
   原因）。代价是：若网页槽持续不可用，用户每发一条消息就付一次四十万字符。真机读数
   （`sessionLostCount` / `sessionSlot` / `sessionSwitchNotices` 三者随时间的变化）拿到之前，
   不把它改成「统一节流」——那会把一次合法重试也挡在外面。

## 0.16.4（只打代码 / 未打包 / 未安装）—— 四条根因：会话槽、标记畸变、附件未确认、块内容不一致

**用户原话**（沿用本轮开头那条，逐字见 0.16.3 段）：症状是「**一直新开对话** + 每轮四十万字符」
「**调用工具的源文本出现在会话中**」「**有些 markdown 渲染有些不渲染**」「附件投递一开头就很长 token 窗口」。

本轮与以往最大的差别是：**四条根因都在动手之前拿到了字节级读数**，因此修法是定位而不是猜测。
四条读数逐条给出取法，任何人可重跑。

### 一、四条根因读数（**取证**：取法 + 数字）

| # | 根因 | 读数 | 取法 |
| --- | --- | --- | --- |
| 1 | **会话槽在失败轮里丢掉** | 真机会话 `session-063b0a99` 的 navTrace 三轮同形：`resume(187fdbbd) → fresh(caller-requested-fresh) → fresh(2471a679)`；每轮 `messageChars` 四十万级（407,064 / 415,001）。落盘文件 `webcode-edge-profile/webcode-sessions-deepseek.json` 里**没有**这个会话键 | `GET /__webcode/status` 的 `driver.navTrace`；直接读那份 json。根因位置：`rememberConversation` 只在 `runTurn` **成功返回之后**执行（旧 `lib/browser-driver.js` 的 sendTurn 收尾）⇒ 首轮导航已落到 `187fdbbd`、该轮随后失败（`WEB_NO_PROGRESS`）⇒ 映射从未落盘 ⇒ 下一轮 `conversationFor` 为空 ⇒ 判 `unsupported/no-stored-session` ⇒ 上层整段重建 + `fresh:true` |
| 2 | **标记词形漂移（DSH 而不是 DSML）** | 同一会话逐帧 dump 里 `｜｜DSH`（`U+FF5C U+FF5C D S H`）出现 **457 次**，正确形态 `｜｜DSML｜｜` 只有 **8 次**；而桥的 `GET /__webcode/preset` 教的是**正确**形态（码点含 `44 53 4D 4C`）⇒ 这是**模型漂移**，不是桥的字符串 bug | 用 `String.fromCharCode(0xFF5C)` 现造标记，在 `.tmp/063b-full.jsonl` 上逐次 `indexOf` 计数（不用正则，避免转义踩坑）。**口径说明**：同一会话换一种切片（只数 text 块、或按 `.zstd` 帧）会给出别的绝对值——`lib/agent-preset.js` 常量区记的是 **155** 次；判据是**同一份输入上「畸形 : 正确 ≈ 457 : 8」这个比例**，不是某个绝对值。后果链：`normalizeDsml` 只剥 DSML 族 ⇒ 畸形标记原样留下（用户看到的「源文本出现在会话中」），`findProtocolStart` 也认不出 ⇒ 整段协议被当散文外发 |
| 3 | **附件上传后未被确认** | `/status.driver.attachTransport = { at, fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276 }`；同时 `GET /__webcode/attach-entry` 明确说入口是好的：`available:true`、`inputs:1`、`accept` 含 `.md,.txt,.json,.log`、`multiple:true`，但 **`previewHits: []`** | 两个只读端点各读一次。结论：「入口在」与「上传后网页会不会渲染出可见附件」是**两件事**——后者只能真的传一次才知道，于是本轮加了只上传不发送的 `POST attach-probe` |
| 4 | **文本块内容与增量通道不一致** | 用户报「有些 markdown 渲染有些不渲染」。本轮护栏用脚本驱动构造「权威全文 ⊃ 增量通道」并断言 `block-end.text` 与 Σ `text-delta` 逐字一致；实测在「调用块**之后**还有散文、而那段散文只在权威全文里」时，块内容少一段 | `node --test test/markdown-block-integrity.test.mjs`；根因：收尾的 `stripProtocolText(finalText)` 在协议起点**截断**，拿不到调用块之后的散文，紧邻的补发判据于是恒为空 |

**另有一条同族根因（本轮由护栏实测抓到，已修）**：`lib/index.js` 的
`relay.submit(...).catch((err) => { turn.invalidate?.(); … })` —— 旧写法**无条件**作废上层
发送游标：**任何**一轮失败（含 `WEB_NO_PROGRESS` 这种「内容已经发出去、只是网页没吐完」
的失败）都会让下一轮 `fresh = true`，把整段首轮提示词重发一次，并且**再开一个新网页对话**。
护栏实测（脚本驱动、同一 `apply` 实例三轮）：`fresh` 序列 `[true,false,true]`，第三轮
`messageChars = 150,072`（真机同级读数是四十万级）。修法与驱动侧那条**同因不同层**：
根因 1 修的是「失败之后的下一轮还能不能续上」，这条修的是「失败本身就让游标归零」——
现在按错误码白名单决定是否作废（见修复清单 #10）。

### 二、本轮修复清单（每条都有对应护栏）

| # | 修复 | 位置 | 护栏 |
| --- | --- | --- | --- |
| 1 | **落地即落盘**：导航一落到网页会话就 `rememberConversation`，**不等整轮成功**；轮次成功后 id 变了再覆盖并计 `conversationReplacedCount` | `lib/browser-driver.js` 的 `noteLanded()`（runTurn 内两处调用点） | `test/session-continuity.test.mjs` **①c**（行为级：本轮失败也必须已在磁盘上）+ **⑨**（结构判据） |
| 2 | **URL 自愈**：槽为空但页面此刻停在某个网页会话上 ⇒ 补齐并落盘，`source:'url-heal'` | 同上 | `test/session-continuity.test.mjs` **①b**（`sessionSlot` 三态） |
| 3 | **重建节流**：同一会话键连续 `WEB_SESSION_LOST` 时，第二次在**发送之前**就抛 `WEB_SESSION_REBUILD_THROTTLED`（避免「重建→失败→再重建」雪崩，每次四十万字符） | `lib/index.js` 的 executor `WEB_SESSION_LOST` 分支 | `test/session-continuity.test.mjs` **⑥**（断言第二次这一轮只发 1 次，重放被挡在发送之前） |
| 4 | **只读读数 `sessionSlot` + 控制面动作**：`status().sessionSlot = { webSessionId, at, source:'store'\|'url-heal'\|'none' }`；`GET /__webcode/session-slot` 可随时核对 | `lib/browser-driver.js`、`lib/web-control.js` | `test/session-continuity.test.mjs` **①b / ⑦** |
| 5 | **标记词形宽容**：`DSML\|DSH\|DS`（大小写不敏感）+ 允许标记与标签名之间无空格；**保守判据**：只对「标记 + 已知标签名」动手，散文里的裸 `<calls>` / `<invoke name="x">` 一律不动 | `lib/agent-preset.js` 的 `normalizeDsml` / `findProtocolStart` / `partialProtocolAt` | `test/marker-typo.test.mjs` **10 项**（三种词形正向 + 4 条反向安全线） |
| 6 | **教学补一句禁令**：标记必须完整写成 `｜｜DSML｜｜`，不要写成 DSH 或其它缩写（源码里该字符用码位现造） | `lib/agent-preset.js` 的 `TRAIN_NOTE_DSML` / deepseek 教学 | 同上的夹具形态断言（`test/dsml-real-reply-regression.test.mjs` 的首 12 码点） |
| 7 | **附件探针**：`POST /__webcode/attach-probe {text}` **只上传、绝不发送**，返回 `{ ok, evidence, selector, domSnippet, cleaned, chars }`；`cleaned:false` 如实报（附件可能仍留在输入框里） | `lib/browser-driver.js` 的 `probeAttachment` + `lib/web-control.js` 的动作 | `test/attach-probe-contract.test.mjs` **5 项**（含「全程 0 次发送」与「未确认不粉饰」） |
| 8 | **投递形态开关**：`promptTransport: 'attach' \| 'inline'`（默认 `attach`；`inline` = **永远纯文本**，逐字回到旧行为）；设置页新增单选，面板显示**当前生效值**与最近一次实际投递结果 | `lib/index.js` DEFAULTS + 两个构造点的读取函数、`lib/browser-driver.js` 的 `promptTransportNow`、`lib/settings-page.js`、`lib/client.cjs`、`lib/web-control.js` 的 `attach-status` | `test/settings-transport.test.mjs` **6 项**（判据层 / 配置层 / 接线层 / 控制面层） |
| 9 | **文档归位**：根目录 `PLAN*.md`（4 份）与 `REPORT.md` 移入 `.local-plans/` 并加 `.gitignore` 规则；`doc/` 里对 `PLAN-0.14.0-HANDOFF.md` 的 12 处引用改指新路径；新建 `ROADMAP.md` / `REQUIREMENTS-TASKBOARD.md` / `PROMPT-ENGINEERING.md` 并补进索引 | `.local-plans/`、`.gitignore`、`doc/README.md`、`doc/*.md` | `check-repo-hygiene.mjs`（索引死链）+ `grep` 自查「还有没有指向旧路径的行」（0 条） |
| 10 | **按错误码决定是否作废发送游标**：新增 `CURSOR_INVALIDATING_CODES` 白名单，未列出的码（含空 code）**保留游标**、下一轮继续发增量，不再整段重建 | `lib/index.js` 的 `relay.submit(...).catch(...)` | `test/session-continuity.test.mjs` **④**（失败一轮后第三轮仍 `fresh=false` 且字符数 < 5,000） |

### 三、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 本轮新增 5 个护栏文件 | `session-continuity` **11/11**、`marker-typo` **10/10**、`markdown-block-integrity` **5/5**、`attach-probe-contract` **5/5**、`settings-transport` **6/6** —— 合计 **37/37 全绿**（逐文件跑，2026-09-17 实跑） |
| **全量单测（逐文件跑，lead 亲跑）** | **57 个文件 / 715 项通过 / 0 项失败 / 0 个失败文件**（`Get-ChildItem test/*.test.mjs` 逐个 `node --test --test-timeout=180000 <file>`，2026-09-17 22:1x 实跑） |
| **打包与装机（lead 亲跑）** | `pnpm pack` → `dsh-webcode-bridge-0.16.4.tgz`（410,808 字节）；`verify-pack` **36/36 逐字相同 + 接线完好**；`install-profiles` 装入 `profiles/web` 与 `profiles/headless` **均为 v0.16.4**；8 个改动文件 `sha256` 前 12 位与工作树**逐一相同**（index/browser-driver/agent-preset/idle-window/web-control/settings-page/client/dsml-repair）。**运行中的进程仍是 0.16.3——重启后才加载** |
| `lint-comments.mjs` | **error 0 / warn 0**，exit 0（**109 个文件**，2026-09-17 实跑） |
| `check-repo-hygiene.mjs` | **PASS**（BOM / 索引死链 / Node 版本三条全绿） |
| `check-ledger.mjs` | **PASS**（version 0.16.4 / testFiles 57/57） |
| 反向验证（**%TEMP% 等价拷贝**，工作区 lib/ 不留任何改动） | ① `session-continuity`：把 `noteLanded` 里落盘那一行等价去掉 → **①c 与 ⑨ 变红**（「失败的一轮之后会话槽是空的」）；② `settings-transport`：删掉 `if (o.transport === 'inline') …` 那一支 → **①变红**（mode 变回 attach）；③ `marker-typo`：词形宽容回滚成只认 DSML（`(?:DSML\|DSH\|DS)` → `(?:DSML)`，2 处）→ **②③⑨ 变红**（「解出 2 条调用（应为 3）」）；④ `markdown-block-integrity`：收尾不再把末段补发成 `text-delta` → **①②③⑤ 变红**（「下标 0 的块内容与 Σ text-delta 不逐字一致」）；⑤ `session-continuity`：把重建节流条件改成恒不成立 → **⑥ 变红**（「没有拿到 WEB_SESSION_REBUILD_THROTTLED，实际 WEB_SESSION_LOST」）。五条原始输出见本轮实施报告 |
| 一条**环境**读数（不是产品缺陷） | 「真 HTTP + 真 `apply()`」的护栏在 `--test-force-exit` 下会被判**文件级红**：两条断言都 ✔，进程收尾却报 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c line 94`。实测：`wiring-roster` 带该开关 **3/3 复现**、**不带则 2/2 全绿且进程自然退出**；把收尾改成 `await` + `closeAllConnections()`、或让响应带 `connection: close`、或加一个收尾 `setTimeout` 都**不能**消除 ⇒ 触发条件是这个开关本身（Windows + Node 24 的退出路径竞态）。因此 `wiring-roster` / `session-continuity` / `attach-probe-contract` / `settings-transport` 请用 `node --test <file>` 跑，不加 `--test-force-exit` |

### 四、取证 vs 推断（分开写）

**取证**（第一节四条 + 本节读数）：457 / 8 次的标记计数、navTrace 三次同形、
`attachTransport` 与 `attach-entry` 的两组字段、脚本驱动下 `fresh` 序列 `[true,false,true]`。

**推断**（尚无直接读数）：

1. 「块内容不一致」与用户那句「有些 markdown 渲染有些不渲染」是**同一件事**——本轮只证明了
   两条通道的字节会不一致（护栏可复现），**没有**真机截图或 DOM 读数把二者对上；
2. 会话槽丢失在别的站点（GLM/z.ai）是否同形，**没有读数**：本轮只看了一个 deepseek 会话；
3. 根因 2 的「457 次」来自**一个**会话的 dump，不能外推成「模型整体漂移率」。

### 五、仍未修完（不假装通过）

1. **0.16.4 未打包、未装机、未重启**：因此本轮全部读数都是**离线**读数；
   三条根因的真机验收（`ROADMAP.md` P1）必须在装机重启之后做。
2. `README.md:88` 仍写着「根目录 `PLAN*.md`、`REPORT.md` 是本地私有留痕」——
   它们本轮已移入 `.local-plans/`；该文件不在本轮的写范围内，留给下一轮同步。
3. **`--test-force-exit` 的环境噪声**（见 §三最后一行）：它不是产品缺陷，但会让
   「真 HTTP + 真 `apply()`」的护栏在全量跑里多出文件级红。跑这些文件时**不要**加该开关。

**已修完的两条（本轮内闭环，读数在上面）**：
`session-continuity` ④（上层游标归零 ⇒ 现在按 `CURSOR_INVALIDATING_CODES` 白名单判定）与
`markdown-block-integrity` ③（调用块之后的散文只在权威全文里时被丢掉 ⇒ 收尾已补发）——
两条判据都**没有放宽期望值**，是实现在它们上面改绿的。

## 0.16.3（已打包 / 已装 / 已重启生效）—— 三条真机读数：网页原话解得出、看门狗分相位、超长文本有上限

**用户原话**：「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了你说是
没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复……另外请你解决一个问题，
现在提示词有误参考的最佳工程实践？deepseek？然后是发送的纯文本太长了！」

本轮报错（用户逐字贴出）：

```
本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished） — 本轮已中止，可重试
```

### 一、三条真机读数（**取证**：每条都写清取法与数字）

| 读数 | 取法 | 数字 |
| --- | --- | --- |
| 网页原话能解出几条调用 | `POST /__webcode/history {"sessionId":"971db3e8-7ea6-4f63-ad41-c14bb44a6d27"}` 取 assistant 消息 → 逐字落成 `test/fixtures/dsml-real-14-step5-grep-pwsh.txt` → `parseAgentReply(text, {tools})` | **1204 字符 → calls=3（grep / pwsh / pwsh）、diagnostics=[]** |
| 失败会话那一步的跨度 | 解 `.dsh/sessions/…session-dff3edf7…/session.v3.jsonl.zstd`（29 帧） | turn1 **step5：18:41:59 → 18:43:51，112s 零事件**；同行 step1-4 **每步都有事件**（工具调用 2-4 条） |
| 发进网页的纯文本 | `POST /__webcode/history` 的 user 消息 | **127,888 字符**（工具教学 38,279 + 会话 transcript 89,609） |
| 首轮提示词总量 | `GET /__webcode/preset` | **409,555 字符** |

结论：**问题 1「真实工具调用被丢」在这一条物证上已经修好**（前 13 份夹具另见 §0.16.2）；
本轮报错与它**不是同一件事**——`WEB_NO_PROGRESS` 是看门狗开火，把「网页还在 prefill、
还没开口」当成了「网页不说了」。

### 二、本轮修复清单（每条都有护栏）

| # | 修复 | 位置 | 护栏 |
| --- | --- | --- | --- |
| 1 | 看门狗窗口**分相位**：首个事件之前 + 驱动在忙 → 常规 × 倍数；已开流 / 链路没跑起来 → 照旧快报 | `lib/idle-window.js`（`idleWindowDecision`）、接线 `lib/index.js` 的 `nextWithIdle()` | `test/idle-window.test.mjs` 17 项 + `test/watchdog-first-byte.test.mjs` 9 项 |
| 1b | 相位窗口给**驱动整轮预算**留余量：`totalBudgetMs` ⇒ 窗口 ≤ 预算 − max(1s, 10%)，被压过置 `capped:true`（否则 240s 与整轮 240s 同值赛跑，报错会退化成没有页面现场的 `web turn timed out`） | `lib/idle-window.js` | `test/idle-window.test.mjs` ⑧/⑧b/⑧c/⑧d/⑧e |
| 1c | 三层超时的**源码级顺序**判据（中继外层 > 驱动整轮 > 看门狗窗口） | `lib/index.js`、`lib/relay.js` | `test/timeout-order.test.mjs` 5 项 |
| 2 | 驱动现场读数进 `/status`：`lastActivityAt`、`domReplyChars`、`attachTransport`；超时报错带出前两者 | `lib/browser-driver.js` 的 `status()`、`lib/index.js` 的看门狗文案 | `test/watchdog-first-byte.test.mjs` ⑤ |
| 3 | 附件上传函数的**结构修复**：`uploadTextAttachment` 从 `uploadImages` 的 `if` 块体内移出（0.16.2 的形状靠函数声明提升侥幸能跑，相邻重构会变成静默回落 inline） | `lib/browser-driver.js` | `test/upload-attachment-structure.test.mjs` 4 项（含扫描器自检，防「框空 body」式假绿） |
| 4 | 附件**尺寸上限**：`attachMaxChars` 默认 1_500_000；超上限保**尾部**截断并写明「已省略前 N 字符」，绝不静默丢内容 | `promptTransportPlan` + `runTurn` | `test/prompt-transport-attach.test.mjs` 9 项 + `test/attach-callsite.test.mjs` 6 项（调用点真的调到、`attachTransport` 成败都留痕） |
| 5 | 真机回复**回归夹具 14**（网页原话 1204 字符 → 3 条调用、参数逐字相等、diagnostics 空） | `test/fixtures/dsml-real-14-step5-grep-pwsh.txt` | `test/dsml-real-reply-regression.test.mjs` 11 项 |
| 6 | `DSML_BAR` 注释纠错：该常量是 `String.fromCharCode(0xFF5C) × 2`，注释按真机码点读数改写 | `lib/agent-preset.js` | 夹具 14 的首 12 码点断言（源码里用码位现造，不粘贴该字符） |

### 三、取证 vs 推断（**分开写**，别混）

**取证**（§一 的四条读数都属于这一栏，取法逐条写在表里）：网页原话 1204 字符、calls=3、
diagnostics 空；失败会话 step5 跨度 112s 零事件、step1-4 每步有事件；发进网页的纯文本
127,888 字符；首轮提示词 409,555 字符。驱动新增的三个字段可直接在 `GET /__webcode/status`
核对。

**推断**（尚无直接读数，缺哪一条写在里面）：

1. 「12.8 万字符输入 ⇒ prefill 超过 120s」是**推断**：直接量到的只有「112s 零事件 + 页面
   `busy` + 同一轮其它步骤事件正常」。**首字节第几秒到达，没有任何读数记录过**——新报错文本
   带 `最近驱动活动` / `页面已有 N 字回复未回传`，就是为了让**下一次**能量到它。
2. 「网页那侧在 18:43 之后是否真的产出了完整答复」**未被证实**：只有那一刻的**页面 DOM
   读数**（`domReplyChars` / 截图 / 网页会话里的 assistant 条目）能证实，这次没有落盘。
   桥侧「零事件」只证明**捕获链没收到东西**，不能证明网页没生成。
3. 「走附件更快/更稳」**未被证实**：0.16.3 起 `attachInlineLimitChars` 默认 **60,000**
   （超阈值即走附件），但本轮**没有真机配对数据**——「真的上传成功」「模型真的读了附件」
   两条都只能在重启后由真机读数验证（见下）。

### 四、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 新增 4 个测试文件（逐文件跑） | `dsml-real-reply-regression` **11/11**、`idle-window` **17/17**、`prompt-transport-attach` **9/9**、`upload-attachment-structure` **4/4**（四个一起跑：**36/36**，退出 0） |
| 全部测试文件（逐文件跑） | **52/52 全绿，0 个失败文件**（`node --test --test-timeout=90000 test/<每个文件>`；一轮循环跑完 51 个共 **671 项通过**，`attach-callsite` 随后单独跑 6/6；2026-09-17 实跑） |
| 反向验证（**%TEMP% 等价拷贝**，工作区不留任何 lib/ 改动） | 结构护栏：拿**已安装 0.16.2** 的原文件跑 → ①② 变红（信息含「结构被破坏」）；DSML 回归：把 `normalizeDsml` 回滚成恒等 → ②③⑤⑦⑧b 变红（`calls=0`，即用户看到的那件事）；`idle-window`：四种错误改法（mid-stream 也乘倍数 / 真值判断 firstEventAt / 驱动不忙也宽限 / baseMs 不回落）分别让 ②②b③b④⑥ / ②b③b④ / ③ / ④④b⑥⑦ 变红，另三种（忽略预算 / 去掉小预算保护 / 余量置 0 造成同值赛跑）分别让 ⑧⑧d / ⑧d / ⑧⑧e 变红；`prompt-transport-attach`：三种改法（上限参与 mode 判定 / 取消默认上限 / 非法上限当默认）分别让 ①④⑤ / ①② / ③ 变红 |
| `lint-comments.mjs` | error 0 / warn 0（104 个文件，2026-09-17 实跑） |
| `check-ledger.mjs` | **PASS**（version 0.16.3 / testFiles 52/52，2026-09-17 实跑） |
| `check-repo-hygiene.mjs` | **PASS**（无 BOM / 索引无死链 / Node 版本相容，2026-09-17 实跑） |

### 五、用户需要知道的配置项（0.16.3 新增）

- **`idleFirstByteMultiplier`（默认 2）**：首个 token 之前的看门狗窗口 = 常规窗口 × 该值
  （默认 120s → 240s）。**这不是「把超时调大」**，而是把「网页还没开口」与「网页不说了」
  分成两个相位——只有「本轮还没有任何事件」**且**「驱动报告本轮仍在忙」这一格才乘倍数。
  **设 1 即逐字恢复旧行为**；按自己网页的启动速度调即可。
- **`attachInlineLimitChars`（默认 60,000）**：超过这个字符数就把提示词改走**附件**投递
  （真机依据：127,888 字符纯文本的一轮，step5 有 112s 零事件——网页在 prefill，被 120s
  看门狗判死）。普通单轮增量（几十~几千字符）仍然逐字走 inline，行为不变。
  **写 0 = 关闭**，逐字恢复 0.16.2 行为。附件投递途中任何一步失败（没有上传入口 /
  页面没出现附件）都会**回落 inline**，并把结果记进 `/status` 的 `attachTransport`。
- **`attachMaxChars`（默认 1_500_000）**：附件投递的尺寸上限；超过就保留**尾部**再上传，
  并在文件开头写明「已省略前 N 字符」。真机最大一轮 409,555 字符，离上限还很远。
- **相位窗口与整轮超时的关系（无需配置，但要知道）**：宽限后的相位窗口原本是
  `120s × 2 = 240s`，与驱动整轮预算 `requestTimeoutMs`（默认 240s）**同值**——谁先开火由
  事件循环决定，而整轮超时的报错**没有相位、没有页面现场**。现在相位窗口被压到整轮预算的
  90%（默认 240s → **216s**），保证先开火的是信息更全的那个报错；`capped:true` 就是
  「这个窗口被预算压过」的标记。

## 0.16.2（已打包 / 已装 / 待重启）—— 三个真机问题：调用被丢、提示词教错、纯文本 40 万字符

**用户原话**：「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了
你说是没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复……另外请你
解决一个问题，现在提示词有误参考的最佳工程实践？deepseek？然后是发送的纯文本太长了！」

---

### 一、取证方法：第一次拿到「网页实际发出的字节」

本轮与以往所有修复的根本区别是**取证方向**。历史修复反复不中的共同点，是只有 harness
侧的读数（「正文停了」「只有思考」）。这轮用桥自己的**只读控制面**取网页那一侧的原话：

```powershell
POST http://127.0.0.1:8931/__webcode/history  body: sessionId
node .tmp/capture-dsml-fixtures.mjs      # 逐字落成 test/fixtures/dsml-real-*.txt
```

13 份真机夹具，网页实际发出的是 **DeepSeek 原生 DSML**（标记字符是全角竖线）。

### 二、问题 1：真实工具调用被丢（红基线可复现）

| 夹具 | 形态 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| dsml-real-13 | 闭合标签**连名字都省掉** | calls=0 | calls=2 |
| dsml-real-7 | **漏写 invoke 开标签**，直接 parameter 起写 | calls=0 | calls=2 |
| 其余 11 份 | 正常 | 正常 | 正常 |

**这正是「说有工具调用、又说没有正文」**：探测命中、解析为 0 条 → 协议被 proseSafeEnd
整段扣住 → 只剩散文或空 → 交回 TOOL_CALL_UNPARSED。

修法：新增 `lib/dsml-repair.js` 的 `resolveNamelessClosers`，在 `normalizeDsml` **之前**
跑栈式还原（无名闭合补名、缺外壳补空名壳），并让 invokeOpenRe 接受空名字。
**保守判据**：只对带 DSML 标记的标签动手；散文里的裸 parameter 一律不动。

护栏：`test/dsml-native-close.test.mjs` **22 项**（13 份夹具逐份 + 9 条判据，含 6 条反向安全线）。

### 三、问题 2：提示词在对抗模型的既有先验

旧提示词教「标签包裹 + 裸 JSON」。**13/13 份真机夹具里模型一次都没用过它**
——它用的是本网页原生的 DSML。即提示词让模型做一次格式翻译，翻译中途的形态漂移正是
问题 1 那两族的来源。

修法：deepseek 站点改教**原生 DSML 骨架**，三处同源（首轮教学 / 首轮传输协议 / 增量轮
再教学），由 DSML_ONE_LINE 与 dsmlSkeleton() 单点定义。**其它站点逐字不变**。

### 四、问题 3：纯文本 409,555 字符

实测（`GET /__webcode/preset`）：

```
TOTAL 409,555
  工具教学（preset）        38,241  ( 9.3%)
  会话 transcript         370,985  (90.6%)   ← 其中 DSH 系统指令 279,223
  传输协议                     329
```

修法：纯函数 promptTransportPlan 决定 inline / attach；超阈值且有附件能力时把长文本作为
.md 附件上传，composer 只发**短指令**；任何一步不成立（无上传入口 / 附件未确认）
→ 回落 inline。**默认 0 = 关闭**，即不配时行为与 0.16.1 逐字相同。

风险已写进代码注释：上传是有副作用的动作（可能撞风控）、模型未必读附件（因此正文里明确
要求它先读）、附件确认依赖可见预览节点（站点改版即失效，走既有 ATTACH_NOT_CONFIRMED）。

护栏：`test/prompt-transport.test.mjs` **8 项**（3 正向 + 5 反向安全线）。

### 五、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| 全部 45 个测试文件（逐文件跑） | **45/45 全绿，0 失败** |
| `test/dsml-native-close.test.mjs` | **22/22**（13 份真机夹具全解析、无泄漏） |
| `test/prompt-transport.test.mjs` | **8/8** |
| `lint-comments.mjs` | error 0 / warn 0（96 个文件） |
| `check-ledger.mjs` | PASS（version 0.16.2 / testFiles 45/45） |

### 六、一次被自己的护栏抓住的漂移（记下来）

改提示词时顺手把一句**所有站点共用**的话从「多个工具调用代码块」改成「多个工具调用」，
`prompt-variants.test.mjs` 的「默认路径零位移」断言立刻变红——它逐字比对 0.14.7 基线。
**已回退**。这正是那条护栏存在的意义：默认路径的任何位移都必须是有意的、有据的。

## 0.16.1（已打包 / 已装 / 未重启）—— 桥自有 Team/任务数据层：磁盘回落让「卸载 AgentTeams」成立

**用户原话的第三件事**：「将 agent team 卸载」。0.16.0 只做完了左栏入口，这一轮做的是
**卸载的前提**——没有它，卸载等于连面板一起卸掉。

### 一、为什么「读官方服务」这一条链本身就挡住了卸载

桥的 Team / 任务板两个面板从 0.15.0 起只读官方 `agentTeams` 服务
（`lib/roster.js` 的 `projectTeam` / `projectTasks`）。这条链有一个结构性后果：
**那个包一旦不在，面板永远是空的**。于是「取代 AgentTeams」在实现上无从落地——
用户看到的是「卸载之后面板也没了」，读起来像桥坏了。

### 二、第二个来源不是「绕开官方读私有格式」

AgentTeams 自己就把磁盘当真相来源。第三方实现（`@nanmicoder/dsh-agent-teams`）的
`lib/snapshot.js` 开头逐字写着：

> read the durable team files (**the truth source**) and enrich with live subagent
> activity, so the panel always reflects the on-disk state even when a model skipped
> a tool "ritual"

即：**运行时 activity 是叠加在磁盘事实之上的**，磁盘才是底。桥读的是这份公开约定的
落盘格式（`.agent-teams/<teamId>/team.json`），与官方服务读的是同一份文件，
不存在第二套格式、也没有私有字段。

### 三、优先级与错误口径（刻意如此）

新增 `lib/team-state.js`（纯函数 + 只读 fs），`lib/roster.js` 改为**双来源分派**：

| | 行为 |
| --- | --- |
| 官方服务可用 | 用服务（它多给实时 `activity` 与官方算好的 `ready`），`source: 'service'` |
| 服务不可用、磁盘有本会话的团队 | 用磁盘行，`source: 'disk'`，另带 `serviceError` 说明服务为何不可用 |
| 两边都读不到 | 报**服务那一侧**的原因（主来源），`source: null`，磁盘原因放 `diskError` |

**为什么错误口径要这样**：既有的错误字符串（`caller-not-live` /
`agentTeams-service-has-no-listMembers` / `no-session-id` …）逐字不变，因此既有护栏与
用户读到的解释都不受影响；磁盘那一侧的细节另开字段，不覆盖主来源的结论。

### 四、三条「不造假」的具体落点

1. **不跨会话张冠李戴**。只认 `captainSessionId` 与当前会话**逐字相同**的团队；磁盘上
   有别人的团队时如实报 `no-team-for-this-session: N-other-team(s)-on-disk`，绝不拿它
   顶替——这正是 0.15.3 那个「读到别人的 lead」缺陷的同族病根。
2. **不算 `ready`**。磁盘行**不带 `ready` 键**，交给 `task-graph.js` 按官方判据现算并标
   `readySource: 'computed'`。官方给了就不重算这条判据已经在那一层，在这里再算一遍
   就是第二份真相。
3. **不猜工作区根**。`cwd` 只从 `sessions.get(sessionId).header.cwd` 取；拿不到就返回
   `no-session-cwd`，而不是 `path.join(undefined, …)` 拼出一个**看起来正常但永远读不到**
   的路径。

另外：`archive/` 被排除（那是已删除团队的归档，否则删掉的团队会重新出现在面板上）；
`inScope`/`dependencies`/`attempt`/`assignee` 分别映射成面板已有的
`writeScopes`/`blockedBy`/`revision`/`ownerName`，同一份 UI 消费两边。

### 五、界面上必须能看出「数据从哪来」（新增 `teamSource` / `tasksSource`）

磁盘回落时成员**没有实时 activity**，于是「空闲」会被读成「真的空闲」，而不是
「这里没有实时数据」。因此 `projectRoster` 新增 `teamSource` / `tasksSource` 两个标注，
两个面板各渲染一行来源说明（`来源：AgentTeams 服务` / `来源：磁盘状态（AgentTeams 未提供实时数据）`）。
来源本身也是一条状态——这是本仓库「不造假状态」纪律的直接延伸。

### 六、实际卸载动作（profile 层）

`~/.dsh/profiles/web/package.json` **两处**同时摘掉第三方 `@nanmicoder/dsh-agent-teams`
（`dependencies` + `dsh.profile.bundles`），并顺手修掉一个真隐患：
`dsh-webcode-bridge` 的依赖路径还钉在 **0.15.11 的 tgz** 上，而工作树早已 0.16.x——
那是「改了没生效」纪律下最容易复发的一处。改前已备份
（`package.json.bak-20260917-115436`）。

**保留官方三个包**（`dsh-experimental-agent-team{,-profile,-tool-agent-team}`）：
桥的回落链只在服务不可用时接手，官方服务在时仍是首选；摘掉它等于主动放弃实时
activity。用户要卸载的是**重复实现**，不是官方那一套。

### 七、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `node --check`（`team-state.js` / `roster.js` / `client.cjs`） | 三个都 exit 0 |
| 全部 41 个测试文件（逐文件跑） | **41/41 全绿，0 失败** |
| `test/roster.test.mjs` | 27/27（含新增键集断言与来源为 null 的断言） |
| `test/client-render.test.mjs` | 33/33 |
| `check-ledger.mjs` | PASS（version 0.16.1 / testFiles 41/41） |
| `lint-comments.mjs` | error 0 / warn 0（88 个文件） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / Node 版本） |
| `verify-pack` | **31/31 逐字相同** + 接线完好（新增 `team-state.js` 后从 30 涨到 31） |
| 安装 | web profile **v0.16.1**，`team-state.js` 在位，`nanmicoder` 已从 deps 与 bundles 消失 |

### 八、一次自己踩到的坑（记下来）

第一次 pack 0.16.1 之后**又改了 `client.cjs`**（加来源标注），tarball 于是落后于工作树——
正是 `doc/verify.md` 里 0.14.4 记过的那个陷阱。`verify-pack` 一跑就照出来（当时若跳过这一步
就会装上一份半旧代码）。已删除重打，第二次 31/31 通过。**结论不变：pack 之后任何改动都必须
重打 + 重验，不能只看命令退出码。**

### 九、仍未做真机验收（不假装通过）

**重启 DSH 之前，以下四件事都只是静态证据**：

1. 左栏「新开对话」下方是否真的出现任务板入口（0.16.0 的 `sidebar.panellist`）；
2. 点它是否切到中央列任务板（`main` 座位 key 与 id 同名）；
3. 卸载第三方包之后，Team / 任务板是否由磁盘回落显示出来（`来源：磁盘状态` 那一行）；
4. 官方 `agentTeams` 服务是否照旧工作（来源应显示 `AgentTeams 服务`）。

当前进程里跑的是旧代码（0.15.9），所以第 3、4 条**必须**重启后才能看到。

## 0.16.0（已打包 / 已装 / 未重启）—— 任务板进左栏：走官方 `sidebar.panellist`，不走 DOM 注入

**用户原话**：「把任务板入口放在左栏那里固定，新开对话下方，参加 task board，然后你想办法将
team 的面板保持原地，但是做到可以取代 agent team 完好设计逻辑理念，将 agent team 卸载」。

本轮先做**能做完的那一半**（左栏固定入口），并把另一半的真实阻塞点查清（见文末）。

### 一、先说清「参考实现为什么走 DOM 注入，而这里不必」

`reference/dsh-task-board` 的 `src/client/sidebar-entry-core.ts` 开头逐字写着：

> dsh's sidebar shell exposes no slot an external plugin can register into
> (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already taken),
> so the entry row is injected between the shell's New Session button and the
> workspace browser.

**那个前提在官方这一版已经变了。** 实测 slots 目录（`cordis_inspect_query` →
`client/Slots/listSubTree`）里 `sidebar.panellist` 是存在的，契约原文是：

> Global panel icons. **Each list id addresses the matching main panel**; the sidebar
> owns the button and resolves its label from list metadata.

对比两条路线：

| | DOM 注入（参考实现） | `sidebar.panellist`（本轮） |
| --- | --- | --- |
| 按钮本体 | 自己 `createElement('button')` | **shell 画**（`PanelRow`：Tooltip、`aria-current`、选中高亮） |
| 位置 | `insertBefore` 抢，靠 `[class*="newSession"]` 模糊匹配 | shell 渲染顺序即 `logoRow → New Session → panelList → workspace`，**结构保证** |
| 重渲染 | `MutationObserver` 自愈 | React 自己管 |
| 折叠态 | 自己复刻 56px 轨道样式 | shell 给 `size: wide ? 16 : 18` |
| 键盘可达 | 要自己补 | 天生正确 |
| 官方改 class 名 | 静默插错位置 | 不受影响 |

所以本轮**不引入那条路线**。「取代 agent-team 的设计理念」要保留的是「左栏固定入口 +
中央列面板」这个**交互结构**，而它现在能用官方一等公民的槽实现——比 DOM 注入更强。

### 二、两半必须成对（这是本轮唯一的真陷阱）

契约后半句是关键：「Each list id **addresses the matching main panel**」。侧栏行只是一个
指向 `main` 座位的按钮，点击走 shell 的 `selectPanel(id)`，而 layout service 会**校验该 key
是否已注册**：

```
layout.selectPanel: main panel "X" is not registered
```

只注册侧栏那一半 = 界面看起来正常、**点一下就报错**。因此两半的 id 与 key 必须逐字相同，
护栏也按「成对且同名」写（`★ 左栏入口：sidebar.panellist 与同名 main 座位必须成对注册`）。

### 三、改了什么

| 位置 | 内容 |
| --- | --- |
| `lib/client.cjs` 顶部注释 | 「三块界面」→「四块」，补第 4 条（左栏入口 + 同名 main 页面） |
| `lib/client.cjs` `TaskBoardPanelIcon` | 内联 SVG（16 viewBox / stroke-width 1.3 / currentColor）。**不引官方 primitives**：里面没有依赖图语义的图标，队列图标表达的是「排队等待」，会读成发送队列。**不自绘 button、不挂 onClick**——按钮与可访问名归 shell |
| `lib/client.cjs` `TaskBoardMain` | 主列页面容器（`.hwb-main` 滚动 + `h1` 页内标题），内部**复用同一个 `TaskBoardPanel`**——同一语义只画一次，否则「右栏说被阻塞 2、主列说被阻塞 3」迟早出现 |
| `lib/client.cjs` 注册处 | `sidebar.panellist`（`id=webcode-tasks-panel`、`order=40`、`label` 为 thunk）+ `main`（`key` 与 id 逐字相同） |
| `lib/client.cjs` 样式 | `.hwb-main` / `.hwb-main-head`；`box-sizing` 显式写，少它 padding 会把容器撑出可视区、底部永远滚不到 |
| `test/client-render.test.mjs` | 桩新增收 `sidebar.panellist` 与 `main` 两类登记并回传；新增 2 条用例（成对注册 / 图标不得自绘 button） |

### 四、本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `node --check lib/client.cjs` | exit 0 |
| `test/client-render.test.mjs` | **33/33 通过**（新增 2 条） |
| `check-ledger.mjs` | PASS（version 0.16.0 / testFiles 41/41） |
| `lint-comments.mjs` | error 0 / warn 0（87 个文件） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / Node 版本） |
| `test/regression.test.mjs` | 53/53 通过（547 s，本机慢是已知的） |
| `test/mirror.test.mjs` | 7/7 通过（首轮批次里那次失败是 fetch 到本地端口的瞬时错，`git stash` 后在**干净树**上重跑仍 7/7，已排除本轮改动） |

### 五、没做完的那一半，以及它卡在哪（不假装通过）

**「将 agent team 卸载」本轮没有执行。** 查清了事实，但它不是一个「改一行配置」的动作：

1. **桥的两个面板依赖官方 `agentTeams` 服务**，不是依赖第三方包。`lib/roster.js` 的
   `projectTeam` / `projectTasks` 读的是 `ctx.agentTeams` 的 `listMembers` / `listTasks`。
   该服务的注册点是 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js:96` 与 `:1680`
   的 `super(ctx, "agentTeams")`。
2. **当前 profile 里同时装了两套重叠实现**（`profiles/web/package.json`）：
   `@deepseek-ai/dsh-experimental-agent-team*`（官方，0.1.5-alpha.2）与
   `@nanmicoder/dsh-agent-teams`（第三方，0.1.18）。两边注册的工具名**故意重叠**——
   官方 profile 层的 `cordis.patch.yml` 注释原文就是「remove the global continuable-child
   controls before the scoped Team tools register the overlapping `list_agents`、
   `send_message`、`interrupt_agent` names」。本会话的工具表里两套名字同时在场。
3. 因此**卸载第三方包之前必须先确认桥不依赖它的任何东西**。已知第三方包提供的是
   `agent_teams_*` 工具（`lib/tool-names.js`）与一个 `shell.overlay` 悬浮面板
   （`lib/client.js:3684`），**不提供 `agentTeams` 服务**；但「工具名从哪来」这条链
   在真机上还需一次核对（会话工具表里 `agent_teams_*` 与官方的 `spawn_teammate` /
   `team_task_*` 并存，两套都在）。
4. 卸载本身要改 profile 的 `dependencies` + `dsh.profile.bundles` 并重装——那是**环境
   变更**，按仓库纪律（`doc/verify.md`）应在重启后做真机验收，且要先确认左栏入口在真机
   真的渲染出来（本轮只到单测与源码闸门，**未做真机目视**）。

**下一步（下一轮该做的）**：打包 0.16.0 → `verify-pack` → 装 profile → 重启 → 目视
左栏「新开对话」下方是否出现任务板入口且点击能切到中央列 → 再据实决定卸载第三方包的
改动清单。

> **2026-09-17 三次漂移修正（第 5 次）**：上表此前写着「工作树 0.15.9 / 已装 0.15.9 /
> 只有 0.15.7 与本轮 0.15.9 未推送」，且 `check-ledger` 实测**红**（`package.json`
> = 0.15.11 vs 台账 0.15.9）。更严重的是：**0.15.10 与 0.15.11 两轮工作在本文件里
> 一个字都没有**——同一毛病第 5 次出现（正文补在下面）。本轮还发现
> `client-server-contract.test.mjs` 因多注册了一条死路由而**一直红着没人知道**，
> 因为台账写的是「40/40 全绿」而那份读数是旧轮次的。修法与判据见 §0.15.11。
>
> **2026-09-16 二次复核修正（第 4 次漂移）**：上表此前写着「已装 0.15.6 / 运行 0.15.6（需重启）」
> 与「0.15.4～0.15.7 全部未推送」，**三项均过期**——实测**已装且正在运行 0.15.7**，
> 且**只有 0.15.7 未推送**。同一次复核还发现 `long-term-issues.md` 的 `一览表`
> **漏登记 #19、#20**（正文有、表里没有）。完整诊断见
> [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md)。
>
> **第 3 次修订（2026-09-16）**：上表此前逐字写着「工作树 0.15.3 / 已装 0.15.3 / 运行进程仍是旧的 /
> 35 个测试文件」，**四行全过期**，且 0.15.4、0.15.5、0.15.6 三轮工作在本文件里**没有任何段落**
> （同一毛病第 3 次出现）。本次一并补齐，并把「版本号与测试文件数」的核对方式写进
> `doc/review-guide.md` 的收尾清单——**靠自觉的记账已经失败三次，不能再只靠自觉**。
>
> **本机跑测试的前提（2026-09-16 实测，必须知道）**：沙箱下的 `%TEMP%`
> 是 ACL 受限目录，`mkdtempSync(os.tmpdir())` 一律 **EPERM**，会让
> `regression` / `tool-loop` / `wiring-roster` 三个文件假失败。
> 把 `TMPDIR`/`TEMP`/`TMP` 指到工作区 `.tmp` 后 **39/39 全绿**。
> 这是环境前提，不是回归——已记入 `long-term-issues.md` #10。

## 2026-09-17 CI 全红修复（无产品代码改动）—— 三条独立红因，一条新的机器判据

**用户报的是「CI 在 GitHub 上一直是红的」。** 实测 run `35137367183`（`6bcba7c`）四条腿
**全红**，且**红在两处不同的地方**——这是先要看清的事：

| 腿 | 红在哪一步 | 退出码 |
| --- | --- | --- |
| `ubuntu-latest, node 20` | **第 5 步「安装依赖」** | 1（测试一步都没跑） |
| `windows-latest, node 20` | **第 5 步「安装依赖」** | 1（同上） |
| `ubuntu-latest, node 22` | 第 9 步「reference 来源表一致」 | 1 |
| `windows-latest, node 22` | 第 9 步「reference 来源表一致」 | 1 |

即：Node 版本是**一个**变量，`gen-reference-index.mjs` 是**另一个**。三条根因：

### 一、Node 20 那两条腿跑不起来（`ci.yml` + `engines.node`）

日志原文（`ubuntu-latest, node 20`）：

```
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Process completed with exit code 1.
```

根因不是「Node 20 有回归」，而是**两处版本声明互相矛盾**：`package.json` 的
`packageManager` 钉的是 `pnpm@11.25.0`（要求 Node ≥22.13），矩阵里却放着 Node 20。

**这一条此前被一个错误的结论掩盖着**：`ci.yml`、`doc/ci-cd.md` §3.2、`CONTRIBUTING.md` ②
三处都写着「Node 20 上 `pnpm test` 会因 glob 失败」，并据此给 Node 20 写了一段
「用 bash 展开 glob」的专用命令。那段分流**从来没有被执行过**——失败在它之前。
一个为错误前提写的补丁，恰好让人不去看真因。三处文字已全部改正。

修法（三者对齐）：`engines.node` → `>=22.13`；矩阵 → `[22, 24]`；删掉 glob 分流，
两平台四条腿跑**同一条** `pnpm test`。

### 二、`gen-reference-index.mjs --check` 自己就是坏的（退 2，不是退 1）

本机复现：

```
[ref-index] 脚本自身失败：ReferenceError: README is not defined
    at main (scripts/gen-reference-index.mjs:179:24)
```

`--check` 分支引用了两个**从未定义过的**标识符（`REF` 与 `README`），一走到那里就抛
`ReferenceError`、以退出码 2 结束。它被 `ci.yml` 与 `ci-local.mjs` 同时当作**阻断闸门**调用，
所以那不是「少跑一道检查」，而是**每次 CI 都红一次、且红在一个与改动无关的地方**。
根因是 `refDirOf()` 写了却没人调用——`--root` 这个为测试留的入口是死代码。

修法：路径只经由 `refDir` 一个变量流动（`readme` 与存在性判断都用它），
`--root` 覆盖因此在 `--check` 路径上同样生效；顺带复用已算好的 `table`，
不再让「打印的表」与「校验的表」各算一遍。

### 三、闸门修好之后，它立刻抓到一条真漂移

修好 `--check` 后本机实跑，**它报出 3 条与磁盘不一致**（此前被 `ReferenceError` 掩盖着）：

- `dsh-file-attachment`（1.9 MB）在磁盘上、可克隆，但**没登记进来源表**；
- `dsh-task-board`（1.5 MB）、`dsh-archive-manager`（0.5 MB）是 2026-09-17 新解包的副本，
  同样没进表。

已重新生成 §4 的表写回 `reference/README.md`，并修正 §3 的两处过期计数
（「6 份 md」实为 7 份、「33 个 clone」实为 34 个）。`--check` 现在 **exit 0**
（校验 39 个本机存在的条目）。

### 四、`reference/` 下四个幻影 submodule（CI 收尾时会被 git 摸到）

实测 `reference/` 下有 **4 个 gitlink**（mode `160000`）：`deepseek-web-import`、
`dsh-deepseek-chat`、`opencode2dsh`、`webcode`——它们**入库了**，被 git 当成 submodule 条目。
而仓库**没有 `.gitmodules`**，于是任何 `git submodule foreach` 都会报：

```
fatal: No url found for submodule path 'reference/deepseek-web-import' in .gitmodules
```

这正是 `actions/checkout` 的 post 步骤在每条腿上都会打印的那条 warning。根因是某次
`git add reference/<clone>` 绕过了 `.gitignore:9` 的 `reference/*/`（README §2 已把这条陷阱写在案）。

修法：`git rm --cached` 这四个条目（**只动索引，不删磁盘上的克隆**）。
`reference/` 现在只剩 `README.md` 与 `local-refs/` 被跟踪——与 §2 的约定一致。

### 五、新增判据 C：CI 矩阵必须与 `engines.node` 相容

本次事故的形状是「改了一处人写的声明，没人去改另一处」。因此在
`scripts/check-repo-hygiene.mjs` 加了判据 C，直接比对 `ci.yml` 的 `matrix.node`
与 `package.json` 的 `engines.node`：矩阵里出现**低于最低声明版本**的大版本会红，
矩阵**没有覆盖**最低声明大版本也会红（只测更高版本会放过「最低版本上跑不起来」）。

已做**反向验证**：把矩阵临时改回 `[20, 24]`，闸门实测 `FAIL(2)` 并逐条指出问题；
改回 `[22, 24]` 后 `PASS`。**判据按大版本比较**，不试图复刻 semver 全套规则
（`>=22.13` 配矩阵 `22` 是允许的，setup-node 取最新 22.x）。

### 本轮验证读数

| 闸门 | 读数 |
| --- | --- |
| `lint-comments.mjs` | error 0 / warn 0，exit 0（85 个文件） |
| `check-ledger.mjs` | PASS（version 0.15.11 / testFiles 40/40） |
| `check-repo-hygiene.mjs` | PASS（BOM / 索引 / **Node 版本** 三条全绿）；`--self-test` 通过 |
| `check-commit-msg.mjs --self-test` | 10 正例 + 6 反例全部符合预期 |
| `gen-reference-index.mjs --check` | **exit 0**（修好前是 exit 2） |
| `ci-local.mjs --fast` | **7/7 PASS** |
| `bench-offline` | 14/14 通过（7 题 × 2 变体） |
| 40 个测试文件 | **40/40 全绿**。注意 `node --test` 在本机整体跑会 spawn EPERM（见「已知环境约束」），
所以这是**逐文件**跑出来的读数：`Get-ChildItem test\*.test.mjs` 逐个 `node <file>`，失败 0 |

## 2026-09-17 CI 全红修复（第二轮）—— 修完之后，**真问题才浮出来**

上一条修完后 CI 立刻跑出新结果：四条腿**仍红**，但**红的位置全变了**——这本身就是进展：
Node 20 的两条腿不再死在 `pnpm install`，`ref-index` 也不再 ReferenceError。

| 腿 | 现在红在哪 |
| --- | --- |
| `ubuntu-latest, node 22` / `node 24` | `pnpm test`：**2 条测试失败**（首次真正跑到测试！） |
| `windows-latest, node 22` / `node 24` | `ref-index`：仍报 1 条不一致 |

### 六、`ref-index` 为什么修完还红：**大小列不该参与比对**

Windows runner 报 `local-refs` 与 README 不一致，两边**只有「大小」一格不同**
（本机 1.4 MB / CI 1.5 MB）。根因是大小**不是磁盘内容的属性，而是 checkout 方式的属性**：
`local-refs/` 是唯一入库的 `reference/` 条目，里面是文本，而 `core.autocrlf` 会让同一份
文件在不同平台上落成不同字节数。于是这一格对「来源能否复现」**零信息量**，
却让闸门在干净克隆（= 只有 `local-refs` 存在）上**永远不可能通过**。

这正是文件头自己警告的那类假红。修法：`comparableLine()` 只比对**可复现的两列**
（remote 与 HEAD），大小保留在表里供人阅读但不参与判定。

已做两次验证：

- **正向**（复现 CI 条件）：只放 `local-refs` + 仓库里真实的 README → `--check` **exit 0**；
- **反向**（确认没被改瞎）：把 README 里 `local-refs` 的 remote 改成别的地址 →
  仍然 **exit 1** 并逐字打印两边差异；只改大小 → **exit 0**（正是想要的语义）。

### 七、两条 Linux 专属测试失败：**都是测试的跨平台 bug，不是产品缺陷**

这是本条最值得记的事：这两条测试**从来没有在 Linux 上跑过**（此前 CI 死在更早的步骤），
所以它们一直是「只在 Windows 上被验证过」。CI 第一次真正跑到测试，就把它们照出来了。

**① `prompt-variants.test.mjs`：零位移基线把宿主 OS 名写死了。**

断言是「模板逐字零位移」，但基线是从 Windows 抄的，里面含
`运行环境：Windows（Node v24.18.0）`。Linux 上 `platformNote()` 正确地输出 `Linux`，
断言于是报「文本发生了位移」——差异行却只有那一个词。**模板根本没变**，
变的是宿主。测试原本只归一化了 Node 版本号，漏了 OS 名。

修法：归一化**两项**（OS 名 + Node 版本）。OS 名映射在测试里**独立重写一份**，
不去调 `lib` 的 `platformNote()`——否则断言会退化成「函数等于它自己」，模板被改坏也不红。

**② `site-mount.test.mjs`：白名单测试用了 Windows 专属路径。**

它拿 `Z:\definitely\not\here` 当「白名单之外」的样本。在 Windows 上那是另一个盘符，
必然在白名单外；但在 Linux/macOS 上 `Z:\...` 只是**一个普通相对文件名**，
`path.resolve` 会把它拼到 cwd 下——**恰好落在本包树里**（= 白名单根之一），
于是先撞上「不存在」分支，报的是 `源 profile 目录不存在` 而不是 `允许范围`。

**产品行为是对的**（白名单判定本身没坏），坏的是测试选的样本路径。
修法：改用 `path.parse(os.homedir()).root` 下的同级目录，任何平台上都在 home 之外；
并加一条前提断言，防止将来有人把样本挪回 home 之内而让这条测试悄悄失去意义。

### 八、为什么这两条「测试 bug」值得单列

它们不是「CI 环境不好」，而是**跨平台承诺没有被真的验证过**：
README 说支持 Windows 与 macOS/Linux（`platformNote` 专门按平台改写指令），
但守护这份承诺的测试只在 Windows 上跑过。`doc/ci-cd.md` §7 早就写明
「两平台失败的**原因通常不同**」——这一轮正好是那句话的实例：
Windows 腿红在 `ref-index`，Linux 腿红在测试，两组原因毫无关系。

### 本轮第二轮验证读数

| 项 | 读数 |
| --- | --- |
| 40 个测试文件（本机 Windows 逐文件） | **40/40 全绿** |
| `gen-reference-index.mjs --check` | exit 0；干净克隆条件下 **exit 0**；构造漂移 **exit 1** |
| `lint-comments` / `check-ledger` / `check-repo-hygiene` / `check-commit-msg --self-test` | 全部 exit 0 |
| `ci-local.mjs --fast` | **7/7 PASS** |

### 本轮零产品代码改动

只动了 CI、脚本与文档：`.github/workflows/ci.yml`、`scripts/gen-reference-index.mjs`、
`scripts/check-repo-hygiene.mjs`、`scripts/ci-local.mjs`、`reference/README.md`、
`package/dsh-webcode-bridge/package.json`（仅 `engines.node`）、`README.md`、
`CONTRIBUTING.md`、`doc/ci-cd.md`、本文件。**插件版本号不变（仍 0.15.11）**，
因此不需要重新打包或重启。

## 0.15.11（已打代码 / 未打包 / 未安装）—— 等待药丸「同栏」由**结构**决定，不靠边距

**补记说明**：本轮与 0.15.10 的工作此前**没有写进本文件**（第 5 次漂移）。以下依据是
工作树源码里的留痕（`lib/client.cjs` 的注释、`lib/wait-stats.js` 的两条新导出）与实测读数，
不是事后回忆。

### 一、0.15.10 先做的（药丸化 + 面板）

用户报的是输入框底下那条等待信息**与官方统计药丸分成两栏**。旧实现的根因是**长度预算**：
它把「本会话 / 距上次发送 / 限流」三件事塞进一行，官方那个槽位放的是 13px 单行药丸，
一行只容得下「一个数 + 一个后缀」，于是必然换行成第二栏。

| 文件 | 改动 |
| --- | --- |
| `lib/wait-stats.js` | 新增 `composerWaitPillLabel`（单行短文案，无数据返回 `null` ⇒ 整枚不渲染）与 `waitStatDetailRows`（点击面板的明细行，对齐官方 stat-dialog 的 dl 网格） |
| `lib/web-control.js` | `waitStatsPayload` 增发 `label` / `sessionValue` / `detailRows`；`composerWaitLine`（长文案）**保留**，供旧前端与 curl 核对 |
| `lib/client.cjs` | 设置页的「累计等待发送」区块（`WaitStats`）删除——同一份数字不再两处重复 |

### 二、0.15.11：同栏改为结构决定

0.15.10 之后仍是「两条 dock 条目 ⇒ 必然换行」，因为 `conversation.composer.dock`
的每个条目都落在 composerStack（列向 flex）里。修法是**不再自建一行**：

- 新 `useOfficialStatsHost(wanted)`：用 `MutationObserver` 盯 `[data-composer-stats]`
  （官方 `ui-chat` StatsPills 的根节点），行一出现就 `React portal` 把这个节点挂进去，
  它于是成为该行里紧跟官方药丸之后的 **flex 子项**——居中、间距、换行全部归官方那条 CSS 管，
  **没有任何写死的偏移量**。
- 官方行缺席时（会话尚无任何统计：StatsPills 在 `steps===0 && !hasTokens` 时返回 null）
  回落自建一行，样式**逐字抄** StatsPills.root / stat-dialog.module.css（28px 高、
  border-radius 24px、`tabular-nums`、面板向上展开）。
- 关闭语义对齐官方 `openPill` 独占：Esc 收起 + `pointerdown` 落在自己 wrap 之外就收起
  （于是点官方任何一枚药丸时本面板随之关闭）。用 `rootRef` 而不是整行做边界，
  点自己面板内部（含滚动条）不会误关。
- 图标用 `IconQueueOutline14`（官方 primitives 无 gauge/clock，队列图标是同语义域最近的一个）。

### 三、同轮修掉的死路由（`GET wait-stats`）

`test/client-server-contract.test.mjs` 实测**红**，报 `GET wait-stats`：

```
契约：服务端每个动作至少能被一种方法触达（没有写错方法名的死路由）
  same-name action registered but method unreachable: GET wait-stats
```

**判据本身是对的**：那条 GET 是 0.15.10 顺手加的（注释写「便于 curl 核对累计值」），
但**没有任何真实消费方**——客户端只走 `api('wait-stats', {sessionId})` ⇒ POST。
实测 `POST wait-stats` 带空 body 给出**逐字相同**的累计视图：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8931/__webcode/wait-stats' -Method POST `
  -ContentType 'application/json' -Body '{}'    # → 200，rows 就是累计面
```

所以修法是**删掉那条 GET**，不是改宽测试。这与 0.15.3 的立场一致（「若确属误报，请改
本脚本的判据而不是绕过它」）——这里不是误报：多一条永不抵达的同名路由，只会让
「哪个方法是对的」重新变成需要猜的事，而那正是 0.15.3 那次 405 的同族病根。

> **为什么这条红了的测试没被台账记到**：台账那一行写的是「40/40 全绿」，但那是
> **上一个轮次的读数**。这印证了本仓库反复踩的同一个坑——**读数会过期，而闸门不会自己
> 重跑**。本轮把「逐文件跑一遍并核对 40/40」写进收尾清单。

## 0.15.10（已打代码 / 未打包 / 未安装）—— 见 §0.15.11 第一节

单行药丸 + 点击面板；设置页重复的累计区块删除。判据：`test/wait-stats.test.mjs`
（`composerWaitPillLabel` / `waitStatDetailRows` 的纯函数护栏）与
`test/client-render.test.mjs`（药丸渲染与面板交互）。

## 0.15.9（已打包 / 已装 / 已重启生效）—— 用户报的「web 内容在 harness 显示不了」：缺 `name` 的调用被静默丢弃

**用户原话**：「现在返回 web 的内容会在 harness 端显示异常/显示不了？有些可以有些不行？
请你先优先只修复这个问题，让实际 harness 能正常长期跑！这是最近有的问题，修复过却还是存在！」

### 一、先拿到「网页实际发出的字节」（这一步是全部结论的地基）

历史修复反复不中，共同点都是**只有 harness 侧的读数**（「正文停了」「只有思考」），
从来没有网页那一侧的原话。本轮用桥自己的只读控制面把头一次拿到：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8931/__webcode/history' -Method POST `
  -ContentType 'application/json' -Body '{"sessionId":"49ab6330-0fbd-4842-a7b7-e9ce5d57031b"}'
node .tmp/extract-nameless-fixtures.mjs     # 逐字落成 test/fixtures/nameless-*.txt
```

结果一句话：**模型连着两轮把调用写成 `<tool_call>{"mcp_action":"call","purpose":…,"arguments":{…}}`——没有 `name` 字段**。

### 二、根因（`lib/agent-preset.js` 的 `takeObj`）

围栏调用只认「JSON 能解析 **且** 有 `name`」，缺名直接 `return`，**连 diagnostics 都不写**
（0.15.6「丢弃不再静默」只覆盖了 JSON 解析失败那一支）。于是：调用消失 → 协议被
`proseSafeEnd` 扣住 → 只剩散文；正文全是协议时整轮被判「只有思考」，交回一句与事实
相反的 `THINKING_ONLY_NO_ANSWER`。真机读数：`turn 4 step 1 = reasoning(739)+text(59)`，
`turn 4 end reason=completed`，之后 4 个 turn 模型反复说「my tool calls didn't get results」。

### 三、修法

| 文件 | 改动 |
| --- | --- |
| `lib/agent-preset.js` | 新增 `normCallArgs`（导出归一化，流式与收尾共用）与 `inferToolNameFromArgs`（按**本会话工具表**反推名字：每个键都必须被该工具声明、必填必须齐、候选必须唯一）；`parseAgentReply(text, { tools })` 用它救回缺名/包装名调用，猜不出时**必须**留 diagnostics；还原成功的调用带 `nameInferred` |
| `lib/index.js` | 两处解析传 `tools`；流式开块也用同一份判据（界面提前显示「正在调用 read」）；新增 `TOOL_CALL_UNPARSED` 提示——协议被探测到但一条可执行调用都没有时，如实说明并给重发格式，**取代**那句反事实的 thinking-only 文案与空白消息 |
| `lib/zero-progress.js` | **未改**。它的顺序契约（thinking-only 先于 protocol-withheld）仍然成立；新分支排在它**之前**，且提示里带上思考尾部，不吞任何内容 |

**为什么不做「按第一个键查表」**：`{file_path}` 会被读成 `write` 并覆盖文件——
执行错的事比丢调用更坏。唯一解要求把这类误判挡在门外。

### 四、判据与反向验证

| 项 | 读数 |
| --- | --- |
| 红基线（修复前） | 四份真机夹具 `calls=0 / diagnostics=[]`（`.tmp/red-baseline-nameless.txt`） |
| 新护栏 | `test/nameless-call.test.mjs` **15 项**：①②③⑤⑦⑫⑬⑭ 修复前为红；④⑥⑧⑨⑩⑪ 是反向安全线，⑪a 覆盖另两条早退分支的留痕 |
| 全量单测 | **40/40 文件全绿、556 项断言 0 失败**（逐文件跑；`.tmp/full-test-run-0159-final.txt`） |
| 注释闸门 | `lint-comments` error 0 / warn 0，退出 0 |
| 记账闸门 | `check-ledger` PASS（version 0.15.9 / testFiles 40/40） |
| 真机口径 | 重启后对同一网页形状应看到 `tool-call` 块（修复前一个块都不开） |

### 六、打包与安装（本轮收尾的实际读数）

| 步骤 | 命令 | 读数 |
| --- | --- | --- |
| 打包 | `pnpm pack`（`package/dsh-webcode-bridge/`） | `dsh-webcode-bridge-0.15.9.tgz`（308,118 B） |
| 发布护栏 | `node scripts/verify-pack.mjs <tgz>` | **逐字相同 29/29**，接线完好，退出 0 |
| 安装 | `node scripts/install-profiles.mjs` | `web: v0.15.9`、`headless: v0.15.9`，退出 0 |
| 安装核对 | `.tmp/verify-installed-0159.mjs` | 版本 0.15.9 ✔；lib **24/24 sha256 相同** ✔；用**已安装**解析器跑四份真机夹具，`["grep","pwsh"]`/`["read","pwsh"]`/`["read"]`/`["read"]` 全对 ✔ |
| 已装包端到端 | `.tmp/verify-installed-e2e-0159.mjs` | 导入**已安装**的 `lib/index.js` 跑真机夹具 → 工具调用块 `["read","pwsh"]`、散文保留、协议未泄漏；解析不出调用时正文含 `TOOL_CALL_UNPARSED` 且不再误报「只思考」✔ |
| 重启 | `.tmp/restart-dsh-web.ps1`（分离进程 90 秒倒计时） | 旧进程 23800 停止 → 新进程 **14648** 于 23:56:16 起来，3080/8931 同时恢复监听 |
| 重启后核对 | `GET /__webcode/status` | **`version=0.15.9`、`hash=a2e1e2349249`**；relay running、driver loggedIn（transport=playwright-edge）、**79 条会话映射已恢复**（含 `session-07907f7c → 49ab6330`）、21 个模型在册 ✔ |
| 真机活体冒烟 | `POST 127.0.0.1:8931/v1/chat/completions`（真实网页轮次） | **200，3.6 s 返回正文**（`"I can't read that file: the read tool isn't available in this conversation."`——符合该端点行为：`/v1` 只做纯对话转发、不教协议）。证明重启后的 **relay + driver + 网页会话整条链是活的** ✔ |

**收尾诚实说明**：`/v1` 这条 OpenAI 兼容路径不经过 harness 适配器，因此它**不能**用来验证缺 `name` 的调用还原；
那条链路的判据是「用真机字节跑适配器得到工具调用块」，已由上表两行（安装核对 + 已装包端到端）
覆盖。缺名调用何时出现由网页模型决定，无法在真机上定向制造——夹具就是模型原话本身。

### 七、这一条为什么值得单独记

`takeObj` 有**两条**出口会丢调用（JSON 解析失败、结构不合法），0.15.6 只给前者装了留痕。
**「不留痕的早退分支」是静默丢弃的唯一来源**——给一条路加日志时，要把同一个函数里
所有 `return` 一起数一遍。台账正文见 `long-term-issues.md` #23。

## 0.15.8（已打代码 / 未打包 / 未安装）—— #19 真根因修复 + 仓库结构整理

### 一、#19 修复：`invoke` 体的 lazy 截断（主路径静默丢调用）

**根因**（诊断定位，`diagnosis-2026-09-16.md` §5）：`lib/agent-preset.js` 的 `invoke`
体用 **lazy** 正则 `([\s\S]*?)</invoke>` 捕获。当**参数体里举例引用了协议自身的闭合标签**
（写文档/审计报告说明协议形状时必然出现）时，在示例里的第一个 `</invoke>` 处截断 →
体内无配平 `</parameter>` → `n===0` → **调用被静默丢弃**。

**真机证据**：仓库根那份 22,366 字符的 `REPORT.md` 泄漏样本——它本该是一次 `write`
调用的参数体，却因调用不可执行而**变成了文件本身**，真正的交付物从未落盘。

**修法**：新增 `invokeBodyEnd(src, from)`——**配平感知的状态机**，只在「参数外」遇到的
第一个 `</invoke>` 才算体终点。

| 方案 | 结果 |
| --- | --- |
| lazy（修复前） | 体 10,133 字符，**无配平参数 → 0 调用** |
| **greedy（未采用）** | 能救单个调用，但会把同轮第二个调用吞进第一个的体里 |
| **配平状态机（采用）** | 体延伸到位，`name=write`，`content=10,121` 字符 |

**反向验证（`doc/comment-style.md` §9.3：先红后绿）**：新增 ⑬ 在修复前**实测为红**
（`pass 17 / fail 1`），修复后 **19/19 全绿**。

**同时修掉修法自己引入的一个回归**：换成两次定位后 `m[0]` 不再包含体，
导致「畸形标签抢救」分支（扫 `m[0]` 找 `"name"/"arguments"` 片段）失效。
实测 `regression.test.mjs` 由 53/53 变成 49/53；重建 `m[0]` 后回到 **53/53**。
另外给状态机加了**降级兜底**：扫到结尾仍不配平时退回第一个 `</invoke>`（取旧行为），
而不是返回 -1 把整条调用丢掉。

### 二、仓库结构整理

| 动作 | 结果 |
| --- | --- |
| 一次性探针归档 | `test-mock/` 顶层 **83 → 25** 项；58 个无代码引用的探针移到 `test-mock/archive/`（git 识别为 **58 个 rename**，历史保留） |
| 死代码移出根目录 | `extension/`（9 文件，零代码引用，`relay.js:12` 明言「there is no extension」）→ `test-mock/archive/extension/`；仓库根目录不再有它 |
| `.tmp` 清理 | **272.3 MB → 122.8 MB**（删 `.tmp/pnpm-probe/node_modules` 149.5 MB 可再生缓存 + 30 个空的 `webcode-test-*` / `webcode-wiring-*` 测试残留目录） |
| 悬空 gitlink 清除 | `reference/` 下 4 个 mode-160000 gitlink（`webcode`、`opencode2dsh`、`deepseek-web-import`、`dsh-deepseek-chat`）**无 `.gitmodules` 却是子模块条目** → `git rm --cached`，磁盘文件保留，`.gitignore:9 reference/*/` 从此真正生效 |
| 死链修复 | `README.md` 两处指向被 `.gitignore` 排除的 `PLAN.md` 已改为仓库内权威入口 |
| 文档同步 | 归档路径变化同步进 `doc/review-guide.md`、`doc/ci-cd.md`、`CONTRIBUTING.md`；新增 `test-mock/archive/README.md` 写明目录约定与「归档后相对导入失效」 |

**判据（下次整理照此，不要凭「看起来旧」）**：留 = 被代码引用或属稳定入口；
归档 = 只被文档提及且那轮结论已回写。

## 2026-09-16 全局诊断（本轮工作，无产品代码改动）

一次完整盘点，产出单独成文：[diagnosis-2026-09-16.md](diagnosis-2026-09-16.md)。
**三条已证结论改变了台账的原有记法**，摘要如下（细节与复现命令见该文）：

| # | 结论 | 影响 |
| --- | --- | --- |
| **#19 已归因** | 真根因是 `lib/agent-preset.js:1186` 的 `invokeRe` 用 **lazy** 体捕获 `([\s\S]*?)</invoke>`；当**参数体里举例引用了协议自身的闭合标签**（写文档/审计报告的主路径）时，体在示例里的第一个 `</invoke>` 处截断 → 无配平 `</parameter>` → `n===0` → 调用静默消失。**与 0.15.6 猜的「围栏形状」无关**（8 种围栏形状实测全部健康） | 从「未归因」改为**「已归因，待修」**；修法方向已用 lazy/greedy 对照验证 |
| **#22 前提推翻** | `session-fcbb5bf8` step 7 的 `assistant/message` **有** text 块（357 字符），且那**就是桥自己写的 `THINKING_ONLY_NO_ANSWER` 诊断文本**（`thinkingOnlyNotice` → `emitText` 落库）。原报告「没有 text 块」为误 | 可能性 2（捕获链丢正文）**排除**；**真正的缺陷是诊断文本被持久化进助手正文**，严重度 中 → **高** |
| **#9 重定性** | `run-m2` / `run-m2b` / `run-m2c` 三项实跑均为 `spawn EPERM`，**从未跑到自己的断言**。原记「走废弃扩展链路 / mock 形状脱节 → 干净树同样失败」**无实测支持** | 改记 **UNTESTABLE（本机）**，须由 CI 读数定性；不得再当作「已知既有失败」解释红色项 |

**同轮完成的收尾**：

- `long-term-issues.md` 一览表**补登记 #19、#20**（此前正文有、表里没有）；
  #9/#19/#22 各加复核段；#10 补记本机**第二类 EPERM**（`mkdtemp`，可用 `TMPDIR` 绕过）。
- `README.md` 两处指向 `PLAN.md`（被 `.gitignore` 排除）的**死链已修**——
  克隆者看不到该文件；改为指向仓库内的 `doc/` 权威入口，并加一段说明。
- `doc/README.md` 索引加入本诊断报告。
- **护栏**：`test/fence-nested-call.test.mjs` 新增 ⓪a/⓪b 两项真机形态用例（12 → **14 项**）。
- **可复现证据脚本**：`.tmp/probe-diagnosis-2026-09-16.mjs`（组 A/B/C，退出码即判据）。
- 复核读数：**测试 39/39 全绿**、`check-ledger` **exit 0**、`lint-comments` **error 0 / warn 0**。

**下一步（P0）**：① #22 修 `thinkingOnlyNotice` 不得进正文通道（注意 `TOOL_UNKNOWN`
**需要**模型看见，两类提示须分开评估）；② #19 按 `<parameter>` 配平定界修 `invokeRe`
（**不要**直接用 greedy——会把同轮第二个调用吞进第一个）；③ 两者都要先补
`withheld` / `n===0` 的**形状指纹留痕**。


## 0.15.7（已打包 / 待装 / 需重启生效）—— SET 重发吞掉流式增量

用户原话（逐字）：**「？怎么回事》明明有输出：`<tool_call>{…}</tool_call>`
却提示 THINKING_ONLY_NO_ANSWER」**。

**用户的观感是对的**：问题不在收尾判定，而在**接收层的流式增量**。

### 根因

DeepSeek 会把**整份 response 对象**反复重发，`fragments` 每次都比上一次长。
两个入口（真机都出现过）旧实现都是**整份替换**，且只在**第一次**见到该
response 时外发增量：

- `{o:'SET', p:'', v:{response:{…}}}`
- `{o:'SET', p:'response/fragments', v:[…]}`

于是 `onDelta` 累计的 `acc` 停在第一帧，而 `finish().text` 是完整正文：

```
acc           = "Hello"          ← 界面正文停在半路
finish().text = "Hello world!"   ← 「明明有输出」
```

后果链条：正文停半路 → `index.js` 的边界探测只看 `acc`、后段里的
`<tool_call>` **探不到** → 一个 tool-call 块都不开、**工具从未执行** →
收尾 `finalText` 与 `textSent` 分叉 → 判成「正文空 + 只有思考」→
交回 `THINKING_ONLY_NO_ANSWER`。

### 修法

抽出 `emitFragmentDiff(next, prev)`，**两个入口共用**，按下标逐位对比：

| 情形 | 处置 |
| --- | --- |
| 同下标变长且以旧内容为前缀 | 只发增长的后缀 |
| 同下标被改写 | **不发**（补发会变成重复正文） |
| 新增下标 | 整段当增量发 |

附带修掉两个同源缺陷：**新增片段**整段漏发、**新增图片**流式期间不触发
`onImage`（轮次进行中界面无图，只能靠 `finish()` 事后捞回）。

### 护栏与反向验证

`test/decoder-fragment-diff.test.mjs`（9 项 = 5 判据 + 3 反向安全线 + 1 接线）。
**反向验证已做**：把 diff 外发改回「只在首次」→ **pass 4 / fail 5**；
恢复后 **9/9 全绿**。全量 **39/39** 测试文件通过。

### 一条通用教训

`onDelta`（增量通道）与 `finish()`（权威快照）**两条通道同时存在**，
而测试历来只 assert `finish()`——它**总是对的**，所以那个洞活到了真机。

> **任何「增量通道 + 权威快照」双通道的解码器，都必须有一条把两者
> 钉在一起的断言（流式外发 ≡ 权威全文逐字一致）。**

详见 `doc/long-term-issues.md` #21（本条）与 #22（同一用户报告里
**未归因**的另一半：DeepSeek 只出思考不出正文）。

## 0.15.6（已发布 / 已装 / 已重启生效）—— 参数含围栏的调用被丢弃并整段泄漏

用户原话（逐字）：**「harness 端的 markdown 渲染整块不见（web 正常）」**。

这是 0.15.5 修「普通 markdown 围栏被误判成协议」时**引入的回归**，影响面是
**写文档/写代码的主路径**（97 个会话里参数含 ``` 的 tool-call 有 108 个）。

| # | 环节 | 缺陷 |
| --- | --- | --- |
| ① | `parseAgentReply` | 非贪婪围栏正则 `` /```([\s\S]*?)```/ `` 在**第一个内层 ```** 处截断体 → `JSON.parse` 失败 → `takeObj` 静默 return → **调用消失，文件从未落盘** |
| ② | `firstCallFenceAt` | 用同一个错误窗口 → `hasJson=false` → 真调用围栏被判成普通围栏 → `findProtocolStart` 返回 **-1** |
| ③ | `proseSafeEnd` | index=-1 时返回**全文长度** → 整段原始协议被当正文外发并持久化 |

**根因一句话**：「什么算围栏体」有两份知识（解析器一份、泄漏防护一份），两份都写错了同一边界。

**修法**：两侧统一到 `readCallAt`（花括号 + 字符串转义感知）这一个定位器，
并给 `proseSafeEnd` 加一道独立兜底。

**A/B 实测**（`.tmp/probe-audit-regress.mjs`，同一段文本）：

| 版本 | boundary | proseSafeEnd | withheld | parsedCalls | contentIntact |
| --- | --- | --- | --- | --- | --- |
| 0.15.3 | 53 | 53 | 313 | 0 | false |
| **0.15.5** | **-1** | **366（全文）** | **0** | 0 | false |
| **0.15.6** | 53 | 53 | 313 | **1** | **true** |

**验证**：新增 `test/fence-nested-call.test.mjs` 12 项；反向验证（倒回修复前）
**pass 5 / fail 7**，证明护栏真的钉住了缺陷。完整记录见 `doc/verify.md` §0.15.6。

> 本文件**首次写入就是被这个缺陷吃掉的**（write 参数里含代码块 → 调用消失 + 协议泄漏），
> 当时不得不补写一份审计报告来记录这件事——那份报告已按用户指示于 2026-09-16 删除。
> 教训留在本文件与 `doc/verify.md` §0.15.6 里。
> **并且 2026-09-16 又一次复现**：一次 `edit` 被 `withheld 390 chars` 且未落盘，
> 见 `doc/long-term-issues.md` #19。这是本项目第一例「缺陷吃掉了它自己的记录」。

## 0.15.5（已发布 / 已装 / 已重启生效）—— 「零进展轮」顺序纠正 + 去 BOM

**真机缺陷的原始现场**（子代理会话 `ecad7b6a`）：

```
step1  usage={inputTokens:26263,outputTokens:197}   blocks=[text(66), tool-call(pwsh)]
step2  usage={inputTokens:28555,outputTokens:0}     blocks=[reasoning(201)]
turn/end reason=completed
```

后果：`doc/research/graph-plugins-references.md` 与 `panel-plugins-references.md` 均 MISSING，
`reference/` 无任何新克隆——**一个工具调用发出去之后，整轮以「零产出」收场却报 completed**。

**修法**：`zeroProgressDecision` 的判据顺序——`thinking-only` 判定必须先于
`protocol-withheld` 判定，否则「正文空 + 思考非空 + 有扣留协议」这一类会被静默吞掉。
新增纯函数模块 `lib/zero-progress.js` + `test/zero-progress.test.mjs`（11 项）。

**反向验证**（`doc/verify.md` §0.15.5）：换回旧顺序 → exit 1 / fail 2；恢复 → exit 0 / pass 11。

**同一轮的其他改动**：`package.json` 去 BOM（首三字节 `123,10,32`）、
`.github/CODEOWNERS` 把 `@owner` 占位符换成真实账号 `@RSLN-creator`。

## 0.15.4（已发布 / 已装 / 已重启生效）—— 真实花名册的两个语义缺陷

**没有单独台账段落，从 `lib/roster.js:25-54` 的注释与 `lib/client.cjs:389` 反推**——
两个缺陷都有**真机 + 官方源码双重证据**：

| # | 缺陷 | 现场 | 修法 |
| --- | --- | --- | --- |
| A | 「挑第一个能通过 `listMembers` 的 agent」会读到**别人的** lead | 官方 `tryMembership`（`dsh-experimental-agent-team/lib/index.js:397-430`）对**任何没有 subagentDescriptor 的顶层 Agent** 都返回 `{role:'lead',name:'lead'}` 而**不抛错**，`list()` 还无条件先插一行 lead 伪行。于是旧实现读到的是「进程里第一个顶层 agent 自己的 lead」——与用户正在看的会话无关。**活进程实证：换两个不同 `sessionId` 查询 `/status`，`team` 段逐字相同** | 只用**当前会话自己**当凭据（`agents.get(sessionId)`）；拿不到就如实说 `caller-not-live`，绝不用别的 agent 顶替 |
| B | 把 Team **总任务数**当成「每个成员的任务数」 | 对每个成员都调 `listTasks(agent).length`——那个数是整块任务板的条数，对每个成员都一样；还同一 agent 调了两次 | 按官方 `TeamTaskView.ownerName` 归属，且**整表只读一次** |

**顺带**：Team 的「成员」与「任务板」拆成两个字段（官方 `remoteView` 返回的本来就是
`{members, tasks}`，任务板是**团队级**的，不是某个成员的属性）。

**验证**：`test/wiring-roster.test.mjs` 与 `test/roster.test.mjs`（本轮大幅扩写，+340 行）。

## 0.15.3（本轮）—— 设置页整块空白 + 花名册恒读不到

用户原话（逐字）：**「请你查看设置界面 窗口问题，现在空白一片」**。

查下去是**三个独立缺陷叠加**，其中两个同属「引用/调用点都在、链路的另一端不存在」
这一族（上一轮 `projectRoster` 漏 import 是同族），而且**离线全绿**。

| # | 缺陷 | 现场 | 后果 | 修法 |
| --- | --- | --- | --- | --- |
| ① | `SiteAccounts` 的 hook 写在提前 `return` 之后 | `lib/client.cjs`：3 个 `useState` + 1 个 `useEffect` 之后是「站点表为空就返回加载中」，**这句之后**又写第 5 个 `useState`（`picked`） | 首屏跑 4 个 hook 就 return，`sites` 到达后同一次挂载走到第 5 个 → React 硬错误 → 错误冒泡到 `settings.section` 的 `SlotErrorBoundary` → **整块栏目变空占位** | `picked` 提到提前 `return` 之前 |
| ② | `status` 只注册了 GET，客户端走 POST | `api('status', { sessionId })` 带 body ⇒ POST；`web-control.js` 只有 `'GET status'` | 真机 `POST /__webcode/status` ⇒ **405**；`subAgentsError` 报的 `no-session-id` 是**后果**不是根因 | `actions['POST status'] = actions['GET status']`（**别名**，不复制实现） |
| ③ | `settings.section` 是 root 作用域，`inject` 拿不到 sessionId | 0.15.0 写了 `inject: (sessionId) => ({ sessionId })` | root 槽的 `inject` 只拿到 `actions` 对象，被当成会话 id 送到服务端 | 新增 `SettingsSection`，经官方 standard prop **`useSessions`** 读 `state.current` |

**官方契约证据（本地权威，不是推断）**：
`...\dsh-cordis-client-runner\lib\client.js:3873` → `settings.section` 的 `scope: "root"`；
同处 `:3902` 的 `standardProps` 列表含 `useSessions: UseSessions`；
官方 `dsh-client-ui-settings-general\lib\client.js` 自己就是
`useSessions(state => …state.current…)` 读会话。

### 为什么原来的护栏全绿（本轮最该记住的一条）

- `client-render.test.mjs` 的 `useState` 桩是**按名字取值**的映射，结构上察觉不到
  hook 顺序/数量违规；且切换 payload 时会清空 states ⇒「同一次挂载内 4→5 个 hook」
  从未被复现。
- 同一个文件的 mock fetch **不看方法**，任何 URL 都回 200 + JSON ⇒
  「服务端没这条路由」整个不可见。

护栏的建模失真，把整类缺陷盖住了。新增的三条护栏都**先证明能抓到缺陷再修**
（反向验证记录见 `doc/verify.md`）：

| 护栏 | 抓什么 | 反向验证 |
| --- | --- | --- |
| `test/hooks-order.test.mjs`（2 项） | 组件体顶层「hook 在提前 return 之后」 | 搬回 return 之后 → 红；搬回 → 绿 |
| `test/client-server-contract.test.mjs`（2 项） | 客户端 `api(action, body)` 推的方法 vs 服务端动作表 | 删别名 → 红；恢复 → 绿 |
| `client-render.test.mjs` +2 项 | root 槽不得用 inject 冒充会话来源；降级链必须完整 | 三条反向用例全部被抓到 |

> 护栏自身两次失手也记录在案：`hooks-order` 第一版不跟踪花括号深度会**误报**
> （会误报的护栏会被直接绕过）；第二版跟踪了深度却漏掉**单行守卫**
> （`if (cond) return x;`）这一形态——正是真机缺陷的写法，反向验证因此**静默漏过**。
> 教训：**护栏写完必须反向验证，且反向用例本身要确认「变更真的生效了」。**

### 验证（全部实跑）

| # | 判据 | 命令 | 结果 |
| --- | --- | --- | --- |
| A1 | 全量单测 | 35 个测试文件逐文件跑 | **35/35 全绿** |
| A2 | 注释闸门 | `node scripts/lint-comments.mjs` | 退出 **0** |
| A3 | 打包 | `pnpm pack` | `dsh-webcode-bridge-0.15.3.tgz`（285,437 字节） |
| A4 | 发布闸门 | `node scripts/verify-pack.mjs <tgz>` | **28/28 逐字相同** + 接线完好，退出 **0** |
| A5 | 装入真机 profile | `node scripts/install-profiles.mjs <tgz> --profiles web` | web **0.15.3**，退出 **0** |
| A6 | 安装副本逐条核对 | `Select-String` on installed copy | `picked` 在 return 之前（504 < 579）/ `POST status` 别名在位 / `useSessions` 接线在位 / `roster` import 在位 |
| A7 | 推送 | `git push origin main` | `1798bd5..ca1e855`，退出 **0** |

### 仍需重启后确认（离线无法证明）

1. `GET /__webcode/status` → `build.version` = **0.15.3**（当前进程实测仍是 0.15.2，
   `POST` 实测仍是 **405** —— 与「装完不重启不生效」完全一致）。
2. 设置 →「网页桥接」栏目能渲染出各卡片（缺陷 ①）。
3. `subAgentsError` 不再含 `no-session-id`（缺陷 ②③）；空时应显示
   「当前没有正在运行的…」而不是「读不到」。

> **0.14.7 时的基线「305 通过」已过期**。本轮实测 **421**，增量来自三处：
> `accounts`(38) + `accounts-integration`(16) 在 0.14.7 已计入 305；之后新增
> `roster`(真实花名册)、`bench`/`prompt-bench-harness`（基准层）、
> `stall-settle`(15，本轮新增：12 项判据 + 3 项接线护栏)。**台账此前一直没跟上**——这正是「记账未收口」的
> 同一族问题，写在这里以免下次又拿旧数当基线。

## 0.15.2（本轮）—— 修「只出思维链然后卡死」+ LoopX 移除 + 闸门转正

用户原话（逐字）：**「长时间后只有思维链卡住，harness 端，没有任何报错，没有下一步」**。
注意这不是 0.14.0 修过的那一类（那类是「网页早写完了却没送 FINISHED」）。

### 根因：0.14.0 的双条件判据有结构性盲区

0.14.0 的 `shouldSettleWip` 判据是「流停 **且** 页面 DOM 助手消息停止增长」。盲区在于：
**思考阶段网页把「思考中 / Thought for 5s」这类计时文案持续写进同一个助手节点**，
节点 `innerText.length` 因此一直变长 → `lastDomGrowthAt` 被无休止刷新 →
**「DOM 停长」永远不成立** → 收束器永不动作。而看门狗按「最后一个增量」计时，
思考增量同样刷新它，也判不出来。唯一兜底是 240s 总超时，报错还是通用 `web turn timed out`。

一句话教训：**任何依赖「还在动」的判据，都要问一句「这个『动』会不会是假的」**——
计时器在动不是模型在产出内容。

### 修法（三条，缺一不可）

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `lib/metrics.js` `answerDomLength` | DOM 采样改量**剥掉整行计时文案后**的真实回答长度，让「只剩计时器在动」重新等于「DOM 停长」 |
| ② | `lib/metrics.js` `shouldSettleStalledThinking` | **绝对墙钟**判据：自最后一次**正文/图片**起超过 `answerTimeoutMs`（默认 180s）即收束，不看 DOM、不看思考 |
| ③ | `lib/browser-driver.js` `startWipWatch` | 接线：新增 `lastAnswerAt`（**只由正文/图片刷新，思考不刷新**）；`settled_by` 如实区分 `thinking-only-settled` / `partial-wip-settled(dom-timer-only)` / 其余 |

### 顺带修掉的两个真缺陷

1. **`empty response` 抹掉归因**：`lib/index.js` 收尾分支原本无条件
   `assertNonEmpty(out, '', [])` —— 第二个实参写死空串，于是「思考全文都在、正文为空」
   被判成空回复。改成：正文空 + 无调用 + 思考非空 → **不抛错**，交回一条带现场的
   `THINKING_ONLY_NO_ANSWER` 提示（含思考尾部 200 字、收束原因、累计次数），
   与既有 `TOOL_UNKNOWN` 同型，任务因此**继续**而不是整轮作废。
2. **`emitText` 写死下标 0**：工具轮里思考块已用掉 0（`openThink` 从 nextIndex 分配），
   收尾再写 0 会与**已关闭**的 reasoning 块撞下标。`TOOL_UNKNOWN` 与本次新增的
   `THINKING_ONLY_NO_ANSWER` 两条路径都落在这条缝上。已改为显式传 `nextIndex`。

### 可观测

`status()` 新增 `thinkingOnlyTurns`、`lastStalledSettle`（含 `thinkingChars` / `answerChars` /
`waitedMs` / `domTimerOnly`）、`answerTimeoutMs`；`idleScene()` 与 `WEB_NO_PROGRESS`
报错文本同步带上，看门狗超时时能直接读出「只有思考、没有回答」。

### 护栏 `test/stall-settle.test.mjs`（15 项 = 12 判据 + 3 接线）

正向：到上限即收束、上限可配置、计时文案剥完为 0。
**反向安全线（同等重要）**：正文持续产出 → 永不命中（不腰斩长回复）；
上限为 0/非法 → **判据关闭**而不是「立刻收束」；缺 `lastAnswerAt` 基线 → 不收束；
正文里出现「思考中」三个字是内容、不被剥掉。

> 其中「缺基线」那条抓到一个真 bug：`Number(null)` 是 `0` 且 `isFinite(0)` 为真，
> 只判 `isFinite` 会把缺失的时间戳读成「epoch 0」＝「已等一万年」，
> 于是每轮缺字段时第一个 tick 就判死。**这比不修更坏**，已改成同时挡 `<= 0`。

**另有 3 项是接线护栏，与「判据本身对不对」是两回事。** 加它们的原因是复查时
发现的一个真实缺口：0.15.2 最初只在 `browser-driver.js` 加了 `answerTimeoutMs`
的默认值，而 `index.js` 既没在 `DEFAULTS` 声明、也没在 `createBrowserDriver`
时传进去（两处 call site 都漏了）。**行为是对的**——driver 内部默认恰好也是
180s——但**配置层完全够不着它**：任何人想调这个上限都会发现自己改的值没有任何
效果。这类「静默不生效」缺陷不会让任何断言变红，只会让下一次真机排障时少一个旋钮。

接线护栏的判据刻意选「传进去能不能读到」而不是「默认值等于多少」：前者能抓住
「加了配置项但忘了接」这一整类问题，后者只能抓住某一次写错常量。三项分别覆盖
接线存在、缺省回落 180s（而不是 `undefined`——`undefined` 会让判据直接
`return false`，等于这条防线静默消失）、以及 `0` 被保留为「显式关闭」而不是被
`|| 默认值` 吃掉。

### LoopX 整体移除（已完成，2026-09-15）

用户决定舍弃。**本仓库零代码引用**（`package/` 与 `scripts/` 下 `git grep -i loopx` 命中 0），
也**未被任何活动配置引用**（`~/.dsh/settings.yaml`、`.agent-presets/`、`profiles/web/package.json`
三处均无）。因此移除的是仓库外的东西，已按下列清单**全部删除并逐项核对**：

| 项 | 内容 | 体积 |
| --- | --- | --- |
| 运行时本体 | `~/.agents/runtime/dsh-loopx-plugin` | 104.92 MB / 2272 文件 |
| 7 个 skill | `loopx`、`loopx-benchmark`、`loopx-doc-registry`、`loopx-pr-program`、`loopx-pr-review`、`loopx-project`、`loopx-self-repair` | 0.31 MB |
| 3 个锁/安装记录 | `.loopx-skill-install.json`、`.loopx-workflow-skills.lock{,.holder.json}` | ~2 KB |
| **合计** | | **约 105.22 MB** |

**删除后核对**：`skills/` 下 loopx 条目 **0** 个；`runtime/dsh-loopx-plugin` 不存在；
**其余 85 个 skill 目录完好**（证明没有误删）；会话技能目录里 7 个 `loopx*` 技能已消失。

**仓库内保留不动**：
- `doc/progress.md`（本节）、`doc/verify.md`、`scripts/install-profiles.mjs` 里对它的 3 处提及
  已改写成**通用教训**——任何走 GitHub tarball 的依赖都会踩同一条证书坑，
  这条知识比「某个包曾经坏过」更耐用。
- `REPORT.md` 的取证记录保留（它已被 `.gitignore` 排除，属本地私有留痕）。
- **不**给 `.gitignore` 加 `.loopx/`：该目录从未存在于本仓库，加一条空规则是噪音。
  （REPORT 的 C-5 因此关闭为「不适用」，而不是「已修」。）

### 注释闸门转正

`scripts/lint-comments.mjs` 从「非阻断」改为**阻断**，并进 CI 必需检查。关键修法：
原 CS002 按**整行扫源码**，于是 `const MARKER_RE = /\b(TODO|…)\b/;` 这种
**正则字面量**里的 `TODO` 被当成待办注释——一个「查待办注释」的规则在读代码。
改为先用状态机抽出真正的注释文本再判。**并验证了它没变成空壳**：种一条真
`// TODO fix this later` → 确认报错 → 撤回 → 恢复 0。细节见 `doc/ci-cd.md` §4。

### CI/CD 与审查补强

- `ci.yml`：注释闸门删 `continue-on-error`；新增 `scripts/ci-local.mjs --fast` 自检
  （`--fast` 跳过慢的全量单测，净成本约 1 秒，换来两个平台都验证一次本机入口的
  按平台分叉逻辑）；`release.yml` 同步转阻断。
- 新增 `.github/CODEOWNERS`（**须先把 `@owner` 换成真实账号**）。
- `codeql.yml`：加 `paths-ignore`（`reference/**`、产物目录、`.tmp/**`、`*.tgz`）。
- `doc/review-guide.md`：新增「卡死类缺陷的审查要点」——**任何等待/超时/收束逻辑
  必须同时给出绝对上限与反向单测**。
- `doc/ci-cd.md`：§4 改写为转正说明（含 CS002 判据 bug 的完整记录）、§7 必需检查清单更新。

### 文档收口（REPORT C-8）

- `doc/README.md` 表格列错位已修（LoopX 那行已随移除删掉，全表 3 列一致，27 个链接全部可解析）。
- `doc/long-term-issues.md`：补上缺失的 `## 16` 正标题（此前一览表有 15/16/17，
  正文只有 15 和 17，跳号会让人以为这条被删了）。
- `PLAN.md:3` 版本头 `0.14.5` → `0.15.2`。

### git 收口（REPORT A-3）

工作树此前积压了大量未提交改动（REPORT A-3 记录的「阶段 A-6 只做了一半」）。
本次按主题分成 **5 个提交**收口，每个提交都能单独看懂、单独回滚：

| 提交 | 主题 |
| --- | --- |
| `e92db16` | `fix(stall)`：只出思维链卡死的第三条防线（本轮核心） |
| `df2f194` | `test+ci`：注释闸门转阻断，CI/CD 与审查补强 |
| `ecd3e31` | `feat(bench+roster)`：提示词基准层与真实花名册 |
| `cec55fe` | `feat(tooling)`：会话日志解析器与泄漏检测盲区修复 |
| `3fbfdce` | `fix(protocol)`：协议原文不再被持久化进助手正文 |

**REPORT A-3 点名的两项均已裁决**：

1. `scripts/session-read.mjs`（用户明确要求的交付）—— 已入库，见 `cec55fe`。
2. `bench-out.txt`（OOM 留痕）—— **裁决为不入库**。它是「每次跑都可能变」的产物，
   而真正的证据（约 4GB 堆耗尽、669849ms）已逐字写进 `lib/bench.js` 的注释；
   同时把 `bench.js` 里对它的**文件引用摘掉**——注释指向一个读者手上没有的文件，
   比没有引用更坏。已加 `.gitignore` 规则。

**新发现并如实记录（不掩盖）**：加 `*.tgz` 规则时发现**历史上有 56 个 tgz
已被跟踪**（共 5.55 MB）。gitignore 对已跟踪文件无效，所以这条规则只挡新文件。
本次**刻意不删**历史 tgz：`doc/ci-cd.md` §6.2 的回滚步骤明确依赖它们
（「回滚：装回上一个版本的 tgz（package\ 下存着历史版本）」），删掉会让那条文档失效。
现状是**有意为之**，理由已写进 `.gitignore` 注释——包括「若将来清理，必须
`git rm --cached` 与改写回滚文档一起做」。

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
- **归因**：错误码 × 已做适配 × 残留风险的对照表见 `doc/bridge-failure-ledger.md`
  （原先这里指向 `session-log-review.md`，那份已按用户指示于 2026-09-16 删除）。
- **P0 修复**：composer 分块写入 + `PROMPT_WRITE_STALLED`。真机证据是 80 万字符
  一次性 `fill` 导致 30s 超时；决策抽成纯函数 `composerWritePlan` / `stallStep`。
  护栏 `test/composer-write.test.mjs` 12 项。
- **P1 修复**：`<tool_result>` 加进协议边界锚点（但**不**加进 transport 判定）。
  护栏 `test/protocol-leak.test.mjs` +2 项。

## 0.14.7（已发布 / 已装 / 等重启生效）—— 同站多账户

用户明确「team 最后实现，优先解决前面问题」。0.14.6 收口后本轮做的是**同站多账户**。

### 数据模型（`lib/accounts.js`，纯函数身份层）

| 概念 | 0.14.6 | 0.14.7 |
| --- | --- | --- |
| 账户槽 id | 不存在 | `<siteId>#<slot>`；**默认槽仍是 `<siteId>`**（`#1` 是其别名） |
| profile 目录 | `<profileDir>/sites/<siteId>` | 默认槽**逐字不变**；非默认槽 `<profileDir>/sites/<siteId>/<slot>` |
| 模型 id | `site:model` | `site@slot:model`；`site:model` 与全部历史别名照旧解析到默认槽 |
| 显示名 | `站点短键/模型id` | 非默认槽追加 `(账户N)`；**默认槽不加**（既有断言原样通过） |
| 发送间隔 | 设置级单值 | **槽级**（`sendGapMsBySlot`），回落链 槽 → 站点键 → 全局 |
| 设置字段 | — | `accounts: []`（**默认空 = 行为与 0.14.6 完全一致**）、`sendGapMsBySlot: {}` |

### 落地的文件

- **新增** `lib/accounts.js`：`parseAccountKey` / `formatAccountKey` / `formatModelId` /
  `parseModelId` / `slotProfileDir` / `accountLabel` / `normalizeAccounts` / `slotsForSite` /
  `sendGapForSlot`（与 `composerWritePlan` 同纪律：决策抽纯函数，调用方只做 IO）。
- `lib/providers.js`：`listAllModels(accounts)` 展开槽；`resolveWebModel` 支持 `@slot`；
  默认槽的 id / 显示名 / `accountKey` 与 0.14.6 **逐字相同**。
- `lib/browser-driver.js`：接受 `slot`，日志前缀带槽（`[webcode-driver:glm#2]`），status 透出 `slot`/`accountKey`。
- `lib/index.js`：`driverFor(accountKey)` 按槽建独立驱动与独立 profileDir；发送间隔按槽计时；
  `buildTurn` 的 meta 带 `slot`/`accountKey`；`driverStatus` 按槽展开（含未初始化槽）。
- `lib/web-control.js`：`login`/`verify-login`/`window`/`session-import`/`connect` 全部按 accountKey 路由；
  `login-sites` 合并「全站点默认槽 + 已配置非默认槽」；`settings` 写入前归一化 `accounts`/`sendGapMsBySlot`。
- `lib/client.cjs`：`SiteAccounts` 按 `accountKey` 索引——**两个账户两行，互不覆盖**。

### 顺带修掉的一个真 bug

`resolveWebModel` 首版只处理 `slot !== default` 的分支，导致 `glm@1:glm-5.3`
（`1` 是默认槽别名）掉进 `split(':')` 兜底、被切成站点 `glm@1` → 报「不支持的网页模型」。
账户1 本该与默认槽完全等价。已改为**连同默认槽一起交给 `parseModelId`**，并有专门护栏。

### 验证

- `npm test`：**305 通过 / 0 失败**，`run-m1.js` **M1 PASS**。
- `accounts.test.mjs` 38 项（纯函数全形态）+ `accounts-integration.test.mjs` 16 项
  （默认槽零位移 / 两槽不串 / 槽级间隔接缝）。
- `verify-pack`：26 项中 25 项逐字相同，唯一差异是 `package.json` 被 pnpm 规范化掉
  `packageManager`（逐字段 diff 确认 **field diffs: 1**，且版本一致 0.14.7）。
- 双 profile 安装标记逐一核对：`accounts.js` 在位、`normalizeSlot`（driver）、
  `listAllModels(accounts`（providers）、`accountKeyOf`（web-control）、`displayName`（client）、
  `formatModelId`（index）全部 `True`。
- 回滚备份：`profiles/{web,headless}/*.bak-2026-09-14-accounts`。

### 重启后要核对的三点

1. `/__webcode/status` 的 `build.version` = **0.14.7**。
2. 设置页「账户与登录管理」每个站点一行；配置 `accounts` 后**同一站点出现两行**
   （`智谱清言 (GLM)` 与 `智谱清言 (GLM) (账户2)`），两行状态互不覆盖。
3. 未配置 `accounts` 时行为与 0.14.6 完全一致（默认槽零位移）。

## 下一阶段（0.14.8 Team 面板）

官方三个 `@deepseek-ai/dsh-experimental-*` 包**已装**（web profile，全部 `0.1.5-rc.1`），
但它们的 `package.json` 里**没有 `dsh.client` 入口**（只有 profile 包有 `bundle.patch`）——
即**官方 Team 面板的 client 侧不在已发布 tarball 里**，不能照抄。

因此路线是：服务端复用官方 `agentTeams` Remote method（`view`/`createTask`/`updateTask`），
本项目自建右栏只读面板（roster 五态 + 任务板），沿用官方九个工具名与语义。
**必须显式声明**：单进程共享 checkout，并行的是会话与呈现，不是文件系统。

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

- **`spawnSync` 从 Node 里调用任何外部程序都会 `EPERM`**（2026-09-16 实测，Node v24.18.0）。
  实测四种写法**全部** `status=null, error.code='EPERM'`：`spawnSync('git',…)`、
  `spawnSync('node',…)`、`spawnSync('cmd',…)`、以及**写绝对路径**的
  `spawnSync('C:\\Program Files\\Git\\cmd\\git.exe',…)`。而同一台机器上 pwsh 直接跑
  `git rev-parse` 正常返回 —— 即这是**Node 子进程创建被沙箱挡住**，不是 git 没装。
  **两个真实后果，必须知道**：
  1. `test-mock/artifacts-check.mjs` 会走它的「不在 git 工作树内 → SKIP → exit 0」分支。
     它**打印的是 SKIP 而不是 PASS**（这一点写得对，没有假装通过），但在本机它
     **等于一条空转护栏**——本次 `output/` 规则的修复就是靠手跑 `git check-ignore` 验证的，
     不能指望这条闸门。CI 上 git 可用，闸门是真的。
  2. `scripts/ci-local.mjs` 的**全部四步**都经 `spawnSync` 启动，因此在本机**四步都不会真的跑**。
     本机复核必须逐条手跑命令（本次 38 个测试文件就是这么跑的）。
  > 这一条与既有的「`node --test` glob 在本机 `spawn EPERM`」是**同一个根因**，
  > 此前只被记成「glob 不支持」这一局部现象，覆盖面被低估了。
- `pnpm install` 曾因一个**无关依赖**（走 GitHub release tarball 的包）证书校验失败
  （`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）而整体失败 → 安装走手动解包
  （`scripts/install-profiles.mjs`）。**这是通用约束**：依赖树里只要还有任何一个包从
  GitHub tarball 拉，这条路径就会再踩一次。可用的绕过是 `$env:NODE_OPTIONS='--use-system-ca'`
  （Node 24+ 用系统证书库），见 `doc/verify.md`。
  > 0.15.2：那个具体依赖（LoopX 插件）已被用户决定整体舍弃，本仓库不再引用它；
  > 上面这条作为**通用教训**保留。
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

---

## 0.16.3 附录：超长纯文本改走附件的取证、命令与连带发现

> 本节是上文 `## 0.16.3` 的**同一版本补充取证**（不另开版本号）。
> 计划原文见根目录 `PLAN-2026-09-17-0.16.3.md`（本地私有留痕，不入库）。

本次报错（逐字）：

```
本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished） — 本轮已中止，可重试
```

### 一、取证（三条读数，全部来自桥自己的只读面，可复核）

| # | 读数 | 取法 | 原始值 |
| --- | --- | --- | --- |
| 1 | 网页真实回复**确实存在且可解析** | `POST /__webcode/history {"sessionId":"971db3e8-…"}` → 再喂给 0.16.2 的解析器 | assistant 消息 **1204 字符**，解出 **calls=3**（grep / pwsh / pwsh），`diagnostics` 空 |
| 2 | 失败会话 turn1 **step5 跨度 112s 且全程零事件** | 解 `.dsh/sessions/…session-dff3edf7…/session.v3.jsonl.zstd`（29 帧） | step5 在 **18:41:59 → 18:43:51 无任何事件** → 看门狗开火 |
| 3 | 发进网页的纯文本 **127,888 字符** | `POST /__webcode/history` 的 user 消息 | 工具教学 **38,279** + 会话 transcript **89,609** |

### 二、取证能推出什么、不能推出什么（这两段必须分开读）

**取证**：

- 读数 1 证明「网页没返回正文」的旧结论**是错的**——网页有回复，是桥没解析出来
  （0.16.2 已修，本轮只补回归：真机夹具 14 + `test/dsml-real-reply-regression.test.mjs`）。
- 读数 3 是读数 2 的输入端：12.8 万字符一次性贴进输入框，DeepSeek 网页要**重新 prefill
  整个上下文**才吐第一个 token；而看门狗自「上一次事件」起 120s 内看不到任何新事件
  （连思考增量都没有）就把这一轮判死。
- 读数 2 里 step1-4 每步都有事件（工具调用 2-4 个），说明**捕获链是活的**，「链路坏」不成立。

**推断（标注清楚，不要当成取证）**：prefill 12.8 万字符是 step5 那 112s 无事件的**唯一可信
解释**——依据是读数 2（零事件）+ 读数 3（输入量）+「捕获链活着」三项；但我们**没有**同时抓到
「网页侧 prefill 起止时刻」与「桥侧事件流」的配对时间线，因此这是**归因推断**，不是直接观测。

> 一个与步调无关的坑：失败那一刻 `lastEndReason=finished` 是**上一轮**的收束原因（它是
> 「最近一次收束」而不是「本轮状态」），当时的复盘把它当成本轮线索用过一次。看门狗分相位
> （0.16.3）正是为了不再需要这种猜测。

### 三、修了什么（对应 `PLAN-2026-09-17-0.16.3.md` §3.1/§3.2）

- **接线缺陷（真缺陷，先修）**：`lib/browser-driver.js` 里 `uploadTextAttachment` 的定义被插在
  `uploadImages` 的 `if (!hit) { … throw err;` **之后、闭括号之前**——函数声明提升让它侥幸能跑，
  但 `if` 块被提前关掉、文件里剩下两个孤立闭括号。后果链：相邻重构 → 只在 `catch` 作用域可见 →
  调用点 `ReferenceError` → 被 runTurn 的 `catch` 吞掉 → **静默回落 inline**（界面上一切正常，
  长文本从来没走成附件）。已整体移到 `uploadImages` **完整结束之后**，`if` 块结构复原；
  护栏 `test/upload-attachment-structure.test.mjs`（源码结构断言 + 扫描器自检）钉住它不许挪回去。
- **附件上限**：`promptTransportPlan` 新增 `maxChars`（默认 1_500_000）/`payloadChars`/`truncate`/`kept`。
  **上限只影响「上传多少」，绝不影响「走不走附件」**（`mode`/`reason`/`limit`/`total` 逐字未变）；
  非法 `maxChars`（`<=0`/`NaN`/非数字/`null`）视为不设上限——配置写错只许退化成旧行为，
  不许把这一轮的消息悄悄砍成半截。护栏 `test/prompt-transport-attach.test.mjs`。
- **截断保尾部 + 留痕**：超上限时保留**尾部**（尾部才是当下要执行的那一步），文件开头写
  「已省略前 N 字符」，文件名带出 `tail<保留数>of<原文数>`，`onThink` 同步报出
  `原始 / 实际上传 / 省略` 三个数——**绝不静默丢上下文**。1_500_000 不是网页的实测上限，
  而是「真机已知最大 **409,555** 字符（`GET /__webcode/preset` 的 `promptChars`）的约 3.7 倍」
  这个余量的落点；真机两个读数（409,555 与 127,888）都远在它之下，正常轮次不会被截断（护栏 ⑥ 钉住）。
- **可核对读数**：驱动新增实例状态 `attachTransport` 并进 `status()`（`/__webcode/status`）——
  成功 `{ at, name, chars, payloadChars, truncated, evidence, total }`，回落
  `{ at, fallback: true, code, total }`。为什么必须有：附件投递的失败被 `catch` 吞掉后只留一行
  `warn`，用户侧看到的是「照样发出去了」，于是「到底有没有真的走附件」无从判断
  （这正是用户抱怨过好几次的「说做了、其实没做」）。

### 四、本轮实跑的命令（本机必须逐文件跑，`node --test <glob>` 会 `spawn EPERM`）

```
node --check lib/browser-driver.js                      → exit 0
node .tmp/probe-transport-plan.mjs                      → exit 0（4 条分支 + maxChars 非法/缺失/截断边界）
node --test test/prompt-transport.test.mjs              → 8/8 pass（0.16.2 既有判据逐字未变）
node --test test/prompt-transport-attach.test.mjs       → 9/9 pass
node --test test/upload-attachment-structure.test.mjs   → 4/4 pass
```

### 五、连带发现（同一次取证，代码不在本轮改动范围内）

- **`cfg.attachInlineLimitChars` 在 0.16.2 默认是 0（附件投递关闭）**，因此上面整条路径当时
  **从未在真机上跑过一次**——结构缺陷与「默认关」叠加，等于这条能力一直只停在纸面上。
  **0.16.3 起默认改为 60,000**（`0` = 关闭），依据是那轮 127,888 字符纯文本被看门狗判死的
  真机读数；配置面与理由见 `lib/index.js` 的 DEFAULTS 注释。
- `promptTransportPlan` 在 `mode:'inline'` 时的 `payloadChars` 口径歧义（0.16.3 已修）：
  修前 inline + 超上限会返回 `truncate:true / payloadChars:maxChars`，而 inline 路径
  **一个字符都不截**——字段名说的是「会发多少」，读数却是「假如走附件会上传多少」。
  现在 inline 一律 `truncate:false`、`payloadChars = total`、`kept:null`；「若走附件会上传
  多少」只在 `mode:'attach'` 时表达。护栏：`test/attach-callsite.test.mjs` ⑦。
