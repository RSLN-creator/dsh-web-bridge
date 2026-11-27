// sites/kimi.js — KIMI site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

// kimi 的账号身份选择器（**单一真源**，#65）：`loginProbe.ok` 与 `accountProbe`
// 读同一份**证据**，但登录判定只能取其中的**精确子集**。
//
// ## 缺陷现场
//
// `loginProbe` 原先只有 `bad`、没有 `ok` ⇒ 已登录的 kimi 只能落到
// `probe-fallback`（按 #53 三态 = uncertain），面板显示不出「已登录」。
// 同文件 `accountProbe` 早有真机证据：昵称 `span.user-name` = "TYZ0712"、
// 头像 `img.user-avatar`（src 落在 `avatar.moonshot.cn`）。
//
// ## 为什么两处**不**逐字共用同一组（2026-10-19 live 真机读数）
//
//   · `span.user-name`       —— 登录判定 ok 用（live c1v1 命中）；
//   · `img.user-avatar`      —— 登录判定 ok 用（live c1v1 命中）；
//   · `img[src*="avatar.moonshot.cn"]` —— **不得**进 loginProbe.ok：live 读数
//     c3v3，会命中侧栏的插件图标 ⇒ 用它判登录会误报。它只用于**身份打分**
//     （accountProbe.avatar，读不到昵称时靠它找头像）。
//
// 因此常量分层：精确子集（登录判定）与宽集合（身份打分）各一份，宽集合显式
// 引用精确子集，杜绝同一字面量写两遍。
const KIMI_ACCOUNT_NAME_SELECTORS = Object.freeze(['span.user-name']);
// 登录判定用的精确头像选择器（live 真机 c1v1）。
const KIMI_LOGIN_AVATAR_SELECTORS = Object.freeze(['img.user-avatar']);
// 身份打分用的宽集合：精确子集 +头像 CDN 的 src 包含匹配（live c3v3，含插件图标）。
const KIMI_ACCOUNT_AVATAR_SELECTORS = Object.freeze([
  ...KIMI_LOGIN_AVATAR_SELECTORS,
  'img[src*="avatar.moonshot.cn"]',
]);

