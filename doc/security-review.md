# dsh-webcode-bridge 安全与逻辑评审（0.14.0）

本文是给评审者的完整安全说明。基线是仓库里 0.4.1 版的《安全与逻辑审查》，
本次扩写**保留并整合原结论**，同时把每条结论回溯到当前代码；凡与现状不符的旧结论，
在下文明确标注「已修复（0.14.0）」或「与现状不符」。所有行号均为本次逐文件读到的真实位置。

审查口径：人工源码审查 + 现有回归测试；不沿用旧文档无证据的「全部安全」结论，也不采信
独立代理的自述。包版本取自 `package/dsh-webcode-bridge/package.json`（`0.14.0`）。

---

## 1. 威胁模型

### 1.1 部署形态

桥以 DSH 插件形式加载（`package/dsh-webcode-bridge/lib/index.js`），做两件有安全含义的事：

1. 用 Playwright 驱动本机**已登录的**真实 Edge（持久 profile，`index.js:54` 的
   `profileDir` 默认落在 `$DSH_HOME/webcode-edge-profile`，实际启动见
   `browser-driver.js` 的 `launch()`，`chromium.launchPersistentContext(cfg.profileDir, …)`
   在 `browser-driver.js:660`），操作 chat.deepseek.com 等站点，把它们变成 DSH 的 LLM provider。
2. 在 DSH web server 上挂 `/__webcode/*` 同源控制面路由（挂载点 `index.js:1501-1530`），
   并在本机 `127.0.0.1:8931` 起一个中继（默认值 `index.js:33-34`、`relay.js:23-24`，
   监听语句 `relay.js:276`），中继上还有 OpenAI 兼容前端 `/v1/*`（`openai.js:211-282`）。

### 1.2 对手与边界

明确假设：**本机单用户**，服务只监听回环，不做远程访问认证，**不支持也不允许把端口暴露到公网**。

两类对手：

| 对手 | 能力 | 桥的应对 |
| --- | --- | --- |
| 本机其它进程 / 其它本地页面 | 能连 `127.0.0.1:8931`；能在浏览器里发起跨站请求 | Host 回环族判定 + `Sec-Fetch-Site` + Origin 三道闸（第 2 节） |
| 任意公网站点 | 能诱导用户浏览器向 `127.0.0.1` 发请求，能借 DNS 重绑定伪造 Host | 同上；`Sec-Fetch-Site: cross-site` 直接拒绝（`web-control.js:121-122`） |

**被保护的东西**：

- 已登录网页会话产生的数据（会话列表、历史消息、模型回复），不被跨站页面读取。
- DeepSeek 的 `userToken` / 网页登录态，不被控制面接口导出。
- 控制面动作（连接、登录、开窗、导入登录态、改设置、操作网页）不被第三方页面触发。

**明确不保护的东西**（不隐瞒）：

- **不隔离同机进程**。任何以当前用户身份运行的本地程序都能直连 `127.0.0.1:8931`，
  也能读 `profileDir` 下的文件。桥没有做跨用户 / 跨进程隔离，也没有做本机进程鉴权。
- **不保护持久 Edge profile 本身**。`profileDir` 里就是真实的 cookie 与登录态，
  落到磁盘时依赖操作系统文件权限，桥自身没有加密。
- **不保护发给网页模型的内容**。上下文、工具结果、截图都会送到站点（沿用原文结论）。
- **不承诺绕过或对抗站点风控**。桥驱动的是用户自己的已登录网页会话，不是绕过登录，
  但站点仍可能因自动化行为限流或加验证（第 5 节）。

---

## 2. 控制面三道闸

实现集中在 `package/dsh-webcode-bridge/lib/web-control.js` 的 `csrfSafe(req)`
（`web-control.js:114-132`），在请求分派入口统一执行（`web-control.js:438-442`），
预览路由单独再执行一次（`web-control.js:467-470`）。

### 2.1 第一道：Host 必须是回环族

- 判定实现：`lib/loopback.js` 的 `isLoopbackHost`（`loopback.js:21-25`），
  正则 `IP_LOOPBACK`（`loopback.js:17`，接受 `127.0.0.1` / `[::1]`，可带端口）与
  `NAME_LOOPBACK`（`loopback.js:18`，接受 `(子域.)*localhost`，可带端口）。
- 调用点：`web-control.js:120`（`if (!isLoopbackHost(hostHeader)) return false;`）。
- 同样规则复用在：`lib/openai.js` 的 `csrfSafe`（`openai.js:26`）与
  `lib/mirror.js` 的 `loopbackOnly`（`mirror.js:217-222`）。

