// providers.js — 多站点内容服务注册表。
//
// 受 AgentDock（github.com/agentdock/agentdock）“provider 无关适配器”启发：
// 站点差异全部收口于本文件 + lib/decoder.js；驱动/中继/OpenAI 前端只面向
// {site, model} 二元组，新增一个内容服务 = 在 SITES 里加一个条目。
//
// 未知模型必须拒绝（resolveWebModel throw），绝不允许静默回退默认模型。
// 网页改版核对入口：`pnpm doctor`（test-mock/real-verify.mjs）。

import { DEFAULT_SLOT, normalizeSlot, parseModelId, formatModelId, accountLabel } from './accounts.js';

const site = (s) => Object.freeze(s);

/**
 * 网页会话 URL 契约的三态（C-2）。
 *
 * 背景（真机 2026-09-14 取证）：驱动旧实现把「会话 id ↔ 地址」的知识硬编码成
 * DeepSeek 的两种形状（`?chat_session_id=<id>` 与 `/a/chat/s/<id>`），于是
 * **GLM 永远拿不到会话 id**：探针实录
 *   page.url() = https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
 *   result.sessionId = null → rememberConversation 从不执行 →
 *   webcode-sessions-glm.json 恒为 "{}"（deepseek 那份 6058 字节）
 * → 每一轮都 WEB_SESSION_LOST → 上层 fresh 重开 → 用户看到「同一会话却每轮新开对话」。
 *
 * 而 GLM 的 SSE 首帧里 `conversation_id` 与 URL 的 `cid` 是**同一个 24 位十六进制
 * 串**（6aa6f08454b3a5a4e4f64a77），即身份一直在，只是没人去读。
 *
 * 三态语义（驱动据此决定导航动作，**不允许静默降级**）：
 *   'fresh'       —— 开新会话（首轮，或上层明确要求重开）
 *   'resume'      —— 该站点声明了地址形状，可以直接导航回既有会话
 *   'unsupported' —— 站点没有可用的地址形状：**必须报错交给上层整段重建**，
 *                    绝不能默默开一个新会话并把增量发进去（那正是历史上
 *                    「跑着跑着变傻」的根因，见 browser-driver 的 WEB_SESSION_LOST）
 */
export const NAVIGATION_STATES = Object.freeze(['fresh', 'resume', 'unsupported']);

/**
 * 从**地址**解析既有网页会话（'resume' 那一态的地址形状），解析不到返回 null。
 *
 * 每个站点只声明**自己的**形状，驱动不再写死 DeepSeek 的两种。新增站点若地址栏
 * 里带会话 id，就在这里加一条；不带（例如只把 id 放在 SSE 帧里）就声明
 * `conversationIdFromStream: true` 并**不**在这里编一个形状出来——
 * 编形状的代价是导航到一个不存在的地址，比不支持更糟。
 */
const CONVERSATION_URL_SHAPES = Object.freeze({
  // DeepSeek：`?chat_session_id=<id>` 与 `/a/chat/s/<id>` 两种（历史形态，勿动）
  deepseek: [
    (u) => u.searchParams.get('chat_session_id'),
    (u) => u.pathname.match(/\/a\/chat\/s\/([0-9a-zA-Z-]{8,64})/)?.[1],
  ],
  // 智谱清言 / Z.ai：`?cid=<24 位十六进制>`。真机 2026-09-14 实录
  //   https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
  // 且该 cid 与 SSE 首帧的 conversation_id 逐字相同（见 decoder.js 的 GlmDecoder）。
  // 注意**不能用 `chatglm.cn/main/alltoolsdetail` 这个无 cid 的形态当会话地址**：
  // 那是游客落地页，导航过去等于开新会话。
  glm: [(u) => u.searchParams.get('cid')],
  // zai **故意不在这里**：真机探针（real-probe-25-zai-url.mjs，2026-09-14）在
  // chat.z.ai 上拿到的地址是裸根 `https://chat.z.ai/`（query 键为空、页面里没有
  // 会话链接），而 real-probe-23 在 zai 上跑一轮直接 120s 超时（captureAlive=true、
  // replyChars=0）——**没有取到任何会话地址形状的证据**。
  // 按本项目一贯立场（宁可不切，也不猜着切）：编一个形状出来会让驱动导航到一个
  // 不存在的地址，比「声明不支持 + 让上层整段重建」更糟。zai 因此落在
  // 'unsupported' 态，并由 sessionLostCount / lastSessionLost 如实透出（C-3），
  // 而不是像旧实现那样每轮静默新开对话。取证后续见 doc/long-term-issues.md 第 14 条。
});

/** 由地址构造「导航回既有会话」的地址（'resume' 那一态的逆运算）。 */
const CONVERSATION_URL_BUILDERS = Object.freeze({
  deepseek: (origin, id) => origin + '/a/chat/s/' + encodeURIComponent(id),
  // GLM/Z.ai：`/main/alltoolsdetail?cid=<id>`；lang 交给站点自己补默认值。
  glm: (origin, id) => origin + '/main/alltoolsdetail?cid=' + encodeURIComponent(id),
});

