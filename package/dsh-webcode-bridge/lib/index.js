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
import { DEEPSEEK, resolveWebModel, listAllModels, getSite, SITES, qualifyModelId } from './providers.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRelay } from './relay.js';
import { createOpenAiFront } from './openai.js';
import { createBrowserDriver } from './browser-driver.js';
import { createWebControl, buildSessionEvents, mainLineOf } from './web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply, findProtocolStart, stripProtocolText, readCallAt, partialProtocolAt, coerceArguments, fillMissingRequired, trainNoteFor, normalizeDsml } from './agent-preset.js';
import { createMirror } from './mirror.js';
import { textOfBlocks } from './flatten.js';
import { estimateTokens } from './metrics.js';
import { renderSettingsPage } from './settings-page.js';

export const name = 'webcode-bridge';

// cordis service injection: declaring these is REQUIRED before ctx.webServer /
// ctx.llm property access is permitted ("cannot get property ... without inject").
export const inject = ['llm', 'webServer'];

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
  // 排队上限必须显著大于单轮上限：网页一次只跑一轮，并行子代理会排队；
  // 旧值 300s 只比单轮 240s 多 60s，排在第二位的请求几乎必然「刚开始跑就超时」，
  // 长任务里的并行分支会成片失败。900s 足够跨过 2-3 轮排队。
  queueTimeoutMs: 900_000,
  // 登录（有头 Edge 人工登录）的等待上限。控制面 POST login 会等到这一步结束
  // 才回结果，所以这里必须比驱动自身的浏览器启动留出余量。
  loginTimeoutMs: 300_000,
  // 每个站点向 DSH 声明的上下文窗口。网页 composer 的真实上限未知，声明过大
  // 会让 DSH 的压缩永不触发（transcript 只增不减）；这里给保守值，越界时由
  // PROMPT_TRUNCATED 回读校验报错而不是静默截断。
  contextWindowBySite: { deepseek: 1_000_000 },
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile'),
  headless: true,
  contextMode: 'session', // 'session': one web conversation per DSH session, incremental turns
  allowedOrigins: ['http://127.0.0.1:3080', 'http://localhost:3080'],
};

/** 发送间隔（设置页「发送间隔」）：两次向同一站点发送之间的最小毫秒数。
 *  滑窗限流（「消息发送过于频繁」）的防护手段，也是 RATE_LIMITED 退避的基数。 */
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

/** Pull image attachments out of message blocks in DSH's several shapes.
 *  Returns [{ name, contentType, data(base64) }] — data URLs are decoded
 *  inline; http(s) URLs are fetched (≤8MB) so vision turns carry real pixels. */
const IMAGE_DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s;
function imagesOfMessages(messages) {
  const out = [];
  let idx = 0;
  const push = (name, contentType, data, url) => {
    if (data && data.length > 8) out.push({ name: name || `image-${++idx}.png`, contentType: contentType || 'image/png', data });
    else if (url) out.push({ name: name || `image-${++idx}.png`, contentType: contentType || 'image/png', url });
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b) continue;
      const url = b.url ?? b.imageUrl?.url ?? b.image_url?.url;
      if (typeof url === 'string') {
        const dm = IMAGE_DATA_URL.exec(url);
        if (dm) { push(b.name, dm[1], dm[2]); continue; }
        if (/^https:\/\//.test(url)) { push(b.name, b.mediaType, undefined, url); continue; }
      }
      const source = b.source;
      if (source?.data && typeof source.data === 'string' && source.data.length > 8) push(b.name, source.mediaType, source.data);
      else if (typeof b.data === 'string' && b.data.length > 8) push(b.name, b.mediaType, b.data);
      else if (typeof b.base64 === 'string' && b.base64.length > 8) push(b.name, b.mediaType, b.base64);
    }
  }
  return out;
}
async function resolveRemoteImages(images) {
  const settled = await Promise.all(images.map(async (img) => {
    if (!img.url) return img;
    try {
      const resp = await fetch(img.url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;
      const type = resp.headers.get('content-type') || img.contentType;
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) return null;
      return { ...img, contentType: type, data: buf.toString('base64') };
    } catch { return null; }
  }));
  return settled.filter(Boolean);
}

// Optional: resolve the LlmRuntime service class so ctx.get(Service) works too.
let llmServiceRef = null;
try { llmServiceRef = (await import('@deepseek-ai/dsh-llm')).LlmRuntime; } catch { /* optional peer */ }

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