**防御目标：DNS 重绑定。** 攻击者把自己的域名解析到 `127.0.0.1` 后，浏览器发出的请求
Host 头会是攻击者域名，回环族判定直接拒绝；而公网无法把一个域名解析到**受害者的**
本机回环，所以 `*.localhost` 子域与 `localhost` 等价，不引入新面。

`<site>.localhost` 子域是刻意放行的（`web-control.js:117-119` 注释、`mirror.js:206-216`）：
右栏每个站点挂在 `http://<siteId>.localhost:<port>/` 上，控制面必须在那上面照常可用。
判定规则只在 `loopback.js` 定义一次，`web-control.js` / `openai.js` / `mirror.js` 三处共用——
这条收敛是 0.12.9 真机故障（`zai.localhost:8931/__webcode/status` 被 403）的直接产物。

### 2.2 第二道：`Sec-Fetch-Site: cross-site` 拒绝

- 代码：`web-control.js:121-122`（`const site = …; if (site === 'cross-site') return false;`）。
- 同规则：`openai.js:27-28`。

**防御目标：公网页面发起的跨站请求。** 现代浏览器对跨站发起的请求会带
`Sec-Fetch-Site: cross-site`，这一条直接拦掉「任意公网站点诱导用户浏览器打本机端口」。
副作用是**非浏览器客户端（如 `curl`）不带该头，会通过**——这是明确的设计取舍，
见 `web-control.js:11-12` 的立场注释与 `web-control.js:131`（无 Origin 时返回 `true`）。
代价记在第 6 节。

### 2.3 第三道：Origin 只接受同源或白名单

- 代码：`web-control.js:123-131`。有 Origin 时，先查白名单
  （`allowedOrigins`，构造于 `web-control.js:93`，来源 `index.js:62` 的
  `['http://127.0.0.1:3080', 'http://localhost:3080']`），否则走同源判定
  `originMatchesHost`（`loopback.js:32-40`，比较的是 `URL.host`，**含端口**）。
- 白名单来源：`index.js:62`，只列 DSH 前端自己的两个源；右栏站点 iframe 是
  `<siteId>.localhost:<relay 端口>`，与中继同源，不走白名单。

**防御目标：其它本地应用冒充。** `loopback.js:30` 的注释说得直白：别的回环端口是
**另一个应用**，不是「我们」。因此 `http://127.0.0.1:8931` 上收到的、
Origin 指向 `http://127.0.0.1:9999` 的请求会被判 false。同源挂载（DSH webServer 上的
`/__webcode/*`）根本不发 CORS 头，也不存在跨源可读的问题。

### 2.4 为什么不能用 `Access-Control-Allow-Origin: *`

`web-control.js:95-100` 的注释给出了理由，代码在 `web-control.js:101-112`：
`corsHeaders` **只回显白名单里的 Origin**，否则返回空对象；`openai.js:38-49` 同样只回显白名单。
中继层也有一条对应注释（`relay.js:262-267`）：没有宽松 CORS。

理由：控制面动作里有读会话列表 / 读历史（`web-control.js:383-391`）、
读诊断、开关登录窗口、导入本机登录态（`web-control.js:348-361`）。
如果回 `*`，任何一个恶意本地页面都能发简单 POST 并**跨源读到会话数据**——
这正是 CORS 模型下 `*` 无法与「带凭据的本地控制面」共存的根本原因。
OPTIONS 预检同样只回显白名单（`web-control.js:420-426`、`openai.js:212-216`），
陌生人拿到裸 204，预检失败。

### 2.5 三道闸的落点汇总

| 闸 | 文件:行号 | 防御目标 |
| --- | --- | --- |
| Host 回环族 | `web-control.js:120`，实现在 `loopback.js:21-25` | DNS 重绑定、跨主机访问 |
| `Sec-Fetch-Site: cross-site` | `web-control.js:121-122` | 公网页面发起的跨站请求 |
| Origin 同源 / 白名单 | `web-control.js:123-131`、`loopback.js:32-40`、白名单 `index.js:62` | 其它本地应用冒充、跨源读取 |
| 统一执行点 | `web-control.js:438-442`（403）、`web-control.js:467-470`（预览 403） | 分派前拦截，未知路径不泄漏 |
| OpenAI 前端同规则 | `openai.js:224-226` | `/v1/*` 与 `/bridge/*` 的 POST |
| 镜像同规则 | `mirror.js:217-222`、`mirror.js:516` | 反代只服务回环 |

---

## 3. 凭据边界

