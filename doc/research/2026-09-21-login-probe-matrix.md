# GLM/千问/豆包/Kimi/Z.ai 五站协议转换 —— Task 0 证据与真机门禁（2026-09-21）

> 对应计划：`doc/plans/2026-09-21-domestic-sites-protocol.md`。
> 本文是 **Task 0（改码前复现钉死）的收口证据**，以及 **Task 1 收口结论**。
> 铁律：DeepSeek 站点不可动；改码前先有证据，严禁猜测。

---

## Task 0.1 登录探针真机矩阵

### 五站现状（providers.js 的 loginProbe，未改，含历史真机注释）

| 站点 | origin | loginProbe.bad（未登录特征） | 已知「有输入框误报已登录」风险 |
|---|---|---|---|
| glm | chatglm.cn | `p:has-text("登录"), button/a:has-text("登录"), …Sign in` | 游客页**自带完整输入框**（真机 2026-09-13）→ 必须靠 bad 特征 |
| qwen | chat.qwen.ai | `button:has-text("登录"/"注册"), a:has-text("登录"), …` | 游客页**自带完整输入框**（真机 2026-09-13）→ 必须靠 bad 特征 |
| doubao | doubao.com | `button/a:has-text("登录"), …Sign in` | 游客页有「登录」入口；已登录入口消失（真机 2026-09-13） |
| kimi | kimi.com | `button/a:has-text("登录"), …Sign in` | 游客页「登录」入口可见（真机 2026-09-13），已登录消失 |
| zai | chat.z.ai | `button/a:has-text("登录"), …Sign in` | 游客页**自带完整输入框** + 发送按钮（真机 2026-09-12） |

### judgeLoggedIn 判定逻辑（lib/browser-driver.js:662-680）
命中 `bad` 且可见 → 判未登录（`probe-bad`）；否则命中 `ok` → 判已登录；
都没有 → 回退「可见 composer 计数 > 0」（`probe-fallback` / `input-fallback`）。

### 空 profile 实测真值（2026-09-21 真机探针 `test-mock/login-probe.mjs`，全部正确）

五站 × 空（一次性临时）profile 无头打开，`judgeLoggedIn` 回读判定，与「空 profile=未登录」真值对账：

| 站点 | 空 profile 判定（应=未登录） | 判定依据 | 结论 |
|---|---|---|---|
| glm | NOT_LOGGED_IN | probe-bad | ✅ 正确 |
| qwen | NOT_LOGGED_IN | probe-bad | ✅ 正确 |
| doubao | NOT_LOGGED_IN | probe-bad | ✅ 正确 |
| zai | NOT_LOGGED_IN | probe-bad | ✅ 正确 |
| kimi | ~~LOGGED_IN~~ → 修后 NOT_LOGGED_IN | probe-fallback → probe-bad | ⚠️ 修前**误报已登录**，修后正确 |

**kimi 误报根因（真机 DOM 抓取 `dump-login-candidates.mjs`）**：kimi 游客页**自带完整富文本编辑器**
（`div[contenteditable="true"]` 可见），登录入口是头部 `button.login-button-text`「登录」与侧栏
`button.next-sidebar-history-list__login`「登录以同步历史会话」。这些按钮在 `domcontentloaded` 一瞬
**尚未水合**，`judgeLoggedIn` 在那一刻 bad/ok 双缺 → 回退成「有输入框=已登录」→ 误报。

**修复（browser-driver.js `judgeLoggedIn`）**：仅当「站点声明了 bad 特征 + 双特征初查都没命中 +
将回退成语义歧义（有可见 composer）」时，对 bad 特征做 **2s 有界 SPA 水合重探**，命中即改判未登录。
快速命中路径零等待；deepseek（未声明特征）完全不受影响；已正确站点不受影响。修后五站空 profile 全对。
时序证据：同一 bad 选择器在 connect 后立即 `count=3/firstVisible=true`（按钮其实一直都在，只差水合那一下）。

> 用法：`REAL_PROFILE=…\sites\glm node test-mock/login-probe.mjs --site glm` 逐站回读。

### 已登录态：本机真机五站回读（2026-09-21 实跑，**留证据**）

上表是**空 profile**（真值=未登录）那一半。已登录那一半此前只写着「待用户真实登录后对账」——
本轮发现本机 `~/.dsh/webcode-edge-profile/sites/<site>` 五站 profile **都已存在**（最后写入
15:07–16:00），于是直接拿它跑了一遍回读，不再等。命令（逐站、间隔 20s 防站点风控）：

