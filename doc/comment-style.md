# 注释规范：只写「为什么」

本仓库（`dsh-webcode-bridge`）的源码注释有一条很硬的取向：**注释解释「为什么」，代码说明「做什么」**。
它的直接后果是——注释里大量出现日期、站点名、真实数字与「旧实现错在哪」。这不是文风偏好，而是
因为本仓库的绝大多数改动来自 AI 会话：会话会被重启顶掉、上下文会丢失，**注释是唯一的跨会话记忆**。
一份只写「设置模型」的注释，对下一个会话等于零信息；一份写着「旧实现按 system 文本里出现
『标题』就判为命名请求，导致真实轮次被本地截断」的注释，能让下一个会话不敢把那行改回去。

写新注释前先读 `doc/review-guide.md`（15 个源码文件的地图 + 三条不可越界约束）。

---

## 1. 一句话原则

> **注释解释「为什么」，代码说明「做什么」；不写同义反复。**

判断标准只有一个：把这段注释删掉，后来者会不会更容易写错？
会 → 保留并写足；不会 → 删掉。

---

## 2. 必须写注释的六种场合

### 2.1 反直觉的实现（看起来可以更简单，但简化会引入 bug）

代码看上去绕、或者明显存在「更直接」的写法时，必须写明**为什么不能简化**。

正例一 —— 收束条件是「流停」**且**「DOM 停止增长」两个条件，而不是只看流停
（`lib/metrics.js:93-110`）：

```js
 * **安全线（必须有反向单测）**：收束条件是双重的——「流停」**且**「页面 DOM 的
 * 助手消息长度停止增长」。只看流停会截断仍在生成的长回复：思考阶段本就可能
 * 十秒级不吐正文，只看流停等于把正常长回复判死。因此任一条不满足就**不收束**。
```

```js
  if (!(now - Number(lastProgressAt) >= idle)) return false;   // 流还在动 → 绝不动
  if (!domAvailable) return true;                              // 页面不可用：退回仅流停判定
  return now - Number(lastDomGrowthAt) >= idle;                // 页面还在长 → 绝不动
```

正例二 —— 会话游标指纹只锁「工具名字集合」，不是整个 tools 对象
（`lib/index.js:1421-1432`）：

```js
    // 游标指纹只锁「真正决定网页侧提示词内容」的东西：模型、系统提示词、
    // 全局指令、工具**名字集合**、以及已经发出去的消息。
    //
    // 旧实现把 options.tools 整个对象 JSON.stringify 进指纹——工具描述的措辞
    // 一变（宿主升级、动态描述、参数 schema 里字段顺序变化）指纹就变，游标被
    // 判为陈旧、下一轮改走「整段重建」，网页那一侧于是被重开一个新会话。
    // 真机表现：一切正常但上下文像「不动了」（每轮都在重建首轮），并且网页会话
    // 槽被反复切换。名字集合一致就沿用同一网页会话。
```

正例三 —— 会话缓存淘汰前先删后插（`lib/index.js:1470-1476`）：

```js
      commit() {
        // 先删后插把键移到 Map 尾部；配合尾部淘汰就是「最近最少使用」，
        // 旧写法对已存在键 set 不改变插入序，淘汰会先丢掉最老的热会话，
        // 表现为长会话莫名重新整段重发。
```

正例四 —— 空流不立即收场，留 3s 宽限（`lib/browser-driver.js:475-480`）：

```js
      // 空流宽限重绑（no_response_frames 缓解）：DeepSeek 前端自动重试时，占位的
      // 空/错流会先到先收（end 触发 finish），真正的重试流随后才开、被
      // captureId 过滤丢弃——整轮报 no_response_frames，长任务反复被打死
```

### 2.2 曾经的 bug 与回归点（说明「旧实现怎样、表现是什么」）

凡是「有人很可能改回去」的地方，都要把旧实现与当时的症状一并写下，让回归在代码里
面就被拦住。

正例一 —— `lib/index.js:312-314`（命名判定）：

```js
 * 只认 DSH 自己的 `purpose: 'session-title'`。旧实现还拿 system 文本里的
 * 「title/标题/命名」当判据——工作区指令里只要出现过这些词，一次真实轮次就会
 * 被本地截成前 16 个字直接返回，模型根本没被调用。
```

正例二 —— `lib/index.js:607-609`（0.9.6 的流式回归）：

```js
      // 已外发的正文原文（字符串，acc 的前缀）。0.9.6 曾把它改成「已发到的下标」
      // （数字），但收尾处的 startsWith/slice/stripProtocolText 仍按字符串用——
      // 纯文本回复必抛 STREAM_REWRITE 整轮作废、带调用时正文块变成数字。
```

正例三 —— `lib/web-control.js:41-46`（控制面漏挂载事故）：

