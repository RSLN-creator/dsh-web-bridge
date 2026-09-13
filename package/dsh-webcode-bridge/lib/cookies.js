// cookies.js — Set-Cookie 的两个消费方向，各自按 RFC 6265 解析。
//
// 为什么单独抽一个纯模块（2026-09-14，豆包「登录后右侧打开网页会掉登录」取证）：
// 上游回的 Set-Cookie 有两个完全不同的去处，旧实现把它们混成两段字符串替换：
//   • 回写给 GUI 浏览器：mirror 把上游响应转给右栏 iframe 所在的
//     `http://<site>.localhost:<port>`（mirror.js 的 rewriteCookie）；
//   • 写回给驱动 profile：mirror 顺手把同一批 header 交给
//     driver.writeProfileCookies()，落到 playwright 的 cookie jar。
// 字符串替换做不到「判断这枚 cookie 是不是删除」，也保不住浏览器强制的
// `__Secure-` / `__Host-` 前缀契约，于是两个方向同时出错：
//   1. 删除（`name=; Max-Age=0`）被当成「把值设成空串」。空串没有过期时间，
//      于是**把 profile 里那枚有效 cookie 就地抹成空值**——下一轮真实发送就是
//      未登录。站点在 iframe 里刷新一次会话、回一枚清空 cookie，桥照单写回，
//      用户看到的就是「打开右侧网页之后掉登录」。
//   2. `__Secure-` 前缀 cookie 必须带 `Secure`，剥掉之后浏览器按前缀规则
//      **直接丢弃**；playwright 侧同样要求 `secure: true`，否则 addCookies 抛错，
//      整批一枚都写不进去。
// 抽成纯函数之后，两个方向各自可离线断言（test/cookies.test.mjs）。
//
// 契约：本模块不碰网络、不碰浏览器、不读全局状态；同名属性按「最后一次出现者胜」
// 解析（RFC 6265 §5.3 对重复属性的处理）。

/** 已知的 SameSite 取值（大小写不敏感），归一成浏览器与 playwright 都认的写法。 */
const SAME_SITE = Object.freeze({ strict: 'Strict', lax: 'Lax', none: 'None' });

/** `__Secure-` / `__Host-` 前缀的 cookie 名——浏览器对它们有强制校验。 */
const SECURE_PREFIX = /^__(Secure|Host)-/i;
const HOST_PREFIX = /^__Host-/i;

/**
 * 解析一条 Set-Cookie 头。
 * @param {string} raw 上游给的 Set-Cookie 头值（不含 header 名）。
 * @returns {{name:string,value:string,domain:string|null,path:string|null,secure:boolean,httpOnly:boolean,sameSite:string|null,maxAge:number|null,expires:number|null}|null}
 *   null = 这条头不是合法的 `name=value`（空 name、缺 `=`）。
 */
export function parseSetCookie(raw) {
  const text = String(raw == null ? '' : raw);
  const end = text.indexOf(';');
  const pair = end < 0 ? text : text.slice(0, end);
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  const out = {
    name,
    value: pair.slice(eq + 1).trim(),
    domain: null,
    path: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    maxAge: null,
    expires: null,
  };
  for (const part of (end < 0 ? '' : text.slice(end + 1)).split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf('=');
    const key = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : seg.slice(i + 1).trim();
    if (key === 'domain') {
      // RFC 6265 §4.1.2.3：前导点被忽略，域大小写不敏感。
      const d = val.replace(/^\./, '').toLowerCase();
      if (d) out.domain = d;
    } else if (key === 'path') {
      if (val) out.path = val;
    } else if (key === 'secure') {
      out.secure = true;
    } else if (key === 'httponly') {
      out.httpOnly = true;
    } else if (key === 'samesite') {
      const s = SAME_SITE[val.toLowerCase()];
      if (s) out.sameSite = s;
    } else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) out.maxAge = Math.trunc(n);
    } else if (key === 'expires') {
      const t = Date.parse(val);
      if (Number.isFinite(t)) out.expires = t;
    }
    // 其余属性（Priority / Partitioned / 未知扩展）对本桥无意义，丢弃。
  }
  return out;
}

/**
 * 这枚 cookie 是不是一条**删除**指令。
 *
 * 区分「删除」与「设置」是本次修复的核心：旧实现把两者都当成设置，于是
 * `name=; Max-Age=0` 会以空值重新写入，把有效登录态就地抹掉。
 *
 * @param {ReturnType<typeof parseSetCookie>} cookie
 * @param {number} [now] 判定 Expires 是否已过的时刻（显式传入便于单测钉死）
 * @returns {boolean}
 */
export function isDeletion(cookie, now = Date.now()) {
  if (!cookie) return false;
  if (cookie.maxAge != null) return cookie.maxAge <= 0;
  if (cookie.expires != null) return cookie.expires <= now;
  return false;
}

