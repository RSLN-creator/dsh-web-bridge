// openai.js — OpenAI-compatible HTTP front over the relay.
//   GET  /v1/models
//   POST /v1/chat/completions   (stream:false → JSON, stream:true → SSE + [DONE])
//   GET  /bridge/status         (relay + extension + consent diagnostics)
//
// Requests are flattened into a single prompt and forwarded to the consented
// extension; responses stream back as deltas arrive.

import { flattenOpenAiMessages } from './flatten.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_CT = 'application/json; charset=utf-8';
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/** Reject browser contexts a hostile web page controls (anti-CSRF/anti-rebind).
 *  Loopback Host kills DNS rebinding; `Sec-Fetch-Site: cross-site` kills
 *  requests initiated from public websites; an explicit Origin must be the
 *  server's own origin or on the allowlist (another loopback port is a
 *  different application, not "us"). Local CLI tools send neither header. */
function csrfSafe(req, allowedOrigins = []) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) return false;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return false;
  const origin = String(req.headers.origin || '');
  if (origin) {
    if (allowedOrigins.includes(origin.toLowerCase())) return true;
    try { return new URL(origin).host === String(req.headers.host || ''); }
    catch { return false; }
  }
  return true;
}

/** CORS preflight/headers reflecting ONLY allowlisted origins (never `*`). */
function corsHeaders(req, allowedOrigins = []) {
  const origin = String(req.headers.origin || '');
  if (origin && allowedOrigins.includes(origin.toLowerCase())) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      Vary: 'Origin',
    };
  }
  return {};
}

/** Only the safe subset of relay status leaves the process: no profile
 *  paths, no web-session URLs (ids alone are fine for diagnostics). */
function publicStatus(relay) {
  const st = relay.status();
  const d = st.driver || {};
  const lt = d.lastTurn ? { sessionId: d.lastTurn.sessionId, at: d.lastTurn.at } : null;
  return {
    running: st.running, consent: st.consent, requireConsent: st.requireConsent,
    busy: st.busy, lastError: st.lastError,
    driver: { running: d.running, busy: d.busy, needLogin: d.needLogin, loggedIn: d.loggedIn, lastTurn: lt },
  };
}

export function createOpenAiFront(relay, modelInfo) {
  const { modelId, modelName, providerId } = modelInfo;
  const allowedOrigins = (relay?.config?.allowedOrigins || []).map((s) => String(s).toLowerCase());

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': JSON_CT });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 4_000_000) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  function estimateTokens(s) { return Math.ceil((s ? String(s).length : 0) / 4); }

  function modelsDocument() {
    return {
      object: 'list',
      data: [{ id: modelId, object: 'model', created: 0, owned_by: providerId }],
    };
  }

  function completionId() { return 'chatcmpl-webcode-' + Math.random().toString(36).slice(2); }

  async function handleChatCompletions(req, res) {
    let body;
    try { body = await readBody(req); }
    catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages) return sendJson(res, 400, { error: { message: 'messages array required' } });
    const stream = body?.stream === true;
    const prompt = flattenOpenAiMessages(messages);
    const created = Math.floor(Date.now() / 1000);
    const id = completionId();
    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (delta, finishReason, usage) => JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      });
      res.write('data: ' + frame({ role: 'assistant', content: '' }, null) + '\n\n');
      try {
        await relay.submit(prompt, {
          onDelta: (t) => { try { res.write('data: ' + frame({ content: t }, null) + '\n\n'); } catch {} },
        }).then(({ text }) => {
          if (!text.trim()) throw new Error('empty response from web AI');
          const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(text), total_tokens: estimateTokens(prompt) + estimateTokens(text) };
          res.write('data: ' + frame({}, 'stop', usage) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, (err) => {
          res.write('data: ' + JSON.stringify({ error: { message: err.message, type: 'bridge_error', diagnostics: publicStatus(relay) } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
      } catch (err) {
        try { res.end(); } catch {}
      }
      return;
    }

    try {
      const { text } = await relay.submit(prompt);
      if (!text.trim()) throw new Error('empty response from web AI');
      const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(text), total_tokens: estimateTokens(prompt) + estimateTokens(text) };
      sendJson(res, 200, {
        id, object: 'chat.completion', created, model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      });
    } catch (err) {
      sendJson(res, 503, {
        error: { message: err.message, type: 'bridge_error', diagnostics: publicStatus(relay) },
      });
    }
  }

  function handle(req, res, pathname) {
    if (req.method === 'OPTIONS') {
      // preflight: reflect only allowlisted origins (bare 204 for strangers)
      res.writeHead(204, corsHeaders(req, allowedOrigins));
      res.end();
      return;
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/webcode/v1/models')) {
      return sendJson(res, 200, modelsDocument());
    }
    if (req.method === 'GET' && pathname === '/bridge/status') {
      // public subset only — no profile paths, no session URLs
      const st = publicStatus(relay);
      return sendJson(res, 200, { ...st, modelId, modelName });
    }
    if (req.method === 'POST' && !csrfSafe(req, allowedOrigins)) {
      return sendJson(res, 403, { error: { message: 'cross-site requests are not allowed' } });
    }
    if (req.method === 'POST' && pathname === '/bridge/consent') {
      return void (async () => {
        let body = {};
        try { body = await readBody(req); } catch {}
        relay.setConsent(body?.accepted === true);
        sendJson(res, 200, { ok: true, consent: relay.status().consent });
      })();
    }
    if (req.method === 'POST' && pathname === '/bridge/import-session') {
      return void (async () => {
        let body = {};
        try { body = await readBody(req); } catch {}
        const sessionImport = relay.config.sessionImport;
        const dir = String(body?.sourceProfileDir || '');
        if (!sessionImport || !dir) {
          return sendJson(res, 400, { error: { message: 'sourceProfileDir required / no driver' } });
        }
        // only profiles in the DSH home, under the driver profile, or in this
        // package tree — an arbitrary user-data-dir would let callers create
        // Chromium profile files anywhere on disk
        let resolved = null;
        try { resolved = path.resolve(dir); } catch {}
        const bases = [relay.config.profileDir, process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), pkgRoot]
          .filter(Boolean).map((p) => { try { return path.resolve(p); } catch { return null; } }).filter(Boolean);
        const contained = resolved && bases.some((b) => {
          const rel = path.relative(b, resolved);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        if (!contained) {
          return sendJson(res, 400, { error: { message: 'sourceProfileDir outside permitted roots' } });
        }
        try {
          const result = await sessionImport(resolved);
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendJson(res, 500, { error: { message: err?.message || String(err) } });
        }
      })();
    }
    if (req.method === 'POST' && pathname === '/bridge/login') {
      return void (async () => {
        const loginTrigger = relay.config.loginTrigger;
        if (!loginTrigger) return sendJson(res, 503, { error: { message: 'no driver' } });
        loginTrigger().then(
          () => {},
          (err) => console.warn('[webcode-bridge] login flow error:', err?.message),
        );
        sendJson(res, 200, { ok: true, message: 'login window opening; complete the login in that window' });
      })();
    }
    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/webcode/v1/chat/completions')) {
      return void handleChatCompletions(req, res);
    }
    sendJson(res, 404, { error: { message: `no route: ${req.method} ${pathname}` } });
  }

  return { handle, modelsDocument };
}
