# Harness Web Bridge 路线

## 当前版本 0.9.9

0.9.9（多站点 tab 适配 + 设置页按真实需求重构）：针对「除 DeepSeek 外 kimi/qwen
打不开、glm 空白、chatgpt 渲染出错、退出视图再进加载很久、设置里找不到登录管理」
五条真机反馈。

1. **镜像同源化从白名单改为全量（`lib/mirror.js`）。** qwen 的主资源域
   `assets.alicdn.com`、GLM 的 at/o.alicdn.com（图标字体）等当年不在
   staticOrigins 白名单里，crossorigin 脚本被非法 ACAO 拒绝 → 整页空白/渲染
   出错。现在标签属性语境（src/href/poster/srcset）与 CSS url() 里的**一切绝对
   资源 URL** 一律改写到 `/__static/<host>/…` 同源转发；运行时 fetch/XHR 仍按
   ASSETS 清单；内网/回环 host 拒绝代理（防本机 SSRF）。providers.js 补齐
   qwen/glm 实测静态域。真机复验：glm 镜像外部引用归零，qwen 只剩行内 JS
   运行时赋值（无 crossorigin，直接加载，无害）。
2. **standalone 桥多站点路由修复（`bin/bridge-standalone.js`）。** executor
   写死 deepseek 驱动，`zai:auto`/`glm:auto` 全部 MODEL_SITE_MISMATCH。现按
   meta.siteId 路由（与 DSH 插件路径同规则）；真机 glm:auto 一句话对话实测通。
3. **GLM 累积帧去重（`lib/decoder.js`）。** GLM 流帧的 text 是**累积全文**而非
   增量（真机一句话被原样输出两遍——末两个 update/finish 帧各带全文）。按
   part:content 槽位做累积差分：相同帧跳过、前缀扩展只发新增后缀、无关片段追加，
   三种语义（累积/增量/片段）全兼容。
4. **右侧栏 iframe 保活（`lib/client.cjs`）。** 旧实现每次挂载都重设 src
   （`?ts=` 时间戳）——侧栏每开合一次整页重载，站点应用初始化数秒。现在访问过
   的站点 frame 全部常驻 DOM 按 display 切换，重进零加载；刷新按钮才强制重载。
5. **设置页按真实需求重构（`lib/client.cjs`）。** 修复了旧 Settings 组件的卡片
   括号错乱（连接卡片提前闭合，登录管理渲染不出来）；新结构：**账户与登录管理**
   （每站点一行：状态 + 登录/更换账户 + 独立窗口，等待真实结果回显）置顶 →
   模型管理 → 连接 → **速度观测**（HTML/CSS 条形图：首字/思考/正文/速度/总耗时）
   → **会话与子代理**（subAgentMode：独立=每个子代理自己的新网页对话 / 共用=
   与主会话同对话，own 为默认；buildTurn 按 keyPath 尊重该设置）→ 首轮提示词
   （固定模板只读展示 + 全局指令为唯一可编辑段）。**网页历史导入 UI 移除**
   （后端路由保留，测试仍在用）。

已知问题：z.ai（zai:auto）的 SSE 是 `chat:completion` 包装帧，`openai-sse` 解码器
对不上导致单轮静默等满 240s 超时——需要真机抓流后写专用解码器（experimental 标
注保持）。chatgpt.com 的 WAF/登录墙对镜像代理天然敏感，建议独立窗口打开。

## 0.9.8

0.9.8（流式收尾回归修复 + 两轮结构优化）：0.9.7 收尾后做「长期真实调用」复跑，
发现 0.9.6 的流式循环重写里 `textSent`（已外发正文）从字符串被改成了数字下标，
而收尾处 `finalText.startsWith(textSent)`、`finalText.slice(textSent.length)`、
`stripProtocolText(textSent)` 仍按字符串用——这正是「回复缺失/没法同一对话继续」
比 0.9.3 更糟的直接原因。四条真机症状全部定位并修复：

1. **纯文本回复必抛 `STREAM_REWRITE`**（`"完整回复".startsWith("123")` 恒假 →
   整轮作废、游标不前进、下一轮重复发增量）：恢复 `textSent` 的字符串语义，
   保留 0.9.6 的单调边界逻辑（`lib/index.js`）。
2. **带调用的回复正文块变成数字**：`stripProtocolText(下标)` 返回 `String(下标)`
   ——解析出调用而流式探测没开块时，助手文本只剩一个数。修复后正文块恒为
   已发散文原文。