export const kimiSite = {
  // 2026-09-11 实测：kimi.moonshot.cn 已只剩 302 → https://www.kimi.com/，
  // 镜像按旧域名取页会拿到空跳转壳，右侧栏打不开。改用真实站点。
  id: 'kimi', name: 'Kimi', origin: 'https://www.kimi.com',
  // Measured Kimi composer ceilings: prefer attachments above 8k; inline is unsafe above 200k.
  limits: {
    attachInlineLimitChars: 8_000,
    composerHardLimitChars: 200_000,
  },
  staticOrigins: ['https://statics.moonshot.cn'],
  // 真实流端点带动态会话 id：/api/chat/{id}/completion/stream（Kimi-Free-API 同构），子串匹配。
  // 2026-09-21 真机 CDP 确证：kimi 网页已从旧 SSE **全面迁移到 Connect-RPC**——
  // 发送/回复走 `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`（application/connect+json），
  // 响应为二进制帧流 [flags(1)][len(4BE)][json]。旧 /api/chat 端点不再被网页使用，
  // 必须命中新端点并走 connect 二进制帧切分，否则捕获链零回传（页面有回复却超时）。
  completionPaths: ['/apiv2/kimi.gateway.chat.v1.ChatService/Chat', '/api/chat/', '/completion/stream'],
  streamTransport: 'connect',
  // 2026-09-13 真机校准：kimi 网页**没有 textarea**，输入框是 contenteditable
  // 的富文本编辑器（div.chat-input-editor）。旧选择器只有 textarea，输入框
  // 计数恒为 0 → 已登录的 profile 被判成「未登录」，设置页/右栏徽标永远显示
  // 「未登录」，点「检测」也没用（检测走的就是同一个输入框判定）。
  input: 'div.chat-input-editor, div[contenteditable="true"], textarea.chat-input, textarea[placeholder], textarea',
  // 发送控件（2026-09-27 真机取证补上；此前 kimi 走「按 Enter」的默认路径）。
  //
  // ## 为什么必须声明它（带附件的轮次此前发不出去）
  //
  // 真机现场（`.tmp-probe/kimi/lead-send-out.json`，sentinel 探针逐拍读数）：
  //   · 附件上传**完成前**，控件是 `<div class="send-button-container disabled">`；
  //     那一刻按 <kbd>Enter</kbd>，网页**完全不响应**——Enter 后 0.4s / 2.0s 两次采样，
  //     输入框长度恒为 81、地址栏恒为 `https://www.kimi.com/`、附件 chip 恒在；
  //   · `disabled` 类消失后**点它**：输入框立刻变成 1（只剩换行）、chip 清 0、
  //     地址栏切到 `/chat/<uuid>` ⇒ **发送成功**。
  //
  // 也就是说「按 Enter」这条路在 kimi 上从一开始就不可靠，而附件让它**必然**失败
  // （上传窗口内 Enter 无效，旧实现的「点按钮 → 回车 → 再点按钮」全落在窗口内）。
  // 驱动侧配套改动：发送前先等这个控件的 `disabled` 类消失（判据见
  // browser-driver 的 sendReady），而不是等一个固定时长——上传耗时随文件大小变化。
  sendButton: '.send-button-container',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'kimi-connect', stream: true,
  // 未登录特征：游客页有可见的「登录」入口（真机实测未登录镜像页文案为
  // 「登录以同步历史会话」+「登录」）。已登录页这两个入口都消失。
  // 注意必须限定 button/a——不限定的 :has-text 会命中包含该文案的祖先 div，
  // 已登录页的其它节点一旦出现「登录」二字就会误判。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    // ok（#65）：取 `accountProbe` 证据里的**精确子集**——昵称 `span.user-name`
    // 与头像 `img.user-avatar`（live 真机两者均 c1v1 命中）。**不含**
    // `img[src*="avatar.moonshot.cn"]`：该宽串 live c3v3，会命中侧栏插件图标
    // ⇒ 放进登录判定会误报已登录（宽集合只用于身份打分，见上方常量注释）。
    ok: [...KIMI_ACCOUNT_NAME_SELECTORS, ...KIMI_LOGIN_AVATAR_SELECTORS].join(', '),
  },
  // 真实昵称/头像（2026-10-03 真机取证，证据
  // `test-mock/out/account-identity-live-kimi-2026-10-03T17-17-55.json`）：
  //   · 昵称 `span.user-name` = "TYZ0712"（此前靠通用 `[class*="user-name"]` 恰好命中，
  //     现在**显式声明**，不再依赖「类名里恰好含 user-name」这个巧合）；
  //   · 头像 `img.user-avatar`，src 落在 `avatar.moonshot.cn`（score 18，全页最高）。
  accountProbe: {
    name: KIMI_ACCOUNT_NAME_SELECTORS,
    avatar: KIMI_ACCOUNT_AVATAR_SELECTORS,
  },
  // 模型选择契约 —— 真机 dump（2026-09-13，test-mock/out/model-dropdown-kimi-*.json）：
  //   触发  <div class="model-name"><span class="current-effort">进阶</span></div>
  //   弹层  <button role="menuitemradio" class="model-item[ checked]">
  //           <span class="header">K3</span><span class="desc">擅长对话与 Agent 任务，全能旗舰</span>
  //   实测选项（逐字）：快速 / K3 / K3 集群
  //
  // ⚠️ 触发节点的文本是**当前思考强度**（「快速」或「进阶」），不是模型名 ——
  // 触发只能按 class 定位，绝不能按文本「快速」定位（那会随强度档位变化，
  // 也是 probe-model-picker 首跑用 getByText 没抓到模型触发的原因）。
  modelPicker: {
    trigger: ['.model-name', '.current-effort'],
    option: 'button[role="menuitemradio"].model-item',
    optionName: ['.header'],
    // 回读口径②：kimi 的触发按钮只显示「思考强度」（快速/进阶），模型名只在
    // **展开的菜单**里以选中态出现。readbackInMenu 让 picker 重新开菜单读
    // checkedOption 的 .header（即当前选中的模型名）。
    // 真机 verify-model-switch 首跑读到「进阶」，无法判断模型是否真的换了。
    readbackInMenu: true,
    checkedOption: 'button.model-item.checked',
    scopedToComposer: true,
  },
  models: [
    { id: 'k3', name: 'K3', labels: ['K3'], context: 1_000_000, acceptsImages: true },
    // 2026-09-28 真机：菜单第三行是 **K2.8 Preview**（它的模型行读作「快速」是因为
    // 当前档位徽章与名字同字，见 think-effort.js 的 kimi 条目注释）。
    // 同一次读数里 **K3 集群 已从菜单消失**——网页侧把它挪进了「+ 号面板」
    //（菜单顶部横幅原文：「集群功能已移动至+号面板中」），因此模型表**真删**
    // `k3-cluster`：留着它就是一行点了会 option-not-in-list 的死条目。
    // 历史 id `kimi:k3-cluster` / `k3-cluster` 仍由 ALIASES 收敛到 K3（旧会话不断链）。
    { id: 'k2.8-preview', name: 'K2.8 Preview', labels: ['K2.8 Preview'], context: 1_000_000, acceptsImages: true },
    { id: 'quick', name: '快速', labels: ['快速'], context: 1_000_000 },
    // ⚠ 0.19.43 起**真删** auto（原显示名「Kimi」）。理由与 GLM 逐字同构：
    // `modelPicker` 已声明，网页真实档位是 快速 / K3 / K3 集群 三条，auto 是桥自己
    // 发明的「不切换」档。历史 id `kimi:auto` 仍由 ALIASES 解析（见那里）。
  ],
  navigation: {
    fromUrl: (url) => {
      const parts = url.pathname.split('/');
      const id = parts[1] === 'chat' ? parts[2] : null;
      return id && /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : null;
    },
    toUrl: (origin, id) => origin + '/chat/' + encodeURIComponent(id),
  },
};
