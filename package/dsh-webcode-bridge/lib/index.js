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
import { createWebControl, buildSessionEvents, mainLineOf } from './web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply, findProtocolStart, stripProtocolText, readCallAt, partialProtocolAt, coerceArguments, fillMissingRequired, trainNoteFor, normalizeDsml } from './agent-preset.js';
import { createMirror } from './mirror.js';
import { httpFetch } from './upstream.js';
import { textOfBlocks } from './flatten.js';
import { estimateTokens, computeSendGap, checkContextBudget } from './metrics.js';
import { accumulateWait, sanitizeWaitStats, emptyWaitStats, composerWaitLine, waitStatRows, formatDuration } from './wait-stats.js';
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
  // 写入 composer 的单块字符上限（0.14.5）。超长提示词一次性交给 Playwright
  // 的 fill() 会在网页侧整段卡住并以 30s 超时收尾，且没有任何中间态可诊断；
  // 分块写入 + 块间回读长度让失败更早、且带得出已写进度（PROMPT_WRITE_STALLED）。
  composerChunkChars: 20_000,
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

/** Pull image attachments out of message blocks in **every** shape DSH uses.
 *
 * 三类来源，标成 tagged entry 交给 resolveImages 统一落成 base64：
 *   • `durable` — DSH 原生块 `{type:'image', attachment:ImageAttachmentRef}`。
 *     像素不在块里，必须经 attachments 服务读取。**这是 harness 截图/粘贴的
 *     唯一形态**，0.12.9 之前完全没被识别（见 resolveAttachments 注释）。
 *   • `inline`  — wire 形状的 data URL / source.data / base64（OpenAI 前端、
 *     旧会话回放）。data URL 就地解码，不落盘。
 *   • `remote`  — http(s) URL，由 resolveRemoteImages 抓取（≤8MB）。
 *
 * 返回 [{ name, contentType, kind, ref?|data?|url? }]。
 */