```
$env:REAL_PROFILE="$env:USERPROFILE\.dsh\webcode-edge-profile\sites\<site>"
node test-mock/login-probe.mjs --site <site>
```

| 站点 | judgeLoggedIn 判定 | 判定依据 | 用时 | 说明 |
|---|---|---|---|---|
| glm | **LOGGED_IN** | `probe-ok` | 2.7s | 直接命中 ok 特征，**证据最强**（不依赖任何回退） |
| qwen | NOT_LOGGED_IN | `probe-bad` | 2.7s | 该 profile 里确有「登录/注册」入口可见 |
| doubao | NOT_LOGGED_IN | `probe-bad` | 3.1s | 同上 |
| kimi | LOGGED_IN | `probe-fallback` | 4.0s | **弱结论**：bad/ok 双缺 → 回退「有可见 composer」 |
| zai | LOGGED_IN | `probe-fallback` | 4.1s | **弱结论**：同上 |

**「弱结论」是什么意思（必须分开读）**：`probe-fallback` 表示**站点声明的 bad/ok 特征一个都没命中**，
判定退化成「页面上有可见输入框=已登录」。这与三种情况都自洽：真已登录、站点改版使特征失效、
页面没加载完。因此 kimi / zai 这两行的 LOGGED_IN **不能**当作「已登录态不漏报」的证据。

**DOM 原始读数**（`test-mock/login-markers.mjs`，只读；确认上述歧义不是选择器写法错）：

| 站点 | 「登录/Sign in」按钮 | `[class*=avatar]` | `img[class*=avatar]` | `[class*=user-info]` | composer |
|---|---|---|---|---|---|
| kimi | 0 | 2（可见） | 1（可见） | 2（可见） | 1（可见） |
| zai | 0 | 0 | 0 | 0 | 1（可见） |

kimi 有可见头像 → 语义上更像真已登录，但**仍是推断**：头像节点不保证只出现在已登录态。
zai 的页面里**连头像都没有**，只有输入框 —— 这正是 `probe-fallback` 会被触发的原因。

**另一条独立证据（cookie 名扫描，只读、不打印值）**：直接对
`sites/<site>/Default/Network/Cookies` 做可打印串扫描，找 `kimi-auth` / `refresh_token` /
`sessionid` / `qwen-web-session` 等**登录后才会有**的名字。结果：**五站全部零命中**。

> 这条读数**推不出**「没登录」：现代站点普遍把会话放在 httpOnly + 短名 cookie 或 localStorage，
> 登录态不一定以白名单里的名字出现；且 Edge 128+ 的 cookie 值是 app-bound 加密（`v20`），
> 名字之外看不到内容。**它的正确读法是「本机无法用这条通路复核登录态」，不是「未登录」。**
> 如实记在这里，免得下一个人把「零命中」当成反证。

**本轮据此能下的结论**：① glm 的已登录态有**强证据**（probe-ok）；② kimi / zai 只能给弱结论；
③ qwen / doubao 的 `probe-bad` **均已定性为正确**（qwen 用户确认未登录；doubao 见下节，桥 profile 里确实游客页）。

### qwen / doubao 定性（用户 2026-09-21 反馈「除 qwen 外我都登录了」后当场查证）

用户明确表示 **qwen 未登录、其余四站（glm / doubao / kimi / zai）已登录**。据此对 doubao 做了
定向取证（`.tmp/doubao-login-detail.mjs` → `test-mock/doubao-login-detail.mjs`，只读）：

| 读数 | 值 | 含义 |
|---|---|---|
| 落在「登录」子串上的可见元素 | `button.semi-button`「登录」（可见）、`span.semi-button-content` | **是登录入口本身**，不是「退出登录」那种子串假阳性 |
| `[class*=avatar]` 计数 | **0** | 登录态在豆包页头会渲染头像；这里是 0 |
| composer 计数 | 1 | 游客页**也自带完整输入框**（与 glm/qwen/zai 同一形态） |
| 与公开（未登录）访问抓到的页面比对 | **逐字同构**（同样出现「登录」「下载电脑版登录」「关于豆包」、无头像） | 桥 profile 拿到的就是**游客页** |