/** 站点是否只从流里拿会话 id（地址栏不给形状）。GLM 两者都有，这里留作扩展点。 */
export function conversationIdFromUrl(siteId, url) {
  const shapes = CONVERSATION_URL_SHAPES[siteId];
  if (!shapes) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const pick of shapes) {
    try { const v = pick(u); if (v) return String(v); } catch { /* 试下一种形状 */ }
  }
  return null;
}

/** 能否直接导航回既有会话：能则返回地址，不能则返回 null（→ 'unsupported'）。 */
export function conversationUrlFor(siteId, origin, sessionId) {
  const build = CONVERSATION_URL_BUILDERS[siteId];
  if (!build || !sessionId) return null;
  try { return build(String(origin).replace(/\/$/, ''), String(sessionId)); } catch { return null; }
}

/**
 * GLM 系站点（智谱清言 / Z.ai）向 DSH 声明的上下文窗口（token）。
 *
 * 为什么是 1_000_000 而不是别的数：**这是真机实测出来的下界，不是抄来的规格**。
 * 探针 `test-mock/real-probe-23-glm-budget.mjs` + `real-probe-24-glm-ceiling.mjs`
 *（2026-09-14，有头 Edge + 真实登录态）把 composer 逐档灌满并回读，得到：
 *
 *   1000 → 1000 · 4000 → 4000 · 16000 → 16000 · 32000 → 32000 · 64000 → 64000
 *   128000 → 128000 · 200000 → 200000 · 250000 · 400000 · 600000 · 800000
 *   1000000 → 1000000 · 1200000 → 1200000      ← 全部逐字回读，**没有一档被截断**
 *
 * 即：**网页输入框在 120 万字符处仍未触顶**，所以「输入框容量」从来不是这些站点的
 * 瓶颈（旧注释里把它当成未知数、随手写 1_000_000 当占位，方向就错了）。
 * 按本仓库自己的估算口径（CJK≈0.7 tok/字符 + 10% 余量）折算，120 万字符 ≈ 92 万
 * token，因此 1_000_000 是**有实测支撑的下界**，而不是乐观估计。
 *
 * 仍然要说清它不是什么：它**不是模型注意力窗口的规格**——那个数探针测不到（要看
 * 站点服务端的截断行为），并且会随网页改版变化。真实语义是「本桥愿意让 transcript
 * 长到多大」，配合 B-2 的发送前预算闸（`CONTEXT_WINDOW_EXCEEDED`）使用：越界在
 * **发出之前**就是一条可读的报错，而不是发出去被网页静默截半截。
 */
const GLM_CONTEXT_WINDOW = 1_000_000;

export const DEEPSEEK = site({
  id: 'deepseek', name: 'DeepSeek 网页版', origin: 'https://chat.deepseek.com',
  // **必须挂在中继根上，不能用自己的子域**（真机 2026-09-13）：DeepSeek 前端
  // 会校验宿主名，`http://deepseek.localhost:8931/` 触发
  // `Unknown hostname: deepseek.localhost`，`#root` 永远 0 个子节点——右栏整页
  // 空白，而它正是唯一端到端可用的基线，回归代价最大。中继根本来就是它
  //（relay 默认站点），根相对资源/SPA 路由天然正确，不需要子域那层隔离。
  mountAtRelayRoot: true,
  // 静态资源域：站点 HTML 用绝对 URL + crossorigin 引用，而该域返回的
  // Access-Control-Allow-Origin 是字面量通配（https://*.deepseek.com，非法值），
  // 浏览器据此硬性拒绝执行脚本，整页退化成「页面资源加载异常」。
  // 这些域改由 lib/mirror.js 同源转发（/__static/<host>/…）。
  staticOrigins: ['https://fe-static.deepseek.com'],
  completionPaths: ['/api/v0/chat/completion'],
  input: 'textarea.ds-scroll-area',
  // 这里**故意不声明 loginProbe**，理由是真机事实（2026-09-13）：
  // DeepSeek 的游客落地页就是登录页本身（镜像里实测停在 `/sign_in`，正文
  // 「+86 发送验证码 / 登录 / 密码登录 …」，`document.querySelectorAll('textarea')`
  // 为 0），而已登录的会话页有 `textarea.ds-scroll-area`。因此「回退输入框判定」
  // 在它身上恰好是准的；再叠一条含「登录」字样的 bad 特征反而容易误伤。
  sendButton: "div[role='button']:has(path[d^='M8.3125'])",
  stopButton: "div[role='button']:has(path[d^='M2 4.88'])",
  attachSelector: "input[type='file']",
  // 附件上传后的可见证据（2026-09-18 补充）。DeepSeek 用构建期哈希类名，
  // 通用类名列表必然零命中。改为宽松选择器：含 webcode/context/markdown 的节点。
  // 主证据仍是文件名本身（filenameEvidence），这只是提速副证据。
  attachPreview: "[class*='file'], [class*='attachment'], [data-file], [data-attachment]",
  decoder: 'deepseek', stream: true,
  // 单一模型入口：桥只暴露一个 DeepSeek（深度思考）。
  // 旧版三 pill（快速/专家/识图）已随 2026-09-10 新版 UI 取消——真机实测
  // model_type 恒为 default，模式差异只剩「深度思考」开关；带图发送同样是
  // default + ref_file_ids，由网页自行路由。因此不再拆成三个模型 id，
  // 带图能力对本模型自动生效（有图就传，无图不受限）。
  models: [
    { id: 'deepseek', name: 'DeepSeek（深度思考）', labels: ['专家模式', 'DeepSeek'], thinking: true, context: 1_000_000, acceptsImages: true },
  ],
});

