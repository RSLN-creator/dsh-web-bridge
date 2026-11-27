// sites/zai.js — ZAI site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

import { GLM_CONTEXT_WINDOW } from './constants.js';

export const zaiSite = {
  // 0.21.1 修：海外站 origin 必须是 chat.z.ai。0.19.99 曾把它改成 zchat，虽然
  // 0.21.0 已把中国站拆成独立站点 ZAI_CN，但这里漏改回来 ⇒ 两站指向同一域名，
  // 违反用户 2026-10-20「国内国外是两个站点」的明令（已由 login-sites 实测抓到）。
  id: 'zai', name: 'Z.ai', origin: 'https://chat.z.ai',
  // 选择器里显示的站点键。默认等于 id，只有这里不同：站点的真实身份就是
  // 「z.ai」这个域名（用户要的正是「一眼看出是哪个网站」），而 `zai` 只是
  // 我们内部的路由 id。二者不同不影响解析——解析只认 id（见 resolveWebModel）。
  shortKey: 'z.ai',
  // 静态资源域：z.ai 的前端包/字体放在独立域上，跨域 + 非法 ACAO 会被浏览器
  // 拒绝执行（与 DeepSeek 同一类问题）。纳入同源转发（lib/mirror.js）。
  // api.z.ai 是前端调后端的绝对域（真机 probe-net 实测），不代理则页面提示
  // 「无法连接到服务」。
  staticOrigins: ['https://z-cdn.chatglm.cn', 'https://api.z.ai'],
  // 镜像页需要看到根路径（真机证据 2026-09-13）：
  // z.ai 的前端 router 只认根路径。同一个镜像挂在 /__webcode/site/zai/ 下时，
  // 它的错误边界会渲染「200: An unexpected error has occurred.」——接口全部
  // 200 + 正确 JSON，纯粹是路由基线不匹配；把 pathname 改写成 '/'（其余资源
  // 已由镜像改写成带前缀的绝对路径，运行时根相对请求由 bootstrap 钩子补前缀）
  // 后立刻恢复成正常界面（输入框出现）。GLM 不需要这个开关。
  rootPathForSpa: true,
  // ⚠ 2026-10-14 真机更正：真机 completion 打到 **`/api/v2/chat/completions`**，
  //   而原声明只有 v1 与无版本两条 ⇒ **缺 v2**。逐字读数（那一轮 summary.network）：
  //     `RES 200 text/event-stream; charset=utf-8
  //      https://chat.z.ai/api/v2/chat/completions?timestamp=…&requestId=…`
  //   这条漏声明是**静默**的：捕获层按声明匹配 ⇒ 一个块都接不到，而页面正常渲染。
  completionPaths: ['/api/v2/chat/completions', '/api/v1/chat/completions', '/api/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // z.ai 对程序化 Enter 不响应，必须点发送按钮（真机 2026-09-12：轮次静默挂死正因如此）。
  sendButton: '#send-message-button',
  attachSelector: "input[type='file']",
  // 附件落到页面上的可见证据（上传确认用，见 browser-driver 的 waitForAttachment）
  attachPreview: "img[src^='blob:'], [class*='attachment'], [class*='file-card']",
  // 助手回复节点选择器（0.19.19 的契约位；2026-09-27 真机实测改写）。
  //
  // ## 旧值为什么必须换掉（真机读数，不是推断）
  //
  // 夹具 `test/fixtures/zai-real-dom/zai-chat-dom-inventory.json` 是真机会话页面的
  // 293 个元素的逐字清单（tag/class/id/父索引/innerText 长度，消息 uuid 已脱敏）。
  // 在它上面复算旧值的命中集合是**逐条可核**的（下表每行只写标签名与命中数，
  // 完整选择器见上一行）：`div.markdown-body` 与 `.markdown-body` 各 **0** 次
  // （z.ai 页面上没有这个 class），`[class*="prose"]` **2** 次（#151 用户消息
  // 53509 字、#172 助手轮容器 0 字），`[class*="message"]` **4** 次
  // （#148 用户轮外壳、#160 编辑按钮、#168 助手轮外壳，以及
  // **#184 div.w-full.messageInputContainer.font-primary（输入框容器）**），
  // `main` **0** 次（页面上根本没有 main 元素）。
  // 驱动的读取语义是 `[...querySelectorAll(sel)].pop()` = **文档序最后一个**命中节点。
  // #184 是输入框容器，且它排在 #172 之后 ⇒ 旧值的最后一次命中恒为它，innerText 恒为
  // 「深度思考\n最高」= **7 字**。三处独立读数逐字吻合：
  //   · 夹具复算：`.pop()` = #184，chars=7；
  //   · 落地页（无会话）实测：命中 1 个节点，就是它，7 字；
  //   · 事故轮次 240s 超时现场：驱动报 `replyChars: 7`。
  // 也就是说 `WEB_NO_PROGRESS … 页面已有 7 字回复未回传` 里的「7 字回复」**从来不是回复**，
  // 是输入框容器的 innerText。按本项目纪律（报错必须指向真因），这条假读数比没有读数更贵：
  // 它把排查方向引向「解码器对不上」，而真因在别处（见下一条 decoder 注释）。
  // 危害不止于日志：它让 `answerSelector` **恒定命中**且文本恒定 7 字 ⇒
  // ① `domFound` 恒真、`lastDomGrowthAt` 永不刷新（「页面还在长 → 绝不动」这道保护对 zai 是死的）；
  // ② 捕获停摆兜底（captureStallRescueMs）拿到的「页面正文」就是这个输入框容器文本，
  //    一旦 `domTextChanged` 成立，桥会把「深度思考\n最高」当成本轮回答交给上层。
  //
  // ## 新值的依据（同一夹具的真机读数）
  //
  // #151 是用户消息节点（`div.chat-user … markdown-prose`，chars=53509）；
  // #172 是助手轮容器（`div.chat-assistant … markdown-prose`，chars=0）；
  // #174 是它的子节点响应正文区（`div#response-content-container`，chars=0）。
  // 新值命中 2 个（#172、#174），`.pop()` = #174，chars=0 —— 即「页面确实什么都没说」，
  // 如实报 0，而不是 7。
  // `div.chat-assistant` 与 `#response-content-container` 都是**语义特征**（前端用来标记
  // 「这一轮是谁说的 / 响应正文放哪」），不是 `.svelte-xxxx` 那种编译期哈希——与
  // `div.chat-user` 同族，改版时更稳。两个都留：`#response-content-container` 更靠内
  // （读到纯正文，不带助手轮外壳文案），`div.chat-assistant` 是它的父级兜底，
  // 于是「外壳在、正文区还没挂上」时也不会退化成读不到任何节点。
  //
  // ## ⚠ 这一改**不会**让 z.ai 变成可用——真正的拦路虎不在选择器
  //
  // 2026-09-27 真机四轮复现（headless×3、headed×1，全部 0 帧）：**completion 请求根本没发出去**。
  // 站点自带前端（z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.96/assets/index-p_7VciLU.js）
  // 逐字写着这条闸门：站点特性里 `enable_captcha` 为真时，前端会先 await 一次
  // 阿里云验证（`HN()`）拿到 `lc`，再把它传给发请求的 `bhe()`；`bhe` 内部才是
  // fetch `…/api/chat/completions`。自动化环境下那次 await **停在页面上不返回**，
  // 于是 `bhe` 永不执行；同页 `#chat-captcha-element`、`#chat-captcha-trigger` 可见，
  // 滑块窗口在 headless 轮次里带 `window-show` 全显。
  // ⇒ 本文件的 decoder/completionPaths **都不是**本轮失败的原因，别在这里找。
  answerSelector: 'div.chat-assistant, #response-content-container',
  // 风控闸的**可见证据**（声明位；读取与判定的接线在 lib/browser-driver.js，见下）。
  //
  // 为什么需要它：本轮失败的报告是 `WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容
  // （… 页面已有 7 字回复未回传）`——用户等满 240s，读到的却是一句由假读数拼出来的
  // 归因（见 answerSelector 的长注释）。而真因在页面上一眼可见。驱动应当在**发送后**
  // 周期性检查这个选择器；命中且可见时立刻抛一条可读错误（建议 code
  // `WEB_CAPTCHA_REQUIRED`，文案里带上「站点弹出了滑块/人机验证，请在弹出的窗口里
  // 手动通过后重试」），**不要**继续等 120s/240s 的看门狗。
  //
  // 真机读数（本轮，`shown` = offsetWidth||offsetHeight||getClientRects().length）：
  //   · 发送前（落地页，probe-zai-resume-shape.mjs）：`[id*=captcha],[class*=captcha]`
  //     查询命中 **0 个节点** —— 即这些节点不是常驻的，可以做触发器；
  //   · 发送后 headless（probe-zai-chat-frames.mjs）：`#chat-captcha-element`、
  //     `#chat-captcha-trigger` 可见，且 `#aliyunCaptcha-window-popup.window-show` 整窗可见；
  //   · 事故页面（live-cdp/dom-inventory.json #269/#270/#272）：同上，`window-show`。
  // ⚠ 如实标注两处局限：
  //   ① 「发送前不存在」只有**落地页**那一条读数；一次**成功**轮次里这些节点长什么样
  //      **没有读数**（本轮没有任何一次成功轮次）。所以判定必须带**可见性**，
  //      且失败方向上宁可漏报也不能把正常轮次判死——建议只在**发送后**检查，
  //      并在命中时如实写进 navTrace/诊断，而不是当唯一判据。
  //   ② 有头轮次里滑块窗口未显（只有 `#chat-captcha-element`/`#chat-captcha-trigger` 可见），
  //      所以**不能**只认 `#aliyunCaptcha-window-popup`，否则会漏掉那一种形态。
  captchaSelector: '#chat-captcha-element, #aliyunCaptcha-window-popup.window-show',
  // ✅ decoder 已落地（2026-10-14）：**真机帧已取得**，`decoder: 'zai'`（`lib/decoder.js` 的
  // `ZaiDecoder`）。此前长期挂「没有 wire 证据 ⇒ 刻意不改」，理由是「已知解不出好过猜着解不出」。
  //
  // 真机帧逐字夹具：`test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`（护栏
  // `test/zai-decoder.test.mjs`）。线上形状（每个事件一行，**不是** OpenAI 的 choices）：
  //   data: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking"}}
  //   data: {"type":"chat:completion","data":{"phase":"other","usage":{…}}}
  //   data: {"type":"chat:completion","data":{"delta_content":"你好呀","phase":"answer"}}
  //   data: {"type":"chat:completion","data":{"phase":"done","done":true}}
  //
  // 先前**只有**站点 bundle 的代码证据（帧处理器 di 的解构 `{id, done, content, delta_content,
  // …phase…}`），当时据此推断的形状**方向正确**：正文/思考都在 `delta_content`、靠 `phase` 分流、
  // 收尾看 `done`；`choices` / `parts` / `reasoning_content` 在该 bundle 里均为 0 次
  // ⇒ 既不是 `choices[].delta.content`（OpenAISseDecoder）也不是 `parts[].content[].type`
  // （GlmDecoder）——「z.ai 用 GLM 帧」这条假设**被推翻**（现由真机帧确认）。
  //
  // 真机帧还改正了本条目**另一处**声明缺陷：`completionPaths` 原缺 `/api/v2/…`（见上方注释）。
  //
  // ⚠ 取证步骤的落点（2026-10-14 改正）：本条原先把读者指向 `.tmp-probe/zai/RESULT.md`，
  // 而 `.tmp-probe/` 被 `.gitignore:61` 覆盖 ⇒ **对克隆仓库的人不存在**。而那句话说的不只是
  // 「读数在那里」，是「**确切步骤**在那里」——即离开它就无法重跑，正是 `wiki/protocol.md` §5
  // 禁止的形态。步骤与探针已入库：
  //   · 步骤 → `doc/runbooks/zai-capture-frames.md`
  //   · 探针 → `test-mock/zai-capture-frames.mjs`（`PROBE_HEADED=1`，需人工过一次滑块）
  // 另：本条原先写「见 doc/long-term-issues.md 第 14 条」，**条号是错的**——第 14 条是
  // 「Z.ai 没有会话地址形状」（0.19.52 已收口）；帧格式的登记条目是 **§30**。
  decoder: 'zai', stream: true, experimental: true,
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    ok: '.user-avatar, [class*="avatar"], button[aria-label*="User"]',
  },
  // 模型选择契约 —— 全部来自 probe-model-dropdown.mjs 的真机 dump
  //（2026-09-13，证据 test-mock/out/model-dropdown-zai-*.json）：
  //   触发  <button class="modelSelectorButton" aria-label="选择一个模型">GLM-5.3-Flash</button>
  //   弹层  <button aria-label="model-item"> … <div class="line-clamp-1">GLM-5.3</div> …
  // 实测选项（逐字）：GLM-5.3-Flash / GLM-5.3 / GLM-5.2
  //
  // 注意 "GLM-5.3" 是 "GLM-5.3-Flash" 的**前缀** —— 这正是 model-picker 必须做
  // 精确名匹配、不能做前缀匹配的原因（0.12.9 的 getByText 启发式会选错模型）。
  modelPicker: {
    trigger: ['button.modelSelectorButton', '[aria-label="选择一个模型"]'],
    option: "button[aria-label='model-item']",
    optionName: ['.line-clamp-1'],
    selected: ['button.modelSelectorButton'],
  },
  models: [
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-5.3-Flash'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.2', name: 'GLM-5.2', labels: ['GLM-5.2'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    // ⚠ 0.19.43 起**真删** auto（原显示名「Z.ai」）。理由与 glm 逐字同构：
    // modelPicker 已声明，网页真实档位就是 GLM-5.3-Flash / GLM-5.3 / GLM-5.2 三条。
    // 历史 id `zai:auto` 仍由 ALIASES 解析（它与 `glm:auto` 是两条不同的别名，
    // 各自收敛到**本站点**的档位，不许互相串站点）。
  ],
};