### 3.1 token / 登录态不出页面（控制面口径）

`web-control.js:15-16` 的立场注释：DeepSeek 的 `userToken` 不离开驱动页；
列表与历史在**已登录标签页内**跑 `fetch`，只把蒸馏后的 JSON 带回来。

代码依据：

- `lib/browser-driver.js` 的 `webApi`（`browser-driver.js:1855-1893`）整段是
  `page.evaluate(...)` 的**页内**闭包：token 从页内 `localStorage` 读出
  （`browser-driver.js:1867-1872`），只用于页内 `fetch` 的 `Authorization` 头
  （`browser-driver.js:1874`），并且显式拒绝跨源 api path
  （`browser-driver.js:1884`：`if (target.origin !== location.origin) throw …`）。
  返回值只保留 `{ status, ok, json, text }`（`browser-driver.js:1889`）。
- `listSessions`（`browser-driver.js:1896-1915`）与 `fetchHistory`
  （`browser-driver.js:1917-1939`）只把 `id / title / updatedAt`、
  `id / role / content / parentId / isBranch / at` 这类字段映射出来，不含 token。
- 控制面的 action 表（`web-control.js:166-404`）里**没有**任何返回 token 的 action。
  原文「移除 token 导出接口」这一条在当前代码里成立。

**但有一处必须如实说明**：右栏的站点镜像会把 token 注入到**镜像页面**的
`localStorage`（`lib/mirror.js` 的 `bootstrap()`，`mirror.js:267-284`；
token 由 `getToken()` 取得，`mirror.js:630-631`，注入调用 `mirror.js:643-646`）。
镜像页面的源是回环（`<siteId>.localhost:<port>` 或 `/__webcode/site/<siteId>/`），
因此这不是「token 出到公网」，但**它确实离开了原站点页面**。若评审要求
「token 严格不出页面」，这里的口径需要重新确认。

### 3.2 会落盘的东西与权限

| 文件 | 位置（代码） | 写入方式与权限 |
| --- | --- | --- |
| `webcode-consent.json` | 路径 `relay.js:35`；读写 `relay.js:48-66` | 原子写（tmp + rename），`{ mode: 0o600 }`，`relay.js:62-64` |
| `webcode-settings.json` | 路径 `index.js:366`；写入 `index.js:395-400` | 原子写，`{ mode: 0o600 }`，`index.js:398` |
| `webcode-send-state.json` | 路径 `index.js:1037`；写入 `index.js:1055-1063` | 原子写，`{ mode: 0o600 }`，`index.js:1060` |
| `webcode-login-state.json` | 路径 `browser-driver.js:241`；写入 `browser-driver.js:245-251` | `fs.writeFileSync(loginStatePath(), JSON.stringify(entry))`，`browser-driver.js:249`，**未指定 mode**（见第 6 节） |
| `webcode-sessions-<siteId>.json` | 路径 `browser-driver.js:313`；写入 `browser-driver.js:325-330` | `browser-driver.js:328`，**未指定 mode**（见第 6 节） |
| 持久 Edge profile 本身 | `index.js:54` 的 `profileDir`；启动 `browser-driver.js:660` | 由 Edge 自己管理，里面是**真实 cookie / 登录态** |
| 中继 control 状态（内存） | `relay.js:43-46` | 仅内存，`stop()` 时 `consent = false`（`relay.js:298`） |

`webcode-consent.json` 的原子写动机写在 `relay.js:60-61`：避免进程退出留下被截断的
consent 文件、把「已同意」静默变回「首次运行」。

`webcode-send-state.json` 只存「站点 id → 上次发出时刻」（`index.js:1031-1037`），
读取时还会过滤未知站点与超过 24h 的陈旧基准（`index.js:1040-1053`），不含凭据。

**导入登录态的安全约束**（`browser-driver.js` 的 `importStorageFromProfile`，
`browser-driver.js:1784-1847`）：

- 绝不在用户真实的 User Data 目录上 `launchPersistentContext`；先复制最小集合
  （`Local State` + `Default/Network/Cookies` 等，`browser-driver.js:1801-1811`）
  到临时目录，读完即删（`browser-driver.js:1833-1836`）。旧实现直接挂载用户目录，
  会撞单实例锁并可能把用户浏览器带进自动化会话（`browser-driver.js:1777-1780`）。
- Edge 128+ 的 app-bound 加密（v20）读不出 cookie 时**显式报错**，不留半截状态
  （`browser-driver.js:1818-1831`）。
