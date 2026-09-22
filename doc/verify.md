# 验收记录

本文件按版本追加。最新在最前。

---

# 0.19.0 补记 —— 第三轮对抗审查抓到的 2 条真缺陷（887 条单测当时全绿也看不见）

日期：2026-09-22（同日追加）。工作树仍为 **0.19.0**。

## 为什么要单开一段

前三轮的读数是「887/887 全绿」，而这一段记的两条缺陷**全部逃过了那 887 条**。
它们不是靠读代码发现的，是靠**动态驱动真实组件** + **变异测试**发现的。
记在这里的理由是：**「测试全绿」不等于「功能可用」**，而这两条正好各自打破了
用户三条要求里的一条（③ 的 Team 用不了、② 的反馈看不到）。

## 一、阻断级：`MultiModelCompareView` 一次挂载只能发一句话

**症状（动态复现，非推断）**：从已注册的 `conversation.view` 槽取出真实组件 → 驱动表单
提交 → 解析 chat 请求并让其返回。读数：提交后按钮 `发送中… disabled:true`；**三列回复全部
到达后，按钮仍是 `disabled:true`**；三列状态均为「已完成」。
即：**列全绿、按钮永久锁死**，`conversation.view` 是中央常驻视图不随交互卸载，**不自愈**。

**根因**：`setSending(false)` 是全文件**唯一**的解锁点，而它被写在**微任务**里的一个
`setCols` updater 内，判据是「没有列处于 streaming」。那段微任务排进队列时，上面刚把每列
设成 `streaming`，而 POST chat 的往返还没回来 ⇒ 判为「仍有 streaming」⇒ 提前返回，
**解锁行永不执行**。

**修法**：① 用 `pendingRef` **计数**在途列数（发出 `+= jobs.length`、`finally` 里 `-= 1`、
归零才解锁）——`finally` 保证**失败也减**，不存在「一列异常永久锁死」；
② 把 `setSending` **移出** updater（在 updater 里调另一个 setState 是不纯 reducer，
StrictMode 双调用下行为未定义）。

**护栏**：`team-compare.test.mjs` 新增「发送锁必须必然解开」——禁 `Promise.resolve().then(`
式延时猜测、禁 updater 内调 `setSending`、要求计数 + `finally` + 归零判据、且
`setSending(false)` **全文件只能出现一次**。**反向验证**：退回旧写法 → `FAIL(1)`；还原 → PASS。

## 二、严重级：详情页的写操作反馈**一条都渲染不出来**（本轮自己引入的回归）

**症状（动态复现）**：渲染看板 → 点卡片进详情页 → 点「保存修改」：
`POST task-update` **真的发出**，而「已保存。」在**任何**渲染树里都不存在。
⚡ 派发路径同：`task-implement` → `chat` 都带正确的 `{siteId, prompt, sessionKey}` 发出，
而「已按批注派发」/「派发失败」/模型回复**都不出现**。

**根因**：`notify()` 的**全部** 16 个调用点都在 `TaskDetailNotionView` 的写回调里，
而 `boardNotice` 横幅只在**看板/列表分支**渲染 —— `TaskBoardPanel` 在
`if (selectedTaskId)` 处就 `return h(TaskDetailNotionView, …)` 了，**永远走不到**渲染点。

**性质**：这是**本轮把 `alert()` 换成内联横幅时丢掉的那一半**（`alert` 是阻塞弹窗，
与挂载分支无关，所以旧实现不会有这个问题）。属于本项目反复记过的「说做了、其实没做」——
写入确实到了服务端，但用户看不到任何结果，**包括被 CAS 拒绝与被派发失败的结果**。

**修法**：把 `notice` / `onDismissNotice` 传进详情页并在其体内渲染（两处渲染点：看板 + 详情页）。
**护栏**：`client-render.test.mjs` 新增「详情页写操作反馈必须有渲染出口」——要求组件**接收**
该状态、**体内真的渲染**它、关闭回调**真的被调用**、且两处渲染点都在。
**反向验证**：把详情页那一句渲染改成恒假 → `FAIL(1)`；还原 → PASS。

## 三、三条护栏逃逸（子代理在沙箱副本里变异验证，均已修并各自补判据）

| # | 逃逸形态 | 后果 | 为何漏网 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | `onImplement` 忽略 chat 结果，换一句无条件成功 | **派发失败被报成成功** | 没有任何断言覆盖 chat 结果的消费 | 补判据覆盖「chat 失败必须标失败」 |
| 2 | `verdictOf` 的 `ok === false` 分支反转成返回成功 | **服务端明确拒绝被报成成功**（正是该判据要防的假成功） | 上一版**只钉了白名单那一支**（`ok === true`），黑名单分支从未被钉 | 两支都钉，且钉**返回语义**而非字面量存在 |
| 3 | 按站点忙碌锁退回全局锁（`isBusy(sid)` → `busySids.length`） | 重新引入「其它站点点击被静默吞掉」 | 判据只禁**单数**字面量 `if (busySid) return;`，只断言 `isBusy` **被定义**、从未断言它**被用作守卫** | 断言守卫**确实调用** `isBusy(sid)` |

**对照实验**：子代理另做了一条无害变异（插入 `const __unused = null;`）——**照样存活**，
说明其方法能区分「真缺陷」与「噪音」，不是见变异就红。

## 四、Lead 复跑的反向验证（每条都先断言「变异确实生效」）

| 判据 | 变异 | 读数 |
| --- | --- | --- |
| 发送锁必然解开 | 退回「微任务扫 streaming」 | **FAIL(1)** ✔ |
| `verdictOf` 两支都钉 | 黑名单分支反转成成功 | **FAIL(1)** ✔ |
| 详情页反馈有出口 | 详情页渲染点改为恒假 | **FAIL(1)** ✔ |
| 忙碌锁按站点 | 退回全局锁 | **FAIL(1)** ✔ |

四条全部还原后**逐字一致**、复跑 PASS。**方法论**：脚本每次都先断言「替换确实生效」再判定
（前两轮各栽过一次「替换静默失效 → 把有效护栏误判成装饰品」），因此本轮没有假阴性。

## 五、第三轮明确「无发现」的类别（逐项核实，不是略过）

- **跨作用域/未定义标识符 —— 干净**：用大括号配对的作用域走查解析了五个组件里每个被调用的
  标识符；此前那条 `siteSlot` 跨组件引用**确已修好**（`slotOf` 现为本地定义）。
  仅有的「未解析」命中都只出现在**注释里**（如 `openTab`）或关键字/内建。
- **hooks 规则 —— 干净**：逐组件枚举每个 hook 调用与非表达式 `return`，五个组件里
  **每个 hook 都在每个提前 `return` 之前**。