3. **收尾 tail 用 `slice(textSent.length)`**（数字没有 `.length` → `slice(0)`），
   整段正文重发一遍。修复后只补发未发的尾巴。
4. **协议原文在工具名分片到达前漏进正文**：0.9.6 用 `knownName`（要求名字已到）
   门控正文边界，但名字在参数分片里后到；改为按 `transport` 形态即停（名字不
   匹配工具表时不开调用块，JSON 配平后游标越过，这段最终仍会送达）。
   另补 `findProtocolStart` 对「```json 围栏 + `{"name","arguments"}`（无
   mcp_action）」的 transport 判定——解析器认、探测不认的 0.9.4 式泄漏。
5. **网页部分断流（end.text 为空但增量已流出）按增量收尾**，不再误判空回复。

护栏：`test/stream-tail.test.mjs` 六项（纯文本不抛 STREAM_REWRITE、正文块=
散文原文、围栏形状不泄漏、`5 < 10` 结尾不截断、断流按增量收尾、增量与块内容
一致）。真机验证：`node test-mock/run-real-longrun.mjs`（真实 Edge + 真实网页
会话 + 真实工具闭环），0.9.8 前后各跑一次均 PASS——同会话 5 轮全部
`fresh=false`（无整段重建）、一轮 13 个调用全解析执行、追问「总行数」答出与
本地真值一致的数字（5606/5606）、报告文件落盘、无协议泄漏。

两轮独立结构优化（每轮后全量 `pnpm test` 复验）：

| 指标 | 0.9.7 基线 | 第一轮（复用/职责分离） | 第二轮（可读性） |
| --- | --- | --- | --- |
| `lib/index.js` 行数 | 1105 | 949 | 1053（含 ~105 行 0.9.8 修复与注释） |
| 内联设置页 HTML | 101 行 | 抽出 `lib/settings-page.js` | — |
| 块开关舞蹈（开思考/开正文/关思考） | 8 处内联 | 每循环一次定义，12 个调用点单行化 | — |
| `usage`+`finish` 收尾对 | 4 处重复 | — | `finishChunks()`，3 处收敛 |
| 空回复判定表达式 | 3 处重复 | — | `assertNonEmpty()` |
| 流式 8 字符消歧尾巴 | 魔数 `-8` | — | `PROSE_TAIL_CHARS` |

登录链路（0.9.5 已修，本次复核）：设置面板（client.cjs `LoginSites`，
`wait:true` + 300s 超时）→ `POST /__webcode/login` → `loginAndReport` →
`openLogin()`（already-logged-in 快速路径 / 清单实例锁重试 / 结果回传）。
真机长跑预检 `connect` 返回 `loggedIn:true`；未登录时长跑脚本会自动开有头
窗口等人工登录后再继续。

## 0.9.7

0.9.7（工具调用「能执行」收尾）：针对「有些工具用 DeepSeek 在新对话里执行不了」
这条反馈，把属于桥的那一半彻底修掉，并给出一条可回归的验证剧本。

1. **参数形状纠偏（新增 `coerceArguments`）。** 真机 64 次工具报错**全部**是同一
   类：`"offset" must be a number`（网页把数字写成字符串 `"10"`）、
   `"questions" must be an array`（数组写成单对象）、
   `"run_in_background" must be a boolean`。现在按工具 schema **显式声明的类型**
   做定向纠偏，只做无歧义的方向；没声明类型、或解析失败（`"abc"` → number）一律
   原样保留，交给 DSH 报它自己的错——桥不吞、不猜。
2. **未知工具不再整轮作废。** 网页调了本会话没有的工具（真机里调过未登记的
   `write` / `subagent`）时，旧实现抛错让整轮失败，用户得手动再催一次；现在把
   「TOOL_UNKNOWN + 本会话可用工具清单 + 请重试」作为这一轮的回复交回会话，正常
   收束，下一轮模型据此自纠。
3. **新增 `test/tool-loop.test.mjs`：新会话工具闭环剧本。** 用注入驱动模拟网页真实
   产出的**五种**调用形状（标准 `<tool_call>` / 全角 DSML / 裸 `<invoke>` XML /
   ```json 围栏 / `**Calling:**` 渲染），每一种都必须产出可执行块；再加参数纠偏与
   未知工具两条。这是「新开一个对话验证每个工具」在桥这一侧的判据。