export const GLM = site({
  id: 'glm', name: '智谱清言 (GLM)', origin: 'https://chatglm.cn',
  // sdata.chatglm.cn 是埋点上报域：跨域被拒不影响功能，但会在控制台刷
  // 一片 CORS 错误（真机 52 条）。纳入同源转发后干净且仍能上报。
  staticOrigins: ['https://sdata.chatglm.cn', 'https://at.alicdn.com', 'https://o.alicdn.com', 'https://lf3-data.volccdn.com', 'https://res.wx.qq.com'],
  completionPaths: ['/chatglm/backend-api/assistant/stream'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'glm', stream: true,
  // 未登录特征（2026-09-13 真机）：GLM 游客页**自带完整输入框**，旧判定必然把
  // 未登录记成已登录（空 profile 上实测 verify-login 回 true）。它的登录入口
  // 不是 button/a，而是侧栏里的一个叶子节点
  // `<p class="sidebar-user-name">登录</p>`（同层还有 `sidebar-user-desc`
  // 「登录送积分好礼」）——因此只限定 button/a 会漏掉（实测 count=0）。
  // 限定到 p 既命中该节点，又避开「不限定的 :has-text 会命中祖先 div」的老坑；
  // 已登录页此处显示用户名，误判方向也只是「提示去检测」，不会谎报已登录。
  loginProbe: {
    bad: 'p:has-text("登录"), button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  // 模型选择契约 —— 真机 dump（2026-09-13，test-mock/out/model-dropdown-glm-*.json）：
  //   触发  <div class="think-mode-trigger mode-button …"><span class="think-label">GLM-5.3</span>极致</div>
  //   弹层  <div class="think-mode-item …"> <span class="item-model-box">GLM-5.3</span> …
  //   实测选项：GLM-5.3（selected）/ GLM-Flash（desc「5.3-Flash，回复速度快」）
  //
  // 别拿 `.model-select-container` 当模型入口（probe 首跑点开的就是它）：那是
  // **工具选择器**（联网模式 / Agent / 研究报告 / PPT制作 / 数据分析 / 创意海报 /
  // 网页应用），点它会把会话切进某个 Agent 工具，而不是切换模型版本。
  modelPicker: {
    trigger: ['.think-mode-trigger', '.mode-button'],
    option: '.think-mode-item',
    // 名字节点优先用 .item-name：Flash 条目的结构是
    //   <span class="item-model-box">GLM-Flash<span class="item-new">new</span></span>
    //   <span class="item-name">GLM-Flash</span>
    // —— .item-model-box 的 textContent 被徽章污染成「GLM-Flashnew」，而
    // .item-name 是干净的名字。GLM-5.3 条目没有 .item-name，回退到
    // .item-model-box（它本身就是干净的「GLM-5.3」）。
    // 注意不能用 `.item-model-box:not(.item-new)`：.item-new 是它的**子节点**，
    // 不是同一元素上的类，:not() 排除不掉（真机实测仍然读到 GLM-Flashnew）。
    optionName: ['.item-name', '.item-model-box'],
    // 回读用 .think-label：它同时含模型名与思考档位（如「GLM-5.3极致」），
    // 判定按「包含」即可（见 verify-model-switch 的比较口径）。
    selected: ['.think-label'],
  },
  // 未真机校准的站点只给「网页当前模型」入口:桥不宣称具体版本号(网页
  // 模型更新极快,硬编码清单必然过时——2026-09-08 用户实测 GLM 网页已到
  // 5.x,旧目录还在 4.5/4.6)。在右侧网页里手动选模型,桥按当前网页状态对话。
  models: [
    // labels 用网页逐字文本（model-picker 的精确匹配按它比对）：网页上
    // 版本条目显示 GLM-5.3，Flash 条目显示 GLM-Flash。
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-Flash'], context: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'auto', name: '智谱清言', labels: ['GLM'], context: GLM_CONTEXT_WINDOW },
  ],
});

export const CHATGPT = site({
  id: 'chatgpt', name: 'ChatGPT 网页版', origin: 'https://chatgpt.com',
  completionPaths: ['/backend-api/conversation'],
  input: '#prompt-textarea, textarea[data-id], textarea',
  attachSelector: "input[type='file']",
  decoder: 'chatgpt', stream: true,
  // 未登录特征：游客页可见的 Log in / Sign up 入口。本机网络层对 chatgpt.com
  // 返回 403（WAF），这条判定目前更多是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'ChatGPT', labels: ['ChatGPT'], context: 196_000 },
  ],
});

export const KIMI = site({
  // 2026-09-11 实测：kimi.moonshot.cn 已只剩 302 → https://www.kimi.com/，
  // 镜像按旧域名取页会拿到空跳转壳，右侧栏打不开。改用真实站点。
  id: 'kimi', name: 'Kimi (月之暗面)', origin: 'https://www.kimi.com',
  staticOrigins: ['https://statics.moonshot.cn'],
  // 真实流端点带动态会话 id：/api/chat/{id}/completion/stream（Kimi-Free-API 同构），子串匹配
  completionPaths: ['/api/chat/', '/completion/stream'],
  // 2026-09-13 真机校准：kimi 网页**没有 textarea**，输入框是 contenteditable
  // 的富文本编辑器（div.chat-input-editor）。旧选择器只有 textarea，输入框
  // 计数恒为 0 → 已登录的 profile 被判成「未登录」，设置页/右栏徽标永远显示
  // 「未登录」，点「检测」也没用（检测走的就是同一个输入框判定）。
  input: 'div.chat-input-editor, div[contenteditable="true"], textarea.chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'kimi', stream: true,
  // 未登录特征：游客页有可见的「登录」入口（真机实测未登录镜像页文案为
  // 「登录以同步历史会话」+「登录」）。已登录页这两个入口都消失。
  // 注意必须限定 button/a——不限定的 :has-text 会命中包含该文案的祖先 div，
  // 已登录页的其它节点一旦出现「登录」二字就会误判。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  // 模型选择契约 —— 真机 dump（2026-09-13，test-mock/out/model-dropdown-kimi-*.json）：
  //   触发  <div class="model-name"><span class="current-effort">进阶</span></div>
  //   弹层  <button role="menuitemradio" class="model-item[ checked]">
  //           <span class="header">K3</span><span class="desc">擅长对话与 Agent 任务，全能旗舰</span>
  //   实测选项（逐字）：快速 / K3 / K3 集群
  //
  // ⚠️ 触发节点的文本是**当前思考强度**（「快速」或「进阶」），不是模型名 ——
  // 触发只能按 class 定位，绝不能按文本「快速」定位（那会随强度档位变化，
  // 也是 probe-model-picker 首跑用 getByText 没抓到模型触发的原因）。
  modelPicker: {
    trigger: ['.model-name', '.current-effort'],
    option: 'button[role="menuitemradio"].model-item',
    optionName: ['.header'],
    // 回读口径②：kimi 的触发按钮只显示「思考强度」（快速/进阶），模型名只在
    // **展开的菜单**里以选中态出现。readbackInMenu 让 picker 重新开菜单读
    // checkedOption 的 .header（即当前选中的模型名）。
    // 真机 verify-model-switch 首跑读到「进阶」，无法判断模型是否真的换了。
    readbackInMenu: true,
    checkedOption: 'button.model-item.checked',
    scopedToComposer: true,
  },
  models: [
    { id: 'k3', name: 'K3', labels: ['K3'], context: 1_000_000, acceptsImages: true },
    { id: 'k3-cluster', name: 'K3 集群', labels: ['K3 集群'], context: 1_000_000 },
    { id: 'quick', name: '快速', labels: ['快速'], context: 1_000_000 },
    { id: 'auto', name: 'Kimi', labels: ['Kimi'], context: 1_000_000 },
  ],
});

export const QWEN = site({
  id: 'qwen', name: '通义千问 (Qwen)', origin: 'https://chat.qwen.ai',
  staticOrigins: ['https://g.alicdn.com', 'https://img.alicdn.com', 'https://assets.alicdn.com'],
  // 浏览器端为 OpenAI 兼容 SSE。2026-09-12 真机：流端点已迁到
  // /api/v2/chat/completions（v2 + completions，含 /api/chat 的旧串不再命中），
  // 子串匹配同时覆盖新旧端点。
  completionPaths: ['/api/chat', '/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // Qwen Studio（2026-09-12 真机）：程序化 Enter 不触发发送（消息停在框里），
  // 发送按钮是稳定特征 class .send-button（aria=发送）——与 z.ai 同类问题。
  sendButton: '.send-button',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'openai-sse', stream: true, experimental: true,
  // 未登录特征（2026-09-13 真机）：qwen 游客页**自带完整输入框**
  // （textarea.message-input-textarea 可见），旧判定「有输入框=已登录」于是把
  // 未登录记成已登录——用户看到的正是「qwen 没有登录却直接显示登录了」。
  // 游客页右上角有可见的「登录 / 注册」按钮，命中即判未登录。
  loginProbe: {
    bad: 'button:has-text("登录"), button:has-text("注册"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  models: [
    { id: 'auto', name: 'Qwen', labels: ['Qwen'], context: 1_000_000 },
  ],
});

export const DOUBAO = site({
  id: 'doubao', name: '豆包', origin: 'https://www.doubao.com',
  completionPaths: ['/samantha/chat/completion'],
  // 2026-09-13 真机校准：豆包输入框是 tiptap/ProseMirror 的 contenteditable
  // （div.tiptap.ProseMirror），不是 textarea。旧选择器只有 textarea，驱动侧
  // 定位输入框必然失败。
  input: 'div.tiptap.ProseMirror, div[contenteditable="true"], textarea[data-testid="chat_input_input"], textarea',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'doubao', stream: true, experimental: true,
  // 未登录特征：游客页有可见的「登录」按钮；登录后该按钮消失。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  // 模式选择契约 —— 真机 dump（2026-09-13，test-mock/out/doubao-mode-*.json）：
  //   豆包没有下拉式模型选择器；它的「模型」是**对话 / 工作**两个模式，
  //   常驻在输入框上方的一个**分段控件**里：
  //     容器 <div class="relative flex h-54 items-center justify-center rounded-full p-[3px] bg-dbx-fill-trans-20 mt-20">
  //       选项 <button class="… w-160 … text-dbx-text-primary">  <span class="truncate">对话</span>
  //            <button class="… w-160 … text-dbx-text-secondary"><span class="truncate">工作</span>
  //
  // 与弹层式站点的两点根本不同（model-picker 用 segmented 开关区分）：
  //   ① **没有触发按钮**：选项本身就常驻页面，点「触发」等于先把模式切走，
  //      因此 segmented 契约**故意不声明 trigger**。
  //   ② **没有 aria-selected**：选中态只体现在 class 上——
  //      选中 = text-dbx-text-primary，未选 = text-dbx-text-secondary，
  //      所以回读用 selectedStateClass / unselectedStateClass。
  modelPicker: {
    segmented: true,
    option: 'div.bg-dbx-fill-trans-20.rounded-full > button, button.w-160',
    optionName: ['span.truncate'],
    selectedStateClass: 'text-dbx-text-primary',
    unselectedStateClass: 'text-dbx-text-secondary',
  },
  models: [
    // 本地默认：**对话**（豆包标准对话模式）。放在最前即首选。
    { id: 'chat', name: '对话', labels: ['对话'], context: 256_000, acceptsImages: true },
    { id: 'work', name: '工作', labels: ['工作'], context: 256_000, acceptsImages: true },
    { id: 'auto', name: '豆包', labels: ['豆包'], context: 256_000 },
  ],
});

export const GROK = site({
  id: 'grok', name: 'Grok (xAI)', origin: 'https://grok.com',
  completionPaths: ['/rest/app-chat/conversations/new'],
  input: 'textarea[aria-label], textarea',
  attachSelector: "input[type='file']",
  decoder: 'grok', stream: true,
  // 未登录特征（2026-09-13 真机）：游客页有可见的「登录 / 注册」，且自带输入框
  // （空 profile 上实测 verify-login 回 true）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Sign up"), a:has-text("Sign up")',
  },
  models: [
    { id: 'auto', name: 'Grok', labels: ['Grok'], context: 256_000 },
  ],
});

export const CLAUDE = site({
  id: 'claude', name: 'Claude (Anthropic)', origin: 'https://claude.ai',
  completionPaths: ['/api/append_message'],
  input: 'div[contenteditable="true"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'claude', stream: true,
  // 未登录特征：游客页可见的 Sign in / Log in。claude.ai 对本机返回 403
  //（地区受限），这条同样是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'Claude', labels: ['Claude'], context: 200_000 },
  ],
});

