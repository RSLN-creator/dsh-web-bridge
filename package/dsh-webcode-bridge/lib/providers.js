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
  // 静态资源域：站点 HTML 用绝对 URL + crossorigin 引用，而该域返回的
  // Access-Control-Allow-Origin 是字面量通配（https://*.deepseek.com，非法值），
  // 浏览器据此硬性拒绝执行脚本，整页退化成「页面资源加载异常」。
  // 这些域改由 lib/mirror.js 同源转发（/__static/<host>/…）。
  staticOrigins: ['https://fe-static.deepseek.com'],
  completionPaths: ['/api/v0/chat/completion'],
  input: 'textarea.ds-scroll-area',
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
    { id: 'deepseek', name: 'DeepSeek（深度思考）', labels: ['专家模式', 'DeepSeek'], thinking: true, context: 1_000_000 },
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
  // 未真机校准的站点只给「网页当前模型」入口:桥不宣称具体版本号(网页
  // 模型更新极快,硬编码清单必然过时——2026-09-08 用户实测 GLM 网页已到
  // 5.x,旧目录还在 4.5/4.6)。在右侧网页里手动选模型,桥按当前网页状态对话。
  models: [
    { id: 'auto', name: 'GLM-5.3', labels: ['GLM'], context: 1_000_000 },
  ],
});

export const CHATGPT = site({
  id: 'chatgpt', name: 'ChatGPT 网页版', origin: 'https://chatgpt.com',
  completionPaths: ['/backend-api/conversation'],
  input: '#prompt-textarea, textarea[data-id], textarea',
  attachSelector: "input[type='file']",
  decoder: 'chatgpt', stream: true,
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
  input: 'textarea.chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  decoder: 'kimi', stream: true,
  models: [
    { id: 'auto', name: 'Kimi K3', labels: ['Kimi'], context: 1_000_000 },
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
  models: [
    { id: 'auto', name: 'Qwen', labels: ['Qwen'], context: 1_000_000 },
  ],
});

export const DOUBAO = site({
  id: 'doubao', name: '豆包', origin: 'https://www.doubao.com',
  completionPaths: ['/samantha/chat/completion'],
  input: 'textarea[data-testid="chat_input_input"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'doubao', stream: true, experimental: true,
  models: [
    { id: 'auto', name: '豆包', labels: ['豆包'], context: 256_000 },
  ],
});

export const GROK = site({
  id: 'grok', name: 'Grok (xAI)', origin: 'https://grok.com',
  completionPaths: ['/rest/app-chat/conversations/new'],
  input: 'textarea[aria-label], textarea',
  attachSelector: "input[type='file']",
  decoder: 'grok', stream: true,
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
  completionPaths: ['/api/chat/completions', '/api/v1/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // z.ai 对程序化 Enter 不响应，必须点发送按钮（真机 2026-09-12：轮次静默挂死正因如此）。
  sendButton: '#send-message-button',
  attachSelector: "input[type='file']",
  decoder: 'openai-sse', stream: true, experimental: true,
  // 登录判定特征：z.ai 游客页自带完整输入框（真机 2026-09-12 实测：未登录
  // 时 textarea + #send-message-button 都在，「有输入框=已登录」必然误报），
  // 未登录特征是可见的「登录」按钮；bad 命中 → 判未登录。注意 :text-matches
  // 对嵌套 span 按钮不命中（真机实测 count=0），has-text 才稳定。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
  },
  models: [
    { id: 'auto', name: 'GLM-5.3-Flash (Z.ai)', labels: ['GLM', 'Z.ai'], context: 1_000_000 },
  ],
});

// Gemini 的 RPC 流不是稳定契约 — 用 DOM 终态抓取兜底（decoder: 'dom'）。
export const GEMINI = site({
  id: 'gemini', name: 'Gemini (Google)', origin: 'https://gemini.google.com',
  completionPaths: [],
  input: 'div.ql-editor[contenteditable="true"], rich-textarea textarea, textarea',
  attachSelector: "input[type='file']",
  decoder: 'dom', stream: false, experimental: true,
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
  glm: 'glm:auto', 'glm-4.5': 'glm:auto', 'glm-4.6': 'glm:auto',
  kimi: 'kimi:auto', qwen: 'qwen:auto', doubao: 'doubao:auto',
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