- **`busySids` 并发逻辑 —— 干净**：解锁按发起站点 `filter`，`apiSoft` 不抛异常，
  不存在「永久忙碌」或「永久空闲」的交错；单值版本那个 `点A→点B→B先返回清空A` 的交错**已消失**。

## 六、顺带抓到并修掉的一处：注释被当成代码调用

修完上面两条后，`client-server-contract.test.mjs` 报 **`GET chat` 未在服务端注册**
（真机会是 HTTP 405）。核查：`chat` 在服务端**只有 POST**；出问题的是我写的**注释**——
它在解释旧缺陷时逐字引用了 `api('chat')`（**不带第二个参数**），而契约测试按**源码文本**
解析调用（不剥注释），于是把「说明」读成了「GET 调用」。
这与本仓库记过多次的坑同源（护栏/契约测试匹配到注释）。修法：注释改写成散文措辞
（`下面那句 POST chat`），不再出现可被解析为调用的字面量。

> **可复用的教训**：本仓库有三处判据直接**按源码文本**解析（契约测试、护栏、变异脚本），
> 它们**都不剥注释**。因此**注释里不要写出可被解析成真实调用的代码字面量**——
> 尤其不要写「没有第二个参数的 `api('x')`」这种形态（会被读成 GET）。
> 需要引用旧写法时，要么改写成散文，要么确保字面量不会被误解析。

---

# 0.19.0 —— 三项用户要求（③ 删 Team / ② 任务板与 Word 审批 / ① 登录收敛）＋ 两轮独立审查

日期：2026-09-22。环境：Windows、Node v24.18.0。工作树版本 **0.19.0**。

## 零、一句话结论与「尚未真机生效」的如实声明

**已做成的**：三项要求的代码与护栏全部落地，全量 **887/887 通过 exit 0**，四个离线闸门全 PASS，
tarball `verify-pack` **42/42 逐字相同 + 接线完好**，两个 profile 均已装入 **v0.19.0** 且**声明与
lock integrity 已同步**。

**尚未做成的**：**线上 3080 进程跑的仍是 0.18.0**——0.19.0 的客户端改动要**重启 DSH** 才生效。
因此本文件中一切「界面项」的真机目视核对（任务板观感、Word 双栏、登录按钮、并列多会话视图）
**都还没有做**，如实记为待办而不是已完成。

## 一、本轮真机验证（teammate `verify-live`，线上 3080，脚本与读数见 `.tmp/verify-live-report.md`）

**验证版本证据**：`GET /__webcode/status` 起止各读一次，均为 `build.version=0.18.0` /
`hash a86bce573e0b`（读数不变，说明验证期间进程未被换掉）。**注意它验的是 0.18.0，不含本轮
0.19.0 的 `client.cjs` 改动**——所以下面这些是「0.19.0 所继承的基线事实」，不是 0.19.0 的验收。

| # | 项 | 读数 | 判定 |
| --- | --- | --- | --- |
| ① | `glm` 一轮真实请求 | `{"ok":true,"reply":"9","fresh":true}`，5.2s | **通过** |
| ① | `kimi` 一轮真实请求 | `{"ok":true,"reply":"9","fresh":true}`，5.9s | **通过**（`probe-fallback` 弱判据此次为真阳性） |
| ① | `doubao` | 502 `NEED_LOGIN: 豆包 会话缺失` | **失败，但理由真实**。发送前缓存 `loggedIn=true/probe-fallback` 是弱判据**假阳性**；失败后 `/status` 自我更正为 `probe-bad/needLogin=true`，per-site store 为 `{}` 互证。**桥没有谎报成功** |
| ① | `qwen` | 502 `NEED_LOGIN` | **失败，与已知 `loggedIn=false` 一致** |
| ① | `zai` | 502，耗时 241.1s | **失败，根因未定位**。旁证：网络可达（probe 200）、页面已开新会话（消息确实送达）、`loggedIn=true/probe-ok`，但 per-site store 仍 `{}`（会话未落地）。**未取得 502 正文、未观察到 captcha 证据，故不归因验证码**——按纪律记「读不到」 |
| ② | 并列多会话语义 | 轮 1「只回一个数字：7」→ `reply:"7", fresh:true, resumed:false`；轮 2「上一个数字加 1」→ `reply:"8", fresh:false, resumed:true` | **通过（强证据）**。答对「上一个数字 +1」**只有真续上同一对话才可能**；`webSessionId` 前后均为 `6ab24430f04b04ef5e183534`，且与 glm 页面 `cid` 互证 |
| ③ | 任务板 6 端点全链路 | create(rev0) → update(pending→in_progress, attempts 0→1, rev1) → comment(rev2) → comment-resolve(resolved false→true, rev3) → implement → delete(软删, rev4) | **全部 `ok`** |
| ③ | **诚实性核对 1：CAS 是否真被消费** | `POST task-comment` 带过期 `expectedRevision=0` → `{"ok":false,"error":"revision-mismatch: expected 0, actual 1"}` | **通过**（过期写入被真实拒绝，不是假成功） |
| ③ | **诚实性核对 2：`task-implement` 是否谎报派发** | 返回 `{"dispatched":false,"dispatchBy":"client"}` | **通过**（如实标注「客户端负责派发」） |
| ③ | 反向：伪造 `taskId` / 空 prompt | `{"ok":false,"error":"task-not-found"}` / `empty-prompt` | **通过** |
| ④ | 探针清理 | 默认台账可见行 2 → 1（余 `t4` 非本次探针，未动）；bridge 作用域那份可见 0 | **通过** |

**风控合规**（硬约束，逐条可核）：单站 1 次、**零重试**、站间实测最小 **32s**、prompt 极短。
真实发送合计：glm 3（② 两轮 + ① 一轮）、zai/doubao/kimi/qwen 各 1。

## 二、真机暴露的两条**口径**问题（已验证，存档以免下次踩坑）

这两条**不是**缺陷，是「按直觉用会得到错误结论」的机制，必须写下来：

1. **`/status` 的 `conversations` 是「默认 deepseek 站点」的映射**（128 键已满额裁剪），
   **不含**发往其它站点的 key；`GET session-slot?siteId=zai` 也**不按传入 siteId 路由**
   （实测回 `siteId:"deepseek"`）。
   ⇒ **跨站核对必须读该站 `profileDir` 下的 `webcode-sessions-<siteId>.json`**，
   用 `/status.conversations` 做跨站验证会得到错误结论。
2. **任务台账的存储根**取 `body.workspaceRoot || config.workspaceRoot || process.cwd()`。
   不传 `workspaceRoot` 时，线上落到**宿主 cwd 工作区**（实测 `…\A0-Robocup\.webcode-tasks\ledger.json`），
   **不是本仓库**；且与传 `workspaceRoot` 的那份**互不可见**。那才是任务看板 UI 读的那一份。
   （据此已在 `.gitignore` 补 `.webcode-tasks/` 规则，理由见该文件注释。）