```js
 * 动机（真机 2026-09-13 取证）：index.js 曾手写一份 routes 数组，
 * verify-login / site-probe / session-import 三个 action 加进了本文件的表、
 * 却忘了加进那份数组 —— 设置面板的「检测 / 独立窗口 / 导入登录态」按钮
 * 全部落到 DSH webServer 的未知 POST 兜底（405 + 空 body），客户端
 * response.json() 于是抛 “unexpected end of JSON data”。
 * 让挂载清单从 action 表派生，这类「加了 action 忘了挂载」不可能再发生。 */
```

正例四 —— `lib/index.js:226-228`（图片被静默丢弃的旧账）：

```js
 * 0.12.9 之前这里根本没有解析 attachment store，imagesOfMessages 只认
 * wire 形状（url / image_url / source.data / base64），与原生块**零交集**，
 * 于是 harness 截图/粘贴的图每次都被静默丢弃——网页端自然说看不到图。 */
```

正例五 —— `lib/browser-driver.js:1161-1164`（部分流旧实现直接抛错）：

```js
        // 部分流：正文/思考/图片已拿到，但网页没发 FINISHED/close。把已有内容当
        // 本轮结果交出去（上层会解析工具协议、执行、回填），下一轮再让模型续写。
        // 旧实现直接抛错——模型已输出的正文与完整工具调用被整段丢弃，界面上就是
        // 「跑到一半突然停止」，且工具循环再也不会继续。
```

### 2.3 真机取证（日期 + 站点/环境 + 现象 + 关键数字）

这是本仓库注释最有辨识度的部分。**凡是「网页实际这样、不是我们猜的」的结论，都要带日期**，
必要时带站点、当时的数值现场。没有日期的经验之谈，下一个会话会当成猜测推翻重来。

正例一 —— `lib/metrics.js:50-57`（发送间隔语义修正）：

```js
 * 为什么是纯函数：真机 2026-09-13 用户报「等待时间好像不是按我设置的来」。
 * 取证发现设置**存住了**（`webcode-settings.json` 里 `sendGapMs: 10000`，
 * `GET /__webcode/settings` 也回 10000），真正的原因是三件事，其中两件在
 * 这里被固化成可离线断言的行为：
 *   a) 基准是「上一轮**结束**」而非「上一轮**发出**」——一轮跑了 20.9s 时，
 *      10000ms 的间隔只剩 7609ms 可见（真机 metrics 实测值）；
```

正例二 —— `lib/browser-driver.js:516-522`（WIP 永不发 FINISHED）：

```js
   * 背景（真机 2026-09-13 取证）：DeepSeek 网页流可能以 `status:'WIP'` 结束且
   * **永不发 FINISHED**。解码器于是给 `{complete:false, partial:true}`，而
   * `done` promise 只有 `phase==='end'`（此时已经过去了）或 240s 定时器能
   * settle——一轮早就写完的回复于是把 sendTurn → relay → 适配器的
   * `await ch.next()` 全部挂住，界面表现是**无限「思考中」**。
   * 现场证据：recoveredTurns=1、lastRecovered.reason='stream_ended_before_finished'、
   * status='WIP'、chars=463。
```

正例三 —— `lib/browser-driver.js:618-620`（Windows 进程终止方式）：

```js
  /** 杀掉命令行里含本 profileDir 的孤儿 Edge 进程（只杀 ours，不碰用户自己的 Edge）。
   *  必须走 WMI Terminate：Stop-Process/taskkill 对 Chromium 子进程的受限 DACL
   *  会拒绝访问（真机 2026-09-12 实测），WMI 的 Terminate 能正常终结。 */
```

正例四 —— `lib/browser-driver.js:624-625`（分隔符导致匹配失败）：

```js
      // 统一成全反斜杠再匹配：调用方传混合分隔符（C:\Users\x/.dsh/…）时
      // -like 永远匹配不上（真机踩过）。
```

正例五 —— `lib/web-control.js:117-119`（回环子域被误拦）：

```js
    // DNS 重绑定防护：Host 必须是回环名称族。**包含 <site>.localhost 子域**——
    // 右栏的站点 iframe 就住在那些源上，控制面必须在那上面照常可用（真机
    // 2026-09-13：旧正则只认裸 localhost，子域上的 /__webcode/* 全被 403）。
```

正例六 —— `lib/metrics.js:23-28`（按 UI 代际取期望值）：

```js
/** 网页模型 id → 其请求上报的 model_type 期望值（真机核验契约）。
 *
 *  桥只暴露一个 DeepSeek 模型（2026-09-11 三合一），差异全在「深度思考」：
 *  classic = 旧三 pill UI（≤0.7.2）：deepseek 走专家模式 → model_type=expert；
 *  unified = 2026-09-10 新版 UI：model_type 恒为 default，差异只剩 thinking_enabled
```

