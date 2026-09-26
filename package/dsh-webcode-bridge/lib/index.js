// index.js — dsh-webcode-bridge · Host half (profile bundle, real Node).
//
// Registers a "Web AI (webcode)" LLM provider in the DSH model selector and
// runs the local relay (WS for the consent-gated browser extension + an
// OpenAI-compatible HTTP front for verification and reuse).
//
// Native DSH capabilities are untouched: this plugin only ADDS an llm route
// and a local server; fs/shell/skills/MCP registries are never replaced.

import os from 'node:os';
import fs from 'node:fs';
import { DEEPSEEK, resolveWebModel, listAllModels, getSite, SITES, qualifyModelId, MODEL_ALIAS_IDS } from './providers.js';
import {
  DEFAULT_SLOT, parseAccountKey, formatAccountKey, formatModelId, normalizeAccounts, slotsForSite,
  slotProfileDir, accountLabel, sendGapForSlot,
} from './accounts.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRelay } from './relay.js';
import { createOpenAiFront } from './openai.js';
import { createBrowserDriver } from './browser-driver.js';
import { zeroProgressDecision } from './zero-progress.js';
import { idleWindowDecision } from './idle-window.js';
import { createWebControl, buildSessionEvents, mainLineOf } from './web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply, findProtocolStart, stripProtocolText, stripProtocolRegions, proseSafeEnd, readCallAt, partialProtocolAt, unresolvedCallFenceAt, closingFenceAfter, headlessCallTailAt, coerceArguments, fillMissingRequired, trainNoteFor, normalizeOfficialToolCalls, normCallArgs, inferToolNameFromArgs, recoverUnparsedCalls, officialToolCallSpecimen, officialCallExampleFor, buildPreset } from './agent-preset.js';
// 只用 `teachFor`（1146 的续跑重申、3290 的首轮落盘）——那两处是**真调用**，
// 即计划 Task 1.4 所说的「教学提示按 teachShape 选支」。
// `transportShapeForSite` 曾一并 import 但全文件零调用（第三轮自审发现），已移除；
// 它仍是 tool-transport.js 的公开导出，被 tool-parser.js 与 tool-transport.test.mjs 用。
import { teachFor } from './tool-transport.js';
// 展示文案（自动续跑进度说明）单独一个文件：它只在「外发」这一层有约束
// （协议安全 / 不许静默降级 / 与事实一致），而这三条都需要独立护栏——
// `apply()` 是巨大闭包，里面的 helper 无法被测试单独 import。见 lib/notices.js。
import { autoContinuedNotice } from './notices.js';
// 图片请求计价：**不是可选装饰，是压缩路径的硬契约**。DSH 运行时用
// `adapters.get(p)?.adapter.imageRequestPricing(p, m)` 取它——可选链护不住方法本身，
// 缺了它 token meter 的每次测量都抛 `is not a function`，手动 /compact 必炸。
// 三条占位文案的同源约束与已知边界见该文件头。
import { webcodeImageRequestPricing } from './image-pricing.js';
// 自动续跑的整会话累计与形态切换（0.19.3，用户指令「加整会话累计」）：
// 判据的唯一来源是 continueFormFor；计数落盘失败静默，绝不影响回合交付。
import { createContinueCounter, continueFormFor, DEFAULT_CONTINUE_COMPLETE_AFTER } from './continue-budget.js';
// 注意（0.17.3）：这里**不再** import `tool-parser.js`。它是一层对 `parseAgentReply`
// 的纯委托薄壳，本文件已经直接用 agent-preset 的解析器 + 自己的流式状态机，接上它
// 只会多一跳而行为逐字不变。原先那行 import 是**死的**（全文件零调用），而
// tool-parser.js 的头注却写着「已正式接线」——两者都是假话，第三轮自审发现后按本项目
// 纪律改回事实。该模块仍被单测引用，去留见计划 Task 1.4。
import { appendReplyLog } from './reply-log.js';
import { contractFingerprintOf, reanchorSent, messageHash, ANCHOR_LEN } from './session-anchor.js';
import { writePromptFiles, readPromptFile, sitePromptPath, sessionPromptPath, DEFAULT_PROMPT_STORE_DIR } from './prompt-store.js';

/**
 * 提示词落盘的根目录（与 prompt-store.writePromptFiles 同一套解析）。
 * 'off' = 用户显式关闭落盘；此时读也一并关闭（不留半个开关）。
 */
function promptStoreDirFor() {
  const requested = process.env.WEBCODE_PROMPT_STORE_DIR;
  if (requested === 'off') return null;
  return requested || DEFAULT_PROMPT_STORE_DIR;
}

/**
 * 读回某会话落盘的上下文正本（0.16.29 文件投递）。
 *
 * 测试进程（node --test）在无显式目录时不读真实 ~/.dsh/webcode/——与写入端
 * （prompt-store 的 NODE_TEST_CONTEXT 守卫）严格对称：只写不读或只读不写
 * 都会让「落盘即投递源」这句话在某一条通道上变成空头承诺。
 */
function readSessionPrompt(sessionKey) {
  if (!sessionKey) return null;
  const dir = promptStoreDirFor();
  if (!dir) return null;
  if (!process.env.WEBCODE_PROMPT_STORE_DIR && process.env.NODE_TEST_CONTEXT) return null;
  return readPromptFile(sessionPromptPath(dir, sessionKey));
}
import { createMirror } from './mirror.js';
import { httpFetch } from './upstream.js';
import { textOfBlocks } from './flatten.js';
// 真实花名册（0.15.0）。**这行曾经漏掉过**：下面的 `rosterOf` 注入点照样写着
// `projectRoster(ctx, sessionId)`，而它是箭头函数体、创建时不求值 —— 于是模块能加载、
// 全量单测全绿，只有真机 `/__webcode/status` 真的调用时才抛 ReferenceError，
// 被 web-control 的 try/catch 降级成 `subAgentsError: "roster-threw: projectRoster is not defined"`，
// 面板永久空白（与 0.14.9「写死空数组」的可见后果一致）。
// 护栏：test/wiring-roster.test.mjs 走真实 apply() → HTTP → /status 钉住整条路径。
// workspaceRootOf 供控制面解析任务台账的存储根：与 projectTasks 内部的 cwdOf
// 是**同一个函数**，两侧因此不可能对「工作目录是什么」有第二种判据。
import { projectRoster, workspaceRootOf } from './roster.js';
import { estimateTokens, computeSendGap, checkContextBudget } from './metrics.js';
import { accumulateWait, sanitizeWaitStats, emptyWaitStats, composerWaitLine, waitStatRows, formatDuration } from './wait-stats.js';
import { renderSettingsPage } from './settings-page.js';
import { renderComparisonView } from './comparison-view.js';

export const name = 'webcode-bridge';

// cordis service injection: declaring these is REQUIRED before ctx.webServer /
// ctx.llm property access is permitted ("cannot get property ... without inject").
//
// 0.15.5（P2-1）：把 roster.js 真正依赖的服务**显式声明**出来。
// 旧实现只有 llm/webServer，其余全靠 roster.js 的 serviceOf() 用 ctx.get 兜底——
// 那条兜底路径是必要的（cordis 版本差异下取法不稳），但**不能是唯一**路径：
// 未声明时取属性会抛，兜底一旦失效，整块花名册会静默消失。
//
// 服务名逐个核实过注册点，不是凭印象写的（本轮实测）：
//   agents               ← dsh-agent/lib/index.js:299            super(ctx,'agents')
//   sessions             ← dsh-session/lib/index.js:1315          super(ctx,'sessions')
//   sessionProjections   ← dsh-session-projection/lib/index.js:52 super(ctx,'sessionProjections')
//   subagents            ← dsh-subagent/lib/index.js:2853         super(ctx,'subagents')
//
// **故意不加 `agentTeams`**：它由实验包 `@deepseek-ai/dsh-experimental-agent-team` 提供，
// 是否挂载取决于 profile 组合。把它写进 inject 会让整个插件在未挂载该实验包的
// profile 上卡在 waiting——症状是「桥整个不见了」，比花名册少一块严重得多。
// 它继续走 serviceOf 的可选读取 + 独立降级（teamError 如实说明原因）。
//
//
// **webServer 不在这个列表里**（0.16.5，真机 2026-09-18）。它只有 web 应用提供；
// 写进 inject 会让没有 webServer 的 profile（headless）整条 entry pending——
// 真机复现：`dsh --profile headless "回复两个字：收到"` →
// `webcode-bridge: pending (waiting for service: webServer)`，退出 1。
// 而「无外部干扰长跑」正要用 headless 这类没有 webServer 的 profile 驱动，
// 所以它必须是**可选**依赖：路由挂载改走 apply() 里的嵌套 ctx.inject(['webServer'], …)。
// 同一份纪律也适用于 agentTeams（见下）。
// 兜底路径保留：serviceOf 仍同时试 ctx[name] 与 ctx.get(name)。
export const inject = ['llm', 'agents', 'sessions', 'sessionProjections', 'subagents'];

/**
 * 哪些失败码才有资格**作废发送游标**（`sessionState.delete(keyPath)`）。
 *
 * 判据（0.16.4，真机事故 2026-09-17 20:52 / 会话 `session-063b0a99`）：**失败发生在
 * 「内容已经发出去之后」的一律不作废**。那一轮的四十几万字符已经在网页会话里了，
 * 重发整段不但救不回来，还会（a）把上下文顶爆、（b）经 `fresh:true` 把这一轮送进
 * 一个**新建的**网页对话——用户看到的就是「明明上下文没到，却一直新开对话」。
 * 反过来，只有「网页侧那段前文**确定不在/不可用**」时，重放整段才是唯一正确的恢复
 *（见 executor 里 WEB_SESSION_LOST 分支的注释）。
 *
 * 因此这是一张**白名单**：不在表里的码（含将来新加的码）默认**保留**游标。
 * 默认安全侧选「保留」而不是「作废」的理由是代价不对称——错误地保留游标，最坏是
 * 下一轮把一个增量发进一个已知有前文的网页会话（可恢复）；错误地作废游标，是每一轮
 * 都重发四十万字符并新开一个对话（用户报的那条症状本身）。
 *
 * 行为级实测（guards 的脚本驱动、同一 apply 实例三轮）：修前 fresh 序列
 * `[true,false,true]`、第三轮 messageChars=150,072；修后第三轮 `fresh=false` 且只有
 * 增量（护栏 test/session-continuity.test.mjs ④ 钉住这条红基线）。
 *
 * **0.16.6 起 `WEB_SESSION_REBUILD_THROTTLED` 不在这张表里**：节流不再抛错——它现在由
 * executor 直接收场成一条「网页会话已切换」的提示（见 `sessionSwitchedNotice`），
 * 而「这一轮正文没有进网页会话、游标不许前进」改由同一条链路里的
 * `cededCursorKeys` 标记保证。留着这一格就是一条永不命中的孤儿规则：它描述的抛错
 * 路径已经不存在（doc/comment-style.md §3.3）。
 */
export const CURSOR_INVALIDATING_CODES = Object.freeze(new Set([
  'WEB_SESSION_LOST',              // 槽里的网页会话已删/过期/被风控拦：前文确实没了
  'NEED_LOGIN',                    // 未登录：这一轮根本没进网页会话
  'MODEL_UI_CHANGED',              // 网页模型契约失配：这一轮的请求元数据都不可信
]));

const DEFAULTS = {
  port: 8931,
  host: '127.0.0.1',
  providerId: 'webcode',
  displayName: 'Harness Web Bridge',
  modelId: 'deepseek-web',
  modelName: 'DeepSeek Web (网页版)',
  settingsNs: 'webcode',
  requireConsent: true,
  requestTimeoutMs: 240_000,
  // 「只出思维链、永远不出正文」的绝对上限（0.15.2）。与 requestTimeoutMs 的分工：
  // 那个是**整轮**（含正常的长思考 + 长正文）的总兜底，240s 到点时用户已经干等
  // 四分钟且报错看不出原因；这个从**最后一次正文/图片**起算，专抓「思考完就没下文」。
  //
  // 为什么必须在这里也列一份：driver 自己有同名默认值（180_000），但**默认值
  // 只有被显式传进去才生效**。最初只加了 driver 那一侧，index.js 既没在 DEFAULTS
  // 声明、也没在 createBrowserDriver 时传 —— 结果是「可配置」只对了一半：
  // 行为正确（driver 内部默认值恰好就是 180s），但配置层完全够不着它，
  // 任何人想调这个值都会发现自己改的东西没有任何效果。这正是「静默不生效」那一类
  // 缺陷，所以两处都要有，且注释写明原因。
  answerTimeoutMs: 180_000,
  // 捕获链中断兜底的静默阈值（0.19.12）。真机事故（2026-09-24，session-12d9c3c6）：
  // 首事件已到后「页面 SSE → 页内捕获 → 解码器」中断，页面把回复写完（DOM 1072 字）
  // 而桥侧 120s 零事件，WIP 稳态收束因 bodyReady 不成立救不了，最后看门狗开火、
  // 内容整轮丢失。驱动现在会在流静默这么久且页面仍在写/写过了本轮内容时，把页面
  // DOM 文本当 partial 结果兜底交回（判据见 metrics.shouldRescueStalledCapture，
  // 接线在 browser-driver startWipWatch，护栏 test/capture-stall-rescue.test.mjs）。
  //
  // 上限约束：**必须 < idleTimeoutMs（默认 120s）**，否则适配器看门狗先开火、
  // 兜底永远轮不到——判据层不强制这条（纯函数不读别家配置），调大的人自己承担。
  // 0 = 显式关闭。同 answerTimeoutMs 的教训：必须在此声明并显式传入 driver，
  // 否则「可配置」只对了一半，用户改了没有任何效果。
  captureStallRescueMs: 45_000,
  // 「网页还没开口」相位的窗口倍数（0.16.3，真机事故的修法）。
  //
  // 起因：2026-09-17 真机，DSH 会话把 **127,888 字符**纯文本发进 DeepSeek 网页
  // （POST /__webcode/history 的 user 消息：工具教学 38,279 + 会话 transcript
  // 89,609），那一轮 step5 从 18:41:59 到 18:43:51 **跨度 112 秒零事件**，适配器侧
  // 120s 看门狗开火报 WEB_NO_PROGRESS；而同一轮 step1-4 每步都有事件（工具调用
  // 2-4 条）⇒ 捕获链是活的，网页只是在 prefill 那 12.8 万字符的输入。用户看到的
  // 就是「web 明明有回复，桥说没内容」。
  //
  // 倍数**只作用于**「本轮还没有任何事件」且「驱动 status().busy === true」这一格；
  // 已经开流后的静默、以及驱动不在忙（链路根本没跑起来）一律按 IDLE_TIMEOUT_MS
  // 照旧快报——那两种情况下拖长窗口只会让真正的故障更晚暴露。判据抽成纯函数
  // lib/idle-window.js（可离线反向验证），接线在 nextWithIdle()，护栏见
  // test/watchdog-first-byte.test.mjs。
  //
  // 非法值（<=0/NaN/非数字）由 idleWindowDecision 回落成 1（= 不做任何放宽）；
  // 这里**不重复 clamp**——同一个判据写两份必然漂移（本文件 78-82 行那类
  // 「配置看起来存在、行为却够不着」的缺陷就是这么来的）。
  //
  // 必须在这里也列一份：driver/适配器侧的默认值只有**被显式传进去**才生效，
  // 不声明的话「可配」只对了一半（同 answerTimeoutMs 的教训，见上方注释）。
  idleFirstByteMultiplier: 2,
  // 写入 composer 的单块字符上限（0.14.5）。超长提示词一次性交给 Playwright
  // 的 fill() 会在网页侧整段卡住并以 30s 超时收尾，且没有任何中间态可诊断；
  // 分块写入 + 块间回读长度让失败更早、且带得出已写进度（PROMPT_WRITE_STALLED）。
  composerChunkChars: 20_000,
  // 超过这个字符数就把提示词改为**附件**投递。**默认 60_000（0.16.3 起启用）**。
  //
  // ## 为什么 0.16.2 默认关、0.16.3 改成 60_000
  //
  // 0.16.2 的立场是「没有真机配对数据之前不改默认行为」。0.16.3 有了那次真机事故的
  // 完整读数，立场随之改变：
  //   · 事故会话 `session-dff3edf7` 的 turn1 step5，发进网页的是 **127,888 字符**
  //     纯文本（POST /__webcode/history 的 user 消息读数：工具教学 38,279 + 会话
  //     transcript 89,609），该步 18:41:59→18:43:51 **112 秒零事件**，
  //     被适配器侧 120s 看门狗判死 —— 而网页那侧仍在生成（用户看到的就是
  //     「web 明明有回复、桥说没内容」）；
  //   · 纯文本投递另有两次已发生的真机事故：PROMPT_WRITE_STALLED（写入停滞）与
  //     PROMPT_TRUNCATED（网页只收了半截，模型照常作答）。
  // 真机最大一轮是 409,555 字符（GET /__webcode/preset），60,000 这个阈值正好把
  // 「一轮塞进几万字符的 transcript」挡在纯文本路径之外，而**普通单轮增量
  // （几十~几千字符）仍然逐字走 inline**，行为不变。
  //
  // ## 风险与回落（每一层都有护栏）
  //
  // 附件投递是有副作用的动作（上传、可能撞站点风控、模型未必读附件），因此：
  //   · 页面没有上传入口 → `ATTACH_UNAVAILABLE`，回落 inline；
  //   · 附件未在页面上确认出现 → `ATTACH_NOT_CONFIRMED`，回落 inline；
  //   · 上传成功但模型没读 → composer 正文明确要求「先读取该附件全文」，
  //     且**下一轮会把新的增量照常 inline 发出**，不会长期断上下文；
  //   · 实际走了哪条路 → 落进 driver status 的 `attachTransport`（/status 可核对）。
  // **0 = 关闭**的语义保留：想完全回到旧行为就显式写 0。判据见 promptTransportPlan。
  //
  // 0.19.11：**这个 60,000 只是「全站默认」，站点可以更严**（只收紧、不开启）。
  // 真机病因（用户原话「明明在附件投递模式下，看的还是完整上下文」）：deepseek 的
  // 典型首轮实测 48,937 / 53,797 字符，**都在这条默认线以下** ⇒ under-limit ⇒
  // 全文逐字灌进输入框 —— 越典型的会话越走 inline。现在 deepseek 走
  // browser-driver 的 SITE_ATTACH_INLINE_LIMIT（8,000），已真机复验：50,219 字符
  // 首轮落到附件、完成请求 ref_file_ids 非空、对话框只渲染 82 字符。
  // 配置成 0 仍然一律 inline（站点表绝不把附件重新打开）。
  attachInlineLimitChars: 60_000,
  // 长字符串里**未转义引号**的可选修复（0.19.11，**默认关**）。
  //
  // 为什么默认关：修它必须猜「这枚 `"` 是字符串结束还是内容里的字面引号」，而 0.16.25
  // 的红线写着「宁可拒收 + 续跑，也不静默代拼参数」。默认关时行为与 0.19.10 逐字相同，
  // 真机那 10 条长文本哑火照旧走「拒收 + 诊断 + UNPARSED 续跑」。
  //
  // 开启后也只接受**能完整 parse 成一个对象**的结果（修不出合法对象 = 没修，照旧拒收），
  // 判据见 agent-preset 的 repairUnescapedQuotesInJsonStrings。
  jsonQuoteRepair: false,
  // 提示词**投递形态**（0.16.3）：'attach'（默认）| 'inline'。
  //
  // 为什么需要这个开关（用户原话：「没有做到能够把提示词放入文本（设置界面也改为
  // 打开文本）」）：超长正文改走附件是一条**有副作用**的路径——触发一次真实上传，
  // 可能撞站点风控，模型也未必读附件。用户必须能在设置面把这条路整条关掉、
  // 逐字回到旧行为（40 万字符纯文本灌输入框），而不是只能改源码或删配置。
  //
  // 语义边界（两个方向都写清楚，避免下一个人理解成别的意思）：
  //   · 'attach' —— 不强制任何方向；是否真的走附件仍由 attachInlineLimitChars
  //     与页面是否有上传入口决定（判定层只有 promptTransportPlan 一处）。
  //   · 'inline' —— **永远纯文本**，不看阈值、不看入口，即 0.16.1 的行为。
  // 非法值一律按 'attach'（见 browser-driver 的 promptTransportNow）。
  //
  // 必须在这里也列一份：driver 侧的默认值只有**被显式传进去**才生效，不声明的话
  // 「可配」只对了一半（同 answerTimeoutMs 的教训，见上方注释）。两个
  // createBrowserDriver 调用点都要传读取函数，否则「设置页改了、行为没变」。
  promptTransport: 'attach',
  // 附件投递的**尺寸上限**（0.16.3，PLAN-2026-09-17-0.16.3 §3.2，默认 1_500_000）。
  // 超过就不上传：超长附件塞给网页同样会撞风控/渲染，改为保留尾部截断后再上传
  // （尾部才是当下要执行的内容），并在文件开头写明「已省略前 N 字符」，绝不静默丢内容。
  // 真机读到的最大一轮是 409,555 字符（GET /__webcode/preset），离这个上限还很远，
  // 因此这条是护栏而非常规路径。判据与截断动作见 browser-driver 的 promptTransportPlan。
  attachMaxChars: 1_500_000,
  // 排队上限必须显著大于单轮上限：网页一次只跑一轮，并行子代理会排队；
  // 旧值 300s 只比单轮 240s 多 60s，排在第二位的请求几乎必然「刚开始跑就超时」，
  // 长任务里的并行分支会成片失败。900s 足够跨过 2-3 轮排队。
  queueTimeoutMs: 900_000,
  // 登录（有头 Edge 人工登录）的等待上限。控制面 POST login 会等到这一步结束
  // 才回结果，所以这里必须比驱动自身的浏览器启动留出余量。
  loginTimeoutMs: 300_000,
  // ---- 并发（0.19.4，用户指令）-----------------------------------------------
  // 原话：「已有使用账号不允许同时再使用！！一个网址可以多个账号，多个对话！但是必须
  // 每个对于唯一账号！……不能同时发过多请求，错峰！但是不是让你只留一个协议进行转接；
  // 还是多账户并发多会话那样需要真实多个转接！」
  //
  // 取值含义（执行器在 relay.js）：
  //   · 同一 accountKey 同时只允许一个在途请求，第二个在**它自己的通道**里排队；
  //   · 不同账号之间真并发，上限由此值控制（2 = 两个账号可以同时跑）；
  //   · 任何两次「发出」之间至少隔 minSendIntervalMs，避免同一站点被瞬间打出一串。
  // 默认 2 路 / 1s 是**保守起点**：网页端本就有风控，宁可先慢一点，也不要为了并发
  // 把账号跑进「消息发送过于频繁」。
  maxConcurrentLanes: 2,
  minSendIntervalMs: 1000,
  // 每个站点向 DSH 声明的上下文窗口。网页 composer 的真实上限未知，声明过大
  // 会让 DSH 的压缩永不触发（transcript 只增不减）；这里给保守值，越界时由
  // PROMPT_TRUNCATED 回读校验报错而不是静默截断。
  contextWindowBySite: { deepseek: 1_000_000 },
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile'),
  headless: true,
  contextMode: 'session', // 'session': one web conversation per DSH session, incremental turns
  // 解析失败自动续跑的轮数上限（0.16.25）。UNPARSED 收尾前把再教学提示**作为用户
  // 消息补发进同一个网页会话**并收第二轮回复——把真机里用户手动打「继续，注意
  // 工具调用」救活循环的动作自动化（session cd997dd3 11:21:26 / 11:22:51 两次逐字）。
  // 0 = 关闭（回落为「提示当正文」收场）；只认会话模式轮（无状态轮由调用方自己循环）。
  autoContinueRounds: 1,
  // 「整会话累计」的升级点 N（0.19.3，用户指令：「加"整会话累计"：超过 N 次就改为发
  // 完整提醒」「不能停！继续后续需要 auto！！我需要真实长上下文」）。
  //
  // 语义边界必须读准：**这不是刹车**。累计补发次数 > N 之后，续跑照旧进行，
  // 只是每一轮把协议段升级为**完整提醒**（该站点的完整教学：工具清单＋调用格式＋
  // 使用准则，取会话教学正本，与 prompts/<site>.md 逐字同源）。0 = 不升级
  // （永远短提示），不是「立即升级」——判据在 lib/continue-budget.js 的 continueFormFor。
  autoContinueCompleteAfter: DEFAULT_CONTINUE_COMPLETE_AFTER,
  // 「网页自己注入的那部分上下文」的固定开销（token）。用户指令：「要：每轮加一笔
  // 固定开销」，口径是**宁可高报也不低估**（同 usageFixedOverheadTokens 的兄弟项）。
  //
  // 它补的是一个已知缺口：桥报给 DSH 的 inputTokens 一直是「我发出去的文本」，
  // 而网页那一侧的上下文还包含它自己的系统提示、界面框架与站点前言——这些**永远
  // 不会经过桥**，于是读数系统性偏低。2048 是**明确标注的上界猜值**，不是实测：
  // 网页不公开它自己的系统提示，唯一能实测它的办法是读回网页会话做对账（见
  // doc/research/2026-09-23-longrun-rounds-3-4.md §3.6 的对账探针 D3）。
  //
  // 为什么按**一次性偏移**计入而不是每轮累加：网页自己的系统提示在上下文里只有
  // **一份**（每轮重新 prefill 不等于每轮多一份）。累加进累计值会重复计数，把压缩
  // 压力虚推上去；用户要的是「不低估」，不是「虚高」。
  usageFixedOverheadTokens: 2048,
  // 允许携带 Origin 的显式白名单（除「同源」之外的额外放行）。同源判定本身由
  // lib/loopback.js 的 originMatchesHost 完成，因此这里**只需列 DSH 前端自己的
  // 两个源**——右栏站点 iframe 是 <siteId>.localhost:<relay 端口>，它们与 relay
  // 同源（控制面相对路径 /__webcode/* 就落在那些源上），不靠白名单。
  // 旧注释里「白名单必须含 *.localhost:3080」是误判：DSH 前端不会被挂在子域上。
  allowedOrigins: ['http://127.0.0.1:3080', 'http://localhost:3080'],
};

/** 发送间隔（设置页「发送间隔」）：两次向同一站点**发送**之间的最小毫秒数。
 *  滑窗限流（「消息发送过于频繁」）的防护手段，也是 RATE_LIMITED 退避的基数。
 *
 *  0.14.0 语义修正：基准从「上一轮**结束**」改成「上一轮**发出**」（send-to-send），
 *  与设置页/文档一直以来的承诺一致（旧实现在长回复下会把等待吃掉——真机实测
 *  一轮跑 20918ms 时 10000ms 的间隔只剩 7609ms 可见）。判定逻辑收在
 *  metrics.computeSendGap（纯函数，可离线断言）。
 *  注意站点 id 白名单化：基准表会落盘，键名不可信来源只能是 SITES。 */
const SEND_GAP_MAX_MS = 600_000;
const clampSendGapMs = (v) => Math.min(SEND_GAP_MAX_MS, Math.max(0, Math.round(Number(v) || 0)));

// 模型目录 = 全部内容服务站点的模型（'site:model' 限定 id），DSH 模型选择器
// 直接可见 GLM/ChatGPT/Kimi/Qwen/豆包/Grok/Claude/Gemini 的模型。
const WEB_MODELS = listAllModels();

/** 正文流式时保留的「消歧尾巴」字符数：协议标记可能分片到达（<t → <tool_call>），
 *  最后 8 个字符先扣住不发，等下一个增量消歧；收尾时由 tail 补发。 */
const PROSE_TAIL_CHARS = 8;
const log = (...a) => console.log('[webcode-bridge]', ...a);
const warn = (...a) => console.warn('[webcode-bridge]', ...a);

/** 可中止的 sleep：等待期间 DSH 侧取消要立即退出，不能让用户干等退避。 */
function sleepSignal(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('webcode relay: aborted'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const IMAGE_DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

/**
 * 从 DSH 消息块里取出图片附件——覆盖 DSH 用到的**全部**形状。
 *
 * 三类来源，标成 tagged entry 交给 resolveImages 统一落成 base64：
 *   • `durable` — DSH 原生块 `{type:'image', attachment:ImageAttachmentRef}`。
 *     像素不在块里，必须经 attachments 服务读取。**这是 harness 截图/粘贴的
 *     唯一形态**，0.12.9 之前完全没被识别（见 resolveAttachments 注释）。
 *   • `inline`  — wire 形状的 data URL / source.data / base64（OpenAI 前端、
 *     旧会话回放）。data URL 就地解码，不落盘。
 *   • `remote`  — http(s) URL，由 resolveRemoteImages 抓取（≤8MB）。
 *
 * 认不出的一律**跳过而不是抛错**：这里是入口路径，一条畸形块不该让整轮失败。
 *
 * @param {Array} messages DSH 消息数组
 * @returns {Array<{name: string, contentType: string, kind: string, ref?: object, data?: string, url?: string}>}
 */
export function imagesOfMessages(messages) {
  const out = [];
  let idx = 0;
  const nextName = (name) => String(name || '').trim() || `image-${++idx}.png`;
  const push = (entry) => { out.push({ ...entry, name: nextName(entry.name) }); };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b) continue;
      // ① DSH 原生 durable 图片块（首要路径）。
      if (b.type === 'image' && b.attachment && typeof b.attachment === 'object') {
        push({ kind: 'durable', ref: b.attachment, name: b.name || b.attachment.name, contentType: b.attachment.mediaType });
        continue;
      }
      // ② 内联 / 远程 wire 形状（兼容路径，保持旧行为）。
      const url = b.url ?? b.imageUrl?.url ?? b.image_url?.url;
      if (typeof url === 'string') {
        const dm = IMAGE_DATA_URL.exec(url);
        if (dm) { push({ kind: 'inline', name: b.name, contentType: dm[1], data: dm[2] }); continue; }
        if (/^https:\/\//.test(url)) { push({ kind: 'remote', name: b.name, contentType: b.mediaType, url }); continue; }
      }
      const source = b.source;
      if (source?.data && typeof source.data === 'string' && source.data.length > 8) push({ kind: 'inline', name: b.name, contentType: source.mediaType, data: source.data });
      else if (typeof b.data === 'string' && b.data.length > 8) push({ kind: 'inline', name: b.name, contentType: b.mediaType, data: b.data });
      else if (typeof b.base64 === 'string' && b.base64.length > 8) push({ kind: 'inline', name: b.name, contentType: b.mediaType, data: b.base64 });
    }
  }
  return out;
}

// 请求侧图片预算：与 dsh-llm-deepseek 的 DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET /
// DEFAULT_REQUEST_IMAGE_MAX_BYTES 对齐，让桥取到的版本和原生 DeepSeek 路由同档。
const REQUEST_IMAGE_POLICY = Object.freeze({ maxPixels: 640_000, maxBytes: 1_048_576 });
// attachments 服务不可用时的兜底上限（直接读原始字节，不做 request 投影）。
const RAW_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function resolveRemoteImages(images) {
  const settled = await Promise.all(images.map(async (img) => {
    if (!img.url) return img;
    try {
      const resp = await fetch(img.url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;
      const type = resp.headers.get('content-type') || img.contentType;
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > RAW_IMAGE_MAX_BYTES) return null;
      return { ...img, contentType: type, data: buf.toString('base64') };
    } catch { return null; }
  }));
  return settled.filter(Boolean);
}

