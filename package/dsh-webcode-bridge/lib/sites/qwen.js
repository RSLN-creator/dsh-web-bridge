// sites/qwen.js — QWEN site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

export const qwenSite = {
  id: 'qwen', name: 'Qwen', origin: 'https://chat.qwen.ai',
  staticOrigins: ['https://g.alicdn.com', 'https://img.alicdn.com', 'https://assets.alicdn.com'],
  // 浏览器端为 OpenAI 兼容 SSE。2026-09-12 真机：流端点已迁到
  // /api/v2/chat/completions（v2 + completions，含 /api/chat 的旧串不再命中），
  // 子串匹配同时覆盖新旧端点。
  completionPaths: ['/api/chat', '/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // Qwen Studio（2026-09-12 真机）：程序化 Enter 不触发发送（消息停在框里），
  // 发送按钮是稳定特征 class .send-button（aria=发送）——与 z.ai 同类问题。
  sendButton: '.send-button',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'openai-sse', stream: true, experimental: true,
  // 未登录特征（2026-09-13 真机）：qwen 游客页**自带完整输入框**
  // （textarea.message-input-textarea 可见），旧判定「有输入框=已登录」于是把
  // 未登录记成已登录——用户看到的正是「qwen 没有登录却直接显示登录了」。
  // 游客页右上角有可见的「登录 / 注册」按钮，命中即判未登录。
  //
  // ## 0.19.78：`ok` 补 `img.user-img`（真机读数，与 doubao 同型缺陷）
  //
  // 旧 `ok` 是 `.user-avatar, [class*="user-avatar"], [class*="userAvatar"],
  // .header-user-avatar` —— **四条在真机上全部命中 0**（2026-10-14 有头窗口实测）：
  // qwen 登录后的头像元素是 **`<img class="user-img" src="data:image/png;base64,…">`**
  // （在侧栏左下角 `.user-menu-btn-content-left` 里，30x30）。
  // ⇒ 已登录的 qwen 拿不到 `probe-ok`，只能落到 `probe-fallback`（按 #53 三态 = `uncertain`），
  //   面板显示不出「已登录」——**与 doubao 的 #59 是同一条缺陷**（声明与真机元素名不符）。
  //
  // 判据来自同一页面两次对照：**游客壳 `img.user-img` = 0，水合后 = 1**
  // （见 `doc/long-term-issues.md` #62 的时间线表），因此它是可靠的**正向**特征。
  // ⚠ 保留原有四条（别的版本/布局可能仍用 `.user-avatar` 一族），只**追加**不替换：
  //   多一条真机命中的候选只会让判定更准，不会把未登录判成已登录
  //   （`bad` 仍在**前面**先判，且未登录时这些头像元素本就不存在）。
  loginProbe: {
    bad: 'button:has-text("登录"), button:has-text("注册"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    ok: 'img.user-img, .user-avatar, [class*="user-avatar"], [class*="userAvatar"], .header-user-avatar',
  },
  models: [
    { id: 'auto', name: 'Qwen', labels: ['Qwen'], context: 1_000_000 },
  ],
};
