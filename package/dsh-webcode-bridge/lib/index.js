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
import { DEEPSEEK, resolveWebModel } from './providers.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRelay } from './relay.js';
import { createOpenAiFront } from './openai.js';
import { createBrowserDriver } from './browser-driver.js';
import { createWebControl, buildSessionEvents, mainLineOf } from './web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply } from './agent-preset.js';
import { createMirror } from './mirror.js';
import { flattenGenerateOptions, textOfBlocks } from './flatten.js';
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
  queueTimeoutMs: 300_000,
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'webcode-edge-profile'),
  headless: true,
  contextMode: 'session', // 'session': one web conversation per DSH session, incremental turns
  allowedOrigins: ['http://127.0.0.1:3080', 'http://localhost:3080'],
};

// Model identifiers select the corresponding mode in the logged-in web UI.
const WEB_MODELS = DEEPSEEK.models;

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
 */
function localAnswer(options) {
  try {
    const purpose = String(options.purpose || '');
    const sys = String(options.system || '');
    if (!/title|标题|命名|naming/i.test(`${purpose} ${sys}`)) return null;
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
  // 全局指令：设置页可追加，持久化在 profile 目录的 webcode-settings.json。
  const settingsPath = path.join(cfg.profileDir, 'webcode-settings.json');
  let extraPrompt = '';
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (saved && typeof saved.extraPrompt === 'string') extraPrompt = saved.extraPrompt;
  } catch { /* first run */ }
  const settingsStore = {
    get: () => ({ extraPrompt }),
    set: (extraPromptNew) => {
      extraPrompt = typeof extraPromptNew === 'string' ? extraPromptNew.slice(0, 4000) : '';
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const tmp = settingsPath + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify({ extraPrompt, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        fs.renameSync(tmp, settingsPath);
      } catch (err) { warn('settings save failed:', err?.message); }
      return settingsStore.get();
    },
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
        .submit(turn.prompt, { signal: options.signal, onDelta: (t) => ch.push({ delta: t }), meta: turn.meta })
        .then(({ text }) => ch.push({ end: text }))
        .catch((err) => { turn.invalidate?.(); ch.push({ err }); });

      if (tools.length === 0) {
        // pure chat: stream deltas as they arrive
        yield { type: 'block-start', index: 0, blockType: 'text' };
        let acc = '';
        for (;;) {
          const ev = await ch.next();
          if (ev.delta) {
            acc += ev.delta;
            yield { type: 'text-delta', index: 0, text: ev.delta };
          } else if (ev.err) {
            throw ev.err;
          } else {
            // canonical full text wins; patch the tail if deltas lagged
            if (ev.end && ev.end !== acc) {
              if (ev.end.startsWith(acc)) {
                const rest = ev.end.slice(acc.length);
                if (rest) { acc = ev.end; yield { type: 'text-delta', index: 0, text: rest }; }
              } else {
                acc = ev.end; // diverged: block-end below carries the truth
              }
            }
            break;
          }
        }
        if (!acc.trim()) throw new Error('webcode relay: empty response from web AI');
        turn.commit();
        yield { type: 'block-end', index: 0, block: { type: 'text', text: acc } };
        yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(acc) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        await settled;
        return;
      }

      let end = null;
      let acc = '';
      let textSent = '';
      let textOpen = false;
      let pendingCall = null;
      const callSeq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const callId = i => `call-webcode-${String(options?.sessionId || 'stateless')}-${callSeq}-${i}`;
      const marker = value => value.search(/<\s*(?:tool_call|function|stories)|```|\*\*Calling:|(?:^|\n)\s*\{/i);
      for (;;) {
        const ev = await ch.next();
        if (ev.delta) {
          acc += ev.delta;
          const boundary = marker(acc);
          // Keep a short suffix until the next delta disambiguates a marker.
          const safeEnd = boundary < 0 ? Math.max(0, acc.length - 32) : boundary;
          if (safeEnd > textSent.length && !pendingCall) {
            const delta = acc.slice(textSent.length, safeEnd);
            if (!textOpen) { textOpen = true; yield { type: 'block-start', index: 0, blockType: 'text' }; }
            textSent += delta;
            yield { type: 'text-delta', index: 0, text: delta };
          }
          if (boundary >= 0 && !pendingCall) {
            const suffix = acc.slice(boundary);
            const candidate = suffix.match(/\*\*Calling:\*\*\s*`([\w.-]+)`/)?.[1]
              || suffix.match(/"(?:name|tool)"\s*:\s*"([\w.-]+)"/)?.[1];
            const transport = /^<\s*(tool_call|function|stories)|^\*\*Calling:|"mcp_action"\s*:\s*"call"|^\s*\{\s*"tool"/i.test(suffix);
            if (transport && candidate && tools.some(t => t.name === candidate)) {
              if (textOpen) yield { type: 'block-end', index: 0, block: { type: 'text', text: textSent } };
              const index = textOpen ? 1 : 0;
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
      const finalText = (end ?? acc) || '';
      if (!finalText.trim()) throw new Error('webcode relay: empty response from web AI');

      const { calls } = parseAgentReply(finalText);
      const valid = calls.filter((c) => tools.some((t) => t?.name === c.name));
      if (pendingCall && valid[0]?.name !== pendingCall.name) {
        turn.invalidate?.();
        throw new Error('TOOL_PROTOCOL_INVALID: 工具参数不完整或调用顺序不一致');
      }
      if (valid.length) {
        turn.commit();
        if (textOpen && !pendingCall) yield { type: 'block-end', index: 0, block: { type: 'text', text: textSent } };
        for (let i = 0; i < valid.length; i++) {
          // id carries the session so harness-side streams / logs can be traced
          // back to the web conversation that produced the call.
          const id = callId(i);
          const index = i + (textOpen ? 1 : 0);
          const args = JSON.stringify(valid[i].arguments ?? {});
          if (!(i === 0 && pendingCall)) yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, ...(i === 0 && pendingCall ? {} : { name: valid[i].name }), argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: valid[i].name, arguments: args } };
        }
        yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(finalText) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }

      if (!textOpen) { turn.commit(); yield* emitText(finalText, turn.prompt); return; }
      if (!finalText.startsWith(textSent)) throw new Error('STREAM_REWRITE: 网页重写了已输出内容');
      turn.commit();
      if (finalText.length > textSent.length) yield { type: 'text-delta', index: 0, text: finalText.slice(textSent.length) };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: finalText } };
      yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(finalText) } };
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
      if (m?.sessionKey) {
        return driver.sendTurn(m.sessionKey, prompt, {
          fresh: m.fresh === true,
          signal: opts.signal,
          onDelta: opts.onDelta,
          model: m.model,
          images: m.images,
        }).catch(async (err) => {
          // a vanished/deleted conversation poisons the stored slot — reset
          // it so the NEXT turn reopens a fresh web chat
          if (err && !err.code) await driver.resetConversation(m.sessionKey).catch(() => {});
          throw err;
        });
      }
      return driver.sendPrompt(prompt, opts);
    },
    driverStatus: () => driver.status(),
    loginTrigger: () => driver.openLogin(),
    sessionImport: (dir) => driver.importStorageFromProfile(dir),
    onHttp: (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const pathname = u.pathname;
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
    settingsStore,
  });
  const mirror = createMirror({
    siteOrigin: new URL(cfg.site).origin,
    getToken: () => driver.getToken(),
    logger: console,
  });

  // Session-mode turn builder (needs cfg; installed once). Images ride in the
  // turn meta (only the newly-arrived ones) so vision turns attach real files
  // on the web side; parallel agents get their own web conversation via the
  // agent-qualified session key.
  buildTurn = (options = {}) => {
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const model = resolveWebModel(options.model || cfg.modelId).id;
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
        meta: { model },
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
      meta: { sessionKey: keyPath, fresh, model },
      invalidate: () => sessionState.delete(keyPath),
      async attach() {
        // a fresh turn replays the whole transcript → attach every image in it;
        // an incremental turn attaches only newly-arrived images
        const scope = (keyPath && !fresh) ? messages.slice(st.sent) : messages;
        const imgs = imagesOfMessages(scope);
        return imgs.length ? resolveRemoteImages(imgs) : [];
      },
      commit() {
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
      ['connect', 'connect'], ['interact', 'interact'],
      ['sessions', 'sessions'], ['history', 'history'],
      ['workspaces', 'workspaces'], ['import', 'import'],
      ['settings', 'settings'],
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
  }
  front = createOpenAiFront(relay, cfg);
  relay.start();
  log(`provider "${cfg.providerId}" registered; relay on http://${cfg.host}:${cfg.port}`);
  log(`web driver ready: site=${cfg.site} profile=${cfg.profileDir}`);

  // cordis: returning a disposer scopes everything to this plugin's fiber.
  return () => {
    for (const dispose of routeDisposers) if (typeof dispose === 'function') dispose();
    relay.stop();
    driver.close();
    log('unregistered; relay closed; driver stopped');
  };
}
