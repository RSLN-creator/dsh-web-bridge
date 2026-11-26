// sites/claude.js — CLAUDE site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

export const claudeSite = {
  id: 'claude', name: 'Claude', origin: 'https://claude.ai',
  completionPaths: ['/api/append_message'],
  input: 'div[contenteditable="true"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'claude', stream: true,
  // 未登录特征：游客页可见的 Sign in / Log in。claude.ai 对本机返回 403
  //（地区受限），这条同样是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'Claude', labels: ['Claude'], context: 200_000 },
  ],
};