// z.ai（智谱 GLM 的海外站点）：与 chatglm.cn 同源模型、不同域与不同前端。
// 浏览器端为 OpenAI 兼容 SSE（/api/chat/completions），故复用 'openai-sse'
// 解码器；选择器用「特征选择器」而不是站点版本 class（改版频繁，特征更稳）。
export const ZAI = site({
  id: 'zai', name: 'Z.ai (GLM 海外版)', origin: 'https://chat.z.ai',
  // 选择器里显示的站点键。默认等于 id，只有这里不同：站点的真实身份就是
  // 「z.ai」这个域名（用户要的正是「一眼看出是哪个网站」），而 `zai` 只是
  // 我们内部的路由 id。二者不同不影响解析——解析只认 id（见 resolveWebModel）。
  shortKey: 'z.ai',
  // 静态资源域：z.ai 的前端包/字体放在独立域上，跨域 + 非法 ACAO 会被浏览器
  // 拒绝执行（与 DeepSeek 同一类问题）。纳入同源转发（lib/mirror.js）。
  // api.z.ai 是前端调后端的绝对域（真机 probe-net 实测），不代理则页面提示
  // 「无法连接到服务」。
  staticOrigins: ['https://z-cdn.chatglm.cn', 'https://api.z.ai'],
  // 镜像页需要看到根路径（真机证据 2026-09-13）：
  // z.ai 的前端 router 只认根路径。同一个镜像挂在 /__webcode/site/zai/ 下时，
  // 它的错误边界会渲染「200: An unexpected error has occurred.」——接口全部
  // 200 + 正确 JSON，纯粹是路由基线不匹配；把 pathname 改写成 '/'（其余资源
  // 已由镜像改写成带前缀的绝对路径，运行时根相对请求由 bootstrap 钩子补前缀）
  // 后立刻恢复成正常界面（输入框出现）。GLM 不需要这个开关。
  rootPathForSpa: true,
  completionPaths: ['/api/chat/completions', '/api/v1/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // z.ai 对程序化 Enter 不响应，必须点发送按钮（真机 2026-09-12：轮次静默挂死正因如此）。
  sendButton: '#send-message-button',
  attachSelector: "input[type='file']",
  // 附件落到页面上的可见证据（上传确认用，见 browser-driver 的 waitForAttachment）
  attachPreview: "img[src^='blob:'], [class*='attachment'], [class*='file-card']",
  decoder: 'openai-sse', stream: true, experimental: true,
  // 登录判定特征：z.ai 游客页自带完整输入框（真机 2026-09-12 实测：未登录
  // 时 textarea + #send-message-button 都在，「有输入框=已登录」必然误报），
  // 未登录特征是可见的「登录」按钮；bad 命中 → 判未登录。注意 :text-matches
  // 对嵌套 span 按钮不命中（真机实测 count=0），has-text 才稳定。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  // 模型选择契约 —— 全部来自 probe-model-dropdown.mjs 的真机 dump
  //（2026-09-13，证据 test-mock/out/model-dropdown-zai-*.json）：
  //   触发  <button class="modelSelectorButton" aria-label="选择一个模型">GLM-5.3-Flash</button>
  //   弹层  <button aria-label="model-item"> … <div class="line-clamp-1">GLM-5.3</div> …
  // 实测选项（逐字）：GLM-5.3-Flash / GLM-5.3 / GLM-5.2
  //
  // 注意 "GLM-5.3" 是 "GLM-5.3-Flash" 的**前缀** —— 这正是 model-picker 必须做
  // 精确名匹配、不能做前缀匹配的原因（0.12.9 的 getByText 启发式会选错模型）。
  modelPicker: {
    trigger: ['button.modelSelectorButton', '[aria-label="选择一个模型"]'],
    option: "button[aria-label='model-item']",
    optionName: ['.line-clamp-1'],
    selected: ['button.modelSelectorButton'],
  },
  models: [
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-5.3-Flash'], context: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.2', name: 'GLM-5.2', labels: ['GLM-5.2'], context: GLM_CONTEXT_WINDOW, acceptsImages: true },
    // 站点默认：不切换网页模型，按页面当前选择走。名字保持干净的站点名
    //（regression.test.mjs 有护栏：模型名不得含「网页当前模型」这类元描述，
    // 也不得用括注——选择器里应当是干净名字）。
    { id: 'auto', name: 'Z.ai', labels: ['GLM'], context: GLM_CONTEXT_WINDOW },
  ],
});

