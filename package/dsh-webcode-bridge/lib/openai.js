// openai.js — OpenAI 兼容 HTTP 前端（跑在中继上）。
// GET /v1/models   POST /v1/chat/completions (stream:false → JSON, stream:true → SSE + [DONE])
// GET /bridge/status (relay + extension + consent diagnostics)
//
// 本版：
// • meta.images — 从 OpenAI 消息提取的图片附件进入 turn.meta（修复“有图说没图”）
// • onThink 通道 — SSE 发 delta.reasoning_content（深度思考链不再丢失）
// • onImage 通道 — 网页生成的图片回传为 content parts（image_url / b64 / 引用）
// • /v1/models — 列出全部内容服务站点的模型（site:id 限定 id）

import { flattenOpenAiMessages, imagesOfOpenAiMessages } from './flatten.js';
import { SITES, resolveWebModel, DEFAULT_MODEL_ID, qualifyModelId } from './providers.js';
import { estimateTokens } from './metrics.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_CT = 'application/json; charset=utf-8';
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/** 拒绝浏览器里恶意网页可控的上下文（防 CSRF/防 DNS 重绑定）。 */
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

/** CORS 预检/响应头只反映白名单来源（绝不 *）。 */
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

/** 只有中继状态的安全子集会离开进程：不带 profile 路径、不带网页会话 URL。 */
function publicStatus(relay) {
  const st = relay.status();
  const d = st.driver || {};
  const lt = d.lastTurn ? { sessionId: d.lastTurn.sessionId, at: d.lastTurn.at } : null;
  return {
    running: st.running, consent: st.consent, requireConsent: st.requireConsent,
    busy: st.busy, lastError: st.lastError,
    driver: {
      siteId: d.siteId ?? 'deepseek',
      running: d.running, busy: d.busy, needLogin: d.needLogin, loggedIn: d.loggedIn, lastTurn: lt,
      account: d.loggedIn ? '网页账号（已登录）' : (d.needLogin ? '未登录' : '未知'),
      lastRate: d.lastRate ?? null,
    },
    sites: Array.isArray(d.sites) ? d.sites : null,
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
        // 20MB：允许携带 base64 图片附件（6 张 × ≤8MB 之内），超出拒绝
        if (size > 20_000_000) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  /** 全部内容服务站的模型目录（site:id 限定 id + 能力元数据）。 */
  function modelsDocument() {
    const data = [];
    for (const st of SITES) {
      for (const m of st.models) {
        data.push({
          id: st.id + ':' + m.id,
          object: 'model',
          created: 0,
          owned_by: st.id,
          meta: { name: m.name, thinking: m.thinking === true, vision: m.vision === true, experimental: Boolean(st.experimental) },
        });
      }
    }
    data.push({ id: 'deepseek-web', object: 'model', created: 0, owned_by: 'deepseek', meta: { name: 'DeepSeek Web (兼容别名)' } });
    return { object: 'list', data };
  }

  function completionId() { return 'chatcmpl-webcode-' + Math.random().toString(36).slice(2); }

  /** 网页生成的图片 → OpenAI content parts。url 优先；b64 缺 mime 按 png；
   * image_asset_pointer（ChatGPT）无直链时以引用形式透出。 */
  function imageParts(images = []) {
    const parts = [];
    for (const img of images.slice(0, 6)) {
      if (typeof img === 'string') { parts.push({ type: 'image_url', image_url: { url: img } }); continue; }
      if (!img) continue;
      if (img.url) parts.push({ type: 'image_url', image_url: { url: img.url } });
      else if (img.base64) parts.push({ type: 'image_url', image_url: { url: 'data:' + (img.mime || 'image/png') + ';base64,' + img.base64 } });
      else if (img.pointer || img.assetPointer) {
        parts.push({ type: 'image_ref', image_ref: { pointer: img.pointer || null, asset: Boolean(img.assetPointer), mime: img.mime || 'image/png' } });
      }
    }
    return parts;
  }

  async function handleChatCompletions(req, res) {
    let body;
    try { body = await readBody(req); }
    catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages) return sendJson(res, 400, { error: { message: 'messages array required' } });
    let selectedModel, selectedSiteId;
    try { const r = resolveWebModel(body.model || modelId); selectedModel = r.id; selectedSiteId = r.siteId; }
    catch (err) { return sendJson(res, 400, { error: { message: err.message } }); }
    const thinkMode = ['on', 'off', 'auto'].includes(body?.think_mode) ? body.think_mode : 'auto';
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const stream = body?.stream === true;
    const prompt = flattenOpenAiMessages(messages);
    // 关键修复：用户消息里的图片附件进入 meta.images，由驱动上传到网页（识图模式）
    const images = imagesOfOpenAiMessages(messages);
    const created = Math.floor(Date.now() / 1000);
    const id = completionId();
    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (delta, finishReason, usage) => JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: selectedModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      });
      res.write('data: ' + frame({ role: 'assistant', content: '' }, null) + '\n\n');
      const qualified = qualifyModelId(selectedModel, selectedSiteId);
      try {
        await relay.submit(prompt, {
          meta: { model: qualified, siteId: selectedSiteId, images, thinkMode },
          signal: controller.signal,
          onDelta: (t) => { try { res.write('data: ' + frame({ content: t }, null) + '\n\n'); } catch {} },
          onThink: (t) => { try { res.write('data: ' + frame({ reasoning_content: t }, null) + '\n\n'); } catch {} },
          onImage: (img) => { try { res.write('data: ' + frame({ images: [img] }, null) + '\n\n'); } catch {} },
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
      const qualified = qualifyModelId(selectedModel, selectedSiteId);
      const { text, thinking, images: genImages } = await relay.submit(prompt, { meta: { model: qualified, siteId: selectedSiteId, images, thinkMode }, signal: controller.signal });
      if (!text.trim()) throw new Error('empty response from web AI');
      const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(text), total_tokens: estimateTokens(prompt) + estimateTokens(text) };
      const parts = [{ type: 'text', text }];
      const imgs = imageParts(genImages);
      if (imgs.length) parts.push(...imgs);
      const message = { role: 'assistant', content: parts };
      if (thinking) message.reasoning_content = thinking;
      sendJson(res, 200, {
        id, object: 'chat.completion', created, model: selectedModel,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
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
      res.writeHead(204, corsHeaders(req, allowedOrigins));
      res.end();
      return;
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/webcode/v1/models')) {
      return sendJson(res, 200, modelsDocument());
    }
    if (req.method === 'GET' && pathname === '/bridge/status') {
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
        // 只允许 DSH home、驱动 profile 或本包树内的 profile —— 任意 user-data-dir
        // 会让调用方在磁盘任意位置创建 Chromium profile 文件
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
        let body = {};
        try { body = await readBody(req); } catch {}
        const loginTrigger = relay.config.loginTrigger;
        if (!loginTrigger) return sendJson(res, 503, { error: { message: 'no driver' } });
        const siteId = String(body?.siteId || '').trim() || undefined;
        loginTrigger(siteId).then(
          () => {},
          (err) => console.warn('[webcode-bridge] login flow error:', err?.message),
        );
        sendJson(res, 200, { ok: true, message: 'login window opening; complete the login in that window' });
      })();
    }
    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/webcode/v1/chat/completions')) {
      return void handleChatCompletions(req, res);
    }
    sendJson(res, 404, { error: { message: 'no route: ' + req.method + ' ' + pathname } });
  }

  return { handle, modelsDocument };
}
