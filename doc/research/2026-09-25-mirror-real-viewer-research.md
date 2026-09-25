# 镜像路线「真实查看器」方案研究（2026-09-25）

> 背景：0.21.2 路线还原后，镜像 iframe 恢复默认（原生帧率）。用户问「怎么做到
> 真实查看器」——即在不放弃镜像的前提下，让图片查看器/文件预览这类**运行时
> 动态请求**也能工作。本文是 sciverse/上网 + 本地参考（wabac.js 已在
> `reference/wabac.js`）核对后的结论。

## 一、病根复述（为什么查看器在镜像里打不开）

镜像的运行时覆盖面 = bootstrap 钩子（fetch/XHR 包装 + createElement 的
src/href 属性 setter）+ 静态标签改写。缺口：React 用 `setAttribute` 赋的
src、innerHTML 注入、以及从 API 数据拼出的**绝对真实域 URL**——这些请求
直接打到真实站点，而用户浏览器对这些域没有登录 cookie ⇒ 401/403。

## 二、被验证的架构：SW 拦截层 + DOM 级重写（双件套）

- **wabac.js**（本地 `reference/wabac.js`，ReplayWeb.page 的核心）：
  Service Worker 按 scope 拦截**本源下的一切请求**（fetch/XHR/img/文档）并
  重写转发，配套 **wombat.js** 在页面内做 DOM 级重写（patch 属性 setter、
  setAttribute、innerHTML 等）——两者缺一不可。自带 **Live Proxy 示例**
  （对活网页做全功能改写代理）。
- **Ultraviolet 系**（同型架构）：SW 把本源下所有请求重写到代理路径
  （如 `/service/<encoded-url>`），配客户端重写让页面只发本源 URL。
- 关键机制（Stack Overflow / Chromium 安全 FAQ 核对）：**SW 只能拦截本源
  scope 内的请求**——所以「页面只发本源 URL」是前提，这正是客户端重写层
  的职责；跨源 iframe 内部在重写为同源代理 URL 后即可被覆盖。

## 三、适配本桥的设计（0.22 候选）

1. **镜像源注册 SW**：`https://<siteId>.localhost:8931/sw.js`，scope 覆盖整源；
   fetch 处理器把 `/wr/<真实URL>` 形态的请求转给现有中继（cookie 合并逻辑
   **原样复用**，不重写第二份）。
2. **客户端重写升级到 wombat 级**：现有 bootstrap 补 `setAttribute`/
   `innerHTML`/srcset 三处 hook（或直接引 wombat.js，~100KB 单文件）。
   此后页面发出的**每一个**请求都是本源 URL ⇒ 全部落进 SW ⇒ 全部带驱动
   cookie 走中继。查看器/预览的请求从此无死角。
3. **文件/图片端点直通**：`/wr/` 不做域白名单（静态标签的教训：白名单必然
   漏域），一律转中继；中继已有 SSRF 防护（内网拒绝）。
4. **登录态**：SW 转发的请求带中继合并的驱动 cookie——「账号一处」性质不变。

复杂度预估：bootstrap 三处 hook + sw.js（~150 行）+ 路由 `/wr/`（中继已有
代理路径复用）≈ 一轮交付；引 wombat.js 是更彻底但更重的选项。

## 三之二、0.19.14 交付（hooks + /wr/ 双件，SW 暂缓）

按「尽可能不复杂」裁量，先落 hooks + `/wr/`，SW 暂缓（它只能拦截本源请求，
而客户端改写本来就是前提；hooks 覆盖不到的残余场景留给真机反馈再升级）：

1. **`/wr/<encodeURIComponent(绝对URL)>` 路由**（mirror.js `proxyWrapped`）：
   任意公网 http(s) 目标的带 cookie 转发——cookie 合并、指纹头、响应净化与主镜像
   同一套；**cookie 按「目标域」取**（`cachedProfileCookies(targetOrigin)`）。
   **referer 必须是上游页面**（真机二分实锤：files.deepseeksvc.com 的签名 URL 对
   referer=目标域直接 403、referer=chat.deepseek.com 200——镜像页里裂图的机理
   正是浏览器把镜像 origin 当 referer 发给了 CDN）。SSRF 面与 `/__static/`
   同一口径：内网/回环/非 http(s) 一律拒绝。HTML 响应走同序「改写 + 注入」，
   让被包裹页面的后续请求也留在本源；Location 重定向同口径收进镜像命名空间。
2. **bootstrap toLocal 兜底**：上游主机与 ASSETS 清单之外的**一切** http(s) 绝对
   地址 → `ROOT + '/wr/' + encodeURIComponent(u)`；`isLocalPath` 认识 `/wr/` 防
   二次加前缀。文件/图片服务的运行时请求从此落进 `/wr/` 带驱动 cookie。
3. **补钩三处**：`setAttribute('srcset')`（逐段改写）+ createElement 的
   img/source `srcset` 属性 setter；`innerHTML`（字符串级属性语境改写，快路径：
   不含 `http`/`//` 原样返回）；`window.open`（新标签打开图片/文件留在镜像）。
4. 静态标签的改写**维持** `/__static/`（公共资产，无 cookie 需求，已有测试钉住）；
   `/wr/` 只接管运行时未知域——两类语境各走各路，互不重写。

护栏：`test/mirror.test.mjs` 新增 /wr/ 用例（bootstrap 兜底文本断言、内网/非
http 拒绝、公网目标不可达 502）。真机验收：`test-mock/real-mirror-viewer.mjs`
（真实登录态 + 独立 mirror 实例 + 无登录浏览器打开含图会话）。

## 四、本轮（0.21.2）已做

路线还原：镜像恢复默认（原生帧率），画面流收进工具栏「真实模式」按钮
（显式 opt-in，LivePane 内可退回）。WebRTC/投屏代码全部保留。

## 参考源

- wabac.js（本地 + GitHub webrecorder/wabac.js，含 examples/live-proxy）
- Stack Overflow: Is it possible to proxy iframe sub-resources with service workers
- MDN Service Worker API；Jake Archibald: Service workers and base URIs
- Chromium Service Worker Security FAQ；Privacy CG proposals #15
