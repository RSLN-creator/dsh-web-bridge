// mirror.js - serve the real DeepSeek web app inside the right sidebar.
// The upstream is fixed at siteOrigin; this is a same-origin relay, not an
// open proxy. The page token is injected only into the relay origin's storage.

export function createMirror(options = {}) {
  const {
    siteOrigin = 'https://chat.deepseek.com',
    getToken = async () => null,
    logger = console,
    // 站点静态资源域（providers.js 的 staticOrigins）与本站点在镜像中的挂载
    // 前缀；两者一起决定 HTML/CSS 里绝对资源 URL 如何改写成同源路径。
    assetOrigins = [],
    mountPrefix = '',
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
  // 站点 HTML 用绝对 URL + crossorigin 引用静态域（DeepSeek 的
  // fe-static.deepseek.com），浏览器因此以 CORS 模式请求；而该域返回的
  // Access-Control-Allow-Origin 是字面量通配（非法值），脚本被硬性拒绝，
  // 页面退化成「页面资源加载异常」。这里把资源 URL 改写成镜像自己的
  // <mountPrefix>/__static/<host>/<path> 并同源转发——既不做 CORS 判定，
  // 也让 @font-face 这类必须 CORS 的资源可用。
  const STATIC_SEG = '/__static/';
  const assetHosts = new Set(assetOrigins.map((o) => {
    try { return new URL(String(o)).host; } catch { return ''; }
  }).filter(Boolean));

  /** 把文本里指向静态域的绝对 URL 改写成同源路径。 */
  function rewriteAssetUrls(text) {
    let out = String(text);
    for (const origin of assetOrigins) {
      const from = String(origin).replace(/\/$/, '');
      let host = '';
      try { host = new URL(from).host; } catch { continue; }
      const to = mountPrefix + STATIC_SEG + host;
      out = out.split(from + '/').join(to + '/');
      out = out.split('"' + from + '"').join('"' + to + '"');
      out = out.split("'" + from + "'").join("'" + to + "'");
      out = out.split('(' + from + ')').join('(' + to + ')');
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
      upstream = await fetch(origin + assetPath + search, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
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


  function loopbackOnly(req, res) {
    const host = String(req.headers.host || '');
    if (/^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)) return true;
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message: 'mirror: loopback only' } }));
    return false;
  }

  function rewriteLocation(value) {
    try {
      const url = new URL(value, upstreamOrigin);
      return url.host === upstreamHost ? url.pathname + url.search + url.hash : value;
    } catch {
      return value;
    }
  }

  function rewriteCookie(value) {
    return String(value)
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*secure/gi, '')
      .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
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
    return `<script data-webcode-mirror>(function(){
	try{if(${tokenLiteral}!==null)localStorage.setItem('userToken',${tokenLiteral});}catch(e){}
	try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error('mirror: service worker disabled'));};}catch(e){}
	var UP=${originLiteral};
	// 只存 host：匹配与拼接都用纯字符串，避免正则转义在模板里失真。
	var ASSETS=${assetHostsLiteral};
	var MP=${JSON.stringify(mountPrefix + STATIC_SEG)};
	// 绝对地址 → 同源镜像路径；null 表示无需改写。
	function toLocal(u){
	  if(typeof u!=='string')return null;
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

    // 静态资源同源转发（见上方 rewriteAssetUrls 的说明）
    if (pathname.startsWith(STATIC_SEG)) {
      const rest = pathname.slice(STATIC_SEG.length);
      const cut = rest.indexOf('/');
      const host = cut < 0 ? rest : rest.slice(0, cut);
      const assetPath = cut < 0 ? '/' : rest.slice(cut);
      if (!assetHosts.has(host)) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'mirror: unknown asset host ' + host } }));
        return true;
      }
      return proxyAsset(req, res, 'https://' + host, assetPath, search);
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower.startsWith('sec-fetch-') || lower === 'origin' || lower === 'referer') continue;
      headers[key] = value;
    }
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    headers.referer = upstreamOrigin + '/';

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
      upstream = await fetch(upstreamOrigin + pathname + search, {
        method: req.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
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
    out['x-webcode-mirror'] = '1';

    const contentType = String(out['content-type'] || '');
    if (contentType.includes('text/html')) {
      const html = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      let token = null;
      try { token = await getToken(); } catch { /* page remains usable for login */ }
      // 顺序很重要：先改写站点自身的资源 URL，再注入 bootstrap。
      // 反过来的话，rewriteAssetUrls 会把 bootstrap 里的 UP/ASSETS 常量
      // 一起改写成同源路径，运行时比较永不命中（真机 GLM 埋点仍被 CORS 拦）。
      let patched = rewriteAssetUrls(html);
      // URL 改成同源后 crossorigin 不再需要；integrity 一旦不匹配会让整页脚本
      // 失效（失败面大于收益），一并剥离。
      patched = patched.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin(?:="[^"]*")?/gi, '');
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