export function apply(ctx, config = {}) {
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
  const defaultConfig = { extraPrompt: '', defaultModel: 'deepseek', previewRefreshRate: 5000, thinkMode: 'on', subAgentMode: 'own', subAgentSite: 'follow', sendGapMs: 0 };
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

  // ---- LLM provider adapter --------------------------------------------
  // Pure adapter registration (the shape opencode2dsh's adapter mode uses): the
  // provider appears in the model selector immediately and listModels is read
  // live at selector time. We deliberately do NOT also call
  // registerConfigurableProviders — declaring the same provider in the
  // "configurable" directory as well makes the GUI treat it as an endpoint-
  // gated provider and the models never surface in the main selector.

  const adapter = {
    providerInfo(provider) { return { id: provider, name: cfg.displayName }; },
    providerRetryPolicy() { return undefined; },
    async listModels(provider) {
      return WEB_MODELS.map((m) => ({ provider, id: m.id, name: m.name }));
    },
    async resolveModel(provider, model) {
      const m = resolveWebModel(model);
      if (!m) throw new Error('[webcode-bridge] 未知模型: ' + model);
      // 网页 composer 的真实上限未知（历史欠账），声明 1_000_000 会让 DSH 的
      // 上下文压缩永远不触发、transcript 只增不减——「上下文不动/被撑爆」的一
      // 部分来源。按站点给一个诚实的保守值：DeepSeek 网页实测能稳定收下十万级
      // 字符，按 CJK≈0.7 token/字符折算留出余量取 128k；其余站点 64k
      // （每个都有 PROMPT_TRUNCATED 回读校验兜底，越界会报错而不是静默截断）。
      const contextWindow = m.context
        ?? cfg.contextWindowBySite?.[m.siteId]
        ?? (m.siteId === 'deepseek' ? 1_000_000 : 64_000);
      return { provider, id: model || m.id, name: m.name, context: { contextWindow } };
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal);
      return { model: info, stream: (opts) => this.stream({ ...opts, model, signal: opts.signal || signal }) };
    },
    async *stream(options) {
      const turn = buildTurn(options);
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
      const settled = relay
        .submit(turn.prompt, {
          signal: options.signal,
          onDelta: (t) => ch.push({ delta: t }),
          onThink: (t) => ch.push({ think: t }),
          onImage: (img) => ch.push({ image: img }),
          meta: turn.meta,
        })
        .then(({ text, thinking, images }) => ch.push({ end: { text, thinking, images } }))
        .catch((err) => { turn.invalidate?.(); ch.push({ err }); });

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
          const ev = await ch.next();
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
        const imageMd = imageMarkdown(endImages);
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
        const ev = await ch.next();
        if (ev.think) {
          thinkAcc += ev.think;
          if (!thinkOpen) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' }; thinkOpen = true; }
          yield { type: 'reasoning-delta', index: thinkIndex, text: ev.think };
          continue;
        }
        if (ev.image) { genImages.push(ev.image); continue; }
        if (ev.delta) {
          acc += ev.delta;
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
          const openerBoundary = rest.index >= 0 && /^\s*(?:<\s*(?:tool_call|tool_calls|function|stories|invoke)\b|```|\{\s*["\{]|\*\*Calling:)/i.test(normalizeDsml(acc.slice(boundary, boundary + 24)));
          // 流式开块只认「该边界的调用对象已经配平」：块名取自配平 JSON 本身，与
          // 收尾 parseAgentReply 同源，名字/数量在结构上不可能错位。代价是不再在
          // 参数流式途中提前显示「正在调用 X」（0.7.1 契约让位于可靠性——错位
          // 作废整轮的代价是长任务 goal 直接空转）。没被流式开块的调用由收尾
          // 循环补发，不受影响。
          const completed = rest.index >= 0 ? readCallAt(acc, boundary) : null;
          let completedName = '';
          if (completed) {
            try { const o = JSON.parse(completed.raw); if (o && typeof o?.name === 'string') completedName = o.name; } catch { /* 还没写完或非 JSON */ }
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
          const proseLimit = (rest.index >= 0 && rest.transport) ? boundary
            : (rest.index >= 0 && tagAhead) ? boundary
            : (markerAt >= 0 ? markerAt : Math.max(0, acc.length - PROSE_TAIL_CHARS));
          const safeEnd = Math.max(from, proseLimit);
          const proseChunk = safeEnd > from ? acc.slice(from, safeEnd) : '';
          if (proseChunk && (pendingCalls.length === 0 || proseChunk.trim())) {
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
            const opened = { name: completedName, id: callId(pendingCalls.length), index: nextIndex++, at: boundary };
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
          if (isCallObj && completed.end > protocolFrom) protocolFrom = completed.end;
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

      const { calls } = parseAgentReply(finalText);
      let valid = calls.filter((c) => tools.some((t) => t?.name === c.name));
      // GLM-5.3 强制思考（reference/zai-copilot-chat 的 dialect 佐证：5.3 起思考
      // 不可关）：真机确认模型会把工具调用写进思考流而不是正文，正文解析不到时
      // 从思考全文兜底解析一次。正文已有可用调用时不看思考——思考里的可能是
      // 预演草稿，照单全收会双重执行。
      if (!valid.length && thinkAcc) {
        const thinkCalls = parseAgentReply(thinkAcc).calls.filter((c) => tools.some((t) => t?.name === c.name));
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
        const notice = `TOOL_UNKNOWN: 网页发出了本会话不存在的工具调用（${[...new Set(unknownNames)].join(', ')}）。`
          + `本会话只有这些工具：${available.join(', ') || '（无）'}。`
          + '请改用上面列出的工具名重新发起调用；如果任务不需要工具，请直接给出结论。';
        warn(notice);
        yield* emitText(notice, turn);
        return;
      }
      // 流式期间已开块的调用必须与最终解析结果**逐个对齐**（名字与顺序）。不对齐
      // 说明协议形状在中途漂移，参数落到了错误的块上；宁可作废这一轮重来，也不能
      // 让 Harness 收到「名字对、参数错」的调用。
      const mismatch = pendingCalls.findIndex((p, i) => valid[i]?.name !== p.name);
      if (mismatch >= 0) {
        turn.invalidate?.();
        throw new Error('TOOL_PROTOCOL_INVALID: 工具参数不完整或调用顺序不一致'
          + `（流式已开块：${pendingCalls.map(p => p.name).join(', ') || '无'}；`
          + `解析结果：${valid.map(c => c.name).join(', ') || '无'}）`);
      }
      if (valid.length) {
        turn.commit();
        yield* closeThink();
        if (textOpen && !pendingCalls.length) {
          // 流式收尾还扣着 PROSE_TAIL_CHARS 尾巴没发（正文无协议边界、调用来自
          // 思考兜底的 GLM-5.3 场景）：先补上再收口，否则正文尾巴被永远扣住。
          const prose0 = proseSent.slice(proseBlockStart);
          const clean = stripProtocolText(finalText);
          const missing = (clean.startsWith(prose0) && clean.length > prose0.length) ? clean.slice(prose0.length) : '';
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
        const out = imageMd ? finalText + imageMd : finalText;
        assertNonEmpty(out, '', []);
        yield* emitText(out, turn);
        return;
      }
      if (!finalText.startsWith(textSent)) throw new Error('STREAM_REWRITE: 网页重写了已输出内容');
      turn.commit();
      const imageMd = imageMarkdown(endImages);
      if (imageMd) finalText += imageMd;
      const tail = finalText.slice(textSent.length);
      if (tail) yield { type: 'text-delta', index: textIndex, text: tail };
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: finalText } };
      yield* closeThink();
            yield* finishChunks(turn, finalText + thinkAcc, 'stop');
    },
  };
  llm.registerAdapter([cfg.providerId], adapter);

  /** Valid minimal text chunk sequence. */
async function* emitText(text, turn) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: inputTokensOf(turn), outputTokens: estimateTokens(text) } };
  yield { type: 'finish', reason: { kind: 'stop' } };
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

/** 每轮收尾的 usage + finish 事件对（outputTokens 口径：正文+思考一起估）。 */
function* finishChunks(turn, outputText, kind) {
  yield { type: 'usage', usage: { inputTokens: inputTokensOf(turn), outputTokens: estimateTokens(outputText) } };
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
    loginTimeoutMs: cfg.loginTimeoutMs,
    logger: console,
  });

  // 多站点：每个内容服务一个独立驱动实例（独立 profile，避免登录态串号）。
  // deepseek 用默认 driver（兼容测试注入与既有 profile）；其余站点按需懒创建。
  const drivers = new Map();
  function driverFor(siteId) {
    if (!siteId || siteId === 'deepseek') return driver;
    if (!drivers.has(siteId)) {
      const st = getSite(siteId);
      if (!st) throw new Error('[webcode-bridge] 未知站点: ' + siteId);
      drivers.set(siteId, createBrowserDriver({
        siteId,
        site: st.origin + '/',
        profileDir: path.join(cfg.profileDir, 'sites', siteId),
        headless: cfg.headless !== false,
        requestTimeoutMs: cfg.requestTimeoutMs,
        loginTimeoutMs: cfg.loginTimeoutMs,
        logger: console,
      }));
    }
    return drivers.get(siteId);
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
    const d = siteId === 'deepseek' ? driver : drivers.get(siteId);
    if (!d || typeof d.listSessions !== 'function' || typeof d.conversationFor !== 'function') return null;
    const conv = d.conversationFor(String(sessionId));
    const webSessionId = conv?.webSessionId;
    if (!webSessionId) return null;
    const dir = await d.listSessions(100);
    const hit = (dir?.sessions || []).find((s) => s.id === webSessionId);
    const title = String(hit?.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title === '(无标题)') return null;
    return title;
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
  // 发送间隔的站点级状态：站点 id → 上一轮结束的时刻。「发送间隔」节流与
  // 限流退避都以它为基准（同站点串行，跨站点互不影响）。
  const lastSendBySite = new Map();
  // 站点限流退避重试上限（RATE_LIMITED）。退避时长 = max(发送间隔, 10s) × 已重试次数，
  // 10s 下限是因为限流滑窗通常以十秒计，几十毫秒的短间隔重试只会再次撞墙。
  const RATE_LIMIT_RETRIES = 2;

  let front = null;
  const relay = createRelay({
    ...cfg,
    logger: console,
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
      const sendGapMs = clampSendGapMs(m?.sendGapMs);
      const attempt = (fresh) => {
        if (m?.sessionKey) {
          const drive = driverFor(siteId);
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
              log('web session lost — replaying the full first-turn prompt into a fresh web chat');
              await drive.resetConversation(m.sessionKey).catch(() => {});
              return drive.sendTurn(m.sessionKey, m.rebuild(), { ...turnOpts, fresh: true });
            }
            // a vanished/deleted conversation poisons the stored slot — reset
            // it so the NEXT turn reopens a fresh web chat
            if (err && !err.code) await drive.resetConversation(m.sessionKey).catch(() => {});
            throw err;
          });
        }
        return driverFor(siteId).sendPrompt(prompt, { signal: opts.signal, meta: m, onDelta: opts.onDelta, onThink: opts.onThink, onImage: opts.onImage, model: qualified, thinkMode });
      };
      // 发送节流（设置页「发送间隔」）：本轮发送前把与上一轮结束的间隔补满。
      // 等待不属于网页生成耗时，单独记 sendWaitMs（右栏统计「发送前等待」）。
      let waitedMs = 0;
      if (sendGapMs > 0) {
        const wait = Math.max(0, (lastSendBySite.get(siteId) || 0) + sendGapMs - Date.now());
        if (wait > 0) {
          log(`send gap: waiting ${Math.round(wait / 1000)}s before next send to ${siteId}`);
          await sleepSignal(wait, opts.signal);
        }
        waitedMs += wait;
      }
      try {
        let result = null;
        let retries = 0;
        for (;;) {
          try { result = await attempt(m?.fresh === true); break; }
          catch (err) {
            // 站点限流（DeepSeek hint rate_limited）：消息已被服务端撤回，重发
            // 安全；按退避序列重试同一轮，而不是把失败甩回 DSH 让长任务断链。
            if (err?.code !== 'RATE_LIMITED' || opts.signal?.aborted || retries >= RATE_LIMIT_RETRIES) throw err;
            retries += 1;
            // 10s 下限：限流滑窗以十秒计，几十毫秒的短间隔重试只会再次撞墙。
            // （rateLimitBackoffMinMs 仅供离线测试调小；真实运行缺省 10_000。）
            const backoff = Math.max(sendGapMs, cfg.rateLimitBackoffMinMs ?? 10_000) * retries;
            waitedMs += backoff;
            warn(`rate limited — retry ${retries}/${RATE_LIMIT_RETRIES} after ${Math.round(backoff / 1000)}s (${siteId})`);
            await sleepSignal(backoff, opts.signal);
          }
        }
        if (result && typeof result === 'object') {
          result.metrics = { ...(result.metrics || {}), sendWaitMs: Math.round(waitedMs), rateLimitRetries: retries };
        }
        return result;
      } finally {
        // 节流基准是「上一轮结束时刻」：成功、失败、被限流都一样重新起算。
        lastSendBySite.set(siteId, Date.now());
      }
    },
    driverStatus: () => {
      const base = driver.status();
      // 聚合全部内容服务的登录/运行状态：未初始化的站点给占位（不启动浏览器）。
      const sites = SITES.map((st) => {
        const d = st.id === 'deepseek' ? driver : drivers.get(st.id);
        if (!d) {
          // 重启后未懒创建的站点：登录缓存直接读站点 profile 的落盘状态，
          // 否则面板永远「待检查」，用户只能逐站点手动核验（问题③的另一半）。
          let cached = null;
          // 默认驱动（deepseek）的登录态落盘在根 profile，其余站点在 sites/<id>/；
          // 只查后者的旧实现让 DeepSeek 每次重启都显示「待检查」，用户被迫手点。
          // 根 profile 文件只对默认站点回退——别的站点读了会把 DeepSeek 的
          // 登录态安到自己头上。
          const statePaths = [path.join(cfg.profileDir, 'sites', st.id, 'webcode-login-state.json')];
          if (st.id === 'deepseek') statePaths.push(path.join(cfg.profileDir, 'webcode-login-state.json'));
          for (const p of statePaths) {
            try { cached = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch { /* 未初始化过 */ }
          }
          const has = cached && typeof cached.loggedIn === 'boolean';
          return { siteId: st.id, siteName: st.name, origin: st.origin, initialized: false, running: false, busy: false, loggedIn: has ? cached.loggedIn : null, loggedInCached: has && cached.loggedIn === true, loginCheckedAt: has ? cached.at : null, needLogin: has && cached.loggedIn === false, selectedModel: null, window: null, loginState: 'idle', lastLogin: null };
        }
        const s = d.status();
        return { siteId: st.id, siteName: st.name, origin: st.origin, initialized: true, running: s.running, busy: s.busy, loggedIn: s.loggedIn, loggedInCached: s.loggedInCached === true, loginCheckedAt: s.loginCheckedAt ?? null, needLogin: s.needLogin, selectedModel: s.selectedModel, window: s.window ?? null, loginState: s.loginState ?? 'idle', lastLogin: s.lastLogin ?? null };
      });
      return { ...base, sites };
    },
    loginTrigger: (siteId) => driverFor(siteId || 'deepseek').openLogin(),
    // 设置页「登录网站」用：等这次登录真正结束（成功/失败/超时）再把结果带回
    // 控制面。旧动作是 fire-and-forget，失败只能进控制台，界面永远显示未登录。
    loginAndReport: async (siteId, { timeoutMs } = {}) => {
      const sid = getSite(siteId) ? siteId : 'deepseek';
      const d = driverFor(sid);
      const ms = Math.max(10_000, Number(timeoutMs) || cfg.loginTimeoutMs);
      const t0 = Date.now();
      let timer = null;
      try {
        const result = await Promise.race([
          d.openLogin(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`login timed out after ${ms}ms`)), ms); }),
        ]);
        return { ok: true, siteId: sid, siteName: getSite(sid)?.name, ms: Date.now() - t0, ...(result || {}) };
      } catch (err) {
        return { ok: false, siteId: sid, siteName: getSite(sid)?.name, ms: Date.now() - t0, error: String(err?.message || err) };
      } finally { if (timer) clearTimeout(timer); }
    },
    siteConnect: (siteId) => driverFor(getSite(siteId) ? siteId : 'deepseek'),
    // 展示窗口动作（有头 Edge）：侧栏「独立窗口」按钮走这里，与登录共用
    // 同一持久 profile——窗口里直接可聊，自动化轮次驱动同一页面。
    windowOpener: (siteId, action, opts = {}) => {
      const d = driverFor(getSite(siteId) ? siteId : 'deepseek');
      if (action === 'close') return d.closeWindow();
      // 多窗口错位：统计已开的窗口数作为停靠偏移，新窗不盖旧窗。
      let openCount = 0;
      try {
        for (const s of (relay ? relay.config.driverStatus().sites : []) || []) if (s?.window?.open) openCount++;
      } catch { /* 非关键路径 */ }
      return d.openWindow({ ...opts, offset: openCount });
    },
    sessionImport: (dir) => driver.importStorageFromProfile(dir),
    onHttp: (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const pathname = u.pathname;
      // 多站点侧栏视图：/__webcode/site/<siteId>/… → 对应站点 mirror
      const siteRoute = /^\/__webcode\/site\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
      if (siteRoute) {
        const [, sid, rest = '/'] = siteRoute;
        if (!getSite(sid)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'unknown site: ' + sid } }));
          return;
        }
        mirrorFor(sid).handle(req, res, rest, u.search).catch(() => { try { res.end(); } catch {} });
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
  // 多站点侧栏视图：每个内容服务一个 mirror 实例（各自 origin + 对应 driver 的
  // 登录态 token），懒创建；路径前缀 /__webcode/site/<siteId>/…。
  const mirrors = new Map();
  function mirrorFor(siteId) {
    const sid = getSite(siteId) ? siteId : 'deepseek';
    if (!mirrors.has(sid)) {
      const st = getSite(sid);
      mirrors.set(sid, createMirror({
        siteOrigin: st.origin,
        getToken: () => driverFor(sid).getToken(),
        logger: console,
        assetOrigins: st.staticOrigins || [],
        mountPrefix: '/__webcode/site/' + sid,
        getCookies: (origin) => driverFor(sid).profileCookies(origin),
        setCookies: (headers, origin) => driverFor(sid).writeProfileCookies(headers, origin),
        getUserAgent: () => driverFor(sid).userAgent(),
      }));
    }
    return mirrors.get(sid);
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
    const defaultModel = settings.defaultModel;
    const thinkMode = ['on', 'off', 'auto'].includes(settings.thinkMode) ? settings.thinkMode : 'auto';
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const resolvedModel = resolveWebModel(options.model || defaultModel || cfg.modelId);
    let model = resolvedModel.id;
    let siteId = resolvedModel.siteId;
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
    }
    const keyAgentId = subAgentMode === 'own' ? agentId : null;
    const keyPath = options.sessionId && cfg.contextMode === 'session' && !options.purpose
      ? [String(options.sessionId), keyAgentId ? String(keyAgentId) : ''].filter(Boolean).join('::')
      : null;
    const recordPreset = (prompt) => {
      // Record every real agent turn (no aux purpose): this is the exact
      // first-turn text the bridge sends to the web page on first contact.
      if (options.purpose) return;
      lastPresetInfo = {
        prompt,
        model,
        agentId,
        tools: Array.isArray(options.tools) ? options.tools.map((t) => t?.name).filter(Boolean) : [],
        at: new Date().toISOString(),
      };
    };
    if (!keyPath) {
      const prompt = serializeFirstTurn({ ...options, extraPrompt, siteId });
      recordPreset(prompt);
      return {
        prompt,
        inputTokens: estimateTokens(prompt),
        meta: { model: siteId + ':' + model, siteId, thinkMode, sendGapMs: clampSendGapMs(settings.sendGapMs) },
        async attach() {
          const imgs = imagesOfMessages(messages);
          return imgs.length ? resolveRemoteImages(imgs) : [];
        },
        commit() {},
      };
    }
    // 游标指纹只锁「真正决定网页侧提示词内容」的东西：模型、系统提示词、
    // 全局指令、工具**名字集合**、以及已经发出去的消息。
    //
    // 旧实现把 options.tools 整个对象 JSON.stringify 进指纹——工具描述的措辞
    // 一变（宿主升级、动态描述、参数 schema 里字段顺序变化）指纹就变，游标被
    // 判为陈旧、下一轮改走「整段重建」，网页那一侧于是被重开一个新会话。
    // 真机表现：一切正常但上下文像「不动了」（每轮都在重建首轮），并且网页会话
    // 槽被反复切换。名字集合一致就沿用同一网页会话。
    const toolNameKey = Array.isArray(options.tools)
      ? options.tools.map((t) => String(t?.name || '')).filter(Boolean).sort().join(',')
      : '';
    const fingerprint = count => createHash('sha256').update(JSON.stringify({ model, system: options.system, tools: toolNameKey, extraPrompt, messages: messages.slice(0, count) })).digest('hex');
    let st = sessionState.get(keyPath);
    if (st && (messages.length <= st.sent || st.fingerprint !== fingerprint(st.sent))) st = null;
    const fresh = !st;
    st ||= { sent: 0, toolResults: 0, tokens: 0 };
    // 增量轮的再教学提示按站点取（glm 只教代码块形状，与首轮同一立场）。
    const delta = serializeDelta(messages, st.sent, st.toolResults, undefined, trainNoteFor(siteId));
    let prompt;
    if (fresh) { prompt = serializeFirstTurn({ ...options, extraPrompt, siteId }); recordPreset(prompt); }
    else prompt = delta.text;
    // 上下文计数口径（问题③根因）：网页这一侧是「首轮全文 + 后续增量」，模型
    // 实际看到的上下文 = 本会话已发出去的全部文本之和。旧实现把 usage.inputTokens
    // 报成 estimateTokens(turn.prompt)，增量轮里 turn.prompt 只是本轮那一小段增量；
    // GUI 上下文表取最近一次 usage 的 inputTokens，于是每开新一轮就掉回接近 0，
    // 看起来「清空重新开始」。这里改成累计值（单调不减）。
    const deltaTokens = estimateTokens(prompt);
    const cumulativeTokens = fresh ? deltaTokens : (st.tokens || 0) + deltaTokens;
    return {
      prompt,
      inputTokens: cumulativeTokens,
      meta: {
        sessionKey: keyPath, fresh, model: siteId + ':' + model, siteId, thinkMode,
        // 发送间隔（设置页）：executor 在发送前按它节流，限流退避也以它为基数
        sendGapMs: clampSendGapMs(settings.sendGapMs),
        // 网页会话丢失时的整段重放文本（见 executor 的 WEB_SESSION_LOST 分支）
        rebuild: () => serializeFirstTurn({ ...options, extraPrompt, siteId }),
      },
      invalidate: () => sessionState.delete(keyPath),
      async attach() {
        // a fresh turn replays the whole transcript → attach every image in it;
        // an incremental turn attaches only newly-arrived images
        const scope = (keyPath && !fresh) ? messages.slice(st.sent) : messages;
        const imgs = imagesOfMessages(scope);
        return imgs.length ? resolveRemoteImages(imgs) : [];
      },
      commit() {
        // 先删后插把键移到 Map 尾部；配合尾部淘汰就是「最近最少使用」，
        // 旧写法对已存在键 set 不改变插入序，淘汰会先丢掉最老的热会话，
        // 表现为长会话莫名重新整段重发。
        sessionState.delete(keyPath);
        sessionState.set(keyPath, { sent: messages.length, toolResults: delta.toolResultsSent, fingerprint: fingerprint(messages.length), tokens: cumulativeTokens });
        if (sessionState.size > 512) sessionState.delete(sessionState.keys().next().value);
      },
    };
  };

  // Same-origin primary mount on the DSH web server (no CORS, no cross-site
  // surface at all) — same pattern deepseek-web-import uses. cordis exposes
  // Service instances as context properties, so try ctx.webServer before the
  // string-keyed ctx.get fallback.
  const webServer = (() => {
    for (const attempt of [() => ctx.webServer, () => ctx.get('webServer')]) {
      try {
        const w = attempt();
        if (w && typeof w.register === 'function') return w;
      } catch { /* next */ }
    }
    return null;
  })();
  const routeDisposers = [];
  if (webServer && typeof webServer.register === 'function') {
    const routes = [
      ['status', 'status'], ['consent', 'consent'], ['login', 'login'],
      ['diagnostics', 'diagnostics'], ['preset', 'preset'],
      ['connect', 'connect'], ['interact', 'interact'], ['window', 'window'],
      ['sessions', 'sessions'], ['history', 'history'],
      ['workspaces', 'workspaces'], ['import', 'import'],
      ['settings', 'settings'], ['models', 'models'],
      ['login-sites', 'login-sites'],
    ];
    for (const [, suffix] of routes) {
      try {
        routeDisposers.push(webServer.register({
          kind: 'exact',
          path: '/__webcode/' + suffix,
          handler: (req, res) =>
            webControl.handle(req, res, '/__webcode/' + suffix)
              .then((handled) => { if (!handled) res.writeHead(404).end(); })
              .catch(() => { try { res.writeHead(500).end(); } catch {} }),
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
  }
  front = createOpenAiFront(relay, cfg);
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
