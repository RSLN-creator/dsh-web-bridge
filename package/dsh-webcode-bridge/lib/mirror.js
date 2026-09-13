// mirror.js - serve the real DeepSeek web app inside the right sidebar.
// The upstream is fixed at siteOrigin; this is a same-origin relay, not an
// open proxy. The page token is injected only into the relay origin's storage.

import { httpFetch } from './upstream.js';
import { isLoopbackHost } from './loopback.js';
import { rewriteSetCookieForMirror, mergeCookieHeaders } from './cookies.js';

export function createMirror(options = {}) {
  const {
    siteOrigin = 'https://chat.deepseek.com',
    getToken = async () => null,
    logger = console,
    // 站点静态资源域（providers.js 的 staticOrigins）与本站点在镜像中的挂载
    // 前缀；两者一起决定 HTML/CSS 里绝对资源 URL 如何改写成同源路径。
    assetOrigins = [],
    mountPrefix = '',
    // 有些站点的前端 router 只认根路径（见 providers.js 的 z.ai 说明）。
    // 打开后注入脚本会在页面脚本之前把 pathname 改写成 '/'——站点看到的就是
    // 根路径；资源/接口仍走镜像前缀（静态标签已改写，运行时根相对请求由
    // bootstrap 的 toLocal 钩子补前缀）。GLM 等站点不需要，保持默认关闭。
    rootPathForSpa = false,
    getCookies = null,
    setCookies = null,
    getUserAgent = null,
  } = options;
  const upstreamOrigin = new URL(siteOrigin).origin.replace(/\/$/, '');
  const upstreamHost = new URL(upstreamOrigin).host;
  const log = (...args) => logger.log?.('[webcode-mirror]', ...args);
  const warn = (...args) => logger.warn?.('[webcode-mirror]', ...args);

  const LOCAL_PREFIXES = ['/v1/', '/bridge/', '/webcode/', '/__webcode/'];
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  ]);
  const STRIP_RESPONSE = new Set([
    'content-security-policy', 'content-security-policy-report-only',
    'x-frame-options', 'cross-origin-embedder-policy',
    'cross-origin-embedder-policy-report-only', 'clear-site-data',
    'content-length', 'content-encoding',
  ]);

  const isLocal = (pathname) => LOCAL_PREFIXES.some((prefix) =>
    pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));

  // ---- 静态资源同源转发 ------------------------------------------------
  // 站点 HTML 用绝对 URL + crossorigin 引入脚本/样式（DeepSeek 的
  // fe-static.deepseek.com、qwen 的 assets.alicdn.com、GLM 的 at/o.alicdn.com…），
  // 浏览器因此以 CORS 模式请求；而不少域返回的 Access-Control-Allow-Origin 是
  // 字面量通配（非法值），脚本被硬性拒绝，页面退化成空白/「资源加载异常」。
  // 因此**标签属性语境里的一切绝对资源 URL 一律改写**到镜像自己的
  // <mountPrefix>/__static/<host>/<path> 同源转发——不再维护逐站白名单
  // （白名单模式在 qwen/glm/kimi 上反复漏域，正是多站点 tab 空白的根因）。
  // 只有标签属性与 CSS url() 会被改写；行内 JS 字符串里的接口地址不动，
  // 运行时 fetch/XHR 仍由 bootstrap 按 ASSETS 清单（providers.js staticOrigins）
  // 改写。内网/回环主机拒绝代理，防本机 SSRF。
  const STATIC_SEG = '/__static/';
  const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|.*\.local$)/i;

  /** 绝对资源 URL → 同源镜像路径；本站绝对地址收敛进 mountPrefix，内网原样返回。 */
  function toProxyUrl(u) {
    try {
      const url = new URL(String(u), upstreamOrigin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return u;
      const tail = url.pathname + url.search + url.hash;
      if (url.host === upstreamHost) return mountPrefix + tail;
      if (PRIVATE_HOST.test(url.hostname)) return u;
      return mountPrefix + STATIC_SEG + url.host + tail;
    } catch { return u; }
  }

  /** 标签属性语境里的资源引用 → 同源镜像路径。
   *
   *  三种形态都要处理（真机证据 2026-09-13）：
   *    1. 绝对 `https://host/path` —— 原本就支持；
   *    2. 协议相对 `//host/path`（GLM 的 `//at.alicdn.com/...`、z.ai 的
   *       `//o.alicdn.com/...`、qwen 的 logo）—— 浏览器按镜像源（回环）解析，
   *       直接 404；
   *    3. **根相对 `/path`**（GLM 的 webpack 产物 `/runtime.*.js` `/libs.*.js`
   *       `/main.*.js`、z.ai 运行时的 `/api/config`）—— 浏览器解析成
   *       `http://127.0.0.1:8931/path`，而那是**默认站点（DeepSeek）镜像的根**：
   *       这些请求会拿到 DeepSeek 的 HTML（200 + text/html），脚本因严格 MIME
   *       校验被拒、JSON 解析炸掉 —— 这正是「DeepSeek 右栏能开、GLM/z.ai 空白」
   *       的根因。它们属于本站点，必须改写成 mountPrefix + path。
   *  注意 `<base>` 解决不了这个问题：以 `/` 开头的 URL 永远相对 origin 解析。 */
  function toProxyAny(u) {
    if (typeof u !== 'string' || !u) return u;
    if (u.charAt(0) === '/') {
      if (u.charAt(1) === '/') return toProxyUrl('https:' + u);   // 协议相对
      if (u.charAt(1) !== '/') return mountPrefix + u;            // 根相对（本站）
    }
    return toProxyUrl(u);
  }

  /** 路径已经是镜像自己的（mountPrefix / __static / 桥的本地前缀）时不要重复加前缀。
   *  否则一次改写过的 `/__webcode/site/glm/__static/...` 会被二次拼成
   *  `/__webcode/site/glm/__webcode/site/glm/__static/...`。 */
  function alreadyLocal(p) {
    if (mountPrefix && p.startsWith(mountPrefix + '/')) return true;
    if (p.startsWith(STATIC_SEG)) return true;
    return LOCAL_PREFIXES.some((prefix) => p.startsWith(prefix));
  }

  function rewriteProxyAttr(_m, attr, quote, url) {
    return attr + quote + toProxyAny(url) + quote;
  }

  /** 把标签属性语境（src/href/poster/srcset）与 CSS url() 里的资源 URL 改写成同源路径。 */
  function rewriteAssetUrls(text) {
    let out = String(text)
      .replace(/(\s(?:src|href|poster)\s*=\s*)(["']?)((?:https?:)?\/\/[^"'\s>]+)\2/gi, rewriteProxyAttr)
      .replace(/url\(\s*(["']?)((?:https?:)?\/\/[^)'"\s]+)\1\s*\)/gi, (_m, q, u) => 'url(' + q + toProxyAny(u) + q + ')');
    // srcset 值是「URL 描述符, URL 描述符」列表，逐段处理
    out = out.replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi, (_m, attr, quote, value) =>
      attr + quote + value.split(',').map((part) => {
        const t = part.trim();
        if (!/^(?:https?:)?\/\//i.test(t)) return part;
        const sp = t.indexOf(' ');
        return sp < 0 ? toProxyAny(t) : toProxyAny(t.slice(0, sp)) + t.slice(sp);
      }).join(', ') + quote);
    // 根相对资源（/main.*.js、/api/config…）：单列一遍，因为上面的正则只吃
    // 「//」开头的形态。已是镜像路径的（__static / mountPrefix / 桥本地前缀）
    // 原样保留，避免二次加前缀。mountPrefix 为空（relay 根上的默认站点）时
    // 无需改写——那时 /path 本来就落在正确的地方。
    if (mountPrefix) {
      const rootRel = /(\s(?:src|href|poster)\s*=\s*)(["'])(\/(?!\/)[^"'\s>]*)\2/gi;
      out = out.replace(rootRel, (_m, attr, quote, path) =>
        attr + quote + (alreadyLocal(path) ? path : mountPrefix + path) + quote);
    }
    return out;
  }

  /** 把 /__static/<host>/<path> 代理回 https://<host><path>。 */
  async function proxyAsset(req, res, origin, assetPath, search) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower.startsWith('sec-fetch-') ||
          lower === 'origin' || lower === 'referer' ||
          lower.startsWith('access-control-')) continue;
      headers[key] = value;
    }
    headers.referer = origin + '/';

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const result = await readRequestBody(req);
      if (result.tooLarge) {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'mirror: request body too large' } }));
        return true;
      }
      body = result.body;
      if (body.length) headers['content-length'] = String(body.length);
    }

    let upstream;
    try {
      upstream = await httpFetch(origin + assetPath + search, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'follow',
        timeoutMs: 60_000,
      });
    } catch (error) {
      warn('asset upstream failed:', assetPath, error?.message);
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: 'mirror: asset upstream unreachable' } }));
      return true;
    }

    const out = {};
    for (const [key, value] of upstream.headers) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE.has(lower) ||
          lower === 'set-cookie' || lower.startsWith('access-control-')) continue;
      out[key] = value;
    }
    out['x-webcode-mirror'] = '1';

    const contentType = String(out['content-type'] || '');
    if (contentType.includes('text/css')) {
      const css = rewriteAssetUrls(Buffer.from(await upstream.arrayBuffer()).toString('utf8'));
      out['content-length'] = String(Buffer.byteLength(css));
      res.writeHead(upstream.status, out);
      res.end(css);
      return true;
    }

    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) { res.end(); return true; }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client disconnected */ }
    try { res.end(); } catch {}
    return true;
  }


  // 回环主机白名单：127.0.0.1 / [::1] / localhost，以及 **<site>.localhost 子域**。
  // 子域方案是本插件多站点挂载的正式形态：每个站点挂在
  // http://<siteId>.localhost:<port>/ 上，站点看到的 pathname 与它自己的真实
  // 站点完全一致（doubao 的 /chat/、z.ai 的 /auth …），SPA router 基线不再
  // 错位；同时 Host 头唯一确定镜像实例，不会互相串站。
  // 浏览器与 Windows 都把 *.localhost 解析到回环，因此这仍然是 loopback-only，
  // 没有扩大暴露面（公网无法把一个名字解析到本机 127.0.0.1）。
  //
  // 判定实现统一在 lib/loopback.js：本文件、web-control.js、openai.js 三处
  // 曾各写一份同义正则，0.12.9 加子域时漏改控制面 → 真机实锤
  // `zai.localhost:8931/__webcode/status` 被 403。规则从此只定义一次。
  function loopbackOnly(req, res) {
    if (isLoopbackHost(req.headers.host)) return true;
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message: 'mirror: loopback only' } }));
    return false;
  }

  function rewriteLocation(value) {
    try {
      const url = new URL(value, upstreamOrigin);
      if (url.host !== upstreamHost) return value;
      // 站内重定向必须留在镜像自己的命名空间里：豆包根路径回 302 → /chat/，
      // 直接回写 /chat/ 会被浏览器解析成「镜像的 /chat/」，而镜像只在
      // <mountPrefix>/ 下服务 → 右栏渲染出一张没有页面内容的壳（预览"打不开"）。
      // 统一改写成 mountPrefix + pathname，让 iframe 继续走代理。
      const path = url.pathname + url.search + url.hash;
      if (isLocal(url.pathname)) return path;      // 桥自己的路由，原样
      return mountPrefix + path;
    } catch {
      return value;
    }
  }

  /** 同源请求的常规浏览器指纹头。
   *  代理到 CloudFront 这类 CDN 时，请求既没有 sec-fetch-* 也没有 UA（Node fetch
   *  默认 UA 是 undici），会被直接判成机器人返回 403
   *  「Request blocked」，右栏于是显示一张 403 错误页——这就是「预览网页打不开」
   *  在 DeepSeek 上的真因。补上桌面 UA；sec-fetch-* 由浏览器自己带着（客户端同源
   *  请求会发），这里只在缺失时补默认值，绝不覆盖真实值。 */
  const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
  function browserFingerprintHeaders(headers, origin) {
    const has = (k) => Object.keys(headers).some((h) => h.toLowerCase() === k);
    if (!has('user-agent')) headers['user-agent'] = DEFAULT_UA;
    if (!has('accept')) headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    if (!has('accept-language')) headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    if (!has('sec-fetch-mode')) headers['sec-fetch-mode'] = 'navigate';
    if (!has('sec-fetch-dest')) headers['sec-fetch-dest'] = 'document';
    if (!has('sec-fetch-site')) headers['sec-fetch-site'] = 'same-origin';
    if (!has('sec-fetch-user')) headers['sec-fetch-user'] = '?1';
    headers.referer = origin + '/';
    return headers;
  }

  /**
   * 上游 Set-Cookie → 右栏 iframe 那个源（`http://<site>.localhost:<port>`）。
   *
   * 实现搬到 cookies.js（纯函数，可离线断言）。旧实现是三段字符串替换，在两种
   * 真实情形下会把登录态弄丢——见 cookies.js 顶部的取证说明与
   * test/cookies.test.mjs 的回归用例。
   */
  function rewriteCookie(value) {
    return rewriteSetCookieForMirror(value);
  }

  function bootstrap(token) {
    const tokenLiteral = token
      ? JSON.stringify(JSON.stringify({ value: token, __version: '0' })).replace(/</g, '\\u003c')
      : 'null';
    const originLiteral = JSON.stringify(upstreamOrigin);
    // 资产域清单注入页面：静态标签已由 rewriteAssetUrls 改写，但脚本运行时
    // 仍会按绝对地址发 XHR/fetch（埋点上报等）——一并改写到同源，避免
    // 跨域被拒后在控制台刷一片 CORS 错误。
    const assetHostsLiteral = JSON.stringify(assetOrigins.map((o) => { try { return new URL(String(o)).host; } catch { return ''; } }).filter(Boolean));
    // 必须在站点脚本之前执行：只改地址栏里的路径，不触发加载。
    const rootPathFix = rootPathForSpa
      ? '<script data-webcode-rootpath>try{if(location.pathname!==\'/\')history.replaceState(null,\'\',\'/\');}catch(e){}</script>\n'
      : '';
    return rootPathFix + `<script data-webcode-mirror>(function(){
	try{if(${tokenLiteral}!==null)localStorage.setItem('userToken',${tokenLiteral});}catch(e){}
	try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error('mirror: service worker disabled'));};}catch(e){}
	var UP=${originLiteral};
	// 只存 host：匹配与拼接都用纯字符串，避免正则转义在模板里失真。
	var ASSETS=${assetHostsLiteral};
	var MP=${JSON.stringify(mountPrefix + STATIC_SEG)};
	var ROOT=${JSON.stringify(mountPrefix)};
	// 资源地址 → 同源镜像路径；null 表示无需改写。
	// 已经是镜像路径的（mountPrefix / __static / 桥的本地前缀）原样返回，
	// 否则第二次经过 toLocal 会被拼成 /__webcode/site/glm/__webcode/site/glm/…
	function isLocalPath(p){
	  if(ROOT&&p.indexOf(ROOT+'/')===0)return true;
	  if(p.indexOf('/__static/')===0)return true;
	  return p.indexOf('/v1/')===0||p.indexOf('/bridge/')===0||p.indexOf('/webcode/')===0||p.indexOf('/__webcode/')===0;
	}
	function toLocal(u){
	  if(typeof u!=='string'||!u)return null;
	  // 根相对 /x：本站资源，但要加上镜像前缀，否则会落到回环根
	  // （= 默认 DeepSeek 镜像的根）——真机 GLM 的 /runtime.*.js 就是这么被
	  // 换成一张 text/html 的，脚本因严格 MIME 校验拒绝执行、页面永远空白。
	  if(u.charAt(0)==='/'){
	    if(u.charAt(1)==='/'){return toLocal('https:'+u);}
	    if(u.charAt(1)!=='/')return isLocalPath(u)?u:(ROOT+u);
	  }
	  if(u.indexOf(UP)===0)return u.slice(UP.length)||'/';
	  if(u.indexOf('https://')!==0&&u.indexOf('http://')!==0)return null;
	  var rest=u.slice(u.indexOf('://')+3);
	  var cut=rest.indexOf('/');
	  var host=cut<0?rest:rest.slice(0,cut);
	  for(var i=0;i<ASSETS.length;i++){
	    if(ASSETS[i]===host)return MP+host+(cut<0?'/':rest.slice(cut));
	  }
	  return null;
	}
	var fetch0=window.fetch;
	if(fetch0)window.fetch=function(input,init){try{
	if(typeof input==='string'){var m0=toLocal(input);if(m0!==null)input=m0;}
	else if(input&&typeof input.url==='string'){var m1=toLocal(input.url);if(m1!==null)input=new Request(m1,input);}
	}catch(e){}return fetch0.call(this,input,init);};
	var open0=XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open=function(method,url){try{var m2=toLocal(url);if(m2!==null)url=m2;}catch(e){}return open0.apply(this,arguments);};
	// 动态创建的脚本/样式/图片（webpack 的懒加载 chunk 走这条路：d.p="/" 之后
	// 拼出 "/<chunk>.js" 再赋给 script.src）。这一步不补，首屏静态标签修好了、
	// 后面的按需 chunk 仍会打到回环根拿到 DeepSeek 的 HTML。
	var ce0=document.createElement.bind(document);
	function fixProp(el,prop){
	  try{
	    var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),prop);
	    if(!d||!d.set||!d.get)return;
	    Object.defineProperty(el,prop,{configurable:true,enumerable:true,
	      get:function(){return d.get.call(this);},
	      set:function(v){var m=toLocal(v);try{d.set.call(this,m===null?v:m);}catch(e){try{d.set.call(this,v);}catch(e2){}}}});
	  }catch(e){}
	}
	document.createElement=function(tag,opt){
	  var el=ce0(tag,opt);
	  try{
	    var t=String(tag||'').toLowerCase();
	    if(t==='script'||t==='img'||t==='iframe'||t==='source')fixProp(el,'src');
	    else if(t==='link'||t==='a')fixProp(el,'href');
	  }catch(e){}
	  return el;
	};
	var sa0=Element.prototype.setAttribute;
	Element.prototype.setAttribute=function(name,value){
	  try{
	    var n=String(name||'').toLowerCase();
	    if(n==='src'||n==='href'||n==='poster'){var m=toLocal(value);if(m!==null)value=m;}
	  }catch(e){}
	  return sa0.call(this,name,value);
	};
})();</script>
<style data-webcode-singlecol>
/* 侧栏单栏化：站点自带的双栏布局在窄面板里很挤——隐藏左侧导航列，
   需要时从左缘右滑呼出（overlay 抽屉，不动站点自身逻辑）。选择器按
   「导航列特征」而不是站点版本号 class（改版频繁，特征更稳）。 */
.hwb-nav-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.32);opacity:0;pointer-events:none;transition:opacity .18s;z-index:2147483000}
.hwb-nav-backdrop.show{opacity:1;pointer-events:auto}
.hwb-nav-rail{position:fixed;left:-44px;top:0;bottom:0;width:44px;display:flex;align-items:center;justify-content:center;
  background:var(--ds-bg,#fff);border-right:1px solid #8883;cursor:pointer;z-index:2147483001;
  color:var(--ds-text,#555);font-size:11px;writing-mode:vertical-rl;letter-spacing:2px;
  box-shadow:2px 0 10px rgba(0,0,0,.12);user-select:none;opacity:0;transition:opacity .18s,left .18s}
.hwb-nav-rail.show{opacity:1;left:0}
.hwb-nav-rail:hover{background:#8881}
</style>
<script data-webcode-singlecol>(function(){
	if(window.__webcodeSingleCol)return;window.__webcodeSingleCol=1;
	// 左侧导航列探测：宽高比像侧栏（高≥视口 70%、宽 ≤ 320px、无输入框）
	// 的最左可见 flex/grid 子元素；找不到就不动布局（宁可不改也别改坏）。
	function findNavColumn(){
		var vw=window.innerWidth;
		var cands=[].slice.call(document.body.children).filter(function(el){
			var r=el.getBoundingClientRect();
			return r.width>0&&r.height>=window.innerHeight*0.7&&r.left<vw*0.42&&r.right<=vw*0.45+320;
		});
		// 常见形态：主容器是 flex 行、第一个子元素是窄列
		for(var i=0;i<cands.length;i++){
			var el=cands[i],r=el.getBoundingClientRect();
			if(r.width>0&&r.width<=320&&r.right<=vw*0.45+1){
				if(el.querySelector('textarea'))continue;
				return el;
			}
			var kids=[].slice.call(el.children).filter(function(k){var kr=k.getBoundingClientRect();return kr.width>0;});
			if(kids.length>=2){
				var first=kids[0].getBoundingClientRect(),second=kids[1].getBoundingClientRect();
				if(second.left>first.right&&first.width>0&&first.width<=320&&first.right<=vw*0.45+1&&first.height>=window.innerHeight*0.6){
					if(kids[0].querySelector('textarea'))continue;
					return kids[0];
				}
			}
		}
		return null;
	}
	var backdrop=document.createElement('div');backdrop.className='hwb-nav-backdrop';
	var rail=document.createElement('div');rail.className='hwb-nav-rail';rail.textContent='会话列表';
	rail.title='右滑/点击展开会话列表';
	var navEl=null,navPrev='';
	function applySingle(){
		var nav=findNavColumn();
		if(!nav||nav===navEl)return;
		if(navEl){try{navEl.style.cssText=navPrev}catch(e){}}
		navEl=nav;navPrev=nav.style.cssText;
		nav.style.cssText=navPrev+';position:fixed;left:-'+nav.getBoundingClientRect().width+'px;top:0;bottom:0;z-index:2147483002;transition:left .2s ease;box-shadow:4px 0 18px rgba(0,0,0,.18);';
	}
	function openNav(){
		if(!navEl)applySingle();
		if(!navEl)return;
		navEl.style.left='0';backdrop.classList.add('show');rail.classList.remove('show');
	}
	function closeNav(){
		if(navEl)navEl.style.left='-'+navEl.getBoundingClientRect().width+'px';
		backdrop.classList.remove('show');rail.classList.add('show');
	}
	function mount(){
		if(!document.body)return;
		document.body.appendChild(backdrop);document.body.appendChild(rail);
		backdrop.addEventListener('click',closeNav);
		rail.addEventListener('click',openNav);
		// 左缘 24px 内右滑呼出
		var sx=0,sy=0,tracking=false;
		document.addEventListener('touchstart',function(e){
			var t=e.touches[0];sx=t.clientX;sy=t.clientY;tracking=sx<24;
		},{passive:true});
		document.addEventListener('touchmove',function(e){
			if(!tracking)return;var t=e.touches[0];
			if(t.clientX-sx>36&&Math.abs(t.clientY-sy)<48){openNav();tracking=false;}
			else if(sx-t.clientX>36){closeNav();tracking=false;}
		},{passive:true});
		// 鼠标/键盘也可用（桌面无触摸）
		document.addEventListener('keydown',function(e){
			if((e.ctrlKey||e.metaKey)&&e.key==='b'){e.preventDefault();navEl&&navEl.style.left==='0'?closeNav():openNav();}
		});
		var lastX=0,hover=false;
		document.addEventListener('mousemove',function(e){
			if(hover)return;
			if(e.clientX<6){hover=true;lastX=e.clientX;return;}
			if(hover&&e.clientX-lastX>60){openNav();hover=false;}
		});
		// 布局收敛后再应用一次（SPA 首帧有骨架屏时列结构未定型）
		var tries=0,timer=setInterval(function(){
			applySingle();
			if(navEl||++tries>40)clearInterval(timer);
		},500);
		applySingle();closeNav();
	}
	if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
	// SPA 路由切换后重新探测
	var push0=history.pushState;if(push0){history.pushState=function(){var r=push0.apply(this,arguments);closeNav();navEl=null;applySingle();return r;};}
})();</script>`;
  }

  /** 上游返回的不是站点应用，而是一张 CDN/WAF/网关的错误页。
   *
   *  真机证据（2026-09-11 实测）：本机直连 chat.deepseek.com 被 CloudFront 判成
   *  机器人，回 403 + 「Request blocked. We can't connect to the server for this
   *  app or website at this time」，而 chatglm.cn / www.kimi.com / chat.qwen.ai
   *  / chat.z.ai 全部 200。右栏 iframe 于是显示一张英文 403 页 —— 用户看到的
   *  就是「除了 DeepSeek，其它站点的预览都能打开」。
   *
   *  这里识别这类响应并换成能自解释的说明页（含重试），而不是把上游错误页原样
   *  塞进面板，也不要在错误页上再注入 bootstrap（那会得到一张拼接出来的怪页面）。 */
  const UPSTREAM_ERROR_SIGNATURES = [
    /Generated by cloudfront/i,
    /Request blocked\. We can't connect to the server/i,
    /<title>\s*(?:403|404|429|500|502|503|504)\s/i,
    /Just a moment\.\.\./i,
    /Attention Required!\s*\|\s*Cloudflare/i,
    /Access Denied/i,
  ];
  function looksLikeUpstreamErrorPage(html) {
    const sample = String(html).slice(0, 6000);
    return UPSTREAM_ERROR_SIGNATURES.some((re) => re.test(sample));
  }

  function upstreamErrorPage(status, host, note) {
    return [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>' + host + ' 拒绝了镜像请求（HTTP ' + status + '）</title>',
      '<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fafafa;color:#333}',
      '.box{max-width:440px;padding:24px;text-align:center}.t{font-size:16px;font-weight:600;margin:0 0 8px}',
      '.d{font-size:13px;line-height:1.75;opacity:.78;margin:0 0 12px;text-align:left}',
      '.u{font-size:12px;opacity:.55;word-break:break-all}',
      'button{margin-top:14px;padding:6px 16px;border:1px solid #8885;border-radius:6px;background:transparent;cursor:pointer;font:inherit}</style>',
      '</head><body><div class="box">',
      '<p class="t">' + host + ' 拒绝了镜像请求（HTTP ' + status + '）</p>',
      '<p class="d">' + note + '</p>',
      '<p class="d">可以这样绕开：点右侧栏顶部的 <b>⧉ 独立窗口打开</b>，'
        + '或到「设置 → 网页桥接 → 登录网站」用真实浏览器窗口访问该站点。'
        + '独立窗口走的是本机真实浏览器（保留登录态与真实指纹），不经过镜像的反向代理。</p>',
      '<p class="u">' + String(host || '').slice(0, 80) + '</p>',
      '<button onclick="location.reload()">重新加载</button>',
      '</div></body></html>',
    ].join('');
  }

  async function readRequestBody(req, limit = 8 * 1024 * 1024) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
    const chunks = [];
    let size = 0;
    const tooLarge = await new Promise((resolve) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) resolve(true);
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(false));
      req.on('error', () => resolve(true));
    });
    return tooLarge ? { tooLarge: true } : { body: Buffer.concat(chunks) };
  }

  async function handle(req, res, pathname = new URL(req.url, upstreamOrigin).pathname, search = new URL(req.url, upstreamOrigin).search) {
    if (isLocal(pathname)) return false;
    if (!loopbackOnly(req, res)) return true;

    // 静态资源同源转发（见上方 rewriteAssetUrls 的说明）。任意公网 host 都接受，
    // 内网/回环/畸形 host 拒绝（防本机 SSRF）。
    if (pathname.startsWith(STATIC_SEG)) {
      const rest = pathname.slice(STATIC_SEG.length);
      const cut = rest.indexOf('/');
      const host = cut < 0 ? rest : rest.slice(0, cut);
      const assetPath = cut < 0 ? '/' : rest.slice(cut);
      if (!/^[a-z0-9.-]+$/i.test(host) || PRIVATE_HOST.test(host)) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'mirror: host not allowed' } }));
        return true;
      }
      return proxyAsset(req, res, 'https://' + host, assetPath, search);
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      // 保留 sec-fetch-*：这是浏览器真实发出的同源请求，去掉它反而会让
      // CloudFront 之类的 CDN 把请求判成机器人（403）。
      if (HOP_BY_HOP.has(lower) || lower === 'origin') continue;
      headers[key] = value;
    }
    // Cookie 合并（0.14.4）：旧实现是「请求带 cookie 就只用请求里的」，于是右栏
    // iframe 在 `<site>.localhost` 上存过任何一枚 cookie 之后，驱动 profile 里
    // **真正登录的那份 cookie 就再也不会发给上游**——表现就是「打开右侧网页
    // 之后掉登录」。现在 profile 优先、请求补缺，详见 cookies.mergeCookieHeaders。
    {
      let profileCookies = [];
      if (typeof getCookies === 'function') {
        try { profileCookies = await getCookies(upstreamOrigin) || []; } catch { /* best effort */ }
      }
      const merged = mergeCookieHeaders(profileCookies, req.headers.cookie);
      if (merged) headers.cookie = merged;
    }
    if (typeof getUserAgent === 'function') {
      try { const ua = await getUserAgent(); if (ua) headers['user-agent'] = String(ua); } catch {}
    }
    browserFingerprintHeaders(headers, upstreamOrigin);

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const result = await readRequestBody(req);
      if (result.tooLarge) {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'mirror: request body too large' } }));
        return true;
      }
      body = result.body;
      if (body.length) headers['content-length'] = String(body.length);
    }

    let upstream;
    try {
      upstream = await httpFetch(upstreamOrigin + pathname + search, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'manual',
        timeoutMs: 60_000,
      });
    } catch (error) {
      warn('upstream failed:', pathname, error?.message);
      // 面板里显示裸 JSON 对用户毫无意义。给一个能自解释的页面：
      // 站点连不上（多见于本机网络/代理不通），并说明不是桥本身坏了。
      const host = (() => { try { return new URL(upstreamOrigin).host; } catch { return upstreamOrigin; } })();
      const page = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<title>无法连接 ' + host + '</title>',
        '<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fafafa;color:#333}' +
        '.box{max-width:420px;padding:24px;text-align:center}.t{font-size:16px;font-weight:600;margin:0 0 8px}' +
        '.d{font-size:13px;line-height:1.7;opacity:.75;margin:0 0 14px}' +
        '.u{font-size:12px;opacity:.55;word-break:break-all}' +
        'button{margin-top:14px;padding:6px 16px;border:1px solid #8885;border-radius:6px;background:transparent;cursor:pointer;font:inherit}</style>',
        '</head><body><div class="box">',
        '<p class="t">无法连接 ' + host + '</p>',
        '<p class="d">右侧网页需要本机直连该站点。当前网络或代理不可达，请检查后重试；桥与登录态不受影响。</p>',
        '<p class="u">' + String(error?.message || '').slice(0, 120) + '</p>',
        '<button onclick="location.reload()">重新加载</button>',
        '</div></body></html>',
      ].join('');
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return true;
    }

    const out = {};
    for (const [key, value] of upstream.headers) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE.has(lower) || lower === 'set-cookie') continue;
      out[key] = lower === 'location' ? rewriteLocation(value) : value;
    }
    const cookies = upstream.headers.getSetCookie?.() || [];
    if (cookies.length) out['set-cookie'] = cookies.map(rewriteCookie);
    if (cookies.length && typeof setCookies === 'function') {
      try { await setCookies(cookies, upstreamOrigin); } catch { /* best effort */ }
    }
    out['x-webcode-mirror'] = '1';

    const contentType = String(out['content-type'] || '');
    if (contentType.includes('text/html')) {
      const html = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      // CDN/WAF 错误页：换成能自解释 + 可绕开的说明页（见 upstreamErrorPage）。
      if (upstream.status >= 400 && looksLikeUpstreamErrorPage(html)) {
        const host = (() => { try { return new URL(upstreamOrigin).host; } catch { return upstreamOrigin; } })();
        const page = upstreamErrorPage(upstream.status, host,
          '该站点前面的 CDN / 风控层把来自本机脚本的请求判成了机器人（常见于 CloudFront / Cloudflare 的速率或指纹校验）。'
          + '桥本身与登录态不受影响，网页端照常可用。');
        warn('upstream returned an error page:', upstream.status, host);
        res.writeHead(502, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(page)),
        });
        res.end(page);
        return true;
      }
      let token = null;
      try { token = await getToken(); } catch { /* page remains usable for login */ }
      // 顺序很重要：先改写站点自身的资源 URL，再注入 bootstrap。
      // 反过来的话，rewriteAssetUrls 会把 bootstrap 里的 UP/ASSETS 常量
      // 一起改写成同源路径，运行时比较永不命中（真机 GLM 埋点仍被 CORS 拦）。
      let patched = rewriteAssetUrls(html);
      // URL 改成同源后 crossorigin 不再需要；integrity 一旦不匹配会让整页脚本
      // 失效（失败面大于收益），一并剥离。
      patched = patched.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin(?:="[^"]*")?/gi, '');
      // 注意：不要对整段注入做 `</script` 转义 —— 那会把这两块 script 自己的
      // 收尾标签也一起转掉，标签不闭合、整段脚本不执行（2026-09-13 真机实测：
      // document.createElement 仍是原生的，webpack 懒加载 chunk 全部 404）。
      // token 已在 bootstrap 里用 `\u003c` 转义过，这里无需再处理。
      const injected = bootstrap(typeof token === 'string' ? token : null);
      patched = patched.includes('</head>')
        ? patched.replace('</head>', injected + '</head>')
        : injected + patched;
      out['content-length'] = String(Buffer.byteLength(patched));
      res.writeHead(upstream.status, out);
      res.end(patched);
      return true;
    }

    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return true;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client disconnected */ }
    try { res.end(); } catch {}
    log('proxied', req.method, pathname);
    return true;
  }

  return { handle, isLocal };
}