> 关于「某些工具在 DeepSeek 下执行不了」的边界说明：桥只能保证**网页发过来的调用
> 被正确解析、纠偏、交付**。DSH 在任何会话模式下只把**该会话真实注册的工具**交给
> 模型（极简模式实测只有 `pwsh`），所以 `subagent`/`write`/`edit` 之类的调用在
> 极简模式下本来就该被拒绝——桥现在会明确回报可用清单而不是静默停摆。要跑多工具
> 任务请把会话预设切到标准模式（见 [长跑审查](doc/deepseek-longrun.md) 第四节）。

## 0.9.6

0.9.6（流式协议边界重做）：0.9.5 收尾前做「一轮连发多个调用」的真机形状复现，把流式循环里三处会**静默损坏或挂死**的缺陷一次改掉。这三处都在
`lib/index.js` 的流式循环 + `lib/agent-preset.js` 的探测函数里：

1. **同一个调用被开成几十个块。** 边界探测每来一个 delta 都在同一位置命中，
   而游标只在「参数 JSON 配平」后才推进；真机「连发 3 个 read」实测被开成 32 个
   调用块，最终因块数与解析结果不匹配抛 `TOOL_PROTOCOL_INVALID`、整轮作废。
   现在：按边界下标去重（一个调用只开一次块）+ 参数配平后把游标推到该对象末尾。
2. **协议原文又漏回正文。** 游标推进后再次搜索会命中**更早**的收尾标签
   （`</tool_call>` 本身也是锚点），正文外发区因此回退，把
   `</tool_call>{"mcp_action":…` 整段当散文发出去；另一半是「半成品标记」：
   `<t` / `<tool_cal` / `**Calling:` 前缀在完整标签出现前被当正文发出。
   现在：正文边界**单调不减**，并用 `partialProtocolAt()` 定位半成品标记起点、
   停在那里等下一个增量。
3. **`safeEnd` 卡死导致流式循环挂住。** 一旦把「非可执行调用的裸 `{`」当截断点，
   正文下标就再也推不动（实测 `node --test` 直接跑不完）。现在只有**确认为真
   调用**才用边界截断，其余只保留极短尾巴。
4. 顺带修掉一个交付格式 bug：调用块关闭时把「已发到的下标」当块内容发出去
   （`block.text` 变成数字 `3`），应为已发正文原文。

护栏：`test/parse.test.mjs` 新增 6 项直接锁这三个函数的语义（偏移定位、完整性
判定、半成品标记、普通 `<`/`>` 不误扣、DSML 形态一致）；`test/regression.test.mjs`
新增「一轮连发 3 个调用」端到端用例（3 块、id 唯一、同 id 只交付一次、散文保留、
协议不得进正文）。

## 0.9.5

0.9.5（真机故障取证后的五修 + z.ai）：本机 13 份真实会话转录逐事件统计后定位
（取证全文见 [故障取证](doc/incident-2026-09-11.md)）：

1. **「跑到一半突然停止」= 部分流被整段丢弃。** 12 次 `turn/end` 的 error 全是
   `web capture ended incomplete`：网页没发 `FINISHED`/`close` 就断流，而解码器
   旧判据要求两帧齐全，于是已经解出的正文与完整工具调用被一起扔掉。现在解码器
   把已解出内容带出来并标 `partial`，驱动层接受这一轮（记 `recoveredTurns`），
   只有真的什么都没有或结构坏掉才失败。
2. **工具调用失败全是参数形状漂移**（64 次报错无一例外）：`"offset" must be a
   number`、`"questions" must be an array`、缺 `description`/`command`。另加了
   `TOOL_UNKNOWN`：网页调了本会话不存在的工具（真机调用过未登记的 `write`）时，
   旧实现静默过滤 → 空回复被当收束 → 任务从此不动；现在报错并把可用工具名带回
   会话，下一轮可自纠。
3. **「退出一次后哪儿都登不上」= 写死 deepseek 的入口 + fire-and-forget 登录 +
   持久 profile 残留单实例锁。** 登录现在返回真实结果、控制面默认等待、
   启动前清 `SingletonLock`/`SingletonCookie` 等残留锁（仅在确认无活着的 ctx 时），
   有头启动失败自动清锁重试一次；设置页新增「登录网站」站点选择器。
4. **「上下文不会动」= 游标指纹认了工具描述的措辞。** 指纹改为只锁工具**名集合**，
   描述/schema 变化不再顶掉游标、不再每轮重建首轮；`contextWindow` 从一律 1e6
   收敛为按站点保守值（DeepSeek 128k、其余 64k，可覆盖），让 DSH 的压缩能触发。
