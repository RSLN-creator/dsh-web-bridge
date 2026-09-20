// relay.js — the hub between DSH and the web AI (in-package browser driver).
//
// One HTTP server on 127.0.0.1:
//   POST /v1/chat/completions, GET /v1/models   OpenAI-compatible front
//   GET  /bridge/status                         diagnostics (driver + consent)
//   POST /bridge/consent                        risk-gate opt-in (per session)
//   POST /bridge/login                          open the one-time login window
//   anything else                               delegated to onHttp fallback
//
// Requests flow through a single-slot executor (busy flag) + FIFO queue — the
// web page only ever automates one message at a time (low-frequency). The
// executor is the in-package browser driver; there is no extension.

import { randomUUID } from 'node:crypto';
import { Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './metrics.js';

/**
 * 本机 relay：一个只绑回环的 HTTP 服务，扮演「网页模型的 OpenAI 兼容端点」。
 *
 * 它存在的意义是把**单进程共享的浏览器驱动**串行化：DSH 可能同时发多个请求，
 * 而网页会话只有一个输入框，并发写入必然互相踩。relay 因此做三件事：
 *   1. 排队（`queueTimeoutMs` 内串行执行，超时才放弃）；
 *   2. 同意闸（`requireConsent`：用户没在设置页授权就不接受任何请求）；
 *   3. 把驱动吐出的增量转发成 SSE 给调用方。
 *
 * 安全边界：`host` 默认 `127.0.0.1`，**不要**改成 0.0.0.0——这个端口背后是
 * 用户已登录的网页会话，暴露到局域网等于把账号交出去。
 *
 * @param {object} [options] 配置覆盖（port/host/executor/onHttp/logger…）
 * @returns {object} relay 实例（start/stop/status/submit 等）
 */
export function createRelay(options = {}) {
  const cfg = {
    ...options,
    port: options.port ?? 8931,
    host: options.host ?? '127.0.0.1',
    requestTimeoutMs: options.requestTimeoutMs ?? 240_000,
    queueTimeoutMs: options.queueTimeoutMs ?? 300_000,
    requireConsent: options.requireConsent !== false,
    modelId: options.modelId ?? 'deepseek-web',
    logger: options.logger ?? console,
    onHttp: options.onHttp ?? null,          // OpenAI front (index.js wires it)
    executor: options.executor ?? null,      // (prompt, {signal,onDelta}) → {text}
    driverStatus: options.driverStatus ?? null, // () → driver status
    loginTrigger: options.loginTrigger ?? null,  // () → open one-time login window
    sessionImport: options.sessionImport ?? null, // (sourceProfileDir) → adopt session
    consentStorePath: options.consentStorePath ?? (options.profileDir ? path.join(options.profileDir, 'webcode-consent.json') : null),
    // 每次调用收束时的观测回调 (metrics, meta)。0.14.4：累计等待时长的唯一记账
    // 入口——记账必须发生在**本轮真正收束**那一刻，而不是轮询 status 时补算，
    // 否则同一条 metrics 会被重复累加（status 是被高频读取的）。
    onMetrics: options.onMetrics ?? null,
  };
  const log = (...a) => cfg.logger.log?.('[webcode-relay]', ...a);
  const warn = (...a) => cfg.logger.warn?.('[webcode-relay]', ...a);

  let httpServer = null;
  let started = false;
  let startError = null;
  let consent = false;      // loaded once from the durable local consent record
  let busy = false;
  let lastError = '';
  let metrics = null;

  function loadConsent() {
    if (!cfg.consentStorePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(cfg.consentStorePath, 'utf8'));
      consent = raw?.accepted === true;
    } catch { /* first run or unreadable store */ }
  }

  function saveConsent() {
    if (!cfg.consentStorePath) return;
    try {
      fs.mkdirSync(path.dirname(cfg.consentStorePath), { recursive: true });
      // Replace the small record atomically so a process exit cannot leave a
      // truncated consent file that silently turns into a first-run state.
      const tmp = cfg.consentStorePath + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ accepted: consent, updatedAt: new Date().toISOString() }), { mode: 0o600 });
      fs.renameSync(tmp, cfg.consentStorePath);
    } catch (err) { warn('consent store save failed:', err?.message); }
  }

  const queue = [];         // { prompt, resolve, reject, onDelta, signal, clearQ }
  const active = new Map(); // requestId → { item, seq, text, timer }

  function status() {
    return {
      running: started,
      startError,
      port: cfg.port,
      consent,
      consentPersistent: Boolean(cfg.consentStorePath),
      requireConsent: cfg.requireConsent,
      busy,
      queueLength: queue.length,
      activeRequests: active.size,
      lastError,
      metrics,
      driver: cfg.driverStatus?.() ?? null,
    };
  }

  function dispatchNext() {
    if (busy) return;
    const item = queue.shift();
    if (!item) return;
    if (cfg.requireConsent && !consent) {
      lastError = 'consent not granted — enable the bridge in the Web AI panel first';
      warn(lastError);
      item.reject(new Error('webcode relay: ' + lastError));
      item.clearQ?.();
      dispatchNext();
      return;
    }
    item.clearQ?.();
    const requestId = 'req-' + randomUUID();
    busy = true;
    const entry = { item, seq: 0, text: '', timer: null, startedAt: performance.now(), firstDeltaAt: null, thinkingChars: 0 };
    active.set(requestId, entry);
    // The relay owns a master AbortController so ITS timeout/stop actually
    // reaches the executor — a driver-side timer alone leaves the web turn
    // running and pollutes the queue with `driver busy` failures.
    const ac = new AbortController();
    entry.ac = ac;
    const forwardAbort = () => { if (!ac.signal.aborted) ac.abort(new Error('webcode relay: request aborted')); };
    if (item.signal) {
      const onCallerAbort = () => {
        if (!active.has(requestId)) return;
        clearTimeout(entry.timer);
        active.delete(requestId);
        forwardAbort();
        item.reject(abortError());
      };
      if (item.signal.aborted) { onCallerAbort(); releaseAndDispatch(); return; }
      item.signal.addEventListener('abort', onCallerAbort, { once: true });
      entry.removeAbort = () => item.signal.removeEventListener('abort', onCallerAbort);
    }
    entry.timer = setTimeout(() => {
      if (!active.has(requestId)) return;
      active.delete(requestId);
      forwardAbort();                       // cancel the in-flight web turn
      lastError = `request timed out after ${cfg.requestTimeoutMs}ms`;
      warn(lastError, requestId);
      item.reject(new Error('webcode relay: ' + lastError));
    }, cfg.requestTimeoutMs);
    log('dispatched', requestId, `(queue=${queue.length})`);
    Promise.resolve().then(() => cfg.executor(promptOf(item), {
      signal: ac.signal,
      meta: item.meta || null,
      onDelta: (t) => {
        if (!active.has(requestId)) return;
        const e = active.get(requestId);
        e.firstDeltaAt ??= performance.now();
        e.text += t;
        e.seq += 1;
        try { item.onDelta?.(t); } catch {}
      },
      onThink: (t) => { try { item.onThink?.(t); } catch {} },
      onImage: (img) => { try { item.onImage?.(img); } catch {} },
    })).then(
      (result = {}) => {
        const text = result.text;
        const e = active.get(requestId);
        entry.removeAbort?.();
        if (!e) { releaseAndDispatch(); return; }
        clearTimeout(e.timer);
        active.delete(requestId);
        releaseAndDispatch();
        const endAt = performance.now();
        const outputTokens = estimateTokens(String(text ?? e.text));
        const measured = result.metrics || {};
        const durationMs = Math.round(measured.endToEndMs ?? (endAt - e.startedAt));
        const firstTokenMs = measured.firstResponseMs ?? (e.firstDeltaAt === null ? null : Math.round(e.firstDeltaAt - e.startedAt));
        const responseMs = measured.responseMs ?? (firstTokenMs == null ? durationMs : Math.max(1, durationMs - firstTokenMs));
        metrics = {
          estimated: false,
          timing: 'measured',
          tokensEstimated: true,
          tokenBasis: 'CJK≈0.7/字符、ASCII≈0.25/字符，仅用于相对速度比较',
          outputTokens,
          durationMs,
          firstTokenMs,
          thinkingMs: measured.thinkingMs ?? null,
          responseMs,
          responseTps: Math.round(outputTokens * 10000 / Math.max(1, responseMs)) / 10,
          tps: Math.round(outputTokens * 10000 / Math.max(1, durationMs)) / 10,
          phaseSource: measured.firstResponseMs != null ? '网页 SSE' : '中继观测',
          // 发送前等待（节流间隔 + 限流退避）：发生在网页生成之前，不计入
          // durationMs，右栏统计单独一条展示；rateLimitRetries 是限流重试次数。
          sendWaitMs: Math.max(0, Math.round(Number(measured.sendWaitMs) || 0)),
          rateLimitRetries: Math.max(0, Math.round(Number(measured.rateLimitRetries) || 0)),
          // 0.14.0：让「设了间隔却看不见」不可能再发生——目标值与距上次发出的
          // 实际间隔一起透出，于是**没等待**的那些轮次也有数字可核对。
          gapTargetMs: Math.max(0, Math.round(Number(measured.gapTargetMs) || 0)),
          // 0.16.31：间隔**口径**（send-to-send / end-to-start）。读数里不写清
          // 用的是哪把尺子，「等待不像我设的」就无从判定——同一个 sincePrevSendMs
          // 在两个口径下含义完全不同（距上次发出 / 距上次回复完成）。
          gapBasis: measured.gapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send',
          sincePrevSendMs: measured.sincePrevSendMs == null ? null : Math.max(0, Math.round(Number(measured.sincePrevSendMs) || 0)),
          // 本轮收束原因（finished / partial-wip-settled / timeout）——见
          // browser-driver 的 WIP 稳态收束；null 表示驱动没报（旧版本/dom 站点）。
          endReason: typeof measured.endReason === 'string' ? measured.endReason : null,
        };
        // 观测回调：累计等待时长在这里落账（见 cfg.onMetrics 注释）。回调失败
        // 绝不能影响本轮结果——统计是附带产物，不是主链路。
        try { cfg.onMetrics?.(metrics, item.meta || null); } catch (err) { warn('onMetrics failed:', err?.message); }
        lastError = '';
        e.item.resolve({
          text: (text ?? e.text) || '',
          thinking: typeof result.thinking === 'string' ? result.thinking : '',
          images: Array.isArray(result.images) ? result.images : [],
        });
        log('request done', requestId, `chars=${(text ?? '').length}`);
      },
      (err) => {
        const e = active.get(requestId);
        entry.removeAbort?.();
        if (!e) { releaseAndDispatch(); return; }
        clearTimeout(e.timer);
        active.delete(requestId);
        lastError = err?.message || String(err);
        releaseAndDispatch();
        e.item.reject(err instanceof Error ? err : new Error(lastError));
      }
    );
  }

  function promptOf(item) { return item.prompt; }

  function releaseAndDispatch() {
    busy = false;
    dispatchNext();
  }

  function submit(prompt, { signal, onDelta, onThink, onImage, meta } = {}) {
    return new Promise((resolve, reject) => {
      if (!cfg.executor) return reject(new Error('webcode relay: no executor configured'));
      if (queue.length >= 32) {
        lastError = 'queue full (32) — the web page is a low-throughput backend';
        warn(lastError);
        return reject(new Error('webcode relay: ' + lastError));
      }
      const item = { prompt, resolve, reject, onDelta, onThink, onImage, signal, meta };
      const qTimer = setTimeout(() => {
        const i = queue.indexOf(item);
        if (i >= 0) {
          queue.splice(i, 1);
          lastError = `queue timeout after ${cfg.queueTimeoutMs}ms`;
          warn(lastError);
          reject(new Error('webcode relay: ' + lastError));
        }
      }, cfg.queueTimeoutMs);
      let queuedAbort;
      item.clearQ = () => { clearTimeout(qTimer); if (queuedAbort) signal.removeEventListener('abort', queuedAbort); };
      if (signal?.aborted) {
        item.clearQ();
        return reject(abortError());
      }
      if (signal) {
        queuedAbort = () => {
          const i = queue.indexOf(item);
          if (i >= 0) {
            queue.splice(i, 1);
            item.clearQ();
            reject(abortError());
          }
        };
        signal.addEventListener('abort', queuedAbort, { once: true });
      }
      queue.push(item);
      dispatchNext();
    });
  }

  function setConsent(accepted) {
    consent = accepted === true;
    saveConsent();
    log('consent set to', consent);
  }

  function start() {
    if (started) return status();
    loadConsent();
    httpServer = new HttpServer((req, res) => {
      // No permissive CORS: the server is loopback-only and consumed by local
      // tools and same-host pages. A wildcard here would let any public
      // website read the logged-in web AI's answers cross-origin. OPTIONS is
      // passed through so mounted route tables can answer preflights with an
      // allowlist-reflected origin.
      if (cfg.onHttp) return void cfg.onHttp(req, res);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    httpServer.on('error', (err) => {
      startError = err.message;
      warn('http server error:', err.message);
    });
    httpServer.listen(cfg.port, cfg.host, () => {
      started = true;
      log(`listening on http://${cfg.host}:${cfg.port} (consent ${cfg.requireConsent ? 'required' : 'not required'})`);
    });
    return status();
  }

  function stop() {
    for (const requestId of [...active.keys()]) {
      const e = active.get(requestId);
      clearTimeout(e?.timer);
      try { e?.ac?.abort(new Error('webcode relay: relay stopped')); } catch {}
      active.delete(requestId);
      e?.item.reject(new Error('webcode relay: relay stopped'));
    }
    for (const item of queue.splice(0)) {
      item.clearQ?.();
      item.reject(abortError('relay stopped'));
    }
    if (httpServer) { try { httpServer.close(); } catch {} }
    httpServer = null;
    started = false;
    consent = false;
    log('stopped');
  }

  return { start, stop, submit, status, setConsent, get config() { return cfg; } };
}

function abortError(message = 'aborted') {
  const err = new Error('webcode relay: ' + message);
  err.name = 'AbortError';
  return err;
}