// Gemini 的 RPC 流不是稳定契约 — 用 DOM 终态抓取兜底（decoder: 'dom'）。
export const GEMINI = site({
  id: 'gemini', name: 'Gemini (Google)', origin: 'https://gemini.google.com',
  completionPaths: [],
  input: 'div.ql-editor[contenteditable="true"], div.ql-editor, rich-textarea textarea, textarea, div[contenteditable="true"]',
  attachSelector: "input[type='file']",
  decoder: 'dom', stream: false, experimental: true,
  // 未登录特征：gemini 游客页有可见的「登录」按钮（.signed-out-buttons 内），
  // 登录后换成账号头像。旧判定只看输入框，游客页的 ql-editor 让未登录被记成
  // 已登录（真机 2026-09-13：verify-login 报 true，页面却明写「登录」）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in")',
  },
  models: [
    { id: 'auto', name: 'Gemini', labels: ['Gemini'], context: 1_000_000 },
  ],
});

/** 全部内容服务（顺序即 OpenAI /models 列表顺序）。 */
export const SITES = Object.freeze([DEEPSEEK, GLM, CHATGPT, KIMI, QWEN, DOUBAO, GROK, CLAUDE, GEMINI, ZAI]);

/**
 * 选择器里显示的模型名 = `站点短键/模型 id`（0.14.0）。
 *
 * 为什么不是只写模型名：DSH 的模型选择器**只渲染 model.name**，不拼 provider
 * （见 dsh-client-ui-model-selection 的 option 渲染）。旧目录里 8 个站点都叫
 * `auto`，选择器上就是一串分不清出处的「ChatGPT / Qwen / Grok」；而 `glm-5.3`
 * 这种名字同样看不出是 chatglm.cn 还是 z.ai。带上站点短键后，每一行都自带
 * 出处，且与 id 一一对应（`z.ai/glm-5.3` ↔ id `zai:glm-5.3`）。
 *
 * 注意这**只是显示名**：id 仍是 `site:model`，别名表、历史设置值、会话游标、
 * 路由全部不动。
 *
 * 0.14.7（同站多账户）追加一条：显示名后面可能跟 `(账户N)`。
 * **默认槽不跟** —— 见 accounts.accountLabel 的注释，默认槽的显示名必须与 0.14.6
 * 逐字相同，否则既有用户的下拉里会凭空多出他们没配置过的东西。
 */