正例七 —— `lib/browser-driver.js:475-478`（具体到某次会话的某一步）：

```js
      // captureId 过滤丢弃——整轮报 no_response_frames，长任务反复被打死
      // （0.12.2 真机 goal 会话 turn2 step12 实锤）。空流不立即收场：留 3s
```

### 2.4 不可越界约束（如「工具协议只有 agent-preset.js 一处定义」）

本仓库有一批「谁改谁负责」的约束，写在代码里比写在文档里更靠近改动点。

正例一 —— 唯一真相从 action 表派生（`lib/web-control.js:38-39`）：

```js
 * 这是控制面的**唯一真相**：进程内分派器（handle）与宿主路由挂载
 *（lib/index.js 的 webServer.register）都从它派生。
```

正例二 —— 别名的唯一定义处（`lib/providers.js:373-376`）：

```js
 * 因此：**列表接口仍返回它**（历史会话、`agent-default-model` 的旧值、OpenAI
 * 前端的 `model: 'deepseek-web'` 都依赖它解析），但**选择器下拉过滤掉它**。
 * 这份集合是「哪些是别名」的唯一定义处：UI（client.cjs）、适配器
 * （index.js listModels）与测试都必须从这里取，不许各自再写一份字面量。
 */
export const MODEL_ALIAS_IDS = Object.freeze(new Set(['deepseek-web']));
```

正例三 —— 无法共享模块时，用测试钉住重复字面量（`lib/client.cjs:266-268`）：

```js
      // 这里是浏览器侧 bundle，无法 import 主机的 providers.js，因此字面量不得
      // 不重复一份；两处一致由 test/model-labels.test.mjs 钉住（它同时读
      // providers.MODEL_ALIAS_IDS 与本文件，不一致即失败）。
```

正例四 —— 宿主服务注入必须先声明（`lib/index.js:28-30`）：

```js
// cordis service injection: declaring these is REQUIRED before ctx.webServer /
// ctx.llm property access is permitted ("cannot get property ... without inject").
export const inject = ['llm', 'webServer'];
```

正例五 —— 只注册适配器，不再注册到 configurable 目录（`lib/index.js:415-420`）：

```js
  // Pure adapter registration (the shape opencode2dsh's adapter mode uses): the
  // provider appears in the model selector immediately and listModels is read
  // live at selector time. We deliberately do NOT also call
  // registerConfigurableProviders — declaring the same provider in the
  // "configurable" directory as well makes the GUI treat it as an endpoint-
  // gated provider and the models never surface in the main selector.
```

正例六 —— 安全线要求反向单测（`lib/metrics.js:93`）：

```js
 * **安全线（必须有反向单测）**：收束条件是双重的——「流停」**且**「页面 DOM 的
```

（全仓三条不可越界约束的完整列表见 `doc/review-guide.md`：绝不静默降级模型、
绝不静默丢上下文、工具协议只有 `lib/agent-preset.js` 一处定义。）

### 2.5 有意为之的取舍（如「不假装切换成功」「宁可失败也不静默截断」）

凡是在「看起来能糊过去」和「如实报错」之间选了后者的地方，都要写明这是选择，不是疏漏。

正例一 —— 模型切换没校准就如实报（`lib/browser-driver.js:1266-1273`）：

```js
   * 0.13.0 重写（真机根因）：旧实现在没有选择器契约时，用
   * `getByText(labels[0], {exact:true})` 之类的启发式**猜着点**，猜不到就
   * `return { strict:false, fallback:'default-model' }` —— 而调用方把这个
   * 返回值当成功继续往下走，于是「模型选择」在多数站点上是静默的空操作。
   *
   * 现在：站点在 providers 里声明 modelPicker 契约（触发 + 选项 + 回读），
   * 由 lib/model-picker.js 执行**精确名匹配 + 点击后回读确认**；没有契约就
   * 如实报告 unverified，绝不假装切换成功。
```

正例二 —— 声明保守的上下文窗口（`lib/index.js:49-51`）：

```js
  // 每个站点向 DSH 声明的上下文窗口。网页 composer 的真实上限未知，声明过大
  // 会让 DSH 的压缩永不触发（transcript 只增不减）；这里给保守值，越界时由
  // PROMPT_TRUNCATED 回读校验报错而不是静默截断。
```

正例三 —— 图片能力宁可声明为不支持（`lib/index.js:446-448`）：

```js
      // 因此按模型的真实带图能力声明（acceptsImages，不是 vision：vision 是
      // DeepSeek 那种必须带图的独立识图模式）；未真机校准的一律 text——宁可
      // 明确不支持，也不让图片在半路被悄悄换掉。
```