## 三、测试与闸门读数（全部本机实跑）

| 闸门 | 命令 | 读数 |
| --- | --- | --- |
| 全量单测 | `node --test test/*.test.mjs` | **887/887 通过、exit 0**（75 文件） |
| 注释闸门 | `node scripts/lint-comments.mjs` | **PASS**（149 文件 error 0 / warn 0） |
| 台账闸门 | `node scripts/check-ledger.mjs` | **PASS**（version 0.19.0、testFiles 75/75） |
| 文件规范 | `node scripts/check-repo-hygiene.mjs` | **PASS**（BOM / 索引死链 / Node 版本） |
| 参考索引 | `node scripts/gen-reference-index.mjs --check` | **PASS**（45 条目，0 个不在本机） |
| 客户端-服务端契约 | `node --test test/client-server-contract.test.mjs` | **2/2**（新路由未破坏契约） |

> **一条必须记住的判据**：全量测试**必须串行、独占**跑。本轮一次全量跑出现
> `regression.test.mjs` 超时（400,668ms）+ 1 fail，而**单独跑该文件 54/54 通过**——
> 根因是当时机器上并发跑着多个 `node --test` 进程（我的后台全量 + teammate 的复跑），
> 该文件含多条**真实驱动计时**用例（单条 20s/40s/60s），争用把某条推过了文件级超时。
> **并发跑出的红不是代码缺陷**；判据一律以独占复跑为准。

## 四、发布闸门与装机（实读）

| 项 | 怎么读的 | 读数 |
| --- | --- | --- |
| tarball | `pnpm pack` | `dsh-webcode-bridge-0.19.0.tgz`，**565,140 字节** |
| 打包一致性 | `node scripts/verify-pack.mjs` | **逐字相同 42/42** + 接线完好 + tarball 与工作树一致 |
| 装机 | `node scripts/install-profiles.mjs` | web = **v0.19.0**、headless = **v0.19.0** |
| 装机内容与工作树同源 | 五文件 × 两 profile 的 sha256 前 12 位 | `client.cjs` **79D29ABC1C93**、`browser-runtime.js` **DCEFFBE2BDCB**、`web-control.js` **0D2F3F8B1367**、`settings-page.js` **FD4439BBEC2E**、`roster.js` **8F33D53C9BDC** —— **10/10 全部相同** |
| profile 声明 | 两 profile 的 `package.json` | 均 **0.19.0** |
| **lock 声明与 integrity** | 两 profile 的 `pnpm-lock.yaml` | 均指向 `dsh-webcode-bridge-0.19.0.tgz`、`version: 0.19.0`、integrity `sha512-rVBztarjGVVz9WHXbtswr7YMzSf279a64b/rLSa6AQHpc41AEAAW2wPX8LOl59dXefBy0ZqdMl1sdb+QAheCsg==`（**由 tarball 原始字节独立重算核对一致**）；逐行 diff 比对备份证明**只有 bridge 条目变动**，`modsearch` / `dsh-drop-caret` / `dshmarket` / `playwright-core` 的 integrity **未被误伤** |

> **本轮实测读数会随修复推进而更新**（本文件按「最新在最前」追加，但同一版内我选择**直接更新为最终值**而不是留一串中间值）：tarball 因第三轮修复经历过 563,279 → 563,545 → **565,140** 三次打包，`client.cjs` 的 sha256 相应由 `9BCAF917B600` 变为 **`79D29ABC1C93`**。**每一次重打包都重新同步了路径 + integrity + version 三项并独立复算核对**——只改路径不改 integrity，pnpm 通道会校验失败或按旧值回退。

> **与 lock 同步有关的纪律**（本项目 §0.16.10 七记过）：`install-profiles.mjs` **绕开 pnpm**
> 直接写 `node_modules`，**不改**声明与 lock。不同步的话，任何一次走 pnpm 的操作都会按 lock 里的
> 旧 tarball 把 `node_modules` **静默回退**到上一版。本轮已同步，且用**逐行 diff 比对备份**证明
> 只动了该动的条目。

## 五、两轮独立审查（含反向验证）

| 轮次 | 执行者 | 结果 |
| --- | --- | --- |
| 第一轮 | teammate `reviewer-1` | 报告 `.tmp/review-round1.md`：**4 条发现**，3 条真并已修（含 1 条阻断级：跨组件作用域 `ReferenceError`），1 条护栏逃逸已修；另跑 **8 条反向验证**（原本 6 有效 / 2 逃逸） |
| 第二轮 | teammate `reviewer-2` | **中途失败退出、未产出报告**（如实记）。其退出前给出的唯一结论「`teamSource` 失去唯一消费者」经核实**为真并已修**；其余角度由 Lead 自行复核并留痕（见 `doc/progress.md` 对应行） |

**第一轮修完后的反向验证（Lead 复跑，证明护栏不是装饰品）**：三条此前「不变红」的逃逸形态
**现已全部变红**——I（保留定义、调用改回 `siteSlot(`）→ fail 1；F（删掉菜单项 `disabled`）→ fail 1；
G2（改回全局锁）→ fail 1；还原后 **7/7 pass**。

**本轮新增护栏一览**（每条都做过反向验证，删判据即变红）：
官方花名册 Team 面板不得复活 / `conversation.view` 必须注册并列多会话 / label 不得自称「三列」/
CSS 只许用官方已有的 dsw token / 按钮走官方 button-info 语义 token 且禁 `alert` / 看板列数不得写死 /
Word 范式三件套（含锚点原始下标）/ 写路径必须吃 CAS 且成功判据白名单式 / 登录入口不得指向桥以外的
浏览器（按组件体）/ 目录不得跨组件引用 `siteSlot` / 忙碌态按站点判定且两个入口都有 `disabled` /
`teamSource` 三段链路齐全 / 右栏座位集合与标签页类型集合实测值。

## 六、待办（未做，如实记）

1. **重启 DSH** 使 0.19.0 生效（当前 3080 仍是 0.18.0）。
2. 重启后逐项目视核对：任务板观感与官方审美、人工新建/编辑/删除任务、Word 式左正文右批注栏
   （含正文侧锚点留痕）、站点目录的单账户「登录」按钮与多账户菜单项、中央对话区并列多会话视图。
3. `zai` 一轮超时的根因（本轮仍未定位；**不采信**「阿里云验证码」这一未经证实的归因）。
4. `doubao` / `qwen` 在桥窗口内登录后是否可用（本轮读到的是「未登录」这一真实状态）。
5. 多账户站点（`glm#2`）的真机登录窗口实测。

---

# 0.16.40 已装机（实读）＋ 0.16.39 装机核对（历史）

日期：2026-09-21 17:16（读数取自运行中的 3080）。环境：Windows、Node v24.18.0、DSH 0.1.6-alpha.2。

## 一、装机与进程（全部实读，非推断）