const IMAGE_DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s;
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
  const hint = scene
    ? `（页面${scene.preview ? '在' : '不在'}${scene.lastRecovered ? `，最近一次部分流：${scene.lastRecovered.reason} ${scene.lastRecovered.chars} 字` : ''}）`
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
  // accounts（0.14.7）：同站多账户的槽清单。**默认空数组 = 行为与 0.14.6 完全一致**
  // ——「不配置就不改变」是多账户这种高风险特性的第一条纪律：任何一个没配槽的
  // 用户都不该因为升级而看到不同行为。
  // sendGapMsBySlot：槽级发送间隔覆盖（`{ 'glm#2': 60000 }`）。回落链见
  // accounts.sendGapForSlot：槽显式值 → 站点级键 → 全局 sendGapMs。
  const defaultConfig = { extraPrompt: '', defaultModel: 'deepseek', previewRefreshRate: 5000, thinkMode: 'on', subAgentMode: 'own', subAgentSite: 'follow', sendGapMs: 0, accounts: [], sendGapMsBySlot: {} };
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
   * 优先级：模型自带 context（providers.js 各站点，glm/zai 已是真机实测下界）
   *        > cfg.contextWindowBySite[siteId]（运维/测试覆盖）
   *        > deepseek 1_000_000 / 其余 64_000 的诚实兜底。
   *
   * 未校准站点的 64_000 是**保守值**，含义是「宁可让 DSH 早一点压缩，也不要
   * 发出去被网页端截半截」；越界同样由 PROMPT_TRUNCATED 与预算闸双重兜底。
   */
  function contextWindowFor(m) {
    return m?.context
      ?? cfg.contextWindowBySite?.[m?.siteId]
      ?? (m?.siteId === 'deepseek' ? 1_000_000 : 64_000);
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
      chars: String(prompt || '').length,
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
    async listModels(provider) {
      // 选择器下拉过滤兼容别名（deepseek-web 与 deepseek:deepseek 显示名逐字相同，
      // 照单渲染就是两行同名项）。别名本身仍可被 resolveModel 解析——历史会话与
      // OpenAI 前端的旧值依赖它，所以只过滤「展示」，不动「解析」。
      return WEB_MODELS.filter((m) => !MODEL_ALIAS_IDS.has(m.id)).map((m) => ({ provider, id: m.id, name: m.name }));
    },
    async resolveModel(provider, model) {
      const m = resolveWebModel(model);
      if (!m) throw new Error('[webcode-bridge] 未知模型: ' + model);
      // 网页 composer 的真实上限未知（历史欠账），声明 1_000_000 会让 DSH 的
      // 上下文压缩永远不触发、transcript 只增不减——「上下文不动/被撑爆」的一
      // 部分来源。按站点给一个诚实的保守值：DeepSeek 网页实测能稳定收下十万级
      // 字符，按 CJK≈0.7 token/字符折算留出余量取 128k；其余站点 64k
      // （每个都有 PROMPT_TRUNCATED 回读校验兜底，越界会报错而不是静默截断）。
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
      // 现场在**超时那一刻**才采（同步调用，无页面往返）：提前采会拿到过时状态。
      const idleScene = () => {
        try {
          const st = driverFor(idleSiteId)?.status?.() || null;
          if (!st) return null;
          return {
            preview: st.preview === true,
            running: st.running === true,
            busy: st.busy === true,
            recoveredTurns: st.recoveredTurns ?? 0,
            lastRecovered: st.lastRecovered ?? null,
            lastEndReason: st.lastEndReason ?? null,
          };
        } catch { return null; }
      };
      const nextWithIdle = async () => {
        let timer = null;
        try {
          return await Promise.race([
            ch.next(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(idleTimeoutError(IDLE_TIMEOUT_MS, idleScene())), IDLE_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
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
          // 调用标签的残尸（真机 2026-09-14 会话 c7c7a03c step69：两个调用之间流出
          // "</</" 文本块，用户看到「回复夹杂错误调用」）：不含任何字母数字的纯标签
          // 碎片不是内容，按调用间隙的空白同型处理——静默推进游标，不开文本块。
          // 带字母数字的（如 "</div>"、代码示例）照常外发，不受影响。
          const tagDebris = /^[\s<>\/|\uFF5C]+$/.test(proseChunk);
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
    composerChunkChars: cfg.composerChunkChars,
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
        loginTimeoutMs: cfg.loginTimeoutMs,
        composerChunkChars: cfg.composerChunkChars,
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
  const lastSendByAccount = new Map();
  /** 该键是否指向一个已知站点（`glm` 与 `glm#2` 都算）。文件可手改，不抛错。 */
  function knownAccountKey(key) {
    try { return Boolean(getSite(parseAccountKey(key).siteId)); } catch { return false; }
  }
  (function loadSendState() {
    try {
      const raw = JSON.parse(fs.readFileSync(sendStatePath, 'utf8'));
      const now = Date.now();
      for (const [key, at] of Object.entries(raw || {})) {
        // 只认已知站点 + 合理时间窗：文件可能来自别的机器/很久以前，
        // 陈旧基准没有意义（24h 前的「上一轮」不该再压住本轮）。
        if (!knownAccountKey(key)) continue;
        const t = Number(at);
        if (!Number.isFinite(t) || t <= 0 || t > now || now - t > SEND_STATE_MAX_AGE_MS) continue;
        lastSendByAccount.set(key, t);
      }
    } catch { /* 首次运行或文件损坏：按「没有基准」处理即可 */ }
  })();
  /** 记录「刚刚真正发出」。只在发送成功那一刻调用；写失败仅 warn，绝不阻断发送。 */
  function rememberSend(accountKey, at = Date.now()) {
    lastSendByAccount.set(accountKey, at);
    try {
      fs.mkdirSync(path.dirname(sendStatePath), { recursive: true });
      const tmp = sendStatePath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(lastSendByAccount)), { mode: 0o600 });
      fs.renameSync(tmp, sendStatePath);
    } catch (err) { warn('send-state save failed:', err?.message); }
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
  /** 控制面读取用：`{ total, session }`。sessionId 缺省时只回累计。 */
  function waitStatsSnapshot(sessionId) {
    const key = typeof sessionId === 'string' && sessionId ? sessionId.split('::')[0] : null;
    return {
      total: waitStats.total,
      session: key ? (waitStats.sessions.get(key) || emptyWaitStats()) : null,
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

  let front = null;
  const relay = createRelay({
    ...cfg,
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
        return driverFor(accountKey).sendPrompt(prompt, { signal: opts.signal, meta: m, onDelta: opts.onDelta, onThink: opts.onThink, onImage: opts.onImage, model: qualified, thinkMode });
      };
      // 发送节流（设置页「发送间隔」）：**send-to-send** 语义——本轮发送距上一次
      // *发出* 不足设置值就补满。判定与「距上次发送」都由纯函数给出，等待本身
      // 不属于网页生成耗时，单独记 sendWaitMs（右栏统计「发送前等待」）。
      let waitedMs = 0;
      const gapPlan = computeSendGap({ lastSendAt: lastSendByAccount.get(accountKey) ?? null, now: Date.now(), gapMs: sendGapMs });
      if (gapPlan.skewed) {
        warn(`send-state for ${accountKey} is in the future (clock skew?) — treating it as "just sent"`);
      }
      if (gapPlan.waitMs > 0) {
        log(`send gap: waiting ${Math.round(gapPlan.waitMs / 1000)}s before next send to ${accountKey}`);
        await sleepSignal(gapPlan.waitMs, opts.signal);
        waitedMs += gapPlan.waitMs;
      }
      // 基准在「本轮真正交给网页」的那一刻更新，且只在成功发出时——限流退避
      // 与失败都不该污染它，否则下一轮的间隔会被一次失败凭空吃掉。
      const markSent = () => rememberSend(accountKey);
      try {
        let result = null;
        let retries = 0;
        for (;;) {
          markSent();
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
            warn(`rate limited — retry ${retries}/${RATE_LIMIT_RETRIES} after ${Math.round(backoff / 1000)}s (${accountKey})`);
            await sleepSignal(backoff, opts.signal);
          }
        }
        if (result && typeof result === 'object') {
          result.metrics = {
            ...(result.metrics || {}),
            sendWaitMs: Math.round(waitedMs),
            rateLimitRetries: retries,
            // 三个可核对字段（右栏与 /status 都透出）：本轮生效的目标值、
            // 距上次发出的实际间隔、以及实际等待。用户「设了 10s 却看不到」
            // 的症结正是旧实现只在**等待过**时才显示，这些字段让它恒可核对。
            gapTargetMs: sendGapMs,
            sincePrevSendMs: gapPlan.sincePrevSendMs,
          };
        }
        return result;
      } finally {
        // 基准不再在 finally 里无条件刷新——它只在 markSent() 更新（send-to-send）。
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
      return { ...base, sites };

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
          return { siteId: st.id, siteName: st.name, origin: st.origin, slot: acc.slot, accountKey: acc.key, displayName: accountLabel(st.name, acc.slot), profileDir: slotDir, initialized: false, running: false, busy: false, loggedIn: has ? cached.loggedIn : null, loggedInCached: has && cached.loggedIn === true, loginBasis: trusted ? cached.basis : (cached ? 'stale' : null), loginCheckedAt: cached ? cached.at : null, needLogin: has && cached.loggedIn === false, selectedModel: null, window: null, loginState: 'idle', lastLogin: null };
        }
        const s = d.status();
        return { siteId: st.id, siteName: st.name, origin: st.origin, slot: acc.slot, accountKey: acc.key, displayName: accountLabel(st.name, acc.slot), profileDir: s.profileDir ?? null, initialized: true, running: s.running, busy: s.busy, loggedIn: s.loggedIn, loggedInCached: s.loggedInCached === true, loginBasis: s.loginBasis ?? null, loginCheckedAt: s.loginCheckedAt ?? null, needLogin: s.needLogin, selectedModel: s.selectedModel, window: s.window ?? null, loginState: s.loginState ?? 'idle', lastLogin: s.lastLogin ?? null };
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
    const defaultModel = settings.defaultModel;
    const thinkMode = ['on', 'off', 'auto'].includes(settings.thinkMode) ? settings.thinkMode : 'auto';
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const resolvedModel = resolveWebModel(options.model || defaultModel || cfg.modelId);
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
      const prompt = serializeFirstTurn({ ...options, extraPrompt, siteId });
      recordPreset(prompt);
      return {
        prompt,
        inputTokens: estimateTokens(prompt),
        meta: {
          model: formatModelId(siteId, slot, model), siteId, slot, accountKey, thinkMode,
          // 发送间隔按**槽**取（不同登录态风控独立）；回落链见 accounts.sendGapForSlot。
          sendGapMs: clampSendGapMs(sendGapForSlot(settings, accountKey, siteId)),
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
        sessionKey: keyPath, fresh, model: formatModelId(siteId, slot, model), siteId, slot, accountKey, thinkMode,
        // 发送间隔（设置页）：executor 在发送前按它节流，限流退避也以它为基数。
        // 0.14.7 起按槽取——同一站点两个账户是两份独立的风控窗口。
        sendGapMs: clampSendGapMs(sendGapForSlot(settings, accountKey, siteId)),
        // 网页会话丢失时的整段重放文本（见 executor 的 WEB_SESSION_LOST 分支）
        rebuild: () => serializeFirstTurn({ ...options, extraPrompt, siteId }),
      },
      invalidate: () => sessionState.delete(keyPath),
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
    // 挂载清单从控制面 action 表**派生**（webControl.routes），不再手写第二份。
    // 真机 2026-09-13 的教训：手写数组漏掉了 verify-login / site-probe /
    // session-import 三个 action，设置面板的「检测」按钮全部落到宿主未知 POST
    // 兜底（405 + 空 body），客户端 JSON.parse 抛 “unexpected end of JSON data”。
    // 派生之后这类漏挂载在结构上不可能发生。
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
  }
  front = createOpenAiFront(relay, {
    ...cfg,
    // OpenAI 兼容前端（:8931）也必须遵守设置页的「发送间隔」。它不走 buildTurn，
    // 因此拿不到 settings 快照——这里给一个**当场求值**的取值函数（不是快照），
    // 设置改完立刻生效。真机 0.14.0 矩阵发现该路径 gapTargetMs 恒为 0（见
    // doc/verify.md 的「OpenAI 前端绕过发送间隔」）。
    sendGapMsOf: () => clampSendGapMs(configManager.get().sendGapMs),
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