5. **「预览除 deepseek 外都能开」= 镜像被 CloudFront 判成机器人。** 实测
   `chat.deepseek.com` 经反代返回 403 `Request blocked…`（glm/kimi/qwen/grok/zai
   全 200）。镜像补常规浏览器指纹头、不再剥 `sec-fetch-*`，识别 CDN/WAF 错误页并
   换成「为什么 + 改用独立窗口」的说明页；站内 302（豆包 `/` → `/chat/`）改写为
   带镜像前缀，不再落在命名空间外变空壳。

新增站点 **z.ai**（`https://chat.z.ai`，OpenAI 兼容 SSE，静态域
`z-cdn.chatglm.cn`，别名 `zai`/`z-ai`/`chat.z.ai`），实测镜像 200。

回归：本地 8 个测试文件全绿（`node test/<f>.test.mjs` 逐个跑；`pnpm test` 在本
沙箱会因 pnpm 依赖自检无 TTY 而中止，与代码无关）。

## 0.9.4

0.9.4（协议文本不再进助手文本：截在正确的层）：真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON），既占屏幕又打断阅读。真因不在渲染，而在**流式边界探测与解析器
各认一套形态**：

- `parseAgentReply` 有 DSML 归一化，所以工具照常执行；
- 流式那句行内 `marker()` 只认半角标签 / 围栏 / Calling / 裸 `{`，
  对全角 DSML 恒返回 -1，于是协议原文被当正文一路 text-delta
  发出去、写进会话。

显示层折叠救不了它：那段是正文段落，不是 `<pre>`。修正落在桥接层：

- 新增 `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套
  形态知识，探测协议起点与工具名；流式循环改用它，
  协议文本从此不再进 text-delta；
- 新增 `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文；
- `parseAgentReply` 改用共享的 `normalizeDsml()`，两处不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文（`parseAgentReply(finalText)`），只是
“发往界面”的那一侧被截断。真机夹具 `test/fixtures/leaked-dsml-reply.txt`
（从会话转录原样抽出）与 `test/protocol-leak.test.mjs`（9 项）锁住三件事：
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。

注：0.9.1–0.9.3 的“显示层折叠”已整体回退（`git stash`，可恢复）
——它对不上真机形态（只扫 `<pre>`，而泄漏的是正文段落）。

## 0.9.0
0.9.0（官方右侧栏 + 多站点真实可开）：三处收敛。

1. **右侧栏改用 DSH 官方实现**：`@deepseek-ai/dsh-client-ui-sidebar-right` 的
   `sidebarRightTabs.register()` + `sidebar.right.pane.tab` seat，与会话头角落按钮配对。
   此前依赖第三方 `dsh-better-sidebar`，且降级分支是 `position:fixed` 浮层——
   浮层会盖住右侧内容，正是「点击展开就遮挡」的来源。迁移后侧栏是布局内的一格，
   **结构上不可能遮挡**，并彻底删除 `dsh-better-sidebar` 依赖与浮层代码。
2. **模型三合一**：网页版早已没有「快速/专家/识图」三 pill，模式差异只剩「深度思考」。
   模型目录收敛为一个 `DeepSeek`；`flash`/`vision`/`deepseek-web`/`deepseek-reasoner`
   保留为别名，旧设置值不炸。带图能力对该模型自动生效。
3. **跨域静态资源同源化**：修复「打开异常」的真因——站点脚本跨域 + 非法 ACAO 被浏览器拒绝。
   站点声明 `staticOrigins`，镜像改写 HTML/CSS 绝对 URL、剥离 integrity/crossorigin，
   并把运行时 fetch/XHR 一并改写。GLM 埋点 CORS 52→0。

附带修复：Kimi 域名迁移（`kimi.moonshot.cn` → `www.kimi.com`，旧域名只剩 302）；
面板顶栏加 **刷新** 按钮（官方右侧栏无此入口）；不可达站点给出带站点名的说明页而非裸 JSON；
`test/mirror.test.mjs` 新增护栏锁住「先改写再注入」的顺序契约。

## 0.7.3

0.7.3（新 UI 适配）：2026-09-10 chat.deepseek.com 改版——模型三 pill 消失，

