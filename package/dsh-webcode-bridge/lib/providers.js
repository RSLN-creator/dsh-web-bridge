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
  completionPaths: ['/api/v0/chat/completion'],
  input: 'textarea.ds-scroll-area',
  sendButton: "div[role='button']:has(path[d^='M8.3125'])",
  stopButton: "div[role='button']:has(path[d^='M2 4.88'])",
  attachSelector: "input[type='file']",
  decoder: 'deepseek', stream: true,
  models: [
    { id: 'flash', name: 'DeepSeek Flash · 快速模式', labels: ['快速模式', 'Flash'] },
    { id: 'vision', name: 'DeepSeek Vision · 识图模式', labels: ['识图模式', 'Vision'], vision: true },
    { id: 'deepseek', name: 'DeepSeek · 专家模式（深度思考）', labels: ['专家模式', 'DeepSeek'], thinking: true },
  ],
});

export const GLM = site({
  id: 'glm', name: '智谱清言 (GLM)', origin: 'https://chatglm.cn',
  completionPaths: ['/chatglm/backend-api/assistant/stream'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  decoder: 'glm', stream: true,
  models: [
    { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash · 免费快速', labels: ['GLM-4-Flash', 'Flash', '快速'] },
    { id: 'glm-4.6', name: 'GLM-4.6 · 旗舰', labels: ['GLM-4.6', '旗舰'] },
    { id: 'glm-4.6-thinking', name: 'GLM-4.6 · 深度思考', labels: ['深度思考', 'Thinking'], thinking: true },
    { id: 'glm-4v', name: 'GLM-4V · 识图', labels: ['识图', 'Vision'], vision: true },
  ],
});

export const CHATGPT = site({
  id: 'chatgpt', name: 'ChatGPT 网页版', origin: 'https://chatgpt.com',
  completionPaths: ['/backend-api/conversation'],
  input: '#prompt-textarea, textarea[data-id], textarea',
  attachSelector: "input[type='file']",
  decoder: 'chatgpt', stream: true,
  models: [
    { id: 'gpt-5', name: 'GPT-5 · 标准模式', labels: ['GPT-5', 'ChatGPT'] },
    { id: 'gpt-5-thinking', name: 'GPT-5 Thinking · 深度思考', labels: ['思考', 'Thinking', 'Extended'], thinking: true },
    { id: 'dall-e', name: 'DALL·E · 图像生成', labels: ['图像', 'DALL·E', 'Create image'], imageOut: true },
  ],
});

export const KIMI = site({
  id: 'kimi', name: 'Kimi (月之暗面)', origin: 'https://kimi.moonshot.cn',
  // 真实流端点带动态会话 id：/api/chat/{id}/completion/stream（Kimi-Free-API 同构），子串匹配
  completionPaths: ['/api/chat/', '/completion/stream'],
  input: 'textarea.chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  decoder: 'kimi', stream: true,
  models: [
    { id: 'kimi', name: 'Kimi K2 · 快速', labels: ['K2', 'Kimi'] },
    { id: 'kimi-thinking', name: 'Kimi K2 · 深度思考', labels: ['K2 思考', '深度思考', 'Thinking'], thinking: true },
    { id: 'kimi-vision', name: 'Kimi 视觉版 · 识图', labels: ['视觉版', 'Vision'], vision: true },
  ],
});

export const QWEN = site({
  id: 'qwen', name: '通义千问 (Qwen)', origin: 'https://chat.qwen.ai',
  // 浏览器端为 OpenAI 兼容 SSE（LLMs2API 实测拦截 /api/ + chat 的 POST 流）
  completionPaths: ['/api/chat'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  attachSelector: "input[type='file']",
  decoder: 'openai-sse', stream: true, experimental: true,
  models: [
    { id: 'qwen3-max', name: 'Qwen3-Max · 旗舰', labels: ['Qwen3-Max', 'Max'] },
    { id: 'qwen3-thinking', name: 'Qwen3 · 深度思考', labels: ['思考', 'Thinking'], thinking: true },
    { id: 'qwen-vl', name: 'Qwen-VL · 识图', labels: ['VL', '识图'], vision: true },
  ],
});

export const DOUBAO = site({
  id: 'doubao', name: '豆包', origin: 'https://www.doubao.com',
  completionPaths: ['/samantha/chat/completion'],
  input: 'textarea[data-testid="chat_input_input"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'doubao', stream: true, experimental: true,
  models: [
    { id: 'doubao-pro', name: '豆包 Pro', labels: ['Pro', '豆包'] },
    { id: 'doubao-thinking', name: '豆包 · 深度思考', labels: ['深度思考', 'Thinking'], thinking: true },
  ],
});

export const GROK = site({
  id: 'grok', name: 'Grok (xAI)', origin: 'https://grok.com',
  completionPaths: ['/rest/app-chat/conversations/new'],
  input: 'textarea[aria-label], textarea',
  attachSelector: "input[type='file']",
  decoder: 'grok', stream: true,
  models: [
    { id: 'grok-4', name: 'Grok 4', labels: ['Grok 4', 'Grok'] },
    { id: 'grok-think', name: 'Grok · Think 深度思考', labels: ['Think', '思考'], thinking: true },
  ],
});

export const CLAUDE = site({
  id: 'claude', name: 'Claude (Anthropic)', origin: 'https://claude.ai',
  completionPaths: ['/api/append_message'],
  input: 'div[contenteditable="true"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'claude', stream: true,
  models: [
    { id: 'claude-sonnet', name: 'Claude Sonnet 4.5', labels: ['Sonnet 4.5', 'Sonnet'] },
    { id: 'claude-sonnet-extended', name: 'Claude Sonnet · Extended 思考', labels: ['Extended', '思考'], thinking: true },
    { id: 'claude-opus', name: 'Claude Opus 4.1', labels: ['Opus 4.1', 'Opus'] },
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
    { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', labels: ['2.5 Pro', 'Pro'] },
    { id: 'gemini-2-5-flash', name: 'Gemini 2.5 Flash', labels: ['2.5 Flash', 'Flash'] },
  ],
});

/** 全部内容服务（顺序即 OpenAI /models 列表顺序）。 */
export const SITES = Object.freeze([DEEPSEEK, GLM, CHATGPT, KIMI, QWEN, DOUBAO, GROK, CLAUDE, GEMINI]);

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
        thinking: m.thinking === true,
        vision: m.vision === true,
        imageOut: m.imageOut === true,
        experimental: st.experimental === true,
      });
    }
  }
  out.push({ id: 'deepseek-web', siteId: 'deepseek', siteName: DEEPSEEK.name, name: 'DeepSeek Web (兼容别名)', labels: [], thinking: false, vision: false, imageOut: false, experimental: false });
  return out;
}

/** 兼容别名 → 'site:model' 限定 id。 */
const ALIASES = Object.freeze({
  'deepseek-web': 'deepseek:flash',
  'deepseek-reasoner': 'deepseek:deepseek',
  'gpt-4o': 'chatgpt:gpt-5', chatgpt: 'chatgpt:gpt-5',
  glm: 'glm:glm-4.6', 'glm-4.5': 'glm:glm-4.6',
  kimi: 'kimi:kimi', qwen: 'qwen:qwen3-max', doubao: 'doubao:doubao-pro',
  grok: 'grok:grok-4', claude: 'claude:claude-sonnet', gemini: 'gemini:gemini-2-5-pro',
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