正例四 —— 会话丢失时只能重放整段（`lib/index.js:1104-1107`）：

```js
            // 网页会话被删/过期：桥这一侧的唯一正确恢复是重放「首轮整段」——
            // 网页会话里保有的就是首轮全文 + 后续增量，重放首轮即完整上下文
            // 与工具协议，而不是把一个没有前文的增量丢进新会话（那才是真正的
            // 「跑着跑着变傻」）。重放失败才把游标作废，交给下一轮。
```

正例五 —— 时钟回拨时的取舍（`lib/metrics.js:72-74`）：

```js
  // 时钟回拨：基准在未来时既不能按原值等（可能白等几小时），也不能假装没发过
  // 而彻底不落盘。选择「按刚发过处理」——clamp 到 now，于是 waitMs = gap，
  // 是本轮真实需要的最小等待，且把 skewed 交给调用方记录。
```

正例六 —— 限流不进空流宽限（`lib/browser-driver.js:480`）：

```js
      // 限流（rate_limited）不进宽限：服务端已撤回消息、不会自动重发，白等 3s。
```

### 2.6 外部依赖的脆弱点（网页 UI 改版、Windows 权限、沙箱限制）

本仓库建立在别人的网页 UI 之上，**脆弱点是常态而不是意外**。凡是有可能在某个早晨
失效的地方，都要写清「失效时长什么样、报错码是什么」。

正例一 —— 严格模型校验：取不到请求体即失败（`lib/browser-driver.js:1121-1124`）：

```js
        // 「绝不静默降级模型」：核验本轮真实请求元数据。新版统一 UI 的模式差异在
        // thinking_enabled（model_type 恒为 default），旧三 pill UI 的差异在
        // model_type。取不到请求体本身即失败——旧实现只比对非空 model_type，
        // 请求体一旦改形（如 model_type 消失）就会静默放行。
```

正例二 —— 续聊轮 `model_type:null` 的网页语义（`lib/browser-driver.js:1131-1133`）：

```js
        // 续聊消息（同会话第 2 条起）网页只发 model_type:null——语义是「沿用会话
        // 模型」，新会话首条已核验过，故 model_type 缺失/为 null 时跳过该项；其余
        // 期望键（unified 的 thinking_enabled）必须出现且相等，不允许静默降级。
```

正例三 —— 报错自带现场，省一次抓包（`lib/browser-driver.js:1154-1156`）：

```js
        // 带上流首段原文：整流零响应帧时，「网页 200 包错误 JSON（风控/审核）」
        // 和「流形态对不上」在报错文本里一眼可分，不用再开 SSE_DEBUG 抓包。
        const head = lastFinished?.rawHead ? ' | 流首段: ' + String(lastFinished.rawHead).slice(0, 200) : '';
```

正例四 —— 解码器对不上时抓真实流（`lib/browser-driver.js:458-459`）：

```js
    // SSE 原始帧抓包（WEBCODE_SSE_DEBUG=<dir> 时启用）：新站点解码器对不上时，
    // 用真实流写解码器的第一手证据，而不是猜。
```

正例五 —— Windows 单实例锁残留（`lib/browser-driver.js:592-595`）：

```js
  /** 持久 profile 的 Chromium 单实例锁文件。浏览器被强杀 / 上次启动中途失败时
   *  这些文件会留下来，下一次 launchPersistentContext 直接抛
   *  「ProcessSingleton」类错误——表现为「退出过一次之后不管哪里都无法登录」。
   *  只有在本次进程确认没有活着的 ctx 时才清理（有 ctx 说明锁是真被持有的）。 */
```

正例六 —— 沙箱导致的运行方式差异（`PLAN-0.14.0-HANDOFF.md:35-36`）：

```md
- `npm test`（`node --test "test/*.test.mjs"`）在本会话沙箱下 `spawn EPERM`
  → 改为**逐文件** `node test/<file>.mjs`。
```

---

## 3. 禁止的写法

### 3.1 同义反复

反例（**构造示例**）：

```js
// 设置模型
await selectModel(model);
```

正例参照 `lib/browser-driver.js:1263-1273`：同一个「选模型」，注释写的是**旧实现为什么会静默空操作**。

### 3.2 复述参数名

反例（**构造示例**）：

```js
/** @param gapMs 间隔毫秒数 @param now 当前时间 */
```

正例参照 `lib/metrics.js:59-66`：参数表里写的是**语义与用途**——「上一次向该站点**发出**的
epoch 毫秒」「显式传入，便于单测钉死」「skewed 落盘时间在未来（时钟回拨/跨机拷贝）——
调用方应 warn 一行」。

### 3.3 过时的注释（与代码不符）

这是本仓库最需要警惕的一类：搬迁、改名、重写之后留下的「孤儿注释」。

