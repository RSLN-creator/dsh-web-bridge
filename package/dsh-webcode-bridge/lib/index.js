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
import { serializeFirstTurn, serializeDelta, parseAgentReply, findProtocolStart, stripProtocolText } from './agent-preset.js';
import { createMirror } from './mirror.js';
import { textOfBlocks } from './flatten.js';
import { estimateTokens } from './metrics.js';

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
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile'),
  headless: true,
  contextMode: 'session', // 'session': one web conversation per DSH session, incremental turns
  allowedOrigins: ['http://127.0.0.1:3080', 'http://localhost:3080'],
};

// 模型目录 = 全部内容服务站点的模型（'site:model' 限定 id），DSH 模型选择器
// 直接可见 GLM/ChatGPT/Kimi/Qwen/豆包/Grok/Claude/Gemini 的模型。
const WEB_MODELS = listAllModels();

const log = (...a) => console.log('[webcode-bridge]', ...a);
const warn = (...a) => console.warn('[webcode-bridge]', ...a);

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
 * style requests (small, no tools) derived from the first user message.
 *
 * 只认 DSH 自己的 `purpose: 'session-title'`。旧实现还拿 system 文本里的
 * 「title/标题/命名」当判据——工作区指令里只要出现过这些词，一次真实轮次就会
 * 被本地截成前 16 个字直接返回，模型根本没被调用。
 */
