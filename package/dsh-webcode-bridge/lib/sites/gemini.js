// sites/gemini.js — GEMINI site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

export const geminiSite = {
  id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com',
  completionPaths: [],
  input: 'div.ql-editor[contenteditable="true"], div.ql-editor, rich-textarea textarea, textarea, div[contenteditable="true"]',
  attachSelector: "input[type='file']",
  decoder: 'dom', stream: false, experimental: true,
  // 未登录特征：gemini 游客页有可见的「登录」按钮（.signed-out-buttons 内），
  // 登录后换成账号头像。旧判定只看输入框，游客页的 ql-editor 让未登录被记成
  // 已登录（真机 2026-09-13：verify-login 报 true，页面却明写「登录」）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in")',
  },
  models: [
    { id: 'auto', name: 'Gemini', labels: ['Gemini'], context: 1_000_000 },
  ],
};