反例（真实，`lib/web-control.js:78`）—— 该行注释紧贴在 `createWebControl` 之前，
描述的却是另一个函数；真正的 CORS 实现在 `lib/web-control.js:95-100` 另有注释：

```js
/** Fixed CORS headers for the relay fallback mount (OpenAI-front parity). */


export function createWebControl(deps = {}) {
```

改写或移动代码时，**顺手删掉被搬走的那份注释**；发现孤儿注释，宁可删掉也不要留着误导。

### 3.4 把「是什么」写成一大段

反例（**构造示例**）：

```js
// 这是一个用于处理消息的函数，它接收 messages 参数，然后遍历 messages，
// 对每一条消息进行判断，如果是用户的就取文本，如果不是用户就跳过，
// 最后返回一个结果数组给调用方使用。
```

这段话说的是读者已经能从代码里看到的事，还会随代码演进而过期。要写就写**边界条件**
与**为什么这样分派**，例如 `lib/index.js:97-107` 用一小段说明「三类来源分别是什么、
为什么 durable 是首要路径」。

### 3.5 无信息量的 TODO

本仓库 `lib/` 目录下没有 `TODO` / `FIXME` 字样（已核实），因此**暂无正例**。
反例（**构造示例**）：

```js
// TODO: 以后优化
// TODO: 这里可能有问题
```

必须写成**可验证的条件 + 可执行的下一步**，例如：

```js
// TODO(可验证)：providers.js 里 modelPicker 只有 3 个站点声明；
// 其余站点补齐后应删掉 selectModelGeneric 的 unverified 分支，
// 判据是 /__webcode/diagnostics 里不再出现 fallback:'unverified'。
```

### 3.6 用注释代替代码清晰性

反例（**构造示例**）：

```js
// 如果 a 为真并且 b 不为空且 c 大于 10 就返回 d，否则返回 e
return a && b && c > 10 ? d : e;
```

注释读起来像解释，实际是把代码翻译了一遍。正确做法是**把这段判断抽成有名字的函数**
（本仓库的做法见 `lib/metrics.js`：`computeSendGap`、`shouldSettleWip`、`estimateTokens`
都是「把判定抽成纯函数，再在函数头写为什么」）。

### 3.7 较弱的注释（本仓库内部对照）

以下注释本身不算错，但信息量明显低于本仓库的平均水准，可作为「下限」参考：

`lib/index.js:877`：

```js
  /** Valid minimal text chunk sequence. */
```

它只说明「这里是一组合法的块序列」。同类位置若由本规范来写，应补上**为什么是这个顺序**
（例如 `usage` 必须在 `finish` 之前、`block-end` 必须在 `finish` 之前）。

---

## 4. 格式约定

**语言分工（现状，不是新发明）**

- **中文**：业务语义、历史与根因、真机取证、取舍理由。见 `lib/index.js:1032-1035`、
  `lib/browser-driver.js:1121-1133`、`lib/web-control.js:41-46`。
- **英文**：对外接口、协议与宿主契约。见 `lib/index.js:1-8`（文件头）、
  `lib/index.js:270`（块协议通道）、`lib/web-control.js:1-17`（控制面文件头的安全立场）、
  `lib/index.js:415-420`（宿主适配器注册契约）。
- 两者混排是正常的：同一段英文契约旁常带中文的「我们为什么这么选」。

**块注释与行内注释的位置**

- 函数/常量级：`/** … */` 紧贴声明上方，第一行是一句话结论，空行后写「为什么」
  （范例：`lib/metrics.js:47-67`、`lib/browser-driver.js:513-530`）。
- 行内注释：放在**被解释的那一行**行尾，用于标记「为什么这里要提前返回/提前收场」。
  范例 `lib/metrics.js:108-110`：

```js
  if (!(now - Number(lastProgressAt) >= idle)) return false;   // 流还在动 → 绝不动
  if (!domAvailable) return true;                              // 页面不可用：退回仅流停判定
  return now - Number(lastDomGrowthAt) >= idle;                // 页面还在长 → 绝不动
```

- 分支内注释：写在分支体之前，说明「这个分支为什么存在」。范例
  `lib/index.js:1108-1112`（`WEB_SESSION_LOST` 分支）。

**TODO 的写法**

- 必须是 `TODO(可验证)：<条件> → <动作> → <判据>`，或写明具体阻塞点。
- 不允许出现「以后优化」「暂时这样」「回头再看」这类无法验收的表述。
- 本仓库当前没有任何 `TODO`/`FIXME`，这是可以保持的状态：**能当场说清的就不留 TODO**。

---

## 5. 注释里的数字必须可核对

**规则**：写进注释的每一个数字，都要能说清它是**从哪来的**——哪个接口、哪个字段、
哪个日志行。说不清来源的数字，不要写。