/**
 * 把 imagesOfMessages 的 tagged entry 落成驱动可直接上传的
 * `[{ name, contentType, data(base64) }]`。
 *
 * durable 路径按优先级降级，**每一档失败都记名不静默**：
 *   1. `readImageRequest(ref, policy)` — 宿主归一化 + 按预算投影后的请求版本
 *      （与原生 DeepSeek 路由同档；这是「传上去清晰且不超限」的正路）。
 *   2. `readImage(ref)` — 原始归一化字节（服务不支持 request 投影时）。
 *   3. 都失败 → 记进 skipped，返回给调用方明确报错，而不是让模型说「没看到图」。
 */
export async function resolveImages(images, attachments, signal) {
  const tagged = Array.isArray(images) ? images : [];
  if (!tagged.length) return { images: [], skipped: [] };
  const inline = tagged.filter((i) => i.kind === 'inline');
  const remote = tagged.filter((i) => i.kind === 'remote');
  const durable = tagged.filter((i) => i.kind === 'durable');
  const out = [...inline];
  const skipped = [];

  if (remote.length) out.push(...await resolveRemoteImages(remote));

  for (const entry of durable) {
    const ref = entry.ref;
    if (!attachments) {
      skipped.push({ name: entry.name, reason: '附件服务不可用（ctx.attachments 未挂载），无法读取原生图片块' });
      continue;
    }
    try {
      const version = await attachments.readImageRequest(ref, REQUEST_IMAGE_POLICY, signal);
      const buf = Buffer.from(version.data);
      if (!buf.length) throw new Error('request 版本为空');
      out.push({
        name: entry.name, contentType: version.mediaType || entry.contentType || 'image/png',
        data: buf.toString('base64'), width: version.width, height: version.height, source: 'attachment-request',
      });
      continue;
    } catch (err) {
      warn('readImageRequest failed, falling back to raw bytes:', err?.message);
    }
    try {
      const stored = await attachments.readImage(ref, signal);
      const buf = Buffer.from(stored.data);
      if (!buf.length) throw new Error('原始字节为空');
      if (buf.length > RAW_IMAGE_MAX_BYTES) throw new Error(`原始图片 ${buf.length} 字节超过 ${RAW_IMAGE_MAX_BYTES} 上限`);
      out.push({ name: entry.name, contentType: ref.mediaType || entry.contentType || 'image/png', data: buf.toString('base64'), source: 'attachment-raw' });
    } catch (err) {
      skipped.push({ name: entry.name, reason: String(err?.message || err) });
    }
  }
  return { images: out, skipped };
}

// Optional: resolve the LlmRuntime service class so ctx.get(Service) works too.
let llmServiceRef = null;
try { llmServiceRef = (await import('@deepseek-ai/dsh-llm')).LlmRuntime; } catch { /* optional peer */ }

/** Feature-detect the durable attachment store across cordis context shapes.
 *
 * DSH 的原生图片块长这样：`{ type:'image', attachment: ImageAttachmentRef }`
 *（证据：dsh-llm/lib/types/types.d.ts 的 ImageBlock、dsh-tool-fs 里构造 image
 * 块的那处）。`ImageAttachmentRef` 只带 attachmentId / mediaType / bytes /
 * width / height / name —— **没有任何内联字节**。真正的像素要经
 * `ctx.attachments.readImageRequest(ref, policy, signal)` 取。
 *
 * 0.12.9 之前这里根本没有解析 attachment store，imagesOfMessages 只认
 * wire 形状（url / image_url / source.data / base64），与原生块**零交集**，
 * 于是 harness 截图/粘贴的图每次都被静默丢弃——网页端自然说看不到图。 */
function resolveAttachments(ctx) {
  const usable = (s) => s && typeof s.readImageRequest === 'function' && typeof s.readImage === 'function';
  try { if (usable(ctx.attachments)) return ctx.attachments; } catch { /* next */ }
  try {
    const got = typeof ctx.get === 'function' ? ctx.get('attachments') : null;
    if (usable(got)) return got;
  } catch { /* next */ }
  return null;
}

/** Feature-detect the llm service across cordis context shapes. */
function resolveLlm(ctx) {
  try {
    const direct = ctx.llm;
    if (direct && typeof direct.registerAdapter === 'function') return direct;
  } catch {}
  try {
    const got = typeof ctx.get === 'function' ? ctx.get('llm') : null;
    if (got && typeof got.registerAdapter === 'function') return got;
  } catch {}
  try {
    const owned = llmServiceRef && typeof ctx.get === 'function' ? ctx.get(llmServiceRef) : null;
    if (owned && typeof owned.registerAdapter === 'function') return owned;
  } catch {}
  return null;
}

/** 适配器侧无进展看门狗抛出的错误：把「桥卡住了」变成一条带现场的明确报错。
 *  现场由调用方（apply 作用域，能拿到 driverFor）传进来——模块级函数不得直接
 *  引用 apply 内的绑定。这些字段正是判断「网页没生成」还是「捕获链死了」所需
 *  的最小信息，旧实现只把它们 warn 到宿主控制台。 */
function idleTimeoutError(timeoutMs, scene) {
  const stalled = scene?.lastStalledSettle;
  // 0.16.3：驱动侧的两段现场读数（见 browser-driver status()）。真机事故
  // （2026-09-17，step5 跨度 112s 零事件）里这两段**一起读**就能定性：
  //   · `最近驱动活动时间` 很新 ⇒ WIP 巡检器还在采到页面，链路是活的（不是捕获死了）；
  //   · `页面已有 N 字回复未回传` 不为零 ⇒ 正文早就写在页面 DOM 里了，缺的是回传。
  // 取不到的读数（null）**不出现**在文案里、也不补一个猜的值：把「网页在 prefill」
  // 与「链路死了」混成同一句话，正是这次事故绕远路的原因。
  const activity = typeof scene?.lastActivityAt === 'number'
    ? `，最近驱动活动时间 ${Math.max(0, Math.round((Date.now() - scene.lastActivityAt) / 1000))}s 前`
    : '';
  const pendingChars = typeof scene?.domReplyChars === 'number'
    ? `，页面已有 ${scene.domReplyChars} 字回复未回传`
    : '';
  // 相位必须写进报错：只说「超过 240s」读者不知道那是不是已经宽限过的窗口，
  // 也就分不清「网页还没开口」与「网页不说了」——这两者下一步完全不同。
  //
  // 0.19.23：`mid-stream` 必须**再分一次**。它同时是「开流后静默」与「没开流且
  // 驱动不忙」的返回相位，而旧文案把两者都印成「已开流后的静默」——后一种是
  // **假陈述**。真机 session-e7056e8c turn3 step58 的报错就是这一句，它紧挨着
  // 「最近驱动活动时间 1s 前」与「页面已有 0 字回复未回传」，三者并排读起来
  // 自相矛盾，排查方向当场被带偏。现在按 `firstEventSeen` 分开说。
  const phaseNote = scene?.phase === 'awaiting-first-byte'
    ? `，判定相位=网页还没开口（窗口已放宽到 ${Math.round(timeoutMs / 1000)}s`
      + `${scene.windowCapped === true ? '，且已被整轮预算压到 90% 以内' : ''}）`
    : scene?.phase === 'mid-stream'
      ? (scene.firstEventSeen === false
        // 没开流 + 驱动不忙：链路没跑起来，按常规窗口快报（这是安全侧的判定）。
        ? '，判定相位=网页还没开口且驱动不在忙（按常规窗口未宽限）'
        // 真·开流后静默。
        : '，判定相位=已开流后的静默')
      : '';
  // 收束原因必须**带时刻**（0.16.3）。真机 2026-09-17 18:43 的报错原文是
  // 「（页面在，本轮收束原因 finished）」——而那一轮根本没跑完，`finished` 是
  // **上一轮**写的。一个无标注的旧读数把「网页还在生成」读成了「网页已收束」，
  // 排查方向当场被带偏。这里按写入时刻把它标注成「上一轮的」并给出距今秒数。
  const endReason = (() => {
    if (!scene?.lastEndReason) return '';
    const at = typeof scene.lastEndReasonAt === 'number' ? scene.lastEndReasonAt : null;
    if (at == null) return `，最近一次收束原因 ${scene.lastEndReason}（写入时刻未知）`;
    const ageS = Math.max(0, Math.round((Date.now() - at) / 1000));
    // ≤5s 视为「刚刚这一轮」；超过就是上一轮遗留下来的读数。
    const label = ageS <= 5 ? '本轮收束原因' : `上一轮收束原因（${ageS}s 前）`;
    return `，${label} ${scene.lastEndReason}`;
  })();
  const hint = scene
    ? `（页面${scene.preview ? '在' : '不在'}${scene.lastRecovered ? `，最近一次部分流：${scene.lastRecovered.reason} ${scene.lastRecovered.chars} 字` : ''}`
      + `${stalled ? `，最近一次只出思维链：思考 ${stalled.thinkingChars} 字 / 正文 ${stalled.answerChars} 字（${stalled.reason}）` : ''}`
      + endReason
      + `${phaseNote}${activity}${pendingChars}）`
    : '';
  const err = new Error(`WEB_NO_PROGRESS: 网页侧超过 ${Math.round(timeoutMs / 1000)}s 没有任何新内容${hint} — 本轮已中止，可重试`);
  err.code = 'WEB_NO_PROGRESS';
  err.scene = scene;
  return err;
}

/** Small async channel so adapter.stream() can yield deltas as they arrive. */
function channel() {
  const buf = [];
  let wake = null;
  return {
    push(v) { buf.push(v); const w = wake; wake = null; w?.(); },
    async next() {
      if (buf.length === 0) await new Promise((r) => { wake = r; });
      return buf.shift();
    },
  };
}

/** One-line diagnostics per model call — makes auxiliary calls visible. */
function logCall(options) {
  try {
    const msgs = options.messages || [];
    const last = msgs[msgs.length - 1];
    log('call:', JSON.stringify({
      purpose: options.purpose ?? null,
      msgs: msgs.length,
      tools: (options.tools || []).length,
      model: options.model,
      // 命名走网页端标题（问题④）时要能按 sessionId 对上网页对话，日志里带上它
      // 才能事后核对「这次命名到底有没有接上网页端」。
      sessionId: options.sessionId ?? null,
    }));
  } catch {}
}

/**
 * Session-mode cursor: per DSH session, how much of the message history the
 * web conversation has already received. The first turn (or a divergence
 * reset) sends preset+opening message into a FRESH web conversation; every
 * later turn sends only the increment. Committed strictly after success so
 * aborted turns resend instead of skipping.
 */
/**
 * Auxiliary calls that do not need the web page are answered locally so the
 * user does not see duplicate sends on the web side. Currently: title/naming
 * style requests (small, no tools).
 *
 * 只认 DSH 自己的 `purpose: 'session-title'`。旧实现还拿 system 文本里的
 * 「title/标题/命名」当判据——工作区指令里只要出现过这些词，一次真实轮次就会
 * 被本地截成前 16 个字直接返回，模型根本没被调用。
 *
 * 命名来源（问题④）：优先取网页端该对话的真实标题——网页侧会按首轮内容给对话
 * 命名，用户也可以在那里手动重命名，这才是「自动重命名接入网页端」。取不到
 * （非 DeepSeek 站点、对话尚未落库、网络失败）才退回本地启发式。
 */
