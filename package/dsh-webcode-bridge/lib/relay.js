// relay.js — the hub between DSH and the web AI (in-package browser driver).
//
// One HTTP server on 127.0.0.1:
//   POST /v1/chat/completions, GET /v1/models   OpenAI-compatible front
//   GET  /bridge/status                         diagnostics (driver + consent)
//   POST /bridge/consent                        risk-gate opt-in (per session)
//   POST /bridge/login                          open the one-time login window
//   anything else                               delegated to onHttp fallback
//
// Requests flow through **per-account lanes**: one in-flight request per account
// (the same account must never be driven twice at once), real concurrency across
// distinct accounts, and a global cap plus a minimum spacing between any two
// sends. 0.19.3 and earlier used a single global busy flag + one FIFO, which
// serialized every site and every account — see the cfg comments below.
//
// The executor is the in-package browser driver; there is no extension.

import { randomUUID } from 'node:crypto';
import { Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './metrics.js';

/**
 * 本机 relay：一个只绑回环的 HTTP 服务，扮演「网页模型的 OpenAI 兼容端点」。
 *
 * 它存在的意义是把**并发的写入**收敛成「每个账号一条通道」：DSH 可能同时发多个请求，
 * 而同一个网页会话只有一个输入框，同一账号并发写入必然互相踩。relay 因此做四件事：
 *   1. **按账号分派**（同账号排队，不同账号真并发），并发数与两次发出之间的最小间隔
 *      由 `maxConcurrentLanes` / `minSendIntervalMs` 控制；
 *   2. 同意闸（`requireConsent`：用户没在设置页授权就不接受任何请求）；
 *   3. 把驱动吐出的增量转发成 SSE 给调用方；
 *   4. 队列超时（`queueTimeoutMs`）与请求超时（`requestTimeoutMs`）各自兜底。
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
    // ---- 并发（0.19.4）-------------------------------------------------------
    // 用户原话：「已有使用账号不允许同时再使用！！一个网址可以多个账号，多个对话！
    // 但是必须每个对于唯一账号！……需要不能同时发过多请求，错峰！但是不是让你只留
    // 一个协议进行转接意思！还是多账户并发多会话那样需要真实多个转接！」
    //
    // 因此执行器从「一个全局槽 + 一条 FIFO」改成「**按账号分通道**」：
    //   · 同一账号同时只允许一个在途请求（同账号的第二个请求在它自己的通道里排队）；
    //   · 不同账号之间**真并发**（各自有独立浏览器实例，见 index.js 的 drivers Map）；
    //   · 全局仍有上限与**错峰**，避免同一时刻对同一站点打出一串请求（风控）。
    maxConcurrentLanes: options.maxConcurrentLanes ?? 2,
    minSendIntervalMs: options.minSendIntervalMs ?? 1000,
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

  const active = new Map(); // requestId → { item, seq, text, timer, lane }
  let seqCounter = 0;       // 跨通道的到达序（保证「先到先派」而不是「按通道轮转」）
  let lastSendAt = 0;       // 上一次**真正发出**的时刻（错峰基准）
  let staggerTimer = null;

  /**
   * 并发的唯一单位是**账号**（`accountKey`）。没有账号键的调用（OpenAI 前端的裸调用、
   * 无 meta 的直接 submit）退到 siteId/model/`__default`——它们没有「同账号唯一」的
   * 语义，但仍必须彼此串行。
   *
   * @param {object|null} meta relay.submit 透传的 meta。
   * @returns {string} 通道键。
   */
  function laneKeyOf(meta) {
    return String(meta?.accountKey || meta?.siteId || meta?.model || '__default');
  }

  const lanes = new Map();  // laneKey → { key, busy, queue: [] }

  function laneOf(key) {
    let l = lanes.get(key);
    if (!l) { l = { key, busy: false, queue: [] }; lanes.set(key, l); }
    return l;
  }

  function queuedTotal() {
    let n = 0;
    for (const l of lanes.values()) n += l.queue.length;
    return n;
  }

  function status() {
    return {
      running: started,
      startError,
      port: cfg.port,
      consent,
      consentPersistent: Boolean(cfg.consentStorePath),
      requireConsent: cfg.requireConsent,
      // `busy` 是兼容字段（既有 UI/文档读它）：**还有任何在途**就算 true。
      busy: active.size > 0,
      queueLength: queuedTotal(),
      activeRequests: active.size,
      // 通道明细（0.19.4）：哪条通道在跑、各自排了几条。没有它，「为什么这个账号
      // 的请求还没发出去」只能靠猜——而这次改造的全部意义就是让多账号真并发。
      lanes: [...lanes.values()]
        .filter((l) => l.busy || l.queue.length > 0)
        .map((l) => ({ key: l.key, busy: l.busy, queued: l.queue.length })),
      maxConcurrentLanes: cfg.maxConcurrentLanes,
      minSendIntervalMs: cfg.minSendIntervalMs,
      lastError,
      metrics,
      driver: cfg.driverStatus?.() ?? null,
    };
  }

  /** 挑一条「没在跑、有活」的通道，按**到达序**取最早的请求（跨通道公平）。 */
  function pickLane() {
    let best = null;
    for (const l of lanes.values()) {
      if (l.busy || l.queue.length === 0) continue;
      if (!best || l.queue[0].seq < best.queue[0].seq) best = l;
    }
    return best;
  }

  /**
   * 派发循环：每次最多把在途数推到 `maxConcurrentLanes`，且两次「发出」之间
   * 至少隔 `minSendIntervalMs`（错峰）。到点没到就排一个定时器等，不再空转。
   */
  function dispatch() {
    if (staggerTimer) return;
    for (;;) {
      if (active.size >= cfg.maxConcurrentLanes) return;
      if (lastSendAt > 0 && cfg.minSendIntervalMs > 0) {
        const wait = cfg.minSendIntervalMs - (Date.now() - lastSendAt);
        if (wait > 0) {
          staggerTimer = setTimeout(() => { staggerTimer = null; dispatch(); }, wait);
          staggerTimer.unref?.();
          return;
        }
      }
      const lane = pickLane();
      if (!lane) return;
      // 同意闸在**派发前**判（与旧实现同一位置）：没授权就拒绝并继续派下一个。
      if (cfg.requireConsent && !consent) {
        const rejected = lane.queue.shift();
        rejected?.clearQ?.();
        lastError = 'consent not granted — enable the bridge in the Web AI panel first';
        warn(lastError);
        rejected?.reject(new Error('webcode relay: ' + lastError));
        continue;
      }
      startItem(lane, lane.queue.shift());
    }
  }

  function release(lane) {
    lane.busy = false;
    dispatch();
  }

  function startItem(lane, item) {
    item.clearQ?.();
    const requestId = 'req-' + randomUUID();
    lane.busy = true;
    lastSendAt = Date.now();
    const entry = { item, seq: 0, text: '', timer: null, startedAt: performance.now(), firstDeltaAt: null, thinkingChars: 0, lane: lane.key };
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
      if (item.signal.aborted) { onCallerAbort(); release(lane); return; }
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
    log('dispatched', requestId, `(lane=${lane.key}, queued=${queuedTotal()}, active=${active.size})`);
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
        if (!e) { release(lane); return; }
        clearTimeout(e.timer);
        active.delete(requestId);
        release(lane);
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
          tokenBasis: '三类实测单价（CJK 0.75 / 散文 0.30 / 其余 0.70）+10% 余量；仅用于相对速度比较',
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
        if (!e) { release(lane); return; }
        clearTimeout(e.timer);
        active.delete(requestId);
        lastError = err?.message || String(err);
        release(lane);
        e.item.reject(err instanceof Error ? err : new Error(lastError));
      }
    );
  }

  function promptOf(item) { return item.prompt; }

  function submit(prompt, { signal, onDelta, onThink, onImage, meta } = {}) {
    return new Promise((resolve, reject) => {
      if (!cfg.executor) return reject(new Error('webcode relay: no executor configured'));
      const lane = laneOf(laneKeyOf(meta));
      // 上限是**全局**的（不是每通道 32）：网页是低吞吐后端，无论多少账号，
      // 积压总量都必须有界，否则「并发」会退化成把压力堆在内存里。
      if (queuedTotal() >= 32) {
        lastError = 'queue full (32) — the web page is a low-throughput backend';
        warn(lastError);
        return reject(new Error('webcode relay: ' + lastError));
      }
      const item = { prompt, resolve, reject, onDelta, onThink, onImage, signal, meta, seq: (seqCounter += 1), lane: lane.key, queuedAhead: lane.queue.length };
      // 同账号排队的队伍位置在入队那一刻就记下来，并逐条透出——用户要的
      // 「同账号排队并透出队列位置」不能只在日志里，读数必须能被界面读到。
      log(`queued ${item.seq} on lane ${lane.key} (ahead=${item.queuedAhead}, active=${active.size})`);
      const qTimer = setTimeout(() => {
        const i = lane.queue.indexOf(item);
        if (i >= 0) {
          lane.queue.splice(i, 1);
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
          const i = lane.queue.indexOf(item);
          if (i >= 0) {
            lane.queue.splice(i, 1);
            item.clearQ();
            reject(abortError());
          }
        };
        signal.addEventListener('abort', queuedAbort, { once: true });
      }
      lane.queue.push(item);
      dispatch();
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
    // 0.20.0 工作区画面流：lib/live.js 的 hub 借同一条 httpServer 做 WebSocket
    // upgrade（/webcode/live）。hub 自己做路径与回环 Origin 校验。
    if (cfg.onUpgrade) httpServer.on('upgrade', cfg.onUpgrade);
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
    if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null; }
    for (const lane of lanes.values()) {
      for (const item of lane.queue.splice(0)) {
        item.clearQ?.();
        item.reject(abortError('relay stopped'));
      }
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