function localAnswer(options) {
  try {
    if (String(options.purpose || '') !== 'session-title') return null;
    if (Array.isArray(options.tools) && options.tools.length) return null;
    const firstUser = (options.messages || []).find((m) => m?.role === 'user');
    let t = textOfBlocks(firstUser?.content);
    const prefix = 'Generate the session title from this JSON array of human messages:';
    if (t.startsWith(prefix)) {
      const entries = JSON.parse(t.slice(prefix.length).trim());
      t = Array.isArray(entries) ? entries.map(entry => typeof entry.text === 'string' ? entry.text : '').join(' ') : '';
    }
    t = t.replace(/\s+/g, ' ').trim();
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
  const defaultConfig = { extraPrompt: '', defaultModel: 'deepseek', previewRefreshRate: 5000, thinkMode: 'auto' };
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
      return { provider, id: model || m.id, name: m.name, context: { contextWindow: 1_000_000 } };
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

      const local = localAnswer(options);
      if (local !== null) {
        yield* emitText(local, turn.prompt);
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
        const images = [];
        let end = null;
        for (;;) {
          const ev = await ch.next();
          if (ev.think) {
            thinkAcc += ev.think;
            if (!thinkOpen) { thinkIndex = nextIndex++; yield { type: 'block-start', index: thinkIndex, blockType: 'reasoning' }; thinkOpen = true; }
            yield { type: 'reasoning-delta', index: thinkIndex, text: ev.think };
            continue;
          }
          if (ev.image) { images.push(ev.image); continue; }
          if (ev.delta) {
            acc += ev.delta;
            if (!textOpen) {
              if (thinkOpen) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } }; thinkOpen = false; }
              textIndex = nextIndex++;
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
              textOpen = true;
            }
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
                if (rest) { acc = full; if (!textOpen) { if (thinkOpen) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } }; thinkOpen = false; } textIndex = nextIndex++; yield { type: 'block-start', index: textIndex, blockType: 'text' }; textOpen = true; } yield { type: 'text-delta', index: textIndex, text: rest }; }
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
        if (!acc.trim() && !thinkAcc.trim() && endImages.length === 0) throw new Error('webcode relay: empty response from web AI');
        const imageMd = imageMarkdown(endImages);
        if (imageMd) {
          acc += imageMd;
          if (!textOpen) {
            if (thinkOpen) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } }; thinkOpen = false; }
            textIndex = nextIndex++;
            yield { type: 'block-start', index: textIndex, blockType: 'text' };
            textOpen = true;
          }
          yield { type: 'text-delta', index: textIndex, text: imageMd };
        }
        turn.commit();
        if (textOpen) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: acc } };
        if (thinkOpen) yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
        yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(acc + thinkAcc) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        await settled;
        return;
      }

      let end = null;
      let acc = '';
      let textSent = '';
      let textOpen = false;
      let thinkAcc = '';
      let thinkOpen = false;
      let thinkIndex = -1;
      let textIndex = -1;
      let nextIndex = 0;
      const genImages = [];
      let pendingCall = null;
      const callSeq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const callId = i => `call-webcode-${String(options?.sessionId || 'stateless')}-${callSeq}-${i}`;
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
          const { index: boundary, name: candidate, transport } = findProtocolStart(acc);
          // Keep a short suffix until the next delta disambiguates a marker.
          const safeEnd = boundary < 0 ? Math.max(0, acc.length - 32) : boundary;
          if (safeEnd > textSent.length && !pendingCall) {
            const delta = acc.slice(textSent.length, safeEnd);
            if (!textOpen) {
              if (thinkOpen) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } }; thinkOpen = false; }
              textIndex = nextIndex++;
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
              textOpen = true;
            }
            textSent += delta;
            yield { type: 'text-delta', index: textIndex, text: delta };
          }
          if (boundary >= 0 && !pendingCall) {
            if (transport && candidate && tools.some(t => t.name === candidate)) {
              if (textOpen) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textSent } };
              const index = nextIndex++;
              pendingCall = { name: candidate, id: callId(0), index };
              yield { type: 'block-start', index, blockType: 'tool-call' };
              yield { type: 'tool-call-delta', index, id: pendingCall.id, name: candidate, argumentsDelta: '' };
            }
          }
          continue;
        }
        if (ev.err) throw ev.err;
        end = ev.end;
        break;
      }
      await settled;
      let finalText = (end?.text ?? acc) || '';
      const endImages = Array.isArray(end?.images) && end.images.length ? end.images : genImages;
      if (!finalText.trim() && !thinkAcc.trim() && endImages.length === 0) throw new Error('webcode relay: empty response from web AI');

      const { calls } = parseAgentReply(finalText);
      const valid = calls.filter((c) => tools.some((t) => t?.name === c.name));
      if (pendingCall && valid[0]?.name !== pendingCall.name) {
        turn.invalidate?.();
        throw new Error('TOOL_PROTOCOL_INVALID: 工具参数不完整或调用顺序不一致');
      }
      if (valid.length) {
        turn.commit();
        if (thinkOpen) yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
        if (textOpen && !pendingCall) {
          const imageMd = imageMarkdown(endImages);
          if (imageMd) { textSent += imageMd; yield { type: 'text-delta', index: textIndex, text: imageMd }; }
          // 兜底：边界探测若漏掉某种未知形态，这里仍保证写进会话的助手文本是散文。
          // 正常路径下 textSent 已被 boundary 截过，stripProtocolText 是恒等变换。
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: stripProtocolText(textSent) } };
        }
        for (let i = 0; i < valid.length; i++) {
          // id carries the session so harness-side streams / logs can be traced
          // back to the web conversation that produced the call.
          // 0.7.1：流式期间已提前开块的 pendingCall 必须在这里复用同一个
          // index/id 补发参数并关闭——真实会话（2026-09-08 f3fa97fd）暴露
          // 旧实现另开新 index 重发一遍，Harness 收到同 id 两条调用：先空
          // 参数执行一次（INVALID_ARGS 假错误），再真参数重复执行。
          const reuse = i === 0 && pendingCall;
          const id = reuse ? pendingCall.id : callId(i);
          const index = reuse ? pendingCall.index : nextIndex++;
          const args = JSON.stringify(valid[i].arguments ?? {});
          if (!reuse) yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, ...(reuse ? {} : { name: valid[i].name }), argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: valid[i].name, arguments: args } };
        }
        yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(finalText + thinkAcc) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (!textOpen) {
        turn.commit();
        if (thinkOpen) yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
        const imageMd = imageMarkdown(endImages);
        const out = imageMd ? finalText + imageMd : finalText;
        if (!out.trim()) throw new Error('webcode relay: empty response from web AI');
        yield* emitText(out, turn.prompt);
        return;
      }
      if (!finalText.startsWith(textSent)) throw new Error('STREAM_REWRITE: 网页重写了已输出内容');
      turn.commit();
      const imageMd = imageMarkdown(endImages);
      if (imageMd) finalText += imageMd;
      const tail = finalText.slice(textSent.length);
      if (tail) yield { type: 'text-delta', index: textIndex, text: tail };
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: finalText } };
      if (thinkOpen) yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkAcc } };
      yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(finalText + thinkAcc) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  llm.registerAdapter([cfg.providerId], adapter);

  /** Valid minimal text chunk sequence. */
