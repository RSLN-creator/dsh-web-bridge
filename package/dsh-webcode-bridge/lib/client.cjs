window.__ModuleLoader__.load({
  id: 'dsh-webcode-bridge',
  factory(require, module) {
    'use strict';
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { IconCodeOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const inject = ['slots', 'settingsScope', 'sidebarRightTabs', 'sidebarRight'];
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

    const MODEL_NAMES = { deepseek: 'DeepSeek' };
    // 站点显示名 + 多站点模型目录（打开时从 /__webcode/models 拉取）
    const SITE_NAMES = { deepseek: 'DeepSeek', glm: '智谱清言', chatgpt: 'ChatGPT', kimi: 'Kimi', qwen: '通义千问', doubao: '豆包', grok: 'Grok', claude: 'Claude', gemini: 'Gemini' };

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



    // 按站点分组的模型下拉选项：从桥的 /__webcode/models 取全站点目录
    function ModelSelect({ models, value, onChange, disabled }) {
      if (!models) return h('select', { disabled: true }, h('option', null, '加载模型目录…'));
      const groups = new Map();
      for (const m of models) {
        if (!groups.has(m.siteId)) groups.set(m.siteId, []);
        groups.get(m.siteId).push(m);
      }
      return h('select', { className: 'hwb-model-select', value: value || '', disabled, onChange: e => onChange(e.target.value) },
        [...groups.entries()].map(([sid, list]) => h('optgroup', { key: sid, label: SITE_NAMES[sid] || sid },
          list.map(m => h('option', { key: m.id, value: m.id },
            m.name + (m.experimental ? '（实验）' : '') + (m.thinking ? ' · 深度思考' : '') + (m.vision ? ' · 识图' : ''))))));
    }

    // 各内容服务站点行：登录状态 + 按站点登录/更换账户（二级操作界面）
    function SiteRows({ sites, pending, onLogin }) {
      if (!sites || !sites.length) return h('p', { className: 'hwb-hint' }, '尚无站点状态（发送一次请求后聚合显示）');
      return h('div', { className: 'hwb-sites' },
        sites.map(s => h('div', { key: s.siteId, className: 'hwb-site-row' + (s.busy ? ' busy' : '') },
          h('span', { className: 'hwb-site-name' },
            (SITE_NAMES[s.siteId] || s.siteName || s.siteId),
            s.initialized ? '' : h('span', { className: 'hwb-hint' }, '（未初始化）')),
          h('span', { className: 'hwb-site-state ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle') },
            s.loggedIn === true ? '已登录' : s.loggedIn === false ? '未登录' : '待检查'),
          h('button', { disabled: pending, onClick: () => onLogin(s.siteId) }, s.loggedIn === true ? '更换账户' : '登录'))));
    }

    function Settings() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const [models, setModels] = React.useState(null);
      const [defaultModel, setDefaultModel] = React.useState('');
      const [modelSaved, setModelSaved] = React.useState('');
      const [modelNotice, setModelNotice] = React.useState('');
      const [thinkMode, setThinkMode] = React.useState('auto');
      const [thinkSaved, setThinkSaved] = React.useState('auto');
      const [thinkNotice, setThinkNotice] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        const poll = () => api('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(e.message); });
        poll();
        api('models').then(m => { if (alive) setModels(m.models || []); }).catch(() => {});
        api('settings').then(s => {
          if (!alive) return;
          setDefaultModel(s.defaultModel || ''); setModelSaved(s.defaultModel || '');
          setThinkMode(['on', 'off', 'auto'].includes(s.thinkMode) ? s.thinkMode : 'auto');
          setThinkSaved(['on', 'off', 'auto'].includes(s.thinkMode) ? s.thinkMode : 'auto');
        }).catch(() => {});
        const timer = setInterval(poll, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      async function action(name, body) {
        setPending(true); setError('');
        try { await api(name, body); setStatus(await api('status')); }
        catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      async function saveThink(value) {
        setPending(true); setThinkNotice(''); setError('');
        try {
          const r = await api('settings', { thinkMode: value });
          setThinkMode(r.thinkMode || value); setThinkSaved(r.thinkMode || value);
          setThinkNotice('已保存。下次生成起生效。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      async function saveModel(value) {
        setPending(true); setModelNotice(''); setError('');
        try {
          const r = await api('settings', { defaultModel: value });
          setDefaultModel(r.defaultModel || value); setModelSaved(r.defaultModel || value);
          setModelNotice('已保存：新建会话未显式选模型时将使用该模型。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      const relay = status?.relay;
      const driver = status?.driver;
      const sites = driver?.sites;
      const consent = relay?.consent === true;
      const metrics = relay?.metrics;
      const currentModelName = m => models?.find(x => x.id === m)?.name || MODEL_NAMES[m] || m;
      // 「深度思考」三态开关仅对 DeepSeek 站点有意义——只有默认模型落在
      // deepseek 站点时才展示（其余站点 pill 契约未真机校准，不硬造开关）
      const defaultSiteId = (defaultModel || '').split(':')[0];
      const showThink = defaultSiteId === 'deepseek';
      return h('section', { className: 'hwb-settings' },
        h('h2', null, 'Harness Web Bridge'),
        h('p', { className: 'hwb-lead' }, '用已登录的 Edge 网页驱动内容服务：右侧直接显示可操作的真实网页，模型生成与工具调用均以网页原生流程执行，与 API 调用同源。'),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '模型'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '默认模型'),
            h('div', { className: 'hwb-row-main' },
              h(ModelSelect, { models, value: defaultModel, disabled: pending, onChange: setDefaultModel }),
              h('button', { disabled: pending || !defaultModel || defaultModel === modelSaved, onClick: () => saveModel(defaultModel) }, '保存'),
              modelNotice && h('span', { className: 'hwb-hint' }, modelNotice))),
          showThink && h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '深度思考'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: thinkMode, disabled: pending, onChange: e => setThinkMode(e.target.value) },
                h('option', { value: 'auto' }, '自动（按所选模型的默认思考行为）'),
                h('option', { value: 'on' }, '始终开启（强制打开网页「深度思考」开关）'),
                h('option', { value: 'off' }, '始终关闭（追求速度）')),
              h('button', { disabled: pending || thinkMode === thinkSaved, onClick: () => saveThink(thinkMode) }, '保存'),
              thinkNotice && h('span', { className: 'hwb-hint' }, thinkNotice))),
          h('p', { className: 'hwb-hint indent' }, '当前网页模型：' + (driver?.selectedModel ? currentModelName(driver.selectedModel) : '未选择（按默认模型）'))),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '连接'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '网页服务'),
            h('div', { className: 'hwb-row-main' }, h('span', null, relay?.running ? '中继已连接' : '未启动'))),
          h('div', { className: 'hwb-row' },
            h('label', { className: 'hwb-consent' },
              h('input', {
                type: 'checkbox', checked: consent, disabled: pending,
                onChange: e => action('consent', { accepted: e.target.checked }),
              }),
              h('span', null, '启用网页自动化')),
            h('span', { className: 'hwb-hint' },
              consent
                ? (relay?.consentPersistent ? '已永久保存到本机：首次授权一次即可长期使用' : '当前运行有效，配置目录不可写入')
                : '首次使用时请勾选授权一次；关闭后所有网页调用都会被拒绝。'))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '账户'),
            h('div', { className: 'hwb-row-main' },
              h('span', null, driver?.loggedIn ? 'DeepSeek 网页账号已登录（本地浏览器配置）' : driver?.needLogin ? '未登录（需要先登录一次）' : '待检查'),
              h('button', { disabled: pending || relay?.busy, onClick: () => action('login', { siteId: 'deepseek' }) },
                driver?.loggedIn ? '更换账户' : '登录账户（首次授权）')))),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '内容服务站点'),
          h(SiteRows, { sites, pending, onLogin: siteId => action('login', { siteId }) })),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '模型与观测'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '最近一次生成速度'), h('div', { className: 'hwb-row-main' }, h(Metrics, { metrics }))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '会话隔离'),
            h('div', { className: 'hwb-row-main' }, h('span', { className: 'hwb-hint' }, (driver?.conversationCount ?? 0) + ' 个网页会话槽；并行 agent 按 agentId 分开，网页请求仍按队列逐个执行'))),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '首轮提示词'),
          h(PresetPreview),
          h(GlobalPrompt)),
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '网页历史'),
          h(SessionImport)),
        relay?.lastError ? h('p', { role: 'alert', className: 'hwb-hint' }, '最近错误: ' + relay.lastError) : null,
        error && h('p', { role: 'alert' }, error));
    }

      function Conversation({ browserSrc }) {
        const [siteId, setSiteId] = React.useState('deepseek');
        const [frameSrc, setFrameSrc] = React.useState('');
        const [frameReady, setFrameReady] = React.useState(false);
        const [connectError, setConnectError] = React.useState('');
        const [winBusy, setWinBusy] = React.useState(false);
        const [winOpen, setWinOpen] = React.useState(null); // siteId whose window is open
        const winState = site => api('window').then(w => {
          const openSite = w?.window?.open ? w.siteId : null;
          setWinOpen(openSite);
          return openSite;
        }).catch(() => null);
        React.useEffect(() => {
          let alive = true;
          winState().then(s => { if (alive && s && s !== siteId) setSiteId(s); });
          const poll = setInterval(() => winState(), 5000);
          return () => { alive = false; clearInterval(poll); };
        }, []);
        React.useEffect(() => {
          let alive = true;
          setFrameReady(false);
          api('connect', { siteId }, 90000).then(() => {
            if (alive) setFrameSrc(browserSrc + '__webcode/site/' + siteId + '/?ts=' + Date.now());
          }).catch(e => { if (alive) setConnectError(e.message); });
          return () => { alive = false; };
        }, [browserSrc, siteId]);
        async function toggleWindow() {
          setWinBusy(true); setConnectError('');
          try {
            const target = winOpen === siteId ? 'close' : 'open';
            await api('window', { siteId, action: target });
            await winState();
          } catch (e) { setConnectError(e.message); }
          finally { setWinBusy(false); }
        }

        // 官方右侧栏没有刷新入口；镜像页面用带时间戳的 URL 重挂 iframe 即可重载。
        function reloadFrame() {
          setConnectError(''); setFrameReady(false);
          setFrameSrc(browserSrc + '__webcode/site/' + siteId + '/?ts=' + Date.now());
        }
        return h('div', { className: 'hwb-conversation' },
          h('div', { className: 'hwb-sitebar', role: 'tablist', 'aria-label': '内容服务站点' },
            h('div', { className: 'hwb-sitebar-tabs' },
              Object.entries(SITE_NAMES).map(([sid, name]) => h('button', {
                key: sid, role: 'tab', 'aria-selected': sid === siteId, className: sid === siteId ? 'active' : '',
                onClick: () => setSiteId(sid),
              }, name))),
            h('button', {
              className: 'hwb-icon-btn', title: '刷新右侧网页（重新加载镜像页面）',
              'aria-label': '刷新右侧网页', onClick: reloadFrame,
            }, '\u21bb'),
            h('button', {
              className: 'hwb-win-btn' + (winOpen === siteId ? ' open' : ''), disabled: winBusy,
              title: winOpen === siteId ? '收起独立窗口（回到无头运行）' : '在独立窗口中打开真实网页（可登录、可聊天、与桥共用会话）',
              'aria-pressed': winOpen === siteId, onClick: toggleWindow,
            }, winBusy ? '窗口切换中…' : winOpen === siteId ? '✓ 已开独立窗口 · 点击收回' : '⧉ 独立窗口打开')),
          connectError && h('div', { className: 'hwb-error', role: 'status' },
            '浏览器视图未能连接：' + connectError + ' ',
            h('button', { className: 'hwb-retry', onClick: reloadFrame }, '重试')),
          frameSrc && h('iframe', {
            className: 'hwb-browser-frame',
            src: frameSrc,
            title: SITE_NAMES[siteId] + ' 网页对话',
            referrerPolicy: 'no-referrer',
            sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
            onLoad: () => { setFrameReady(true); setConnectError(''); },
            onError: () => { setFrameReady(false); setConnectError('网页代理加载失败，请确认中继服务已启动'); },
          }),
          frameSrc && !frameReady && !connectError && h('div', { className: 'hwb-frame-status' }, '正在加载 ' + SITE_NAMES[siteId] + ' 网页…（加载后可直接在右侧操作，生成任务由网页原生执行）'));
      }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = '.hwb-settings{max-width:760px;padding:20px;color:inherit;display:flex;flex-direction:column;gap:14px}.hwb-settings h2{font-size:20px;letter-spacing:0;margin:0 0 2px}.hwb-lead{font-size:12px;opacity:.72;margin:0;line-height:1.6}.hwb-card{border:1px solid #8884;border-radius:10px;padding:2px 16px 8px;background:transparent}.hwb-group{font-size:12px;font-weight:600;opacity:.72;margin:12px 0 0}.hwb-group.first{margin-top:12px}.hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid #8883}.hwb-row:last-child{border-bottom:0}.hwb-row-label{flex:0 0 128px;min-width:96px;font-size:13px;padding-top:2px}.hwb-row-main{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hwb-row button{padding:5px 12px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-consent{display:flex;align-items:center;gap:8px}.hwb-hint{font-size:12px;opacity:.72;margin:4px 0 0;line-height:1.5}.hwb-hint.indent{margin:6px 0 8px 128px}.hwb-model-select{min-width:220px;max-width:340px;padding:6px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.hwb-sites{display:flex;flex-direction:column}.hwb-site-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #8883}.hwb-site-row:last-child{border-bottom:0}.hwb-site-row.busy{opacity:.55}.hwb-site-name{flex:1;font-size:13px}.hwb-site-state{font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid #8885}.hwb-site-state.ok{color:#2e7d32;border-color:#2e7d3280}.hwb-site-state.bad{color:#93443e;border-color:#93443e80}.hwb-site-row button{padding:4px 12px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-metrics{display:flex;flex-direction:column;gap:2px;min-width:220px}.hwb-metrics-head{font-size:12px;margin-bottom:4px}.hwb-metrics-row{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}.hwb-badge{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;border:1px solid #8885;margin-right:8px}.hwb-badge.measured{color:#2e7d32;border-color:#2e7d3280}.hwb-preset{padding:12px 0;border-bottom:1px solid #8883}.hwb-preset:last-child{border-bottom:0}.hwb-preset summary{cursor:pointer;font-size:13px}.hwb-import{display:flex;flex-direction:column;gap:8px}.hwb-import select{padding:6px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.hwb-import-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #8883}.hwb-import-title{flex:1;font-size:13px}.hwb-prompt-input{width:100%;min-height:80px;padding:8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;font:inherit;line-height:1.5;resize:vertical}.hwb-preset pre{max-height:280px;overflow:auto;font-size:12px;line-height:1.5;padding:10px;border:1px solid #8883;border-radius:6px;white-space:pre-wrap;word-break:break-word}.hwb-conversation{height:100%;width:100%;min-height:0;overflow:hidden;background:#fff;position:relative;display:flex;flex-direction:column}.hwb-retry{padding:4px 10px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-error{padding:8px;font-size:12px;color:#93443e;background:#fff}.hwb-sitebar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #8883;background:var(--ds-bg,#fff)}.hwb-sitebar-tabs{display:flex;gap:6px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin;padding-bottom:1px}.hwb-sitebar button{padding:3px 10px;border:1px solid #8885;border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}.hwb-sitebar button:hover{border-color:#8888;background:#8881}.hwb-sitebar button.active{background:#2563eb;color:#fff;border-color:#2563eb}.hwb-icon-btn{flex:0 0 auto;align-self:center;width:26px;height:26px;display:grid;place-items:center;padding:0;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1}.hwb-icon-btn:hover{background:#8882}.hwb-win-btn{flex:0 0 auto;align-self:center;padding:4px 10px;border:1px solid #2563eb80;border-radius:8px;background:#2563eb0d;color:#2563eb;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s}.hwb-win-btn:hover{background:#2563eb1a}.hwb-win-btn.open{background:#2563eb;color:#fff}.hwb-win-btn:disabled{opacity:.5;cursor:default}.hwb-sitebar-tabs::-webkit-scrollbar{height:4px}.hwb-sitebar-tabs::-webkit-scrollbar-thumb{background:#8884;border-radius:2px}to{transform:translateX(0);opacity:1}}to{transform:translateX(24px);opacity:0}}';
      document.head.appendChild(style);
      const browserStyle = document.createElement('style');
      browserStyle.textContent = '.hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}.hwb-frame-status{position:absolute;inset:0;display:grid;place-items:center;background:#fff;color:#7a8494;font-size:12px;pointer-events:none}';
      document.head.appendChild(browserStyle);
      const cornerStyle = document.createElement('style');
      cornerStyle.textContent = '.hwb-corner-btn{width:28px;height:28px;display:grid;place-items:center;border:1px solid #8884;border-radius:7px;background:transparent;color:inherit;cursor:pointer;padding:0}.hwb-corner-btn:hover{background:#8882}';
      document.head.appendChild(cornerStyle);
      const disposers = [() => style.remove(), () => browserStyle.remove(), () => cornerStyle.remove()];
      const warn = (what, e) => console.warn('[webcode-bridge] ' + what + ' failed:', e && e.message ? e.message : e);

      // ---- 设置页（保持原有能力） --------------------------------------
      try {
        const off = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'webcode', order: 110,
          label: () => '网页桥接', inject: () => ({}),
        }, Settings));
        if (typeof off === 'function') disposers.push(off);
      } catch (e) { warn('settings section', e); }

      // ---- 官方右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）--------
      // 页面类型：不声明 patterns，由 kind 寻址；内容体注册在同名 id 的 keyed seat。
      // 这条路径与 DSH 自带的文件树/文档预览同级——是布局内的一格，不是浮层。
      const TAB_ID = 'dsh-webcode-bridge';
      const TAB_KIND = 'webcode-bridge';
      const WebcodeBody = () => h(Conversation, { browserSrc: relayBase + '/' });

      try {
        const offType = ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'Web Bridge',
          guide: [{
            order: 55,
            title: () => 'Web Bridge',
            description: () => 'DeepSeek 网页会话（已登录的真实网页，可读可写）',
          }],
        });
        if (typeof offType === 'function') disposers.push(offType);
      } catch (e) { warn('sidebarRightTabs.register', e); }

      try {
        const offBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID,
        }, WebcodeBody));
        if (typeof offBody === 'function') disposers.push(offBody);
      } catch (e) { warn('pane.tab body', e); }

      // ---- 会话头角落按钮：展开/收起右侧栏 ------------------------------
      try {
        const CornerButton = () => h('button', {
          className: 'hwb-corner-btn', type: 'button',
          title: '打开 Web Bridge 网页会话（右侧栏）',
          'aria-label': '打开 Web Bridge 网页会话',
          onClick: () => { try { ctx.sidebarRight.toggleExpanded(); } catch (_) {} },
        }, icon(16));
        const offCorner = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
          name: 'conversation.session.header.corner',
        }, CornerButton));
        if (typeof offCorner === 'function') disposers.push(offCorner);
      } catch (e) { warn('header corner button', e); }

      return () => disposers.reverse().forEach(d => { try { d(); } catch (_) {} });
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
