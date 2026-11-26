// sites/chatgpt.js — CHATGPT site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

export const chatgptSite = {
  id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com',
  completionPaths: ['/backend-api/conversation'],
  input: '#prompt-textarea, textarea[data-id], textarea',
  attachSelector: "input[type='file']",
  decoder: 'chatgpt', stream: true,
  // 未登录特征：游客页可见的 Log in / Sign up 入口。本机网络层对 chatgpt.com
  // 返回 403（WAF），这条判定目前更多是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'ChatGPT', labels: ['ChatGPT'], context: 196_000 },
  ],
};