| 项 | 怎么读的 | 读数 |
| --- | --- | --- |
| 运行中的进程 | `GET http://127.0.0.1:3080/__webcode/status` 的 `build` | `{hash:'f7e3cc76d4e8', version:'0.16.39'}` |
| 两个 profile 的声明 | 读 profile 的 `package.json` 依赖 + `pnpm-lock.yaml` | 均指向 `dsh-webcode-bridge-0.16.39.tgz`，`version: 0.16.39` |
| 两个 profile 的内容 | 两个 `node_modules/dsh-webcode-bridge/package.json` | 均 **v0.16.39** |
| 装机内容与工作树同源 | 三处 `lib/client.cjs` sha256 前 12 位 | 均为 **F1DAEBA4AB3E**（286,290 字节） |
| 全量单测 | `node --test test/*.test.mjs` | **853/853 通过、exit 0**（72 文件，399s） |
| 离线闸门 | `lint-comments` / `ref-index` / `check-ledger` | 依次 PASS（143 文件 0/0）、PASS（45 条目）、PASS（0.16.39 + 72/72） |

> **0.16.38 那一节整体已被本版覆盖**：它写的「当前进程仍是 0.16.37 ⇒ 十项待重启核」
> 在今天已经成立过又过期了（0.16.38 → 0.16.39 两次装机，进程现为 0.16.39）。
> 那一节按本文件「按版本追加」的纪律**原样保留**作历史，不再往回改。

## 二、0.16.39 界面项：进程已就位，可真机核对

下面五条**不是**待重启项（进程已经是 0.16.39），是「打开页面看一眼」即可定论的项：

| # | 要看的 | 怎么判 |
| --- | --- | --- |
| 1 | 站点目录宽度 | 「Web Bridge」标签页里目录恒 **380px** 且居中，窄面板下收缩并留左右 12–20px |
| 2 | 等待药丸面板 | 面板**左边缘对齐**触发胶囊、贴近视口边时被夹紧不溢出、字号随设置缩放 |
| 3 | 选站点 | 点目录里一行站点 → **替代当前 Web Bridge 标签页**（不新开一格） |
| 4 | 工具条图标 | 四颗动作按钮是官方线框图标（刷新 / 独立窗口 / 新面板 / 浮动），28×28 |
| 5 | 设置页统计块 | 「速度与等待」里累计统计块的数值与药丸面板**同源**（服务端 `statBlocks` 现算） |

## 三、0.16.40 改动（**未打包、未装机**，发版前必读）

工作树里有两项 2026-09-21 网页会话所做的真机协议适配，**尚未进任何 tarball**：

- **Kimi 迁 Connect-RPC**：kimi 网页已弃用旧 SSE，改走 `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`
  （`application/connect+json`，响应为 `[flags(1)][len(4BE)][json]` 二进制帧流）。
  `providers.js` 补端点 + `streamTransport:'connect'`；`browser-driver.js` 的 `captureInit` 加字节切帧；
  `decoder.js` 新增 `kimi-connect` 解码器。
- **GLM 工具轮后正文残留**：真机抓帧确证「增量碎片 → 工具轮 → 完整段落快照（连续两帧重发）」混合语义，
  旧解码器把同一段播两遍；现按段累积做去重 + 前缀补全。

**已做完**：`pnpm pack` → `verify-pack`（41/41）→ `install-profiles.mjs` 装两 profile →
声明同步到 0.16.40 + integrity 写入。**只剩重启与真机**：重启 DSH 后各跑一轮，
看 Kimi 工具闭环能否连续、正文是否完整，GLM 工具轮正文是否不再加倍。
**未真机跑通前不宣布这两项完成。**

---

# 0.16.38 装机核对与**待重启真机验收**清单（历史）

日期：2026-09-21。环境：Windows、Node v24.18.0、DSH 0.1.6-alpha.2。

## 一、已完成（已实测）

| 项 | 判据 | 结果 |
| --- | --- | --- |
| 全量单测 | `node scripts\ci-local.mjs` 的 `test` 步 | **exit 0**（396s） |
| 注释闸门 | 同上 `lint-comments` | PASS |
| 台账闸门 | `check-ledger` | PASS（version 0.16.38 / testFiles 70/70） |
| 仓库卫生 | `repo-hygiene` | PASS |
| 参考索引 | `gen-reference-index --check` | PASS（43 个存在条目全一致） |
| 生成物卫生 | `artifacts-check` | PASS |
| 装机（两 profile） | `install-profiles.mjs` | web / headless 均 **v0.16.38** |
| 装机内容与工作树同源 | 三处 `lib/client.cjs` sha256 前 12 位 | 均为 **F70D2E1EA0E8**（269,729 字节） |

## 二、**待重启**才能验的部分（当前进程仍是 0.16.37）

实测：`GET http://127.0.0.1:3080/__webcode/status` 的 `build` = `{hash:'33eaf0dcf185', version:'0.16.37'}`
⇒ 运行中的进程尚未加载 0.16.38。下面每一条都必须**重启 DSH 并刷新页面**之后才谈得上核对。

| # | 要看的 | 怎么判 |
| --- | --- | --- |
| 1 | 构建指纹 | 设置页顶部显示 `v0.16.38` |
| 2 | 站点 tab 条 | **一行**、可鼠标滚轮横滚、看不到滚动条、与下方分隔线有间距 |
| 3 | 等待药丸 | 与官方统计药丸**等高同排**；把侧栏拖窄，它跟着收缩（不再定长） |
| 4 | 全局页卡片 | 有「发送间隔（全局）/ 提示词投递 / 连接 / 速度与等待 / 会话与子代理 / 正在运行 / 全局指令 / 首轮提示词（只读）」；**没有**「账户与登录管理」「模型管理」 |
| 5 | 站点页卡片（任选一个站点 tab） | 有「该站点的账户与登录 / 该站点的模型 / 该站点的首轮提示词 / 该站点的排队间隔」；**没有**「正在运行 / 提示词投递 / 会话与子代理 / 全局指令」 |
| 6 | 站点提示词文件 | 站点页显示等宽路径；点「用默认程序打开」→ 系统默认编辑器打开 `prompts/<site>.md`；从未发过消息时如实报「还没生成」并显示路径 |
| 7 | 每站只能改自己的 | 在站点 A 改「本网站指令」保存，切到站点 B，B 的输入框**不被影响**；全局指令两页都不串 |
| 8 | Z.ai 显示名 | 站点 tab、模型下拉、图标 title 全部是 `Z.ai`，不再出现「GLM 海外版」 |
| 9 | DeepSeek 图标 | 站点目录/首屏网格/工具条三处都不越出图标框，与其它站点光学居中一致 |
| 10 | 站点级模型 | 站点页「本网站默认模型」选一支保存；「用本站点作为主线默认」改写全局落点；跨站点的旧值被忽略（看 `/__webcode/settings` 回读） |

