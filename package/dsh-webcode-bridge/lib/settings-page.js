// settings-page.js — 独立设置页（/__webcode/settings-page）的静态 HTML。
// 从 index.js 抽出（第一轮可维护性优化）：纯展示模板，不依赖运行时状态；
// 模型目录在挂载时注入，保持与 DSH 原生设置面板（client.cjs）互不干扰。
// 注意：新增设置项时两处都要改（原生面板 client.cjs / 本页），字段名以
// configManager 的 defaultConfig 为准。

/** @param {Array<{id:string,name:string,siteName:string,experimental?:boolean}>} models 模型目录 */
export function renderSettingsPage(models) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Webcode Bridge 设置</title>
<style>
body { font-family: system-ui, sans-serif; background: #f8fafc; padding: 20px; max-width: 600px; margin: 0 auto; }
.card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 24px; }
h1 { font-size: 20px; margin-top: 0; }
label { display: block; margin: 16px 0 6px; font-weight: 600; }
textarea, select, input { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
textarea { min-height: 80px; font-family: inherit; }
pre.preset { max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; background: #f1f3f5; border-radius: 8px; padding: 10px; margin: 8px 0 0; }
button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-top: 16px; width: 100%; }
button:hover { background: #1d4ed8; }
#status { margin-top: 12px; padding: 8px; border-radius: 6px; }
.success { background: #dcfce7; color: #166534; }
.error { background: #fee2e2; color: #991b1b; }
.hint { font-size: 13px; color: #6b7280; margin-top: 4px; }
.state { display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 10px; }
.state.ok { background: #dcfce7; color: #166534; }
.state.bad { background: #fee2e2; color: #991b1b; }
.state.idle { background: #e5e7eb; color: #4b5563; }
button.mini { width: auto; margin-top: 0; padding: 6px 12px; font-size: 13px; }
</style>
</head>
<body>
<div class="card">
  <h1>⚙️ Webcode Bridge 设置</h1>
  <form id="settingsForm">
    <label for="extraPrompt">全局指令（首轮注入，唯一可编辑的提示词部分）</label>
    <textarea id="extraPrompt" placeholder="例如：请始终使用中文回答..."></textarea>
    <div class="hint">这段文本会追加到每个新网页会话的第一条用户消息之前。保存后下方模板会立刻反映它。</div>

    <label>首轮提示词（只读，默认显示）</label>
    <div class="hint">
      发送首条消息时注入网页的完整内容，由桥按当前会话的工具清单自动生成。
      不同站点是**两套协议**（GLM 网页会拦截正文里的调用标签），用下面的选择框切换查看。
    </div>
    <select id="variantSelect" style="margin-top:6px;"></select>
    <div id="variantNote" class="hint"></div>
    <pre id="variantText" class="preset">加载中…</pre>
    <div id="variantTools" class="hint"></div>

    <label for="defaultModel">默认模型</label>
    <select id="defaultModel">
      ${models.map((m) => `<option value="${m.id}">${m.name}${m.experimental ? '（实验）' : ''}</option>`).join('\n      ')}
    </select>
    <div class="hint">新建会话时默认选择的模型。已接入：DeepSeek、GLM、ChatGPT、Kimi、通义千问、豆包、Grok、Claude、Gemini。</div>

    <label for="previewRefreshRate">预览刷新率 (毫秒)</label>
    <input type="number" id="previewRefreshRate" min="1000" max="30000" step="500" value="5000">
    <div class="hint">控制预览面板自动刷新的间隔。</div>

    <label for="thinkMode">深度思考</label>
    <select id="thinkMode">
      <option value="auto">自动（按所选模型的默认思考行为）</option>
      <option value="on">始终开启（强制打开网页「深度思考」开关）</option>
      <option value="off">始终关闭（追求速度）</option>
    </select>
    <div class="hint">手动覆盖网页端的「深度思考」开关。自动=按模型属性（DeepSeek 默认开启深度思考）；始终开启/关闭则无视模型。</div>

    <label for="subAgentMode">子代理网页会话</label>
    <select id="subAgentMode">
      <option value="own">独立（推荐）：每个子代理自己的新网页对话</option>
      <option value="share">共用：所有子代理与主会话共用一个网页对话</option>
    </select>
    <div class="hint">同一 DSH 会话里并行 agent 的网页会话分配方式。</div>

    <label for="subAgentSite">子代理站点</label>
    <select id="subAgentSite"></select>
    <div class="hint">
      子代理网页会话与主线<b>相互隔离</b>：各自独立的网页对话，上下文互不可见。
      「跟随主线」时子代理开在主线站点——同一站点两路消息频率叠加，容易触发站点限流
      （「消息发送过于频繁」）；给子代理选另一个站点即可分流。子代理站点的登录
      复用与主站完全相同的一套登录逻辑（登录 / 检测 / 独立窗口），登录态按站点各自
      持久化：与主线同站点时两者天然共享登录，跨站点互不影响。
    </div>
    <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
      <button type="button" id="syncMainToSub" style="width:auto; margin-top:0; padding:6px 12px; font-size:13px;">主线站点 → 子代理</button>
      <button type="button" id="syncSubToMain" style="width:auto; margin-top:0; padding:6px 12px; font-size:13px;">子代理站点 → 主线</button>
      <span class="hint" style="margin-top:0;">手动单向同步「站点选择」；登录态不迁移（同站点天然共享，跨站点无法迁移）。</span>
    </div>

    <div id="subAccountFollow" class="hint" style="display:none;">跟随主线站点：子代理与主线共用同一账户，登录状态随主线站点，无需单独登录。</div>
    <div id="subAccountBlock" style="display:none; margin-top:10px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:8px;">
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <b id="subSiteName" style="font-size:14px;"></b>
        <span id="subSiteState" class="state idle">待检查</span>
        <button type="button" id="subLogin" class="mini">登录</button>
        <button type="button" id="subVerify" class="mini">检测</button>
        <button type="button" id="subWindow" class="mini">独立窗口</button>
      </div>
      <div id="subAccountStatus" class="hint"></div>
      <div class="hint">子代理站点的账户与登录管理：与主线站点同一套逻辑（真实 Edge 窗口一次性登录），登录态按站点各自持久化；与主线同站点时两者天然共享登录。</div>
    </div>

    <label>提示词投递形态</label>
    <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-top:6px;">
      <label style="display:flex; gap:6px; align-items:center; font-weight:400; margin:0;">
        <input type="radio" name="promptTransport" value="attach" style="width:auto;"> 附件投递（默认）
      </label>
      <label style="display:flex; gap:6px; align-items:center; font-weight:400; margin:0;">
        <input type="radio" name="promptTransport" value="inline" style="width:auto;"> 纯文本（永远写进输入框）
      </label>
      <button type="button" id="attachProbeBtn" class="mini">附件探针（只上传·不发送）</button>
    </div>
    <div class="hint">
      超过阈值的正文改走<b>附件上传</b>：绕开网页输入框的写入卡死与截断（真机事故：
      一次 41.7 万字符纯文本灌进输入框，整轮 112 秒零事件）。任何一步失败都会
      <b>自动回落纯文本</b>，消息不会发不出去。选「纯文本」= 逐字回到旧行为。
      <br>「附件探针」会向当前网页会话上传一个 webcode-probe.md（只上传、绝不发送），
      上传后立即尝试清理，并把证据节点与清理结果如实报回来——这是「附件到底行不行」
      唯一不消耗真实会话的读数。
    </div>
    <div id="transportLine" class="hint">投递状态加载中…</div>
    <div id="transportLastLine" class="hint"></div>
    <div id="transportProbeLine" class="hint"></div>

    <label for="sendGapPreset">发送间隔（限流防护）</label>
    <div style="display:flex; gap:8px;">
      <select id="sendGapPreset" style="flex:0 0 150px;">
        <option value="0">0 秒（关闭）</option>
        <option value="2000">2 秒</option>
        <option value="5000">5 秒</option>
        <option value="10000">10 秒</option>
        <option value="30000">30 秒</option>
        <option value="60000">60 秒</option>
        <option value="custom">自定义…</option>
      </select>
      <input type="number" id="sendGapMs" min="0" max="600000" step="500" style="flex:1;" placeholder="毫秒（0–600000）">
    </div>
    <div class="hint">两次向同一网站<b>发送</b>之间的最小间隔（send-to-send：距上一次发出不足这个值就等满，已满足则不等待）。DeepSeek 网页有「消息发送过于频繁」的滑窗限流，长任务工具循环节奏密时容易触发；设置间隔可主动避开。触发限流后桥会按 max(发送间隔, 10 秒) 起步自动退避重试（最多 2 次）。实际等待、目标值与「距上次发送」都在右侧统计的「发送前等待」里逐项显示；该设置会落盘，<b>重启后第一轮同样生效</b>。</div>

    <button type="submit">保存设置</button>
  </form>
  <div id="status"></div>
</div>
<script>
  const API_BASE = '/__webcode';
  // 裸模型 id（历史设置值，如 'deepseek-web'）→ 站点限定 id（'deepseek:deepseek'）
  const MODEL_IDS = ${JSON.stringify(Object.fromEntries(models.map((m) => [m.id.split(':').pop(), m.id])))};
  const SITE_IDS = ${JSON.stringify([...new Set(models.map((m) => m.id.split(':')[0]))])};
  const form = document.getElementById('settingsForm');
  const statusEl = document.getElementById('status');

  async function loadSettings() {
    try {
      const res = await fetch(API_BASE + '/settings');
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      document.getElementById('extraPrompt').value = data.extraPrompt || '';
      document.getElementById('defaultModel').value = MODEL_IDS[data.defaultModel] || data.defaultModel || 'deepseek:deepseek';
      document.getElementById('previewRefreshRate').value = data.previewRefreshRate || 5000;
      document.getElementById('thinkMode').value = ['on', 'off', 'auto'].includes(data.thinkMode) ? data.thinkMode : 'auto';
      document.getElementById('subAgentMode').value = data.subAgentMode === 'share' ? 'share' : 'own';
      const subSiteEl = document.getElementById('subAgentSite');
      if (!subSiteEl.options.length) {
        subSiteEl.innerHTML = '<option value="follow">跟随主线站点（默认）</option>'
          + SITE_IDS.map((s) => '<option value="' + s + '">' + s + '</option>').join('');
      }
      const subSiteVal = data.subAgentSite && SITE_IDS.includes(data.subAgentSite) ? data.subAgentSite : 'follow';
      subSiteEl.value = subSiteVal;
      const gapMs = Math.max(0, Math.round(Number(data.sendGapMs) || 0));
      document.getElementById('sendGapMs').value = gapMs;
      const presetEl = document.getElementById('sendGapPreset');
      presetEl.value = ['0', '2000', '5000', '10000', '30000', '60000'].includes(String(gapMs)) ? String(gapMs) : 'custom';
      // 投递形态：后端（GET /settings）已经带默认值回来（未保存过时是 'attach'），
      // 因此这里只需按值选中；前端不自己造默认值——否则「面板选中项」与「驱动真实
      // 行为」会各有一份默认，而这两者分叉时用户没有任何办法发现。
      const transport = data.promptTransport === 'inline' ? 'inline' : 'attach';
      const radio = document.querySelector('input[name="promptTransport"][value="' + transport + '"]');
      if (radio) radio.checked = true;
    } catch (e) {
      statusEl.textContent = '加载设置失败: ' + e.message;
      statusEl.className = 'error';
    }
  }

  // ---- 首轮提示词（只读模板 + 适配下拉，默认显示） --------------------------
  // 模板由 GET /__webcode/prompt-variants 现算（与真正发出去的那一份同源）。
  // 这里只做展示与切换，不提供编辑——可编辑的只有上面的「全局指令」。
  let variantData = null;
  function renderVariant(id) {
    if (!variantData) return;
    const v = variantData.variants.find((x) => x.id === id) || variantData.variants[0];
    document.getElementById('variantText').textContent = v.text;
    document.getElementById('variantNote').textContent =
      v.note
      + (variantData.active && variantData.active.variantId === v.id ? '（本会话最近一次实际使用的就是这一支）' : '')
      + (variantData.active && variantData.active.variantId !== v.id
        ? '（本会话最近一次实际使用的是「' + ((variantData.variants.find((x) => x.id === variantData.active.variantId) || {}).label || variantData.active.variantId) + '」）'
        : '');
    document.getElementById('variantTools').textContent = variantData.toolsSource === 'placeholder'
      ? '当前工具清单是占位示例——发送第一条消息后会自动换成该会话的真实清单。'
      : (variantData.active && variantData.active.tools && variantData.active.tools.length
        ? '本会话工具：' + variantData.active.tools.join(', ') : '');
  }
  async function loadVariants() {
    try {
      const r = await fetch(API_BASE + '/prompt-variants');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'HTTP ' + r.status);
      variantData = d;
      const sel = document.getElementById('variantSelect');
      sel.innerHTML = d.variants.map((v) => '<option value="' + v.id + '">' + v.label
        + (d.active && d.active.variantId === v.id ? ' · 本会话正在用' : '') + '</option>').join('');
      const want = (d.active && d.active.variantId) || (d.variants[0] && d.variants[0].id);
      sel.value = want;
      renderVariant(want);
    } catch (e) {
      document.getElementById('variantText').textContent = '首轮提示词加载失败：' + e.message;
    }
  }
  document.getElementById('variantSelect').addEventListener('change', (e) => renderVariant(e.target.value));
  loadVariants();

  document.getElementById('syncMainToSub').addEventListener('click', () => {
    const site = (document.getElementById('defaultModel').value || '').split(':')[0];
    if (!site) return;
    document.getElementById('subAgentSite').value = SITE_IDS.includes(site) ? site : 'follow';
    statusEl.textContent = '已把子代理站点设为 ' + site + '（尚未保存，请点「保存设置」）';
    statusEl.className = '';
  });
  document.getElementById('syncSubToMain').addEventListener('click', () => {
    const site = document.getElementById('subAgentSite').value;
    if (!site || site === 'follow') { statusEl.textContent = '子代理站点为「跟随主线」，无需同步'; statusEl.className = ''; return; }
    const modelSel = document.getElementById('defaultModel');
    const preferred = site + ':auto';
    const hit = Array.from(modelSel.options).find(o => o.value === preferred) ? preferred
      : (Array.from(modelSel.options).find(o => o.value.startsWith(site + ':')) || {}).value;
    if (hit) {
      modelSel.value = hit;
      statusEl.textContent = '已把主线默认模型设为 ' + hit + '（尚未保存，请点「保存设置」）';
      statusEl.className = '';
    }
  });

  document.getElementById('sendGapPreset').addEventListener('change', (e) => {
    if (e.target.value !== 'custom') document.getElementById('sendGapMs').value = e.target.value;
  });

  // ---- 投递形态的「生效值 + 最近一次实际结果」（0.16.3） ----------------------
  // 三行文案全部由服务端算好（GET /attach-status）：这条读数的口径与驱动内的判据
  // 同源，浏览器侧再写一份格式化就会出现「面板说成功了、驱动其实回落了」。
  // 记录成因（用户原话）：「没有做到能够把提示词放入文本（设置界面也改为打开文本）
  // 导致输出对话一开头就很长 token 窗口」——真机读数是 attachTransport
  // {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}，而当时面板上
  // 一个字都没有，用户只能看到「对话一开头很长」。
  async function loadTransportStatus() {
    const line = document.getElementById('transportLine');
    try {
      const d = await fetch(API_BASE + '/attach-status').then((r) => r.json());
      if (!d || !d.ok) throw new Error((d && d.error) || 'HTTP');
      line.textContent = '当前生效：' + d.transportLine;
      document.getElementById('transportLastLine').textContent = '最近一次实际投递：' + d.lastLine;
      document.getElementById('transportProbeLine').textContent = '附件探针：' + d.probeLine;
    } catch (e) {
      line.textContent = '投递状态读取失败：' + (e && e.message ? e.message : e);
    }
  }

  document.getElementById('attachProbeBtn').addEventListener('click', async () => {
    // 探针有副作用（一次真实上传），因此先显式征得同意再跑——上传是外部动作，
    // 不该由一个「看看」的点击悄悄触发。清理路径在服务端（probeAttachment 的
    // cleanupAttachment），无论成功失败都会被走到。
    if (!window.confirm('附件探针会向当前网页会话上传一个 webcode-probe.md（只上传、绝不发送），上传后立即尝试清理。继续？')) return;
    const btn = document.getElementById('attachProbeBtn');
    const out = document.getElementById('transportProbeLine');
    btn.disabled = true;
    out.textContent = '附件探针运行中（最多 20 秒）…';
    try {
      // 这里**不用** apiPost：探针「未确认附件」时回的是 { ok:false, ... } 但
      // HTTP 仍是 200，而 apiPost 会把 ok:false 当异常抛掉——那样最要紧的那次
      // 读数（失败现场）就正好被显示层吞了。
      const res = await fetch(API_BASE + '/attach-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '# webcode attach probe\n' + new Date().toISOString() + '\n' }),
      });
      const text = await res.text().catch(() => '');
      out.textContent = '附件探针返回：' + (text || '(空响应)').slice(0, 600);
    } catch (e) {
      out.textContent = '附件探针请求失败：' + (e && e.message ? e.message : e);
    } finally {
      btn.disabled = false;
      loadTransportStatus();
    }
  });

  // ---- 子代理账户与登录管理（与原生面板同一套端点：login / verify-login / window） ----
  const subAccountBlock = document.getElementById('subAccountBlock');
  const subAccountFollow = document.getElementById('subAccountFollow');
  const subSiteState = document.getElementById('subSiteState');
  const subSiteName = document.getElementById('subSiteName');
  const subAccountStatus = document.getElementById('subAccountStatus');
  let subWinOpen = false;
  let subBusy = false;

  async function apiPost(name, body) {
    const res = await fetch(API_BASE + '/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    // 先读文本再解析：后端 405/404 回的是空 body 时，直接 .json() 会抛
    // “unexpected end of JSON data”，把真实状态码吞掉（0.12.9 真机 bug）。
    const text = await res.text().catch(() => '');
    const ctype = res.headers.get('content-type') || '';
    let data = null;
    if (text && ctype.includes('json')) { try { data = JSON.parse(text); } catch { /* 下面按空处理 */ } }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error('HTTP ' + res.status + '：'
        + ((data && (data.error || data.message)) || text.slice(0, 160) || '无响应内容'));
    }
    return data || {};
  }

  /** 不抛异常的 POST：行内显示失败原因用。 */
  async function apiSoftPost(name, body) {
    try { return { ok: true, data: await apiPost(name, body) }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  }

  function setSubState(s) {
    subSiteState.className = 'state ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle');
    subSiteState.textContent = s.loggedIn === true ? (s.loggedInCached ? '已登录(缓存)' : '已登录') : s.loggedIn === false ? '未登录' : '待检查';
    subSiteState.title = basisText(s);
    document.getElementById('subLogin').textContent = s.loggedIn === true ? '更换账户' : '登录';
  }

  // 判定依据（loginBasis）是后端已经给出的真相，0.12.9 之前 UI 完全没露出——
  // 于是「未登录」看起来像凭空断言。这里把它翻译成一句人话做 hover 说明。
  function basisText(s) {
    const when = s.loginCheckedAt ? new Date(s.loginCheckedAt).toLocaleTimeString() : '';
    const basis = s.loginBasis === 'probe-bad' ? '命中站点未登录特征'
      : s.loginBasis === 'probe-ok' ? '命中站点登录特征'
        : s.loginBasis === 'probe-fallback' ? '站点特征未命中，回退输入框判定'
          : s.loginBasis === 'input-fallback' ? '按输入框存在与否推断（该站点未声明登录特征）'
            : s.loginBasis === 'stale' ? '旧版本结论，已被忽略'
              : '尚未核验';
    return '判定依据：' + basis + (when ? ' · ' + when + ' 核验' : '');
  }

  async function refreshSubAccount() {
    const site = document.getElementById('subAgentSite').value;
    if (!site || site === 'follow') {
      subAccountBlock.style.display = 'none';
      subAccountFollow.style.display = '';
      return;
    }
    subAccountBlock.style.display = '';
    subAccountFollow.style.display = 'none';
    subSiteName.textContent = site;
    try {
      const st = await fetch(API_BASE + '/status').then((r) => r.json());
      const hit = (st.sites || []).find((s) => s.siteId === site);
      if (hit) setSubState(hit);
    } catch (e) { /* 状态拿不到就维持当前显示 */ }
    try {
      const w = await fetch(API_BASE + '/window').then((r) => r.json());
      subWinOpen = Boolean(w.windows && w.windows[site] && w.windows[site].open);
      document.getElementById('subWindow').textContent = subWinOpen ? '收起窗口' : '独立窗口';
    } catch (e) { /* 同上 */ }
  }

  async function subAction(kind) {
    const site = document.getElementById('subAgentSite').value;
    if (!site || site === 'follow' || subBusy) return;
    subBusy = true;
    subAccountStatus.textContent = '';
    subAccountStatus.className = 'hint';
    const btns = ['subLogin', 'subVerify', 'subWindow'].map((id) => document.getElementById(id));
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (kind === 'login') {
        subAccountStatus.textContent = '等待登录完成…（最长 5 分钟，请在弹出的 Edge 窗口内完成登录）';
        const r = await apiSoftPost('login', { siteId: site, wait: true, timeoutMs: 300000 });
        if (!r.ok) {
          subAccountStatus.textContent = '✗ ' + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          subAccountStatus.textContent = (d.alreadyLoggedIn ? '登录态仍有效，无需重复登录' : (d.message || '登录完成'))
            + (d.ms ? '（' + Math.round(d.ms / 1000) + 's）' : '');
          subAccountStatus.className = d.loggedIn === true ? 'success' : 'error';
        }
      } else if (kind === 'verify') {
        const r = await apiSoftPost('verify-login', { siteId: site });
        if (!r.ok) {
          subAccountStatus.textContent = '✗ 检测失败：' + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          // 三态：true / false / null（null = 该站点尚未打开过，不是错误）。
          subAccountStatus.textContent = d.loggedIn === true ? '✓ 已检测到登录态'
            : d.loggedIn === false ? '✓ 检测完成：仍未登录（请在独立窗口完成登录后再检测）'
              : '✓ 检测完成：待检查（该站点尚未打开过，点「独立窗口」打开一次后再检测）';
          subAccountStatus.className = d.loggedIn === false ? 'error' : 'success';
        }
      } else if (kind === 'window') {
        const r = await apiSoftPost('window', { siteId: site, action: subWinOpen ? 'close' : 'open' });
        if (!r.ok) {
          subAccountStatus.textContent = '✗ ' + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          subAccountStatus.textContent = (d && d.alreadyOpen) ? '窗口已存在——已聚焦弹到最前'
            : (subWinOpen ? '独立窗口已收起，回到无头运行' : '独立窗口已打开（与桥共用登录态）');
        }
      }
    } catch (e) {
      subAccountStatus.textContent = '✗ ' + e.message;
      subAccountStatus.className = 'error';
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      subBusy = false;
      await refreshSubAccount();
    }
  }

  document.getElementById('subLogin').addEventListener('click', () => subAction('login'));
  document.getElementById('subVerify').addEventListener('click', () => subAction('verify'));
  document.getElementById('subWindow').addEventListener('click', () => subAction('window'));
  document.getElementById('subAgentSite').addEventListener('change', refreshSubAccount);
  setInterval(refreshSubAccount, 20000);
  // 投递读数轮询（15s）：真机出问题时用户往往就停在这一页上，读数必须自己更新，
  // 不能要求他手动刷新（旧版本这一页对附件投递完全沉默）。
  setInterval(loadTransportStatus, 15000);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      extraPrompt: document.getElementById('extraPrompt').value,
      defaultModel: document.getElementById('defaultModel').value,
      previewRefreshRate: parseInt(document.getElementById('previewRefreshRate').value, 10) || 5000,
      thinkMode: document.getElementById('thinkMode').value,
      subAgentMode: document.getElementById('subAgentMode').value,
      subAgentSite: document.getElementById('subAgentSite').value || 'follow',
      sendGapMs: Math.max(0, parseInt(document.getElementById('sendGapMs').value, 10) || 0),
      // 投递形态（0.16.3）：只有逐字 'inline' 才是「永远纯文本」；服务端在写入侧
      // 还会再归一化一次（见 web-control 的 POST settings），两处判据同源。
      promptTransport: (document.querySelector('input[name="promptTransport"]:checked') || {}).value === 'inline' ? 'inline' : 'attach',
    };
    try {
      const res = await fetch(API_BASE + '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('保存失败');
      const result = await res.json();
      statusEl.textContent = '✅ 设置已保存';
      statusEl.className = 'success';
      // 全局指令改了 → 上方模板的文本也跟着变；不重拉的话用户会以为没生效。
      loadVariants();
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.className = 'error';
    }
  });

  loadSettings().then(refreshSubAccount).then(loadTransportStatus).catch(() => {});
</script>
</body>
</html>`;;
}