对照三条正例：

- 「10000ms 的间隔只剩 7609ms 可见」（`lib/metrics.js:54-55`）：注明来源为
  「真机 metrics 实测值」，且同文件给出对照口径（一轮跑了 20.9s）。
- 「recoveredTurns=1、lastRecovered.reason='stream_ended_before_finished'、
  status='WIP'、chars=463」（`lib/browser-driver.js:521-522`）：全部是
  `driver.status()` 上**可直接读到**的字段名与取值，读者能自己去 `/__webcode/status`
  核对。
- 「0.12.2 真机 goal 会话 turn2 step12 实锤」（`lib/browser-driver.js:477-478`）：
  定位到具体版本、具体会话与具体步骤，而不是「有时会失败」。

写法要求：

1. 数字后面跟来源：`（真机 metrics 实测值）`、`（driver.status() 的 lastRecovered.chars）`、
   `（`GET /__webcode/settings` 返回）`。
2. 不同口径的数字不要混在一句话里（例如「耗时」与「等待」必须分清，
   参见 `lib/metrics.js:54-56` 把 20.9s 与 7609ms 分成两项写）。
3. 引用**行号**要谨慎：`PLAN-0.14.0-HANDOFF.md:70-72` 里写的 `lib/index.js:968`
   与 `lib/index.js:1052-1055` 在当前文件里已经对不上（现为 `lib/index.js:1037` 与
   `lib/index.js:1121-1125`）。行号只在同一次改动内可靠，跨版本请改用**函数名/常量名**定位
   （`rememberSend`、`computeSendGap`、`webcode-send-state.json`）。

---

## 6. 给 AI 会话的注释要求

本仓库大量由 AI 会话修改，因此对会话额外约束如下：

1. **改动时保留原有取证注释**。带日期的取证注释（如「真机 2026-09-13 取证」）是历史资产，
   不是待清理的噪音。重写函数时把它一并搬过去；只有在你**用新证据推翻它**时才能改写，
   并且要写下新日期、新站点、新数字，说明旧结论为何不再成立。
2. **新增结论必须带日期与证据**。「网页是这样行为的」一律写成
   `真机 <YYYY-MM-DD> <站点/环境>：<现象>（<字段>=<值>）`，字段名要能在
   `/__webcode/status`、`/__webcode/diagnostics`、驱动 `status()` 或日志里查到。
   凭推断得出的结论，就明确标注为推断，不要伪装成取证。
3. **不要用注释复述 diff**。`// 新增：…`、`// 修改为…`、`// 修复了…` 对后来者没有价值——
   版本历史属于 git。注释只回答「为什么现在是这个样子」。
4. **删代码时连带处理它的注释**。函数被搬走、分支被删掉后，留在原地的注释会变成
   §3.3 那类孤儿（真实案例见 `lib/web-control.js:78`）。
5. **改到「不可越界」处，先读注释再动手**：`lib/agent-preset.js`（工具协议唯一定义处）、
   `lib/providers.js` 的 `MODEL_ALIAS_IDS`、`lib/web-control.js` 的 `routeIndex`、
   `lib/index.js` 的 `inject` 声明。这几处的注释就是修改边界本身。
6. **跑测试的方式也写进注释/文档**：`npm test` 在本机沙箱下会 `spawn EPERM`，
   需逐文件 `node test/<file>.mjs`（见 `PLAN-0.14.0-HANDOFF.md:35-36`）。
   会话之间传递这类环境事实，比传递「我试过了」有用得多。

---

## 7. 错误码规范（0.14.5）

本仓库的失败一律走**带错误码的 Error**，而不是返回 `null`/`false` 让调用方猜。
错误码是跨模块契约：解码器、驱动、relay、适配器、客户端都会读它。

### 7.1 命名

`大写下划线`，形如 `<阶段>_<故障>`：

| 错误码 | 含义 | 位置 |
| --- | --- | --- |
| `PROMPT_TRUNCATED` | 写入**之后**回读，网页只收了半截 | `lib/browser-driver.js` |
| `PROMPT_WRITE_STALLED` | 写入**期间**长度不再增长（0.14.5 新增） | `lib/browser-driver.js` |
| `CONTEXT_WINDOW_EXCEEDED` | 发送**之前**预算闸拦下 | `lib/metrics.js` + `lib/index.js` |
| `MODEL_UI_CHANGED` / `MODEL_UNAVAILABLE` | 模型选择契约失配 | `lib/browser-driver.js` |
| `WEB_SESSION_LOST` / `RATE_LIMITED` | 会话/限流 | `lib/browser-driver.js` |

**不要**用同义词造新码（例如已有 `PROMPT_TRUNCATED` 就不要再加 `PROMPT_TOO_LONG`）。
新增码之前先 grep 现有码表，语义确实不同才加。