/**
 * 把上游的 Set-Cookie 改写成**给右栏 iframe 的那个源**用的形态。
 *
 * 右栏 iframe 住在 `http://<site>.localhost:<port>`，与上游不同域，因此：
 *   • `Domain` 必须去掉（留在里面浏览器整枚丢弃）——落成 host-only；
 *   • `Secure` **不能**为了「这是 http」而剥掉：`*.localhost` 在 Chromium 里是
 *     potentially-trustworthy origin，Secure cookie 照常收下；而 `__Secure-` /
 *     `__Host-` 前缀缺了 Secure 会被按前缀规则直接丢弃——登录态就是这么「掉」的。
 *   • `SameSite=None` 收敛成 `Lax`：iframe 内部所有请求都同源，Lax 足够，
 *     且避免「None 缺 Secure」这种必然被拒的组合。
 *   • `__Host-` 前缀额外要求 `Path=/` 且无 Domain —— Domain 已去，Path 补齐。
 *   • `Max-Age` / `Expires` 原样保留，删除指令才会真的删掉。
 *
 * @param {string} raw
 * @returns {string} 可直接作为 Set-Cookie 回给浏览器的字符串
 */
export function rewriteSetCookieForMirror(raw) {
  const c = parseSetCookie(raw);
  if (!c) return String(raw == null ? '' : raw);
  const parts = [c.name + '=' + c.value];
  if (c.expires != null) parts.push('Expires=' + new Date(c.expires).toUTCString());
  if (c.maxAge != null) parts.push('Max-Age=' + c.maxAge);
  const path = HOST_PREFIX.test(c.name) ? '/' : c.path;
  if (path) parts.push('Path=' + path);
  if (c.secure || SECURE_PREFIX.test(c.name)) parts.push('Secure');
  if (c.httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=' + (c.sameSite === 'Strict' ? 'Strict' : 'Lax'));
  return parts.join('; ');
}

/**
 * 把上游的 Set-Cookie 改写成 playwright 的 `addCookies` 条目。
 *
 * 与镜像方向的差别只有一处：这里写的是**驱动自己的 cookie jar**（真实上游域，
 * 没有跨域问题），所以 Domain 保留、Path 保留；删除指令翻译成 `expires: 0`，
 * 而不是写一个空值。
 *
 * @param {string} raw
 * @param {string} originUrl 写回时归属的源（`https://www.doubao.com`）
 * @param {number} [now] 计算 Max-Age 基准与删除判定的时刻
 * @returns {{name:string,value:string,domain?:string,path?:string,url?:string,secure:boolean,httpOnly:boolean,sameSite:string,expires?:number}|null}
 */
export function toPlaywrightCookie(raw, originUrl, now = Date.now()) {
  const c = parseSetCookie(raw);
  if (!c) return null;
  const cookie = {
    name: c.name,
    value: c.value,
    secure: c.secure || SECURE_PREFIX.test(c.name),
    httpOnly: c.httpOnly,
    // playwright 只认这三个字面量；缺省给 Lax（与浏览器缺省一致，且不会
    // 因为「None 但没有 secure」被 Chrome 拒绝）。
    sameSite: c.sameSite || 'Lax',
  };
  const host = (() => { try { return new URL(String(originUrl)).hostname; } catch { return null; } })();
  const domain = c.domain || host;
  if (domain) {
    cookie.domain = domain;
    cookie.path = c.path || '/';
  } else {
    // 连源都解析不出来时退回 url 形态，至少不让 playwright 抛「缺 url/domain」。
    cookie.url = String(originUrl);
  }
  if (isDeletion(c, now)) cookie.expires = 0;                              // 0 = 立即过期
  else if (c.maxAge != null) cookie.expires = Math.floor(now / 1000) + c.maxAge;
  else if (c.expires != null) cookie.expires = Math.floor(c.expires / 1000);
  return cookie;
}

/**
 * 合并「驱动 profile 的 cookie」与「浏览器这次带上的 cookie」，产出真正发给
 * 上游的 Cookie 头。
 *
 * 旧实现是二选一：请求带 cookie 就**只用**请求里的，否则才回退 profile。
 * 于是只要右栏 iframe 在 `<site>.localhost` 上存过哪怕一枚 cookie（站点在
 * iframe 里自己 set 的、或上一次会话残留的），驱动 profile 里那份**权威登录
 * 态就永远不再参与上游请求**——用户看到的就是「右栏打开一次，登录就掉了」。
 *
 * 现在按「profile 优先、请求补缺」合并：同名以 profile 为准（profile 才是
 * 真机登录的那一份），请求里独有的 cookie 追加进去（站点在 iframe 里刚下的
 * 那些仍然有效）。
 *
 * @param {Array<{name:string,value:string}>} profileCookies
 * @param {string} requestCookieHeader
 * @returns {string} 可直接放进 Cookie 头的字符串；空串表示不带 cookie
 */
export function mergeCookieHeaders(profileCookies, requestCookieHeader) {
  const merged = new Map();
  for (const part of String(requestCookieHeader || '').split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    if (name) merged.set(name, seg.slice(eq + 1).trim());
  }
  for (const c of Array.isArray(profileCookies) ? profileCookies : []) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    merged.set(name, String(c?.value ?? ''));
  }
  return [...merged].map(([k, v]) => k + '=' + v).join('; ');
}
