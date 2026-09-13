// providers.js — 多站点内容服务注册表。
//
// 受 AgentDock（github.com/agentdock/agentdock）“provider 无关适配器”启发：
// 站点差异全部收口于本文件 + lib/decoder.js；驱动/中继/OpenAI 前端只面向
// {site, model} 二元组，新增一个内容服务 = 在 SITES 里加一个条目。
//
// 未知模型必须拒绝（resolveWebModel throw），绝不允许静默回退默认模型。
// 网页改版核对入口：`pnpm doctor`（test-mock/real-verify.mjs）。

const site = (s) => Object.freeze(s);

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
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: 1_000_000, acceptsImages: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-Flash'], context: 1_000_000, acceptsImages: true },
    { id: 'auto', name: '智谱清言', labels: ['GLM'], context: 1_000_000 },
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
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-5.3-Flash'], context: 1_000_000, acceptsImages: true },
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: 1_000_000, acceptsImages: true },
    { id: 'glm-5.2', name: 'GLM-5.2', labels: ['GLM-5.2'], context: 1_000_000, acceptsImages: true },
    // 站点默认：不切换网页模型，按页面当前选择走。名字保持干净的站点名
    //（regression.test.mjs 有护栏：模型名不得含「网页当前模型」这类元描述，
    // 也不得用括注——选择器里应当是干净名字）。
    { id: 'auto', name: 'Z.ai', labels: ['GLM'], context: 1_000_000 },
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

/** 全站点模型目录（'site:model' 限定 id + 能力元数据）——DSH 模型选择器与
 *  OpenAI /v1/models 共用这一份，保证两边模型列表一致。 */
export function listAllModels() {
  const out = [];
  for (const st of SITES) {
    for (const m of st.models) {
      out.push({
        id: st.id + ':' + m.id,
        siteId: st.id,
        siteName: st.name,
        name: m.name,
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
  out.push({ id: 'deepseek-web', siteId: 'deepseek', siteName: DEEPSEEK.name, name: 'DeepSeek (兼容别名)', labels: [], thinking: true, vision: false, imageOut: false, experimental: false });
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

function resolved(st, m) {
  return Object.freeze({
    site: st, siteId: st.id, siteName: st.name, origin: st.origin,
    decoder: st.decoder, stream: st.stream !== false, experimental: Boolean(st.experimental),
    id: m.id, name: m.name, labels: m.labels,
    thinking: m.thinking === true, vision: m.vision === true, imageOut: m.imageOut === true,
    acceptsImages: m.acceptsImages === true,
  });
}

/** 解析任意模型 id（裸 id / 'site:model' / 别名 / {id}）→ 站点+模型。未知必须 throw。 */
export function resolveWebModel(value = DEFAULT_MODEL_ID) {
  const id = typeof value === 'object' ? value?.id : value;
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('不支持的网页模型：' + id);
  const qualified = ALIASES[raw] || raw;
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

export function getSite(siteId) {
  return SITES.find((s) => s.id === siteId) ?? null;
}

/** 归一化模型 id：裸 id 补站点前缀（'glm-4.6' + 'glm' → 'glm:glm-4.6'），
 *  已限定或空值原样返回。executor / OpenAI 前端共用，保证路由唯一。 */
export function qualifyModelId(model, siteId) {
  if (model === undefined || model === null) return model;
  const s = String(model);
  if (siteId && !s.includes(':')) return siteId + ':' + s;
  return s;
}