**结论（有证据，不是推断）**：桥自己的 profile `~/.dsh/webcode-edge-profile/sites/doubao`
**确实处于未登录态**。`probe-bad` 这一判定是对的，探针没有假阳性。

**那用户看到的「已登录」是登录在哪了？** 最可能是登录在**用户自己的 Edge**（或另一个
profile）里，而桥用的是独立 profile 目录（`~/.dsh/webcode-edge-profile/sites/<site>`）。
两者互不相通——这正是 README「登录态按站点各自持久化」那句的代价：**在普通浏览器里
登录，桥看不到**。要修，只能走设置页该站点的「登录」按钮（它开的就是桥 profile 的窗口）。

> **注意**：探针只能证明「**桥 profile 里**是不是游客页」，**不能**证明「用户是否登录过豆包」。
> 这两件事本轮已用「页面逐字同构」分开，不要把结论读成后者。
>
> **残留的不确定**：`[class*=avatar]` 是通用启发式，豆包若换 class 命名，这条读数会失真。
> 但本条结论**不单靠它**——「可见的『登录』按钮」与「页面与未登录公开页同构」两条已足够。

**qwen**：用户已确认未登录，`probe-bad` 与真值一致，探针正确。这一行从「矛盾」改判为**正确**。

**由此得到一条通用教训**：本表此前把「探针判定」与「真实登录态」并列时，隐含假设了两者是
同一个 profile。真正的对账必须先问一句「**你是在哪个浏览器/profile 里登录的**」——否则
「我明明登录了」与「探针说没登录」会同时为真，而两边都没错。
③ kimi / zai 只能给弱结论，要拿到强证据得补「已登录专属」的 ok 特征（当前两站都没声明）。

---

## Task 0.2 GLM 正文残留复现（真机门禁）

### GlmDecoder 现状（lib/decoder.js:578-637）
`content[].type` 仅处理 `think` / `text` / `image`；**`code` / `quote_result` / `execution_output`
等其余 type 被整体跳过**（不 emit、不吸收）。

真机帧结构（glm-free-api 同构）：`{conversation_id, status, parts:[{content:[{type, text, think, image}]}]}`，
`text` 为**累积全文**（按槽位差分只吐后缀，防重复放大）。

### 残留/漏正文的风险点（待真机字节定性）
- 用户在「支付宝 GLN 产品真实对话」看到的**正文残留**，需先钉死：残留字节来自哪个 type、哪几帧——
  是 `quote_result` 里带引用正文被跳过，还是 GLM 原生「内置工具」回灌落在桥的正文流里。
- plan Task 2.1 的依据是这张真机帧类型分布表：`quote_result` / `code` / `execution_output`
  是否带用户可见正文、当前跳过是否造成漏吐。

> ⛔ **门禁**：需用真机（或回放夹具）跑一轮 GLM 工具调用，把原始 SSE 帧全量落盘
> `.tmp/glm-replay/raw-frames.jsonl`，再逐 type 标定。无真机帧时对 decoder 的任何字节级改动都属猜测。

---

## Task 0.3 上下文口径核对（本会话已用只读子 agent 审计，结论：一致）

| 站点 | 展示口径 | 预算口径 | 是否一致 |
|---|---|---|---|
| glm / zai | `1_000_000`（providers.js GLM_CONTEXT_WINDOW） | `1_000_000`（index.js `contextWindowFor` ← m.context） | **一致** |
| qwen | `1_000_000`（providers.js models[].context） | 同上 | **一致** |
| kimi | `1_000_000`（providers.js models[].context） | 同上 | **一致** |

- 唯一备用闸来源：index.js `contextWindowFor()` ← `checkContextBudget()`（metrics.js:274）。
- token 折算唯一单价表：metrics.js `estimateTokens`，展示与预算共用。
- settings-page.js **当前不展示 context**（第 85 行只是「上下文互不可见」注释）——用户
  「上下文长度没被正确写出来」的观感，更可能是**设置页根本没投影该值**，而非展示/预算分源。
- **剩余事项（Task 2.3）**：把「展示上下文」与「发送预算」做成两个显式字段并如实投影到
  `/status` 与设置页；`test/model-labels.test.mjs` 不传参输出须与 0.14.6 逐字不变。

---

## Task 0.4 profile 账户关联核对（本会话已用只读子 agent 审计）

