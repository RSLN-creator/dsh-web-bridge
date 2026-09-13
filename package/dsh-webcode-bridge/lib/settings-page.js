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
button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-top: 16px; width: 100%; }
button:hover { background: #1d4ed8; }
#status { margin-top: 12px; padding: 8px; border-radius: 6px; }
.success { background: #dcfce7; color: #166534; }
.error { background: #fee2e2; color: #991b1b; }
.hint { font-size: 13px; color: #6b7280; margin-top: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>⚙️ Webcode Bridge 设置</h1>
  <form id="settingsForm">
    <label for="extraPrompt">全局指令（首轮注入）</label>
    <textarea id="extraPrompt" placeholder="例如：请始终使用中文回答..."></textarea>
    <div class="hint">这段文本会追加到每个新网页会话的第一条用户消息之前。</div>

    <label for="defaultModel">默认模型</label>
    <select id="defaultModel">
      ${models.map((m) => `<option value="${m.id}">${m.name}（${m.siteName}${m.experimental ? ' · 实验' : ''}）</option>`).join('\n      ')}
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
    <div class="hint">两次向同一网站发送消息之间的最小间隔（本地回复到网页发送的等待时间）。DeepSeek 网页有「消息发送过于频繁」的滑窗限流，长任务工具循环节奏密时容易触发；设置间隔可主动避开。触发限流后桥会按 max(发送间隔, 10 秒) 起步自动退避重试（最多 2 次）。实际等待在右侧统计的「发送前等待」单独展示。</div>

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
    } catch (e) {
      statusEl.textContent = '加载设置失败: ' + e.message;
      statusEl.className = 'error';
    }
  }

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
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.className = 'error';
    }
  });

  loadSettings();
</script>
</body>
</html>`;;
}