async function* emitText(text, prompt) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text) } };
  yield { type: 'finish', reason: { kind: 'stop' } };
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
        logger: console,
      }));
    }
    return drivers.get(siteId);
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
  let front = null;
  const relay = createRelay({
    ...cfg,
    logger: console,
    // Session mode routes into the session's own web conversation (only the
    // increment lands); stateless turns (OpenAI front, aux) stay fresh.
    executor: (prompt, opts) => {
      const m = opts?.meta || null;
      // 归一化模型限定 id：meta 可能只带裸 id（OpenAI 前端），补上站点前缀，
      // 保证 driver 的 selectModel 一定解析到正确站点，不会因跨站点重名串模型。
      const qualified = qualifyModelId(m?.model, m?.siteId);
      // thinkMode: 'auto' | 'on' | 'off' — 设置页手动覆盖网页「深度思考」开关
      const thinkMode = ['on', 'off', 'auto'].includes(m?.thinkMode) ? m.thinkMode : 'auto';
      if (m?.sessionKey) {
        const drive = driverFor(m.siteId);
        const turnOpts = {
          fresh: m.fresh === true,
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
      return driverFor(m?.siteId).sendPrompt(prompt, { ...opts, model: qualified, thinkMode });
    },
    driverStatus: () => {
      const base = driver.status();
      // 聚合全部内容服务的登录/运行状态：未初始化的站点给占位（不启动浏览器）。
      const sites = SITES.map((st) => {
        const d = st.id === 'deepseek' ? driver : drivers.get(st.id);
        if (!d) return { siteId: st.id, siteName: st.name, initialized: false, running: false, busy: false, loggedIn: null, needLogin: false, selectedModel: null, window: null };
        const s = d.status();
        return { siteId: st.id, siteName: st.name, initialized: true, running: s.running, busy: s.busy, loggedIn: s.loggedIn, needLogin: s.needLogin, selectedModel: s.selectedModel, window: s.window ?? null };
      });
      return { ...base, sites };
    },
    loginTrigger: (siteId) => driverFor(siteId || 'deepseek').openLogin(),
    siteConnect: (siteId) => driverFor(getSite(siteId) ? siteId : 'deepseek'),
    // 展示窗口动作（有头 Edge）：侧栏「独立窗口」按钮走这里，与登录共用
    // 同一持久 profile——窗口里直接可聊，自动化轮次驱动同一页面。
    windowOpener: (siteId, action, opts = {}) => {
      const d = driverFor(getSite(siteId) ? siteId : 'deepseek');
      if (action === 'close') return d.closeWindow();
      return d.openWindow(opts);
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
    const model = resolvedModel.id;
    const siteId = resolvedModel.siteId;
    const agentId = options.agentId ?? options.agentName ?? options.agent ?? null;
    const keyPath = options.sessionId && cfg.contextMode === 'session' && !options.purpose
      ? [String(options.sessionId), agentId ? String(agentId) : ''].filter(Boolean).join('::')
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
      const prompt = serializeFirstTurn({ ...options, extraPrompt });
      recordPreset(prompt);
      return {
        prompt,
        meta: { model: siteId + ':' + model, siteId, thinkMode },
        async attach() {
          const imgs = imagesOfMessages(messages);
          return imgs.length ? resolveRemoteImages(imgs) : [];
        },
        commit() {},
      };
    }
    const fingerprint = count => createHash('sha256').update(JSON.stringify({ model, system: options.system, tools: options.tools, extraPrompt, messages: messages.slice(0, count) })).digest('hex');
    let st = sessionState.get(keyPath);
    if (st && (messages.length <= st.sent || st.fingerprint !== fingerprint(st.sent))) st = null;
    const fresh = !st;
    st ||= { sent: 0, toolResults: 0 };
    const delta = serializeDelta(messages, st.sent, st.toolResults);
    let prompt;
    if (fresh) { prompt = serializeFirstTurn({ ...options, extraPrompt }); recordPreset(prompt); }
    else prompt = delta.text;
    return {
      prompt,
      meta: {
        sessionKey: keyPath, fresh, model: siteId + ':' + model, siteId, thinkMode,
        // 网页会话丢失时的整段重放文本（见 executor 的 WEB_SESSION_LOST 分支）
        rebuild: () => serializeFirstTurn({ ...options, extraPrompt }),
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
        sessionState.set(keyPath, { sent: messages.length, toolResults: delta.toolResultsSent, fingerprint: fingerprint(messages.length) });
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
          const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Webcode Bridge 设置</title>
<style>
body { font-family: system-ui, sans-serif; background: #f8fafc; padding: 20px; max-width: 600px; margin: 0 auto; }
.card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 24px; }
h1 { font-size: 20px; margin-top: 0; }
label { display: block; margin: 16px 0 6px; font-weight: 600; }
textarea, select, input { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
textarea { min-height: 80px; font-family: inherit; }
button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-top: 16px; width: 100%; }
button:hover { background: #1d4ed8; }
#status { margin-top: 12px; padding: 8px; border-radius: 6px; }
.success { background: #dcfce7; color: #166534; }
.error { background: #fee2e2; color: #991b1b; }
.hint { font-size: 13px; color: #6b7280; margin-top: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>⚙️ Webcode Bridge 设置</h1>
  <form id="settingsForm">
    <label for="extraPrompt">全局指令（首轮注入）</label>
    <textarea id="extraPrompt" placeholder="例如：请始终使用中文回答..."></textarea>
    <div class="hint">这段文本会追加到每个新网页会话的第一条用户消息之前。</div>

    <label for="defaultModel">默认模型</label>
    <select id="defaultModel">
      ${WEB_MODELS.map((m) => `<option value="${m.id}">${m.name}（${m.siteName}${m.experimental ? ' · 实验' : ''}）</option>`).join('\n      ')}
    </select>
    <div class="hint">新建会话时默认选择的模型。已接入：DeepSeek、GLM、ChatGPT、Kimi、通义千问、豆包、Grok、Claude、Gemini。</div>

    <label for="previewRefreshRate">预览刷新率 (毫秒)</label>
    <input type="number" id="previewRefreshRate" min="1000" max="30000" step="500" value="5000">
    <div class="hint">控制预览面板自动刷新的间隔。</div>

    <label for="thinkMode">深度思考</label>
    <select id="thinkMode">
      <option value="auto">自动（按所选模型的默认思考行为）</option>
      <option value="on">始终开启（强制打开网页「深度思考」开关）</option>
      <option value="off">始终关闭（追求速度）</option>
    </select>
    <div class="hint">手动覆盖网页端的「深度思考」开关。自动=按模型属性（DeepSeek 默认开启深度思考）；始终开启/关闭则无视模型。</div>

    <button type="submit">保存设置</button>
  </form>
  <div id="status"></div>
</div>
<script>
  const API_BASE = '/__webcode';
  // 裸模型 id（历史设置值，如 'deepseek-web'）→ 站点限定 id（'deepseek:deepseek'）
  const MODEL_IDS = ${JSON.stringify(Object.fromEntries(WEB_MODELS.map((m) => [m.id.split(':').pop(), m.id])))};
  const form = document.getElementById('settingsForm');
  const statusEl = document.getElementById('status');

  async function loadSettings() {
    try {
      const res = await fetch(API_BASE + '/settings');
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      document.getElementById('extraPrompt').value = data.extraPrompt || '';
      document.getElementById('defaultModel').value = MODEL_IDS[data.defaultModel] || data.defaultModel || 'deepseek:deepseek';
      document.getElementById('previewRefreshRate').value = data.previewRefreshRate || 5000;
      document.getElementById('thinkMode').value = ['on', 'off', 'auto'].includes(data.thinkMode) ? data.thinkMode : 'auto';
    } catch (e) {
      statusEl.textContent = '加载设置失败: ' + e.message;
      statusEl.className = 'error';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      extraPrompt: document.getElementById('extraPrompt').value,
      defaultModel: document.getElementById('defaultModel').value,
      previewRefreshRate: parseInt(document.getElementById('previewRefreshRate').value, 10) || 5000,
      thinkMode: document.getElementById('thinkMode').value,
    };
    try {
      const res = await fetch(API_BASE + '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('保存失败');
      const result = await res.json();
      statusEl.textContent = '✅ 设置已保存';
      statusEl.className = 'success';
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.className = 'error';
    }
  });

  loadSettings();
</script>
</body>
</html>`;
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