export function modelDisplayName(st, m, slot) {
  return accountLabel(st.shortKey || st.id, slot) + '/' + m.id;
}

/**
 * 兼容别名 id 集合（0.14.0）。
 *
 * `deepseek-web` 是不带站点前缀的历史 id（旧版 OpenAI 前端与旧会话用它），
 * 它与 `deepseek:deepseek` 指向**同一个**模型，因此显示名逐字相同。若把它照
 * 单渲染，选择器上会出现两行一模一样的 `deepseek/deepseek`——用户看到的就是
 * 「下拉里有重复项」。
 *
 * 因此：**列表接口仍返回它**（历史会话、`agent-default-model` 的旧值、OpenAI
 * 前端的 `model: 'deepseek-web'` 都依赖它解析），但**选择器下拉过滤掉它**。
 * 这份集合是「哪些是别名」的唯一定义处：UI（client.cjs）、适配器
 * （index.js listModels）与测试都必须从这里取，不许各自再写一份字面量。
 */
export const MODEL_ALIAS_IDS = Object.freeze(new Set(['deepseek-web']));

/**
 * 全站点模型目录（限定 id + 能力元数据）——DSH 模型选择器与
 * OpenAI /v1/models 共用这一份，保证两边模型列表一致。
 *
 * `accounts`（0.14.7，可选）：设置里的账户槽数组。传了就把每个启用槽展开成一组条目：
 *
 *   不传 / 传空             → 与 0.14.6 **逐字节相同**的输出（默认槽）
 *   [{siteId:'glm',slot:'2'}] → glm 的默认槽与 `glm@2` 各出一组
 *
 * **兼容性硬约束**：不传参数时，本函数必须与 0.14.6 的输出完全一致。
 * `test/model-labels.test.mjs` 与 `test/multi-site-decoder.test.mjs` 的既有断言
 * 就是这条约束的执行者——它们**不传参数**，因此任何默认槽形状的漂移都会立刻失败。
 */