0.7.3（新版 UI 适配）：2026-09-10 chat.deepseek.com 改版——模型三 pill 消失，
输入框只剩「深度思考 / 智能搜索」开关，首条与续聊消息的 model_type 恒为 default，
模式差异只剩 thinking_enabled（带图发送 = default + ref_file_ids）。驱动新增 UI 代际
侦测（classic/unified），unified 下按模型语义同步深度思考开关；发送后核验升级为
「契约期望元数据全量比对」（unified 必查 thinking_enabled，model_type 缺失/null 视为
网页沿用会话模型）。长跑真机还暴露三种「解析器漏形状 → 工具循环静默中断」的调用漂移
（混合壳 / 新版 DSML 带类型属性 / tool_call 包装壳）与重复匹配，均已修复并加回归测试；
probe-17 增加「收束文本仍含调用记号即 FAIL」护栏。真机 doctor 8/8、10 轮零干预马拉松通过。详见
[长跑审查](doc/deepseek-longrun.md) 第六节。

## 0.7.2

0.7.2（长跑可靠性）：网页会话丢失改「重放整段首轮」而不是静默发增量；网页输入框
截断超长提示词改为报错；页面崩溃/浏览器被关立刻失败并自愈重开；中止会等停止
按钮点完；工具描述不再截到 300 字符（DSH 的硬约束就写在描述里）。详见
[长跑审查](doc/deepseek-longrun.md)。

## 0.6.0

多站点内容服务打通：模型选择器与 /v1/models 暴露全部 9 个内容服务的模型（'site:model' 限定 id），executor 按站点路由到独立 driver（独立 profile，避免登录态串号），未初始化站点在状态接口给占位、不启动浏览器；思考链（onThink → DSH reasoning 块）与网页图片（onImage → markdown/OpenAI image parts）贯穿 DeepSeek/GLM/ChatGPT/Kimi/Qwen/豆包/Grok/Claude/Gemini。

0.6.0 新增（本轮）：
- 模型目录收口 `listAllModels()`（providers.js），DSH 选择器与 OpenAI /v1/models 同源；
- 多 driver 容器 `driverFor(siteId)`：deepseek 沿用默认驱动（兼容测试注入），其余站点懒创建 `profileDir/sites/<siteId>`；
- executor/OpenAI 前端共用 `qualifyModelId()` 归一化限定 id，杜绝跨站点重名串模型；
- /bridge/login 与 /__webcode/login 支持 `siteId` 参数按站点登录；status 聚合 `sites[]` 列表；
- 设置页「默认模型」下拉列全站点模型；
- 解码器按逆向证据对齐：GLM（parts[].content[] 嵌套）、Kimi（event:'cmpl'）、ChatGPT（JSON-patch + 结构帧双形态）、Qwen（OpenAI 兼容 SSE + qwen-free-api 兜底），见 reference/glm-free-api、Kimi-Free-API、LLMs2API 等仓库。

已复用：MIT 的 webcode SSE 协议实现、Playwright Core、Harness 原生 LLM 与权限契约、已安装 better-sidebar 注册接口。没有复制侧栏插件本体，也没有引入另一套本地工具执行器。

## 后续顺序

1. DeepSeek 契约维护：将 DOM、模型目录、请求类型、SSE 样本集中为供应商契约；升级前运行三模型探测、真实只读工具闭环和脱敏样本回归。未知页面或请求类型拒绝继续，不静默降级模型。（探针脚本 test-mock/real-probe-05*.mjs 已就位；统一契约自检见 test-mock/real-verify.mjs，真机 7 项全绿：三模式 model_type=default/expert/vision + 工具闭环自主 read→真实执行→总结收束）
2. ~~支持图片附件~~（0.5.0 完成：消息图片块 → 网页文件上传，真机验证）
3. ~~恢复网页列表与导入~~（0.5.1 完成：真机验证 `chat_session/fetch_page` 与 `chat/history_messages` 当前结构；设置页「网页历史」可导入为主线 DSH 会话）
4. ~~设置持久化~~（0.5.0 完成 consent 持久化）；剩余：接入宿主 settingsScope 保存默认模式、预览刷新率等界面偏好。
5. ~~多站点~~（0.6.0 完成：9 站点模型目录 + 独立 driver 路由 + 按站点登录；各站点解码器已按 reference 逆向证据对齐，真实登录后的 DOM 契约仍需逐站真机校准——completionPaths 子串匹配、模型选择器标签、图片回传形态以真机为准）
6. 强化可靠性：同一 Harness 会话并发提交隔离（0.5.0 已按 agentId 隔离网页会话）、网页上下文超限、删除网页会话后的完整重建、IME 和复制选区体验。
7. ~~自定义全局指令~~（0.5.1 完成：设置页「全局指令」保存到 webcode-settings.json，追加到每个新网页会话首轮提示词）
