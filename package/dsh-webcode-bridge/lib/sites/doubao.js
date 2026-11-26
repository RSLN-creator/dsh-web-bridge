// sites/doubao.js — DOUBAO site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

// 豆包的账号头像选择器（**单一真源**，#59）：`loginProbe.ok` 与
// `accountProbe.avatar` 必须读同一组字符串。
//
// 缺陷现场（0.19.92 真机读数）：旧 `loginProbe.ok` 是
// `[class*="avatar"], .user-avatar, img[class*="avatar"]` —— **真机命中 0**
// （豆包真实头像的 class 是 `rounded-full object-cover select-none …`，不含
// "avatar" 语义），于是已登录的豆包只能落到 `probe-fallback`（= uncertain）。
// 同文件 `accountProbe.avatar` 早已有真机证据：头像 `<img src="…passport.byteacctimg.com/img/user-avatar/…">`
// 命中 1（36x36 @17,850）。以它为唯一真源，两个字段引用同一个数组，杜绝
// 「两处手写、迟早漂移」。
const DOUBAO_AVATAR_SELECTORS = Object.freeze([
  'img[src*="passport.byteacctimg.com/img/user-avatar"]',
  'img.rounded-full.object-cover.select-none',
]);

export const doubaoSite = {
  id: 'doubao', name: 'Doubao', origin: 'https://www.doubao.com',
  completionPaths: ['/samantha/chat/completion'],
  // 2026-09-13 真机校准：豆包输入框是 tiptap/ProseMirror 的 contenteditable
  // （div.tiptap.ProseMirror），不是 textarea。旧选择器只有 textarea，驱动侧
  // 定位输入框必然失败。
  input: 'div.tiptap.ProseMirror, div[contenteditable="true"], textarea[data-testid="chat_input_input"], textarea',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'doubao', stream: true, experimental: true,
  // 助手回复节点（0.19.89 补声明；真机读数见 long-term-issues #76）。
  //
  // ## 为什么必须声明（补之前它落在 DeepSeek 兜底串上 ⇒ **恒假读数**）
  //
  // 未声明时驱动用 `answerSelectorFor` 的兜底串
  // `.markdown, [data-message-author-role="assistant"], .ds-markdown`
  // ——那是 **DeepSeek 形状**，在 doubao 会话页命中 **0 个节点** ⇒
  //   `replyChars:0` / `selectorHit:false` 是**与页面实际内容无关的恒假读数**。
  // 真机现场（2026-10-17，**只读**导航 + DOM 双证据，零发送）：
  //   页面上**确有一段完整模型回复**（截图可见），而驱动报 `replyChars:0`。
  //   ⇒ 后果不只是日志难看：`browser-driver.js` 的看门狗与「捕获停摆兜底」
  //     都拿这个读数当「页面有没有说话」，于是**网页正常回复也会等到超时**。
  //
  // ## 选择器的依据（逐条只读实测，`test-mock/doubao-answer-precise.mjs` / `-pop-check.mjs`）
  //
  //   · doubao 用 **两个类名族**区分轮次：助手 = `receiveMessage`，用户 = `sendMessage`；
  //     ⇒ 该选择器**只命中助手轮**（实测 3 个可见），**不会**把用户提问读成回复；
  //   · 驱动用 `[...querySelectorAll(sel)].pop()` 取**最后一个**匹配 ⇒
  //     实测读到的是**最后一条助手消息**（150 字，正是那段回复），
  //     且该节点内**不含** `sendMessage` 结构（`hasSendInside:0`）⇒ 判定为助手成立；
  //   · 刻意用 **`[class*="…"]` 属性包含匹配**而不是 `.receiveMessage`：
  //     实测后者命中 **0**（类名是 `receiveMessage` 与一串 Tailwind 工具类**空格分隔**，
  //     `querySelector('.receiveMessage')` 应当也能命中，但真机上确实为 0
  //     ⇒ 以**实测**为准，取包含匹配）。这是「选择器必须来自真机读数」那条纪律的一次应用。
  //
  // ⚠ 与 zai / glm 的答案不同是**正常的**：那两家的容器类名完全不同
  //（zai=`div.chat-assistant`；glm=`div.markdown-body` 一族）。本条**只**服务 doubao。
  answerSelector: '[class*="receiveMessage"]',
  // 未登录特征：游客页有可见的「登录」按钮；登录后该按钮消失。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    // ok（#59）：与 `accountProbe.avatar` **同源**（见上方 DOUBAO_AVATAR_SELECTORS）。
    // 旧值三条在真机上全部命中 0 ⇒ 已登录豆包恒为 probe-fallback（不确定）。
    ok: DOUBAO_AVATAR_SELECTORS.join(', '),
  },
  // 真实昵称/头像（2026-10-03 真机取证，证据
  // `test-mock/out/account-identity-live-doubao-2026-10-03T17-17-55.json`）。
  //
  // 豆包的用户区在**侧栏左下角**，是一行「36×36 圆头像 + 昵称」：
  //   · 头像 `<img class="rounded-full object-cover select-none mr-8 h-36 w-36"
  //           src="https://p26-passport.byteacctimg.com/img/user-avatar/…">`
  //           —— 落点是**账号头像 CDN**（`passport.byteacctimg.com/img/user-avatar`），
  //           不是站点自己的素材域，因此这条既能锚定账号头像、又不会误抓站点图标；
  //   · 昵称是头像**右侧那个兄弟** `<span class="min-w-0 overflow-hidden text-left …">`
  //     （真机读数里它的文本就是该账号的昵称）。
  //
  // ⚠ 两个都**不含**「user / avatar / nickname」任何语义词，所以通用猜测一律读不到
  //（这正是用户报的「豆包没用上真实账户名」的真因）；必须显式声明。
  // ⚠ 昵称那条用的是 Tailwind 工具类组合，属于「次优但有真机读数」的选择器——
  // 若豆包改版后读不到，先重跑 `node test-mock/probe-account-identity-live.mjs doubao`
  // 取新读数再改，**不要凭印象换一个**（本项目纪律：选择器必须来自真机读数）。
  accountProbe: {
    name: ['span.min-w-0.overflow-hidden.text-left'],
    avatar: DOUBAO_AVATAR_SELECTORS,
  },
  // 模式选择契约 —— 真机 dump（2026-09-13，test-mock/out/doubao-mode-*.json）：
  //   豆包的「对话 / 工作」是常驻在输入框附近的**分段控件**（不是弹层）：
  //     容器 <div class="relative flex h-54 items-center justify-center rounded-full p-[3px] bg-dbx-fill-trans-20 mt-20">
  //       选项 <button class="… w-160 … text-dbx-text-primary">  <span class="truncate">对话</span>
  //            <button class="… w-160 … text-dbx-text-secondary"><span class="truncate">工作</span>
  //
  // ⚠ 2026-09-28 更正一条**曾经写错的事实**：本注释原先写着「豆包没有下拉式模型选择器」。
  // 真机读数（`test-mock/out/think-control-doubao-2026-09-28T10-36-23.json`）证明它有，
  // 而且是**两个独立的控件**：
  //   · 分段控件 「对话 / 工作」                     —— 本 modelPicker 契约管它；
  //   · 模型下拉 `[data-testid="chat_input_action_model"]` 显示「豆包 快速」/ 点开是
  //     「豆包 快速」「豆包 2.1 Turbo专家」两条      —— 用户原话里的「左下角有模型和
  //     思考等级选择」，走 think-effort.js 的 doubao 条目（档位 = 徽章 快速/专家）。
  // 两者是**两个契约、两条链**，不共用选择器，也不互相覆盖。
  modelPicker: {
    segmented: true,
    option: 'div.bg-dbx-fill-trans-20.rounded-full > button, button.w-160',
    optionName: ['span.truncate'],
    selectedStateClass: 'text-dbx-text-primary',
    unselectedStateClass: 'text-dbx-text-secondary',
  },
  models: [
    // 本地默认：**对话**（豆包标准对话模式）。放在最前即首选。
    // 具体用到哪一档模型/档位由 think-effort.js 的 doubao 条目下发（快速 / 专家）。
    { id: 'chat', name: '对话', labels: ['对话'], context: 256_000, acceptsImages: true },
    { id: 'work', name: '工作', labels: ['工作'], context: 256_000, acceptsImages: true },
    // ⚠ 0.19.43 起**真删** auto（原显示名「豆包」）。理由与 GLM/Kimi 同构：
    // modelPicker 的 segmented 契约已声明，网页真实档位是 对话 / 工作 两个模式。
    // 历史 id `doubao:auto` 仍由 ALIASES 解析。
  ],
};