export function listAllModels(accounts) {
  const out = [];
  const slotsBySite = new Map();
  for (const a of normalizeAccountsList(accounts)) {
    if (!slotsBySite.has(a.siteId)) slotsBySite.set(a.siteId, []);
    slotsBySite.get(a.siteId).push(a.slot);
  }
  for (const st of SITES) {
    // 默认槽永远在第一位：不传 accounts 时它就是唯一的一项，输出因此与 0.14.6 相同。
    const slots = [DEFAULT_SLOT, ...(slotsBySite.get(st.id) || [])];
    for (const slot of slots) {
      for (const m of st.models) {
        out.push({
          id: formatModelId(st.id, slot, m.id),
          siteId: st.id,
          slot,
          siteName: st.name,
          name: modelDisplayName(st, m, slot),
          labels: m.labels,
          context: m.context || null,
          thinking: m.thinking === true,
          vision: m.vision === true,
          // acceptsImages = 该模型的**网页端**能收下图片附件（与 vision 不同：
          // vision 是 DeepSeek 那种必须带图的独立「识图模式」；这里只是「可以
          // 带图发」，不带图也能正常用）。宿主据此声明 inputModalities。
          acceptsImages: m.acceptsImages === true,
          imageOut: m.imageOut === true,
          experimental: st.experimental === true,
        });
      }
    }
  }
  // 兼容别名条目：它指向默认槽（历史值语义），槽信息不参与。
  // 显示名刻意写死为「无槽后缀」——它与 `deepseek:deepseek` 同名是**过滤的前提**
  // （见 MODEL_ALIAS_IDS 注释），一旦带上槽后缀这个前提就没了。
  out.push({ id: 'deepseek-web', siteId: 'deepseek', slot: DEFAULT_SLOT, siteName: DEEPSEEK.name, name: modelDisplayName(DEEPSEEK, DEEPSEEK.models[0]), labels: [], thinking: true, vision: false, imageOut: false, experimental: false });
  return out;
}

/** 内部：只取合法的 `{ siteId, slot }` 对，非法条目静默丢弃（设置文件可手改）。 */
function normalizeAccountsList(accounts) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(accounts) ? accounts : []) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    const siteId = String(entry.siteId ?? '').trim();
    if (!SITES.some((s) => s.id === siteId)) continue;
    const slot = normalizeSlot(entry.slot);
    if (!slot || slot === DEFAULT_SLOT) continue;   // 默认槽已无条件包含，不重复
    const key = siteId + '#' + slot;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ siteId, slot });
  }
  return out;
}

/** 兼容别名 → 'site:model' 限定 id。 */
const ALIASES = Object.freeze({
  // 历史 id / 兼容别名 → 唯一 DeepSeek 模型（升级后旧设置值仍可用）。
  'deepseek-web': 'deepseek:deepseek',
  'deepseek-reasoner': 'deepseek:deepseek',
  flash: 'deepseek:deepseek',
  vision: 'deepseek:deepseek',
  'gpt-4o': 'chatgpt:auto', chatgpt: 'chatgpt:auto',
  glm: 'glm:auto', 'glm-4.5': 'glm:glm-5.3', 'glm-4.6': 'glm:glm-5.3',
  // GLM 版本别名（0.13.0 起 glm 站点有真实版本条目；旧设置值必须仍解析得开）
  'glm-5.3': 'glm:glm-5.3', 'glm-5.3-flash': 'glm:glm-5.3-flash',
  // 用户口头/历史写法（点号、连字符、大小写混用）统一收敛到 z.ai 的真实条目
  'z.ai-glm5.3': 'zai:glm-5.3', 'z.ai-glm5.3-flash': 'zai:glm-5.3-flash',
  'zai-glm-5.3': 'zai:glm-5.3', 'zai-glm-5.3-flash': 'zai:glm-5.3-flash',
  'glm-zai-5.3': 'zai:glm-5.3',
  kimi: 'kimi:auto', 'kimi-k3': 'kimi:k3', k3: 'kimi:k3', 'k3-cluster': 'kimi:k3-cluster',
  qwen: 'qwen:auto', doubao: 'doubao:auto',
  grok: 'grok:auto', claude: 'claude:auto', gemini: 'gemini:auto',
  zai: 'zai:auto', 'z-ai': 'zai:auto', 'chat.z.ai': 'zai:auto', 'glm-zai': 'zai:auto',
});