### 7.2 必须携带的现场字段

一个错误码只回答「哪一类失败」，用户与事后排查需要的是**进度与现场**。因此新增
错误码时，`err.message` 里必须包含：

1. **已完成的进度**（`已写 20000/807789 字符`）——区分「一点没写进去」和「写了 97% 才停」；
2. **元素/页面现场**（`tagName`/`id`/`placeholder`/是否可见）；
3. **下一步可执行的动作**（`请先压缩上下文再重试`）。

反面教材是 0.14.4 及之前的 `locator.fill: Timeout 30000ms exceeded`——它把进度、现场、
出路全部丢掉，只剩一个超时数字，排查只能靠猜（这正是 `PROMPT_WRITE_STALLED` 的由来）。

### 7.3 面向用户的句式

面板上显示的失败文案统一为 **「名词 + 后果 + 下一步」**，不出现栈帧与英文内部码：

- ✔ `网页输入框只接收了 3/12 万字符（网页端长度上限）— 请缩短上下文或先压缩历史再重试`
- ✖ `Error: PROMPT_TRUNCATED at fillComposer (browser-driver.js:1204)`

错误码本身仍挂在 `err.code` 上供程序判定，两者不冲突。

---

## 8. 交付物与 present（0.14.5）

写完用户要拿到手的文件后，必须在最终答复**之前**调用 `present` 声明它们——只在正文里
写路径，用户看到的是点不动的纯文本。

### 8.1 一次最多 8 个文件

`present` 接受 **1 到 8** 个文件。超过 8 个时报 `present accepts 1 to 8 files`，
**整个调用失败**——不是部分成功。

真机证据（`session-c710ef6e` 的 `tool/result`，逐字）：

```
Error: present accepts 1 to 8 files
```

那一轮会话正是在**收尾的最后一步**撞上这条约束，随后又被 `locator.fill` 超时打断，
于是「交付物未声明」成了实际后果。

**做法**：交付物多于 8 个时，拆成多次 `present` 调用，每次 ≤8，按重要性分组
（例如「源码改动」一组、「文档」一组）。不要为了凑进 8 个而漏报真实交付物。

### 8.2 声明什么、不声明什么

- **声明**：新建/修改的源码、脚本、配置、文档、报告，以及代码生成的产物。
- **不声明**：只读来当参考的文件、临时中间文件（`.tmp/` 下的探针）、用户没要的输出。
- 路径必须**真实存在**；文件不存在就不要声明（那只会给出一个打不开的面板）。

---

## 9. 实验与取证纪律（0.14.8）

**为什么有这一节**：提示词/适配分支的任何改动，一旦被当成"我试了感觉更好"，
就会让整个项目失去可信度。本节把 **实验规则** 与 **报告模板** 固定下来，
使结论可复核、可反驳——这也是用户在 2026-09-14 明确要求的
「用同一基准性能测试问题」「找别人测评的提示词先拉取参考，然后找差评」。

依据：`doc/research/prompt-engineering-evidence-2026-09-14.md`（五篇文献的逐字结论）。

### 9.1 五条硬规则

1. **不做模型自评。** 判据必须是**机器可判**的（调用序列、参数值、收尾方式、
   协议残片、正文字数）。依据：arXiv 2502.06065 —— LLM 对提示词变体的自评不可靠，
   语义等价的改写会造成大幅波动，因此"让模型说哪个 prompt 更好"不构成证据。
2. **只做配对比较，不宣称最优。** 同一个 harness、同一批 case、同一组判据下比
   `default` 与候选变体。依据：NeurIPS 2024「On the Worst Prompt Performance of
   LLMs」——最差的 prompt 无法提前识别，既有技巧平均提升有限。
3. **样本量小就明说不足。** `summarizeRuns` 的 `disclosure` 块必须**原文**进报告；
   `significant` 在样本 ≤3 时只能是 `false`。**禁止**任何百分比提升字段
   （`lift` / `improvement` / `deltapercent` / `提升百分比`）。
4. **必须披露 harness。** 报告必须写明：站点、模型 id、工具清单、首轮提示词字符数、
   是否离线回放、以及"结论只在当前 harness 下成立"。依据：arXiv 2605.23950 ——
   不披露 harness 的评测结论不可迁移。
5. **默认离线。** `--live` 必须显式批准，且串行、每变体 ≤3 次、间隔 ≥20s
   （风控纪律，见 `lib/browser-dev` 相关的站点探针约束）。离线回放用构造的 chunk 流，
   不联网、不碰真机、不启动浏览器。

### 9.2 报告模板（`test-mock/prompt-bench.mjs` 产出）

