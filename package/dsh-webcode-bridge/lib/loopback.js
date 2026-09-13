// loopback.js — 「这个 Host 是不是本机回环」的唯一判定实现。
//
// 为什么单独成文件：桥曾有三处各写一份同义正则（mirror.js 的 loopbackOnly、
// web-control.js 与 openai.js 的 csrfSafe）。0.12.9 引入 `<siteId>.localhost`
// 子域挂载后，只改一处的后果是真机实锤的：
//   http://zai.localhost:8931/__webcode/status → 403 cross-site control requests
// 子域是站点在右栏里的**正式挂载形态**（见 providers.js / index.js 的说明），
// 所以判定规则必须只定义一次，三处共用。
//
// 安全边界（没有放宽）：
//   • 只接受 IP 回环（127.0.0.1 / [::1]）与 localhost 名称族。
//   • `*.localhost` 由 RFC 6761 保留给回环，浏览器与 Windows 都直接解析到
//     127.0.0.1 —— 公网无法把一个域名解析到**别人的**本机回环，因此这一族
//     与 `localhost` 等价，不会引入 DNS 重绑定面。
//   • 端口不参与判定（桥自己有固定端口；判定靠 Host 名称族，不靠端口）。

const IP_LOOPBACK = /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const NAME_LOOPBACK = /^(?:[a-z0-9-]+\.)*localhost(?::\d+)?$/i;

/** Host 头（可带端口）是否落在回环名称族内。 */
export function isLoopbackHost(host) {
  const h = String(host || '');
  if (!h) return false;
  return IP_LOOPBACK.test(h) || NAME_LOOPBACK.test(h);
}

/**
 * Origin 是否与请求 Host 同源（scheme 由调用方自行判定）。
 * 用于 csrfSafe：「同源请求」永远安全；跨源只认显式白名单。
 * 注意这里比较的是 host（含端口）——别的回环端口是**另一个应用**，不是「我们」。
 */
export function originMatchesHost(origin, hostHeader) {
  try {
    const o = new URL(String(origin));
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    return o.host === String(hostHeader || '');
  } catch {
    return false;
  }
}