export const DEFAULT_MODEL_ID = 'deepseek-web';

function resolved(st, m, slot = DEFAULT_SLOT) {
  const s = normalizeSlot(slot) || DEFAULT_SLOT;
  return Object.freeze({
    site: st, siteId: st.id, siteName: st.name, origin: st.origin,
    // 账户槽（0.14.7）：默认槽恒为 DEFAULT_SLOT，调用方据此决定 profile 目录。
    slot: s, accountKey: s === DEFAULT_SLOT ? st.id : st.id + '#' + s,
    decoder: st.decoder, stream: st.stream !== false, experimental: Boolean(st.experimental),
    id: m.id, name: modelDisplayName(st, m, s), labels: m.labels,
    // 网页上的原始名字（不含站点短键）。model-picker 的兜底目标名用它——
    // 网页上从来不会写 `z.ai/glm-5.3`，拿显示名去比对必然 option-not-in-list。
    webName: m.name,
    thinking: m.thinking === true, vision: m.vision === true, imageOut: m.imageOut === true,
    acceptsImages: m.acceptsImages === true,
  });
}

/**
 * 解析任意模型 id（裸 id / `site:model` / `site@slot:model` / 别名 / `{id}`）
 * → 站点 + 模型 + 账户槽。未知必须 throw。
 *
 * 0.14.7 的解析顺序刻意是**别名优先于槽解析**：
 *
 *   别名表里的值（`flash`、`glm-4.6`、`zai`…）全部指向**默认槽**——
 *   它们代表历史设置值，历史值是在「一个站点一份登录态」的年代写下的，
 *   指到默认槽才是它们的原意。所以先查别名，再解析 `@slot`。
 *   若顺序反过来，一个恰好含 `:` 的别名会被误当成槽限定 id。
 */
export function resolveWebModel(value = DEFAULT_MODEL_ID) {
  const id = typeof value === 'object' ? value?.id : value;
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('不支持的网页模型：' + id);
  const qualified = ALIASES[raw] || raw;
  // 限定形状：`site:model` 与 `site@slot:model` 都由 parseModelId 统一解析。
  //
  // **必须连同默认槽一起处理**（这是 0.14.7 首版的一个真 bug）：
  // `glm@1:glm-5.3` 里的 `1` 是默认槽的别名，parseModelId 会把它归一成
  // `slot: 'default'`；首版只处理「slot !== default」的分支，于是这个 id 掉进
  // 下面的 `split(':')` 兜底，被切成站点 `glm@1` → 查不到 → 抛「不支持的网页模型」。
  // 用户看到的是「填了账户1 反而报错」，而账户1 本该与默认槽完全等价。
  const withSlot = parseModelId(qualified);
  if (withSlot) {
    const st = SITES.find((s) => s.id === withSlot.siteId);
    const m = st?.models.find((m) => m.id === withSlot.modelId);
    if (st && m) return resolved(st, m, withSlot.slot);
    throw new Error('不支持的网页模型：' + id);
  }
  if (qualified.includes(':')) {
    const [sid, mid] = qualified.split(':', 2);
    const st = SITES.find((s) => s.id === sid);
    const m = st?.models.find((m) => m.id === mid);
    if (st && m) return resolved(st, m);
    throw new Error('不支持的网页模型：' + id);
  }
  // 裸 id：DeepSeek 的历史 id 保持原语义；其余要求全站点唯一
  const ds = DEEPSEEK.models.find((m) => m.id === raw);
  if (ds) return resolved(DEEPSEEK, ds);
  const hits = [];
  for (const st of SITES) for (const m of st.models) if (m.id === raw) hits.push([st, m]);
  if (hits.length === 1) return resolved(hits[0][0], hits[0][1]);
  throw new Error('不支持的网页模型：' + id);
}

/**
 * 按站点 id 取站点定义（模型目录、源站、静态域、契约）。
 *
 * 返回 `null` 而不是抛错或回落默认站点：调用方几乎都处在一个「用户给了个
 * 拼错的 siteId」的路径上，抛错会让整个面板 500，回落默认站点则会**静默操作
 * 另一个站点**（比报错危险得多）。所以这里如实说「没有这个站点」，让调用方
 * 决定是报错还是给默认值。
 *
 * @param {string} siteId 站点 id
 * @returns {object|null} 站点定义，未登记时为 null
 */
export function getSite(siteId) {
  return SITES.find((s) => s.id === siteId) ?? null;
}

/** 归一化模型 id：裸 id 补站点前缀（'glm-4.6' + 'glm' → 'glm:glm-4.6'），
 *  已限定或空值原样返回。executor / OpenAI 前端共用，保证路由唯一。
 *
 *  0.14.7：`glm@2:glm-5.3` 这类**已带槽**的限定 id 原样返回——它有 `:`，
 *  天然满足下面的短路条件；槽信息因此不会在这一层被剥掉。 */
export function qualifyModelId(model, siteId) {
  if (model === undefined || model === null) return model;
  const s = String(model);
  if (siteId && !s.includes(':')) return siteId + ':' + s;
  return s;
}
