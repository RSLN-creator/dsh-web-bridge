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

/**
 * 「这个主机名指向本机/内网」的**唯一**判定实现（2026-09-26 从 mirror.js 上移）。
 *
 * 为什么必须只定义一次：本模块头部记过同一族事故——三处各写一份同义正则，
 * 只改一处就留下两个行为不同的边界。这条正则在 0.12.9 起住在 `mirror.js`
 * 里服务镜像代理的三个入口；0.19.26 起 `upstream.js` 的**重定向**路径也要用它
 * （见那里的说明），若各留一份，就会出现「入口拦住了、重定向没拦住」——
 * 那正是这次要修的那个洞。
 *
 * ## 判定分两段，**只加不减**
 *
 * 第一段是 0.12.9 起的**字面量前缀**判据（原样保留）。它的语义刻意保守：
 * `127.` / `10.` 这类前缀不看结尾，因此 `127.evil.com`、`10.example.com`
 * 也会被判成内网。这不是缺陷：这些名字本就不该出现在站点资源表里，
 * 多拦一个的代价是一次可解释的 404，少拦一个的代价是 SSRF。
 * **保留它而不是换成严格的点分四段判定**，是按本仓库「只收窄、绝不放宽」的纪律：
 * 换掉会让 `127.evil.com` 这类**原先被拦**的名字变成放行——那是放宽。
 *
 * 第二段是 0.19.26 新增的补齐，覆盖第一段漏掉的**规格化形态**（探针实测）：
 *   · `0.0.0.0` / `0.` ——「本机/未指定」地址。旧判据零命中，而它是真实可连的目标；
 *   · `[::]` —— IPv6 未指定地址（等价于 `0.0.0.0`）。旧判据只认 `[::1]`；
 *   · `[fe80::/10]` 链路本地、`[fec0::/10]` 站点本地、`[fc00::/7]` 唯一本地；
 *   · `[::ffff:a.b.c.d]` IPv4 映射 —— 必须**解码后**再判，否则 `[::ffff:127.0.0.1]`
 *     会绕过全部 IPv4 判据（Node 的 URL 把它规格化成 `[::ffff:7f00:1]`，实测）。
 *
 * ## 已知边界（不假装它拦得住）
 *
 * 判据只看**主机名字面**，因此挡不住「公网域名解析到 127.0.0.1」这一类
 * （如 `localtest.me` 实测解析到 `127.0.0.1`）。那要靠在连接前解析并复查 IP，
 * 属另一层；本函数的定位是「拦掉字面就写着内网的形态」。真正的兜底是桥
 * **只监听回环**（`lib/index.js`）与各入口的 `loopbackOnly` 守卫。
 *
 * @param {string} host 主机名（可含方括号的 IPv6 字面量，不含端口）
 */
export function isPrivateHost(host) {
  const h = String(host || '');
  if (!h) return false;
  // 第一段：0.12.9 起的原判据（逐字未改，见上方说明）。
  if (/^(?:localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\]$|.*\.local$)/i.test(h)) return true;
  // 第二段：0.19.26 补齐（IPv4 未指定 / IPv6 内网族 / IPv4 映射）。
  if (/^0\./.test(h)) return true;
  if (/^\[(?:::1|::|fe80:|fec0:|f[cd][0-9a-f]{2}:)/i.test(h)) return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(h);
  if (mapped) return isPrivateHost(hexQuadToIpv4(mapped[1], mapped[2]));
  return false;
}

/**
 * `[::ffff:H1:H2]` 的两个十六进制组 → 点分四段 IPv4。
 *
 * 为什么需要它：Node 的 `new URL('http://[::ffff:127.0.0.1]/')` 会把主机名规格化成
 * `[::ffff:7f00:1]`（实测），于是「照着 IPv4 写内网地址」在这里变成十六进制，
 * 字面比对全部落空。解码回 IPv4 后再交给同一个 `isPrivateHost`，
 * 判定规则仍然只有一份。
 *
 * @param {string} hi 高 16 位的十六进制串
 * @param {string} lo 低 16 位的十六进制串
 */
function hexQuadToIpv4(hi, lo) {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff].join('.');
}

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