- 目录规则：`accounts.js slotProfileDir` —— 默认槽 `<profileDir>/sites/<siteId>`，第二槽
  `<profileDir>/sites/<siteId>/2`；deepseek 且 mountAtRelayRoot 时直接用 `<profileDir>`。
- Edge 实例来源：browser-driver.js:1260 `chromium.launchPersistentContext(cfg.profileDir, …)`
  —— **右栏窗与独立登录窗共用一个 userDataDir**（同一 cookie 罐），前提是两者走同一个 `accountKey`。
- 路由：web-control.js:900 解析 login 请求的 `accountKey` → index.js 2923 `driverFor(accountKey).openLogin()`
  与右栏 openWindow 同源。**只要登录设置页与右栏传同一个 accountKey，两窗同 profile。**

> **结论**：目录与 cookie 罐本就同源。若用户仍观测到「不关联」，真机复核点依次为：
> ① 设置页传的 accountKey 是否与右栏站点/槽一致（首查）；② 登录态是否真正写入持久 profile
> （window 关得太早 / cookie 存进临时会话）；③ DSH 客户端 `client.cjs` 调用前 accountKey 是否同步完整。
> 这三项均为真机行为，需真机会话逐项复核。

---

## Task 1 收口结论：统一工具调用转换层已在 agent-preset.js 存在，本层只做薄路由

计划 Task 1 本想「新建带状态机的统一转换层（tool-parser / tool-transport）吸收 browser-driver 散落的
标签/正则」。真机勘察（读 agent-preset.js / prompt-variants.js / browser-driver.js）确认：

- **教学**：`serializeFirstTurn` / `trainNoteFor` / `transportNoteFor` 已按 siteId 分三支，正是计划的
  `transportForSite` 映射（glm=```json / deepseek=官方 / 其余=<tool_call>），并有 `prompt-variants` 支撑；
- **解析**：`parseAgentReply` 已吸收 tag / code / 官方 tool-call / 裸 JSON / `<invoke>` XML，被十多个
  `official-*`、`fence-*`、`parse.test` 等测试钉住——**并非散落在 browser-driver**；
- **回注信封**：`resultBlock` 统一产出 `{"mcp_action":"result","name","status","output"|"error"}`，
  由 `serializeDelta` 复用（Task 1.3 早已收敛，无多处散拼）。

因此新建 parallel 解析器必然制造「两处各写一份协议」的漂移，违背计划自己引为纪律的
「唯一真相仍是 agent-preset.js」（prompt-variants.js 头注）。

### 本会话新增（Task 1 薄路由落点）
- `lib/tool-transport.js`：`TRANSPORT_SHAPES` + `transportShapeForSite(siteId)`（唯一路由表，以
  `variantIdForSite` 为底层）+ `teachFor` / `parseReply`（委托 agent-preset，不复制协议）。
- `lib/tool-parser.js`：`createToolParser`（带状态机薄壳，finish 委托 parseAgentReply）+ `parseToolFence`。
- `test/tool-transport.test.mjs`：10 项护栏全绿（路由 / 教学委托 / 解析委托 / 状态机 / 信封同构）。

**不触碰 DeepSeek（official 分支只路由不实现）；任何解析/教学改动继续走 agent-preset 为唯一真相。**

---

## 真机门禁清单（需用户真实登录态后逐项完成）

1. **Task 0.1（空态已完成；已登录态**部分完成**）**：空 profile 五站全对；已登录态本机真机五站已回读（见上节表），
   但只拿到一条强证据（glm 的 `probe-ok`）。仍待**人工目视**定性两件事：qwen / doubao 的 `probe-bad`
   是真未登录、还是已登录页上的假阳性（后者会漏报）；kimi / zai 要拿强结论需补「已登录专属」ok 特征。
2. **Task 0.2**：GLM 工具调用真机 SSE 全量落盘 → 标定 `quote_result/code/execution_output`
   byte 行为 → Task 2.1 修 decoder。
3. **Task 0.4**：真机复核「独立登录窗 ⇄ 右栏窗」accountKey 一致性。
4. **Task 2.4 / Task 3**：五站真机工具闭环 + `real-mirror-matrix` 10/10。

> 以上为登录态感知的验收项；离线可做部分（Task 1 已交付、Task 0.3 结论已出、Task 2.3 投影改造
> 可离线写码）。凡真机才能定性处，本会话一律不猜测改码。