- 中继上的 `/bridge/import-session` 把 `sourceProfileDir` 限制在 DSH home、
  驱动 profile 或本包树内（`openai.js:244-256`）。**注意**：控制面的
  `POST session-import` 没有这层目录限制（`web-control.js:348-361`），见第 6 节。

### 3.3 镜像对 cookie 的处理（0.14.4 重写）

两个消费方向各自按 RFC 6265 解析，抽成纯模块 `lib/cookies.js`：

- **回给浏览器**（`rewriteSetCookieForMirror`）：去掉 `Domain`（跨域会被整枚丢弃）、
  `SameSite=None` 收敛成 `Lax`，但 **`Secure` 必须保留**——`__Secure-` / `__Host-`
  前缀缺 Secure 会被浏览器按前缀规则直接丢弃。旧实现是字符串替换，把 Secure 剥掉，
  这正是「打开右侧网页后掉登录」的直接原因之一。
- **写回驱动 profile**（`toPlaywrightCookie`）：删除指令（`Max-Age<=0` / `Expires` 已过）
  翻译成 `expires: 0`，**不再写成空值**——旧实现会把 profile 里有效的登录 cookie
  就地抹成空串。`__Secure-` 前缀即使原头没写 Secure 也补上（否则 playwright
  `addCookies` 抛错，整批一枚都写不进去）。
- **请求侧合并**（`mergeCookieHeaders`）：profile 优先、请求补缺。旧实现「请求带
  cookie 就只用请求里的」，于是 iframe 在 `<site>.localhost` 上存过任何一枚 cookie
  之后，驱动 profile 里真正登录的那份**永远不再发给上游**。

`content-security-policy` 等响应头仍在 `STRIP_RESPONSE` 里被剥离（`mirror.js`）；
驱动 cookie 读取有 5 秒短缓存（CDP 往返昂贵，一次页面加载会上百次），
**本镜像写回 cookie 时立即失效**。

---

## 4. 日志与错误

### 4.1 响应体上限

- 控制面：`MAX_BODY_BYTES = 256 * 1024`（`web-control.js:27`），由
  `readBody(req, limit = MAX_BODY_BYTES)`（`web-control.js:146-163`）执行；
  超限时 `req.destroy()` 并回 `{ ok: false, error: 'request body too large' }`，
  HTTP 413（`web-control.js:447-450`）。读取失败或 JSON 解析失败一律退化为 `{}`
  （`web-control.js:158-161`），不会把解析异常泄漏成 500。
- OpenAI 前端：上限 20MB，理由是允许最多 6 张 ≤8MB 的 base64 图片附件
  （`openai.js:79-95`，注释在 `openai.js:84-86`），超出直接 reject。
- 镜像：`readRequestBody` 有独立上限（`mirror.js:505-511`），超限回 413
  （`mirror.js:556-560`）。

### 4.2 错误文本

原文「错误文本是固定文案、不回显 token」**部分成立**，需要按端点区分：

- 固定文案的错误：`'cross-site control requests are not allowed'`（`web-control.js:440`）、
  `'cross-site preview is not allowed'`（`web-control.js:468`）、
  `'preview failed'`（`web-control.js:496`）、
  `'cross-site requests are not allowed'`（`openai.js:225`）、
  `'invalid JSON body'`（`openai.js:136`）、`'messages array required'`（`openai.js:139`）。
- **透传的错误**：`web-control.js:454-461` 的兜底 catch 把 `err.message` 截断到 200 字符
  回给调用方（注释说明这是为了本机用户能照着排查，如 profile 被孤儿 Edge 占用）；
  `index.js:1516-1518` 的路由级 catch 同样截断 200 字符；
  `openai.js:205-207` 与 `openai.js:179` 也把 `err.message` 放进错误体。

**为什么错误里只放「人话原因」**（`web-control.js:455-457` 的注释是依据）：
设置面板是本机用户的唯一操作入口，把 `web request failed` 换成真实原因
（例如 profile 锁被孤儿 Edge 占用）才能照着排查；端点本身 loopback-only，
暴露面没有变化。代价是「固定文案」这条旧结论对兜底路径不再成立，记入第 6 节。

### 4.3 不记录凭据

- 中继完成一轮只记录字符数：`log('request done', requestId, \`chars=…\`)`（`relay.js:191`），
  不记录正文。
- 控制面拒绝时记录的是 origin 而非凭据（`web-control.js:439`）。
- 中继对外暴露的状态里，`publicStatus`（`openai.js:51-67`）显式去掉 profile 路径与
  网页会话 URL：注释写在 `openai.js:51`。
