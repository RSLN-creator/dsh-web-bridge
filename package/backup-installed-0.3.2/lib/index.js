// index.js — dsh-webcode-bridge · Host half (profile bundle, real Node).
//
// Registers a "Web AI (webcode)" LLM provider in the DSH model selector and
// runs the local relay (WS for the consent-gated browser extension + an
// OpenAI-compatible HTTP front for verification and reuse).
//
// Native DSH capabilities are untouched: this plugin only ADDS an llm route
// and a local server; fs/shell/skills/MCP registries are never replaced.

import os from 'node:os';
import path from 'node:path';
import { createRelay } from './relay.js';
import { createOpenAiFront } from './openai.js';
import { createBrowserDriver } from './browser-driver.js';
import { createWebControl, buildSessionEvents, mainLineOf } from './web-control.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply } from './agent-preset.js';
import { createMirror } from './mirror.js';
import { flattenGenerateOptions, textOfBlocks } from './flatten.js';

export const name = 'webcode-bridge';

// cordis service injection: declaring these is REQUIRED before ctx.webServer /
// ctx.llm property access is permitted ("cannot get property ... without inject").
export const inject = ['llm', 'webServer'];

const DEFAULTS = {
  port: 8931,
  host: '127.0.0.1',
  providerId: 'webcode',
  displayName: 'Web AI (webcode)',
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

// Models the provider offers in the DSH selector. All route into the same
// logged-in web conversation; the distinct id picks a behaviour hint injected
// into the first / delta turn (web-side model switching is manual until the
// driver learns to flip the site's own model toggle).
const WEB_MODELS = [
  { id: 'deepseek-web', name: 'DeepSeek Web（网页版 · 标准对话）', mode: 'chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Web（网页版 · 深度思考）', mode: 'reasoner' },
];

const log = (...a) => console.log('[webcode-bridge]', ...a);
const warn = (...a) => console.warn('[webcode-bridge]', ...a);

const estimateTokens = (s) => Math.ceil((s ? String(s).length : 0) / 4);

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
      sys: String(options.system || '').replace(/\s+/g, ' ').slice(0, 80),
      last: textOfBlocks(last?.content).replace(/\s+/g, ' ').slice(0, 60),
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
const sessionState = new Map(); // key → { sent, toolResults }

/* real impl installed inside apply() (needs cfg + driver) */
let buildTurnImpl = null;
function buildTurn(options) { return buildTurnImpl(options); }

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
    const t = textOfBlocks(firstUser?.content).replace(/\s+/g, ' ').trim();
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

  const modeHint = (model) => {
    const mode = WEB_MODELS.find((m) => m.id === String(model || ''))?.mode || 'chat';
    if (mode === 'reasoner') {
      return '[模式] 你被选为「深度思考 R1」模型，请给出更深入、分步推导的回答。如网页端需要手动开启“深度思考”开关，请照做。\n\n';
    }
    return '';
  };

  const adapter = {
    providerInfo(provider) { return { id: provider, name: cfg.displayName }; },
    providerRetryPolicy() { return undefined; },
    async listModels(provider) {
      return WEB_MODELS.map((m) => ({ provider, id: m.id, name: m.name }));
    },
    async resolveModel(provider, model) {
      const m = WEB_MODELS.find((x) => x.id === String(model || ''));
      if (!m) throw new Error('[webcode-bridge] 未知模型: ' + model);
      return { provider, id: m.id, name: m.name, context: { contextWindow: 128_000 } };
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal);
      return { model: info, stream: (opts) => this.stream(opts) };
    },
    async *stream(options) {
      const turn = buildTurn(options);
      logCall(options);

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
        .catch((err) => ch.push({ err }));

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
        yield { type: 'block-end', index: 0, block: { type: 'text', text: acc } };
        yield { type: 'usage', usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(acc) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        await settled;
        return;
      }

      // tools in play: buffer the whole reply, then it is either agent tool
      // calls (mcp_action JSON fences, webcode protocol — possibly several)
      // or plain text — never both streamed.
      let end = null;
      let acc = '';
      for (;;) {
        const ev = await ch.next();
        if (ev.delta) { acc += ev.delta; continue; }
        if (ev.err) throw ev.err;
        end = ev.end;
        break;
      }
      await settled;
      const finalText = (end ?? acc) || '';
      if (!finalText.trim()) throw new Error('webcode relay: empty response from web AI');

      const { calls } = parseAgentReply(finalText);
      const valid = calls.filter((c) => tools.some((t) => t?.name === c.name));
      if (valid.length) {
        turn.commit();
        const callSeq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        for (let i = 0; i < valid.length; i++) {
          // id carries the session so harness-side streams / logs can be traced
          // back to the web conversation that produced the call.
          const id = `call-webcode-${String(options?.sessionId || 'stateless')}-${callSeq}-${i}`;
          const args = JSON.stringify(valid[i].arguments ?? {});
          yield { type: 'block-start', index: i, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: i, id, name: valid[i].name, argumentsDelta: args };
          yield { type: 'block-end', index: i, block: { type: 'tool-call', id, name: valid[i].name, arguments: args } };
        }
        yield { type: 'usage', usage: { inputTokens: estimateTokens(turn.prompt), outputTokens: estimateTokens(finalText) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      turn.commit();
      yield* emitText(finalText, turn.prompt);
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
  const webControl = createWebControl({ driver, relay, config: cfg, host, logger: console });
  const mirror = createMirror({
    siteOrigin: new URL(cfg.site).origin,
    getToken: () => driver.getToken(),
    logger: console,
  });

  // Session-mode turn builder (needs cfg; installed once).
  buildTurnImpl = (options = {}) => {
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const auxPurpose = options.purpose && options.purpose !== 'session-title';
    const head = modeHint(options.model);
    if (cfg.contextMode !== 'session' || auxPurpose) {
      // stateless: whole flattened history in one fresh web conversation
      return { prompt: (auxPurpose ? '' : head) + flattenGenerateOptions(options), meta: null, commit: () => {} };
    }
    const key = String(options.sessionId || 'main');
    let st = sessionState.get(key);
    if (!st) { st = { sent: 0, toolResults: 0 }; sessionState.set(key, st); }
    // DSH rewound the history (regeneration/rewind) → restart the web chat
    if (st.sent > 0 && messages.length < st.sent) {
      log(`session ${key}: history shrank (${st.sent} → ${messages.length}), restarting web conversation`);
      st.sent = 0;
      st.toolResults = 0;
      void driver.resetConversation(key).catch(() => {});
    }
    if (st.sent === 0) {
      const prompt = head + serializeFirstTurn(options);
      return {
        prompt,
        meta: { sessionKey: key, fresh: true },
        commit: () => { st.sent = messages.length; },
      };
    }
    const delta = serializeDelta(messages, st.sent, st.toolResults);
    return {
      prompt: head + delta.text,
      meta: { sessionKey: key, fresh: false },
      commit: () => { st.sent = delta.consumed; st.toolResults = delta.toolResultsSent; },
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
  if (webServer && typeof webServer.register === 'function') {
    const routes = [
      ['status', 'status'], ['consent', 'consent'], ['login', 'login'],
      ['sessions', 'sessions'], ['history', 'history'],
      ['workspaces', 'workspaces'], ['import', 'import'], ['token', 'token'],
    ];
    for (const [, suffix] of routes) {
      try {
        webServer.register({
          kind: 'exact',
          path: '/__webcode/' + suffix,
          handler: (req, res) =>
            webControl.handle(req, res, '/__webcode/' + suffix)
              .then((handled) => { if (!handled) res.writeHead(404).end(); })
              .catch(() => { try { res.writeHead(500).end(); } catch {} }),
        });
      } catch (e) {
        warn('webServer route /__webcode/' + suffix, 'failed:', e?.message);
      }
    }
    try {
      webServer.register({
        kind: 'exact',
        path: '/__webcode/preview',
        handler: (req, res) => { webControl.handlePreview(req, res).catch(() => { try { res.end(); } catch {} }); },
      });
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
    relay.stop();
    driver.close();
    log('unregistered; relay closed; driver stopped');
  };
}
