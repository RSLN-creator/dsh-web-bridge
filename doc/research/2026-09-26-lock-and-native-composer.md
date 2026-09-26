# 0.19.22 — 账号锁「重启后被自己挡住」+ 并列多会话照抄官方

> 用户 2026-09-26 两条要求（逐字）：
>
> 1. 「本轮运行失败账号 glm 已被另一个桥接实例占用（pid 17820，自 2026/9/26 05:50:38 起）……
>    这个报错怎么回事？**还有我是重启了的啊！**」
>    「然后是除了 glm **其余 deepseek 也是这个报错**，你看下就是最新版本引入的问题可能是！」
> 2. 「参考原生的对话框完成并列会话的设计，而不是现在单独画三个框还被下面原生的挤了，
>    **直接抄 dsh**」「**我是让你做好并列做好！然后对话框抄官方复制！不是让你只有一个！**
>    只是让你每个列都能够做到**上下宽度都全长**和对话中的官方一样」

本文只记**取证 → 根因 → 修法 → 读数**，不重复代码里已有的注释。

---

## 一、账号锁：报错怎么回事

### 1.1 现场（实测，不是推断）

```
C:\Users\rsyhn\.dsh\webcode-edge-profile\sites\glm\webcode-bridge.lock.json
  {"pid":17820,"startedAt":1790373028080,"siteId":"glm","accountKey":"glm","at":1790373038325}
C:\Users\rsyhn\.dsh\webcode-edge-profile\webcode-bridge.lock.json
  {"pid":17820,"startedAt":1790373028080,"siteId":"deepseek","accountKey":"deepseek","at":1790375607296}
```

| 读数 | 值 |
| --- | --- |
| `at` 换算（本地） | glm 05:50:38 / deepseek 06:33:27 |
| 询问时本机活着的 dsh | pid **12168**，起于 **08:39:03** |
| `Get-Process -Id 17820` | **not running**（进程表里根本没有） |

一句话：**锁的主人早就不在了，锁还在。**

### 1.2 为什么会这样（0.19.18 的判据只有两条出路）

0.19.18 的 `decideBridgeLock` 只在两种情况下放行：

1. 同 pid **且**同 `startedAt`（= 自己人重入）；
2. 锁龄超过 `STALE_MS`（12 小时）。

于是「进程被强杀 / 用户重启」这一条最常见的路径**没有任何出路**：
`close()` 不会被执行（强杀不给机会）⇒ 锁留在盘上 ⇒ 12 小时内任何人被拒。
用户越是老实重启，越会被自己的旧锁挡住；而报错里那个 pid 连进程都不存在，
他也不知道能删哪个文件。

**为什么 deepseek 也报**：同一个 dsh 进程给每个站点各写一份锁，两份都是 17820，
所以两个站点同时中招 —— 与「0.19.18 起引入」这个判断一致。

### 1.3 修法（三条判据 + 一条接线漏洞）

| # | 修改 | 理由 |
| --- | --- | --- |
| ① | 新增 `isProcessAlive(pid)`：`process.kill(pid, 0)`，**只有 `ESRCH` 判死**，`EPERM` 一律算活 | `ESRCH` 是唯一能**证明**进程不存在的信号；`EPERM`（存在但打不开）必须保守按活处理。Windows 上 libuv 直接走 `OpenProcess`，**不起子进程**（本机实测：自身 true / 17820 → ESRCH / 系统 pid 4 → EPERM）。旧注释里「Windows 要起子进程」这条理由**实测不成立** |
| ② | 同 pid 但 `startedAt` 不同 ⇒ 判 `previous-incarnation`，**允许覆盖** | pid 在活进程之间唯一 ⇒ 同 pid 的锁不可能是别人的。旧版在这里返回 `held`，于是**插件热重载会把进程自己锁在门外** |
| ③ | `process.on('exit')` 兜底释放（只释放自己那份） | 正常退出路径（含 `close()` 被漏调）不该留下需要靠 ①② 救回来的锁 |
| ④ | `acquireBridgeLock` **补传本进程 pid** | 0.19.18 只传了 `startedAt`，于是 `decideBridgeLock` 里 `isFinite(pid)` 恒假——「同进程重入」这条分支在**生产路径上从未生效**（单测传了 pid，所以看不出来） |

报错文案同时补上**存活读数**与**锁文件路径**，并说明「确认没有别的 dsh 在跑就删掉它」。

### 1.4 读数

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 账号锁护栏 | `node --test test/bridge-lock.test.mjs` | **20/20** |
| 其中真进程复现 | ⑦b：真起 node 子进程持锁 ⇒ 必须拒；`kill` 后同一把锁 ⇒ 必须能接管 | PASS（**不注入任何桩**） |
| 变异反向验证 | `node test-mock/probe-lock-verify-reverse.mjs` | 删掉死锁分支 ⇒ ①g/②d/⑦b **三条变红**；还原 ⇒ 20/20 |

判据是**成对**的：只测「误放」能过掉 `return free`，只测「误拒」能过掉 `return held`，
所以两侧各有一条红得起来的护栏。