- 诊断信息（`web-control.js:201`）走 `driver.diagnostics()`；原文「诊断仅记录
  模型 / 思考 / 搜索参数」这一条与现状一致。
- 镜像上游失败时写入错误页的是 `error.message` 截断 120 字符
  （`mirror.js:590`），是网络错误文本，不含凭据。

原文「移除提示词、工具输出正文日志」**未能确认到一条独立的移除提交**；
当前代码里未发现把提示词或工具输出正文写入日志的语句，但 `lastPresetInfo`
会把最近一次首轮提示词留在内存供设置页预览（`index.js:364`、`index.js:1312`），
经 `GET /__webcode/preset` 与 `GET /__webcode/prompt-variants` 可读
（`web-control.js:279-303`）——受同一道 `csrfSafe` 门禁保护。

---

## 5. 风控与合规边界

### 5.1 立场

桥驱动的是**用户自己已登录的网页会话**：登录由用户在真实 Edge 窗口里完成
（`browser-driver.js` 的 `openLogin`，`browser-driver.js:1564` 起），
桥不破解登录、不伪造凭据、不绕过站点的身份校验。
`webApi` 只允许站点相对的、同源的 api path（`browser-driver.js:1856-1858`、
`browser-driver.js:1884`），不做任意跨站请求。

### 5.2 如实说明的风险面

1. **站点风控 / 限流**。自动化发送可能触发站点的速率策略；镜像层已经观测到
   CDN / 风控把来自本机脚本的请求判成机器人（`mirror.js:616-621` 的说明页文案）。
2. **自动化条款**。各家站点对自动化访问的服务条款口径不一，本桥不做合规判断，
   使用者需自行确认。此为文档层面的提示，**代码中没有对应的强制开关**。
3. **网页 UI 变更导致失败**。选择器、路由、请求体形状随站点改版而变；
   站点探活失败时右栏显示说明页（`web-control.js:232-256`），而不是静默空白。
4. **模型串号防护不是合规替代**。`strictModelType` 只保证「实际请求的元数据与所选模式
   相符就放行、不符即报错」（口径见 `doc/review-guide.md`），与站点风控无关。

### 5.3 桥自带的限流防护

- **发送间隔（send-to-send）**：设置项 `sendGapMs`，钳制在 `[0, 600000]` 毫秒
  （`index.js:73-74` 的 `SEND_GAP_MAX_MS` / `clampSendGapMs`；控制面写入时同样钳制，
  `web-control.js:272-275`）。等待判定由纯函数 `computeSendGap` 给出，
  调用点 `index.js:1125-1133`，基准是「上一轮**发出**」而不是「上一轮结束」
  （语义修正见 `index.js:68-71`）。
- **基准落盘**：`webcode-send-state.json`（`index.js:1037`、`0o600` 在 `index.js:1060`），
  避免进程重启后第一轮零等待（动机注释 `index.js:1032-1035`）。基准只在真正发出时更新
  （`markSent`，`index.js:1136-1141`），失败与退避不污染它（`index.js:1134-1135`）。
- **RATE_LIMITED 退避**：`RATE_LIMIT_RETRIES = 2`（`index.js:1066`），
  退避时长 `max(sendGapMs, 10_000) × retries`（`index.js:1150`），
  重试循环 `index.js:1140-1155`。10s 下限的理由写在 `index.js:1064-1065`、
  `index.js:1148-1149`：站点滑窗以十秒计，毫秒级重试只会再撞墙。
- **单槽 + 有界队列**：中继是单槽执行器 + FIFO 队列（`relay.js:10-12`、`relay.js:68-69`），
  队列上限 32，超出直接拒绝（`relay.js:216-220`），因为「网页是低吞吐后端」。
- **超时分层**：单轮 `requestTimeoutMs` 默认 240_000（`relay.js:25`、`index.js:41`），
  排队 `queueTimeoutMs` 默认 900_000（`index.js:42-45`，注释解释旧值 300s 会让
  第二个排队请求必然超时），另有适配器侧「无进展」看门狗
  （`index.js:1067-1073`）。

---

## 6. 未修项与风险接受

以下条目**仍然存在**，不作为「已解决」呈现。

### 6.1 已修复项（供对照）

- **子域控制面被误拒**：0.12.9 引入 `<siteId>.localhost` 后，控制面正则漏改导致
  子域上 `/__webcode/*` 全 403。**已修复（0.14.0）**，新位置：
  判定统一到 `lib/loopback.js`（`loopback.js:21-25`），
  `web-control.js:120`、`openai.js:26`、`mirror.js:217-222` 三处共用。
