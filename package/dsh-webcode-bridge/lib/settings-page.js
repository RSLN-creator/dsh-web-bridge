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

    <button type="submit">保存设置</button>
  </form>
  <div id="status"></div>
</div>
<script>
  const API_BASE = '/__webcode';
  // 裸模型 id（历史设置值，如 'deepseek-web'）→ 站点限定 id（'deepseek:deepseek'）
  const MODEL_IDS = ${JSON.stringify(Object.fromEntries(models.map((m) => [m.id.split(':').pop(), m.id])))};
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
    } catch (e) {
      statusEl.textContent = '加载设置失败: ' + e.message;
      statusEl.className = 'error';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      extraPrompt: document.getElementById('extraPrompt').value,
      defaultModel: document.getElementById('defaultModel').value,
      previewRefreshRate: parseInt(document.getElementById('previewRefreshRate').value, 10) || 5000,
      thinkMode: document.getElementById('thinkMode').value,
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