---

## 二、并列多会话：照抄官方

### 2.1 「被下面原生的挤了」的根因（实测官方源码）

官方对话区的真实结构（`dsh-client-ui-conversation/lib/client.js`）：

```
.body > .scrollBody[data-conversation-scroll]
          > [data-slot="conversation.session"]   ← 锚点，官方渲染器给它 display:contents
          >   .viewArea                          ← 本插件注册的 conversation.view 住在这里
          > .composerSeat[data-composer-seat]    ← 官方对话框：**同一个滚动容器里的兄弟**
```

旧版 `.hwb-compare-view{height:100%}`：在**滚动容器**里 `height:100%` 解析成
「占满一屏」，而官方对话框座位是它的兄弟、另有高度 ⇒ 两者相加超出容器 ⇒
三列被挤掉一截。这就是用户看到的那一幕。

### 2.2 修法

| 落点 | 做什么 |
| --- | --- |
| 视图根节点 | 声明 `data-conversation-composer-overlay`（**官方轨迹视图用的同一条协议**）⇒ 官方 CSS 把 `.viewArea` 变成 `flex:1 1 0;min-height:0;overflow:hidden`，视图拿到**确定的整屏高度** |
| `.hwb-compare-view` | `flex:1 1 auto;min-height:0;overflow:hidden`（不再用 `height:100%`） |
| 列体 | 补 `min-height:0`（flex 子项缺它时 `overflow-y:auto` 永不触发，长回复会把列撑破） |
| 官方对话框座位 | 本视图挂载期间让位：`[data-conversation-scroll]:has(.hwb-compare-view)>[data-composer-seat]{display:none}`。**只在本视图挂载时命中**，切回官方 Chat 视图立即失效 |
| 每列对话框 | 按官方 composer（`.uV2eYG_*`）**逐条复刻**：卡片 radius 22px / 官方输入底 token / 官方柔和投影 token；文本面 36→336px、padding 4/8/0/14；工具栏行 2/8/6；34px 圆形主按钮（官方按钮语义 token、`translateY(-2px)`）；Enter 发送 / Shift+Enter 换行 / **输入法组字不误发** |
| 三列 | **不变**：仍然每列一个自己的对话框、各自 `status` 派生自己的锁、各自稳定 `sessionKey` |

### 2.3 读数：官方样式原样回放 + 真 Chromium 计算样式

`node test-mock/probe-compare-layout.mjs` → **10/10 通过**。做法：从官方包里逐字抽出
两份真实 CSS（ConversationRoot `css$4` 与 InputBar `css$1`，含官方那两条 `:has()` 规则），
配上与官方渲染结构逐字相同的 DOM（含官方渲染器的锚点样式 `display:contents`），
再注入本插件的新版 CSS，然后读**计算样式**。

| 判据 | 读数 |
| --- | --- |
| 官方协议属性生效 | `.viewArea` = flex-basis 0px / min-height 0px / overflow hidden |
| 摘掉协议属性 | `.viewArea` 立刻回到 `overflow:visible` ⇒ 这条属性在**承重** |
| 视图占满滚动容器 | root **900** / scroll **900**（用户要的「上下都全长」） |
| 本视图挂载时官方座位 | `display:none` |
| 视图卸载后 | `display:flex`（**不是全局隐藏**） |
| 三列各有自己的对话框 | cols=3 / cards=3 |
| 每列卡片占满本列宽 | card 447 / col 461（用户要的「左右也全长」） |
| 卡片圆角 | 22px |
| 发送按钮 | 34×34、radius 999px |

> 为什么不直接打开真 GUI 页面取证：`dsh web` 的页面要**进程级 token**（缺它就是 401），
> 而那个 token 只在进程内存里（`DSH_WEB_URL` 环境变量只给 origin）。因此改用
> 「官方样式原样回放」——比字符串断言强一个量级：`:has()` 是否真的级联、
> 官方 hashed 类名是否真的被我们的属性选择器命中、让位规则是否**只在**本视图挂载时生效，
> 三件事都只有真渲染才能回答。

---

## 三、全量读数（本轮实测）

| 闸门 | 结果 |
| --- | --- |
| `node --test test/*.test.mjs` | **1077/1077 pass，fail 0** |
| `test/bridge-lock.test.mjs` | 20/20 |
| `test/team-compare.test.mjs` | 13/13（新增 0.19.22 一条） |
| `test-mock/probe-lock-verify-reverse.mjs` | 反向验证成立 |
| `test-mock/probe-compare-layout.mjs` | 10/10 |
| `check-ledger` / `lint-comments` / `check-repo-hygiene` | 全 PASS |
| 版本 | **0.19.22**（仍在用户要求的 0.19.x 内） |

## 四、用户需要做的一步

**重启 `dsh web`**。安装只换了磁盘上的文件，正在跑的进程里仍是旧代码。

另外，本轮**已经**手工清掉了那两份死锁（`sites/glm` 与 profile 根目录，持有者 pid 17820
已不存在），所以即使不重启，GLM / DeepSeek 现在也不该再报那条占用错误了。