- **控制面漏挂载**：`index.js` 曾手写 routes 数组，漏掉 `verify-login` /
  `site-probe` / `session-import`，导致设置面板按钮落到宿主 405 空 body。
  **已修复（0.14.0）**，新位置：挂载清单从 action 表派生
  （`web-control.js:47-61` 的 `routeIndex` / `controlRoutes`，消费点 `index.js:1501-1524`）。
- **独立运行丢失卡住线索**：无 relay 的兜底 status 分支曾丢 `recoveredTurns` 等字段。
  **已修复（0.14.0）**，新位置：`web-control.js:212-219`。
- **token 导出接口**：控制面 action 表里已无返回 token 的 action
  （`web-control.js:166-404`）。这一条成立。

### 6.2 与原文冲突 / 需更正的结论

- 原文「**移除 token 导出接口和剥离 CSP 的站点反向代理；旧镜像路径返回 410**」——
  前半句（token 导出）成立；后半句**与现状不符**：`lib/mirror.js` 仍在运行链路里
  （实例创建于 `index.js:1315-1324` 与 `index.js:1330-1352`，分发点 `index.js:1264-1266`、
  `index.js:1295-1298`），仍**剥离 CSP**（`STRIP_RESPONSE` 含
  `content-security-policy`，`mirror.js:36-41`，实际剥离在 `mirror.js:602`），
  仍**转发站点资源**（`mirror.js:514-668`），并且静态资源可转发任意公网 host
  （`mirror.js:518-530`）。在当前包内**没有搜索到任何返回 410 的镜像路径**
  （对 `package/dsh-webcode-bridge` 全量 grep `410|Gone|已下线` 无命中）。
  评审应按本节的现状描述，而不是按原文的 410 描述。
- 原文「**错误文本是固定文案**」——对固定分支成立，但兜底路径会透传截断后的
  `err.message`（`web-control.js:454-461`、`index.js:1516-1518`、
  `openai.js:179`、`openai.js:205-207`）。属**口径差异**，非新问题。

### 6.3 未修项清单

1. **本地任意进程可访问 `127.0.0.1:8931`**（监听 `relay.js:276`，默认地址 `relay.js:24`）。
   三道闸拦的是**浏览器**跨站请求；`Sec-Fetch-Site` 与 Origin 都缺失的裸 HTTP 客户端
   会直接通过（`web-control.js:131`）。没有本机进程级鉴权。
2. **持久 Edge profile 里存有真实 cookie**（`index.js:54`、`browser-driver.js:660`）。
   桥不对它加密，安全性等同于操作系统文件权限。
3. ~~**两个状态文件的写入权限不一致**~~ —— **已修复（0.14.4）**：
   `webcode-login-state.json` 与 `webcode-sessions-<siteId>.json` 的
   `writeFileSync` 现在都传 `{ mode: 0o600 }`，与 consent / settings / send-state 一致。
   仍须记住下面那条限定（Windows 上 mode 不生效）。

   > **重要限定（本次核实）**：那几个显式 `0o600` 在 **Windows 上实际并不生效**——
   > Node 文档明确说明 `mode` 只对 POSIX 系统有效，Windows 上文件权限由 ACL 决定。
   > 本插件的目标环境正是 Windows（`DEFAULTS.profileDir` 走 `os.homedir()`，
   > 驱动默认用系统 Edge）。因此上文第 2 条「持久 profile 里存有真实 cookie」的
   > 实际防护等级是**操作系统用户账户隔离**（`%USERPROFILE%` 下的 ACL），
   > 而不是文件模式位。写 `0o600` 仍有意义（跨平台正确性与意图表达），
   > 但**不能据此认为凭据文件已被额外加固**——这是一个容易被误读的点。
4. **镜像反代会转发站点资源**（`mirror.js:514-668`），并把 `userToken` 注入镜像页面的
   `localStorage`（`mirror.js:267-284`、`mirror.js:643-646`）。
   镜像自身有回环 Host 门禁（`mirror.js:217-222`）与内网 SSRF 拦截
   （`PRIVATE_HOST`，`mirror.js:58`、判定 `mirror.js:525-529`），
   但「任意公网 host 的静态转发」是**设计使然**，不是漏洞，也不是零暴露面。
5. **`/v1/*` 前端无鉴权**（`openai.js:211-282`）。保护只有「仅回环」+ POST 的
   `csrfSafe`（`openai.js:224-226`）；`GET /v1/models` 与 `GET /bridge/status`
   连 `csrfSafe` 都没有（`openai.js:217-223`）。本地进程可读状态。
