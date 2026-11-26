// sites/grok.js — GROK site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

export const grokSite = {
  id: 'grok', name: 'Grok', origin: 'https://grok.com',
  completionPaths: ['/rest/app-chat/conversations/new'],
  input: 'textarea[aria-label], textarea',
  attachSelector: "input[type='file']",
  decoder: 'grok', stream: true,
  // 未登录特征（2026-09-13 真机）：游客页有可见的「登录 / 注册」，且自带输入框
  // （空 profile 上实测 verify-login 回 true）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Sign up"), a:has-text("Sign up")',
  },
  models: [
    { id: 'auto', name: 'Grok', labels: ['Grok'], context: 256_000 },
  ],
};
