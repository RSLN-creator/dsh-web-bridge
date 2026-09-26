// upstream.js — 面向镜像的 HTTP 客户端（Node 原生，不依赖 undici/fetch 的全局限制）。
//
// 为什么不用全局 fetch：Node 内建的 fetch（undici）把响应头上限硬编码在
// http.maxHeaderSize（默认 16KB），且该值**运行时不可改**（实测：赋值后仍为
// 16384）。gemini.google.com 的响应头远超 16KB，于是 fetch 直接抛
// UND_ERR_HEADERS_OVERFLOW —— 镜像侧表现为 502「无法连接 gemini.google.com」，
// 而同一台机器用浏览器/curl 访问完全正常（真机证据 2026-09-13）。
//
// 这里用 node:http/https 自己发请求，maxHeaderSize 按请求可配（默认 1MB），
// 并对外暴露与 fetch Response 相同的消费面（status / headers / body.getReader()
// / arrayBuffer()），把 mirror.js 的改动面压到最小。
//
// 另外：**不做自动解压**会让「剥掉 content-encoding 却转发压缩字节」变成隐性
// 损坏。这里显式声明 identity；若上游仍压缩，则流式解压后再交给调用方
// （见 mirror.js 的 STRIP_RESPONSE 会移除 content-encoding/content-length）。

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { isPrivateHost } from './loopback.js';

const MAX_HEADER_BYTES = Number(process.env.WEBCODE_MAX_HEADER_BYTES) || 1 << 20; // 1MB
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 6;

/** 响应头包：保留多值语义（set-cookie 尤其重要），并提供 fetch 同形的读取面。 */
class HeaderBag {
  constructor(rawPairs) {
    this.map = new Map();
    this.setCookies = [];
    for (const [rawKey, value] of rawPairs) {
      const key = String(rawKey).toLowerCase();
      if (key === 'set-cookie') { this.setCookies.push(String(value)); continue; }
      this.map.set(key, this.map.has(key) ? this.map.get(key) + ', ' + value : String(value));
    }
  }
  get(key) { return this.map.get(String(key).toLowerCase()) ?? null; }
  has(key) { return this.map.has(String(key).toLowerCase()); }
  getSetCookie() { return this.setCookies; }
  *[Symbol.iterator]() { for (const [k, v] of this.map) yield [k, v]; }
  entries() { return this.map.entries(); }
}

