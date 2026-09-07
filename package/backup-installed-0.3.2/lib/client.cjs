// client.cjs — dsh-webcode-bridge · browser half.
//
// Right-edge toggle button + slide-in control panel. The web AI is driven by
// the in-package browser driver (playwright-core + system Edge, persistent
// profile) — no extension. The panel talks to the SAME-ORIGIN /__webcode/*
// routes the host half registers on the DSH web server (no CORS surface);
// when those are absent (standalone relay) it falls back to the relay's
// /bridge/web/* routes.
//
// Panel sections:
//   • one-time login + per-session risk consent gate
//   • 打开官网 — real chat.deepseek.com in a dedicated desktop window via the
//     standard window.dsh.desktop SDK (WebView2 host message), falling back to
//     a new browser tab (iframe embedding is impossible: the site's CSP
//     forbids framing — a real window/tab is the only honest "real-time site"
//     mirror view — the REAL chat.deepseek.com UI served through the relay's
//     reverse proxy (the site CSP forbids direct framing) — fully interactive.
//   • 网页会话 — real-time conversation feed from the web side (titles the
//     site generates) and one-click import of any conversation into DSH as a
//     resumable session (branch messages skipped, main line imported).
//
// Format follows dsh-free-models-hub: window.__ModuleLoader__.load with
// id = package name.