**真机取证方式**（与前几版一致）：直接读 `/__webcode/status`、`/__webcode/settings`、
`/__webcode/prompt-variants` 三个端点的 JSON；必要时用 `test-mock/real-probe-*.mjs` 系列脚本。

## 三、尚未验证的诚实记录

- 站点提示词的**契约指纹变化**会让下一轮整段重建一次网页会话（预期行为）：真机上表现为
  「改完指令，下一轮网页侧开了一个新对话」。若要避免这种观感，属产品取舍，不在本轮范围。
- 「用默认程序打开」在 Windows 上依赖 `.md` 的文件关联：未关联编辑器时 `explorer.exe` 可能
  只打开所在目录（此时会回落 `rundll32` 再试一次，仍失败则如实回 `OPEN_FAILED` 并把路径显示出来）。

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

归因要点（`session-log-review.md` 已按用户指示于 2026-09-16 删除，下表是本节的证据本体）：

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
`.local-plans/PLAN-0.14.0-HANDOFF.md` §0.0 的短清单收尾（GLM 连发两轮、`:8931` 间隔、A-4b）。

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

按 `.local-plans/PLAN-0.14.0-HANDOFF.md` §4 的 P2-2 矩阵逐项验收，本轮重点：

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

按 `.local-plans/PLAN-0.14.0-HANDOFF.md` §4 的 P2-2 矩阵逐项验收，重点是：`build.version === '0.14.1'`
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
---

## 0.15.5 反向验证记录：零进展轮顺序纠正（本轮实跑）

护栏 test/zero-progress.test.mjs 写完必须先证明能红（doc/comment-style.md 9.3）。

### 反向：把 zeroProgressDecision 的两条判据换回旧顺序

命令：node test/zero-progress.test.mjs
结果：exit 1，fail 2
  ✖ 正文空 + 思考非空 + 有扣留协议 → thinking-only（旧顺序会静默吞掉这一类）
  ✖ 顺序契约：thinkAcc 判定必须先于 withheld 判定（旧顺序会变红）

### 还原：恢复 thinking-only 优先于 protocol-withheld

命令：node test/zero-progress.test.mjs
结果：exit 0，pass 11 / fail 0

### 全量回归（修复后）