function decompressorFor(encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return null;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  // zstd（真机 2026-09-13）：Cloudflare 在浏览器声明 zstd 时就用 zstd 回包
  //（claude.ai 实测 content-encoding: zstd）。旧实现不认这个编码 → 把压缩字节
  // 当明文转发，镜像页变成一屏二进制乱码。Node ≥22.15 才带 zstd 解压，故做
  // 特性探测；拿不到解压器时**必须报错**，不能静默转发压缩字节。
  if (enc === 'zstd' || enc === 'x-zstd') {
    if (typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress();
    const err = new Error('upstream sent zstd but this Node cannot decompress it');
    err.code = 'ZSTD_UNSUPPORTED';
    throw err;
  }
  const err = new Error('upstream sent unsupported content-encoding: ' + enc);
  err.code = 'ENCODING_UNSUPPORTED';
  throw err;
}

function makeResponse(res, nodeStream) {
  const headers = new HeaderBag(res.rawHeaders ? pairsOf(res.rawHeaders) : []);
  const status = res.statusCode || 0;
  let consumed = null;
  const readAll = async () => {
    if (consumed) return consumed;
    const chunks = [];
    for await (const c of nodeStream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    consumed = Buffer.concat(chunks);
    return consumed;
  };
  return {
    status,
    statusText: res.statusMessage || '',
    headers,
    ok: status >= 200 && status < 300,
    get body() { return nodeStream ? Readable.toWeb(nodeStream) : null; },
    arrayBuffer: async () => {
      const buf = await readAll();
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    text: async () => (await readAll()).toString('utf8'),
    // 内部用：直接拿 Node 流（调用方要自己管解压/转发）
    nodeStream,
  };
}

function pairsOf(rawHeaders) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

/**
 * 重定向落到内网/回环时的专用错误（见 `httpFetch` 里的重定向复查）。
 *
 * 为什么要一个**具名错误码**而不是普通的 `Error`：这条拒绝会被调用方当成网络失败
 * 捕获并降级成说明页，若与「连不上」混在一起，排查时无法区分「站点挂了」与
 * 「站点试图把我们重定向进内网」——后者是需要人看一眼的安全事件。
 *
 * @param {URL} parsed 被拒绝的那一跳的 URL
 */
function ssrfError(parsed) {
  const err = new Error('upstream redirect refused: redirect target is a private/loopback host ('
    + parsed.hostname + ')');
  err.code = 'SSRF_REDIRECT_BLOCKED';
  err.host = parsed.hostname;
  return err;
}

/**
 * 发一个 HTTP(S) 请求。参数与 fetch 的关键子集对齐：
 *   method / headers / body(Buffer|Uint8Array|string) / signal / redirect('follow'|'manual') / timeoutMs
 * 返回对象见 makeResponse（headers.getSetCookie() 保留全部 Set-Cookie）。
 */
export function httpFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = undefined,
    signal = undefined,
    redirect = 'follow',
    timeoutMs = 60_000,
    maxHeaderSize = MAX_HEADER_BYTES,
  } = options;

  // 起始目标是否**本来就在**内网/回环。它由最外层调用一次性决定，并沿重定向链传下去。
  // 抽到 attempt 之外算，是因为判定依据必须是「用户最初要访问哪儿」，不是「现在这一跳在哪」。
  let startedPrivate = false;
  try { startedPrivate = isPrivateHost(new URL(String(url)).hostname); } catch { startedPrivate = false; }

  const attempt = (target, redirectsLeft) => new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(target); } catch (err) { return reject(err); }

    // ---- 重定向不得把公网请求「升级」进内网（2026-09-26，CodeQL js/request-forgery）----
    //
    // 事实：本函数是通用 HTTP 客户端，URL 由调用方给出。调用方（mirror.js / web-control.js）
    // 的**入口**都已用 `isPrivateHost` 拦掉内网目标，但旧实现只在入口拦，重定向这里直接
    // `attempt(next, …)`——**没有复查**。于是「一个已配置的公网站点返回 302 → 169.254.169.254」
    // 这条链路上，入口的检查被绕过去了。这正是静态分析报「URL 依赖用户可控值」的真实一面。
    //
    // 修法刻意**只收窄升级方向**，不放宽也不误伤：
    //   · 起始目标本身就在内网/回环（本机开发、测试桩、`*.localhost` 镜像）⇒ 不额外拦。
    //     这类调用是**测试与本地调试的既有用法**：`test/mirror.test.mjs` 全部以
    //     `127.0.0.1` 起上游桩，拦掉会让它整片变红，而它不引入新的攻击面
    //     （起点本来就是本机，能访问的本就是本机能访问的）。
    //   · 起始目标是公网 ⇒ 任何一跳落到内网/回环，**拒绝**（抛错，不跟随）。
    //     这才是 SSRF 的真实形状：从「我能访问的公网」跳到「只有本机能访问的内网」。
    // 判定放在**每一跳**（本函数开头），因此 302→公网→302→内网 也会被拦住。
    if (!startedPrivate && isPrivateHost(parsed.hostname)) return reject(ssrfError(parsed));
    const mod = parsed.protocol === 'https:' ? https : http;

    const outHeaders = { ...headers };
    // 一律强制 identity，**覆盖**浏览器带来的 accept-encoding：
    //   1) 镜像会把上游响应原样交给 iframe，而 STRIP_RESPONSE 已移除
    //      content-encoding —— 转发压缩字节就是隐性损坏；
    //   2) 浏览器敢声明 zstd/br，不代表本进程能解；把「能不能解」变成
    //      「不用解」比补齐解压器更可靠（解压器仍保留为兜底，见下）。
    // 真机 2026-09-13：claude.ai 在 accept-encoding 含 zstd 时回 zstd，旧实现
    // 既不覆盖也不认 zstd，镜像页直接是一屏乱码。
    for (const k of Object.keys(outHeaders)) {
      if (k.toLowerCase() === 'accept-encoding') delete outHeaders[k];
    }
    outHeaders['accept-encoding'] = 'identity';
    const payload = body === undefined || body === null ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(body));

    const req = mod.request(parsed, {
      method,
      headers: outHeaders,
      maxHeaderSize,               // ← gemini 类超大响应头的正解
      signal,
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (redirect === 'follow' && REDIRECT_STATUS.has(status) && location && redirectsLeft > 0) {
        res.resume();   // 丢弃重定向响应体
        let next;
        try { next = new URL(location, target).toString(); } catch { next = null; }
        if (next) return resolve(attempt(next, redirectsLeft - 1));
      }
      const enc = res.headers['content-encoding'];
      let dec = null;
      try {
        dec = decompressorFor(enc);
      } catch (err) {
        // 不认识的编码（如本机 Node 无 zstd）：宁可明确失败也不转发压缩字节。
        // 转发出去的样子是「镜像页一屏二进制乱码」，比一个清楚的错误难查得多。
        try { res.destroy(); } catch {}
        return reject(err);
      }
      let stream = res;
      if (dec) {
        // 上游无视 identity 仍压缩：流式解压，并抹掉编码/长度头（调用方按明文转发）。
        res.on('error', (err) => dec.destroy(err));
        stream = res.pipe(dec);
        dec.on('error', (err) => { try { res.destroy(); } catch {} reject(err); });
      }
      resolve(makeResponse(res, stream));
    });

    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('upstream timeout after ' + timeoutMs + 'ms'));
    });
    if (payload) req.write(payload);
    req.end();
  });

  return attempt(String(url), MAX_REDIRECTS);
}