6. ~~**`POST /__webcode/session-import` 接受任意 `sourceProfileDir`**~~ ——
   **已修复（0.14.4）**：新增 `permittedImportRoots()` / `isWithinRoots()`
   （`web-control.js` 顶部导出），只允许 DSH home、桥驱动 profile、本包树三个根，
   与 `openai.js` 的 `/bridge/import-session` **共用同一套判定**——两条入口的
   防护强度不再有差异。回归用例见 `test/site-mount.test.mjs` 的
   `session-import 按站点路由`（覆盖「根内不存在」「根外」「根内存在」三条分支）。
7. **强杀本机浏览器进程的能力**：`killOrphanEdgeForProfile`
   （`browser-driver.js:621-636`）用 PowerShell + WMI `Terminate` 终结命令行里
   含本 `profileDir` 的 `msedge.exe`。匹配按路径精确（`browser-driver.js:626`），
   注释声明「只杀 ours，不碰用户自己的 Edge」，但这是一条真实的进程终止路径。
8. **清理 profile 锁**：`clearStaleProfileLocks` 在无 `ctx` 时删除
   `SingletonLock` 等文件（`browser-driver.js:596-616`）。
9. **原文保留的未完成验证项**：图片附件上传、网页导入 API、同会话并发调用、
   手动网页编辑后的自动上下文重建——**仍未完整验证**。
10. **工具结果 16000 字符截断**（原文），大文件审查应分段读取。
11. **token 与 TPS 是估算**，非官方 tokenizer 或计费统计
    （`relay.js:164` 的 `tokenBasis`、`relay.js:160-184` 的 metrics 构造）；
    极短整帧回复的原生流速仍可能不稳定。
12. **网页模型不是可信执行器**：工具标记可能出现在示例或提示注入里；
    Harness 原生权限与审批**不能关闭**（沿用原文）。
13. **上下文与工具结果会发送至网页站点**，截图也含会话内容；
    只应把允许发送的项目用于该 provider（沿用原文）。
14. **自动化与站点内部协议可能随改版、限流、账户状态改变**；
    未知模型必须报错（`strictModelType` 口径见 `doc/review-guide.md`）。
15. **未做跨操作系统用户隔离，也无远程访问认证**；不应把任何端口暴露到公网
    （沿用原文）。

---

## 6.4 0.14.7 / 0.15.0 新增面的安全复核（2026-09-15 补）

**为什么补这一节**：本文档主体写于 2026-09-10，而 0.14.7（同站多账户）与
0.15.0（真实花名册）在那之后引入了**两个新的数据面**。REPORT.md 的 A-6 Item 6.2
明确把「`doc/security-review.md` 是否覆盖 `lib/accounts.js` / 槽级 profileDir」
列为**未取证**项。实测确认：全文对 `accounts` / `slotProfileDir` /
`parseAccountKey` / `roster` / `agentTeams` 的命中数**均为 0** —— 即此前**确实没有**
覆盖。本节把它们补上，结论按实测给出。

### 6.4.1 槽级 profileDir 的路径穿越面（0.14.7）

**威胁**：`slotProfileDir(profileDir, siteId, slot)` 把用户可控的两个字符串拼进
文件系统路径。若拼接前不校验，`glm#../../..` 这类槽名可让桥在任意目录建 profile
（进而写 cookie、读既有登录态）。这是本插件**最值得盯的一类**面——它直接决定
「用户设置的字符串能不能逃出预期目录」。

**结论：已加固，实测无逃逸。** 两道白名单正则（`accounts.js:39-40`）：

```
SLOT_RE    = /^[A-Za-z0-9_-]{1,32}$/
SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
```

两者都**只允许**字母数字与 `_`/`-`，因此 `/`、`\`、`.`、空格、NUL 全部不可能出现。
`parseAccountKey` / `formatAccountKey` / `slotProfileDir` 三处都调用 `normalizeSlot`
或直接测 `SITE_ID_RE`，`slotProfileDir` 在槽名非法时**抛错**而不是回落默认值
（回落会让用户以为切到了账户2、实际一直在用默认账户）。

**实测（不是读码推断）**：对 9 个真实攻击串逐个跑 `parseAccountKey` +
`slotProfileDir`，并额外检查结果路径是否逃出 `<root>/sites/`：

| 攻击串 | 结果 |
| --- | --- |
| `glm#../../../../etc` | BLOCKED（槽名非法） |
| `glm#..` / `glm#.` | BLOCKED |
| `glm#a/b` / `glm#a\b` | BLOCKED |
| `glm#a b` | BLOCKED |
| `glm#\0x` | BLOCKED |
| `../../etc#2` | BLOCKED（**站点 id** 非法） |
| `glm#` | BLOCKED（槽名为空是拼写错误，不静默当默认槽） |