命令：逐文件跑 test/*.test.mjs（本机 node --test glob 仍 spawn EPERM，不用 glob）
结果：FILES PASS=36 FAIL=0
额外入口：test/parse.test.mjs、test/run-m1.js、test-mock/bench-ci.mjs、test-mock/artifacts-check.mjs 均 exit 0

### 真机缺陷的原始现场（子代理会话 ecad7b6a）

  step1  usage={inputTokens:26263,outputTokens:197}   blocks=[text(66), tool-call(pwsh)]
  step2  usage={inputTokens:28555,outputTokens:0}     blocks=[reasoning(201)]
  turn/end reason=completed

后果：doc/research/graph-plugins-references.md 与 panel-plugins-references.md 均 MISSING，
      reference/ 无任何新克隆。

> 注：本条修复尚未经过真机复验（需重启 DSH 后由新的子代理会话确认 outputTokens > 0 且产出文件）。
  在重启验证之前，不得宣称真机已修好。

---

## 0.15.6 反向验证记录：参数含围栏的调用被丢弃并整段泄漏（本轮实跑）

护栏 `test/fence-nested-call.test.mjs` 写完必须先证明能红（doc/comment-style.md §9.3）。

### 缺陷现场（0.15.5 引入的回归）

用户报的症状：**「harness 端的 markdown 渲染整块不见（web 正常）」**。

`write` 一份含代码块的 markdown 文档时（写报告/README/代码的主路径）：

1. `parseAgentReply` 的非贪婪围栏正则 `/```([\s\S]*?)```/` 在**第一个内层 ```** 处
   截断体 → `JSON.parse` 失败 → `takeObj` 静默 return → **调用消失，文件从未落盘**；
2. `firstCallFenceAt` 用同一个错误窗口 → `hasJson=false` → 真调用围栏被判成普通围栏
   → `findProtocolStart` 返回 **-1**；
3. `proseSafeEnd` 在 index=-1 时返回全文长度 → **整段原始协议被当正文外发并持久化**。

### A/B 实测（`.tmp/probe-audit-regress.mjs`，同一段文本）

| 版本 | boundary | proseSafeEnd | withheld | parsedCalls | contentIntact |
| --- | --- | --- | --- | --- | --- |
| 0.15.3 | 53 | 53 | 313 | 0 | false |
| **0.15.5** | **-1** | **366（全文）** | **0** | 0 | false |
| **0.15.6** | 53 | 53 | 313 | **1** | **true** |

即：0.15.3 好歹扣住了协议（只是丢调用），**0.15.5 把「扣住」变成了「全泄漏」**。
控制组（参数里没有围栏）两版都正确解析出 1 个调用 ⇒ 缺陷只由参数内的围栏触发。

### 为什么是「莫名其妙」而不是「必然」（本轮新查明的间歇性）

丢调用取决于**尾部形状**：旧代码里 `bareObjRe` 的 `(?=<|$)` 用非多行串尾收尾。

| 尾部形状 | 旧：调用 | 旧：bareObjRe 命中 | 新：调用 |
| --- | --- | --- | --- |
| 闭合围栏 + 换行 | **0（丢）** | 0 | 1 |
| 闭合围栏（无换行） | **0（丢）** | 0 | 1 |
| 无闭合围栏（截断） | 1（侥幸救回） | 1 | 1 |
| 闭合围栏 + 后续正文 | **0（丢）** | 0 | 1 |

这解释了用户的「**总是莫名其妙**」：同一种写法，尾部差几个字符，结果就不一样。
（`.tmp/probe-why-intermittent.mjs`）

### 反向：把本次三处改动逐字倒回修复前

0.15.5 的修复前源码**未入库**（那次改动至今未提交），故由当前文件反推：
反向 1 = `firstCallFenceAt` 窗口倒回「下一个 ```」；反向 2 = 围栏扫描倒回非贪婪 regex；
反向 3 = 移除 `proseSafeEnd` 的兜底。（`.tmp/rev-0155/agent-preset.js`）

命令：`node .tmp/rev-check.test.mjs`（新测试指向修复前副本）
结果：**exit 1，pass 5 / fail 7**

```
✖ ① write 调用、content 含一组 json 围栏 → 解析出 1 个调用，content 逐字完整
✖ ② 同上 → 边界探测停在围栏起点、transport=true（不得退化成 -1）
✖ ③ 同上 → proseSafeEnd 停在围栏起点，协议被扣住而不是全文外发
✖ ④ content 含三组不同类型围栏 → 仍解析出 1 个调用且内容完整
✖ ⑧ 流式半成品（JSON 未配平、参数里刚出现内层围栏）→ 仍是协议边界
✖ ⑨ arguments 是「转义 JSON 字符串」且内含围栏 → 仍解析出调用
✖ ⑩ edit 调用、new_string 含围栏 → 解析出调用且内容完整
```

⑤⑥⑦⑪⑫ 在修复前后**都是绿的**——它们正是反向安全线：修 ②③ 不得削弱 0.15.5 的
原始修复（⑤⑥）、不得动摇标签族 transport（⑪）、不得放过普通散文（⑤）。

### 还原：恢复花括号感知的围栏定位

命令：`node test/fence-nested-call.test.mjs`
结果：**exit 0，pass 12 / fail 0**

### 全量回归（修复后）

命令：逐文件跑 `test/*.test.mjs`（本机 `node --test` glob 仍 `spawn EPERM`，不用 glob）
结果：**FILES PASS=37 FAIL=0**（含新增的 fence-nested-call，共 37 个文件）
另：`control-routes.test.mjs` 偶发 `bad port`（`server.listen(0)` 取临时端口后连接失败），
    重跑 4/4 通过，属**既有的测试侧 flake**，与本次改动无关。

注释闸门：`node scripts/lint-comments.mjs` → 129 个文件，error 0 / warn 0，exit 0。

### 行为等价性核对（改解析器必须有这一步）

把修复前/后的 parser 对同一批**边角形状**对比，确认除目标缺陷外行为逐字不变：

```
bareFragment      old=1 new=1 SAME     fragPlusEmpty     old=0 new=0 SAME
tagTruncated      old=0 new=0 SAME     callingTruncated  old=0 new=0 SAME
plainProse        old=0 new=0 SAME     benignCalling     old=0 new=0 SAME
```

孤立残片 `<call>` / `</call>` / `<call_call>` / `</call_call>` / `</tool_call>` 的
`transport` 全为 false，与 0.15.3 逐字相同。

### 影响面量化（`.tmp/scan-fence-calls.mjs`，97 个会话）

参数里含 ``` 的 tool-call 共 **108 个**：

```
by tool: { write: 43, edit: 43, pwsh: 9, exit_plan_mode: 9, send_message: 3, subagent: 1 }
最大: write argLen=31730 ticks=22
```

⇒ 这是写文档/写代码的**主路径**，不是边角情形。

### 真机取证（`.tmp/find-leaked-report.mjs`）

审计报告（`doc/status-audit-2026-09-16.md`，已于 2026-09-16 按用户指示删除；
下面这两行是**证据本体**，不依赖该文件存在）：

```
作为真实 tool-call 投递:  (none)                      ← 文件从未落盘
作为助手正文泄漏:        session-604f072a seq=156/164  ← 协议原文进了正文
```

全域搜索（`D:\9_Code_Workspace`、`~\.dsh`、Desktop、Documents）该文件**均不存在**。

> 注：打包与安装已完成（0.15.6 已装进 `~\.dsh\profiles\web`），但**运行中的进程仍是
> 0.15.5**（`GET /__webcode/status` → `version: 0.15.5`）。在重启 DSH 之前，
> **不得宣称真机已修好**。重启后需复核：`version: 0.15.6`，且再写一份含代码块的
> markdown 报告时正文渲染完整、不含 `mcp_action`。

---

## 0.15.6 重启后复核：**修复未完全生效**（2026-09-16，本轮实跑）

DSH 已重启，运行进程已是 0.15.6，但**同一族缺陷又复现了两次**，其中一次吃掉了本轮的改动。

### 实测读数

```
GET  http://127.0.0.1:3080/__webcode/status
  => 200  {"hash":"f61e9f8016a9","version":"0.15.6"}     ← 三层已对齐
POST http://127.0.0.1:3080/__webcode/status   {"sessionId":"session-0f644e25-…"}
  => 200  team=1 members=1 subAgents=0 tasks=0
          subAgentsError=(空) teamError=(空) tasksError=(空)   ← 三个 *Error 全空
```

即 0.15.3 那三条真机缺陷**确认在线生效**，此前那份集成审计的「三层版本错位」
结论**正式失效**（该报告已于 2026-09-16 按用户指示删除；它唯一的长期教训
——「装完不重启 = 等于没修」——已回写进 `doc/review-guide.md` 的收尾清单第 5 条）。

### 但 0.15.6 的修复**不完整** —— 复现记录

| 次 | 触发 | 结果 |
| --- | --- | --- |
| 1 | 一次 `edit`（把 §7.1.1 写进 `doc/ci-cd.md`，新文本里含 markdown 表格与行内代码） | 命中 `withheld 390 chars`，**边界探测命中但没有可执行的完整调用** → 按断流处理，**该次 edit 未落盘** |
| 2 | 同一编辑改成不含围栏的小文本重试 | 落盘成功 |

**判读**：0.15.6 把「参数含 ``` 的 write/edit 调用被丢弃并整段泄漏」**收窄**了，
但**没有根除**——还存在一类形状会让定位器判成「边界探测命中、无可执行完整调用」，
于是既不执行、也不如实报错，只把协议原文扣下。**用户侧的观感是「harness 端一点显示都没有」**，
这恰好是最初那份 bug 报告的原话。

**这是本轮最该记住的一条**：0.15.6 的 A/B 表（`boundary=53 / parsedCalls=1`）证明它修好了
**被测的那一种**形状，而**修复的覆盖面被那一张表高估了**。护栏 `fence-nested-call.test.mjs`
的 12 项同样只覆盖那一种形状。**下一轮必须先把这条复现路径写成反向用例**，
再谈「修好了」。

### 本轮的独立环境事实（已写进 `doc/progress.md`「已知环境约束」）

`spawnSync` 从 Node 里调用**任何**外部程序都 `EPERM`（实测四种写法全中，含绝对路径），
而 pwsh 直接调用同一程序正常。两个后果：`artifacts-check.mjs` 走 SKIP 分支（它打印 SKIP
而不假装 PASS，写法是对的，但本机等于空转）；`ci-local.mjs` 四步**全都不会真的跑**。

### 本轮新增护栏的反向验证（scripts/check-ledger.mjs）

| 步 | 命令 | 结果 |
| --- | --- | --- |
| 正向 | `node scripts/check-ledger.mjs` | exit **0**（版本 0.15.6 / 38 个测试文件） |
| 反向① | 台账「工作树版本」改回 0.15.5 | exit **1**，指名 `package.json = 0.15.6，台账 = 0.15.5` |
| 反向② | 再把「单测基线」写成 35/35 | exit **1**，**两项同时变红** |
| 还原 | 两格改回事实值 | exit **0** |

反向用例是在**真实的 `doc/progress.md`** 上做的，不是造一份假文件——这样验的才是
「这条规则在真文件上抓不抓得住」。还原后的正向读数记在上面。


---

## 0.17.3 验证记录（2026-09-22，三轮交付）

### 一、本轮验证了什么（全部为本机实跑读数，不是推断）

| 项 | 命令 | 读数 |
| --- | --- | --- |
| 全量单测 | `node --test test/*.test.mjs` | **869 tests / 869 pass / 0 fail / exit 0**（379s） |
| 台账闸门 | `node scripts/check-ledger.mjs` | **PASS**：事实=0.17.3 台账=0.17.3；testFiles 73/73 |
| 打包 | `pnpm pack`（`package/dsh-webcode-bridge`） | `dsh-webcode-bridge-0.17.3.tgz`（542,624 字节） |
| 包一致性 | `node scripts/verify-pack.mjs <tgz>` | **逐字相同 41/41 + 接线完好 + tarball 与工作树一致** |
| 装机 | `node scripts/install-profiles.mjs <tgz>` | web / headless 均 **v0.17.3** |
| 装机字节核对 | `Get-FileHash -Algorithm SHA256`（三个关键文件 × 两个 profile） | `client.cjs` **4B7C6A17B471**、`web-control.js` **76884BB6F525**、`task-ledger.js` **EBBFE3578831** —— 与工作树**逐字相同** |
| 声明同步 | profile 的 `package.json` + `pnpm-lock.yaml` | 均指向 0.17.3 tgz，integrity `sha512-6h6GJ/i0…` 与工作树 tarball 一致 |

### 二、第三轮自审抓到并修掉的两处真缺陷（都有护栏）

**A. 批注写路径的 CAS 被静默吞掉。**
`web-control.js:1106` 的 `POST task-comment` 与 `:1117` 的 `POST task-comment-resolve`
**一直在传**第五个参数 `expectedRevision`，而 `applyAddComment` / `applyResolveComment`
的签名**没有这个形参** —— 传进去的值被静默丢弃。

修前实测：同一份台账连调两次、第二次带过期 `expectedRevision=999`，**两次都回 `error = null`**。
这是**假成功**：两人同时批注同一条任务，后到的覆盖前者、双方都收到 ok。
它还与 `task-ledger.js` 头注第 28 行「CAS 是三道防线之一」的声明直接矛盾。
修后实测：过期 → `revision-mismatch: expected 999, actual 0`；正确 revision → 写入并把 revision 推到 1。
护栏：`test/task-ledger.test.mjs`「★ 批注写路径必须吃 CAS」（删掉判定即变红）。

**B. `task-implement` 谎报已派发，而客户端根本不发。**
服务端只**组装** prompt 就返回 `{dispatched: true}`；客户端 `onImplement`（`client.cjs`）
拿到后**只弹一句「已向 AI 发起实施指令！」**，从不把 prompt 投出去 —— 按钮是死的，
用户却被告知已发送。修法：服务端如实标 `dispatched: false` + `dispatchBy: 'client'`；
客户端拿 `res.prompt` 真调 `POST chat` 并带 `res.sessionKey`；`POST chat` 新增 `sessionKey`
支持且**指定会话时不 fresh**（fresh 会把任务上下文每轮清掉，「以任务为核心实现会话」就断了）。

**C. `tool-parser.js` 是死导入，而它的头注谎称「已正式接线」。**
`index.js` 原先那行 import **全文件零调用**；真正接线的是 `teachFor`（`:1146` 续跑重申、
`:3290` 首轮落盘）。已删死导入（连同同样零调用的 `transportShapeForSite`）并把头注改回
「未接线、只被单测引用」——与 `doc/review-0.17.x.md` §6 的判定一致。

### 三、第三轮补的路由级护栏（此前零覆盖）

全量 869 条里**原先没有任何一条**真的 POST 到 `/__webcode/task-*`。
已补 `test/control-routes.test.mjs` 的一条端到端用例（真实 HTTP），断言：
建任务**真写盘**（`.webcode-tasks/ledger.json` 存在）→ 空评论拒 → 过期 revision 拒 →
`task-implement` 标 `dispatched:false` 且**组装阶段不得替用户发消息** →
`chat` 真投递到 driver 且 `sessionKey`/`fresh` 语义正确 → 软删后不进面板行 →
`task-ledger` 只许注册 GET（多注册 POST 会被 `client-server-contract` 判死路由）。
读数：`control-routes.test.mjs` **13/13 通过**。

### 四、未完成项（如实记，不宣布完成）

1. **需重启 DSH 才生效。** 本轮真机探针实测线上 3080 仍是 **0.17.2**
   （`GET /__webcode/status` → `build.version 0.17.2`、`build.hash dd9a81a82725`），
   且 `POST /__webcode/task-*` 全部 **405**（路由不存在）⇒ 0.17.3 尚未加载。
   重启后要复验：任务看板五个新端点可达、Notion 展开页与三列对比视图渲染正常。
2. **五站真机矩阵 `10/10` 仍未见本轮留痕**（计划 Task 4）。本轮未做，不计入完成。
3. `tool-parser.js` 的去留（删或真接）是计划 Task 1.4 的产品决定，本轮只更正事实、未处置。

---

## 0.17.3 真机复验（2026-09-22，用户重启 DSH 之后）

### 一、重启已生效（与重启前读数对照）

| 探针 | 重启前 | 重启后 |
| --- | --- | --- |
| `GET /__webcode/status` → `build.version` | 0.17.2 | **0.17.3** |
| `build.hash` | dd9a81a82725 | **ed0d0bae4777** |
| `POST /__webcode/task-*` | 全部 **405**（路由不存在） | **200**（全部可达） |

`driver = deepseek / loggedIn=true`、`relay running=true consent=true`。

### 二、任务看板五端点真机全链路（线上 3080，真实 HTTP）

| 动作 | 读数 |
| --- | --- |
| `GET task-ledger` | 200，`{ok:true, ledger:{version:1,...}, tasks:[]}` |
| `POST task-create` | 200，返回 `assignedModel.siteId=glm`、`projectId=r3`、`sessionKey` 完整的任务 |
| `POST task-comment` | 200，`resolved=false`，`quote` 保留 |
| `POST task-comment`（`expectedRevision=999`） | **`{ok:false, error:"revision-mismatch: expected 999, actual 1"}`** ← 缺陷 A 的修复在真机确认生效 |
| `POST task-comment-resolve` | 200，`resolved=true` |
| `POST task-update`（→in_progress） | 200，`rev=3` |
| `POST task-implement` | 200，`{dispatched:false, dispatchBy:"client", prompt:"【任务执行指令】…"}` ← 如实标注，不再谎报 |
| `POST task-delete` | 200，`status=deleted`，面板行归零 |

探针任务已全部清理：`before: tasks=2` → `after: tasks=0`。

### 三、★ 真机抓到的最严重缺陷（D）：全新任务会话被 url-heal 采纳成「用户当前正开着的对话」

**现象**：`POST chat` 带一个**全新**的 `sessionKey`（`task-session-t3-muc2xo2n`）后，
`/status` 的 `navTrace` 显示它被判成 **resume**，且 `landedId` 与**本 DSH 会话**
（`session-0f9fe6cf-…`）**同为 `37820be9-1286-4934-9b37-92001068d2ec`**。
`chat` 返回的「回复」因此不是模型回答，而是**用户上一条消息的原文**。

**后果（为什么这条最严重）**：任务指令被发进**用户当前正在看的那个对话**里。
这不是「功能没生效」，是**把内容投到了错误的会话**。

**根因链**：
1. 我在缺陷 B 的修复里写了 `fresh = !body?.sessionKey` —— 「传了会话键就不 fresh」；
2. 而 `browser-driver.js:2624` 的 url-heal 分支条件是「**槽为空 且 fresh=false**」，
   命中时执行 `rememberConversation(key, fromUrl, 'url-heal')` —— 把**页面此刻所在的会话**
   采纳为本轮会话；
3. url-heal 本身是对的（它救的是「失败轮次没落盘」的历史槽，见该处长注释），
   **错的是调用方把一个从未建立过的会话键当成可续会话递给了它**。

**修法**：`fresh` 的判据改为「驱动槽里**确实存着** `webSessionId`」：

```js
const stored = typeof target?.conversationFor === 'function' ? target.conversationFor(sessionKey) : null;
const fresh = !stored?.webSessionId;
```

并新增 `resumed` 字段供调用方核对；同时删掉末尾那句编出来的「成功」——
原先无驱动时回 `{ok:true, reply:'[已向 X 投递: …]'}`，改为
`{ok:false, error:'no-driver-for-site: …（消息未发出）'}`。

**反向验证（护栏不是装饰）**：把判据改回旧写法 → `control-routes.test.mjs` **fail 1**；
还原 → **13/13 pass**。护栏现分两路断言：槽里有 → `resumed:true`/`fresh:false`；
全新键 → `resumed:false`/**`fresh:true`**（并注明「否则 url-heal 会采纳当前页」）。

### 四、修复后的交付读数（全部实跑）

| 项 | 读数 |
| --- | --- |
| 全量单测 | **869 tests / 869 pass / 0 fail / exit 0**（399s） |
| 台账闸门 | **PASS**（0.17.3 / 73 个测试文件） |
| 打包 | `dsh-webcode-bridge-0.17.3.tgz`（543,276 字节，含 D 的修复） |
| `verify-pack` | **逐字相同 41/41 + 接线完好 + tarball 与工作树一致** |
| 装机 | web / headless 均 **v0.17.3**；`web-control.js`/`client.cjs`/`task-ledger.js`/`index.js` 四个文件 × 两 profile **全部 SAME** |
| integrity 同步 | 两 profile 的 `package.json` 与 `pnpm-lock.yaml` 均指向 0.17.3 tgz，integrity `sha512-Yl2Ux7/c…` 与工作树 tarball 一致 |

### 五、残余（如实记）

1. **D 的修复需再次重启才生效**：当前 3080 进程加载的是本轮第一份 0.17.3 tarball
   （`hash ed0d0bae4777`），D 的修复在**第二份** tarball 里。重启后应复验：
   带全新 `sessionKey` 调 `POST chat` 时 `navTrace` 必须出现 `requestedFresh=true`，
   且 `landedId` **不得**等于任何其它会话的 id。
2. **五站真机矩阵 `10/10` 仍未见本轮留痕**（计划 Task 4）。未做，不计入完成。
3. `tool-parser.js` 的去留是计划 Task 1.4 的产品决定，本轮只更正事实。

---

## 0.18.0 浏览器与登录验证（2026-09-22）

### 一、目标 ① 的承诺：登录态跨重启完整保留（真机实测）

探针两段法（只读、不发消息）：

| 段 | 动作 | loggedIn | loginBasis |
| --- | --- | --- | --- |
| 第 1 段 | 用自带 Chromium 打开 GLM，读登录态 | **true** | probe-ok |
| 第 2 段 | **关闭驱动**（浏览器退出）后重新创建，再读 | **true** | probe-ok |

`RESULT: LOGIN-PERSISTS-ACROSS-RESTART`（exit 0）。
「登录一次、之后跨重启一直有效」是实测事实，不是承诺。

### 二、五站登录态矩阵（守风控：≥22s 间隔、单站 1 次、只读）

| 站点 | loggedIn | loginBasis | 强度 |
| --- | --- | --- | --- |
| glm | **true** | probe-ok | 强证据 |
| kimi | **true** | probe-fallback | 弱结论（特征未命中，回退输入框判定） |
| qwen | false | probe-bad | 未登录 |
| doubao | false | probe-bad | 未登录 |
| zai | **true** | probe-ok | 强证据 |

五站 `browserSource` **全部为 `bundled`** —— 自带 Chromium 真的在驱动全部站点。

**结论**：GLM / Z.ai 可直接进入「五站真机可用」验证；Kimi 需先定性弱结论；
**qwen / doubao 需在桥的窗口内登录一次**（设置页或站点工具条的「登录窗口」）。

### 三、修掉「登了不算数」的两处误导入口

桥跑在**自己独占的 Chromium profile** 里，而界面上有两个入口把人带到别处登录：

| 入口 | 原先行为 | 后果 |
| --- | --- | --- |
| 设置页「打开网站」 | `window.open(url)` → 用户日常浏览器（如 Firefox） | 登录不进桥 |
| 站点工具条 🌐 | `sidebarRight.openTab(browser)` → 官方 iframe 浏览器 | 登录不进桥（另一个进程、另一份 cookie 罐） |

这正是长期「探针说未登录、用户说我登了」而**两边都是真的**的根因。
修法：「打开网站」按钮删除（连同其死代码 `SITE_NAMES_MAP` / `SITE_ORIGINS_MAP`）；
🌐 改为打开桥自己的登录窗口；文案里的「Edge 窗口」改为准确措辞。

护栏：`settings-transport.test.mjs` ⑦「登录入口不得指向桥以外的浏览器」。
**反向验证**：把按钮加回去 → **fail 2**；还原 → **7/7 pass**。

### 四、读数汇总

| 项 | 结果 |
| --- | --- |
| 全量单测 | **873/873 通过、exit 0**（399s） |
| 台账闸门 | **PASS**（0.18.0 / 74 文件） |
| 装机 | web / headless 均 **v0.18.0**，关键文件 × 两 profile 全 SAME |
| 打包 | `verify-pack` **42/42 逐字相同** |

### 五、残余（如实记）

1. **需重启 DSH 才生效**（当前 3080 进程仍为 0.17.3）。
2. qwen / doubao 未登录 —— 需人工在桥窗口内登录一次，之后 ② 才能对这两站验证。
3. Kimi 的 `probe-fallback` 是弱结论，需真机发一轮才能定性。