window.__ModuleLoader__.load({
  id: 'dsh-webcode-bridge',
  factory: function (require, module) {
  'use strict';

  const NAME = 'webcode-bridge-client';
  const inject = ['settingsScope'];

  const DEFAULTS = {
    port: 8931,
    host: '127.0.0.1',
    site: 'https://chat.deepseek.com/',
  };

  const STR = {
    title: 'Web AI 桥接',
    step1: '1. 点「打开登录窗口」，在弹出的 Edge 里登录 DeepSeek（仅一次）',
    step2: '2. 勾选下方同意（每次 DSH 启动后需确认一次）',
    step3: '3. DSH 模型选择器选 Web AI (webcode)，之后调用全自动、后台无感',
    note: '自动化在包内驱动器中完成：无扩展、无 iframe。自动化操作网页可能违反站点条款，风险自担。',
    needLogin: '需要登录：点上方按钮完成一次性登录',
    notRunning: '驱动未启动',
    noconsent: '未同意风险告知（勾选下方复选框）',
    connected: '就绪：可无感调用',
    busy: '调用中…',
    consentLabel: '我已阅读并理解自动化风险（可能违反站点条款，存在限流/封号风险），自愿启用',
    openLogin: '打开登录窗口',
    openSite: '打开 DeepSeek 官网（独立窗口）',
    mirrorTitle: '官网原生界面（可直接对话）',
    mirrorReload: '刷新',
    mirrorIdle: '加载真实官网…（登录态自动注入）',
    sessionsTitle: '网页会话（实时）',
    sessionsRefresh: '刷新列表',
    sessionsEmpty: '尚无会话数据，点「刷新列表」获取',
    sessionsLoading: '获取中…',
    importBtn: '导入',
    importing: '导入中…',
    workspaceLabel: '导入到工作区',
    close: '收起',
  };

  function resolveConfig(ctx) {
    const cfg = { ...DEFAULTS };
    try {
      const scope = ctx && ctx.settingsScope;
      if (scope && typeof scope.bind === 'function') {
        const bound = scope.bind({ namespace: 'webcode' });
        const value = typeof bound?.get === 'function' ? bound.get() : null;
        if (value && typeof value === 'object') {
          if (Number.isFinite(value.port)) cfg.port = value.port;
          if (typeof value.host === 'string' && value.host) cfg.host = value.host;
        }
      }
    } catch { /* defaults are fine */ }
    return cfg;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children) node.appendChild(child);
    return node;
  }

  /** Real chat site, real window: the standard desktop SDK first (dsh-desktop
   *  hosts inject window.dsh.desktop; legacy hosts expose the WebView2 bridge
   *  directly), then a plain new tab — the site's CSP forbids iframes, so a
   *  real window is the only true "live official site" surface. Mirrors
   *  dsh-deepseek-chat's proven fallback chain. */
  function openChatSite(site) {
    try {
      const dsh = window.dsh && window.dsh.desktop;
      const raw = (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) ? window.chrome.webview : null;
      if (dsh && typeof dsh.openWindow === 'function') {
        const p = dsh.openWindow({ url: site, title: 'DeepSeek 网页对话' });
        if (p && typeof p.catch === 'function') p.catch(() => { window.open(site, '_blank'); });
        return 'desktop-window';
      }
      if (raw) {
        raw.postMessage(JSON.stringify({ type: 'dsh.desktop.openWindow', url: site, title: 'DeepSeek 网页对话' }));
        return 'desktop-window';
      }
    } catch { /* fall through to tab */ }
    window.open(site, '_blank', 'noopener');
    return 'tab';
  }

  function apply(ctx) {
    const cfg = resolveConfig(ctx);
    const relayBase = `http://${cfg.host}:${cfg.port}`;
    const statusUrl = `${relayBase}/bridge/status`;

    // API base: prefer the same-origin /__webcode routes (host half registers
    // them on the DSH web server); fall back to the relay once, at boot.
    let apiBase = null;
    let mirrorLoaded = false;

    let expanded = false;
    let statusTimer = null;


    let lastState = '';
    let sessionsLoaded = false;
    let sessionsLoading = false;
    let workspaces = [];

    const style = el('style', { text: `
      #webcode-toggle{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483000;
        writing-mode:vertical-rl;letter-spacing:2px;padding:12px 6px;border:1px solid #d7dce3;border-right:none;
        border-radius:8px 0 0 8px;background:#f7f8fa;color:#4a5563;font:12px system-ui,"Microsoft YaHei",sans-serif;
        cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;box-shadow:-2px 0 6px rgba(0,0,0,.05)}
      #webcode-toggle:hover{background:#eef1f5}
      #webcode-dot{width:7px;height:7px;border-radius:50%;background:#c2c8d0;flex:none}
      #webcode-dot.on{background:#4caf7d}
      #webcode-dot.busy{background:#e0a63f;animation:webcodePulse 1s infinite}
      #webcode-dot.warn{background:#e07f3f}
      @keyframes webcodePulse{50%{opacity:.35}}
      #webcode-drawer{position:fixed;top:0;right:-440px;width:430px;height:100vh;z-index:2147483001;
        background:#fff;border-left:1px solid #d7dce3;box-shadow:-6px 0 24px rgba(0,0,0,.10);
        transition:right .28s ease;display:flex;flex-direction:column;font:13px/1.7 system-ui,"Microsoft YaHei",sans-serif}
      #webcode-drawer.open{right:0}
      #webcode-drawer-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eceff3;flex:none}
      #webcode-drawer-title{font-weight:600;color:#2b3442}
      #webcode-drawer-status{color:#7a8494;font-size:11px;flex:1;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #webcode-drawer-close{border:none;background:none;cursor:pointer;color:#5a6472;font-size:14px;padding:2px 6px;border-radius:4px}
      #webcode-drawer-close:hover{background:#eef1f5}
      #webcode-body{flex:1;overflow:auto;padding:14px 16px;color:#3a4453}
      #webcode-steps{margin:8px 0;padding-left:2px}
      #webcode-steps li{list-style:none;margin:6px 0;color:#556070}
      #webcode-agree{display:flex;gap:6px;align-items:flex-start;margin:12px 0;font-size:12px;color:#556070}
      #webcode-note{margin-top:12px;padding:8px 10px;background:#f6f8fa;border-radius:6px;color:#68727f;font-size:12px}
      .webcode-btn{margin-top:10px;width:100%;padding:9px 10px;border:1px solid #cfd6df;border-radius:8px;
        background:#f0f3f7;color:#2b3442;font-size:13px;cursor:pointer}
      .webcode-btn:hover{background:#e6ebf1}
      .webcode-btn:disabled{opacity:.55;cursor:default}
      #webcode-section{margin-top:16px;border-top:1px solid #eceff3;padding-top:10px}
      #webcode-section h4{margin:0 0 6px;font-size:12px;font-weight:600;color:#5a6472}
      #webcode-mirror{width:100%;height:62vh;border:1px solid #d7dce3;border-radius:8px;background:#fff;display:block}
      #webcode-mirror-bar{display:flex;align-items:center;gap:8px;margin:6px 0}
      #webcode-mirror-bar .h{flex:1;color:#5a6472;font-size:12px;font-weight:600}
      #webcode-mirror-hint{color:#8a94a3;font-size:11px;margin-top:4px}      #webcode-ws-select{width:100%;margin-top:6px;padding:6px 8px;border:1px solid #cfd6df;border-radius:6px;
        font-size:12px;color:#2b3442;background:#fff}
      #webcode-sessions{margin-top:6px;max-height:220px;overflow:auto}
      .webcode-session{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px dashed #eef1f5}
      .webcode-session .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#2b3442;font-size:12px}
      .webcode-session .d{color:#8a94a3;font-size:11px;flex:none}
      .webcode-session button{flex:none;border:1px solid #cfd6df;background:#f0f3f7;color:#2b3442;font-size:11px;
        padding:2px 8px;border-radius:5px;cursor:pointer}
      .webcode-session button:hover{background:#e6ebf1}
      #webcode-sessions-msg{color:#8a94a3;font-size:11px;padding:4px 0}
      .webcode-mini{margin-top:6px;width:auto;display:inline-block;padding:4px 10px;font-size:12px}
    ` });
    document.head.appendChild(style);

    const dot = el('i', { id: 'webcode-dot' });
    const toggle = el('button', { id: 'webcode-toggle', text: ' Web AI ', onclick: () => setExpanded(!expanded) }, [dot]);
    document.body.appendChild(toggle);

    const statusEl = el('span', { id: 'webcode-drawer-status', text: '…' });
    const agreeBox = el('input', { type: 'checkbox', id: 'webcode-agree-box' });
    const mirrorFrame = el('iframe', {
      id: 'webcode-mirror',
      title: 'DeepSeek 官网（镜像）',
      // same-origin sandbox on the relay origin (its own storage for the
      // login token), cross-origin to the GUI; referrer policy keeps the
      // loopback out of upstream referrers
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox',
      referrerpolicy: 'no-referrer',
    });
    const mirrorHint = el('div', { id: 'webcode-mirror-hint', text: STR.mirrorIdle });
    const mirrorBar = el('div', { id: 'webcode-mirror-bar' }, [
      el('span', { class: 'h', text: STR.mirrorTitle }),
      el('button', { class: 'webcode-mini', text: STR.mirrorReload, onclick: () => loadMirror(true) }),
    ]);
    const wsSelect = el('select', { id: 'webcode-ws-select' });
    const sessionsList = el('div', { id: 'webcode-sessions' });
    const sessionsMsg = el('div', { id: 'webcode-sessions-msg', text: STR.sessionsEmpty });
    const refreshBtn = el('button', {
      class: 'webcode-btn webcode-mini',
      text: STR.sessionsRefresh,
      onclick: () => loadSessions(true),
    });
    const drawer = el('aside', { id: 'webcode-drawer' }, [
      el('div', { id: 'webcode-drawer-head' }, [
        el('span', { id: 'webcode-drawer-title', text: STR.title }),
        statusEl,
        el('button', { id: 'webcode-drawer-close', text: '✕', title: STR.close, onclick: () => setExpanded(false) }),
      ]),
      el('div', { id: 'webcode-body' }, [
        el('ol', { id: 'webcode-steps' }, [
          el('li', { text: STR.step1 }),
          el('li', { text: STR.step2 }),
          el('li', { text: STR.step3 }),
        ]),
        el('button', {
          class: 'webcode-btn',
          id: 'webcode-login',
          text: STR.openLogin,
          onclick: () => { api('login', {}).catch(() => {}); },
        }),
        el('button', {
          class: 'webcode-btn',
          id: 'webcode-open',
          text: STR.openSite,
          onclick: () => openChatSite(cfg.site),
        }),
        el('label', { id: 'webcode-agree' }, [
          agreeBox,
          el('span', { text: STR.consentLabel }),
        ]),
        el('div', { id: 'webcode-section' }, [
          mirrorBar,
          mirrorFrame,
          mirrorHint,
        ]),
        el('div', { id: 'webcode-section' }, [
          el('h4', { text: STR.sessionsTitle }),
          refreshBtn,
          wsSelect,
          sessionsMsg,
          sessionsList,
        ]),
        el('div', { id: 'webcode-note', text: STR.note }),
      ]),
    ]);
    document.body.appendChild(drawer);

    agreeBox.addEventListener('change', () => {
      api('consent', { accepted: agreeBox.checked }).catch(() => {});
    });

    function setExpanded(next) {
      expanded = next;
      drawer.classList.toggle('open', expanded);
      if (expanded) {
        ensureApiBase().then(() => { loadSessions(false); }).catch(() => {});
        loadMirror(false);
      }
    }

    function loadMirror(force) {
      if (mirrorLoaded && !force) { mirrorHint.textContent = '真实官网界面（与自动化共用同一账号，手动对话实时同步）'; return; }
      mirrorLoaded = true;
      // the relay origin serves the proxied site at root; frame headers are
      // stripped server-side and the login token seeded into the page
      mirrorFrame.setAttribute('src', relayBase + '/');
      mirrorFrame.onload = () => { mirrorHint.textContent = '真实官网界面 · 手动对话与桥接自动化共用同一账号'; };
    }

    async function ensureApiBase() {
      if (apiBase) return apiBase;
      try {
        const r = await fetch('/__webcode/status', { cache: 'no-store' });
        if (r.ok) {
          apiBase = '/__webcode';
          return apiBase;
        }
      } catch { /* fall through */ }
      apiBase = relayBase + '/bridge/web';
      return apiBase;
    }

    async function api(action, body) {
      const base = await ensureApiBase();
      const url = base + '/' + action;
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
      return res.json();
    }

    async function loadWorkspaces() {
      try {
        const j = await api('workspaces');
        workspaces = Array.isArray(j?.workspaces) ? j.workspaces : [];
      } catch { workspaces = []; }
      wsSelect.textContent = '';
      if (!workspaces.length) {
        wsSelect.appendChild(el('option', { value: '', text: '（无可用工作区）' }));
        return;
      }
      for (const w of workspaces) {
        wsSelect.appendChild(el('option', { value: w.id, text: (w.title || w.id) + ' · ' + (w.path || '') }));
      }
    }

    function fmtTime(ts) {
      if (!ts) return '';
      try {
        const d = new Date(Number(ts) || ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    }

    async function loadSessions(force) {
      if (sessionsLoading || !expanded) return;
      if (sessionsLoaded && !force) return;
      sessionsLoading = true;
      sessionsLoaded = true;
      sessionsMsg.textContent = STR.sessionsLoading;
      sessionsList.textContent = '';
      try {
        const j = await api('sessions', { count: 50 });
        const list = Array.isArray(j?.sessions) ? j.sessions : null;
        if (!j?.ok || !list) throw new Error(j?.error || 'bad payload');
        sessionsMsg.textContent = list.length ? '' : '网页端暂无会话';
        for (const s of list.slice(0, 50)) {
          const btn = el('button', { text: STR.importBtn });
          btn.addEventListener('click', async () => {
            const wsId = wsSelect.value;
            if (!wsId) { alert('请先选择工作区'); return; }
            btn.disabled = true; btn.textContent = STR.importing;
            try {
              const r = await api('import', { sessionId: s.id, workspaceId: wsId });
              if (r?.ok) {
                btn.textContent = '已导入';
                alert(`已导入为 DSH 会话（${r.messageCount} 条消息${r.branchSkipped ? '，跳过分支 ' + r.branchSkipped + ' 条' : ''}）${r.attached ? '，刷新网页后可在工作区看到' : '，但挂载失败：' + (r.attachError || '')}`);
              } else {
                btn.textContent = STR.importBtn;
                alert('导入失败：' + (r?.error || '未知错误'));
              }
            } catch (e) {
              btn.textContent = STR.importBtn;
              alert('导入失败：' + (e?.message || e));
            }
          });
          sessionsList.appendChild(el('div', { class: 'webcode-session' }, [
            el('span', { class: 't', title: s.title, text: s.title || '(无标题)' }),
            el('span', { class: 'd', text: fmtTime(s.updatedAt) }),
            btn,
          ]));
        }
      } catch (e) {
        sessionsLoaded = false;
        sessionsMsg.textContent = '获取失败（需登录且驱动已启动）';
      } finally {
        sessionsLoading = false;
      }
    }

    async function pollStatus() {
      let st = null;
      try {
        const base = await ensureApiBase();
        const path = base.startsWith('/') ? '/status' : '/status';
        st = await (await fetch(base + path, { cache: 'no-store' })).json();
      } catch {
        try { st = await (await fetch(statusUrl, { cache: 'no-store' })).json(); } catch { st = null; }
      }
      const d = st?.driver || {};
      const consent = st?.relay ? st.relay.consent : st?.consent;
      const busy = st?.relay ? st.relay.busy : st?.busy;
      let state;
      if (busy) state = 'busy';
      else if (!consent) state = 'noconsent';
      else if (d.needLogin || d.loggedIn === false) state = 'needLogin';
      else if (d.running) state = 'on';
      else state = 'off';
      if (state !== lastState) {
        lastState = state;
        dot.className = state === 'on' ? 'on' : state === 'busy' ? 'busy' : state === 'needLogin' ? 'warn' : '';
        statusEl.textContent =
          state === 'on' ? STR.connected :
          state === 'busy' ? STR.busy :
          state === 'needLogin' ? STR.needLogin :
          state === 'noconsent' ? STR.noconsent : STR.notRunning;
        if (state !== 'noconsent') agreeBox.checked = consent === true;
      }
    }
    pollStatus();
    statusTimer = setInterval(pollStatus, 4000);
    loadWorkspaces().catch(() => {});

    return () => {
      try { clearInterval(statusTimer); } catch {}
      try { toggle.remove(); drawer.remove(); style.remove(); } catch {}
    };
  }

  const __exports__ = { name: NAME, inject, apply };
  if (module) { module.exports = __exports__; }
  return __exports__;
  }
});