**9/9 全拦，无一逃出 `root/sites/`。** 另注：`siteId` 在 `driverFor` 里还要过
`getSite(siteId)`（未知站点直接抛 `未知站点`），所以路径面之外还有一层
**已知站点白名单**——两道独立防线，不依赖同一处校验。

### 6.4.2 花名册的信息暴露面（0.15.0）

**威胁**：`projectRoster` 经 `/__webcode/status` 暴露「谁在跑」。
两个需要判断的点：① 是否泄漏了不该给浏览器的内部标识；② 出错时是否把
宿主内部信息（路径、堆栈）当错误文本回给前端。

**结论：暴露面限于桥自己的只读投影，未发现越界。**

- **只读**：`roster.js` 不调用任何写侧方法（`createTask` / `updateTask` 明示不在此处），
  也不创建/中断任何 Team 状态。
- **字段最小化**：Team 行只透出 `id / name / role / status / taskCount`，
  子代理行只透出 `id / name / status / mode / createdAt`——都是官方 view 的既有字段，
  桥不额外拼装。
- **错误文本已截断**：所有 `*Error` 走 `.slice(0, 160)`（`roster.js:116/143/185/188`），
  且多数是**固定枚举串**（`official-team-package-not-loaded` /
  `agent-registry-unavailable` / `session-not-found` …）。只有 4 处会带上底层
  `e.message` 的前 160 字符——**这是有意的**：花名册读不到时，面板必须能说
  「为什么没有数据」而不是让用户以为是「确实没有成员在跑」（`roster.js` 文件头
  的「不造假状态」纪律）。160 字符不足以带出完整路径或堆栈。
- **路由守卫沿用既有面**：`/__webcode/status` 与其余控制面共用同一套同源判定
  （loopback Host + `Sec-Fetch-Site` + 精确 Origin，`web-control.js:114-132`），
  0.15.0 **没有**为花名册新开任何绕过守卫的路径。

### 6.4.3 本节仍然不做的声明

- **未做真机渗透测试**：上面是**代码级**复核 + 路径面离线实测。真机上的
  浏览器行为（实际发起的请求、cookie 域、反代响应头）未在此节验证。
- **未审计官方包内部**：`agentTeams` 的 `listMembers` 实现属上游
  `@deepseek-ai/dsh-experimental-agent-team`，本文只审计**桥对它的调用方式**
  （凭据从哪来、返回值怎么投影、出错怎么降级），不审计上游实现本身。
- 因此 6.4.1 / 6.4.2 的结论口径是「**桥这一侧已加固且实测无逃逸**」，
  而不是「整条链路已通过安全认证」。

---

原文《已处理》一节中的以下结论在当前代码里**仍然成立**，位置见括号：

- 同源控制接口检查 loopback Host、`Sec-Fetch-Site` 与精确 Origin / 白名单；
  跨站与伪造 Host 由测试验证拒绝（`web-control.js:114-132`、`web-control.js:438-442`）。
- 预览仅回截图（`web-control.js:465-499`，`handlePreview`）；交互仅允许
  归一化坐标点击、限长文本、白名单按键与有界滚动，拒绝任意 JS
  （`browser-driver.js:780-798` 的 `interact`，生成中直接拒绝见
  `browser-driver.js:782`）。
- 工具参数用 `JSON.parse` + 已知工具名白名单；工具协议的唯一定义处是
  `lib/agent-preset.js`（见 `doc/review-guide.md` 的不可越界约束）。
- 取消 / 超时先终止旧 executor 再释放队列；中继持有 master `AbortController`
  （`relay.js:105-130`）；有界队列（`relay.js:216-220`）；响应流大小限制
  （`web-control.js:27`、`openai.js:86`、`mirror.js:505-511`）。
- webServer 路由 disposer 收集卸载，防止热重载残留
  （`routeDisposers`，`index.js:1494`、`index.js:1503`、`index.js:1526`、
  `index.js:1538`，卸载 `index.js:1558-1564`）。
- 上下文 SHA256 检查历史改写与模型切换、失败不提交游标：
  本次未逐行复核该段实现，**未能确认**到具体行号，不在本文断言。

---

*本文只描述 `D:\9_Code_Workspace\dsh-webcode-bridge` 当前工作区里能读到的代码事实；
凡标注「未能确认」的条目，请评审者以源码为准。*