```markdown
# 提示词基准报告（离线回放）
- 生成时间 / 用例集路径 / 变体来源
## 披露（summarizeRuns 的 disclosure 原文）
<原样粘贴，不得改写、不得只留摘要>
## 逐用例结果
| case | 变体 | 通过 | 失败类别（failureKinds） |
## 结论
- 只写"某变体在本 harness 下未出现某类失败"，不写"更好/最优"
- 样本量不足时明写"不足以判断"
```

**失败必须按 `failureKinds`（稳定机器码）分桶，不按文案分桶**——同一问题的两种措辞
被算成两类会让报告系统性夸大问题种类数（该缺陷在 0.14.8 修过一次，见
`lib/bench.js` 的分类器注释）。

### 9.3 判据先于实现

写候选变体**之前**先定判据：一个用例的判据若无法机器判定（例如"看起来对"），
它就不该进 `cases.json`。`test-mock/prompt-bench/cases.json` 里任何
`expect*` 字段若不在 `judgeRun` 支持的 7 条之内，必须有测试失败——否则未知字段
被静默忽略，等于假判据。

**"harness 永远通过"是必须排除的失效模式**：负向用例
（`test-mock/prompt-bench/negative-control/cases.json`）断言 harness 报失败且
**退出码非 0**，这是判据层有效的证据。

---

## 10. 注释与文档是能力放大器（0.14.8）

**为什么有这一节**：用户原话「规范代码注释/文档放在-**为了增强能力**」。
这不是文风偏好——本项目的注释承担的是**可执行的记忆**：把一次真机踩坑的
根因、证据、以及"为什么不能改回去"钉在代码旁边，让下一轮（人或 agent）
不必重新推导。删掉这类注释，等于删掉能力。

### 10.1 三条要求

1. **写"为什么"，不写"是什么"。** `// 把 x 加 1` 没有价值；有价值的是
   "这里必须用 `>=` 而不是 `>`，因为真机第 0 个调用缺参数时 `findProtocolStart`
   返回 `{index:-1}`，用 `>` 会漏判"。代码本身已经说明"是什么"。
2. **每条判断必须带可核对的证据。** 引用**具体**的会话 id / 提交 / 实测命令 /
   文件行号。写"实测发现"而不写是哪次实测，等于要求读者重新做一遍。
   本项目已有的正例：`lib/bench.js` 把 OOM 事故的读数（约 4GB 堆耗尽、669849ms）
   **逐字写进注释本身**——而不是指向 `bench-out.txt`；`lib/browser-driver.js` 把
   「每轮新开对话」的诊断**做成 `status().navTrace` 这个可读字段**——而不是指向
   一份叙述文档。

   > 2026-09-16 修正：本条原先举的两个「正例」恰恰都是**反例**。它们引用的
   > `package/dsh-webcode-bridge/bench-out.txt` 与 `doc/diagnosis-fresh-chat-per-turn.md`
   > **在仓库里都不存在**（前者按裁决不入库，后者已按用户指示删除）。
   > 这正落在本节第 3 条要防的那件事上，而且是在**讲解这条规则的那一段**里发生的。
   > 教训：**「指向别处的证据」会随那次清理一起失效**；把读数本身写进注释、
   > 或做成可读字段，才是不依赖外部文件的证据形态。

3. **失效的注释必须改或删。** 注释承诺了一个不存在的调用方/分支，会比没有注释更糟
   ——读者会据此做出错误判断。0.14.8 修过一例：`lib/prompt-variants.js:108` 曾写
   "前端据此把它们与生产分支分开渲染"，但客户端从未有过该分支；已改为如实描述
   "实验变体只供基准实验显式拉取，不接进 GUI 下拉"。
   0.15.x 又修过一例：`lib/browser-driver.js` 两处指向已删诊断文档的注释。

### 10.2 反面清单（本项目踩过的）

| 反模式 | 本项目的实例 | 代价 |
| --- | --- | --- |
| 注释描述的实现已不存在 | `prompt-variants.js:108` | 误导读者以为有渲染分支 |
| 注释里的数字与代码不符 | 多处 §引用指向不存在的章节 | 文档失去索引价值 |
| 只写结论不写证据 | —— | 下一轮无法判断该不该改回去 |
| 中文注释里混用半角标点致截断 | `lib/bench.js` 分类器曾按 `[：:]` 切分、且对中文做 24 字符硬截断 | 同一失败被算成两类，且键被切在词中间 |

### 10.3 文档与索引

- 新增文档必须进 `doc/README.md` 的索引，且**链接要能 `Test-Path` 通过**——
  指向不存在文件的索引等同于没有索引。
- 被代码引用的文档（如 `doc/diagnosis-*.md`）必须在索引里可查，否则
  "看注释去查"这条路径是断的。
- 文档自述其**口径来源**（官方文档给链接、本机实测给命令），
  这样读者能自行复核而不是只能相信。