async function localAnswer(options, webTitleFor) {
  try {
    if (String(options.purpose || '') !== 'session-title') return null;
    if (Array.isArray(options.tools) && options.tools.length) return null;
    const firstUser = (options.messages || []).find((m) => m?.role === 'user');
    let t = textOfBlocks(firstUser?.content);
    const prefix = 'Generate the session title from this JSON array of human messages:';
    if (t.startsWith(prefix)) {
      try {
        const entries = JSON.parse(t.slice(prefix.length).trim());
        t = Array.isArray(entries) ? entries.map(entry => typeof entry.text === 'string' ? entry.text : '').join(' ') : '';
      } catch { /* 帧文本异常时按原文处理 */ }
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (typeof webTitleFor === 'function') {
      let webTitle = null;
      try { webTitle = await webTitleFor(options); } catch { webTitle = null; }
      if (webTitle) return webTitle;
    }
    return (t.slice(0, 16) || '新会话');
  } catch {
    return null;
  }
}

/** Routes the OpenAI front owns on the relay; everything else mirrors upstream. */
function frontClaims(pathname) {
  return pathname.startsWith('/v1') || pathname.startsWith('/webcode/v1') ||
    pathname === '/bridge/status' || pathname === '/bridge/consent' ||
    pathname === '/bridge/login' || pathname === '/bridge/import-session';
}

/**
 * 插件入口：DSH 加载本包时调用一次，之后整轮生命周期都挂在它注册的东西上。
 *
 * 这里按顺序搭起四层，**顺序有依赖**，不要重排：
 *   1. 驱动层（`driverFor`）——站点 × 账户槽的 Edge 实例，唯一持有浏览器状态的地方；
 *   2. relay + OpenAI 兼容前端——把驱动串行化并暴露标准端点；
 *   3. DSH 的 LLM provider 适配器（`llm.registerAdapter`）——网页模型由此进入
 *      Harness 原生工具循环；
 *   4. 控制面与镜像——`/__webcode/*` 路由（客户端面板的数据源）与右侧栏同源镜像。
 *
 * `ctx.effect` 用于登记清理：会话卸载时路由、驱动、relay 都要按序释放，
 * 否则会留下孤儿 Edge 进程占着 profile 锁（见 long-term-issues 第 7 条）。
 *
 * @param {object} ctx cordis 上下文（已声明 inject 的 llm / webServer）
 * @param {object} [config] 插件配置（端口、站点、profileDir、发送间隔…）
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // 最近一次被 `/status` 投影过的会话 id（0.19.0）。任务台账的**写**路径不带会话身份，
  // 用它与 roster 的任务投影共用同一个工作目录根，避免「任务板与花名册各读一份台账」。
  let lastProjectedSessionId = null;
  const cfg = { ...DEFAULTS, ...(config || {}) };
  // Stable fingerprint surfaced in /__webcode/status so a packed installation
  // can be compared with the workspace build without restarting the GUI here.
  if (!cfg.buildHash) {
    let version = 'unknown';
    try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || version; } catch {}
    cfg.buildHash = createHash('sha256').update('dsh-webcode-bridge@' + version).digest('hex').slice(0, 12);
    cfg.version = version;
  }
  const sessionState = new Map();
  // 0.21.1：会话游标持久化（long-term-issues #2 的落地）。dsh web 重启清零内存
  // Map → no-cursor → fresh → 整段重发；网页会话身份早已落盘，丢的只是「发到第
  // 几条」。commit/invalidate 原子落盘到 profile 目录，启动回灌（上限 512 不变）。
  // **陈旧条目安全**：契约指纹 + 内容锚点自愈（contract-changed / anchor-lost），
  // 持久化不会把旧游标错当新游标。只在显式传入 profileDir 时启用（生产必传；
  // 不传的裸测试形态回落 DEFAULTS 真实 profile，绝不能被测试污染）。
  const cursorStatePath = () => path.join(cfg.profileDir, 'webcode-cursor-state.json');
  const cursorPersistenceUsable = () => Boolean(config && config.profileDir);
  if (cursorPersistenceUsable()) {
    try {
      const raw = JSON.parse(fs.readFileSync(cursorStatePath(), 'utf8'));
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object') {
        for (const [k, v] of Object.entries(raw.entries)) {
          if (sessionState.size >= 512) break;
          if (v && Number.isFinite(v.sent) && typeof v.fingerprint === 'string' && Array.isArray(v.tailHashes)) {
            sessionState.set(k, v);
          }
        }
        if (sessionState.size) log('cursor state restored:', sessionState.size, 'entries');
      }
    } catch { /* 首跑或文件损坏：从零开始，安全（契约 + 锚点自愈） */ }
  }
  let cursorPersistFailures = 0;
  function persistCursorState() {
    if (!cursorPersistenceUsable()) return;
    try {
      fs.mkdirSync(cfg.profileDir, { recursive: true });
      const tmp = cursorStatePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), entries: Object.fromEntries(sessionState) }));
      fs.renameSync(tmp, cursorStatePath());
    } catch (e) {
      if (++cursorPersistFailures <= 3) warn('cursor state save failed:', e?.message);
    }
  }
  // 自动续跑的**整会话累计**（0.19.3，用户指令「加整会话累计」）。落盘根与提示词
  // 落盘同一处（`continuations/<sessionKey>.json`），因此「整会话」跨 dsh web 重启
  // 依然成立；测试进程自动只走内存（守卫在 continue-budget.js，与 prompt-store 对称）。
  const continueCounter = createContinueCounter({ dir: promptStoreDirFor() });
  // 每个会话最近一次**真实发出去的站点教学全文**（buildTurn 的 fresh 分支写入）。
  // autoContinueRound 的「完整提醒」优先读它：那一份就是首轮真实教过的正本，
  // 与提示词落盘的 prompts/<site>.md 正文逐字同源——绝不在续跑路径上另拼一份教学。
  const siteTeachingBySession = new Map();
  // 「这条 DSH 会话上一次用的是哪个账号」（0.19.4）：只用于把「换账号导致的整段重建」
  // 标成 `account-changed` 而不是含糊的 `no-cursor`。有界，与其它会话级 Map 同款。
  const lastAccountBySession = new Map();
  const SITE_TEACHING_CAP = 64;
  /** 记住本会话的站点教学全文（有界：超上限丢最老，与其它会话级 Map 同款）。 */
  function rememberSiteTeaching(sessionKey, text) {
    if (!sessionKey || !text) return;
    siteTeachingBySession.delete(sessionKey); // 先删后插 = 最近使用在尾部
    siteTeachingBySession.set(sessionKey, text);
    while (siteTeachingBySession.size > SITE_TEACHING_CAP) {
      siteTeachingBySession.delete(siteTeachingBySession.keys().next().value);
    }
  }
  // 节流收场那一轮的会话键：那一轮的正文**没有发给网页**（见 executor 的
  // SESSION_SWITCHED 分支），所以适配器收尾处的 `turn.commit()` 不许让游标前进——
  // 否则下一轮会把「这一轮没发出去的消息」当成已发、只发后续增量，也就是静默丢上下文
  //（本仓库三条不可越界约束之一）。`commit()` 消费掉标记（一次性、同一轮内），
  // `invalidate()` 一并清掉；尾部淘汰与 sessionState 同型，防止无界增长。
  const cededCursorKeys = new Set();
  // 「本次进程里作废过几次发送游标」——只读计数，透出到 /__webcode/status 的
  // driver.sessionCursorInvalidations（0.16.4）。存在的意义是把「又新开了一个对话」
  // 一句话定位到**哪一侧**：驱动侧的槽丢了看 sessionLostCount / sessionSlot，
  // 适配器侧把游标清掉了看这个数。没有它，同一个症状在两侧各有一个嫌疑，
  // 只能靠读日志猜（这正是 2026-09-17 那次排查花掉一整天的地方）。
  let sessionCursorInvalidations = 0;
  // 「本次进程里因节流改口成『网页会话已切换』几次」——只读计数，透出到
  // /__webcode/status 的 driver.sessionSwitchNotices（0.16.6）。与上面那枚分开记：
  // 它回答的是**用户看到几次提示**（0.16.6 之前这里是一条红色「本轮运行失败」，
  // 用户报的就是它），混进 sessionCursorInvalidations 就分不清「作废游标」与
  // 「改口成提示」各发生了几次。
  let sessionSwitchNotices = 0;
  // 0.16.29：「为什么新开了 web 端对话」的逐因计数（用户第 4 问的正面回答）。
  // 四个真因见 buildTurn 里 freshReason 的注释。只读，透出到 /__webcode/status 的
  // driver.freshReasons —— 从前这个问题只能靠读日志猜，现在一句话可查。
  const freshReasons = new Map();
  let buildTurn;
  let lastPresetInfo = null;   // the most recent first-turn prompt (settings-page preview)
  // 全局指令：设置页可追加，持久化在 profile 目录的 webcode-settings.json（优先使用宿主 settings 服务）。
  const settingsPath = path.join(cfg.profileDir, 'webcode-settings.json');
  let settingsService = null;
  try { settingsService = ctx.get('settings') || ctx.settings; } catch {}
  // 宿主 settings 必须读写双全才启用（DSH 实测存在 get-only 形态）；
  // 只读宿主会造成「写文件、读宿主」的读写分裂——保存永远丢失。get/set 同源是硬约束。
  if (!(settingsService && typeof settingsService.get === 'function' && typeof settingsService.set === 'function')) {
    settingsService = null;
  }
  // accounts（0.14.7）：同站多账户的槽清单。**默认空数组 = 行为与 0.14.6 完全一致**
  // ——「不配置就不改变」是多账户这种高风险特性的第一条纪律：任何一个没配槽的
  // 用户都不该因为升级而看到不同行为。
  // sendGapMsBySlot：槽级发送间隔覆盖（`{ 'glm#2': 60000 }`）。回落链见
  // accounts.sendGapForSlot：槽显式值 → 站点级键 → 全局 sendGapMs。
  // sendGapBasis（0.16.31）：间隔基准的口径，'send-to-send'（默认）| 'end-to-start'。
  // 为什么默认必须逐字保持 send-to-send：0.14.0 特意把基准从「上一轮结束」改成
  // 「上一轮发出」，并配了单测（test/send-gap.test.mjs）。改默认值等于**静默改掉
  // 所有既有用户的行为**——他们设 10 秒本意是防限流，不是要每轮多等 10 秒。
  // 因此这里只**新增一个可选项**，把选择权交给设置面。语义与判据见
  // metrics.computeSendGap 的注释（两个基准防的是两种不同的东西）。
  // defaultModelBySite（0.16.38）：**站点内覆盖**。主线落点仍是全局 defaultModel
  //（站点+模型），当落点站点为 S 且 defaultModelBySite[S] 存在时，用那一支而不是
  // defaultModel 里的模型。解析点唯一，见 buildTurn 的 effectiveDefault 注释。
  // extraPromptBySite（0.16.38）：**该站点专属的 [本网站指令]**，与全局 extraPrompt
  // 同轮注入（全局在前）。默认空对象 = 行为与 0.16.37 逐字相同。
  const defaultConfig = { extraPrompt: '', extraPromptBySite: {}, defaultModel: 'deepseek', defaultModelBySite: {}, previewRefreshRate: 5000, thinkMode: 'on', subAgentMode: 'own', subAgentSite: 'follow', sendGapMs: 0, sendGapBasis: 'send-to-send', accounts: [], sendGapMsBySlot: {} };
  const configManager = {
    get() {
      // settingsService 已在初始化时校验 get/set 双全；此处仍防御式包裹
      if (settingsService) {
        try {
          const ns = settingsService.get('webcode');
          return { ...defaultConfig, ...(ns || {}) };
        } catch { /* fall through to file store */ }
      }
      try {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return { ...defaultConfig, ...data };
      } catch { return { ...defaultConfig }; }
    },
    set(newConfig) {
      const merged = { ...defaultConfig, ...newConfig };
      // settingsService 初始化时已确认可写；运行期异常仍回落文件，绝不让保存 502
      if (settingsService) {
        try { settingsService.set('webcode', merged); return merged; } catch (err) { warn('host settings set failed:', err?.message); }
      }
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const tmp = settingsPath + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, settingsPath);
      } catch (err) { warn('settings save failed:', err?.message); }
      return merged;
    }
  };
  const llm = resolveLlm(ctx);
  if (!llm) {
    throw new Error('[webcode-bridge] llm service not available on ctx — is this a dsh profile bundle loaded after dsh-base?');
  }
  // 原生图片块的唯一读取入口。拿不到时 harness 的截图会在 attach() 里被明确
  // 记为 skipped 并报错，而不是静默丢弃（见 resolveImages）。
  const attachments = resolveAttachments(ctx);
  if (attachments) log('attachment store resolved — durable image blocks are readable');
  else warn('attachment store NOT available on ctx; native (harness) image blocks cannot be resolved');

  // ---- LLM provider adapter --------------------------------------------
  // Pure adapter registration (the shape opencode2dsh's adapter mode uses): the
  // provider appears in the model selector immediately and listModels is read
  // live at selector time. We deliberately do NOT also call
  // registerConfigurableProviders — declaring the same provider in the
  // "configurable" directory as well makes the GUI treat it as an endpoint-
  // gated provider and the models never surface in the main selector.

  /**
   * 站点声明的上下文窗口（token）的唯一取值处 —— resolveModel 与发送前预算闸
   * 共用这一份，避免「声明的是一个数、闸门比的是另一个数」。
   *
   * 优先级（0.16.22 调整）：cfg.contextWindowBySite[siteId]（运维/测试覆盖，
   * **最高**）> 模型自带 context（providers.js 各站点，glm/zai 已是真机实测下界）
   *        > deepseek 1_000_000 / 其余 64_000 的诚实兜底。
   *
   * 为什么 cfg 必须排在模型声明前面（0.16.22 修）：内置模型全部声明了 context，
   * 旧优先级下 `contextWindowBySite` 永远轮空——预算闸报错文本里「在设置里调大
   * 该站点的窗口声明」这条建议是**空头支票**，用户照做也不会生效。「运维覆盖」
   * 的语义就是覆盖，声明值只是缺省。
   *
   * 未校准站点的 64_000 是**保守值**，含义是「宁可让 DSH 早一点压缩，也不要
   * 发出去被网页端截半截」；越界同样由 PROMPT_TRUNCATED 与预算闸双重兜底。
   */
  function contextWindowFor(m) {
    return cfg.contextWindowBySite?.[m?.siteId]
      ?? m?.budget
      ?? m?.context
      ?? (m?.siteId === 'deepseek' ? 1_000_000 : 64_000);
  }

  /**
   * 上报 usage 时叠加的「网页自身上下文」固定开销（token，一次性）。
   *
   * 单独一处取值、四个调用点共用（会话累计、无会话键单轮、OpenAI 前端两处）——
   * 与 `contextWindowFor` 同一纪律：口径只能有一份，否则「GUI 的用量」与
   * 「OpenAI 前端报的用量」会各说各话。
   *
   * @returns {number} 非负整数（非法/缺省回落 DEFAULTS 的 2048）。
   */
  function usageOverheadTokens() {
    const n = Math.round(Number(cfg.usageFixedOverheadTokens));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 发送前预算闸（0.14.1，B-2）—— 超出声明的上下文窗口就在**发出之前**拒绝。
   *
   * 动机：桥声明的 contextWindow 是乐观值（glm/zai 现为实测 1M），声明偏大的代价
   * 在旧实现里是静默的：DSH 的自动压缩永不触发 → transcript 只增不减 → 最后被网页
   * 端截半截或撞 240s 超时。已有的 PROMPT_TRUNCATED 回读校验发生在**填写之后**，
   * 报错只有长度差，看不出超了多少、也不知道下一步该做什么。
   *
   * 这里把它前移成一条可解释的报错：`CONTEXT_WINDOW_EXCEEDED`，文本里带
   * 「本轮 N 字符 ≈ M token > 声明窗口 W」与可行建议。
   *
   * 边界（都有单测钉住）：拿不到窗口 → 放行（猜一个数去拒绝用户比放行更糟）；
   * 只拒 ratio > 1，不做「接近预算就拦」的节流。
   */
  function assertContextBudget(prompt, modelId) {
    let m;
    try { m = resolveWebModel(modelId); } catch { return; }
    const budget = checkContextBudget({
      text: String(prompt ?? ''),
      contextWindow: contextWindowFor(m),
    });
    if (!budget || budget.ok) return;
    const pct = Math.round(budget.ratio * 100);
    const err = new Error(
      `CONTEXT_WINDOW_EXCEEDED: 本轮提示词 ${budget.chars} 字符 ≈ ${budget.tokens} token，`
      + `超过 ${m.siteId} 声明的上下文窗口 ${budget.window}（${pct}%，超出约 ${budget.overflowTokens} token）。`
      + ' 已在本轮发出前拦下，网页端未被写入。'
      + ' 处理：新开一个会话（推荐），或在设置里调大该站点的窗口声明后重试。',
    );
    err.code = 'CONTEXT_WINDOW_EXCEEDED';
    err.budget = budget;
    warn(err.message);
    throw err;
  }

  const adapter = {
    providerInfo(provider) { return { id: provider, name: cfg.displayName }; },
    providerRetryPolicy() { return undefined; },
    // 必须同步、无 I/O、绝不抛——每次 token meter 测量都会调到这里
    //（dsh-token-meter/lib/index.js:644 → :689 → dsh-llm/lib/index.js:1964）。
    // 旧版缺这个方法时，真实报错是
    //   this.adapters.get(...)?.adapter.imageRequestPricing is not a function
    // 而它出现在**手动压缩**路径上，让「压缩功能」看起来像没实现。
    // 模型解析用 try/catch：历史会话里可能存着已下线的 model id，
    // resolveWebModel 对未知 id 是 throw 的——计价不许把一个陈旧 id 升级成测量失败。
    imageRequestPricing(_provider, model) {
      let acceptsImages = false;
      try { acceptsImages = resolveWebModel(model)?.acceptsImages === true; } catch { acceptsImages = false; }
      return webcodeImageRequestPricing({ acceptsImages });
    },
    async listModels(provider) {
      // 选择器下拉过滤兼容别名（deepseek-web 与 deepseek:deepseek 显示名逐字相同，
      // 照单渲染就是两行同名项）。别名本身仍可被 resolveModel 解析——历史会话与
      // OpenAI 前端的旧值依赖它，所以只过滤「展示」，不动「解析」。
      return WEB_MODELS.filter((m) => !MODEL_ALIAS_IDS.has(m.id)).map((m) => ({ provider, id: m.id, name: m.name }));
    },
    async resolveModel(provider, model) {
      const m = resolveWebModel(model);
      if (!m) throw new Error('[webcode-bridge] 未知模型: ' + model);
      // 声明值来自 `contextWindowFor(m)`，取值链的第一段是 `DEFAULTS.contextWindowBySite`
      // ⇒ deepseek 今天声明 **1,000,000**，其余站点 64k。
      //
      // 这里曾经写着「按站点给诚实的保守值……取 128k」，而代码从来没那样做过
      //（2026-09-23 逐字对照发现，属 doc/comment-style.md §10.2 点名的「注释描述的
      // 实现已不存在」）。按纪律只改注释、**不动行为**：把 1M 改成 128k 会让 DSH 的
      // 自动压缩真的开始触发，那是产品决策而非笔误修正，已记入 doc/progress.md 的遗留项。
      //
      // 已知后果（两条都要读）：1M 之下的 DSH 压缩阈值约 80 万 token，正常使用够不着，
      // 因此长会话目前只靠**手动**／compact；越界仍由 PROMPT_TRUNCATED 回读校验与
      // 发送前预算闸（CONTEXT_WINDOW_EXCEEDED）双重兜底，不会静默截半截。
      const contextWindow = contextWindowFor(m);
      // inputModalities 是**护栏**，不是可选元数据：宿主只在它明确不含 'image'
      // 时调 projectImagesForTextModel() 把图片换成文字占位
      //（dsh-llm/lib/index.js 的那处判定）。声明错了方向，harness 截图会在到达
      // 桥之前就被剥离，症状正是「网页端说没图」——而桥这边看不到任何异常。
      // 因此按模型的真实带图能力声明（acceptsImages，不是 vision：vision 是
      // DeepSeek 那种必须带图的独立识图模式）；未真机校准的一律 text——宁可
      // 明确不支持，也不让图片在半路被悄悄换掉。
      const inputModalities = m.acceptsImages === true ? ['text', 'image'] : ['text'];
      return { provider, id: model || m.id, name: m.name, context: { contextWindow }, inputModalities };
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal);
      return { model: info, stream: (opts) => this.stream({ ...opts, model, signal: opts.signal || signal }) };
    },
    async *stream(options) {
      const turn = buildTurn(options);
      // 发送前预算闸：在 attach/上传/写 composer 之前就拦下越界的一轮（B-2）。
      assertContextBudget(turn.prompt, turn.meta?.model);
      logCall(options);
      const images = await turn.attach?.();
      if (images?.length) {
        turn.meta.images = images;
        log(`vision turn: ${images.length} image(s) attached (${images.map(i => i.contentType).join(',')})`);
      }

      const local = await localAnswer(options, webConversationTitle);
      if (local !== null) {
        yield* emitText(local, turn);
        return;
      }

      const tools = Array.isArray(options.tools) ? options.tools : [];
      const ch = channel();
      // 适配器侧「无进展」看门狗（0.14.0）——问题②的第二条防线。
      //
      // 驱动侧的 WIP 稳态收束（browser-driver.startWipWatch）负责把「网页已经写
      // 完但没送 FINISHED」的轮次在秒级救回来。但还有一类情况它救不了：捕获链
      // 从未建立、页面僵死、或整个 relay 卡在别处。这时 `ch.next()` 会**永远**
      // 挂着，界面表现同样是无限「思考中」，而驱动的 240s 总超时也只在驱动自己
      // 还在跑时才有效。
      //
      // 因此这里在**消费端**加超时：自上次收到任何 delta/think/image 起超过
      // IDLE_TIMEOUT_MS 仍无事件，就主动抛错。错误文本带上驱动现场（有没有活页、
      // 最近一次部分流收束记录），排障不必再翻宿主控制台。
      // 用 Promise.race 而不是独立 setInterval：事件到达即返回，定时器在 finally
      // 里清掉，一次调用一个定时器、零泄漏（旧写法若用常驻 interval，每轮都会
      // 留下一个永不清理的计时器）。
      const idleSiteId = turn?.meta?.siteId || 'deepseek';
      // 本轮是否已经收到过**任何**事件（delta/think/image）。这是本闭包自己的标记，
      // 刻意**不问驱动**：驱动的 status 是跨轮共享的（该事故里看门狗读到的
      // `lastEndReason=finished` 其实是**上一轮**的收束原因，被当成了本轮线索），
      // 而「网页开口了没有」必须严格属于本轮。null = 还没有，epoch ms = 首个事件时刻。
      let firstEventAt = null;
      // 驱动此刻是否在忙。status() 是同步的、已存在；懒驱动（glm#2 之类）可能还没建、
      // 或被替换中的实现根本没有 status() ⇒ 取不到一律按「不在忙」，即按旧窗口快报
      // （安全侧：宁可早报，也不给一个可能已经死掉的链路 2 倍宽限）。
      const idleDriverBusy = () => {
        try { return driverFor(idleSiteId)?.status?.()?.busy === true; } catch { return false; }
      };
      // 相位与窗口在**每次 next() 之前**重算：首个事件一到，窗口立刻回到 IDLE_TIMEOUT_MS，
      // 已经开流的轮次不可能继续享受宽限（判据与安全线见 lib/idle-window.js）。
      const idleDecision = () => idleWindowDecision({
        baseMs: IDLE_TIMEOUT_MS,
        firstEventAt,
        driverBusy: idleDriverBusy(),
        multiplier: cfg.idleFirstByteMultiplier,   // 非法值由纯函数回落成 1
        // 整轮预算：相位窗口必须**严格小于**它，否则看门狗与驱动的整轮超时
        // 会在同一条 deadline 上赛跑，用户可能拿到信息量最少的那句
        // （`web turn timed out`，没有页面现场）。默认 120s×2 = 240s 恰好撞上
        // 整轮 240s，纯函数因此把相位窗口压到预算的 90%。见 lib/idle-window.js。
        totalBudgetMs: cfg.requestTimeoutMs,
      });
      // 现场在**超时那一刻**才采（同步调用，无页面往返）：提前采会拿到过时状态。
      const idleScene = (decision) => {
        // 相位与窗口一并带进现场：报错里「超过 240s」到底是不是宽限后的窗口，
        // 事后必须能一眼读出（旧实现只有一个超时数字，分不清相位）。
        const base = {
          phase: decision?.phase ?? null,
          // 0.19.23：本轮到底有没有收到过事件。`phase` 的 'mid-stream' 同时覆盖
          // 「开流后静默」与「没开流且驱动不忙」两种情形，只印 phase 会让报错
          // 说出一句假陈述（真机 session-e7056e8c turn3）。这个布尔是**只读**的
          // 定性读数，用来把两种情形在文案里分开——窗口计算一个字都没动。
          firstEventSeen: decision?.firstEventSeen === true,
          windowMs: decision?.windowMs ?? null,
          // capped=true ⇒ 相位窗口被整轮预算压过（不是配置写错）。报错里要说出来，
          // 否则下一次看到「判定相位=网页还没开口（窗口已放宽到 216s）」的人
          // 会以为自己配的 240s 没生效。
          windowCapped: decision?.capped === true,
        };
        try {
          const st = driverFor(idleSiteId)?.status?.() || null;
          if (!st) return base;
          return {
            ...base,
            preview: st.preview === true,
            running: st.running === true,
            busy: st.busy === true,
            recoveredTurns: st.recoveredTurns ?? 0,
            lastRecovered: st.lastRecovered ?? null,
            lastEndReason: st.lastEndReason ?? null,
            // 0.16.3：收束原因的写入时刻。没有它就无法把「本轮刚收束」与
            // 「上一轮遗留的读数」分开（真机事故里正是后者被当成了前者）。
            lastEndReasonAt: st.lastEndReasonAt ?? null,
            // 0.15.2：只出思维链的硬上限现场。看门狗超时时，这三个字段能把
            // 「网页没生成」与「思考完就不回答」在报错文本里直接分开。
            thinkingOnlyTurns: st.thinkingOnlyTurns ?? 0,
            lastStalledSettle: st.lastStalledSettle ?? null,
            answerTimeoutMs: st.answerTimeoutMs ?? null,
            // 0.16.3：驱动侧的两段现场读数（见 browser-driver status() 的投影注释）。
            // `lastActivityAt` 很新 ⇒ 巡检器还在读到页面，链路是活的；
            // `domReplyChars` 很大而这边零事件 ⇒ 网页早写完，缺的是回传。
            lastActivityAt: st.lastActivityAt ?? null,
            domReplyChars: st.domReplyChars ?? null,
          };
        } catch { return base; }
      };
      const nextWithIdle = async () => {
        let timer = null;
        try {
          const ev = await Promise.race([
            ch.next(),
            new Promise((_, reject) => {
              const { windowMs, phase } = idleDecision();
              timer = setTimeout(() => reject(idleTimeoutError(windowMs, idleScene({ windowMs, phase }))), windowMs);
              timer.unref?.();
            }),
          ]);
          // 首个事件到达：置位本轮标记，下一次迭代起窗口立刻回到常规值。
          if (firstEventAt === null) firstEventAt = Date.now();
          return ev;
        } finally { if (timer) clearTimeout(timer); }
      };
      const settled = relay
        .submit(turn.prompt, {
          signal: options.signal,
          onDelta: (t) => ch.push({ delta: t }),
          onThink: (t) => ch.push({ think: t }),
          onImage: (img) => ch.push({ image: img }),
          meta: turn.meta,
        })
        .then(({ text, thinking, images }) => ch.push({ end: { text, thinking, images } }))
        .catch((err) => {
          // 交付前的失败**按错误码**决定「要不要把发送游标作废」，不再一律作废
          //（判据与整张白名单见 CURSOR_INVALIDATING_CODES 的注释）。
          //
          // 旧写法是 `turn.invalidate?.()` 无条件执行：任何一轮失败（包括
          // WEB_NO_PROGRESS 这种「内容已经发出去、只是网页没吐完」的失败）都会把
          // sessionState 里这一条删掉，于是下一轮 `const fresh = !st` 为 true ⇒
          // 整段首轮提示词重发 + `fresh:true` ⇒ 又开一个新的网页对话。真机行为级
          // 实测（guards，脚本驱动、同一 apply 实例三轮）：fresh 序列
          // `[true,false,true]`、第三轮 messageChars=150,072——就是用户报的
          // 「一直新开对话 + 每轮四十万字符」，与驱动侧的槽丢失**各自独立**。
          const code = String(err?.code || '');
          if (CURSOR_INVALIDATING_CODES.has(code)) {
            turn.invalidate?.();
            sessionCursorInvalidations += 1;
            warn(`turn failed with ${code} — 作废发送游标（第 ${sessionCursorInvalidations} 次）：`
              + '下一轮将整段重建网页会话');
          } else {
            // 未列出的码（含空 code）默认保留游标：这一轮的失败没有证据表明网页侧
            // 的前文不可用，下一轮继续发增量即可——绝不因此重发整段、更不换新会话。
            log(`turn failed with ${code || '(no code)'} — 保留发送游标，下一轮继续发增量`);
          }
          ch.push({ err });
        });

      if (tools.length === 0) {
        // pure chat: stream deltas as they arrive
        let acc = '';
        let thinkAcc = '';
        let thinkOpen = false;
        let textOpen = false;
        let thinkIndex = -1;
        let textIndex = -1;
        let nextIndex = 0;
        // 块开关的三种状态组合只在这里定义一次；闭包直接改写上面的 let 状态。
        // 0.9.6 的「块内容发成数字」正是同一舞蹈散落多处、漏改一处造成的。
        const openThink = function* () {
          if (thinkOpen) return;
          thinkIndex = nextIndex++;
          yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' };
          thinkOpen = true;
        };
        const openText = function* () {
          if (textOpen) return;
          yield* closeThink();
          textIndex = nextIndex++;
          yield { type: 'block-start', index: textIndex, blockType: 'text' };
          textOpen = true;
        };
        const closeThink = function* () {
          if (!thinkOpen) return;
          yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
          thinkOpen = false;
        };
        const images = [];
        let end = null;
        for (;;) {
          const ev = await nextWithIdle();
          if (ev.think) {
            thinkAcc += ev.think;
            yield* openThink();
            yield { type: 'reasoning-delta', index: thinkIndex, text: ev.think };
            continue;
          }
          if (ev.image) { images.push(ev.image); continue; }
          if (ev.delta) {
            acc += ev.delta;
            yield* openText();
            yield { type: 'text-delta', index: textIndex, text: ev.delta };
          } else if (ev.err) {
            throw ev.err;
          } else {
            end = ev.end ?? null;
            // canonical full text wins; patch the tail if deltas lagged
            const full = end?.text ?? '';
            if (full && full !== acc) {
              if (full.startsWith(acc)) {
                const rest = full.slice(acc.length);
                if (rest) { acc = full; yield* openText(); yield { type: 'text-delta', index: textIndex, text: rest }; }
              } else {
                acc = full; // diverged: block-end below carries the truth
              }
            }
            break;
          }
        }
        const endImages = Array.isArray(end?.images) && end.images.length ? end.images : images;
        // 只出图不出字的回复是合法的（识图模式的常见形态），不能在追加图片
        // markdown 之前就按「空回复」判死。
        assertNonEmpty(acc, thinkAcc, endImages);
        // 0.15.2：纯聊天轮的同一个洞——`assertNonEmpty` 放行了「只有思考」的轮次
        // （第二个实参就是 thinkAcc），但下面既没有正文块、也没有任何交回会话的
        // 内容，于是界面上就是「思考完就没了」。与工具轮同型处置：把归因提示当
        // 正文发出。**不能只改 acc**——本轮的 text-delta 早在 ev.delta 分支发过了，
        // 只赋值不发 delta 的话块内容与已外发内容不一致（界面依旧空白）。
        const thinkingOnly = !acc.trim() && !endImages.length && Boolean(String(thinkAcc || '').trim());
        if (thinkingOnly) {
          acc = thinkingOnlyNotice(thinkAcc, idleScene());
          warn(acc);
        }
        const imageMd = imageMarkdown(endImages);
        if (imageMd) {
          acc += imageMd;
          yield* openText();
          yield { type: 'text-delta', index: textIndex, text: imageMd };
        } else if (thinkingOnly) {
          yield* openText();
          yield { type: 'text-delta', index: textIndex, text: acc };
        }
        if (imageMd) {
          acc += imageMd;
          yield* openText();
          yield { type: 'text-delta', index: textIndex, text: imageMd };
        }
        turn.commit();
        if (textOpen) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: acc } };
        yield* closeThink();
                yield* finishChunks(turn, acc + thinkAcc, 'stop');
        await settled;
        return;
      }

      let end = null;
      let acc = '';
      // 已外发的正文原文（字符串，acc 的前缀）。0.9.6 曾把它改成「已发到的下标」
      // （数字），但收尾处的 startsWith/slice/stripProtocolText 仍按字符串用——
      // 纯文本回复必抛 STREAM_REWRITE 整轮作废、带调用时正文块变成数字。
      // 恢复 0.9.4 的字符串语义，只保留 0.9.6 的单调边界逻辑。
      let textSent = '';
      // 已作为 text-delta 外发的正文拼接（不含从未外发的协议区间）。块收口必须
      // 发「本块开启之后新增的部分」而不是累计值——一轮多调用会开多个文本块，
      // 发累计值用户就会看到同一句话重复 N 次（0.12.3 真机 goal 轮实锤）。
      let proseSent = '';
      let proseBlockStart = 0;
      let textOpen = false;
      let thinkAcc = '';
      let thinkOpen = false;
      let thinkIndex = -1;
      let textIndex = -1;
      let nextIndex = 0;
      const genImages = [];
      // 流式期间已经开块的调用（按出现顺序）。一次回复可以含多个调用，所以这里
      // 必须是列表而不是单个 pendingCall——旧实现只记第一个，模型连发三个 read
      // 时后面两个的参数增量全被丢掉，收尾比对 pendingCall.name !== valid[0].name
      // 直接抛 TOOL_PROTOCOL_INVALID，整轮作废（真机 2026-09-10 轨迹里正是
      // 「一轮连发 3 个 read、只有第 1 个留下」）。
      const pendingCalls = [];
      // 已经消化掉的协议区间终点（不含）。定位用 findProtocolStart(acc, protocolFrom)：
      // 不能在找到一个调用后继续从头扫，否则同一个边界反复命中，同一个调用被开两次块。
      // 不匹配已知工具时（模型在散文里引用或举例说明调用格式）**不**推进这个游标，
      // 那段文字会照常作为正文发出，而不是被静默吃掉。
      let protocolFrom = 0;
      // 已开块的调用，按「协议边界下标」去重：同一个调用在流式期间会被反复命中
      // 同一个边界（参数还没配平时游标不推进），只有开过一次块才不会再开。
      const openedAtIndex = new Map();
      // 目前为止见过的最大协议边界下标（单调不减）：正文外发永远不得越过它。
      let lastBoundary = -1;
      const callSeq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const callId = i => `call-webcode-${String(options?.sessionId || 'stateless')}-${callSeq}-${i}`;
      // 主文本块已经 block-end 之后的追加文本块（自动续跑的结果说明用）。块内容与
      // delta 逐字一致由调用方保证——这里只负责开/发/收三件套与下标推进。
      const emitFollowUp = function* (text) {
        const idx = nextIndex++;
        yield { type: 'block-start', index: idx, blockType: 'text' };
        yield { type: 'text-delta', index: idx, text };
        yield { type: 'block-end', index: idx, block: { type: 'text', text } };
      };
      // 调用块派发三件套（自动续跑两处出口共用）：与流式开块路径同一个
      // coerce/fill 管线，参数纠偏与必填补齐不因「来自续跑轮」而降级。
      const emitCallBlocks = function* (calls, purposeFallback) {
        for (const rc of calls) {
          const idx = nextIndex++;
          const id = callId(idx);
          const target = tools.find((t) => t?.name === rc.name) || null;
          const { args: fixedArgs } = coerceArguments(rc.arguments, target?.parameters);
          const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, rc.purpose || purposeFallback);
          if (filled.length) log(`filled missing required args for ${rc.name}: ${filled.join(', ')}`);
          const args = JSON.stringify(filledArgs);
          yield { type: 'block-start', index: idx, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: idx, id, name: rc.name, argumentsDelta: args };
          yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: rc.name, arguments: args } };
        }
      };
      // —— 解析失败自动续跑（0.16.25）————————————————————————————————————
      //
      // 为什么需要它（真机 cd997dd3，2026-09-19 19:2x，reply-log 逐字取证）：官方
      // 格式漂移（参数对象闭合后多挂 `,{"replace_all":false}` 第二对象）连续三轮
      // UNPARSED，桥把再教学提示交回会话后，agent 循环把「纯文本轮」当最终答案
      // 收场——两次都是**用户手动**打「继续，注意工具的调用」才救活（会话 jsonl
      // 11:21:26 / 11:22:51 两条 user/message 逐字）。提示能让模型改正的前提是
      // **循环还在跑**；0.16.12 的恢复派发只救只读白名单，写类工具（edit/write）
      // 的漂移轮在无人值守下依旧终止。本函数把手动续跑自动化：把 UNPARSED 提示
      // **作为用户消息补发进同一个网页会话**，收第二轮回复交回调用的解析结果。
      //
      // 红线（与 0.16.23 退役纪律同源）：
      //   ① 不改解析宽容度——第二轮回复走同一个 parseAgentReply，第二对象照旧
      //      拒收（代拼参数 = 给漂移发奖励，模型永不收敛）；
      //   ② 只在会话模式（meta.sessionKey）续跑：无状态轮（OpenAI 前端/aux）的
      //      调用方自己拥有循环语义，桥不代做多轮；
      //   ③ 每步至多 autoContinueRounds 次（默认 1，0 = 关闭），续跑轮再失败就
      //      回落既有「提示当正文」收场，绝不递归——最坏代价是一轮额外的网页往返；
      //   ④ 走 relay.submit（同一 meta），发送间隔/限流退避/WEB_SESSION_LOST 整段
      //      重放全套机器原样生效，不绕过任何节流。
      const autoContinueRound = async (noticeText) => {
        const rounds = Math.max(0, Number(cfg.autoContinueRounds ?? 1) || 0);
        // 0.16.29：返回 `{ disabled:true }` 而不是裸 null，让调用方把「根本没补发」
        // 与「补发了但没救回来」分开处置——前者没有第二条通道，再教学提示必须
        // 照旧当正文交回（否则 autoContinueRounds=0 的用户彻底拿不到归因）；
        // 后者提示已经逐字进了网页会话，界面上只留 AUTO_CONTINUED
        //（用户指令：「TOOL_CALL_UNPARSED: 直接隐藏」）。
        if (rounds < 1 || !turn.meta?.sessionKey) return { disabled: true, calls: [], text: '' };
        // 「整会话累计」（0.19.3）——只在**真的补发了一轮**时 +1。上面那道闸之后的
        // 位置是刻意的：没补发的轮（续跑被关 / 无会话键）不计，否则升级点会被
        // 从未发生的事提前触发，界面读数与事实不符。
        // 判据（含「> N 才升级」与「0 = 不升级」两条边界）全在 continueFormFor，
        // 续跑路径只负责取数——策略与执行分开，策略可离线断言。
        const sessionKey = String(turn.meta.sessionKey);
        const completeAfter = Math.max(0, Math.round(Number(cfg.autoContinueCompleteAfter ?? DEFAULT_CONTINUE_COMPLETE_AFTER) || 0));
        // 形态判据用**本次的预期序号**（peek + 1）；真正的 +1 只在补发确认之后落账
        //（见下面的 continueCounter.bump）。这样「整会话累计」只记真的补发了几轮：
        // 发送抛错（RELAY/超时）不占额度，界面读数与事实一致。上面那道闸之后的
        // 位置是刻意的——续跑被关 / 无会话键的轮次根本不计。
        const cumulative = continueCounter.peek(sessionKey) + 1;
        // 判据（含「> N 才升级」与「0 = 不升级」两条边界）全在 continueFormFor，
        // 续跑路径只负责取数——策略与执行分开，策略可离线断言。
        const form = continueFormFor({ cumulative, after: completeAfter });
        // 0.16.25：协议段按**站点**复用 transportNoteFor（与首轮教学同一函数、
        // 逐字同一份文本）。这一轮是「把再教学提示当用户消息补发」，模型看到的
        // 格式指引必须与它首轮被教的完全一致：deepseek 拿官方模板、glm 拿代码块
        // 形状、其余站点拿标签形状。若在这里另写一份或写死某站点的立场，就会
        // 出现「首轮教 A、续跑重申 B」——模型在两者之间摇摆，正是漂移的成因。
        // （noticeText 本身已由 unparsedCallNotice 按官方骨架给出重发示例，这里
        // 补的是**完整协议段**：它带着该站点的格式立场与行为约束。）
        const siteId = turn.meta?.siteId || null;
        const transport = teachFor(siteId, tools);
        // 完整提醒（0.19.3）：累计超过升级点后，把「协议段」换成**会话教学正本**
        // ——它就是首轮真实发出去的那一份（buildPreset + teachFor，与
        // prompts/<site>.md 正文逐字同源），因此带上了首轮才有的工具清单与使用准则。
        // 会话正本缺失（桥重启后接手一个已存在的网页会话，本进程没见过 fresh）时
        // 回落现算：用的还是同一组 builder，区别只在少了 [全局指令]/[本网站指令]
        // 两段用户指令——不是另写一份教学。
        const completeTeaching = form === 'complete'
          ? (siteTeachingBySession.get(sessionKey) || (buildPreset({ tools, siteId }) + teachFor(siteId, tools)))
          : '';
        if (form === 'complete' && !siteTeachingBySession.has(sessionKey)) {
          warn('complete reminder: 会话教学正本缺失（本进程未见过 fresh 轮），本轮现算——少了用户指令两段');
        }
        // 0.16.28：框架前置。真机（session-4f236a51）里模型读到再教学提示会停下来
        // 「回应提醒」而不是「按提醒行动」——续跑轮的开头必须先声明这条消息的身份
        // （系统提示、勿回应），把模型的注意力钉回任务。协议段（transport）保留：
        // 0.16.25 的红线仍然成立——续跑轮看到的格式指引必须与首轮逐字同源，删掉
        // 它等于让模型在两套立场之间摇摆。
        const prompt = '[桥·系统提示] 本条是桥发出的自动化续跑提示，不是用户发言：不要回应、解释或复述它，直接按下面的指示行动并继续任务。\n\n'
          + noticeText
          + '\n\n[自动续跑] 上一轮的工具调用没有被执行（桥没能解析）。请按上面的模板重发那条调用；'
          + '如果任务已经完成或不需要工具，直接给出结论。'
          // 0.19.3：针对真机里最顽固的一种「续跑也救不回来」——模型在思考里打转
          // （「Let me output. / OK. / Writing. / Go.」循环上百字），正文一个字符
          // 都不落，于是下一次续跑又拿到一条 THINKING_ONLY_NO_ANSWER。真机读数：
          // 那条提示里的「思考末尾」整段都是这类自我催促（doc/long-term-issues.md
          // 第 22 条「只出思考、不出正文：未归因」）。旧文案只说了「要做什么」，
          // 没说「什么时候必须落笔」——模型于是继续想，而不是继续做。
          // 只加这一条：把「此刻就输出」写成可判定的动作，并关闭「再想一遍」这个选项。
          + '现在就开始输出，不要再用思考复述计划、也不要反复催促自己；'
          + '这条提示之后的第一段正文，必须直接是调用本身或最终结论。'
          // 完整提醒自带协议段（teachFor 已包含在会话教学正本里），因此两支互斥，
          // 不会把同一份协议文本发两遍。续跑**不停手**：升级只换形态（用户原话
          // 「不能停！继续后续需要 auto！！我需要真实长上下文」）。
          + (completeTeaching
            ? `\n\n[完整提醒·本会话累计第 ${cumulative} 次补发，已超过升级点 ${completeAfter} 次]\n`
              + '下面是本会话首轮真实发给你的完整教学（工具清单、调用格式、使用准则）。'
              + '请照它把上一条调用以**逐字正确**的形状重发；这之后仍会继续自动续跑，不会停手。\n\n'
              + completeTeaching
            : (transport ? `\n\n${transport}` : ''));
        try {
          // fresh 必须钉死 false：executor 按 meta.fresh 决定开不开新网页会话，
          // 而续跑的前提恰恰是「上一轮刚在这个会话里落地」——沿用原 fresh 值会把
          // 首轮的续跑提醒发进一个零上下文的新会话（模型根本不知道自己刚才调了什么）。
          const res = await relay.submit(prompt, { signal: options.signal, meta: { ...turn.meta, fresh: false } });
          const text = String(res?.text || '');
          // 补发**已确认送出**才落账（见上面 cumulative 的口径注释）。
          const delivered = continueCounter.bump(sessionKey);
          const cont = parseAgentReply(text, { tools, jsonQuoteRepair: cfg.jsonQuoteRepair === true });
          // 续跑轮的原始回复同样全量落盘（0.16.17 同一纪律：没有原文就无法离线归因）。
          appendReplyLog(text, {
            sessionId: options?.sessionId ?? null,
            chars: text.length,
            calls: cont.calls.length,
            note: 'auto-continue reply, verbatim',
          });
          if (!text.trim() && !cont.calls.length) {
            log('auto-continue round returned empty reply — 回落为 UNPARSED 提示收场');
            // 形态读数照样带出去：这一轮**确实补发过**，界面不许说成「未补发」。
            return { disabled: false, calls: [], text: '', cumulative: delivered, form };
          }
          log(`auto-continue round: ${text.length} chars, ${cont.calls.length} call(s) parsed, form=${form}, cumulative=${delivered}`);
          return { ...cont, text, cumulative: delivered, form };
        } catch (err) {
          warn(`auto-continue round failed (${String(err?.code || err?.message || err)}) — 回落为 UNPARSED 提示收场`);
          // 发送抛错 = **未确认送出**，因此不落账（额度不占用），也不用一份
          // 「已补发」的读数去顶替：交回 null 让调用方走既有的「补发没发生」分支，
          // 与 0.16.29 的处置逐字同型。
          return null;
        }
      };
      // 续跑进度说明里的三枚读数（累计次数、是否已改用完整提醒、升级点 N）。
      // 八处出口共用这一处口径：免得某一处漏掉「已改用完整提醒」这句话，
      // 界面于是静默少一条归因——那种漏在长会话里最难发现（每一处单看都正常）。
      const continueNoticeFields = (cont) => ({
        cumulative: Math.max(0, Math.round(Number(cont?.cumulative) || 0)),
        complete: cont?.form === 'complete',
        after: Math.max(0, Math.round(Number(cfg.autoContinueCompleteAfter ?? DEFAULT_CONTINUE_COMPLETE_AFTER) || 0)),
      });
      // 续跑回复的散文要走与权威正文同一套协议防线（探到协议痕迹就整段扣住——
      // 续跑回复里出现畸形调用块的概率比正常轮更高，这正是它存在的理由）。
      const safeAutoProse = (raw) => {
        let prose = '';
        try { prose = stripProtocolRegions(raw); } catch { return ''; }
        if (prose && findProtocolStart(prose).index >= 0) {
          warn(`auto-continue prose withheld (${prose.length} chars, 协议痕迹未通过探测)`);
          return '';
        }
        return prose;
      };

      // 与 pure-chat 路径同一组块开关帮助函数（闭包改写上方 let 状态）。
      const openThink = function* () {
        if (thinkOpen) return;
        thinkIndex = nextIndex++;
        yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' };
        thinkOpen = true;
      };
      const closeThink = function* () {
        if (!thinkOpen) return;
        yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
        thinkOpen = false;
      };
      const openText = function* () {
        if (textOpen) return;
        yield* closeThink();
        textIndex = nextIndex++;
        proseBlockStart = proseSent.length;
        yield { type: 'block-start', index: textIndex, blockType: 'text' };
        textOpen = true;
      };
      // 协议边界探测走 findProtocolStart（与 parseAgentReply 共用形态知识）。
      // 0.9.3 及以前这里是一段只认半角标签 / ``` / **Calling: / 裸 { 的行内正则，
      // 认不出 DeepSeek 网页版真实产出的全角 <invoke 形态：boundary 恒为 -1，
      // 协议原文被当正文一路 text-delta 发出去，等收尾 parseAgentReply 认出调用时
      // 已经晚了——真机会话里助手文本存的正是整段 <…>（见 2026-09-11
      // 会话 8e9c538a 的 assistant/message，已固化为 test/fixtures）。
      for (;;) {
        const ev = await nextWithIdle();
        if (ev.think) {
          thinkAcc += ev.think;
          if (!thinkOpen) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' }; thinkOpen = true; }
          yield { type: 'reasoning-delta', index: thinkIndex, text: ev.think };
          continue;
        }
        if (ev.image) { genImages.push(ev.image); continue; }
        if (ev.delta) {
          acc += ev.delta;
          // 0.19.17：已消费协议区间若紧跟着**闭合围栏**，把它一并划进协议区间。
          //
          // 调用的 JSON 配平那一刻它自己的 ` ``` ` 还没到（闭合围栏是随后的增量），
          // 所以上面推进游标时只能停在 JSON 末尾。而 ``` 单独出现不是协议锚点
          // （普通 markdown 代码块也是它）⇒ findProtocolStart 返回 -1 ⇒ 闭合围栏
          // 被当正文发出（离线复现：正文块里多出两块 ` ``` `，见 test/fence-tail.test.mjs）。
          // 判据安全：只在「游标之后只隔空白」时才认，普通散文代码块前面总有散文。
          const cfAdv = closingFenceAfter(acc, protocolFrom);
          if (cfAdv >= 0) protocolFrom = cfAdv + 3;
          // 未消化的部分里找协议起点（半角/全角标签、围栏、Calling、裸 JSON 行）。
          const rest = findProtocolStart(acc, protocolFrom);
          // 单调边界：游标推进后，后续搜索可能又命中**更早**的收尾标签
          // （`</tool_call>` 也是锚点），此时绝不能把 safeEnd 回退——那会把已经
          // 发过的协议原文再当正文发一遍（实测把 `</tool_call>{"mcp_action":...`
          // 整段吐进助手文本）。取历史最大值即可。
          const boundary = rest.index < 0 ? -1 : Math.max(rest.index, lastBoundary);
          // 半成品标记的起点（`<t`、`<tool_cal`、`**Calling:` 前缀…）：正文最多发到
          // 它之前。**必须用「位置」而不是「扣留多少字符」**——用固定 32 字符尾巴
          // 是拦不住的，实测半成品在尾巴之后时照样漏进正文。
          const markerAt = partialProtocolAt(acc);
          // 已被解析消费的协议区间 [textSent 边界, protocolFrom) 不是正文：外发下标
          // 从 protocolFrom 起算。0.12.2 真机（goal 会话 f2cc5438 turn1 step1）实锤：
          // 第一个调用的 JSON 配平、protocolFrom 已越过，但闭标签未到、下一个锚点
          // 未出现（rest.index=-1）时，else 分支把「句子+整个围栏」当正文重新发出
          // ——这就是用户看到的「句子重复 + <tool_call> 原文泄漏」。
          const from = Math.max(textSent.length, protocolFrom);
          // 标签族锚点（<tool_call、</tool_call、全角 DSML 开/闭）之后一律不是正文：
          // transport 依赖 "mcp_action"/工具名在**后文**出现，闭标签永远不满足它。
          // 只认首字符是标签族（<、全角｜、丢头 ｜DSML）——裸 ``` 与裸 { 行（散文
          // 代码块）不受影响，照常外发。
          const tagAhead = rest.index >= 0 && /[<\uFF5C|]/.test(acc[rest.index]);
          // 开启形状边界：围栏/标签开头/```/裸调用 JSON 行/Calling。闭标签（</tool_call>
          // 等）的 transport 也会为 true（下一个调用的 mcp_action 在后文），但它不是
          // 新调用的起点——0.12.3 真机 goal 轮实锤：在闭标签上开块 + 真围栏到达再开
          // 一块，同一调用双块，流式开块 read×8 vs 最终解析 ×5 → TOOL_PROTOCOL_INVALID
          // 整轮作废，goal 从此空转。
          const openerBoundary = rest.index >= 0 && /^\s*(?:<\s*(?:tool_call|tool_calls|function|stories|invoke)\b|```|\{\s*["\{]|\*\*Calling:)/i.test(normalizeOfficialToolCalls(acc.slice(boundary, boundary + 24)));
          // 流式开块只认「该边界的调用对象已经配平」：块名取自配平 JSON 本身，与
          // 收尾 parseAgentReply 同源，名字/数量在结构上不可能错位。代价是不再在
          // 参数流式途中提前显示「正在调用 X」（0.7.1 契约让位于可靠性——错位
          // 作废整轮的代价是长任务 goal 直接空转）。没被流式开块的调用由收尾
          // 循环补发，不受影响。
          const completed = rest.index >= 0 ? readCallAt(acc, boundary) : null;
          let completedName = '';
          let completedNameInferred = false;
          if (completed) {
            try {
              const o = JSON.parse(completed.raw);
              if (o && typeof o?.name === 'string') completedName = o.name;
              // 0.15.9：模型漏写 name 时（真机两轮连发，见 test/nameless-call.test.mjs）
              // 用与收尾解析**同一份**判据先把名字推出来，块才能在流式期间就开对名字、
              // 用户能提前看到「正在调用 read」，而不是等整轮结束才蹦出来。
              // 推不出就退化成「只有 mcp_action」——收尾循环仍会补发，不会丢。
              if (!completedName && o && (o.mcp_action === 'call' || o?.arguments !== undefined)) {
                const guess = inferToolNameFromArgs(normCallArgs(o.arguments ?? o.input ?? o.parameters), tools);
                if (guess) { completedName = guess; completedNameInferred = true; }
              }
            } catch { /* 还没写完或非 JSON */ }
          }
          if (completedNameInferred && completedName) {
            log(`inferred tool name from arguments shape during stream: ${completedName}`);
          }
          const isCallObj = Boolean(completed) && (completedName !== '' || /"mcp_action"\s*:\s*"call"/.test(completed.raw));
          const recognizedCall = isCallObj && openerBoundary && completedName !== ''
            && tools.some(t => t?.name === completedName) && !openedAtIndex.has(boundary);
          // 正文外发区间（单调不减）：
          //  • 疑似调用形态（transport=true）→ 停在该起点：名字通常在参数分片里后到，
          //    若等名字才停，`<tool_call>{"mcp_action"` 会先漏进正文（0.9.6 回归）。
          //  • 标签族锚点已出现但 transport 还认不出（参数分片未到 / 只是闭标签）
          //    → 同样停在该锚点，等下一个增量消歧，绝不越过；
          //  • 其余 → 发到半成品标记之前；没有半成品标记就全发（短尾巴留给
          //    下一次增量消歧）。
          //
          // 前提（0.15.6 写下，免得下次有人以为这里是绝对安全的）：`rest.index < 0`
          // 这一支等价于「探测认为这里没有协议」——**它必须真的可信**。0.15.5 的
          // 围栏窗口取错让 `rest.index` 恒为 -1，正文于是被整段放行（协议泄漏）。
          // 现在两处都修了，且 `proseSafeEnd` 另有独立兜底（见 agent-preset.js 的
          // 同名函数）。改动这一段之前先读那条注释。
          // 0.19.17：尾部「还开着的调用围栏」也必须参与外发上限。
          //
          // 真机缺陷（会话 `session-0b292806` turn2，用户报「正文有空白还有乱码」）：
          // 围栏刚开、JSON 还没吐出 `mcp_action` / `arguments` 的那一小段窗口里，
          // `findProtocolStart` 的围栏判据（体内要有调用关键字段）尚不成立 ⇒ 返回 -1
          // ⇒ 下面只剩 `PROSE_TAIL_CHARS`（8）这个定长尾巴兜底 ⇒ 围栏与 JSON 开头被
          // 当正文一个字符一个字符发出去，且 `textSent` 单调不回退、**收不回来**。
          // 界面上的样子就是助手块里夹着一串 `\n```\n\n` 与 ```` ```json\n{"mcp_actio ````。
          //
          // 判据是纯函数（agent-preset.unresolvedCallFenceAt）：``` 两两配对，落单的
          // 那个还开着，且其后首格是 `{`（调用 JSON）或尚未开始 ⇒ 扣住；普通正文代码块
          // （```js 后面跟代码）不扣，流式观感不受影响。护栏 test/fence-tail.test.mjs。
          const fenceTailAt = unresolvedCallFenceAt(acc, textSent.length);
          let proseLimit = (rest.index >= 0 && rest.transport) ? boundary
            : (rest.index >= 0 && tagAhead) ? boundary
            : (markerAt >= 0 ? markerAt : Math.max(0, acc.length - PROSE_TAIL_CHARS));
          // 取**更小**者：这一条只会让外发变少，永远不会把原本扣住的内容放出去。
          if (fenceTailAt >= 0 && fenceTailAt < proseLimit) proseLimit = fenceTailAt;
          // 无头调用残片（真机 session-c20f43e9，reply-log 逐字）：GLM 流重传调用时
          // 吃掉 JSON 头，留下 `name":"pwsh","purpose":…,"arguments":{…` 夹在两条完整
          // 调用之间。它没有围栏/标签/裸 `{`，边界探测认不出；但它是垃圾不是正文——
          // 扣住不发，等下一个围栏/调用到达后该区间被 protocolFrom 越过、自然消化。
          // 判据见 agent-preset.headlessCallTailAt（只收窄、绝不放宽）。
          // 扫描上界 = 下一个协议边界（若已有）：再往后是完整调用，含 mcp_action，
          // 会让「无 mcp_action」这条判据误判；没有边界时扫到全文结尾。
          const headlessAt = headlessCallTailAt(acc, from, boundary >= 0 ? boundary : acc.length);
          if (headlessAt >= 0) proseLimit = Math.min(proseLimit, headlessAt);
          const safeEnd = Math.max(from, proseLimit);
          const proseChunk = safeEnd > from ? acc.slice(from, safeEnd) : '';
          // 调用标签的残尸（真机 2026-09-14 会话 c7c7a03c step69：两个调用之间流出
          // "</</" 文本块，用户看到「回复夹杂错误调用」）：不含任何字母数字的纯标签
          // 碎片不是内容，按调用间隙的空白同型处理——静默推进游标，不开文本块。
          // 带字母数字的（如 "</div>"、代码示例）照常外发，不受影响。
          // 0.16.8：纯空白**不是**标签残渣。旧判据把空白也归进残渣，命中后静默推进游标、
          // 一个字节都不发；而 PROSE_TAIL_CHARS=8 的滞后让「释放边界恰好切到一个空格或换行」
          // 必然发生。Markdown 是空白敏感的格式，症状正是用户报的「harness 显示格式错乱、
          // web 端正常」：`## 标题` 变 `##标题`、空行消失、围栏缺换行而不闭合。
          // 回归窗口自 0.14.2（引入本判据）；0.9.x 无此分支所以正常。
          // 判据必须**同时**要求「只由标签字符组成」与「至少含一个真标签字符」：
          // 前者排除普通文本，后者排除纯空白。
          // 护栏：test/markdown-block-integrity.test.mjs ⑥（逐字符驱动）。
          const tagOnly = /^[\s<>\/|\uFF5C]+$/.test(proseChunk);
          // 0.16.8 第二层：ASCII 竖线 `|` **不是**标签字符——它是 markdown 表格的分隔符。
          // 旧字符类把它和全角 U+FF5C 一起当成「标签族」，于是表格的每一个 `|` 都被当
          // 残渣吃掉：`| 列 A | 列 B |` 变成 ` 列 A  列 B `，整张表塌成一行文本。
          // 全角 U+FF5C 才是 DSML 标记真身，保留；ASCII `|` 从本类里剔除。
          //
          // 0.16.10 第三层：**孤立的 `<` 不是残渣**，与 0.16.8 修掉的「纯空白」同型。
          // `tagOnly` 判的是「只由标签字符组成」，而单独一个 `<` 恰好满足它，于是被这条
          // 判据静默推进游标吃掉：`textSent` 前进到 `<` 之后，`proseSent` 却一个字节都
          // 没收到——**这个字符永久丢失**，因为收尾的 `proseSent.slice(proseBlockStart)
          // + tail` 里 tail 从 `textSent.length` 起算，已经越过它了。
          //
          // 为什么单独一个 `<` 必然出现（不是理论风险）：上面 `proseLimit` 的
          // `markerAt >= 0 ? markerAt : …` 那一支会在尾部出现半成品标记候选时把外发
          // 边界停在那个 `<` 上，而 `partialProtocolAt` 对 `<` + 任意已知标记名前缀
          // （`<b` `<c` `<f` `<i` `<s` `<t` `<a` `<T` …）都返回该 `<` 的下标。于是
          // 「增量恰好切在 `<` 之后」时，下一次增量的 `proseChunk` 就是这一个 `<`。
          // 这在真实网页流里很常见：HTML 片段、`Array<T>` 这类泛型、以及正文里解释
          // `<tool_call>` 形状的示例，任何一个被增量边界切开都会命中。
          //
          // 真机复现（.tmp-probe/probe-tail-loss.mjs，逐字驱动真实 adapter.stream）：
          //   deltas ['函数 <f','oo> 定义。'] ⇒ 权威 '函数 <foo> 定义。'(12)
          //     实际送达 '函数 foo> 定义。'(11) —— `<` 被吞。
          //
          // 判据修正：残渣只保留「闭合/结构片段」。**光秃秃一个 `<` 是正文，照常外发**；
          // `</` 这类调用标签残尸（真机 2026-09-14 会话 c7c7a03c step69 的 `</</`）
          // 仍按残渣静默处理。取向与 0.16.8 一致：宁可多发一个字符，不可静默吞掉
          // 用户可见的正文。护栏：test/stream-tail.test.mjs 的「孤立 `<`」两条。
          const hasTagChar = /[<>\/\uFF5C]/.test(proseChunk);
          const tagDebris = tagOnly && hasTagChar && proseChunk !== '<';
          if (proseChunk && !tagDebris && (pendingCalls.length === 0 || proseChunk.trim())) {
            yield* openText();
            textSent = acc.slice(0, safeEnd);
            proseSent += proseChunk;
            yield { type: 'text-delta', index: textIndex, text: proseChunk };
          } else if (proseChunk) {
            // 调用之间的纯空白（闭标签与下一个围栏之间的换行）不是正文：静默推进
            // 游标，不开文本块也不发 delta——否则每次调用间隙都会开一个只有换行的
            // 文本块，把界面刷成噪音。
            textSent = acc.slice(0, safeEnd);
          }
          if (recognizedCall) {
            // 同一个调用在流式期间会被反复命中同一个边界，按边界下标去重保证只开一次块。
            lastBoundary = boundary;
            // raw 必须随块保存：收尾若发现权威全文与增量通道分叉（decoder 对
            // fragments 的静默替换不补发增量），这块要用它自己配平的 JSON 收口，
            // 否则参数就没了唯一可信出处（见下方 mismatch 分叉修复）。
            const opened = { name: completedName, id: callId(pendingCalls.length), index: nextIndex++, at: boundary, raw: completed.raw };
            openedAtIndex.set(boundary, opened);
            pendingCalls.push(opened);
            // 散文块到此为止。块内容必须与「本块开启后外发的 text-delta」逐字一致
            // （proseSent.slice(proseBlockStart)）：一轮多调用会开多个文本块，发累计
            // 值用户就会看到同一句话重复 N 次。
            if (textOpen) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: proseSent.slice(proseBlockStart) } }; textOpen = false; }
            yield { type: 'block-start', index: opened.index, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index: opened.index, id: opened.id, name: opened.name, argumentsDelta: '' };
          }
          // 调用对象已配平：把游标推到该对象末尾。闭标签边界的 completed 认出的
          // 是**下一个**调用的 JSON（闭标签自己没有 JSON）——同样消费掉，不开块
          // （收尾循环会补发），这样闭标签永远不会再挡住后续锚点。
          if (isCallObj && completed.end > protocolFrom) {
            protocolFrom = completed.end;
            // 闭合围栏常与 JSON 同一个增量到达；这里顺手越过，免得下一次增量
            // 从它开头重扫（上面的 closingFenceAfter 是增量边界切开时的兜底）。
            const cf = closingFenceAfter(acc, protocolFrom);
            if (cf >= 0) protocolFrom = cf + 3;
          }
          continue;
        }
        if (ev.err) throw ev.err;
        end = ev.end;
        break;
      }
      await settled;
      // 网页侧部分断流时 decoder 可能带回空 text——已解出的正文以流式增量为准，
      // 不能让空串把已流出的内容判成「空回复」或触发 STREAM_REWRITE。
      let finalText = (end?.text ?? '') || acc || '';
      const endImages = Array.isArray(end?.images) && end.images.length ? end.images : genImages;
      assertNonEmpty(finalText, thinkAcc, endImages);

      const { calls, diagnostics } = parseAgentReply(finalText, { tools, jsonQuoteRepair: cfg.jsonQuoteRepair === true });
      // 0.16.17：每轮原始回复全文落盘（lib/reply-log.js）。0.16.13 的「扣留全文进
      // 日志」走 console.warn，只到 DSH 进程 stderr、运行时不持久化——run-8 扣留
      // 1474 字符后磁盘上只剩提示里的 200 字符头，归因第三次断链（用户明确要求
      // 保留原接收内容日志）。写失败静默（模块内吞掉），绝不影响回合交付。
      const replyLogPath = appendReplyLog(finalText, {
        sessionId: options?.sessionId ?? null,
        chars: finalText.length,
        calls: calls.length,
        note: 'raw reply, verbatim',
      });
      // 0.16.26：**思考通道也落盘**。真机（session-181c23b1，2026-09-19 15:17:46）
      // 出现过 `chars=0 | calls=0` 的一轮：正文一个字符都没有、调用写在思考里，
      // 而 0.16.17 的原始回复日志只记正文通道——磁盘上除了「这轮是空的」什么都看不到，
      // 归因第四次断链。思考全文是与正文同级的取证数据，必须一并留存。
      if (thinkAcc) {
        appendReplyLog(thinkAcc, {
          sessionId: options?.sessionId ?? null,
          chars: thinkAcc.length,
          calls: 0,
          note: 'raw thinking, verbatim',
        });
      }
      // 0.15.6：**丢调用不再静默**。旧实现的 `takeObj` 把「看起来是调用、但解析
      // 不出来」和「这段本来就不是调用」压成同一个结果，一次丢调用在会话、在 UI、
      // 在日志里都不留痕——参数含 markdown 围栏的 write 调用被丢、报告从未落盘，
      // 就是这样躲过全部既有断言的（真机回归，见 test/fence-nested-call.test.mjs）。
      // 诊断文本含协议片段，属于排查线索，只进日志不进会话正文。
      if (diagnostics?.length) {
        for (const d of diagnostics.slice(0, 3)) warn(`parse: ${d}`);
      }
      // 缺 name 的调用按参数形状还原后**必须留痕**（0.15.9）：与「静默修复」划清界限，
      // 也让下一次归因能从日志里直接看到网页漏写了 name 这件事发生了几次。
      if (calls.some((c) => c.nameInferred)) {
        log(`inferred tool name(s) for nameless call(s): ${calls.filter((c) => c.nameInferred).map((c) => c.name).join(', ')}`);
      }
      let valid = calls.filter((c) => tools.some((t) => t?.name === c.name));
      // GLM-5.3 强制思考（reference/zai-copilot-chat 的 dialect 佐证：5.3 起思考
      // 不可关）：真机确认模型会把工具调用写进思考流而不是正文，正文解析不到时
      // 从思考全文兜底解析一次。正文已有可用调用时不看思考——思考里的可能是
      // 预演草稿，照单全收会双重执行。
      if (!valid.length && thinkAcc) {
        const thinkCalls = parseAgentReply(thinkAcc, { tools }).calls.filter((c) => tools.some((t) => t?.name === c.name));
        if (thinkCalls.length) valid = thinkCalls;
      }
      // 网页调了本会话没有的工具（真机里模型调过未登记的 write / subagent）。
      // 旧实现静默过滤 → 剩下空回复被当收束 → 任务从此不动。这里**不抛错**而是
      // 把「可用工具清单 + 请重试」作为这一轮的回复交回会话：错误文本会作为助手
      // 消息留在会话里，下一轮模型据此改正，任务不会停摆（抛错会整轮作废、
      // 界面上只看到一次失败，用户得手动再催）。
      const unknownNames = calls.map((c) => c.name).filter((n) => !tools.some((t) => t?.name === n));
      if (!valid.length && unknownNames.length) {
        turn.commit();
        yield* closeThink();
        const available = tools.map((t) => t?.name).filter(Boolean);
        // 0.16.19：出现 TOOL_UNKNOWN 时自动带**官方格式再教学**（用户明确要求
        // 「出现这个时候自动返回提示词，好让会话继续」）——示例用真实工具名，
        // 并点名「骨架占位符/文档示例不是调用」（run-9：模型把教学骨架抄进
        // 代码块举例，占位名被当真执行）。
        const sample = officialCallExampleFor(tools);
        const notice = `TOOL_UNKNOWN: 网页发出了本会话不存在的工具调用（${[...new Set(unknownNames)].join(', ')}）。`
          + `本会话只有这些工具：${available.join(', ') || '（无）'}。`
          + `请按官方模板改用真实工具名重新发起：${officialToolCallSpecimen(sample.name, sample.args)}`
          + '——骨架与文档里的「工具名」等只是占位符，示例形状不是调用，只有真实工具名才会执行；'
          // 0.16.20：点名 run-10 的两个真实漂移（旧文案只打「name 不能省」，没打到
          // 斜杠闭 token 与漏 per-call begin，run-10 里模型连抄三轮坏形状没被纠正）。
          + '重发注意：收尾 token 不带斜杠，每条调用都要用成对的 call-begin/call-end 包住、'
          + '多条共用同一对 calls-begin/calls-end；'
          + '如果任务不需要工具，请直接给出结论。';
        warn(notice);
        // 0.16.27 自动续跑：这一支与 UNPARSED / thinking-only 是**同一个病**——
        // 交回一条纯文本再教学后，agent 循环把它当最终答案收场。用户原话点名了
        // 这一类：「尤其是意外错误工具调用引起的-web 端调用技能因为是文本告知会有
        // 偏移」——模型调了本会话没有的工具名（或把教学骨架里的占位名当真），
        // 桥把清单与模板交回去，但**循环已经停了**，模型没有下一次机会改。
        // 处置与 0.16.25/0.16.26 逐字同型：把提示补发进**同一个网页会话**收第二轮，
        // 解析出真实工具名的调用就照常派发（finish=tool-calls，循环存活）。
        const cont = await autoContinueRound(notice);
        if (cont && !cont.disabled) {
          const contValid = cont.calls.filter((c) => tools.some((t) => t?.name === c.name));
          const contProse = safeAutoProse(cont.text);
          // 0.16.29（用户指令）：与 UNPARSED 同处置——再教学提示全文只作为补发的
          // 用户消息发给模型（autoContinueRound 里逐字发出、逐字落 reply-log），
          // **不再当正文铺进会话**，界面只留一句 AUTO_CONTINUED 进度说明。
          // 0.16.27 曾要求把 notice 外发（让用户看见桥为什么重试）；0.16.29 改由
          // AUTO_CONTINUED 一行承担同一告知职责，细节留在 reply-log 里可查。
          // 唯一例外：补发**根本没发生**（cont.disabled）时仍交回 notice 原文，
          // 因为那条通道不存在了，提示是唯一归因来源（见下面 emitText 兜底）。
          if (contValid.length) {
            const text = autoContinuedNotice({ calls: contValid.length, ...continueNoticeFields(cont) })
              + (contProse ? `\n\n${contProse}` : '');
            yield* emitFollowUp(text);
            yield* emitCallBlocks(contValid, 'auto-continued after TOOL_UNKNOWN round');
            yield* finishChunks(turn, text + thinkAcc + cont.text, 'tool-calls');
            return;
          }
          if (contProse) {
            const text = autoContinuedNotice({ ...continueNoticeFields(cont) }) + `\n\n${contProse}`;
            yield* emitFollowUp(text);
            yield* finishChunks(turn, text + thinkAcc, 'stop');
            return;
          }
        }
        // index 传 nextIndex：上面 closeThink() 已经关掉了思考块（它占用 0），
        // 写死 0 会让正文块与已关闭的 reasoning 块撞下标。
        yield* emitText(notice, turn, nextIndex);
        return;
      }
      // 流式期间已开块的调用必须与最终解析结果对齐。不对齐有两种来历：
      // a) 协议形状中途漂移、参数会落到错误的块上（0.12.4 契约建此防线的原因）；
      // b) 权威全文与增量通道分叉——decoder 对 fragments 的静默替换不补发增量
      //    （lib/decoder.js consumeResponse / response/fragments SET），真机
      //    2026-09-14 会话 c7c7a03c 两个方向都实锤：step70 canonical 多出 grep
      //    （「流式已开块 read；解析 grep, read」）、turn2 step7 canonical 丢失
      //    edit（「流式已开块 edit；解析结果无」），旧实现一律整轮作废，
      //    长任务 goal 从此空转、用户手动重催。
      // 流式块保存了开块时已配平的 JSON（p.raw，模型增量通道真实发出的形状），
      // 所以 b 类可以修复而非作废：流式块用它自己的 JSON 收口，权威解析中没被
      // 流式块覆盖的调用补发新块。a 类（真漂移）没有可信参数出处，仍作废。
      const mismatch = pendingCalls.findIndex((p, i) => valid[i]?.name !== p.name);
      if (mismatch >= 0 && pendingCalls.some((p) => !p.raw)) {
        turn.invalidate?.();
        throw new Error('TOOL_PROTOCOL_INVALID: 工具参数不完整或调用顺序不一致'
          + `（流式已开块：${pendingCalls.map(p => p.name).join(', ') || '无'}；`
          + `解析结果：${valid.map(c => c.name).join(', ') || '无'}）`);
      }
      if (mismatch >= 0) {
        warn('tool protocol divergence — repairing from streamed JSON'
          + `（流式已开块：${pendingCalls.map(p => p.name).join(', ') || '无'}；`
          + `解析结果：${valid.map(c => c.name).join(', ') || '无'}）`);
        // 第 k 个同名流式块对应第 k 个同名权威调用（同名多调用按出现序一一配对，
        // 2026-09-10 真机一轮三个 read 的形状）；canonical 里对不上的（丢失/改名）
        // 用流式块自己的 JSON。配对成功的优先取权威参数——它经过完整解析与抢救。
        const nameCounters = new Map();
        const validUsed = new Array(valid.length).fill(false);
        for (const p of pendingCalls) {
          const k = nameCounters.get(p.name) ?? 0;
          nameCounters.set(p.name, k + 1);
          let seen = -1;
          p.paired = -1;
          for (let i = 0; i < valid.length; i++) {
            if (valid[i].name !== p.name) continue;
            seen++;
            if (seen === k) { p.paired = i; validUsed[i] = true; break; }
          }
        }
        turn.commit();
        yield* closeThink();
        for (const p of pendingCalls) {
          const parsed = p.paired >= 0
            ? valid[p.paired]
            : (parseAgentReply(p.raw).calls.find((c) => c.name === p.name) || null);
          if (!parsed) continue; // 理论不可达：raw 在开块时已配平且带 name
          const target = tools.find((t) => t?.name === parsed.name) || null;
          const { args: fixedArgs, coerced } = coerceArguments(parsed.arguments, target?.parameters);
          const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, parsed.purpose);
          if (filled.length) log(`filled missing required args for ${parsed.name}: ${filled.join(', ')}`);
          if (coerced.length) log(`coerced args for ${parsed.name}: ${coerced.join(', ')}`);
          const args = JSON.stringify(filledArgs);
          yield { type: 'tool-call-delta', index: p.index, id: p.id, name: parsed.name, argumentsDelta: args };
          yield { type: 'block-end', index: p.index, block: { type: 'tool-call', id: p.id, name: parsed.name, arguments: args } };
        }
        for (let i = 0; i < valid.length; i++) {
          if (validUsed[i]) continue;
          const id = callId(pendingCalls.length + i);
          const index = nextIndex++;
          const target = tools.find((t) => t?.name === valid[i].name) || null;
          const { args: fixedArgs, coerced } = coerceArguments(valid[i].arguments, target?.parameters);
          const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, valid[i].purpose);
          if (filled.length) log(`filled missing required args for ${valid[i].name}: ${filled.join(', ')}`);
          if (coerced.length) log(`coerced args for ${valid[i].name}: ${coerced.join(', ')}`);
          const args = JSON.stringify(filledArgs);
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, name: valid[i].name, argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: valid[i].name, arguments: args } };
        }
        yield* finishChunks(turn, finalText + thinkAcc, 'tool-calls');
        return;
      }
      if (valid.length) {
        turn.commit();
        yield* closeThink();
        if (textOpen && !pendingCalls.length) {
          // 流式收尾还扣着 PROSE_TAIL_CHARS 尾巴没发（正文无协议边界、调用来自
          // 思考兜底的 GLM-5.3 场景）：先补上再收口，否则正文尾巴被永远扣住。
          //
          // T2-D：权威散文**不能**用 stripProtocolText 算。那个函数在第一个协议
          // 起点处截断，于是「调用之后的那段正文」在这里被整段丢掉——真机症状是
          // 「话说到一半就没了」，护栏是 test/markdown-block-integrity.test.mjs ③
          // （权威全文 = PROSE1 + CALL + PROSE2，增量只送 PROSE1 → 实测块内容只剩
          // PROSE1，PROSE2 一个字节都不进会话）。stripProtocolRegions 把协议区间
          // **挖掉**、两侧散文都留下，正好是「块内容 = 权威散文」需要的语义。
          const prose0 = proseSent.slice(proseBlockStart);
          const clean = stripProtocolRegions(finalText);
          let missing = (clean.startsWith(prose0) && clean.length > prose0.length) ? clean.slice(prose0.length) : '';
          // T2-C 安全线：补发的这段是**新外发**的字节，所以它自己必须过一遍协议
          // 探测——区间定位一旦失手（未知形态、闭合标签错配），宁可退回旧行为
          // （少补一段正文）也绝不让协议原文进 text-delta / 块内容。
          if (missing && findProtocolStart(missing).index >= 0) {
            warn(`withheld ${missing.length} chars of unverified prose patch (协议痕迹未通过探测，按旧行为不补发)`);
            missing = '';
          }
          if (missing) { textSent += missing; proseSent += missing; yield { type: 'text-delta', index: textIndex, text: missing }; }
          const imageMd = imageMarkdown(endImages);
          if (imageMd) { textSent += imageMd; proseSent += imageMd; yield { type: 'text-delta', index: textIndex, text: imageMd }; }
          // 兜底：边界探测若漏掉某种未知形态，这里仍保证写进会话的助手文本是散文。
          // 正常路径下探测已把协议拦在外面，stripProtocolText 是恒等变换。
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: proseSent.slice(proseBlockStart) } };
        }
        for (let i = 0; i < valid.length; i++) {
          // id carries the session so harness-side streams / logs can be traced
          // back to the web conversation that produced the call.
          // 0.7.1：流式期间已提前开块的调用必须在这里复用同一个 index/id 补发参数
          // 并关闭——真实会话（2026-09-08 f3fa97fd）暴露旧实现另开新 index 重发一遍，
          // Harness 收到同 id 两条调用：先空参数执行一次（INVALID_ARGS 假错误），
          // 再真参数重复执行。现在按位置复用，所以第 2、3 个调用同样不会重复。
          const reuse = pendingCalls[i] || null;
          const id = reuse ? reuse.id : callId(i);
          const index = reuse ? reuse.index : nextIndex++;
          // 参数形状纠偏：网页高频把数字写成字符串、把数组写成单对象（真机 64 次
          // 工具报错全部属于这一类）。只按 schema 显式声明的类型做无歧义纠偏。
          const target = tools.find((t) => t?.name === valid[i].name) || null;
          const { args: fixedArgs, coerced } = coerceArguments(valid[i].arguments, target?.parameters);
          // 缺失必填补齐：DSH 会因 description 这类纯描述字段缺失整次拒绝
          // （真机 GLM 调 pwsh 只给 command 被拒，模型陷入重试死循环）。
          // purpose 优先、命令前缀兜底，补不出就保持缺失，让 DSH 报自己的错。
          const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, valid[i].purpose);
          if (filled.length) log(`filled missing required args for ${valid[i].name}: ${filled.join(', ')}`);
          if (coerced.length) log(`coerced args for ${valid[i].name}: ${coerced.join(', ')}`);
          const args = JSON.stringify(filledArgs);
          if (!reuse) yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, ...(reuse ? {} : { name: valid[i].name }), argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: valid[i].name, arguments: args } };
        }
                yield* finishChunks(turn, finalText + thinkAcc, 'tool-calls');
        return;
      }

      if (!textOpen) {
        turn.commit();
        yield* closeThink();
        const imageMd = imageMarkdown(endImages);
        // 0.15.0 真机修复（会话 e5cb719c step6 / session-a6835ca1 step22）：
        // 「没有调用」**不等于**「全文都是正文」。断流的轮次（no_response_frames /
        // stream_ended_before_finished）里，协议边界探得到、调用却因参数只到一半而
        // 解析不出——旧实现在这里把 finalText 整段当正文发，255 字符（另一例
        // 21,905 字符）的 DSML 协议原文就是这样被写进会话并持久化的。
        // 判据只有一个：proseSafeEnd 复用边界探测的同一套形态知识。
        const safe = proseSafeEnd(finalText, textSent.length);
        const prose = finalText.slice(0, safe);
        const out = imageMd ? prose + imageMd : prose;
        // 被扣住的协议尾巴必须留痕：静默丢弃会让「模型这轮什么都没干」与
        // 「模型调用了但流断了」在日志里长得一模一样，下一次没人能归因。
        const withheld = finalText.length - safe;
        if (withheld > 0) {
          warn(`withheld ${withheld} chars of protocol text from assistant prose`
            + `（边界探测已命中但没有可执行的完整调用：本轮按断流处理，未把协议原文外发）`);
        }
        // 整段正文都被协议占满（safe === 0）时 out 为空——此时**不能**走 emitText
        // 的空回复路径把整轮判死。断流轮的正确语义是「本轮没有可交付正文」，
        // 交给上层按已有工具结果继续，而不是抛 empty response。
        //
        // 0.15.5 修复（真机实证，子代理会话 ecad7b6a step2）：旧实现把这条判定
        // **放在「只有思考」之前**，于是漏掉了一整类零进展轮——网页把全部内容都从
        // 思考通道送来（实测 thinkAcc=201 字符英文推理、正文空、
        // `usage.outputTokens: 0`、`turn/end reason: completed`），收尾时 finalText
        // 非空却被边界探测判为协议（withheld > 0）→ 直接静默 stop。
        // 后果是 agent loop 认为本轮「无事完成」：子代理零产出（两篇笔记 MISSING、
        // reference/ 无任何新克隆），而 thinkAcc 明明有内容。
        //
        // 正确顺序：**先判「只有思考」，再判「正文全是协议」**。前者有思考可归因，
        // 必须给出提示让任务继续；后者才是真正的「本轮没有可交付正文」。
        //
        // 0.15.2 原设计（纯聊天轮同型）：旧实现在这里无条件
        // assertNonEmpty(out, '', []) —— 第二个实参写死空串，于是「思考全文都在、
        // 正文为空」被判成 `empty response from web AI`，归因线索就此抹掉。
        // 处置与 TOOL_UNKNOWN 同型：**不抛错**，把带现场的提示作为本轮回复交回会话。
        const decision = zeroProgressDecision({ out, thinkAcc, withheld, imageCount: endImages.length });
        // 0.15.9：协议被探测到、却一条可执行调用都没解析出来 —— 这不是「只有思考」。
        // 必须放在 zeroProgressDecision **之前**：那两条分支各自都会把事实说错——
        // thinking-only 声称「网页只产出了思考内容」（真机里网页明明发了调用），
        // protocol-withheld 直接静默收束（界面上一片空白）。第 4 种事实是
        // 「网页发了调用、桥没认出来」，它有自己的提示与自我改正路径。
        if (withheld > 0 && !calls.length) {
          // 扣留全文进日志（只进日志、不进会话）：真机漂移每次形状不同且头部
          // 200 字符可能完全正常（run-3 实测），没有全量原文就无法离线归因。
          // 0.16.17 起全文随每轮原始回复落 `~/.dsh/logs/webcode-bridge-replies.log`
          // （replyLogPath 在上方 parseAgentReply 之后已写入）；console 这条降级为
          // 指路——旧实现把全文打到 stderr，DSH 运行时不持久化 stderr，等于没落盘
          // （run-8 实证：1474 字符全文只剩 200 字符头）。
          warn(`withheld protocol text (log-only full copy): ${replyLogPath || 'reply-log unavailable, see lib/reply-log.js'}`);
          // 0.16.12 恢复派发：无人值守循环把「纯文本提示轮」当最终答案收场
          // （长跑第 2/3 轮分别死在 13 分钟 / 8 分钟）。白名单只读工具且参数
          // 可读时，把模型本就打算发起的调用送达——循环靠工具结果存活；
          // 白名单外维持 UNPARSED 提示，绝不放宽。
          const recovered = recoverUnparsedCalls(finalText, tools);
          if (recovered.length) {
            const notice = recoveredCallNotice({ count: recovered.length, scene: idleScene(), withheld });
            warn(notice);
            yield* closeThink();
            for (const rc of recovered) {
              const idx = nextIndex++;
              const id = callId(idx);
              const target = tools.find((t) => t?.name === rc.name) || null;
              const { args: fixedArgs } = coerceArguments(rc.arguments, target?.parameters);
              const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, 'recovered from unparsed protocol block');
              if (filled.length) log(`filled missing required args for recovered ${rc.name}: ${filled.join(', ')}`);
              const args = JSON.stringify(filledArgs);
              yield { type: 'block-start', index: idx, blockType: 'tool-call' };
              yield { type: 'tool-call-delta', index: idx, id, name: rc.name, argumentsDelta: args };
              yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: rc.name, arguments: args } };
            }
            yield* openText();
            const text = (out ? out + '\n\n' : '') + notice;
            yield { type: 'text-delta', index: textIndex, text };
            yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
            yield* finishChunks(turn, (out || '') + thinkAcc, 'tool-calls');
            return;
          }
          const notice = unparsedCallNotice({ thinkAcc, tools, scene: idleScene(), withheld, head: finalText.slice(safe, safe + 200), diagnostic: diagnostics[0] || '' });
          warn(notice);
          // 0.16.25 自动续跑：把提示作为用户消息补发进同一网页会话并收第二轮回复。
          // 第二轮解析出可执行调用就照常派发（finish=tool-calls，循环存活）；
          // 续跑失败/仍无调用则回落「提示当正文」收场（与旧行为逐字同型）。
          const cont = await autoContinueRound(notice);
          if (!cont || cont.disabled) {
            // 补发**根本没发生**（autoContinueRounds=0 或无会话键的无状态轮）：
            // 再教学提示是唯一通道，必须照旧当正文交回，否则模型与用户都拿不到
            // 「这轮为什么没执行」的归因。
            if (cont?.disabled) {
              yield* emitText(out ? `${out}\n\n${notice}` : notice, turn, nextIndex);
              return;
            }
            // 补发过了、模型仍然没能给出可执行调用：界面上只给一句可行动的归因，
            // 不铺再教学提示全文（0.16.29 用户指令）。
            const fallback = autoContinuedNotice({ disabled: true });
            yield* emitText(out ? `${out}\n\n${fallback}` : fallback, turn, nextIndex);
            return;
          }
          const contValid = cont.calls.filter((c) => tools.some((t) => t?.name === c.name));
          const contProse = safeAutoProse(cont.text);
          // 0.16.29（用户指令）：再教学提示（TOOL_CALL_UNPARSED 全文）只作为补发的
          // 用户消息发给模型（见 autoContinueRound），**不再当正文显示在会话里**——
          // 界面只留一句 AUTO_CONTINUED 进度说明。提示全文仍逐字补发、仍落 reply-log。
          const text = (out ? `${out}\n\n` : '')
            + autoContinuedNotice({ calls: contValid.length, final: !contValid.length, ...continueNoticeFields(cont) })
            + (contProse ? `\n\n${contProse}` : '');
          yield* emitFollowUp(text);
          yield* emitCallBlocks(contValid, 'auto-continued after unparsed round');
          yield* finishChunks(turn, text + thinkAcc + cont.text, contValid.length ? 'tool-calls' : 'stop');
          return;
        }
        if (decision === 'thinking-only') {
          const notice = thinkingOnlyNotice(thinkAcc, idleScene());
          warn(notice);
          // 0.16.26 自动续跑：这一支与 UNPARSED 是**同一个病**——交回一条纯文本提示
          // 后 agent 循环把它当最终答案收场，长任务就此停摆。真机 session-181c23b1
          // （2026-09-19 15:17:46，reply-log `chars=0 | calls=0`）就是它：WIP 稳态收束
          // （`partial-wip-settled`）在模型刚想完、还没落笔调用时把这一轮截断，
          // 正文空、思考里有半截推理，于是「思考完就没下文」。
          // 用户要求很明确：deepseek 会话要能长期跑，不许每次遇到就断。
          // 处置与 0.16.25 的 UNPARSED 续跑逐字同型：把提示作为用户消息补发进**同一
          // 个网页会话**收第二轮，解析出调用就照常派发（finish=tool-calls，循环存活）；
          // 无调用但有散文就按最终答复收场；两头都落空才回落旧的「提示当正文」。
          const cont = await autoContinueRound(notice);
          if (cont && !cont.disabled) {
            const contValid = cont.calls.filter((c) => tools.some((t) => t?.name === c.name));
            const contProse = safeAutoProse(cont.text);
            // 0.16.29：thinking-only 的归因提示同样只走补发通道，不再铺进正文
            // （与 UNPARSED / TOOL_UNKNOWN 三处一致）。
            if (contValid.length) {
              const text = autoContinuedNotice({ calls: contValid.length, ...continueNoticeFields(cont) })
                + (contProse ? `\n\n${contProse}` : '');
              yield* closeThink();
              yield* emitFollowUp(text);
              yield* emitCallBlocks(contValid, 'auto-continued after thinking-only round');
              yield* finishChunks(turn, text + thinkAcc + cont.text, 'tool-calls');
              return;
            }
            if (contProse) {
              const text = autoContinuedNotice({ ...continueNoticeFields(cont) }) + `\n\n${contProse}`;
              yield* closeThink();
              yield* emitFollowUp(text);
              yield* finishChunks(turn, text + thinkAcc, 'stop');
              return;
            }
          }
          // closeThink() 已关掉思考块，正文必须用新的下标，不能写死 0。
          yield* emitText(notice, turn, nextIndex);
          return;
        }
        if (decision === 'protocol-withheld') {
          yield* finishChunks(turn, '', 'stop');
          return;
        }
        assertNonEmpty(out, '', []);
        yield* emitText(out, turn);
        return;
      }
      if (!finalText.startsWith(textSent)) throw new Error('STREAM_REWRITE: 网页重写了已输出内容');
      turn.commit();
      const imageMd = imageMarkdown(endImages);
      if (imageMd) finalText += imageMd;
      // 单调边界：正文最多发到 proseSafeEnd 允许的位置。这一条与上面 !textOpen 分支
      // 是同一个洞的两个出口——真机 21,905 字符那条泄漏走的正是这里：流式期间正文块
      // 已经开过（textOpen=true），收尾时 finalText 里那 21,905 字符协议原文被
      // slice(textSent.length) 一次全发了出去。textSent 由流式循环维护，它记的是
      // 「已经发到哪」，不是「最多能发到哪」——两者在断流轮里不相等。
      const proseLimit = proseSafeEnd(finalText, textSent.length);
      let tail = finalText.slice(textSent.length, proseLimit);
      const withheld = finalText.length - proseLimit;
      if (withheld > 0) {
        warn(`withheld ${withheld} chars of protocol text from assistant prose tail`);
      }
      // 正文块已经开过（textOpen）时同样不能只把散文尾巴发出去：协议被扣住、
      // 可执行调用为 0 的那一类轮次（真机 2026-09-16，页面发的是缺 name 的调用）
      // 在界面上长得像「模型只说了半句话就没下文」。把真实原因与重发格式接在同一
      // 个文本块里——tail 同时用于 text-delta 与 block-end 的块内容，接在这里
      // 两处逐字一致，不会出现「块内容比外发的 delta 多一段」的错位。
      let recoveredCalls = null;
      let unparsedNotice = null;
      if (withheld > 0 && !calls.length) {
        warn(`withheld protocol text (log-only full copy): ${finalText.slice(proseLimit)}`);
        recoveredCalls = recoverUnparsedCalls(finalText, tools);
        if (recoveredCalls.length) {
          const notice = recoveredCallNotice({ count: recoveredCalls.length, scene: idleScene(), withheld });
          warn(notice);
          tail = tail ? `${tail}\n\n${notice}` : notice;
        } else {
          // 0.16.29（用户指令）：再教学提示**不接进 tail**——tail 会作为正文外发。
          // 它只存进变量，由下面的 autoContinueRound 作为补发的用户消息发给模型。
          unparsedNotice = unparsedCallNotice({ thinkAcc, tools, scene: idleScene(), withheld, head: finalText.slice(proseLimit, proseLimit + 200), diagnostic: diagnostics[0] || '' });
          warn(unparsedNotice);
        }
      }
      // 块内容必须与外发的 delta 逐字一致，否则界面上这一块会凭空多出协议原文。
      // 因此 delta 必须在 tail 定稿（可能接了 unparsedCallNotice）之后才发。
      //
      // 0.16.4：**流式期间没开过文本块时必须先开块**。真机形态：正文只存在于网页给的
      // 权威全文里（增量通道只送了调用之前的散文，甚至什么都没送），于是
      // `textIndex` 还是初值 -1、`textOpen` 为 false；旧写法直接用 -1 发
      // `text-delta` 与 `block-end`，把这一段正文挂在一个**从未 block-start 的下标**上。
      // 界面上就是用户报的「有些 markdown 渲染有些不渲染」——文本在权威全文里，
      // 却被写进了一个不存在的块。
      // 护栏：`test/markdown-block-integrity.test.mjs` ③（块内容必须等于权威散文）。
      if (tail) {
        yield* openText();
        yield { type: 'text-delta', index: textIndex, text: tail };
      }
      const proseBlock = proseSent.slice(proseBlockStart) + tail;
      // 0.16.29：tail 现在可能为空（再教学提示不再接进来），而 textIndex 只有在
      // openText() 之后才有效。空正文且流式期间也没开过块时跳过 block-end，
      // 不要往一个从未 block-start 的下标上挂内容（0.16.4 修的是同一件事）。
      if (tail || proseBlock) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: proseBlock } };
      }
      yield* closeThink();
      if (recoveredCalls?.length) {
        // 恢复派发（0.16.12）：正文块照发，调用块跟在后面，finish 用 tool-calls
        // 让 agent 循环继续——无人值守下纯文本轮等于提前终止。
        for (const rc of recoveredCalls) {
          const idx = nextIndex++;
          const id = callId(idx);
          const target = tools.find((t) => t?.name === rc.name) || null;
          const { args: fixedArgs } = coerceArguments(rc.arguments, target?.parameters);
          const { args: filledArgs, filled } = fillMissingRequired(fixedArgs, target?.parameters, 'recovered from unparsed protocol block');
          if (filled.length) log(`filled missing required args for recovered ${rc.name}: ${filled.join(', ')}`);
          const args = JSON.stringify(filledArgs);
          yield { type: 'block-start', index: idx, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: idx, id, name: rc.name, argumentsDelta: args };
          yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: rc.name, arguments: args } };
        }
        yield* finishChunks(turn, proseBlock + thinkAcc, 'tool-calls');
        return;
      }
      // 0.16.25 自动续跑（正文块已收口的出口）：与 !textOpen 出口同一语义——把
      // UNPARSED 提示补发进同一网页会话收第二轮；有调用照常派发（tool-calls），
      // 有散文就作为最终答复收场，两头都不落空才回到既有的纯文本 stop 收场。
      if (unparsedNotice) {
        const cont = await autoContinueRound(unparsedNotice);
        if (cont?.disabled) {
          // 0.16.29：补发通道不存在（autoContinueRounds=0 / 无会话键）时，提示是
          // 唯一归因来源，必须照旧铺进正文——与「隐藏」不矛盾：隐藏的前提是
          // 它已经逐字发给了模型。
          yield* emitFollowUp(unparsedNotice);
          yield* finishChunks(turn, proseBlock + unparsedNotice + thinkAcc, 'stop');
          return;
        }
        if (cont) {
          const contValid = cont.calls.filter((c) => tools.some((t) => t?.name === c.name));
          const contProse = safeAutoProse(cont.text);
          if (contValid.length) {
            const text = autoContinuedNotice({ calls: contValid.length, ...continueNoticeFields(cont) }) + (contProse ? `\n\n${contProse}` : '');
            yield* emitFollowUp(text);
            yield* emitCallBlocks(contValid, 'auto-continued after unparsed round');
            yield* finishChunks(turn, proseBlock + text + thinkAcc + cont.text, 'tool-calls');
            return;
          }
          if (contProse) {
            // 0.16.29：续跑轮只有散文时也只留进度说明（提示全文已发给模型）。
            const text = autoContinuedNotice({ ...continueNoticeFields(cont) }) + `\n\n${contProse}`;
            yield* emitFollowUp(text);
            yield* finishChunks(turn, proseBlock + text + thinkAcc, 'stop');
            return;
          }
          // 续跑轮既无调用也无可用散文（空回复）：不动块结构，落回下面的 stop 收场。
        }
      }
      yield* finishChunks(turn, proseBlock + thinkAcc, 'stop');
    },
  };
  llm.registerAdapter([cfg.providerId], adapter);

  /** Valid minimal text chunk sequence. */
