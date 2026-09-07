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

export function createRelay(options = {}) {
  const cfg = {
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
  };
  const log = (...a) => cfg.logger.log?.('[webcode-relay]', ...a);
  const warn = (...a) => cfg.logger.warn?.('[webcode-relay]', ...a);

  let httpServer = null;
  let started = false;
  let startError = null;
  let consent = false;      // consent gate state (this session only)
  let busy = false;
  let lastError = '';

  const queue = [];         // { prompt, resolve, reject, onDelta, signal, clearQ }
  const active = new Map(); // requestId → { item, seq, text, timer }

  function status() {
    return {
      running: started,
      startError,
      port: cfg.port,
      consent,
      requireConsent: cfg.requireConsent,
      busy,
      queueLength: queue.length,
      activeRequests: active.size,
      lastError,
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
      return;
    }
    item.clearQ?.();
    const requestId = 'req-' + randomUUID();
    busy = true;
    const entry = { item, seq: 0, text: '', timer: null };
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
        releaseAndDispatch();
        item.reject(abortError());
      };
      if (item.signal.aborted) return onCallerAbort();
      item.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    entry.timer = setTimeout(() => {
      if (!active.has(requestId)) return;
      active.delete(requestId);
      forwardAbort();                       // cancel the in-flight web turn
      lastError = `request timed out after ${cfg.requestTimeoutMs}ms`;
      warn(lastError, requestId);
      releaseAndDispatch();
      item.reject(new Error('webcode relay: ' + lastError));
    }, cfg.requestTimeoutMs);
    log('dispatched', requestId, `(queue=${queue.length})`);
    cfg.executor(promptOf(item), {
      signal: ac.signal,
      meta: item.meta || null,
      onDelta: (t) => {
        if (!active.has(requestId)) return;
        const e = active.get(requestId);
        e.text += t;
        e.seq += 1;
        try { item.onDelta?.(t); } catch {}
      },
    }).then(
      ({ text }) => {
        const e = active.get(requestId);
        if (!e) return;
        clearTimeout(e.timer);
        active.delete(requestId);
        releaseAndDispatch();
        e.item.resolve({ text: (text ?? e.text) || '' });
        log('request done', requestId, `chars=${(text ?? '').length}`);
      },
      (err) => {
        const e = active.get(requestId);
        if (!e) return;
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

  function submit(prompt, { signal, onDelta, meta } = {}) {
    return new Promise((resolve, reject) => {
      if (!cfg.executor) return reject(new Error('webcode relay: no executor configured'));
      if (queue.length >= 32) {
        lastError = 'queue full (32) — the web page is a low-throughput backend';
        warn(lastError);
        return reject(new Error('webcode relay: ' + lastError));
      }
      const item = { prompt, resolve, reject, onDelta, signal, meta };
      const qTimer = setTimeout(() => {
        const i = queue.indexOf(item);
        if (i >= 0) {
          queue.splice(i, 1);
          lastError = `queue timeout after ${cfg.queueTimeoutMs}ms`;
          warn(lastError);
          reject(new Error('webcode relay: ' + lastError));
        }
      }, cfg.queueTimeoutMs);
      item.clearQ = () => clearTimeout(qTimer);
      if (signal?.aborted) {
        item.clearQ();
        return reject(abortError());
      }
      if (signal) {
        signal.addEventListener('abort', () => {
          const i = queue.indexOf(item);
          if (i >= 0) {
            queue.splice(i, 1);
            item.clearQ();
            reject(abortError());
          }
        }, { once: true });
      }
      queue.push(item);
      dispatchNext();
    });
  }

  function setConsent(accepted) {
    consent = accepted === true;
    log('consent set to', consent);
  }

  function start() {
    if (started) return status();
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
