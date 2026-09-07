window.__ModuleLoader__.load({
  id: 'dsh-webcode-bridge',
  factory(require, module) {
    'use strict';
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { IconCodeOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const inject = ['slots', 'settingsScope'];
    const RELAY_PORT = 8931;
    const relayBase = 'http://127.0.0.1:' + RELAY_PORT;
    const icon = size => h(IconCodeOutline16, { size });

    async function api(action, body, timeoutMs = 30000) {
      const response = await fetch('/__webcode/' + action, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败');
      return data;
    }

    const MODEL_NAMES = { flash: '快速模式', vision: '识图模式', deepseek: '深度思考（专家）' };

    function Metrics({ metrics }) {
      if (!metrics) return h('span', null, '尚无调用记录');
      const measured = metrics.timing === 'measured';
      const rows = [
        ['首字延迟', metrics.firstTokenMs == null ? '--' : metrics.firstTokenMs + ' ms'],
        ['可观测思考', metrics.thinkingMs == null ? '网页未提供' : metrics.thinkingMs + ' ms'],
        ['正文输出', metrics.responseMs == null ? '--' : metrics.responseMs + ' ms'],
        ['正文速度', metrics.responseTps == null ? '--' : metrics.responseTps + (metrics.tokensEstimated ? ' 约 token/s' : ' token/s')],
        ['总耗时', metrics.durationMs == null ? '--' : metrics.durationMs + ' ms'],
      ];
      return h('div', { className: 'hwb-metrics' },
        h('div', { className: 'hwb-metrics-head' },
          h('span', { className: 'hwb-badge' + (measured ? ' measured' : '') }, measured ? '实测' : '估算'),
          measured ? (metrics.phaseSource ? '来自 ' + metrics.phaseSource + '；速度 token 数按 CJK/ASCII 估算，网页内部等待不等同于思考文本' : null) : '首次网页调用完成后显示实测数据'),
        rows.map(([k, v]) => h('div', { key: k, className: 'hwb-metrics-row' }, h('span', null, k), h('output', null, v))));
    }

    function PresetPreview() {
      const [preset, setPreset] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const load = () => api('preset').then(p => setPreset(p)).catch(() => {});
      React.useEffect(() => { if (open && preset === null) load(); }, [open]);
      return h('details', { className: 'hwb-preset', onToggle: e => setOpen(e.target.open) },
        h('summary', null, '提示词模板（发送首条消息时注入网页的完整内容）'),
        preset === null ? h('p', { className: 'hwb-hint' }, '加载中…')
          : preset.prompt
            ? h('pre', null, preset.prompt)
            : h('p', { className: 'hwb-hint' }, preset.note || '尚未发送过首轮请求。'),
        preset?.prompt && h('p', { className: 'hwb-hint' },
          '模型: ' + (MODEL_NAMES[preset.model] || preset.model) +
          (preset.tools?.length ? ' · 工具: ' + preset.tools.join(', ') : ' · 无工具')));
    }

      function SessionImport() {
        const [sessions, setSessions] = React.useState(null);
        const [workspaces, setWorkspaces] = React.useState([]);
        const [workspaceId, setWorkspaceId] = React.useState('');
        const [open, setOpen] = React.useState(false);
        const [loading, setLoading] = React.useState(false);
        const [notice, setNotice] = React.useState('');
        const [error, setError] = React.useState('');
        const [importing, setImporting] = React.useState(null);
        React.useEffect(() => {
          if (!open) return;
          let alive = true;
          api('workspaces').then(w => { if (alive) { setWorkspaces(w.workspaces || []); setWorkspaceId(w.workspaces?.[0]?.id || ''); } }).catch(() => {});
          api('sessions', { count: 20 }).then(s => { if (alive) setSessions(s.sessions || []); }).catch(e => { if (alive) setError(e.message); });
          return () => { alive = false; };
        }, [open]);
        async function doImport(session) {
          setImporting(session.id); setNotice(''); setError('');
          try {
            const r = await api('import', { sessionId: session.id, title: session.title, workspaceId }, 60000);
            setNotice(`已导入为 DSH 会话：${r.messageCount} 条主线消息，分支跳过 ${r.branchSkipped ?? 0}${r.attached ? '' : '（未挂载到工作区）'}`);
          } catch (e) { setError(e.message); }
          finally { setImporting(null); }
        }
        return h('details', { className: 'hwb-preset', onToggle: e => setOpen(e.target.open) },
          h('summary', null, '网页会话导入（把 DeepSeek 网页历史导入为 DSH 会话）'),
          !open ? null
            : h('div', { className: 'hwb-import' },
              h('p', { className: 'hwb-hint' }, '选择目标工作区后，点击导入即可将网页会话主线消息写为可继续对话的 DSH 会话。'),
              h('div', { className: 'hwb-row' },
                h('span', null, '目标工作区'),
                h('select', { value: workspaceId, onChange: e => setWorkspaceId(e.target.value) },
                  workspaces.length ? workspaces.map(w => h('option', { key: w.id, value: w.id }, w.title || w.path || w.id)) : h('option', { value: '' }, '无可选工作区'))),
              sessions === null ? h('p', { className: 'hwb-hint' }, '加载会话列表…')
                : sessions.length === 0 ? h('p', { className: 'hwb-hint' }, '网页端暂无会话记录')
                : sessions.map(s => h('div', { key: s.id, className: 'hwb-import-row' },
                  h('span', { className: 'hwb-import-title' }, s.title || '(无标题)'),
                  h('button', { disabled: !workspaceId || importing === s.id, onClick: () => doImport(s) },
                    importing === s.id ? '导入中…' : '导入'))),
              notice && h('p', { role: 'status', className: 'hwb-hint' }, notice),
              error && h('p', { role: 'alert', className: 'hwb-hint' }, error)));
      }

      function GlobalPrompt() {
        const [value, setValue] = React.useState('');
        const [saved, setSaved] = React.useState('');
        const [open, setOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState('');
        const [error, setError] = React.useState('');
        React.useEffect(() => {
          if (!open) return;
          let alive = true;
          api('settings').then(s => { if (alive) { setValue(s.extraPrompt || ''); setSaved(s.extraPrompt || ''); } }).catch(e => { if (alive) setError(e.message); });
          return () => { alive = false; };
        }, [open]);
        async function save() {
          setBusy(true); setNotice(''); setError('');
          try {
            const r = await api('settings', { extraPrompt: value });
            setSaved(r.extraPrompt || ''); setValue(r.extraPrompt || '');
            setNotice('已保存，后续每个新网页会话的首轮提示词都会包含「全局指令」。');
          } catch (e) { setError(e.message); }
          finally { setBusy(false); }
        }
        return h('details', { className: 'hwb-preset', onToggle: e => setOpen(e.target.open) },
          h('summary', null, '全局指令（追加到每次首轮提示词，生态同款 global-prompt 能力）'),
          !open ? null
            : h('div', { className: 'hwb-import' },
              h('p', { className: 'hwb-hint' }, '这里的内容会以「[全局指令]」形式注入每次发送到网页的首条消息，例如：“始终用中文回答；执行任何操作前先说明依据”。'),
              h('textarea', {
                className: 'hwb-prompt-input', value, rows: 5, maxLength: 4000,
                placeholder: '例如：始终保持工具调用格式；回答简洁；先读文件再下结论。',
                onChange: e => setValue(e.target.value),
              }),
              h('div', { className: 'hwb-row' },
                h('button', { disabled: busy || value === saved, onClick: save }, busy ? '保存中…' : '保存全局指令'),
                notice && h('span', { className: 'hwb-hint' }, notice)),
              error && h('p', { role: 'alert', className: 'hwb-hint' }, error)));
      }



    function Settings() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const poll = () => api('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(e.message); });
        poll();
        const timer = setInterval(poll, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      async function action(name, body) {
        setPending(true); setError('');
        try { await api(name, body); setStatus(await api('status')); }
        catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      const relay = status?.relay;
      const driver = status?.driver;
      const consent = relay?.consent === true;
      const metrics = relay?.metrics;
      return h('section', { className: 'hwb-settings' },
        h('h2', null, 'Harness Web Bridge'),
        h('p', { className: 'hwb-lead' }, '用已登录的 Edge 网页驱动 DeepSeek：右侧直接显示可操作的真实网页，模型生成与工具调用均以网页原生流程执行，与 API 调用同源。'),
        h('h3', { className: 'hwb-group' }, '连接'),
        h('div', { className: 'hwb-row' }, h('span', null, '网页服务'),
          h('span', null, relay?.running ? 'DeepSeek 官方网页 · 已连接' : 'DeepSeek 官方网页 · 未启动')),
        h('div', { className: 'hwb-row' }, h('span', null, '模型'),
          h('span', null, '快速 / 识图 / 深度思考', driver?.selectedModel ? ' · 当前: ' + (MODEL_NAMES[driver.selectedModel] || driver.selectedModel) : '')),
        h('div', { className: 'hwb-row' }, h('span', null, '账户'),
          h('span', null, driver?.loggedIn ? 'DeepSeek 网页账号已登录（本地浏览器配置）' : driver?.needLogin ? '未登录（需要先登录一次）' : '待检查'),
          h('button', { disabled: pending || relay?.busy, onClick: () => action('login', {}) },
            driver?.loggedIn ? '更换账户' : '登录账户（首次授权）')),
        h('div', { className: 'hwb-row' },
          h('label', { className: 'hwb-consent' },
            h('input', {
              type: 'checkbox', checked: consent, disabled: pending,
              onChange: e => action('consent', { accepted: e.target.checked }),
            }),
            h('span', null, '启用网页自动化')),
          h('span', { className: 'hwb-hint' },
            consent
              ? (relay?.consentPersistent ? '已永久保存到本机配置：首次授权一次即可长期使用，后续仅在账户失效时点击「更换账户」' : '当前运行有效，配置目录不可写入')
              : '首次使用时请勾选授权一次；授权会保存到本机配置。关闭后所有网页调用都会被拒绝。')),
        h('h3', { className: 'hwb-group' }, '模型与观测'),
        h('div', { className: 'hwb-row' }, h('span', null, '最近一次生成速度'), h(Metrics, { metrics })),
        h('div', { className: 'hwb-row' }, h('span', null, '会话隔离'),
          h('span', { className: 'hwb-hint' }, (driver?.conversationCount ?? 0) + ' 个网页会话槽；并行 agent 按 agentId 分开，网页请求仍按队列逐个执行')),
        h('h3', { className: 'hwb-group' }, '首轮提示词'),
        h(PresetPreview),
        h(GlobalPrompt),
        h('h3', { className: 'hwb-group' }, '网页历史'),
        h(SessionImport),
        relay?.lastError ? h('p', { role: 'alert', className: 'hwb-hint' }, '最近错误: ' + relay.lastError) : null,
        error && h('p', { role: 'alert' }, error));
    }

    function Conversation({ browserSrc }) {
      const [frameSrc, setFrameSrc] = React.useState('');
      const [frameReady, setFrameReady] = React.useState(false);
      const [connectError, setConnectError] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        api('connect', {}, 90000).then(() => {
          if (alive) setFrameSrc(browserSrc + '?webcode=sidebar&ts=' + Date.now());
        }).catch(e => { if (alive) setConnectError(e.message); });
        return () => { alive = false; };
      }, [browserSrc]);
      return h('div', { className: 'hwb-conversation' },
        connectError && h('div', { className: 'hwb-error', role: 'status' },
          '浏览器视图未能连接：' + connectError + ' ',
          h('button', { className: 'hwb-retry', onClick: () => { setConnectError(''); setFrameReady(false); setFrameSrc(browserSrc + '?webcode=sidebar&ts=' + Date.now()); } }, '重试')),
        frameSrc && h('iframe', {
          className: 'hwb-browser-frame',
          src: frameSrc,
          title: 'DeepSeek 网页对话',
          referrerPolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
          onLoad: () => { setFrameReady(true); setConnectError(''); },
          onError: () => { setFrameReady(false); setConnectError('网页代理加载失败，请确认中继服务已启动'); },
        }),
        frameSrc && !frameReady && !connectError && h('div', { className: 'hwb-frame-status' }, '正在加载 DeepSeek 网页…（加载后可直接在右侧操作，生成任务由网页原生执行）'));
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = '.hwb-settings{max-width:760px;padding:20px;color:inherit}.hwb-settings h2{font-size:20px;letter-spacing:0;margin:0 0 6px}.hwb-lead{font-size:12px;opacity:.72;margin:0 0 12px;line-height:1.6}.hwb-group{font-size:12px;font-weight:600;opacity:.72;margin:18px 0 0;padding-top:12px;border-top:1px solid #8883}.hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid #8883}.hwb-row>span:first-child{flex:1;min-width:140px}.hwb-row button{padding:6px 12px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-consent{display:flex;align-items:center;gap:8px}.hwb-hint{font-size:12px;opacity:.72;margin:4px 0 0;line-height:1.5}.hwb-metrics{display:flex;flex-direction:column;gap:2px;min-width:220px}.hwb-metrics-head{font-size:12px;margin-bottom:4px}.hwb-metrics-row{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}.hwb-badge{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;border:1px solid #8885;margin-right:8px}.hwb-badge.measured{color:#2e7d32;border-color:#2e7d3280}.hwb-preset{padding:12px 0;border-bottom:1px solid #8883}.hwb-preset summary{cursor:pointer;font-size:13px}.hwb-import{display:flex;flex-direction:column;gap:8px}.hwb-import select{padding:6px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.hwb-import-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #8883}.hwb-import-title{flex:1;font-size:13px}.hwb-prompt-input{width:100%;min-height:80px;padding:8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;font:inherit;line-height:1.5;resize:vertical}.hwb-preset pre{max-height:280px;overflow:auto;font-size:12px;line-height:1.5;padding:10px;border:1px solid #8883;border-radius:6px;white-space:pre-wrap;word-break:break-word}.hwb-conversation{height:100%;width:100%;min-height:0;overflow:auto;background:#fff;position:relative}.hwb-retry{padding:4px 10px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-error{padding:8px;font-size:12px;color:#93443e;background:#fff}.hwb-launch{position:fixed;right:10px;top:90px;width:32px;height:32px;z-index:99996;border:1px solid #8885;border-radius:6px;background:var(--ds-bg,#fff);color:var(--ds-text,#444);display:grid;place-items:center;cursor:pointer}.hwb-fallback{position:fixed;right:0;top:0;bottom:0;width:min(720px,100vw);z-index:99995;border-left:1px solid #8885;display:flex;flex-direction:column;background:var(--ds-bg,#fff)}.hwb-fallback header{padding:8px;display:flex;justify-content:space-between}.hwb-fallback>div{flex:1;min-height:0}';
      document.head.appendChild(style);
      const browserStyle = document.createElement('style');
      browserStyle.textContent = '.hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}.hwb-frame-status{position:absolute;inset:0;display:grid;place-items:center;background:#fff;color:#7a8494;font-size:12px;pointer-events:none}';
      document.head.appendChild(browserStyle);
      const disposers = [() => style.remove(), () => browserStyle.remove()];
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'webcode', order: 110,
        label: () => '网页桥接', inject: () => ({}),
      }, Settings));

      let sidebar = null, fallbackRoot, fallback;
      const register = child => {
        sidebar = child.get('betterSidebar');
        const off = sidebar.registerTab({ id: 'webcode', title: () => 'DeepSeek', icon, order: 55, single: true, component: () => h(Conversation, { browserSrc: relayBase + '/' }) });
        return () => { off(); sidebar = null; };
      };
      if (typeof ctx.inject === 'function') ctx.inject(['betterSidebar'], register);
      // 无 better-sidebar 时，使用右侧抽屉 + 浮窗按钮作为降级方案
      const hasBetterSidebar = !!(typeof ctx.inject === 'function' && ctx.get?.('betterSidebar'));
      if (!hasBetterSidebar) {
        const launcher = document.createElement('button');
        launcher.className = 'hwb-launch'; launcher.title = 'DeepSeek 会话'; launcher.setAttribute('aria-label', 'DeepSeek 会话');
        const launcherRoot = createRoot(launcher); launcherRoot.render(icon(18));
        launcher.onclick = () => {
          if (fallback) { fallbackRoot.unmount(); fallback.remove(); fallback = null; return; }
          fallback = document.createElement('aside'); fallback.className = 'hwb-fallback';
          document.body.appendChild(fallback); fallbackRoot = createRoot(fallback);
          fallbackRoot.render(h(React.Fragment, null, h('header', null, 'DeepSeek', h('button', {
            title: '收起会话', 'aria-label': '收起会话', onClick: () => { fallbackRoot.unmount(); fallback.remove(); fallback = null; },
          }, '\u00d7')), h('div', null, h(Conversation, { browserSrc: relayBase + '/' }))));
        };
        document.body.appendChild(launcher);
        disposers.push(() => { launcherRoot.unmount(); launcher.remove(); fallbackRoot?.unmount(); fallback?.remove(); });
      }
      return () => disposers.reverse().forEach(dispose => dispose());
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
