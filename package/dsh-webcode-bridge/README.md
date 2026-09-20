# Harness Web Bridge

已登录的网页版内容服务（DeepSeek / GLM / Z.ai / Kimi / 豆包 / Grok …）作为 Harness 的模型提供方，复用原生本地工具、会话持久化及权限系统。当前版本 0.16.31。

安装（本包**不发 npm registry**，只以 `.tgz` 交付）：

1. 从 [Releases](https://github.com/RSLN-creator/dsh-web-bridge/releases) 下载 `dsh-webcode-bridge-<版本>.tgz`；
   或在本目录 `pnpm install`（**不要加 `--frozen-lockfile`**）后 `pnpm pack` 自己打一份。
2. `dsh plugin --profile web add ./dsh-webcode-bridge-<版本>.tgz`
   （本地排查也可用 `node scripts/install-profiles.mjs`，它先删旧目录再解包，
   绕开 pnpm 对同版本 tarball「Already up to date」不重解的坑）。
3. **重启 `dsh web`。** 不重启等于没装。需要 Node.js 22.13+、系统 Edge；无需浏览器扩展。

> 0.14.5 起发布流程收进仓库：`scripts/verify-pack.mjs` 逐文件核对 tarball 与工作树
> （改完代码忘了重新 pack 时直接报错），`scripts/install-profiles.mjs` 先删旧目录再解包
> （绕开 pnpm 对同版本 tarball「Already up to date」不重解的坑）。两条都是真实踩过的坑。

## 0.16.9

**三件事：Harness 侧 markdown 逐字保真、站点禁令可核对、`pnpm test` 死锁解除。**

### 一、`## 标题` 变 `##标题`、表格塌成一行（真因与修法）

用户原话：「好像零点九几的时候，harness 显示的 Markdown 是没问题的，但现在渲染到 harness
就会格式错乱」「#后面没有空格？代码块包裹没有换行？导致没有闭合？」

真因不是渲染，是**字节在桥里被吃掉了**：流式正文外发处的 `tagDebris` 判据把**纯空白**和
**ASCII 竖线 `|`** 都当成「标签残渣」，命中后静默推进游标、一个字节都不发；而
`PROSE_TAIL_CHARS = 8` 的滞后让「本片放行区间恰好是一个空格或换行」成为必然。于是
`## 标题` 丢空格、空行消失、围栏不闭合、`| 列 A | 列 B |` 塌成 ` 列 A  列 B `。

回归窗口自 **0.14.2**（那次为修「回复夹杂错误调用」加了这个判据），0.9.x 没有这条分支——
所以用户「零点九几是好的」这个观察是准确的。

修法：判据拆成 `tagOnly`（只由标签字符组成）**且** `hasTagChar`（至少含一个真标签字符），
纯空白因此照常外发，ASCII 竖线从「标签族」里剔除（它是 markdown 表格分隔符）。
护栏 `test/markdown-whitespace.test.mjs`（8/8）**逐字符驱动**——只有逐字符喂进去，释放边界
才会落在每个字符上；既有的 `markdown-block-integrity` 抓不住它，因为它只断言「块内容 ≡
Σ增量」，而本缺陷里**两条通道一起**少同一个字节。

### 二、DeepSeek 禁令现在**看得见**

0.16.7 加了站点禁令，但它只存在于代码里：`site-no-attach` 分支不写读数、`status()` 不投影
这个布尔量，`GET attach-status` 反而还在承诺「超过 60000 字符时改走附件」（对该站点已不成立）。
用户因此**无法核对修复是否生效**。本轮补齐 `SITE_NO_ATTACH` 读数、`status()` 的
`attachForbidden` + `siteId` 投影，以及面板上的「本站点永不使用附件投递」。护栏 ⑩（11/11）。

### 三、`pnpm test` 曾连**启动**都做不到

lockfile 把**可选** peerDep 记成普通依赖且 `specifier: '*'` 对 `version: 0.1.5-alpha.1`
自相矛盾，pnpm 的前置检查（`install --frozen-lockfile`）必然失败——**CI 下它会先删
`node_modules` 再报错**，实测真删过一次。修法是把 specifier 收紧为 `^0.1.5-alpha.1`。
顺带修了 `control-routes` 夹具在并行负载下读端口为 `null` 的既有 flake（用 HEAD 版本同样会红，
已确认与本轮改动无关）。

## 0.16.31

**三件事：DeepSeek 附件投递解禁、发送间隔新增「距上次回复完成」口径、等待药丸不再跳动。**

### 一、DeepSeek 附件投递解禁（`ATTACH_FORBIDDEN_SITES` 清空）

0.16.7 的静态禁令（「DeepSeek 收得下附件但读不到它」）建立在一次真机事故上：附件传上去了、
页面也出现了，但那一轮**零回复**。0.16.31 用只上传、**绝不发送**的探针
（`POST /__webcode/attach-probe`）重测，读数推翻了其中一半前提：

```json
{ "ok": true, "evidence": "text:webcode-probe.md", "ms": 105,
  "domSnippet": "<div class=\"e70accd6\">webcode-probe.md</div>", "cleaned": false }
```

即**收得下、渲染得出**在今天的页面上成立（当年 `ATTACH_NOT_CONFIRMED` 的直接原因是文件名
证据还没实现，类名清单零命中）。而另一半（模型读不读）现在有**运行期自愈**兜底：
`DYNAMIC_ATTACH_BLOCKS` 对「附件轮整轮零回复」的两个签名自动降级并记住，当轮即回落
inline。

取舍写在明处：静态禁令用**永久走不了附件**换**一轮风险**，不划算，因此清空静态表；
若自愈再次记下 `ATTACH_ZERO_REPLY`，`/__webcode/status` 的 `attachBlocked` 会如实报出，
那时再按读数据决定是否恢复。**本轮没有真机验证「模型确实读到了附件内容」**——
探针不发送，回答不了这个问题，如实记在台账里。

顺带修了附件 chip 的清理路径：`cleanupAttachment` 原先只沿祖先链找删除控件（真机上 chip
的最深节点是文本 div，控件不一定在祖先里），现在先按语义标签找、再按**位置**找（与文件名
同容器、位于其右侧的可点控件），且多附件时**不按位置猜**——点错会删掉别人的附件。

### 二、发送间隔：新增 `end-to-start`（距上次回复完成）

用户原话：「我需要的是 web 思考后调用时间后不立即回复而是间隔多少秒回复……为了隔开和
他发消息我立马回复的规避点！」。这与既有的 `send-to-send`（距上次发出）**防的不是一件事**：

- `send-to-send`（**仍是默认**）：防站点的滑窗限流，按请求到达计——上一轮跑得久时本轮
  **无需再等**。改默认值等于静默改掉所有既有用户的行为，因此只新增选项。
- `end-to-start`：防对话节奏贴得太紧——上一轮跑了多久**不影响**本轮，**答完那一刻起**
  重新数满间隔。

落盘格式从裸数字升成 `{ send, end }`（**旧格式照样读**，升级不丢基准）；设置页两个面
（HTML 页 + 右栏面板）都有口径下拉；读数新增 `gapBasis`，面板文案随口径切换为
「距上次发出」/「距上次回复完成」。护栏 `test/send-gap-basis.test.mjs` 12 条。

### 三、等待药丸的跳动（真缺陷）

用户报「底下框的时间会跳动」。根因不是取整，是**在途读数被提前清空**：
`clearLiveWait` 原在等待 sleep 的 `finally` 里，于是等待一结束读数就消失，而账本要等整轮
生成跑完才吸收——中间那几十秒药丸掉回**上一轮**的旧值，收束时再跳上去。现在正常路径
保留在途读数（`endsAt` 已把它冻结在满值），只有 **abort** 才清（那时本轮不会有 metrics，
留着会让药丸停在一个不动的假数上）。

## 0.16.30

**官方 token 的「双竖线」漂移让整族解析归零**——这是用户报「版本更新后自动化流程被打断、
每轮都错」的根因。真机回复里模型把包裹竖线写成**两枚** U+FF5C：

```
<｜｜tool▁calls▁begin｜>
<｜｜tool▁call▁begin｜>pwsh<｜｜tool▁sep｜>{"command":"pwd"}<｜｜tool▁call▁end｜>
<｜｜tool▁calls▁end｜>
```

而 0.16.18–0.16.29 的解析正则全是 `'<' + 单枚竖线 + '\s*'`，`\s*` **吃不下第二枚竖线**，
于是四条链路一起失守：`findProtocolStart` → `-1`（认不出边界）、`normalizeOfficialToolCalls`
→ 原文逐字不变（改不动）、`parseAgentReply` → `calls=0`（每轮 `TOOL_CALL_UNPARSED`）、
`partialProtocolAt` → `-1`（半截标记不扣留、漏成正文）。

**「改了什么」的答案**：协议从 DSML 族换成官方 token 族时，**DSML 族一直有的竖线宽容没跟过来**。
`DSML_MARK_SRC` 写的是 `DSML_BAR_CLS + '{1,3}'`（容 1~3 枚），官方族从 0.16.18 引入起只有一枚。
日志计数坐实两族都在写双竖线：全日志 9,803 处 —— DSML 时代 9,764 处（当年被容下、照常执行）、
官方 token 族 25 处（本次现场，一条都不认）。

修法是新增 `OFFICIAL_BAR_CLS = OFFICIAL_BAR + '{1,3}'`（与 `DSML_BAR_CLS` 同纪律、同字符、
同 1~3 上界），替换官方族**全部五条**正则的包裹竖线，并给 `partialProtocolAt` 的精确前缀表
补上双竖线族（前缀表是精确字符串，归一化对"标记不完整"一格都不改，所以归一化救不了它）。
上界 3 不是无界：锚点与改写要在流式途中反复调用，无界量词会把 `<｜｜｜｜｜…` 噪声吞进协议判定。
**只放宽竖线，单竖线既有行为逐字不变。**

再教学提示点名真实病灶（「包裹竖线是一枚，不要写成两枚」）——与 0.16.20/0.16.25 同一条纪律：
提示要指出模型实际写错的那一处，否则模型自查「name 在、JSON 合法」后无处可改、只能原样重发。

验证：新增 `test/official-double-bar.test.mjs` 11 条，对已发布的 0.16.28 代码实跑 **8 红 3 绿**
（红的正是双竖线全族，绿的正是"不许回归"三条），修复后 11/11 绿。真机回复原文重放：日志里
双竖线官方 token 共 **6** 轮、live 运行时 **6/6 全记 `calls=0`**，修复后 **6/6 全部解析成功**、
共产出 **13** 条可执行调用。

## 0.16.29

**再教学提示不再铺进会话正文**（用户指令：「关于 TOOL_CALL_UNPARSED: 直接隐藏」）。三处出口
（`TOOL_CALL_UNPARSED` / `TOOL_UNKNOWN` / `THINKING_ONLY_NO_ANSWER`）的提示仍逐字作为**补发的
用户消息**发给模型，界面上只留一句 `AUTO_CONTINUED: 已自动补发提醒，网页已重新发起 N 条调用。`。
例外：补发**根本没发生**时（`autoContinueRounds=0` 或无会话键）提示照旧当正文交回——
隐藏的前提是它已经送达模型。

**落盘从副本升格为投递源。** 用户要的是「如果新开会话-web 端，就一样把这个当上下文通过文件
发送」。0.16.28 只落了盘（写而不读），本轮新增 `readPromptFile` + `readSessionPrompt`，
整段重建改为 `readSessionPrompt(sessionKey) ?? rebuild()` —— **优先读磁盘正本**，
读不到才回落内存序列化。发出去什么、重建用什么，从此同一份字节。

顺带修掉 0.16.28 的一个真缺陷：`writePromptFile` 用 `[..., ''].filter(Boolean).join('\n')` 拼头部，
那个空串被 `filter` 删掉，头部末行与正文首行**粘成一行**（真机实测：读回只剩第二行之后，
正文首行被吞）。现改为显式 `+ '\n\n'`，读回端兼容旧粘行格式。

**节流窗文案更正**：`SESSION_REBUILD_THROTTLE_MS` 自 0.16.6 起就是 **60 秒**（注释里的「30 秒」
是引 0.16.6 提交里用户对更早版本的描述）。真机佐证：reply-log 的 `19.962s 前…还剩约 40.038s` = 60.0s。

## 0.16.7

> **⚠ 本节结论已于 0.16.31 推翻（原文保留作历史记录）**：`ATTACH_FORBIDDEN_SITES`
> 已清空，DeepSeek 恢复附件投递。推翻的是**前提**：0.16.7 当时判定「网页收下了」所依赖的
> 类名选择器清单在真机上**零命中**，于是把「确认失败」误读成「模型不读」（文件名证据 0.16.3
> 才实现，探针 0.16.4 才有）。0.16.31 的探针实测 `ok:true` 并实拍到 chip DOM。
> **未被推翻的是风险本身**：模型究竟读不读附件，探针回答不了；现在由运行期自愈兜底
> （附件轮零回复 → 当轮降级 inline 并记住）。详见 §0.16.31 一。

**DeepSeek 站点不再走附件投递。** 真机实测（2026-09-18）：71994 字符走附件时，附件确实
传上去了、页面上也出现了，但这一轮**没有任何回复**——`domChars:0`、页面退回
`chat.deepseek.com` 根地址，navTrace 里连 `landed:after-submit` 都没有；同一账号改回
**纯文本投递**就正常（用户原话：「deepseek以附件投递会出问题！不能回复！前面时候改为
输入框还行！」）。

也就是说「网页收得下附件」与「网页模型会读这个附件」是两件事，而 DeepSeek 的答案是「不读」。
因此新增站点契约 `ATTACH_FORBIDDEN_SITES`（当前含 `deepseek`），并在投递判定里把它排在
**阈值之前**：该站点无论多长都只走输入框，宁可慢，也不要「网页收下了、什么都不回」。
判据是**站点声明**而不是调用方的开关——这条知识属于站点契约，写在别处必然漂移。

反向要求同样成立：GLM 的输入框装不下长文，必须留在附件路径上。**本表只排除，
不改变其它站点的既有行为。** 护栏：`test/prompt-transport.test.mjs` ⑨（禁令生效）/
⑨b（不误伤 GLM）。

## 0.16.6

**会话重建节流不再中断会话。** 同一个会话键在 60 秒内已经整段重建过一次时，第二次不再重放
四十万字符——但 0.16.4 的实现是抛 `WEB_SESSION_REBUILD_THROTTLED` 把这一轮**判死**，
界面上就是一条红色「本轮运行失败」、会话当场断掉（用户原话：「改为只提示已经切换会话而不是
打扰直接中断会话」）。现在改为交回一条提示正文：

```
SESSION_SWITCHED: 网页会话已切换——本轮不再重放首轮上下文（上一次整段重建在 30s 前、
重放了 127895 字符，节流窗还剩约 30s）。会话没有中断：直接发送下一条消息即可继续——
窗口过去后这一轮会整段重建，窗口内则继续显示本条提示。
```

节流那一轮的正文一个字节都没进网页会话，所以发送游标**不前进**（下一轮会把这一轮的内容
一并带上，而不是只发一个没有前文的增量），会话槽也**不重置**（留给下一轮与驱动的 URL 自愈）。
提示过几次可在 `/__webcode/status` 的 `driver.sessionSwitchNotices` 核对。护栏：
`test/session-continuity.test.mjs` ⑥（这一轮成功且正文是提示 / 重放仍只发 1 次 / 下一轮仍整段重建）。

> 0.15.0–0.16.5 的变更未逐条回填本文件，见仓库根 `README.md` 的「当前能力 / 验证和边界」
> 与 `doc/progress.md` 的逐轮台账。

## 0.14.5

**修掉两个由真机会话日志定位的缺陷，并把右栏按官方审美重排。**

### 超长提示词写不进输入框（`PROMPT_WRITE_STALLED`）

真机证据（`session-c710ef6e` 的 turn 2 终局，逐字）：

```
locator.fill: Timeout 30000ms exceeded
  - locator resolved to <textarea … placeholder="给 DeepSeek 发送消息 ">
  - fill("# 可用本地工具…(+807789)
```

一次性把 80 万字符交给 `fill()` 时，Playwright 在网页侧整段卡住，30s 后超时；卡住期间
**没有任何中间态可读**。现在按 `composerWritePlan` 分块写入、块间回读长度，连续两块不增长即
抛 `PROMPT_WRITE_STALLED`，错误里带**已写/总长度**与元素现场（标签、id、placeholder、可见性）。
决策抽成纯函数（`composerWritePlan` / `stallStep`），`test/composer-write.test.mjs` 12 项钉住边界。

### `<tool_result>` 外壳漏进正文

同一会话的 `assistant/message` seq=587 里，网页模型把工具结果连同外壳吐了回来：

```
block 9  text len=198  <tool_result>\n{"mcp_action":"result","name":"edit",…
block 11 text len=200  </tool_result>\n{"mcp_action":"result","name":"write",…
```

协议边界锚点只认 `tool_call`，于是边界落在**外壳之后**的 JSON 上，`<tool_result>\n`（13 字符）被当正文发出。
现在 `tool_result|tool_results` 进锚点，但**故意不进 transport 判定**——工具结果不是工具调用，
绝不能被当成待执行的调用。`test/protocol-leak.test.mjs` +2 项钉住这条区分。

### 右栏重排（对齐官方右栏的实测尺寸）

- **顶层工具条**：当前站点名 + 8px 状态点 + 右侧四颗 **28px 图标按钮**（刷新 / 独立窗口 /
  新面板 / 浮动），尺寸与官方 `ExpandButton` 实测值一致（`width/height:28px`、`border-radius:28px`、
  hover `--dsw-alias-interactive-bg-hover`）。文字全部进 `title`/`aria-label`。
- **站点标签条**降为次级导航：紧凑胶囊（26px / 圆角 13px），登录态从「标签内文案」改为
  **色点 + tooltip**（长文案正是把标签条挤爆的原因）；去掉了两端 mask 渐隐——官方右栏不用
  这种表达，且渐变本身就是观感上的「遮挡」。滚轮横向滚动保留（原生非被动监听）。
- 空态/错误态统一成官方 guide 卡片形态（`.5px` 边框、`bg-layer-1`、标题+说明+主按钮三层）。

### 会话日志归因工具（长期资产）

`test-mock/parse-session-log.mjs`：DSH 的会话落盘是**多帧拼接**的 zstd，`zstdDecompressSync`
只解第一帧（1.3 MB 的文件解出 220 字节），这个坑上一轮会话连踩三次。工具按 zstd magic 切帧逐帧解压，
输出事件直方图、轮次结局、失败项、工具调用与用户输入。错误码与归因见 `doc/bridge-failure-ledger.md`。

## 0.14.4

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。
模型分组 Harness Web Bridge 暴露全部内容服务站点（`site:model` 限定 id）；显示名为
「站点短键/模型 id」（如 `z.ai/glm-5.3`、`deepseek/deepseek`），**一眼能看出是哪个
网站**；兼容别名 `deepseek-web` 不出现在下拉里（历史会话仍可解析）。

## 0.14.4

**修掉「打开右侧网页之后掉登录」，并把等待时间变成可核对的两个数。**

（本节以下为 0.14.4 的原始记录，保留不动。）

### 掉登录（豆包真机报障）

根因在 `Set-Cookie` 的两个消费方向被混成字符串替换（`lib/cookies.js` 是本次抽出的纯模块）：

1. **删除指令被当成「设成空值」**。站点在 iframe 里刷新会话时回 `name=; Max-Age=0`，
   旧实现把空值写回驱动 profile——**把有效登录 cookie 就地抹掉**，下一轮真实发送即未登录。
   现在按 RFC 6265 判定删除，翻译成 `expires: 0`。
2. **`__Secure-` / `__Host-` 前缀 cookie 被剥掉 `Secure`**。浏览器按前缀规则**直接丢弃**，
   playwright 侧同样抛错导致整批写不进去。现在保留/补齐 `Secure`，`__Host-` 补 `Path=/`。
3. **镜像转发时 profile 的 cookie 被 iframe 的旧值挤掉**。旧实现「请求带 cookie 就只用请求里的」，
   于是驱动 profile 里真正登录的那份**永远不再发给上游**。现在按 profile 优先、请求补缺合并。

### 等待时长（输入框底下的统计药丸）

`lib/wait-stats.js` 是纯计算层：本会话与累计**同口径**（都来自 relay 的 `sendWaitMs`），
文案由服务端一次算清（`/__webcode/wait-stats` 的 `label` / `detailRows`），
避免两处各写一份格式化后漂移。账本落盘 `webcode-wait-stats.json`，重启不清零。

**与官方统计同一栏（0.15.11 改为结构性方案）**：展示走官方
`conversation.composer.dock` 槽位，取官方 ui-chat `StatsPills` 的尺寸
（28px 高、24px 圆角、14px 线框图标、13px tabular-nums）。

同栏**不靠几何偏移**：`conversation.composer.dock` 的每个条目都是官方那条 dock
flex 行的直接子项，只要自己是 `inline-flex` 就自动同栏，居中、间距、换行全部
由官方 CSS 决定。（0.16.18 起不再 portal、也不再自建整行：DSH 0.1.6-alpha.2 的
`StatsPills` 已不渲染 `[data-composer-stats]`，原先那段「等官方行出现再 portal
进去」的 MutationObserver 因此删掉了。）

> 0.15.10 曾用负上边距把本行「拽」进官方那一行，那是几何猜测：官方行一旦
> 换行（右侧栏把输入区挤窄）或字体档位变化，两块内容就会叠在一起。0.15.11
> 起源码里不允许再出现给等待 wrap 算偏移量的代码，由测试钉住。

交互照官方 `stat-dialog` 契约：**默认只给一个短读数**（如「等待发送 12 s」；
秒级取整——因为正在等待时这个数会逐秒往上走），在途时显示**正在等的
那一段**并把它从起始时刻现算出来（官方那枚药丸同样是「开始就涨」，而不是等
结束才一次性给数），轮询同步提到 1 秒；等待结束、账本结算后自动回落到本会话累计。
点击才展开浮层，内含本会话与累计的完整明细（轮次、平均、限流、发送间隔目标、
距上次发送）。浮层尺寸/圆角/阴影/`dl` 网格逐项对齐官方 `stat-dialog.module.css`，
锚在药丸上右对齐展开。

关闭语义同样对齐官方 `StatsPills`（它由 `useStatDialog` + `useDismissOnOutsidePointer`
驱动，同一时刻只有一枚药丸开着）：**Esc 收起**，且**pointerdown 落在本组件之外
即收起**——于是点官方任何一枚药丸时本面板随之关闭。关闭边界取本组件自身而非
整行，点自己面板内部（含滚动条）不会误关。

**设置页不再重复统计等待时长**：原先那里另有一块「累计等待发送」网格，读的是
同一份账本、同一个数字，属于重复展示（0.15.10 已删除）。设置页「速度与等待」
只保留实测速度指标。

### 右栏

- 站点标签条支持**鼠标滚轮横向滚动**（原生非被动监听），去掉滚动条并加两端渐隐——
  消除「只能拖右滑栏、还有一点遮挡」。
- 「刷新 / 独立窗口 / 分屏 / 浮动」统一成同一套图标按钮（同高、同圆角、同状态表达），
  窄面板下自动只留图标。
- **多开不同网页**：`Ctrl+点击`站点在新分屏打开；或直接用面板上的「分屏 / 浮动」，
  走 DSH 官方 `sidebarRight.split` / `.float`，不自绘浮层（自绘正是遮挡的来源）。
- 站点栏 `z-index` 与 `flex:none` 保证永不被网页区遮住。

### 测试

新增 `test/cookies.test.mjs`（25 例）与 `test/wait-stats.test.mjs`（18 例）；
修掉 `test/mirror.test.mjs` 里把「剥掉 Secure」钉成期望行为的旧断言（它锁的正是本次修的 bug）；
`test/tool-loop.test.mjs` 补测试隔离——它此前读**用户真实**设置（`sendGapMs: 30000`），
退避变成 30s+30s+60s 撞上 120s 看门狗，用例「看环境脸色」。全套 **249/249**。

## 0.14.3

**修掉两个只有真机复验才看得见的 bug**（0.14.2 的单测全绿，但 GLM 第二轮仍然失败）。

复验第一步就发现：0.14.2 的会话**身份**修复完全正确（`result.sessionId` 不再是 null、
`webcode-sessions-glm.json` 不再是 `{}`），但第二轮**换了一个失败方式**：

```
✖ locator.fill: Timeout 30000ms exceeded
  - locator resolved to <textarea>appkey: "CF_APP_WAF", …</textarea>
  - element is not visible
```

1. **登录回退判定只数个数、不看可见性**。导航到 `?cid=` 时 GLM 返回阿里云滑块验证页
   （「滑动验证页面」），页面上 3 个 textarea 全是**隐藏**的 WAF 脚本模板；
   `locator(SEL.input).count() > 0` 于是判成「输入框在 = 已登录」，接着 `fill` 必然超时。
   现在改为 `visibleComposerCount()`：逐元素查可见性，且**遍历全部候选选择器**
   （GLM 的真实 composer 是裸 `<textarea>`，只认 `textarea#chat-input` 会漏掉它）。
2. **「是否已在目标会话上」用 URL 字符串前缀判断**。站点会把地址补成 `?lang=zh&cid=X`，
   而桥拼的目标是 `?cid=X` → `startsWith` 判为不同 → **白白整页重载**，正好撞上风控页。
   现在按**会话 id** 比较（`conversationIdFromUrl`）。
3. **风控页单独成一态**：`detectChallenge()` 认验证页文案与 WAF 脚本指纹，在登录判定
   **之前**调用；报错用 `navReason='challenge-page'` 与「会话过期」分开——否则用户按
   会话过期去查，永远查不到风控。

真机复验结果：GLM 连发两轮，`cid` 逐字相同、`sessionLostCount=0`、第二轮正文正确；
A-4b（重启后第一轮发送间隔）与 F（`:8931` 路径 `gapTargetMs=10000`）均通过。

## 0.14.2

**GLM/Z.ai 的会话身份与上下文预算（B/C/F 三组）。** 用户报「GLM 作为子代理时同一会话却
每轮新开对话」——真机探针查出根因：桥把「会话 id ↔ 地址」的知识硬编码成了 DeepSeek 的两种
形状（`?chat_session_id=` / `/a/chat/s/`），而 GLM 的地址栏是
`https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77`，
其 `cid` 与 SSE 首帧的 `conversation_id` **逐字相同**。旧实现读不到 → `sessionId` 恒 null →
`rememberConversation` 从不执行 → 每轮 `WEB_SESSION_LOST` → 上层 fresh 重开。

1. **会话地址形状按站点声明**（`providers.js` 的两张表 + `contract.conversationNav`），
   导航判定收成三态 `fresh / resume / unsupported`。**没有第四态**：`unsupported` 必须报错，
   不再像旧实现那样默默开一个新会话把增量发进去（那正是「跑着跑着变傻」）。
2. **解码器透出 `conversation_id`**（`GlmDecoder`，基类 `finish()` 统一带出）——身份取
   「地址优先、流兜底」两个来源。
3. **`WEB_SESSION_LOST` 不再静默**：`sessionLostCount` / `lastSessionLost` 进 `/status`，
   右栏显示「网页会话已丢失 N 次（桥已按重放首轮整段自愈）」。
4. **`zai` 故意不声明地址形状**：探针在 chat.z.ai 上只拿到裸根地址、且整轮 120s 超时
   （`replyChars:0`），**没有证据就不编形状**——编出来会导航到不存在的地址，比「不支持」更糟。
5. **上下文窗口声明有实测依据**：探针把 GLM composer 灌到 **120 万字符**、Z.ai 到 100 万字符，
   **全部逐字回读、没有一档被截断**，所以 1M 是有实测支撑的下界（不再是随手写的占位）。
   它是「本桥愿意让 transcript 长到多大」，**不是模型注意力窗口的规格**。
6. **发送前预算闸** `CONTEXT_WINDOW_EXCEEDED`：越界在**写入 composer 之前**就拒，报错文本带
   「多少字符 ≈ 多少 token > 声明窗口多少」与可行建议。旧实现只有填写**之后**的
   `PROMPT_TRUNCATED` 回读校验，报错只有长度差，看不出超了多少。
7. **窗口声明可见**：`GET /__webcode/context-windows` 列出每站点的声明值与**来源**。
8. **修 OpenAI 前端（`:8931`）绕过发送间隔**（真机 0.14.0 矩阵发现）：`lib/openai.js` 两条
   分支构造 `meta` 时都没带 `sendGapMs`，`clampSendGapMs(undefined) === 0`，于是设置页的间隔
   在这条路径上被整体绕过（实测 `gapTargetMs=0`）。改为注入**当场求值**的取值函数。

新增护栏：`test/context-budget.test.mjs`（11 项）、`test/glm-conversation.test.mjs`（17 项）、
`regression` 47/47（+2 接线断言）、`control-routes` 5/5（+`context-windows`）。

## 0.14.1

**工具协议分叉不再整轮作废，纯标签残片不再当正文外发。**

真机会话暴露出两个症状：一轮里工具调用「有时候没执行」，以及回复里夹杂 `</</` 这样的
错误调用碎片。取证后的根因是**解码器与增量通道的分叉**：decoder 对 `fragments` 做静默
全量替换时不补发增量，于是增量累计的 `acc` 与权威全文 `end.text` 在结构上分叉（两个方向
都实锤过：canonical 多出一个 `grep`、canonical 丢失一个 `edit`）。旧实现遇到分叉一律
`TOOL_PROTOCOL_INVALID` 把整轮扔掉，用户看到的就是「调用了但没执行」。

现在开块时保存已经配平的 JSON，发现分叉时改为**修复**而不是作废：同名第 k 个流式块与
第 k 个同名权威调用配对，流式块用它自己配平的 JSON 收口，没被覆盖的权威调用补发新块。
只有块连配平 JSON 都没有时才保留旧的抛错路径。另外，调用之间那些只剩 `</</` 的纯标签
碎片按空白同型跳过，不再混进正文。

回归护栏：`test/regression.test.mjs` 45/45（新增 3 条——分叉的两个方向、标签残片）。
新测试用临时 `profileDir`，避免 0.14.0 引入的发送间隔落盘成为跨测试的干扰通道。

## 0.14.0

**两个真机问题 + 四项既定改动。** 两个问题都是「先取证、后改」：

**① 发送间隔「好像没按设置来」。** 设置一直存得住，真正的原因是三条：基准取的是
「上一轮**结束**」而不是「上一轮**发出**」（一轮跑 20.9s 时，10 秒间隔只剩 7.6 秒
可见）；基准只在进程内存，**重启后第一轮零等待**；`sendWaitMs === 0` 时那条统计
整条不渲染——设了间隔反而「界面上什么都没有」。现在：判定改为 send-to-send 并
**落盘**（`webcode-send-state.json`，原子写、24h 过期），右栏「发送前等待」**恒可
核对**（未等待时也写明「距上次发送 20.9 s 已满足」），目标值与实际间隔都透出到
`/status`。

**② 网页端回复了但 Harness 这边卡住。** 网页流可能以 `status:'WIP'` 结束且**永不发
FINISHED**，驱动只能等 240s 总超时，界面上就是**无限「思考中」**。现在有三条防线：
驱动侧按「流停 **且** 页面 DOM 不再增长」双条件在秒级收束（只看流停会腰斩长回复，
所以是双条件）；适配器侧有「无进展」看门狗，把无限挂住变成一条带页面现场的明确
报错；`lastEndReason` / 超时现场进 `status`，右栏显示「网页流未收尾但内容已保住 N 次」。

**③ 模型显示名自带站点出处**（`z.ai/glm-5.3`），并修掉下拉里的重复行。

**④ 首轮提示词默认显示**：设置界面不再折叠，直接显示发送首条消息时注入网页的完整
内容。

0.16.25 起改为**按网站逐行列出**（每行一个网站，行内下拉可选该网站可用的协议；
下拉只**预览**模板，不改真实选路——每个网站实际用哪一支由桥按站点决定并标在行首）。
原因：协议只有三支、网站有十个，按协议列时用户得自己推断「我这个站算哪一支」；
每行的模板全文折进「查看该协议的完整模板」里，十份全文不会把页面淹掉。

三支协议与站点的对应（`variantIdForSite`，与 `serializeFirstTurn` 的真实分支一一对应）：

| 协议 | 站点 | 形状 |
|---|---|---|
| `official` | deepseek | DeepSeek 官方训练模板（原生工具调用格式） |
| `glm` | glm | ```json 代码块（该网页会抢走调用标签执行） |
| `default` | 其余全部 | `<tool_call>{…}</tool_call>` 标签 |

> 本次同时修掉一个**此前不可见**的错误：`deepseek` 曾被映射到 `default`（标签形状），
> 而它实际走官方模板分支——设置页因此给 deepseek 显示了一份它根本不会收到的模板。
> 之前下拉只有两支，用户不会去比对；改成「每行一个网站」后它立刻就是错的。

模板由 `agent-preset.serializeFirstTurn` 现算——**设置里看到的 = 真正发出去的**。
协议文本（首轮教学、增量轮再教学、解析失败自动续跑）全桥只有一处定义：
`agent-preset.transportNoteFor`。0.16.25 抽取它是为了自动续跑——续跑要把再教学提示
作为用户消息补发，那一轮看到的协议段必须与该站点**首轮逐字相同**；否则会出现
「首轮教 A、续跑重申 B」，模型在两者之间摇摆。

**⑤ 右栏规范化**：注册走 `ctx.effect` 生命周期，标签动作菜单、tablist 方向键导航，
样式改用 DSH 的 `--dsw-alias-*` token。

**⑥ 修掉两处「空转护栏」**：`client-render` 测试的 fetch mock 不是忠实 Response、
渲染器又没递归进 children——两处叠加导致**所有**数据路径静默失败、嵌套组件从未
渲染，旧断言等于空转。修好后 0.14.0 的新面板才真的被测到。

## 0.13.1

**交付物必须以 `present` 呈现，写进预设提示词。** 此前预设从未教过这件事，于是
模型写完文件只在**正文**里列一串路径——用户看到的是一堆点不动的纯文本，而不是
可点开的文件面板。现在预设新增「# 交付物呈现（present）」章节，讲清三件事：
只在正文写路径**不算**交付；`present` 让文件变成可点开的面板；要在最终答复
**之前**调用。首轮的 `[本地工具传输协议]` 尾部也带一句提醒（收尾那一刻最容易忘），
glm 的代码块分支与其它站点的标签分支都覆盖。
**仅在本会话真的注册了 `present` 时才教**——否则模型会去调一个不存在的工具，
白费一轮并撞 TOOL_UNKNOWN。

> 为什么必须升版本号：0.13.0 已发布过一份**不含**该提示词的包，同名同版本却换了
> 内容会让 pnpm 按版本号去重而静默不更新（实测安装副本仍是旧文件），也让构建指纹
> 失去意义。任何内容变更都必须伴随版本号变更。

## 0.13.0

**模型选择从「空承诺」变成真实切换。** 0.12.9 的驱动遇到 `auto` 直接返回、
**页面上一个动作都不做**，而每站目录里又只有这一条 auto——UI 有下拉，网页什么都不会变。
现在按站点声明**模型选择契约**（触发 / 选项 / 名字节点 / 回读），由 `lib/model-picker.js`
执行**精确名匹配 + 点击后回读确认**；契约缺失就如实报「未切换网页模型」，绝不假装成功。
真机实测目录（`test-mock/probe-model-dropdown.mjs` 全量 dump）：

- **z.ai**：`GLM-5.3-Flash` / `GLM-5.3` / `GLM-5.2`
- **GLM**：`GLM-5.3` / `GLM-5.3-Flash`
- **Kimi**：`快速` / `K3` / `K3 集群`
- **豆包**：`对话` / `工作`（分段控件形态，**本地默认 = 对话**）
- chatgpt / claude / gemini / qwen：未校准（诚实显示，不假装可选）

注意 `GLM-5.3` 是 `GLM-5.3-Flash` 的**前缀**，因此匹配必须是精确的
（`test/model-picker.test.mjs` 把这个陷阱钉死）。真机验证
`node test-mock/verify-model-switch.mjs` **11/11 PASS**。

**harness 截图能真的传到网页端了。** 旧实现只认 wire 形状的图片块，而 DSH 原生
（截图走的）是 `{type:'image', attachment}`——两者零交集，于是每次截图传图都被
**静默丢弃**。现在原生块经 `ctx.attachments.readImageRequest` 取像素（预算与
dsh-llm-deepseek 同档），并声明 `inputModalities` 防止宿主把图片提前换成文字；
上传后**必须看到页面上出现附件证据**才发送（拿不到就报错，绝不发一条没有图的消息）。
真机端到端 `node test-mock/real-vision-upload.mjs` PASS：上传已知色带图，
模型答「3条，红色、绿色、蓝色」。

**「检测」按钮不再报 JSON 解析错误。** 根因是 `verify-login` / `site-probe` /
`session-import` 三个 action 进了 action 表却**没进挂载清单**（手写数组漏了），
请求落到宿主兜底回 **405 + 空 body**，客户端在判断状态码之前就 `.json()`，
于是把真实原因吞成一句 `unexpected end of JSON data`。现在挂载清单从 action 表
**派生**（结构上不可能再漏），未知方法回 405 JSON、未知路径回 404 JSON，
客户端先读文本再按 content-type 解析。

**设置界面改为 harness 风格**：三段内联硬编码色合并为一张 token 化样式表
（`--dsw-alias-*` + fallback，16px 圆角卡片 / .5px 边框 / pill 按钮，与 DSH 自家
设置区同款）；站点行改为「状态点 + 名字 + 行内动作」，并**露出登录判定依据**
（`loginBasis` 一直有，此前 UI 把它丢了，于是「未登录」看起来像凭空断言）；
「检测」结果分三态，`待检查` 不再画成红色错误。

## 0.9.7

**工具调用「能执行」。** 真机 64 次工具报错全部是参数形状漂移（数字写成字符串
`"10"`、数组写成单对象、布尔写成字符串）。新增 `coerceArguments`：按工具 schema
**显式声明的类型**做定向纠偏，只做无歧义的方向，解析失败一律原样保留交给 DSH 报错。
网页调了本会话不存在的工具时，不再整轮作废，而是把「TOOL_UNKNOWN + 本会话可用工具
清单 + 请重试」作为这一轮的回复交回会话，下一轮模型自纠。

**关于「某些工具在 DeepSeek 下执行不了」。** 桥只负责把网页发来的调用正确解析、
纠偏、交付；**一个会话能用哪些工具由 DSH 的会话预设决定**——极简模式实测只注册
`pwsh`，此时 `subagent`/`write`/`edit` 本来就不可用。要跑多工具任务请把预设切到
标准模式。新增 `test/tool-loop.test.mjs` 把网页五种真实调用形状（`<tool_call>` /
全角 DSML / 裸 `<invoke>` / ```json 围栏 / `**Calling:**`）固定成回归。

## 0.9.6

**一轮连发多个工具调用不再出错。** 复现真机形状（模型一轮里连发 3 个 `read`）后，
把流式协议边界的三处缺陷一次改掉：同一个调用被开成 32 个块并整轮作废；游标推进后
又命中更早的收尾标签，`</tool_call>{"mcp_action":…` 整段漏回正文；把非调用的裸 `{`
当截断点导致正文下标卡死、流式循环挂住。现在边界**单调不减**、按边界下标去重、
用 `partialProtocolAt()` 扣住 `<t`/`<tool_cal`/`**Calling:` 这类半成品标记。
顺带修掉调用块关闭时把下标当块内容发出去（`block.text` 变成数字）。

## 0.9.5

**登录任意站点。** 设置页「连接 → 登录网站」下拉选择站点后点「登录所选网站」：打开
真实 Edge 窗口等你完成一次性登录，检测到已登录自动切回无头，并把结果（成功/已登录/
失败原因/耗时）回报到界面。旁边的「独立窗口打开」把该站点开成可交互的真实浏览器窗口，
与桥共用登录态。每站点独立 profile，互不串号；上次被强杀留下的 Chromium 单实例锁会在
启动前自动清理并重试一次（「退出过一次之后哪儿都登不上」的直接原因）。

**跑到一半突然停止已修。** 真机 13 份会话转录逐事件统计：12 次异常收尾全是
`web capture ended incomplete`——网页没发 `FINISHED`/`close` 就断流，旧解码器要求
两帧齐全，于是已经解出的正文和完整工具调用被一起丢掉。现在解码器把已解出内容带出来
并标 `partial`，驱动层接受这一轮；真的什么都没有、或结构坏掉，才失败。

**工具调用失败有据可查。** 真机 64 次工具报错全部是参数形状漂移（`"offset" must be a
number`、`"questions" must be an array`、缺 `description`），并新增 `TOOL_UNKNOWN`：
网页调了本会话不存在的工具时不再静默过滤成"收束"，而是报错并把可用工具名回传，下一轮
可自纠。游标指纹改为只锁工具名集合，工具描述升级不会再顶掉上下文游标。

**预览打不开会说明原因。** 实测 `chat.deepseek.com` 经镜像反代被 CloudFront 判成机器人
返回 403（glm/kimi/qwen/grok/zai 均 200）。镜像现在补常规浏览器指纹、识别 CDN/WAF
错误页并换成「为什么 + 改用独立窗口打开」的说明页；站内 302（豆包 `/` → `/chat/`）
改写为带镜像前缀，不再落在命名空间外变空壳。

**新增站点 z.ai**（`https://chat.z.ai`，OpenAI 兼容 SSE，静态域 `z-cdn.chatglm.cn`，
别名 `zai`/`z-ai`/`chat.z.ai`），实测镜像 200。

取证结论见 `doc/bridge-failure-ledger.md`（本机 13 份真实会话转录的逐事件统计；
原先指向的 `doc/incident-2026-09-11.md` 已于 2026-09-16 删除）。

## 0.9.4

协议文本不再进助手文本：截在正确的层。

真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON）。真因不在渲染，而在流式边界探测与解析器各认一套形态：
`parseAgentReply` 有 DSML 归一化，所以工具照常执行；而流式那句行内 `marker()`
只认半角标签 / 围栏 / Calling / 裸 `{`，对全角 DSML 恒返回 -1，于是协议原文被当
正文一路发出去。显示层折叠救不了它（那段是正文段落，不是 `<pre>`）。

- `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套形态
  知识，探测协议起点与工具名；流式循环改用它。
- `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文。
- `normalizeDsml()`：归一化收为一处，探测与解析不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文，只是“发往界面”的那一侧被截断。
回归：`test/protocol-leak.test.mjs`（9 项，真机夹具 `test/fixtures/leaked-dsml-reply.txt`）锁住
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。
MIT。SSE 解码协议参考 MIT 项目 three-water666/webcode。产品展示名更新，安装包名及 provider ID 保持兼容。