async function* emitText(text, turn, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' };
  yield { type: 'text-delta', index, text };
  yield { type: 'block-end', index, block: { type: 'text', text } };
  yield { type: 'usage', ...usagePairOf(turn, estimateTokens(text)) };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** usage 事件的字段（0.16.22）：先把本轮输出累进会话分子，再取含输出累计的
 *  inputTokens——顺序不能反，否则分子永远少最后一轮回复。会话轮（buildTurn 的
 *  keyPath 分支）提供 noteOutput/usageInput；无 keyPath 的单轮没有这两个方法，
 *  退回旧口径 inputTokensOf（没有「会话」可言，谈不上累计）。 */
function usagePairOf(turn, outTokens) {
  turn?.noteOutput?.(outTokens);
  const inputTokens = turn?.usageInput ? turn.usageInput() : inputTokensOf(turn);
  return { usage: { inputTokens, outputTokens: outTokens } };
}

/** 本轮上报给 DSH 的输入 token 数：turn 自带累计值就用它，否则退回本轮文本估算。
 *  详见 buildTurn 里 cumulativeTokens 的注释（问题③：增量轮必须报累计上下文）。 */
function inputTokensOf(turn) {
  return Number.isFinite(turn?.inputTokens) ? turn.inputTokens : estimateTokens(turn?.prompt ?? '');
}

/** 三处相同的「空回复」判定：正文、思考、图片任一非空即合法（识图轮只出图）。 */
function assertNonEmpty(text, thinkText, images) {
  if (!String(text ?? '').trim() && !String(thinkText ?? '').trim() && !(Array.isArray(images) && images.length)) {
    throw new Error('webcode relay: empty response from web AI');
  }
}

/**
 * 「只出思维链、没有正文」的归因提示（0.15.2）。
 *
 * 与 `TOOL_UNKNOWN` 通知同型：**不抛错**，把一条带现场的文本当本轮回复交回会话，
 * 让任务继续。抛错会让整轮作废、界面上只看到一次失败，用户得手动再催——而那正是
 * 用户报的「没有下一步」。
 *
 * 三条现场缺一不可：
 *   • 思考尾部 —— 模型到底在想什么、有没有停在半句；
 *   • 收束原因 —— `thinking-only-settled` 是硬上限收束，`stream_ended_before_finished`
 *     是网页断流，`no_response_frames` 是零响应帧；修法完全不同；
 *   • 计数 —— `thinkingOnlyTurns` 连续增长说明这是稳定复现的形态，不是偶发。
 *
 * @param {string} thinkAcc 本轮已累积的思考全文
 * @param {object|null} scene 驱动现场（driverFor(...).status() 的最小投影）
 * @returns {string} 作为助手回复交回会话的提示文本
 */
function thinkingOnlyNotice(thinkAcc, scene) {
  const think = String(thinkAcc || '');
  const tail = think.length > 200 ? '…' + think.slice(-200) : think;
  const bits = [];
  if (scene?.lastEndReason) bits.push(`本轮收束原因 ${scene.lastEndReason}`);
  if (Number.isFinite(scene?.thinkingOnlyTurns)) bits.push(`只出思维链累计 ${scene.thinkingOnlyTurns} 次`);
  if (scene?.lastStalledSettle?.reason) bits.push(`上次现场 ${scene.lastStalledSettle.reason}`);
  const detail = bits.length ? `（${bits.join('，')}）` : '';
  return `THINKING_ONLY_NO_ANSWER: 网页只产出了思考内容、正文一个字符都没有${detail}。`
    + `本轮已按「没有可交付正文」收束，任务可以继续。`
    + `思考末尾：${tail || '（空）'}。`
    + '如果连续出现，说明模型停在思考里没有转入正文——请重试一次；'
    + '若仍复现，请附上这段提示以便按收束原因归因。';
}

/**
 * 「网页发出了调用但桥解析不出可执行调用」的提示文本（0.15.9）。
 *
 * ## 为什么必须有一条独立的提示，而不是复用 thinking-only
 *
 * 真机现场（`session-07907f7c`，网页会话 `49ab6330`）：模型把调用写成
 * `<tool_call>{"mcp_action":"call","purpose":…,"arguments":{…}}`——**没有 name**。
 * 旧代码解析出 0 个调用、`proseSafeEnd` 把协议整段扣住，于是本轮只剩散文；
 * 正文全是协议时更糟：整轮落到 thinking-only 分支，交回一句
 * 「网页只产出了思考内容、正文一个字符都没有」——**与事实相反**：网页明明发了调用。
 * 用户看到的就是「harness 显示不了」，模型则在接下来几轮反复说
 * 「my tool calls didn't get results」。
 *
 * 判据是 `withheld > 0`（边界探测确实命中了协议）+ `calls.length === 0`
 * （但没有一条能变成可执行调用）。这时唯一正确的做法是把**真实原因**说出来，
 * 并给出可行动的下一步：本会话有哪些工具、格式长什么样。
 *
 * 与 `TOOL_UNKNOWN` / `thinkingOnlyNotice` 同型：不抛错，把提示作为本轮回复交回
 * 会话——抛错会让整轮作废（界面上只看到一次失败），而这条提示能让模型**自我改正**。
 *
 * @param {{thinkAcc?: string, tools?: Array<{name?: string}>, scene?: object|null, withheld?: number, head?: string}} v 本轮现场
 * @returns {string} 作为助手回复交回会话的提示文本
 */
function unparsedCallNotice({ thinkAcc = '', tools = [], scene = null, withheld = 0, head = '', diagnostic = '' } = {}) {
  const available = (Array.isArray(tools) ? tools : []).map((t) => t?.name).filter(Boolean);
  const list = available.length > 24 ? available.slice(0, 24).join(', ') + ' …' : available.join(', ');
  const think = String(thinkAcc || '');
  const tail = think.length > 200 ? '…' + think.slice(-200) : think;
  // 0.16.11（#25）：被扣内容开头必须原样交回。真机 d5fd2e11 单会话复发 4 次
  // （扣留 868/2193/245/541 字符），旧提示只报字数——模型看不见被扣的是哪条调用，
  // 只能整段重猜。「缺 name 且候选不唯一」「参数截断」两类都按红线不许桥侧代猜代拼
  // （PROMPT-ENGINEERING.md §二：截半的调用块不得被拼成完整调用），
  // 唯一安全的出路是让模型看着原文头精确重发。
  const headText = String(head || '').slice(0, 200);
  const bits = [];
  if (withheld > 0) bits.push(`已扣留 ${withheld} 字符协议原文`);
  if (scene?.lastEndReason) bits.push(`本轮收束原因 ${scene.lastEndReason}`);
  // 0.16.25：解析诊断随提示透出（invoke 体静默丢弃分支补的留痕）。真机 cd997dd3
  // 同一形状连错 3 轮、提示没打到病灶是直接原因——模型看到「对象闭合后还挂着
  // {"replace_all":false}」这种点名判语，才知道该改什么，而不是往「太长/截断」上猜。
  if (diagnostic) bits.push(`解析诊断 ${String(diagnostic).slice(0, 200)}`);
  return 'TOOL_CALL_UNPARSED: 网页这一轮发出了工具调用，但桥没能把它变成可执行的调用'
    + '（最常见原因：JSON 里漏写 name 字段、参数 JSON 不配平/被截断，或参数对象闭合后追加了第二个对象等多余内容）。'
    + `本会话可用工具：${list || '（无）'}。`
    // 0.16.18/0.16.19：重发指引改指官方训练模板（与首轮教学/再教学同一个形状），
    // 且示例用**真实工具名**（占位符会被模型照抄 → TOOL_UNKNOWN，run-9 实证）。
    + `请按要求重发：${(() => { const sample = officialCallExampleFor(tools); return officialToolCallSpecimen(sample.name, sample.args); })()}`
    + '——name 不能省；'
    // 0.16.20：点名 run-10 的两个真实漂移（闭 token 带斜杠、漏 per-call begin）。
    // run-10 里旧文案唯一形状要点是「name 不能省」——而模型 name 一直写对了，
    // 教学没打到病灶，模型连抄三轮坏形状（.tmp/debug-log-2026-09-19-run10-*.md）。
    + '重发注意：收尾 token 不带斜杠，每条调用都要用成对的 call-begin/call-end 包住、'
    + '多条共用同一对 calls-begin/calls-end；'
    // 0.16.30：点名本轮的病灶——包裹竖线写成两枚（`<｜｜tool▁…`）。与 0.16.20/0.16.25
    // 同一条纪律：提示必须指出模型实际写错的那一处，否则模型自查「name 在、JSON 合法」
    // 后无处可改，只能原样重发。真机 25 处 `｜｜`、每轮 calls=0 就是这个循环。
    + '包裹竖线是一枚全角竖线（｜），左右各一枚，不要写成两枚（｜｜）；'
    // 0.16.25：点名 cd997dd3 的病灶（sep 后必须是单个 JSON 对象）。模型当时的
    // 自查「太长/被截断/字符坏 JSON」三项都不成立——主对象 2029 字符完全合法，
    // 坏的只是闭合后多挂的 `,{"replace_all":false}`。
    + 'sep 与 call end 之间必须是单个完整 JSON 对象，可选参数（如 replace_all）写在同一个对象里，'
    + '对象闭合后不要再追加任何内容；'
    + '如果任务不需要工具，请直接给出结论。'
    + (bits.length ? `（${bits.join('，')}）` : '')
    + (headText ? `\n被扣协议原文开头：${headText}` : '')
    + (tail ? `\n思考末尾：${tail}。` : '');
}

/**
 * 「已按可读参数恢复派发」的提示文本（0.16.12）。
 *
 * 与 `unparsedCallNotice` 同场出现的选择：扣留块里能读出白名单只读工具的合法
 * invoke 时，桥把调用**代为派发**（工具名与参数都是模型亲笔，不是伪造意图），
 * 循环靠工具结果存活；本提示如实告知模型「已代派发 + 请核对结果」。
 * 正文不含角度括号与 JSON，不会被工具协议锚点当成调用。
 *
 * @param {{count?: number, scene?: object|null, withheld?: number}} v 本轮现场
 * @returns {string} 作为助手回复文本块交回会话的提示
 */
function recoveredCallNotice({ count = 0, scene = null, withheld = 0 } = {}) {
  const bits = [];
  if (withheld > 0) bits.push(`已扣留 ${withheld} 字符协议原文`);
  if (scene?.lastEndReason) bits.push(`本轮收束原因 ${scene.lastEndReason}`);
  return `RECOVERED_CALL: 网页这一轮有 ${count} 条调用因标记畸形未被直接解析，已按可读参数恢复派发（仅只读工具）。`
    + '如果工具结果与你的意图不符，请重新发起完整、规范的调用。'
    + (bits.length ? `（${bits.join('，')}）` : '');
}

/**
 * 「网页会话已切换」提示（0.16.6）——会话重建节流命中那一轮交回会话的正文。
 *
 * ## 为什么是提示，而不是一次失败
 *
 * 0.16.4 的节流（同一会话键在窗口内只允许整段重建一次）修的是**雪崩**：会话槽一旦为空，
 * 每一轮都会走 WEB_SESSION_LOST → 重放四十万字符 → 又失败 → 下一轮再重放。刹车是对的，
 * 但它的表现形式是把这一轮**判死**（抛 `WEB_SESSION_REBUILD_THROTTLED`），于是 DSH 界面
 * 上是一条红色「本轮运行失败」、会话当场中断。用户原话：
 *「改为只提示已经切换会话而不是打扰直接中断会话」。
 *
 * 与 `thinkingOnlyNotice` / `unparsedCallNotice` 同型：**不抛错**，把带现场与出路的提示
 * 当本轮回复交回会话（doc/comment-style.md §7.2 的「进度 + 现场 + 下一步」三条齐全）。
 * 配套的两条副作用在 executor 那一侧，不在这条纯函数里：这一轮的正文没有进网页会话，
 * 所以 `turn.commit()` 不许让游标前进（`cededCursorKeys`），而会话槽**刻意不重置**
 *（留给下一轮的增量与驱动的 URL 自愈）。
 *
 * @param {{waitLeftMs?: number, sinceLastMs?: number, chars?: number}} scene 本轮现场：
 *   节流窗还剩多久、上一次整段重放在多久之前、那次重放了多少字符
 * @returns {string} 作为助手回复交回会话的提示文本（不含角度括号与 JSON，避免被
 *   工具协议解析器当成调用）
 */
function sessionSwitchedNotice(scene = {}) {
  const left = Math.max(0, Math.round(Number(scene.waitLeftMs) || 0) / 1000);
  const since = Math.max(0, Math.round(Number(scene.sinceLastMs) || 0) / 1000);
  const chars = Math.max(0, Math.round(Number(scene.chars) || 0));
  return 'SESSION_SWITCHED: 网页会话已切换——本轮不再重放首轮上下文'
    + `（上一次整段重建在 ${since}s 前、重放了 ${chars} 字符，节流窗还剩约 ${left}s）。`
    + '会话没有中断：直接发送下一条消息即可继续——'
    + '窗口过去后这一轮会整段重建，窗口内则继续显示本条提示。';
}

/** 每轮收尾的 usage + finish 事件对（outputTokens 口径：正文+思考一起估）。 */
function* finishChunks(turn, outputText, kind) {
  yield { type: 'usage', ...usagePairOf(turn, estimateTokens(outputText)) };
  yield { type: 'finish', reason: { kind } };
}

/** 网页生成的图片 → markdown（harness 块协议无 image 块，用文本携带）。 */
function imageMarkdown(images) {
  const parts = [];
  for (const img of Array.isArray(images) ? images.slice(0, 6) : []) {
    if (!img) continue;
    if (typeof img === 'string') { parts.push(`\n\n![image](${img})`); continue; }
    if (img.url) parts.push(`\n\n![image](${img.url})`);
    else if (img.base64) parts.push(`\n\n![image](data:${img.mime || 'image/png'};base64,${img.base64})`);
    else if (img.pointer) parts.push(`\n\n[图片引用: ${img.pointer}]`);
  }
  return parts.join('\n');
}

  // ---- relay + in-package browser driver -------------------------------
  // The driver automates the system Edge directly (persistent profile,
  // one-time headed login, then headless) — no browser extension involved.
  // Tests inject a scripted driver via config.driver instead.
  const driver = cfg.driver || createBrowserDriver({
    site: cfg.site,
    profileDir: cfg.profileDir,
    headless: cfg.headless !== false,
    requestTimeoutMs: cfg.requestTimeoutMs,
    // 只出思维链的绝对上限（0.15.2）。必须显式传：不传的话 driver 会用它自己的
    // 默认值，行为看起来一样，但 cfg.answerTimeoutMs 这个配置项就成了摆设。
    answerTimeoutMs: cfg.answerTimeoutMs,
    // 捕获停摆兜底阈值（0.19.12）。同上：不显式传，配置层就是摆设。
    captureStallRescueMs: cfg.captureStallRescueMs,
    loginTimeoutMs: cfg.loginTimeoutMs,
    composerChunkChars: cfg.composerChunkChars,
    attachInlineLimitChars: cfg.attachInlineLimitChars,
    // 附件尺寸上限（0.16.3）。同 answerTimeoutMs 的教训：不显式传，配置项就成了
    // 摆设——driver 内部即使有同名默认值，用户改 index.js 这一层也永远够不着。
    attachMaxChars: cfg.attachMaxChars,
    // 投递形态（0.16.3）。这里传的是**读取函数**而不是 `cfg.promptTransport` 快照：
    // 设置页写的是 webcode 设置命名空间（configManager），与插件 config 是两个来源，
    // 传快照就等于「设置页选了纯文本、实际仍走附件」。函数每次投递前现读，
    // 未设置时回落插件 config（cfg.promptTransport，默认 'attach'）。
    getPromptTransport: () => configManager.get().promptTransport ?? cfg.promptTransport,
    logger: console,
  });

  // 多站点：每个内容服务一个独立驱动实例（独立 profile，避免登录态串号）。
  // deepseek 用默认 driver（兼容测试注入与既有 profile）；其余站点按需懒创建。
  const drivers = new Map();
  // 把宿主的图片限额交给每个驱动：上传前据此拦下必然被拒绝的输入（张数/字节），
  // 而不是发出去再猜为什么「模型说没图」。拿不到限额时驱动退回保守默认。
  const imageLimitsProvider = () => (attachments ? attachments.imageLimits : null) || null;
  for (const d of [driver]) { try { d.setImageLimitsProvider?.(imageLimitsProvider); } catch { /* 测试注入的桩驱动 */ } }
  /**
   * 取某个「站点 × 账户槽」的驱动实例。
   *
   * 入参是 **accountKey**（`glm` 或 `glm#2`）而不是裸 siteId —— 0.14.7 起
   * 「同一站点两个账户」= 两个独立驱动实例 + 两个独立 profileDir。
   *
   * 兼容性硬约束（两条，都有测试钉住）：
   *   ① `driverFor('deepseek')` 必须仍返回**注入的** `driver`。测试通过
   *      `config.driver` 注入桩驱动；若默认槽改走 createBrowserDriver，
   *      全部既有测试会在无头环境里真的去拉 Edge。
   *   ② `driverFor('glm')` 的 profileDir 必须仍逐字等于
   *      `<profileDir>/sites/glm`（slotProfileDir 的默认槽分支给出的就是它）。
   *
   * 键用 accountKey 而不是 siteId：`glm` 与 `glm#2` 是两份登录态，
   * 用 siteId 做键会让第二个账户把第一个的驱动实例顶掉。
   */
  function driverFor(accountKey) {
    const parsed = parseAccountKey(accountKey || 'deepseek');
    const { siteId, slot } = parsed;
    const key = formatAccountKey(siteId, slot);
    // 默认槽 + deepseek：沿用注入的 driver（测试桩与既有 profile 都在它身上）。
    if (siteId === 'deepseek' && slot === DEFAULT_SLOT) return driver;
    if (!drivers.has(key)) {
      const st = getSite(siteId);
      if (!st) throw new Error('[webcode-bridge] 未知站点: ' + siteId);
      const d = createBrowserDriver({
        siteId,
        slot,
        site: st.origin + '/',
        profileDir: slotProfileDir(cfg.profileDir, siteId, slot, { primary: st.mountAtRelayRoot === true }),
        headless: cfg.headless !== false,
        requestTimeoutMs: cfg.requestTimeoutMs,
        // 同默认 driver：非默认槽的驱动也要拿到这个上限，否则「账户2 卡住」
        // 与「默认槽卡住」的行为会不一致——而两个槽走的是同一份代码。
        answerTimeoutMs: cfg.answerTimeoutMs,
        // 同默认 driver：捕获停摆兜底（0.19.12）也必须两槽一致。
        captureStallRescueMs: cfg.captureStallRescueMs,
        loginTimeoutMs: cfg.loginTimeoutMs,
        composerChunkChars: cfg.composerChunkChars,
        // 同默认 driver：非默认槽也必须拿到附件阈值，否则「账户2 发长提示词」与
        // 「默认槽发长提示词」行为不一致——两个槽走的是同一份代码。
        attachInlineLimitChars: cfg.attachInlineLimitChars,
        // 同默认 driver：附件尺寸上限也必须传，否则「账户2 发超长提示词」与「默认槽」
        // 会走出两种行为——两个槽走的是同一份代码。
        attachMaxChars: cfg.attachMaxChars,
        // 同默认 driver（0.16.3）：第二个账户槽也必须拿到同一个投递形态读取函数，
        // 否则「账户2 选了纯文本」与「默认槽选了纯文本」会走出两种行为——
        // 两个槽走的是同一份代码。
        getPromptTransport: () => configManager.get().promptTransport ?? cfg.promptTransport,
        logger: console,
      });
      try { d.setImageLimitsProvider?.(imageLimitsProvider); } catch { /* 同上 */ }
      drivers.set(key, d);
    }
    return drivers.get(key);
  }

  /**
   * 问题④：DSH 的自动命名（purpose='session-title'）此前完全走本地启发式——把首条
   * 用户消息截前 16 字，网页端给对话起的真实名字（以及用户在那里做的重命名）永远
   * 传不回来。这里把命名接到网页端：找到本 DSH 会话对应的网页对话，读它在网页侧的
   * 真实标题。
   *
   * 只读、且只读已经在跑的驱动：命名是旁路调用，绝不能为了取一个标题去懒创建浏览器
   * （那会为一个名字拉起一整个 Edge profile）。取不到就返回 null，调用方回落本地
   * 启发式——命名失败不该影响会话本身。
   */
  async function webConversationTitle(options) {
    const sessionId = options?.sessionId;
    if (!sessionId) return null;
    let siteId = 'deepseek';
    try { siteId = resolveWebModel(options?.model || configManager.get().defaultModel || cfg.modelId).siteId; } catch { /* 用默认站点 */ }
    // 命名调用没有 agentId：对应的是本会话的主网页对话槽（key = sessionId）。
    // 只读**已经存在**的驱动实例，绝不懒创建（见上）。默认槽的键就是 siteId。
    const d = siteId === 'deepseek' ? driver : drivers.get(formatAccountKey(siteId, DEFAULT_SLOT));
    if (!d || typeof d.listSessions !== 'function' || typeof d.conversationFor !== 'function') return null;
    const key = String(sessionId);
        // 0.21.1：键形修复。写入形状是 sessionId::accountKey（0.19.4 起带账号段），
        // 裸 id 直查必然 miss ⇒ 命名永远回落「首句截 16 字」。先裸 id（兼容旧落盘），
        // 再按会话前缀扫（conversationForSession 在驱动侧做前缀匹配）。
        const conv = d.conversationFor(key)
          || (typeof d.conversationForSession === 'function' ? d.conversationForSession(key) : null);
        const webSessionId = conv?.webSessionId;
    if (!webSessionId) return null;
    const dir = await d.listSessions(100);
    const hit = (dir?.sessions || []).find((s) => s.id === webSessionId);
    const title = String(hit?.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title === '(无标题)') return null;
    return title;
  }

  /**
   * 用**系统默认程序**打开一个本机文件（0.16.38）。
   *
   * 只服务于「设置页里点开该站点的提示词文件」这一件事，因此调用方（web-control
   * 的 POST prompt-file）已经把路径钉死在 prompts/ 目录下——本函数不再做路径
   * 判据，只负责把「怎么叫起默认程序」这件平台差异收在一处。
   *
   * 纪律（与 dsh-host-open-in-app 同一条）：**argv 调用、绝不经 shell**。用户目录
   * 名可能含空格或引号，走 shell 就等于把本机文件路径交给命令行解析；走 argv 时
   * 那个字符串只是一个参数。
   *
   * 失败一律如实回 { ok:false, error }，调用方据此回 OPEN_FAILED——不静默、不假成功。
   *
   * @param {string} absPath 绝对路径
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function openPathWithDefaultApp(absPath) {
    const { spawn } = await import('node:child_process');
    const file = path.resolve(String(absPath || ''));
    if (!file) return { ok: false, error: 'empty path' };
    // Windows：`explorer.exe <file>` 是最短路径；但 .md 未关联编辑器时 explorer 会
    // 静默只打开所在目录（退出码仍是 0），因此失败/未关联时用 rundll32 的
    // FileProtocolHandler 再试一次——它走的就是「用默认程序打开」这条系统路径。
    const plan = process.platform === 'win32'
      ? [
        { cmd: 'explorer.exe', args: [file] },
        { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', file] },
      ]
      : process.platform === 'darwin'
        ? [{ cmd: 'open', args: [file] }]
        : [{ cmd: 'xdg-open', args: [file] }];
    let lastErr = 'open failed';
    for (const step of plan) {
      const r = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        try {
          const child = spawn(step.cmd, step.args, { stdio: 'ignore', windowsHide: true, detached: true });
          child.on('error', (e) => done({ ok: false, error: String(e?.message || e) }));
          child.on('spawn', () => { try { child.unref(); } catch { /* not fatal */ } done({ ok: true }); });
        } catch (e) { done({ ok: false, error: String(e?.message || e) }); }
      });
      if (r.ok) return { ok: true };
      lastErr = r.error || lastErr;
      warn('openPath failed via ' + step.cmd + ':', lastErr);
    }
    return { ok: false, error: lastErr };
  }

  // ---- web-side control plane (sessions / naming / sync / preview) -----
  // Host services are optional: without DSH session services (standalone
  // relay) listing/history/preview still work, import is simply unavailable.
  const host = {
    listWorkspaces() {
      const reg = ctx.get('workspaceRegistry');
      if (!reg || typeof reg.list !== 'function') return { ok: false, error: 'workspaceRegistry 不可用' };
      return { ok: true, workspaces: reg.list().map((w) => ({ id: w.id, title: w.title, path: w.path })) };
    },
    async importToWorkspace({ sessionId, title, workspaceId }) {
      const persistence = ctx.get('sessionPersistence');
      const reg = ctx.get('workspaceRegistry');
      if (!persistence) return { ok: false, error: 'sessionPersistence 服务不可用' };
      if (!reg || !workspaceId) return { ok: false, error: '未指定有效工作区' };
      const ws = typeof reg.get === 'function' ? reg.get(workspaceId) : null;
      if (!ws) return { ok: false, error: '未找到工作区' };

      const hist = await driver.fetchHistory(sessionId);
      const { line } = mainLineOf(hist.messages);
      const msgs = Array.isArray(line) ? line : [];
      if (!msgs.length) return { ok: false, error: '该网页对话没有可导入的消息' };
      // Title: explicit override > the web conversation's real name > fallback.
      let finalTitle = (title || '').trim();
      if (!finalTitle) {
        try {
          const dir = await driver.listSessions(100);
          finalTitle = String(dir.sessions.find((s) => s.id === sessionId)?.title || '').trim();
        } catch { /* naming feed optional */ }
      }
      const events = buildSessionEvents(msgs, finalTitle);
      const sid = 'session-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      const meta = { version: 0, id: sid, createdAt: Date.now(), cwd: ws.path };
      try {
        await persistence.create(meta);
        await persistence.append(sid, events);
      } catch (e) {
        return { ok: false, error: '写入 DSH 会话存储失败' };
      }
      let attached = true;
      let attachError = null;
      try { await ws.attachSession(sid); } catch (e) { attached = false; attachError = String(e?.message || e); }
      log(`imported web session ${sessionId} → ${sid} (${msgs.length} msgs, branchSkipped=${hist.branchCount ?? 0}, attached=${attached})`);
      return { ok: true, sessionId: sid, messageCount: msgs.length, branchSkipped: hist.branchCount ?? 0, title: finalTitle, attached, attachError };
    },
  };
  // 发送间隔的站点级状态：站点 id → **上一次真正发出的时刻**（send-to-send）。
  // 为什么必须落盘（0.14.0，真机 2026-09-13 用户报「等待不是按我设置的来」）：
  // 旧实现只有进程内存，DSH 每次重启都清空，于是**重启后第一轮零等待**——用户
  // 设了 10 秒却发现第一条立刻发出去，这正是「好像没按设置来」的一半来源
  //（另一半是基准取「上一轮结束」，见 metrics.computeSendGap 的注释）。
  // 落盘文件与设置同目录（profileDir），权限 0o600，内容极小。
  const sendStatePath = path.join(cfg.profileDir, 'webcode-send-state.json');
  const SEND_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  // 键是 **accountKey**（`glm` / `glm#2`）而不是 siteId（0.14.7）。
  // 为什么必须按槽分开：不同账户是不同登录态，风控窗口互相独立——
  // 若两个槽共用一条「上次发出」时间线，账户2 会被账户1 的发送压住（或反之），
  // 用户设的槽级间隔就形同虚设。
  //
  // 历史文件的键是 siteId，而默认槽的 accountKey **就是** siteId，
  // 因此旧文件不需要迁移：读进来的键天然正确（见下方 knownAccountKey）。
  //
  // 0.16.31：每个键的值从**一个数**（上次发出的时刻）升成 `{ send, end }` 两个时刻。
  // 为什么必须都存：两个基准防的是两件不同的事（见 metrics.computeSendGap），
  // 而用户可以在设置面切换口径。只存一个的话，切换基准的那一轮会退化成「没有
  // 基准」→ 零等待，用户会看到「刚换成 end-to-start 第一轮没等」。
  // 旧文件（值是裸数字）**照样读**：裸数字即 send，end 视为缺失——升级不丢基准。
  const sendStateByAccount = new Map();
  /** 该键是否指向一个已知站点（`glm` 与 `glm#2` 都算）。文件可手改，不抛错。 */
  function knownAccountKey(key) {
    try { return Boolean(getSite(parseAccountKey(key).siteId)); } catch { return false; }
  }
  /** 时刻是否可信：正整数、不在未来、不过期（陈旧基准没有意义）。 */
  function usableSendTime(t, now) {
    return Number.isFinite(t) && t > 0 && t <= now && now - t <= SEND_STATE_MAX_AGE_MS;
  }
  (function loadSendState() {
    try {
      const raw = JSON.parse(fs.readFileSync(sendStatePath, 'utf8'));
      const now = Date.now();
      for (const [key, value] of Object.entries(raw || {})) {
        // 只认已知站点 + 合理时间窗：文件可能来自别的机器/很久以前。
        if (!knownAccountKey(key)) continue;
        // 旧形态：裸数字 = 上次发出时刻。
        if (typeof value === 'number') {
          if (usableSendTime(value, now)) sendStateByAccount.set(key, { send: value, end: null });
          continue;
        }
        if (!value || typeof value !== 'object') continue;
        const send = Number(value.send);
        const end = Number(value.end);
        const entry = {
          send: usableSendTime(send, now) ? send : null,
          end: usableSendTime(end, now) ? end : null,
        };
        if (entry.send !== null || entry.end !== null) sendStateByAccount.set(key, entry);
      }
    } catch { /* 首次运行或文件损坏：按「没有基准」处理即可 */ }
  })();
  /** 落盘整张表。写失败仅 warn，绝不阻断发送（与 0.14.0 同一条纪律）。 */
  function saveSendState() {
    try {
      fs.mkdirSync(path.dirname(sendStatePath), { recursive: true });
      const tmp = sendStatePath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sendStateByAccount)), { mode: 0o600 });
      fs.renameSync(tmp, sendStatePath);
    } catch (err) { warn('send-state save failed:', err?.message); }
  }
  /** 记录「刚刚真正发出」。只在发送成功那一刻调用。 */
  function rememberSend(accountKey, at = Date.now()) {
    const prev = sendStateByAccount.get(accountKey) || { send: null, end: null };
    sendStateByAccount.set(accountKey, { ...prev, send: at });
    saveSendState();
  }
  /**
   * 记录「刚刚生成结束」（0.16.31，end-to-start 的基准）。
   *
   * 调用点必须是**整轮真正收束之后**（含限流退避重试与压缩重试全部走完），
   * 否则基准会落在一次失败尝试上，让下一轮的等待凭空变短。
   * 与 rememberSend 同一纪律：写失败只 warn。
   */
  function rememberTurnEnd(accountKey, at = Date.now()) {
    const prev = sendStateByAccount.get(accountKey) || { send: null, end: null };
    sendStateByAccount.set(accountKey, { ...prev, end: at });
    saveSendState();
  }

  // ---- 等待发送时长的累计账本（0.14.4） ----------------------------------
  // 需求：输入框底下要显示「本次会话总等待发送时间」，设置页要显示「累计等待时长」。
  // 两者必须同口径（都来自 relay 的 metrics.sendWaitMs），因此共用 wait-stats.js 的
  // 纯计算层，这里只负责**落盘与按会话索引**。
  //
  // 为什么要落盘：DSH 重启会顶掉进程内状态，用户看到的「累计」如果每次重启归零，
  // 这个数字就没有意义了（与 send-state 落盘同一个理由）。
  const waitStatsPath = path.join(cfg.profileDir, 'webcode-wait-stats.json');
  // 单会话索引的上限：只保留最近活跃的若干个会话。GUI 只会读**当前**会话那一格，
  // 但「累计」是全量的——淘汰只影响按会话查询，不影响总数。
  const WAIT_SESSION_CAP = 64;
  let waitStats = (function loadWaitStats() {
    try {
      const raw = JSON.parse(fs.readFileSync(waitStatsPath, 'utf8'));
      return {
        total: sanitizeWaitStats(raw?.total),
        sessions: new Map(Object.entries(raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {})
          .slice(0, WAIT_SESSION_CAP)
          .map(([k, v]) => [k, sanitizeWaitStats(v)])),
      };
    } catch { return { total: emptyWaitStats(), sessions: new Map() }; }
  })();
  function saveWaitStats() {
    try {
      fs.mkdirSync(path.dirname(waitStatsPath), { recursive: true });
      const payload = { total: waitStats.total, sessions: Object.fromEntries(waitStats.sessions) };
      const tmp = waitStatsPath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, waitStatsPath);
    } catch (err) { warn('wait-stats save failed:', err?.message); }
  }
  /**
   * relay 的观测回调：把本轮等待记进「累计」与「本会话」两个账本。
   *
   * 会话键取 meta.sessionKey 的**会话段**（`<sessionId>::<agentId>` → `<sessionId>`）：
   * 子代理有自己的网页对话，但「本次会话等待发送」在用户眼里就是主会话那一个数，
   * 不该被子代理的等待混进来。
   */
  function recordWaitMetrics(metrics, meta) {
    if (!metrics) return;
    // 0.16.24：本轮已结算 ⇒ 在途读数必须让位。否则药丸会同时持有「正在涨的
    // live」与「已落账的累计」，而 composerWaitPillLabel 优先显示 live——
    // 那个数会一直停在冻结值上，把刚结算完的账本挡住。
    clearLiveWait(meta);
    waitStats.total = accumulateWait(waitStats.total, metrics);
    const key = sessionKeyOf(meta);
    if (key) {
      const prev = waitStats.sessions.get(key) || null;
      // 重新插入以刷新 Map 的插入序，配合下面的头部淘汰就是 LRU。
      waitStats.sessions.delete(key);
      waitStats.sessions.set(key, accumulateWait(prev, metrics));
      while (waitStats.sessions.size > WAIT_SESSION_CAP) {
        waitStats.sessions.delete(waitStats.sessions.keys().next().value);
      }
    }
    saveWaitStats();
  }
  /** meta.sessionKey / meta.sessionId → 主会话 id（拿不到就返回 null，只记总数）。 */
  function sessionKeyOf(meta) {
    const raw = meta && (meta.sessionKey || meta.sessionId);
    if (typeof raw !== 'string' || !raw) return null;
    return raw.split('::')[0] || null;
  }
  // ---- 在途等待（0.16.24）----------------------------------------------------
  //
  // 需求（用户原话）：「能做到等待发送实际显示和官方一样开始就计时增长，不要等
  // 过了再变一下子从 n 秒到 m 秒？」
  //
  // 旧实现只把 waitStats 账本透给前端，而账本是**事后结算**的——它在整轮生成
  // 结束、relay 把 metrics 交回来时才更新。于是等待期间药丸什么都不显示（首次
  // 等待时整枚不渲染），等一切结束数字才一次性跳出来，正是用户描述的那个观感。
  //
  // 这里发布「这一轮正在等」的起始时刻；`liveWaitLabel`（wait-stats.js）每次
  // 轮询现算时长——文案仍只有一个来源，客户端不需要第二份时长格式化。
  //
  // 键取 sessionKeyOf(meta)（= 主会话 id），与账本同一把键：药丸按会话 id 查询，
  // 两者必须能对上，否则会出现「面板有数、药丸没有」。
  const liveWaits = new Map();   // sessionId → { startedAt, endsAt, baseMs, kind, accountKey }
  const LIVE_WAIT_CAP = 64;
  // 幽灵兜底：一轮在 sleepSignal 里被 abort 时 finally 会清，但万一某条路径抛在
  // 清理之前，这条在途记录会永远冻结在一个数上。超过这个年龄一律当没有——
  // 宁可少显示一段实时读数，也不要让药丸停在一个不动的假数上。
  const LIVE_WAIT_STALE_MS = 15 * 60_000;

  /** 发布/续写一段在途等待。同一会话重复调用按 LRU 刷新（后一段覆盖前一段）。 */
  function beginLiveWait(meta, accountKey, kind, waitMs, baseMs) {
    const key = sessionKeyOf(meta);
    if (!key) return null;
    const startedAt = Date.now();
    liveWaits.delete(key);
    liveWaits.set(key, {
      startedAt,
      // endsAt 之后 liveWaitLabel 把时长**冻结**在满值：等待确实结束了，但整轮
      // 生成还没跑完、账本还没结算，这时数字不该回退也不该继续涨。
      endsAt: startedAt + Math.max(0, Math.round(Number(waitMs) || 0)),
      baseMs: Math.max(0, Math.round(Number(baseMs) || 0)),
      kind,
      accountKey,
    });
    while (liveWaits.size > LIVE_WAIT_CAP) liveWaits.delete(liveWaits.keys().next().value);
    return key;
  }

  /** 清掉某会话的在途等待（等待结束、轮次收场、或结算落账时）。 */
  function clearLiveWait(meta) {
    const key = sessionKeyOf(meta);
    if (key) liveWaits.delete(key);
  }

  /** 控制面读取用：某会话**正在**等待的那一段（无则 null）。 */
  function liveWaitOf(sessionId) {
    const key = typeof sessionId === 'string' && sessionId ? sessionId.split('::')[0] : null;
    if (!key) return null;
    const live = liveWaits.get(key) || null;
    if (!live) return null;
    if (Date.now() - live.startedAt > LIVE_WAIT_STALE_MS) { liveWaits.delete(key); return null; }
    return live;
  }

  /** 控制面读取用：`{ total, session }`。sessionId 缺省时只回累计。 */
  function waitStatsSnapshot(sessionId) {
    const key = typeof sessionId === 'string' && sessionId ? sessionId.split('::')[0] : null;
    return {
      total: waitStats.total,
      session: key ? (waitStats.sessions.get(key) || emptyWaitStats()) : null,
      // 在途等待与账本一起回，保证药丸的「正在涨」与「已结算」是同一把键查出来的。
      live: liveWaitOf(sessionId),
      now: Date.now(),
    };
  }
  // 站点限流退避重试上限（RATE_LIMITED）。退避时长 = max(发送间隔, 10s) × 已重试次数，
  // 10s 下限是因为限流滑窗通常以十秒计，几十毫秒的短间隔重试只会再次撞墙。
  const RATE_LIMIT_RETRIES = 2;
  // 适配器侧「无进展」看门狗：自上次 delta/think/image 起多久没有任何动静就
  // 主动失败。存在的意义不是替代驱动的 240s 总超时，而是让「网页已回复但桥这
  // 边卡住」这种**无限思考中**在 2 分钟内变成一条带页面现场的明确报错
  //（详见 PLAN-0.14.0-HANDOFF.md 的 P1-3）。必须 > 驱动的 WIP 稳态窗口，
  // 否则看门狗会先于稳态收束开火，把本可救回的回复判死。
  const WIP_IDLE_MS = Math.max(300, Number(cfg.wipIdleMs) || 2500);
  const IDLE_TIMEOUT_MS = Math.max(WIP_IDLE_MS + 1000, Number(cfg.idleTimeoutMs) || 120_000);
  // 会话重建节流（T1）：同一 sessionKey 在窗口内只允许**整段重建**一次。
  //
  // 为什么必须有（2026-09-17 20:52 那次事故的雪崩形态）：会话槽一旦为空，每一轮
  // 都会走 WEB_SESSION_LOST → 整段重建（真机 407,064 字符的首轮提示词重放进一个
  // **新**网页会话）→ 又失败 → 下一轮再重建。用户看到的是「一直新开对话」，代价
  // 是每轮四十万字符的发送加一次风控暴露；而「重建」这个动作本身并不比「等下一轮
  // 自愈」更可能成功——驱动的落地即落盘（browser-driver 的 noteLanded）与 URL 自愈
  // 已经能把槽补回来，短时间内重复重建只会把两边都拖垮。
  //
  // 60s 的依据：它要跨过「一轮失败 → 宿主立刻重试」的时间尺度（小于适配器看门狗
  // 120s 与驱动单轮 240s，因此不会把一次正常的重试也挡在外面），又要短到不耽误用户
  // 手动重试——超窗的重建请求照常放行。`cfg.sessionRebuildThrottleMs` 可调小
  //（**供离线测试用**，0 = 关闭节流），与 cfg.rateLimitBackoffMinMs 的立场一致。
  //
  // 0.16.6 只改了**表现形式**：窗口内的第二次不再抛错，改交回一条「网页会话已切换」
  // 提示（见 executor 里那一段与 sessionSwitchedNotice）。判据、窗口长度、
  //「窗口外照常整段重建」全部逐字不变——变的只是它不再以「本轮运行失败」的样子
  // 出现在用户面前。护栏：test/session-continuity.test.mjs ⑥（同一段剧本，断言从
  // 「拿到 WEB_SESSION_REBUILD_THROTTLED」改成「拿到提示文本、仍只发 1 次、
  // 且下一轮照旧整段重建」）。
  const SESSION_REBUILD_THROTTLE_MS = Math.max(0, Number(cfg.sessionRebuildThrottleMs ?? 60_000) || 0);
  const lastSessionRebuildAt = new Map();   // sessionKey → { at, chars }（真发生过的那次整段重放）

  let front = null;
  const relay = createRelay({
    ...cfg,
    // 中继侧的**外层**总超时必须是两段内层预算之和，不能与它们同值（0.16.3 修正）。
    //
    // 三类超时串在同一条链上：中继外层 > 驱动单轮 > 适配器看门狗窗口。0.16.3 之前
    // 默认全是 240s：驱动超时一到就 resolve/reject，中继的 240s 同时到点，两者在
    // 同一条 deadline 上赛跑 —— 谁先跑完由事件循环决定，用户拿到的可能是中继那句
    // 「request timed out after 240000ms」（没有页面现场），从而丢掉驱动那句带
    // 捕获链是否存活、页面已有多少字回复的诊断。更糟的是首字节相位：看门狗宽限后
    // 的窗口 120s×2 = 240s 与整轮总超时**同值**，于是「网页还在 prefill」那一轮
    // 会被整轮超时先杀掉——0.16.3 想修的那次事故会原样复现，只是报错换了名字。
    //
    // 语义上这也是对的：中继的外层还要覆盖排队（最多 32 个请求串行）与一次
    // 限流退避重试，本来就该比单轮预算宽。护栏见 test/watchdog-first-byte.test.mjs。
    requestTimeoutMs: (Number(cfg.requestTimeoutMs) || 240_000) * 2,
    logger: console,
    // 累计等待时长的记账入口（见 recordWaitMetrics）。
    onMetrics: recordWaitMetrics,
    // Session mode routes into the session's own web conversation (only the
    // increment lands); stateless turns (OpenAI front, aux) stay fresh.
    executor: async (prompt, opts) => {
      const m = opts?.meta || null;
      // 归一化模型限定 id：meta 可能只带裸 id（OpenAI 前端），补上站点前缀，
      // 保证 driver 的 selectModel 一定解析到正确站点，不会因跨站点重名串模型。
      const qualified = qualifyModelId(m?.model, m?.siteId);
      // thinkMode: 'auto' | 'on' | 'off' — 设置页手动覆盖网页「深度思考」开关
      const thinkMode = ['on', 'off', 'auto'].includes(m?.thinkMode) ? m.thinkMode : 'auto';
      const siteId = m?.siteId || 'deepseek';
      // 账户槽（0.14.7）：meta 显式带 accountKey；只有裸 id 的调用方
      // （OpenAI 前端、aux 轮）则从限定模型 id 里解出来（`glm@2:glm-5.3`）。
      // 两者都拿不到 → 默认槽，即 0.14.6 的行为。
      let accountKey = m?.accountKey || null;
      if (!accountKey) {
        try { accountKey = resolveWebModel(qualified).accountKey; } catch { accountKey = null; }
      }
      if (!accountKey) accountKey = siteId;
      const sendGapMs = clampSendGapMs(m?.sendGapMs);
      // 0.16.31：间隔基准（'send-to-send' | 'end-to-start'）。
      // 口径合法性在这里收一次（与 sendGapMs 同层）：未知值一律退回默认基准，
      // 而不是让一个写错的配置项把等待变成「看情况」——配置写错只许退化成旧行为。
      const sendGapBasis = m?.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
      const attempt = (fresh) => {
        if (m?.sessionKey) {
          const drive = driverFor(accountKey);
          const turnOpts = {
            fresh,
            signal: opts.signal,
            onDelta: opts.onDelta,
            onThink: opts.onThink,
            onImage: opts.onImage,
            model: qualified,
            images: m.images,
            thinkMode,
          };
          return drive.sendTurn(m.sessionKey, prompt, turnOpts).catch(async (err) => {
            // 网页会话被删/过期：桥这一侧的唯一正确恢复是重放「首轮整段」——
            // 网页会话里保有的就是首轮全文 + 后续增量，重放首轮即完整上下文
            // 与工具协议，而不是把一个没有前文的增量丢进新会话（那才是真正的
            // 「跑着跑着变傻」）。重放失败才把游标作废，交给下一轮。
            if (err?.code === 'WEB_SESSION_LOST' && typeof m.rebuild === 'function') {
              const prev = lastSessionRebuildAt.get(m.sessionKey) || null;
              const now = Date.now();
              // 节流（见 SESSION_REBUILD_THROTTLE_MS）：第二次重建**不带任何副作用**
              // 地收场，而不是再发一遍四十万字符。
              //
              // 0.16.6：**不再抛错**。0.16.4 在这里抛 WEB_SESSION_REBUILD_THROTTLED，
              // 于是这一轮在 DSH 界面上是一条红色「本轮运行失败」，会话被迫中断——
              // 用户原话：「改为只提示已经切换会话而不是打扰直接中断会话」。
              // 刹车本身是对的（不许再重放四十万字符），错的只是它的**表现形式**：
              // 它把「这一轮没有内容可交」说成了「这一轮失败」。处置与 TOOL_UNKNOWN /
              // thinkingOnlyNotice / unparsedCallNotice 同型——把带现场与下一步的提示
              // 当本轮正文交回会话，任务不断链。
              //
              // 收场时**刻意什么都不改**（不删游标、不重置会话槽），只加一枚
              // 「这一轮没落进网页会话」的标记（cededCursorKeys，见其声明处）：
              //   · 不删游标 ⇒ 下一轮仍是增量（几千字符），而不是又一轮四十万重放；
              //     它会把这一轮没发出去的消息一并带上，由驱动按老规矩重开或续聊——
              //     两条路都保住了上下文，没有静默丢弃；
              //   · 不重置会话槽 ⇒ 万一网页其实还停在那个会话上（驱动的 URL 自愈），
              //     下一轮的增量直接落对地方，而不是被我们提前判死。
              // 窗口过期后的重建照旧由下面的 `m.rebuild()` 分支放行。
              //
              // 0.16.28：节流窗口内**先等完剩余窗口再重建**，不再把提示当正文交回。
              // 真机取证（session-4f236a51，reply-log 逐字 52 次）：提示是**纯文本
              // 回复**，agent 循环把它当最终答复收场——goal 自动化的每一轮被空转
              // 烧掉一整个节流窗（`SESSION_REBUILD_THROTTLE_MS`，默认 **60 秒**；
              // 0.16.6 起就是 60 秒，旧文案写「30 秒」是引 0.16.6 提交里用户对**更早**
              // 版本的描述，0.16.29 更正）、任务零进展，用户看到「被好心提醒完全打断」。
              // 等待是有界的（≤ 窗口全长 = 60s），abort 立即短路到旧收场（提示只在
              // 「用户真的叫停」时才有资格成为本轮正文）。
              if (SESSION_REBUILD_THROTTLE_MS > 0 && prev && now - prev.at < SESSION_REBUILD_THROTTLE_MS) {
                const waitMs = SESSION_REBUILD_THROTTLE_MS - (now - prev.at);
                if (opts.signal?.aborted) {
                  const notice = sessionSwitchedNotice({
                    waitLeftMs: waitMs,
                    sinceLastMs: now - prev.at,
                    chars: prev.chars,
                  });
                  warn(`web session rebuild throttled (sessionKey=${m.sessionKey}, ${Math.round(waitMs / 1000)}s left, `
                    + `last rebuild ${prev.chars} chars) — 已中止，交回「已切换会话」提示`);
                  sessionSwitchNotices += 1;
                  cededCursorKeys.add(m.sessionKey);
                  while (cededCursorKeys.size > 512) cededCursorKeys.delete(cededCursorKeys.values().next().value);
                  return { text: notice, thinking: '', images: [] };
                }
                warn(`web session rebuild throttled (sessionKey=${m.sessionKey}, ${Math.round(waitMs / 1000)}s left, `
                  + `last rebuild ${prev.chars} chars) — 本轮内等完剩余窗口后照常重建（0.16.28：不再用提示打断任务）`);
                try {
                  await sleepSignal(waitMs, opts.signal);
                } catch {
                  // 等待中途被 abort：短路到旧收场，不往下重建。
                  const notice = sessionSwitchedNotice({
                    waitLeftMs: 0,
                    sinceLastMs: now - prev.at,
                    chars: prev.chars,
                  });
                  sessionSwitchNotices += 1;
                  cededCursorKeys.add(m.sessionKey);
                  while (cededCursorKeys.size > 512) cededCursorKeys.delete(cededCursorKeys.values().next().value);
                  return { text: notice, thinking: '', images: [] };
                }
              }
              // 重放文本只算一次：既要发给网页，也要作为「这次重建了多少字符」的读数
              // 留给下一次节流判定（m.rebuild() 是纯序列化，但 40 万字符不该算两遍）。
              // 0.16.28：等待过节流窗的话时钟必须刷新——否则节流记录带着等待前的
              // 旧时间戳，下一次撞窗判定会把真实间隔算长（窗口提前失效）。
              //
              // 0.16.29（用户指令「如果新开会话-web 端，就一样把这个当上下文通过文件
              // 发送」）：落盘文件从**副本**升格为**投递源**。磁盘上那一份就是上一轮
              // 真实发出去的正本，这里优先读回它——于是「发出去什么」与「重建时用什么」
              // 恒为同一份字节。读不到（首次运行 / 曾写入失败 / 配了 'off'）才回落
              // 内存序列化：两条路都保住上下文，绝不静默丢弃。
              // 0.19.14：落盘正本只对**真实轮**成立。辅助轮（purpose 非空，如压缩）
              // 的增量正文 = 本轮末尾那条指令，落盘的主会话首轮里没有它——读回来
              // 重放会丢掉指令本身（摘要对着错误上文产出），必须走本轮自己的 rebuild()。
              const rebuildText = (m?.purpose ? null : readSessionPrompt(m.sessionKey)) ?? m.rebuild();
              lastSessionRebuildAt.set(m.sessionKey, { at: Date.now(), chars: rebuildText.length });
              while (lastSessionRebuildAt.size > 512) lastSessionRebuildAt.delete(lastSessionRebuildAt.keys().next().value);
              // 整段重建全文同步落盘（0.16.28）：这份文本就是「新开会话时把上下文
              // 通过文件发送」的会话文件——无论投递走 inline 还是附件，磁盘上必须
              // 有这一轮真实重放了什么的正本。站点教学文件不在这里重写：它由
              // fresh 首轮维护（重建的教学部分与首轮相同，executor 也没有工具
              // 清单可再生成），这里只补会话文件。
              writePromptFiles({
                siteId,
                sessionKey: m.sessionKey,
                sessionText: rebuildText,
              });
              log(`web session lost — replaying the full first-turn prompt into a fresh web chat (${rebuildText.length} chars)`);
              await drive.resetConversation(m.sessionKey).catch(() => {});
              return drive.sendTurn(m.sessionKey, rebuildText, { ...turnOpts, fresh: true });
            }
            // a vanished/deleted conversation poisons the stored slot — reset
            // it so the NEXT turn reopens a fresh web chat
            if (err && !err.code) await drive.resetConversation(m.sessionKey).catch(() => {});
            throw err;
          });
        }
        return driverFor(accountKey).sendPrompt(prompt, { signal: opts.signal, meta: m, onDelta: opts.onDelta, onThink: opts.onThink, onImage: opts.onImage, model: qualified, thinkMode });
      };
      // 发送节流（设置页「发送间隔」）：基准由 `sendGapBasis` 决定——
      //   · 'send-to-send'（默认）本轮发送距上一次*发出*不足设置值就补满；
      //   · 'end-to-start'（0.16.31）本轮发送距上一次*生成结束*不足设置值就补满，
      //     即「它刚答完，再静默 N 秒才回」——防的是对话节奏贴得太紧，与限流无关。
      // 判定与「距上次发送」都由纯函数给出，等待本身不属于网页生成耗时，
      // 单独记 sendWaitMs（右栏统计「发送前等待」）。
      let waitedMs = 0;
      const sendState = sendStateByAccount.get(accountKey) || null;
      const gapPlan = computeSendGap({
        lastSendAt: sendState?.send ?? null,
        lastEndAt: sendState?.end ?? null,
        basis: sendGapBasis,
        now: Date.now(),
        gapMs: sendGapMs,
      });
      if (gapPlan.skewed) {
        warn(`send-state for ${accountKey} is in the future (clock skew?) — treating it as "just sent"`);
      }
      if (gapPlan.waitMs > 0) {
        log(`send gap: waiting ${Math.round(gapPlan.waitMs / 1000)}s before next send to ${accountKey}`);
        // 0.16.24：等待**开始**就发布在途读数（药丸从此处开始逐秒涨），而不是
        // 等整轮结束再让账本一次性跳变。
        beginLiveWait(m, accountKey, 'gap', gapPlan.waitMs, waitedMs);
        try {
          await sleepSignal(gapPlan.waitMs, opts.signal);
        } catch (err) {
          // 0.16.31：**只有「中途被 abort」才在这里清**。旧实现把清理放进 finally，
          // 于是等待正常结束时在途读数也被抹掉，而账本要等整轮生成跑完才吸收
          //（relay 的 onMetrics）——中间那几十秒药丸掉回**上一轮**的旧值，收束时
          // 再跳上去。这正是用户报的「底下框的时间会跳动」。
          // 现在正常路径**保留**在途记录：endsAt 已把它冻结在满值，读数连续；
          // 等账本吸收时由 recordWaitMetrics 里的 clearLiveWait 收尾（同一份增量
          // 从 live 搬进账本，数字原地不动）。
          // abort 必须清：那时本轮不会有 metrics，账本永远不吸收它，留着会让药丸
          // 停在一个不动的假数上（要等 LIVE_WAIT_STALE_MS 的幽灵兜底才消失）。
          clearLiveWait(m);
          throw err;
        }
        waitedMs += gapPlan.waitMs;
      }
      // 基准在「本轮真正交给网页」的那一刻更新，且只在成功发出时——限流退避
      // 与失败都不该污染它，否则下一轮的间隔会被一次失败凭空吃掉。
      const markSent = () => rememberSend(accountKey);
      try {
        let result = null;
        let retries = 0;
        let compactRetried = false;
        for (;;) {
          markSent();
          try { result = await attempt(m?.fresh === true); break; }
          catch (err) {
            // 站点限流（DeepSeek hint rate_limited）：消息已被服务端撤回，重发
            // 安全；按退避序列重试同一轮，而不是把失败甩回 DSH 让长任务断链。
            if (err?.code === 'RATE_LIMITED' && !opts.signal?.aborted && retries < RATE_LIMIT_RETRIES) {
              retries += 1;
              // 10s 下限：限流滑窗以十秒计，几十毫秒的短间隔重试只会再次撞墙。
              // （rateLimitBackoffMinMs 仅供离线测试调小；真实运行缺省 10_000。）
              const backoff = Math.max(sendGapMs, cfg.rateLimitBackoffMinMs ?? 10_000) * retries;
              // 0.16.24：`baseMs` 传**已经等过的**时长，于是药丸从「发送间隔等待」
              // 直接接着往上涨，而不是退避一开始又从 0 重来。
              const baseBeforeBackoff = waitedMs;
              waitedMs += backoff;
              warn(`rate limited — retry ${retries}/${RATE_LIMIT_RETRIES} after ${Math.round(backoff / 1000)}s (${accountKey})`);
              beginLiveWait(m, accountKey, 'rate-limit', backoff, baseBeforeBackoff);
              try {
                await sleepSignal(backoff, opts.signal);
              } catch (err) {
                // 与上面的发送间隔等待同一条修正（0.16.31）：正常结束时**保留**
                // 在途读数，让「间隔等待 + 限流退避」两段在药丸上连成一条
                // 单调增长的曲线；只有中途 abort 才清（那时本轮不会有 metrics）。
                clearLiveWait(m);
                throw err;
              }
              continue;
            }
            // PROMPT_TRUNCATED 自动压缩重试（0.16.11）：真机 0a62dbb8 首轮 72,980 字符
            // 只被网页收下 72,969——差 11 个字符整轮作废，模型一个字都没回。0.16.7 起
            // DeepSeek 禁用附件投递，长文本只能 inline，长跑里必然复发。修法：fresh
            // 首轮按 accepted 预算重新序列化（丢最旧消息段、留显式标记），只重试一次。
            // 增量轮/无会话轮不重试——增量重放会丢本轮新消息，语义不对。
            if (err?.code === 'PROMPT_TRUNCATED' && m?.fresh === true && !compactRetried
              && typeof m.rebuild === 'function' && !opts.signal?.aborted) {
              compactRetried = true;
              const accepted = Number(err.accepted) || 0;
              // 2KB 余量：回读长度与 DOM 文本长度有细微出入，贴着 accepted 重试可能再撞一次。
              const target = Math.max(4096, accepted - 2048);
              let compacted = '';
              try { compacted = String(m.rebuild({ maxPromptChars: target }) ?? ''); } catch { compacted = ''; }
              if (compacted && compacted.length < String(prompt).length) {
                warn(`PROMPT_TRUNCATED — 一次性压缩重试（${String(prompt).length} → ${compacted.length} 字符，目标 ≤ ${target}）`);
                // 重发用的是压缩后的首轮全文；下游游标/指纹仍按完整 messages 记账
                // （与 WEB_SESSION_LOST 整段重放同一语义）。
                prompt = compacted;
                continue;
              }
            }
            throw err;
          }
        }
        if (result && typeof result === 'object') {
          // 0.16.31：end-to-start 的基准 = **本轮真正收束**的时刻。
          // 打点位置刻意放在这里（所有重试都已走完、result 已拿到）而不是
          // finally：finally 在抛错时也会跑，一次失败的尝试不该把基准往前推，
          // 否则下一轮的等待会凭空变短（与 markSent 只在成功时更新同一条纪律）。
          // send-to-send 下这个字段存了也不用，但**照存**——用户随时可能切换
          // 口径，切换那一轮不该因为「没存过 end」而退化成零等待。
          rememberTurnEnd(accountKey);
          result.metrics = {
            ...(result.metrics || {}),
            sendWaitMs: Math.round(waitedMs),
            rateLimitRetries: retries,
            promptCompactRetries: compactRetried ? 1 : 0,
            // 四个可核对字段（右栏与 /status 都透出）：本轮生效的目标值、**口径**、
            // 距基准的实际间隔、以及实际等待。用户「设了 10s 却看不到」的症结
            // 正是旧实现只在**等待过**时才显示，这些字段让它恒可核对；
            // basis 是 0.16.31 新增的：同一条读数下两个口径给出不同结论，
            // 不写清用的是哪一把尺子，「等待不像我设的」就无法判定。
            gapTargetMs: sendGapMs,
            gapBasis: gapPlan.basis,
            sincePrevSendMs: gapPlan.sincePrevSendMs,
          };
        }
        return result;
      } finally {
        // 基准不再在 finally 里无条件刷新——send 由 markSent() 在**成功发出**
        // 那一刻更新，end 由上面的 rememberTurnEnd() 在**真正收束**时更新。
        // 两者都不在这个 finally 里，因为 finally 在抛错路径上同样会跑。
        void 0;
      }
    },
    driverStatus: () => {
      const base = driver.status();
      // 聚合全部「站点 × 账户槽」的登录/运行状态：未初始化的槽给占位（不启动浏览器）。
      //
      // 0.14.7 从「按站点」升维成「按槽」：`sites` 数组现在每行是一个**槽**，
      // 每行带 `slot` / `accountKey` / `profileDir`，前端据此把 glm 与 glm#2
      // 分成两行显示。默认槽的 accountKey 就是 siteId（历史形态不变），
      // 因此只关心 siteId 的旧调用方（如 web-control 的 login-sites）仍然可用。
      const sites = [];
      for (const st of SITES) {
        for (const acc of slotsForSite(configManager.get().accounts, st.id)) {
          sites.push(siteStatusRow(st, acc));
        }
      }
      return {
        ...base,
        sites,
        // 适配器侧的会话连续性读数（0.16.4）：本次进程里作废过几次发送游标。
        // 与驱动侧的 sessionLostCount / sessionSlot 并列——「又新开对话」这类症状
        // 从此能一句话分成两侧：槽丢了看驱动那一组，游标被清掉了看这个数。
        sessionCursorInvalidations,
        // 节流改口成提示的次数（0.16.6）：用户看到的「网页会话已切换」提示共几条。
        // 与上一条分开正是为了让这两件事不再混成一个数：作废游标 = 下一轮整段重建，
        // 改口成提示 = 这一轮没内容可交但会话还在。两者都发生时的排查路径完全不同。
        sessionSwitchNotices,
        // 0.16.29：「为什么又新开了一个网页对话」的逐因计数。空对象 = 本次进程
        // 还没发生过 fresh；有键就说明发生过，且键名直接给出真因（见 buildTurn）。
        freshReasons: Object.fromEntries(freshReasons),
      };

      /** 单个槽的状态行。拆成函数是因为默认槽与非默认槽的「未初始化」分支要逐字一致。 */
      function siteStatusRow(st, acc) {
        const isDefault = acc.slot === DEFAULT_SLOT;
        const d = (st.id === 'deepseek' && isDefault) ? driver : drivers.get(acc.key);
        if (!d) {
          // 重启后未懒创建的站点：登录缓存直接读站点 profile 的落盘状态，
          // 否则面板永远「待检查」，用户只能逐站点手动核验（问题③的另一半）。
          let cached = null;
          // 默认驱动（deepseek）的登录态落盘在根 profile，其余站点在 sites/<id>/；
          // 只查后者的旧实现让 DeepSeek 每次重启都显示「待检查」，用户被迫手点。
          // 根 profile 文件只对默认站点回退——别的站点读了会把 DeepSeek 的
          // 登录态安到自己头上。
          // 槽目录由 slotProfileDir 决定；默认槽的路径与 0.14.6 逐字相同。
          // deepseek 额外回退根 profile（它的默认槽直接挂在 profileDir 上）。
          const slotDir = slotProfileDir(cfg.profileDir, st.id, acc.slot, { primary: st.mountAtRelayRoot === true });
          const statePaths = [path.join(slotDir, 'webcode-login-state.json')];
          if (st.id === 'deepseek' && isDefault) statePaths.push(path.join(cfg.profileDir, 'webcode-login-state.json'));
          for (const p of statePaths) {
            try { cached = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch { /* 未初始化过 */ }
          }
          // 旧版本（≤0.12.8）的结论是「有输入框=已登录」猜的，qwen/gemini 等游客页
          // 自带输入框的站点全被记成 true，且那时**不写 basis 字段**。因此只有带
          // basis 的落盘值才算数（driver.status() 同一规则）；否则给 null →
          // 面板显示「待检查」。规则必须与 lib/browser-driver.js 逐字一致。
          const trusted = Boolean(cached && typeof cached.basis === 'string');
          const has = trusted && typeof cached.loggedIn === 'boolean';
          // 槽身份三个字段（slot / accountKey / profileDir）在**两条分支里都要有**：
          // 前端把 sites 当同一个列表渲染，缺字段的行会让「未初始化」的槽无法显示成
          // 「glm (账户2)」而退化成裸 siteId，两行看起来一模一样。
         return { siteId: st.id, siteName: st.name, origin: st.origin, slot: acc.slot, accountKey: acc.key, displayName: accountLabel(st.name, acc.slot), profileDir: slotDir, initialized: false, running: false, busy: false, loggedIn: has ? cached.loggedIn : null, loggedInCached: has && cached.loggedIn === true, loginBasis: trusted ? cached.basis : (cached ? 'stale' : null), loginCheckedAt: cached ? cached.at : null, needLogin: has && cached.loggedIn === false, selectedModel: null, window: null, loginState: 'idle', lastLogin: null, sessionLostCount: 0, lastSessionLost: null };
        }
        // status() 可能是 null——「取不到现场」在契约里是合法返回值（懒驱动还没建起来、
        // 测试替身、或本进程尚未观测到任何东西）。旧写法紧接着就读 `s.profileDir`，
        // 于是抛 TypeError；而这条路径在 `apply() → relay.start() → relay.status()
        // → driverStatus()` 上**一定会被走到**，等于「一个还没初始化的驱动能让整个插件
        // 挂载失败」。2026-09-17 实测（node -e 直接调用 apply，注入 status(){return null}
        // 的驱动）：`TypeError: Cannot read properties of null (reading 'profileDir')
        // at siteStatusRow (lib/index.js)`。
        const s = d.status() || {};
        // sessionLostCount / lastSessionLost 必须**逐槽**透出（0.14.8 账户头像）：
        // 前端要按账户显示「会话没了」的浅红状态环，而这两个读数原先只在
        // driver.status() 顶层有——`sites` 的每一行都没有。没有它，UI 就只能
        // 靠 loggedIn 猜，或者干脆写死一个假状态（那是用户明确不要的）。
        // 未初始化的槽给 0/null（不是 omit）：前端按键索引，缺字段会让该行
        // 退化成「undefined 次」，看起来像读数坏了。
        return { siteId: st.id, siteName: st.name, origin: st.origin, slot: acc.slot, accountKey: acc.key, displayName: accountLabel(st.name, acc.slot), profileDir: s.profileDir ?? null, initialized: true, running: s.running === true, busy: s.busy === true, loggedIn: s.loggedIn ?? null, loggedInCached: s.loggedInCached === true, loginBasis: s.loginBasis ?? null, loginCheckedAt: s.loginCheckedAt ?? null, needLogin: s.needLogin === true, selectedModel: s.selectedModel ?? null, window: s.window ?? null, loginState: s.loginState ?? 'idle', lastLogin: s.lastLogin ?? null, sessionLostCount: s.sessionLostCount ?? 0, lastSessionLost: s.lastSessionLost ?? null };
      }
    },
    loginTrigger: (accountKey) => driverFor(accountKey || 'deepseek').openLogin(),
    // 设置页「登录网站」用：等这次登录真正结束（成功/失败/超时）再把结果带回
    // 控制面。旧动作是 fire-and-forget，失败只能进控制台，界面永远显示未登录。
    loginAndReport: async (siteId, { timeoutMs } = {}) => {
      // accountKey（0.14.7）：`glm#2` 登录的是账户2 那份 profile。
      // 未知站点回落到默认站点的**默认槽**（与 0.14.6 行为一致）。
      let accountKey = String(siteId || 'deepseek');
      try {
        const p = parseAccountKey(accountKey);
        accountKey = getSite(p.siteId) ? formatAccountKey(p.siteId, p.slot) : 'deepseek';
      } catch { accountKey = 'deepseek'; }
      const sid = accountKey;
      const d = driverFor(accountKey);
      const ms = Math.max(10_000, Number(timeoutMs) || cfg.loginTimeoutMs);
      const t0 = Date.now();
      let timer = null;
      try {
        const result = await Promise.race([
          d.openLogin(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`login timed out after ${ms}ms`)), ms); }),
        ]);
        return { ok: true, siteId: sid, accountKey, slot: parseAccountKey(sid).slot, siteName: getSite(parseAccountKey(sid).siteId)?.name, ms: Date.now() - t0, ...(result || {}) };
      } catch (err) {
        return { ok: false, siteId: sid, accountKey, ms: Date.now() - t0, error: String(err?.message || err) };
      } finally { if (timer) clearTimeout(timer); }
    },
    siteConnect: (accountKey) => driverFor(accountKey || 'deepseek'),
    // 展示窗口动作（有头 Edge）：侧栏「独立窗口」按钮走这里，与登录共用
    // 同一持久 profile——窗口里直接可聊，自动化轮次驱动同一页面。
    windowOpener: (accountKey, action, opts = {}) => {
      const d = driverFor(accountKey || 'deepseek');
      if (action === 'close') return d.closeWindow();
      // 多窗口错位：统计已开的窗口数作为停靠偏移，新窗不盖旧窗。
      let openCount = 0;
      try {
        for (const s of (relay ? relay.config.driverStatus().sites : []) || []) if (s?.window?.open) openCount++;
      } catch { /* 非关键路径 */ }
      return d.openWindow({ ...opts, offset: openCount });
    },
    // 「导入本机登录态」：把用户真实 Edge profile 的 cookies 采纳进**所选站点**的
    // 桥 profile。旧实现写死默认驱动——对 glm/kimi/qwen 调用会去改 DeepSeek 的
    // 登录态（站点间串号），因此按 siteId 路由到对应驱动（与 login/window 同规则）。
    sessionImport: (accountKey, dir) => driverFor(accountKey || 'deepseek').importStorageFromProfile(dir),
    onHttp: (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const pathname = u.pathname;
      // 多站点侧栏视图（主形态）：<siteId>.localhost:<port>/…
      //
      // 为什么用独立子域而不是路径前缀：站点的 SPA router / 资源解析都以
      // **pathname 基线**为准。挂在 /__webcode/site/<sid>/ 下时，站点看到的
      // pathname 是 /__webcode/site/doubao/chat/，router 认不出自己的 /chat/
      // （真机实测：doubao 的 #root 恒为空、页面只剩「会话列表」四个字）；
      // z.ai / qwen / kimi / glm 则用 history API 把地址栏写回 '/' 或
      // '/main/...'，于是后续请求落到中继根 —— 而中继根是 DeepSeek 镜像，
      // 表现就是「一点登录就跳回 DeepSeek」。
      //
      // 让每个站点拥有独立源（http://<sid>.localhost:<port>）后：pathname 与
      // 真实站点逐字一致，SPA router 基线与根相对资源全部自然正确，cookie 也
      // 按子域天然隔离。*.localhost 由浏览器与系统解析到回环，安全边界不变。
      const hostHeader = String(req.headers.host || '');
      const hostSite = /^([a-z0-9-]+)\.localhost(:\d+)?$/i.exec(hostHeader);
      // 桥自己的控制面路径在子域上照旧可用：镜像 handle 对它们返回 false，
      // 这里据此放行到下面的 webControl 分支（否则子域里的 /__webcode/xxx
      // 会既不被镜像处理、也不被控制面处理，直接挂住）。
      const LOCAL_PREFIXES = ['/v1/', '/bridge/', '/webcode/', '/__webcode/'];
      const isControlPath = LOCAL_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
      if (hostSite && getSite(hostSite[1].toLowerCase()) && !isControlPath) {
        const sid = hostSite[1].toLowerCase();
        mirrorFor(sid).handle(req, res, pathname, u.search).catch(() => { try { res.end(); } catch {} });
        return;
      }
      // 兼容旧路径形态：/__webcode/site/<siteId>/… → 对应站点 mirror
      const siteRoute = /^\/__webcode\/site\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
      if (siteRoute) {
        const [, sid, rest = '/'] = siteRoute;
        if (!getSite(sid)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unknown site: ' + sid } }));
          return;
        }
        mirrorFor(sid, { prefixed: true }).handle(req, res, rest, u.search).catch(() => { try { res.end(); } catch {} });
        return;
      }
      // web-side control fallbacks (standalone relay without DSH webServer)
      if (pathname === '/bridge/web/preview') {
        webControl.handlePreview(req, res).catch(() => { try { res.end(); } catch {} });
        return;
      }
      if (pathname.startsWith('/bridge/web/') || pathname.startsWith('/__webcode/')) {
        webControl.handle(req, res, pathname).then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'no route: ' + pathname } }));
          }
        }).catch(() => { try { res.end(); } catch {} });
        return;
      }
      if (!frontClaims(pathname)) {
        // everything else is the real-site mirror (sidebar's native view)
        mirror.handle(req, res, pathname, u.search).catch(() => { try { res.end(); } catch {} });
        return;
      }
      if (!front) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'front not ready' } }));
        return;
      }
      front.handle(req, res, pathname);
    },
  });
  const webControl = createWebControl({
    driver, relay, config: cfg, host, logger: console,
    // settings-page prompt-template preview: the exact first-turn text the
    // bridge last sent (or the static skeleton before any turn)
    presetInfo: () => lastPresetInfo,
    settingsStore: configManager,
    // B-3：把「声明窗口」的取值函数交给控制面，让 /__webcode/context-windows
    // 列出的值与 resolveModel 声明的、预算闸比的是**同一个数**。
    contextWindowOf: (m) => contextWindowFor(m),
    // 等待发送时长的累计账本（设置页「累计」+ 输入框底下的「本次会话」同源）。
    waitStatsOf: (sessionId) => waitStatsSnapshot(sessionId),
    // 真实花名册（0.15.0）：子代理来自本会话的 subagentCatalog 持久化投影，
    // Team 成员来自官方 agentTeams 服务。两者各自独立降级，读不到时给空数组
    // 并把原因放进 *Error（面板据此区分「确实没有」与「读不到」）。
    // sessionId 决定看**哪个会话**的子代理目录——面板轮询时会带上它。
    rosterOf: (sessionId) => {
      // 记下最近一次被投影的会话：任务台账的写路径（下面 `resolveWorkspaceRoot`）
      // 没有会话身份可拿，用「面板此刻正在看的那个会话」作为同源依据。
      if (sessionId) lastProjectedSessionId = String(sessionId);
      return projectRoster(ctx, sessionId);
    },
    // 任务台账的存储根（0.19.0）：与上面的任务投影**共用同一套判据**
    //（`roster.workspaceRootOf` 就是 `projectTasks` 用的那个 `cwdOf`）。
    //
    // 为什么现在只取「最近一次投影过的会话」而不是从请求里拿 sessionId：
    // 控制面请求里**没有**会话身份（随包客户端调 task 族端点时不带 body），
    // 而现编一个会话 id 去猜工作目录正是本项目禁止的那类猜测。因此这里用任务
    // 投影最近一次用过的会话做根（与「面板正在看的那个人」同源），拿不到就返回
    // null 让路由回落 `process.cwd()`——`GET task-ledger` 会把实际用的根透出。
    // 「客户端带上 sessionId」是遗留收口项，见 doc/progress.md 对应行。
    resolveWorkspaceRoot: () => workspaceRootOf(ctx, lastProjectedSessionId),
    // 「用系统默认程序打开提示词文件」（0.16.38）：平台差异收在 openPathWithDefaultApp。
    openPath: (absPath) => openPathWithDefaultApp(absPath),
  });
  const mirror = createMirror({
    siteOrigin: new URL(cfg.site).origin,
    getToken: () => driver.getToken(),
    logger: console,
    assetOrigins: getSite('deepseek')?.staticOrigins || [],
    mountPrefix: '',
    getCookies: (origin) => driver.profileCookies(origin),
    setCookies: (headers, origin) => driver.writeProfileCookies(headers, origin),
    getUserAgent: () => driver.userAgent(),
  });
  // 多站点侧栏视图：每个内容服务两个 mirror 实例（同一站点、不同挂载形态）——
  //   • 主形态：子域根挂载 http://<siteId>.localhost:<port>/（mountPrefix ''）
  //   • 兼容形态：路径前缀挂载 /__webcode/site/<siteId>/…（mountPrefix 该前缀）
  // 两者都是同一站点同一 driver 的只读转发，不额外持有浏览器状态，因此可以并存。
  const mirrors = new Map();
  function mirrorFor(siteId, { prefixed = false } = {}) {
    const sid = getSite(siteId) ? siteId : 'deepseek';
    const key = sid + (prefixed ? '#path' : '');
    if (!mirrors.has(key)) {
      const st = getSite(sid);
      mirrors.set(key, createMirror({
        siteOrigin: st.origin,
        getToken: () => driverFor(sid).getToken(),
        logger: console,
        assetOrigins: st.staticOrigins || [],
        // 子域形态下站点就住在根上，不需要任何前缀；路径形态才带前缀。
        mountPrefix: prefixed ? '/__webcode/site/' + sid : '',
        // 子域形态 pathname 与真实站点逐字一致，SPA router 基线天然正确——
        // 原先为 z.ai 打的 rootPathForSpa 补丁在子域形态下不再需要（且有害：
        // 它会把 /auth 强行改回 '/'）。仅路径兼容形态保留该开关。
        rootPathForSpa: prefixed && st.rootPathForSpa === true,
        getCookies: (origin) => driverFor(sid).profileCookies(origin),
        setCookies: (headers, origin) => driverFor(sid).writeProfileCookies(headers, origin),
        getUserAgent: () => driverFor(sid).userAgent(),
      }));
    }
    return mirrors.get(key);
  }

  // Session-mode turn builder (needs cfg; installed once). Images ride in the
  // turn meta (only the newly-arrived ones) so vision turns attach real files
  // on the web side; parallel agents get their own web conversation via the
  // agent-qualified session key.
  buildTurn = (options = {}) => {
    // 一次读取设置（宿主 settings 服务或文件），本轮三处消费同一份快照——
    // 旧实现每轮读三次，且三处可能读到不同版本。
    const settings = configManager.get();
    const extraPrompt = settings.extraPrompt;
    // 用户未显式选模型时，设置页保存的「默认模型」生效（此前只有 extraPrompt
    // 被消费，defaultModel 是个只存不用的摆设）。
    //
    // 0.16.38：主线默认模型有了**站点内覆盖**。全局 `defaultModel` 仍是「主线落点
    //（站点 + 模型）」；当落点站点是 S、且 `defaultModelBySite[S]` 存在时，用那一支
    // 而不是 defaultModel 里的模型。覆盖**只在这一处**解析，别的消费点（`/status`、
    // 设置面板的「当前主线默认」显示）都读全局那一个值，避免两套真相。
    const defaultModel = settings.defaultModel;
    const siteDefaultModel = (siteId) => {
      const bySite = settings.defaultModelBySite;
      const v = bySite && typeof bySite === 'object' ? bySite[siteId] : null;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    // 站点专属指令（0.16.38）：与全局 extraPrompt 同轮注入，按**最终站点**取——
    // 子代理站点分流会改 siteId，因此取值必须放在分流之后（见下）。
    const sitePromptFor = (sid) => {
      const bySite = settings.extraPromptBySite;
      const v = bySite && typeof bySite === 'object' ? bySite[sid] : null;
      return typeof v === 'string' ? v : '';
    };
    const thinkMode = ['on', 'off', 'auto'].includes(settings.thinkMode) ? settings.thinkMode : 'auto';
    // 间隔口径（0.16.31）：与 thinkMode 同一层收一次合法性。未知值退回默认基准，
    // 于是「配置写错」只退化成 0.14.0 的既有行为，不会让等待变得无从解释。
    const sendGapBasis = settings.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
    const messages = Array.isArray(options.messages) ? options.messages : [];
    // 站点内覆盖的判据（0.16.38）：**只对未显式选模型的主线轮生效**，且覆盖值必须
    // 落在同一个站点上——站点级默认模型的语义是「这个站点用哪一支」，它不该有能力
    // 把落点站点也搬走（那会让子代理站点分流、账户槽、槽级间隔一起错位）。
    const landed = resolveWebModel(options.model || defaultModel || cfg.modelId);
    let resolvedModel = landed;
    if (!options.model) {
      const override = siteDefaultModel(landed.siteId);
      if (override) {
        try {
          const hit = resolveWebModel(override);
          if (hit.siteId === landed.siteId) resolvedModel = hit;
          else warn('defaultModelBySite[' + landed.siteId + '] 指向别的站点，已忽略：' + override);
        } catch { warn('defaultModelBySite[' + landed.siteId + '] 不是可用模型，已忽略：' + override); }
      }
    }
    let model = resolvedModel.id;
    let siteId = resolvedModel.siteId;
    // 账户槽（0.14.7）：随模型解析一起确定。`glm@2:glm-5.3` → slot '2'；
    // 裸 id 与历史别名 → 默认槽。**默认槽的 accountKey 就是 siteId**，
    // 因此没配槽的用户在 meta 里看到的与 0.14.6 逐字相同。
    let slot = resolvedModel.slot || DEFAULT_SLOT;
    let accountKey = resolvedModel.accountKey || siteId;
    const agentId = options.agentId ?? options.agentName ?? options.agent ?? null;
    // 子代理会话模式（设置页「会话与子代理」）：own = 每个 agentId 独立网页会话
    // （同账号新对话，互不污染主对话）；share = 子代理与主会话共用同一网页对话。
    const subAgentMode = settings.subAgentMode === 'share' ? 'share' : 'own';
    // 子代理站点分流（设置页「子代理站点」）：own 模式下子代理可固定用另一站点
    // 的独立网页会话——主线与子代理同站点时消息频率叠加，容易触发站点限流
    // （真机实测「消息发送过于频繁」）。'follow' = 跟随主线站点。登录态按站点
    // 各自持久（同站点共享登录，跨站点互不影响），网页会话恒相互隔离。
    const subAgentSiteCfg = String(settings.subAgentSite || 'follow');
    const subAgentSite = subAgentSiteCfg !== 'follow' && getSite(subAgentSiteCfg) ? subAgentSiteCfg : null;
    if (agentId && subAgentMode === 'own' && subAgentSite && subAgentSite !== siteId) {
      siteId = subAgentSite;
      model = 'auto';
      // 子代理站点分流是**站点级**设置，它只指默认槽：把一个槽号带过站点边界，
      // 会去读那个站点上根本不存在的账户（`glm#2` → `zai#2`）。
      slot = DEFAULT_SLOT;
      accountKey = siteId;
    }
    // 站点专属指令（0.16.38）：取值点必须在**站点最终确定之后**——子代理站点分流
    // 刚把 siteId 换成了别的站点，在它之前取会拿到主线那一段，注入到子代理轮里。
    const sitePrompt = sitePromptFor(siteId);
    const keyAgentId = subAgentMode === 'own' ? agentId : null;
    // 会话键含 **accountKey**（0.19.4，用户指令「一个网址可以多个账号，多个对话！
    // 但是必须每个对于唯一账号」）：同一条 DSH 会话切到另一个账号 ⇒ 那是**另一条网页
    // 对话**，游标、落盘文件、发送间隔账本各自分开。这样「对话 ↔ 账号」是 1:1 的
    // **结构性**保证，而不是靠运行期比对维持。
    //
    // 一处已知代价：升级后第一次发言时旧键（不含账号段）不再命中，于是每个会话都会
    // 整段重建一次；之后稳定。`sessionKeyOf` 仍取第一段（sessionId），等待账本不受影响。
    const keyPath = options.sessionId && cfg.contextMode === 'session' && !options.purpose
      ? [String(options.sessionId), keyAgentId ? String(keyAgentId) : '', accountKey].filter(Boolean).join('::')
      : null;
    const recordPreset = (prompt) => {
      // Record every real agent turn (no aux purpose): this is the exact
      // first-turn text the bridge sends to the web page on first contact.
      if (options.purpose) return;
      lastPresetInfo = {
        prompt,
        model,
        // siteId 必须一起记：设置页要据此标出「本会话实际走的是哪一支适配」
        // （默认标签形状 / glm 代码块形状），只记 prompt 就只能靠猜。
        siteId,
        // 账户槽（0.14.7）同样要记：同一站点两个槽的提示词可能一样，
        // 但「这一轮走的是哪个账户」是排障时的第一个问题。
        slot,
        accountKey,
        agentId,
        tools: Array.isArray(options.tools) ? options.tools.map((t) => t?.name).filter(Boolean) : [],
        at: new Date().toISOString(),
      };
    };
    if (!keyPath) {
      // ---- 辅助调用（purpose 非空，如 DSH 手动压缩 /compact）----------------
      //
      // 真机取证（2026-09-25 探针 + 会话扫描）：压缩调用的 messages = 整段历史
      // 回放 + 末尾一条 user 压缩指令。旧实现把它当「无会话键的独立首轮」整包
      // 重发进临时网页会话；真实长会话（本项目 ≈190 万字符历史 ≈110 万 token）
      // 上必然被 assertContextBudget 的 100 万预算闸拦死（CONTEXT_WINDOW_EXCEEDED）
      // ——**压缩恰恰只在需要压缩的会话上做不了**，这就是用户报的「compact 不行」。
      //
      // 修法（真机 A 相已验证）：历史本来就在主会话的网页对话里，指令只需作为
      // **增量**发进同一会话，模型对着既有上下文直接产出摘要（探针实测 3 秒、
      // 结构化摘要逐字复现历史事实标记）。判定复用真实轮的同一套游标机制：
      // 契约指纹一致 + 内容锚把已发游标重定位到「只多最后一条」才走增量；
      // 任一不满足（无游标/换账号/历史被改写）回落整段独立首轮。
      // 两条路都**不碰主游标**：压缩成功后宿主替换 surface，下一真实轮锚点失配
      // 自然整段重建（摘要即新起点）；压缩失败则游标原样有效，会话照常续跑。
      const auxKey = options.sessionId && cfg.contextMode === 'session'
        ? [String(options.sessionId), keyAgentId ? String(keyAgentId) : '', accountKey].filter(Boolean).join('::')
        : null;
      const auxSt = auxKey ? sessionState.get(auxKey) : null;
      const lastMsg = messages.length ? messages[messages.length - 1] : null;
      if (auxKey && auxSt && lastMsg?.role === 'user' && messages.length >= 2) {
        const auxToolKey = Array.isArray(options.tools)
          ? options.tools.map((t) => String(t?.name || '')).filter(Boolean).sort().join(',')
          : '';
        const auxContract = contractFingerprintOf({ model, system: options.system, toolNameKey: auxToolKey, extraPrompt, sitePrompt });
        const re = auxSt.contract === auxContract ? reanchorSent(messages, auxSt.tailHashes) : null;
        if (re && re.sent === messages.length - 1) {
          const delta = serializeDelta([lastMsg], 0, auxSt.toolResults || 0, undefined, trainNoteFor(siteId, '', options.tools));
          const auxTokens = (auxSt.tokens || 0) + estimateTokens(delta.text);
          log(`aux purpose=${options.purpose} — 主会话游标命中，只发增量 ${delta.text.length} 字符进既有网页会话（key=${auxKey}）`);
          return {
            prompt: delta.text,
            inputTokens: auxTokens + usageOverheadTokens(),
            usageInput() {
              // 真实上下文规模 = 主会话已发累计 + 本条指令（网页侧上下文本就含有历史）。
              const cur = sessionState.get(auxKey);
              return auxTokens + (Number.isFinite(cur?.outTokens) ? cur.outTokens : 0) + usageOverheadTokens();
            },
            meta: {
              sessionKey: auxKey, fresh: false,
              model: formatModelId(siteId, slot, model), siteId, slot, accountKey, thinkMode,
              sendGapMs: clampSendGapMs(sendGapForSlot(settings, accountKey, siteId)),
              sendGapBasis,
              // 网页会话槽丢失（桥重启后槽空且页面不在原会话）时按既有语义整段
              // 重放——临时新会话同样能产出摘要，优于直接失败。
              rebuild: (hint) => serializeFirstTurn({
                ...options, extraPrompt, sitePrompt, siteId,
                ...(hint && Number.isFinite(hint?.maxPromptChars) ? { maxPromptChars: hint.maxPromptChars } : {}),
              }),
            },
            async attach() {
              const imgs = imagesOfMessages([lastMsg]);
              if (!imgs.length) return [];
              const { images, skipped } = await resolveImages(imgs, attachments, options.signal);
              if (skipped.length) warn('image blocks skipped (unreadable):', JSON.stringify(skipped));
              return images;
            },
            // 辅助轮不动主游标（理由见上方「两条路都不碰主游标」）。
            commit() {},
            noteOutput() {},
          };
        }
      }
      const prompt = serializeFirstTurn({ ...options, extraPrompt, sitePrompt, siteId });
      recordPreset(prompt);
      return {
        prompt,
        // 无会话键的单轮 = 它自己就是一个完整上下文，网页自己的开销在这里也是**一份**。
        inputTokens: estimateTokens(prompt) + usageOverheadTokens(),
        meta: {
          // 0.19.14：**仅 purpose 辅助轮**（压缩等）显式用自己的会话槽（旧实现无
          // sessionKey → 驱动落到 'main' 槽，可能被「URL 自愈」接到用户当前正看着的
          // 那条网页对话上，把整包辅助提示灌进错误会话）。fresh=true 保证每次辅助
          // 调用都开**新**会话——上一条压缩指令残留在同一临时会话里，会让下一条
          // 指令对着错误的上文产出摘要。
          // 无 purpose 的无状态轮（OpenAI 前端裸调用）保持原形态：无 sessionKey，
          // 走驱动的 sendPrompt 通道，不占会话槽、不参与续跑语义。
          ...(options.purpose ? {
            sessionKey: 'aux::' + String(options.purpose) + '::' + String(options.sessionId || 'adhoc'),
            fresh: true,
          } : {}),
          model: formatModelId(siteId, slot, model), siteId, slot, accountKey, thinkMode,
          // 发送间隔按**槽**取（不同登录态风控独立）；回落链见 accounts.sendGapForSlot。
          sendGapMs: clampSendGapMs(sendGapForSlot(settings, accountKey, siteId)),
          // 间隔口径（0.16.31）随 meta 一起下发到 executor，与 sendGapMs 同一层。
          sendGapBasis,
          // fresh=true + rebuild 让 PROMPT_TRUNCATED 的一次性压缩重试也覆盖辅助轮。
          rebuild: (hint) => serializeFirstTurn({
            ...options, extraPrompt, sitePrompt, siteId,
            ...(hint && Number.isFinite(hint?.maxPromptChars) ? { maxPromptChars: hint.maxPromptChars } : {}),
          }),
        },
        async attach() {
          const imgs = imagesOfMessages(messages);
          if (!imgs.length) return [];
          const { images, skipped } = await resolveImages(imgs, attachments, options.signal);
          if (skipped.length) warn('image blocks skipped (unreadable):', JSON.stringify(skipped));
          return images;
        },
        commit() {},
      };
    }
    // 游标判定（0.16.28 拆两层，见 lib/session-anchor.js 头注）：
    //
    //   · **契约指纹**——模型、系统提示词、全局指令、工具**名字集合**。任何一项
    //     变了，网页侧的教学/协议形态就变了，必须整段重建。旧实现把 options.tools
    //     整个对象 JSON.stringify 进指纹——工具描述的措辞一变（宿主升级、动态描述、
    //     参数 schema 里字段顺序变化）指纹就变，游标被判为陈旧、下一轮改走
    //     「整段重建」，网页那一侧于是被重开一个新会话。真机表现：一切正常但
    //     上下文像「不动了」（每轮都在重建首轮），并且网页会话槽被反复切换。
    //     名字集合一致就沿用同一网页会话——这条 0.16.4 的修正原样保留。
    //   · **内容锚**——已发尾部 K 条消息的逐条哈希。真机取证（session-4f236a51，
    //     2026-09-20）：宿主 goal 自动化每个 turn 把 `<goal_round>` 提示拼进数组
    //     头部、turn 结束再移除（agent/inbox/spliced start=0 各 24 次），旧整体
    //     前缀指纹对头部增删零容忍 → 每轮判 fresh → 整段重建风暴（52 次
    //     SESSION_SWITCHED、重放 245k→251k 字符逐轮膨胀、网页会话被反复重开）。
    //     现在指纹失配先试锚点重定位（reanchorSent）：在尾部找已发内容的连续
    //     匹配段，命中就**续同一网页会话**发增量；只有尾部真被改写（压缩摘要
    //     替换等）才回落整段重建。
    const toolNameKey = Array.isArray(options.tools)
      ? options.tools.map((t) => String(t?.name || '')).filter(Boolean).sort().join(',')
      : '';
    // 站点专属指令必须进**两层**指纹（0.16.38）：契约指纹决定「整段重建还是续跑」，
    // 内容指纹决定「尾部有没有变」。站点指令改了、而它只在契约指纹里，续跑判定会
    // 走「契约没变 + 尾部没变」→ 这一轮什么也不发；只进内容指纹则会每轮判 anchor-lost。
    // 两处都要，且两处的键名必须逐字相同（都是 sitePrompt）。
    const contract = contractFingerprintOf({ model, system: options.system, toolNameKey, extraPrompt, sitePrompt });
    const fingerprint = count => createHash('sha256').update(JSON.stringify({ model, system: options.system, tools: toolNameKey, extraPrompt, sitePrompt, messages: messages.slice(0, count) })).digest('hex');
    let st = sessionState.get(keyPath);
    // 0.16.29：判 fresh 的**原因**必须可查（用户第 4 问「搞清楚为什么会新开 web 端
    // 对话！」）。此前只有 `fresh` 一个布尔量，于是「新开了对话」这句话在四个
    // 完全不同的真因面前长得一模一样：首次轮、契约变了、锚定丢了、锚定后无新消息。
    // 四者的修法互不相同（前两个正常，后两个是真故障），因此逐因计数并透出 status。
    let freshReason = null;
    if (st) {
      if (st.contract !== contract) {
        st = null;
        freshReason = 'contract-changed';
      } else if (st.fingerprint !== fingerprint(st.sent) || messages.length <= st.sent) {
        // 旧判据在此直接判死。现在先试内容锚：头槽轮转 / 历史删改（只删不改尾）
        // 都能重定位续跑；锚定后没有新消息（sent' >= length）或锚定失败才判 fresh。
        const re = reanchorSent(messages, st.tailHashes);
        if (re && re.sent < messages.length) st.sent = re.sent;
        else {
          st = null;
          // 锚点找到了但没有新消息可发 ≠ 锚点完全丢失：前者是「宿主把这一轮
          // 当成重放」，后者才是「尾部真被改写」。分开记，排查时不必再猜。
          freshReason = re ? 'anchor-no-new-messages' : 'anchor-lost';
        }
      }
    } else {
      freshReason = 'no-cursor';
    }
    const fresh = !st;
    // 「换账号」这一真因要能被认出来：会话键里带了 accountKey，所以切账号必然表现为
    // 一次 `no-cursor`（新键）。那是对的，但读日志的人会把 `no-cursor` 读成「游标丢了」，
    // 于是一次**预期内**的重建被当成故障排查。这里按 sessionId 记住上次用的账号，
    // 只有真换了才把真因改写成 `account-changed`。
    if (options.sessionId) {
      const seen = lastAccountBySession.get(String(options.sessionId));
      if (fresh && seen && seen !== accountKey) freshReason = 'account-changed';
      lastAccountBySession.delete(String(options.sessionId));
      lastAccountBySession.set(String(options.sessionId), accountKey);
      while (lastAccountBySession.size > 128) {
        lastAccountBySession.delete(lastAccountBySession.keys().next().value);
      }
    }
    if (fresh && freshReason && keyPath) {
      freshReasons.set(freshReason, (freshReasons.get(freshReason) || 0) + 1);
      log(`fresh web chat (reason=${freshReason}, sessionKey=${keyPath}) — 整段重建`);
    }
    st ||= { sent: 0, toolResults: 0, tokens: 0 };
    // 增量轮的再教学提示按站点取（glm 只教代码块形状，与首轮同一立场）。
    const delta = serializeDelta(messages, st.sent, st.toolResults, undefined, trainNoteFor(siteId, '', options.tools));
    let prompt;
    if (fresh) {
      prompt = serializeFirstTurn({ ...options, extraPrompt, sitePrompt, siteId });
      recordPreset(prompt);
      // 提示词落盘（0.16.28）：fresh 首轮 = 站点教学全文（稳定部分）+ 会话上下文
      // 全文（完整首轮）同时落盘。增量轮不写——上下文没变，落盘只会制造 IO 噪音。
      // 静默失败由 prompt-store 自己兜底，这里不接错误分支。
      // 站点教学全文只在这里算一次：既落盘（prompts/<site>.md），又进「会话教学
      // 正本」表供自动续跑的**完整提醒**复用（0.19.3）。两处共用同一个字符串，
      // 于是「续跑升级后重发的教学」与「首轮真实教过的教学」不可能分叉——
      // 这是机制保证，不是靠两处各自照着写对的约定。
      const siteText = buildPreset({ ...options, extraPrompt, sitePrompt, siteId }) + teachFor(siteId, options.tools);
      rememberSiteTeaching(keyPath, siteText);
      writePromptFiles({ siteId, sessionKey: keyPath, siteText, sessionText: prompt });
    }
    else prompt = delta.text;
    // 上下文计数口径（问题③根因）：网页这一侧是「首轮全文 + 后续增量」，模型
    // 实际看到的上下文 = 本会话已发出去的全部文本之和。旧实现把 usage.inputTokens
    // 报成 estimateTokens(turn.prompt)，增量轮里 turn.prompt 只是本轮那一小段增量；
    // GUI 上下文表取最近一次 usage 的 inputTokens，于是每开新一轮就掉回接近 0，
    // 看起来「清空重新开始」。这里改成累计值（单调不减）。
    //
    // 0.16.22 补全（问题④）：上面的「已发文本之和」仍不是完整分子——网页会话的
    // 真实上下文还包含**每轮助手回复**（增量序列化刻意不发它们，网页侧本来就有）。
    // 于是旧口径系统性低估，长回复会话里低估得相当可观。补法：finishChunks/emitText
    // 在每轮收尾时经 noteOutput() 把输出估算累进会话条目的 outTokens（见下），而
    // usage.inputTokens 改报 usageInput() = 已发累计 + 助手输出累计。outTokens 的
    // 生命周期与网页会话严格对齐：fresh 重建开的是**新**网页会话，旧回复不在里面，
    // 所以新条目从 0 起算；commit() 重建条目时必须带上 st.outTokens，否则「先收尾
    // 后 commit」的时序会把已累计的输出丢掉。
    const deltaTokens = estimateTokens(prompt);
    const cumulativeTokens = fresh ? deltaTokens : (st.tokens || 0) + deltaTokens;
    return {
      prompt,
      inputTokens: cumulativeTokens,
      // usage 事件（finishChunks/emitText）用的分子：含助手输出累计。条目不存在
      // （本轮 commit 尚未执行/已被 invalidate）时退回已发累计——少报一轮输出，
      // 好过编一个数。
      usageInput() {
        const cur = sessionState.get(keyPath);
        // 网页自己注入的那部分上下文按**一次性偏移**计入（见 usageFixedOverheadTokens
        // 的注释：它在上下文里只有一份，逐轮累加会把压缩压力虚假推高）。
        return cumulativeTokens + (Number.isFinite(cur?.outTokens) ? cur.outTokens : 0) + usageOverheadTokens();
      },
      // 每轮收尾把助手输出估算累进当前会话条目（读改写 Map 里的现存引用，不重建：
      // commit() 可能先于也可能晚于本调用，两种时序下条目都必须是同一个对象）。
      noteOutput(tokens) {
        const cur = sessionState.get(keyPath);
        if (!cur || !Number.isFinite(tokens) || tokens <= 0) return;
        cur.outTokens = (cur.outTokens || 0) + tokens;
      },
      meta: {
        sessionKey: keyPath, fresh, model: formatModelId(siteId, slot, model), siteId, slot, accountKey, thinkMode,
        // 发送间隔（设置页）：executor 在发送前按它节流，限流退避也以它为基数。
        // 0.14.7 起按槽取——同一站点两个账户是两份独立的风控窗口。
        sendGapMs: clampSendGapMs(sendGapForSlot(settings, accountKey, siteId)),
        // 间隔口径（0.16.31）与它同行：executor 侧两个值缺一不可，只传间隔
        // 会让 end-to-start 的用户静默退回 send-to-send（读数上还看不出）。
        sendGapBasis,
        // 网页会话丢失时的整段重放文本（见 executor 的 WEB_SESSION_LOST 分支）。
        // 0.16.11：接受 { maxPromptChars } —— PROMPT_TRUNCATED 压缩重试从这条路取
        // 压缩后的首轮全文；无参调用（WEB_SESSION_LOST 重放）行为逐字不变。
        rebuild: (hint) => serializeFirstTurn({
          ...options, extraPrompt, sitePrompt, siteId,
          ...(hint && Number.isFinite(hint?.maxPromptChars) ? { maxPromptChars: hint.maxPromptChars } : {}),
        }),
      },
      invalidate: () => {
        // 失败的一轮同样要把节流那枚标记清掉：留着它会吃掉后面某一轮**正常**的提交，
        // 表现成「明明发出去了，下一轮还是从头重发」——与它要防的那个洞正好相反。
        cededCursorKeys.delete(keyPath);
        sessionState.delete(keyPath);
        persistCursorState();
      },
      async attach() {
        // a fresh turn replays the whole transcript → attach every image in it;
        // an incremental turn attaches only newly-arrived images
        const scope = (keyPath && !fresh) ? messages.slice(st.sent) : messages;
        const imgs = imagesOfMessages(scope);
        if (!imgs.length) return [];
        const { images, skipped } = await resolveImages(imgs, attachments, options.signal);
        if (skipped.length) warn('image blocks skipped (unreadable):', JSON.stringify(skipped));
        return images;
      },
      commit() {
        // 节流那一条收场（executor 的 SESSION_SWITCHED 分支）会先种下这枚标记：那一轮的
        // 正文**一个字节都没发给网页**，游标因此不许前进——让它前进的话，下一轮会把
        // 这一轮没发出去的消息当成已发、只发后续增量，网页侧于是永久缺一段前文
        //（静默丢上下文，本仓库三条不可越界约束之一）。标记一次即销，不吃后续轮次。
        if (cededCursorKeys.delete(keyPath)) return;
        // 先删后插把键移到 Map 尾部；配合尾部淘汰就是「最近最少使用」，
        // 旧写法对已存在键 set 不改变插入序，淘汰会先丢掉最老的热会话，
        // 表现为长会话莫名重新整段重发。
        sessionState.delete(keyPath);
        // outTokens 必须随条目延续：noteOutput 与 commit 的先后不定，若这里重建
        // 时丢掉它，「先收尾后 commit」的轮次会把助手输出累计清零（分子悄悄回落）。
        // contract / tailHashes（0.16.28）：下一轮游标判定的两层依据，见上方
        // buildTurn 注释与 lib/session-anchor.js。
        sessionState.set(keyPath, {
          sent: messages.length,
          toolResults: delta.toolResultsSent,
          fingerprint: fingerprint(messages.length),
          contract,
          tailHashes: messages.slice(-ANCHOR_LEN).map(messageHash),
          tokens: cumulativeTokens,
          outTokens: st.outTokens || 0,
        });
        if (sessionState.size > 512) sessionState.delete(sessionState.keys().next().value);
        persistCursorState();
      },
    };
  };

  // Same-origin primary mount on the DSH web server (no CORS, no cross-site
  // surface at all) — same pattern deepseek-web-import uses.
  //
  // 0.16.5（真机 2026-09-18）：这一段**不再**写进模块级 inject。`webServer` 只有
  // web 应用才提供，把它声明成硬依赖会让 `dsh --profile headless` 直接
  // pending (waiting for service: webServer) → 整个 profile 一条 entry 都起不来
  // （真机复现：`dsh --profile headless "回复两个字：收到"` 退出 1）。而**无人值守
  // 长跑**恰恰要靠没有 webServer 的 profile 驱动，所以这条依赖必须可选。
  //
  // 改成嵌套 `ctx.inject(['webServer'], …)` 后两种形态都对：
  //   · 有 webServer（web profile）→ 路由照旧挂在同源 /__webcode/* 上；
  //   · 没有（headless / 测试注入）→ 插件本体照常激活，控制面由 relay 自己的
  //     HTTP 监听兜底——onHttp 里的 web-side fallbacks 那条路径**早就存在**，
  //     不是为这次改动新加的。
  // 挂载清单仍从控制面 action 表**派生**（webControl.routes），不手写第二份；
  // 真机 2026-09-13 的教训：手写数组漏掉了 verify-login / site-probe /
  // session-import 三个 action，设置面板的「检测」按钮全部落到宿主未知 POST
  // 兜底（405 + 空 body），客户端 JSON.parse 抛 “unexpected end of JSON data”。
  const routeDisposers = [];
  // 挂载动作本身抽成函数，只为了下面那条「没有 ctx.inject 时同步走一遍」的
  // 兜底能复用同一份实现——两种入口的挂载结果必须逐字相同，不能各写一套。
  const mountWebServerRoutes = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return;
    for (const suffix of webControl.routes) {
      try {
        routeDisposers.push(webServer.register({
          kind: 'exact',
          path: '/__webcode/' + suffix,
          // 方法分派交给 webControl.handle：未知方法它回 405 JSON（带 Allow），
          // 未知路径它回 false 由这里补 404 JSON。两条路都不再有空 body。
          handler: (req, res) =>
            webControl.handle(req, res, '/__webcode/' + suffix)
              .then((handled) => {
                if (handled) return;
                const text = JSON.stringify({ ok: false, error: 'no route: /__webcode/' + suffix });
                res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
                res.end(text);
              })
              .catch((err) => {
                const text = JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 200) });
                try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(text); } catch {}
              }),
        }));
      } catch (e) {
        warn('webServer route /__webcode/' + suffix, 'failed:', e?.message);
      }
    }
    try {
      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: '/__webcode/preview',
        handler: (req, res) => webControl.handlePreview(req, res).catch(() => { try { res.end(); } catch {} }),
      }));
      log('same-origin control routes mounted on DSH webServer: /__webcode/*');
    } catch (e) {
      warn('webServer preview route failed:', e?.message);
    }

    // 设置页面 UI (HTML)
    try {
      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: '/__webcode/settings-page',
        handler: (req, res) => {
          const html = renderSettingsPage(WEB_MODELS);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }));
      log('settings-page route mounted');
    } catch (e) {
      warn('webServer settings-page route failed:', e?.message);
    }

    // 对比视图页面 (HTML) - 2026-09-18
    try {
      // 辅助函数：获取某个站点的所有已登录槽位
      const slotsForSite = (siteId) => {
        try {
          const status = relay?.config?.driverStatus?.();
          if (!status || !Array.isArray(status.sites)) return [];

          return status.sites
            .filter(s => s.siteId === siteId && s.loggedIn === true)
            .map(s => ({
              slot: s.slot || '1',
              label: s.displayName || s.siteName || siteId,
              accountKey: s.accountKey || siteId,
            }));
        } catch (err) {
          warn('slotsForSite error:', err?.message);
          return [];
        }
      };

      routeDisposers.push(webServer.register({
        kind: 'exact',
        path: '/__webcode/comparison',
        handler: (req, res) => {
          // 收集所有已登录账号
          const allSlots = new Map();
          for (const site of SITES) {
            const slots = slotsForSite(site.id);
            if (slots.length > 0) {
              allSlots.set(site.id, slots);
            }
          }
          const html = renderComparisonView({ allSlots });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }));
      log('comparison-view route mounted');
    } catch (e) {
      warn('webServer comparison-view route failed:', e?.message);
    }

  };
  // cordis 的 ctx.inject 会等服务出现后回调、服务消失后自动卸载（web profile 走这条）；
  // 测试里注入的假 ctx 没有这个方法，就同步试一遍——否则单测会直接抛
  // "ctx.inject is not a function" 而不是验证行为。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (wctx) => {
      mountWebServerRoutes(wctx.webServer);
      // webServer 服务消失时这三组路由要跟着撤掉，否则会留下指向已卸服务的句柄。
      return () => {
        for (const dispose of routeDisposers.splice(0)) if (typeof dispose === 'function') dispose();
      };
    });
  } else {
    let ws = null;
    for (const attempt of [() => ctx.webServer, () => ctx.get('webServer')]) {
      try { const w = attempt(); if (w && typeof w.register === 'function') { ws = w; break; } } catch { /* next */ }
    }
    mountWebServerRoutes(ws);
  }
  front = createOpenAiFront(relay, {
    ...cfg,
    // OpenAI 兼容前端（:8931）也必须遵守设置页的「发送间隔」。它不走 buildTurn，
    // 因此拿不到 settings 快照——这里给一个**当场求值**的取值函数（不是快照），
    // 设置改完立刻生效。真机 0.14.0 矩阵发现该路径 gapTargetMs 恒为 0（见
    // doc/verify.md 的「OpenAI 前端绕过发送间隔」）。
    sendGapMsOf: () => clampSendGapMs(configManager.get().sendGapMs),
    // 间隔**口径**同理当场求值（0.16.31）。它与间隔是一对：只传间隔不传口径，
    // end-to-start 会在这条路径上静默退回 send-to-send，而读数上还看不出
    // （这正是 0.14.0 那次「gapTargetMs 恒为 0」的同型缺陷，第二次修）。
    sendGapBasisOf: () => (configManager.get().sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send'),
  });
  relay.start();
  log(`provider "${cfg.providerId}" registered; relay on http://${cfg.host}:${cfg.port}`);
  log(`web driver ready: site=${cfg.site} profile=${cfg.driver ? '(injected)' : cfg.profileDir}`);

  // cordis: returning a disposer scopes everything to this plugin's fiber.
  return () => {
    for (const dispose of routeDisposers) if (typeof dispose === 'function') dispose();
    relay.stop();
    driver.close();
    for (const d of drivers.values()) d.close().catch(() => {});
    log('unregistered; relay closed; driver stopped');
  };
}
