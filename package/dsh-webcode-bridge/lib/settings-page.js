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
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #f5f5f7;
  color: #1d1d1f;
  padding: 32px 16px 64px;
  max-width: 640px;
  margin: 0 auto;
  -webkit-font-smoothing: antialiased;
}
.header { margin-bottom: 24px; text-align: left; }
.header h1 { font-size: 24px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.4px; }
.header p { font-size: 14px; color: #86868b; margin: 0; }

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: #6e6e73;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 0 12px 8px;
  margin-top: 24px;
}
.section-group {
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03), 0 4px 12px rgba(0,0,0,0.02);
  border: 0.5px solid rgba(0,0,0,0.08);
  overflow: hidden;
  margin-bottom: 20px;
}
.form-row {
  padding: 14px 16px;
  border-bottom: 0.5px solid rgba(0,0,0,0.06);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-row:last-child { border-bottom: none; }
.form-row-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
label { font-size: 14px; font-weight: 500; color: #1d1d1f; margin: 0; }
.hint { font-size: 12px; line-height: 1.45; color: #86868b; margin-top: 2px; }

textarea, select, input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  font-size: 14px;
  color: #1d1d1f;
  background: #fff;
  transition: border-color 0.15s, box-shadow 0.15s;
}
textarea:focus, select:focus, input:focus {
  outline: none;
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
}
textarea { min-height: 84px; font-family: inherit; line-height: 1.45; }

button.primary {
  background: #0071e3;
  color: white;
  border: none;
  padding: 12px 20px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  margin-top: 24px;
  width: 100%;
  transition: background-color 0.15s;
}
button.primary:hover { background: #0077ed; }
button.primary:active { background: #006edb; }

button.mini {
  width: auto;
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  background: #f5f5f7;
  color: #1d1d1f;
  border: 0.5px solid #d2d2d7;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
button.mini:hover { background: #e8e8ed; border-color: #c7c7cc; }

pre.preset {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.55;
  background: #f5f5f7;
  border-radius: 8px;
  padding: 10px;
  margin: 8px 0 0;
  border: 0.5px solid rgba(0,0,0,0.06);
}

.site-prompt {
  border: 0.5px solid rgba(0,0,0,0.08);
  border-radius: 10px;
  padding: 10px 12px;
  margin-top: 8px;
  background: #fafafa;
}
.site-prompt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.site-prompt-name { font-size: 13px; font-weight: 600; }
.site-prompt details { margin-top: 6px; }
.site-prompt summary { font-size: 12px; color: #0071e3; cursor: pointer; user-select: none; }

.native-spec-box {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.native-spec-card {
  border: 0.5px solid rgba(0,0,0,0.08);
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafafa;
}
.native-spec-card summary {
  font-size: 13px;
  font-weight: 600;
  color: #1d1d1f;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.native-spec-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: #f0f0f2;
  color: #6e6e73;
  margin-left: 6px;
}
.native-spec-desc {
  font-size: 12px;
  line-height: 1.5;
  color: #48484a;
  margin: 6px 0 4px;
}

.state { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.state.ok { background: #eafaf1; color: #2e7d32; }
.state.bad { background: #fdf2f2; color: #d32f2f; }
.state.idle { background: #f0f0f2; color: #6e6e73; }

#status { margin-top: 14px; padding: 10px 14px; border-radius: 8px; font-size: 13px; }
.success { background: #eafaf1; color: #2e7d32; }
.error { background: #fdf2f2; color: #d32f2f; }
</style>
</head>
<body>
  <div class="header">
    <h1>⚙️ Webcode Bridge 设置</h1>
    <p>管理模型、提示词、会话节奏与子代理分配策略</p>
  </div>

  <form id="settingsForm">
    <!-- 分组 1: 模型与模式 -->
    <div class="section-title">模型与模式</div>
    <div class="section-group">
      <div class="form-row">
        <label for="defaultModel">默认模型</label>
        <select id="defaultModel">
          ${models.map((m) => `<option value="${m.id}">${m.name}${m.experimental ? '（实验）' : ''}</option>`).join('\n          ')}
        </select>
        <div class="hint">新建会话时默认启用的模型。支持 DeepSeek、GLM、Z.ai、豆包、Kimi、通义千问等。</div>
      </div>
      <div class="form-row">
        <label for="thinkMode">深度思考</label>
        <select id="thinkMode">
          <option value="auto">自动（按所选模型的默认思考行为）</option>
          <option value="on">始终开启（强制打开网页「深度思考」开关）</option>
          <option value="off">始终关闭（追求快速回复）</option>
        </select>
        <div class="hint">控制网页端的深度思考模式；自动模式将遵循模型的原生属性（如 DeepSeek 默认开启）。</div>
      </div>
    </div>

    <!-- 分组 2: 指令与提示词 -->
    <div class="section-title">指令与提示词</div>
    <div class="section-group">
      <div class="form-row">
        <label for="extraPrompt">全局指令（首轮注入）</label>
        <textarea id="extraPrompt" placeholder="例如：请始终使用中文回答..."></textarea>
        <div class="hint">追加一段 [全局指令] 注入每个新网页会话的首条消息。各网站专属指令请在原生面板的站点页配置。</div>
      </div>
      <div class="form-row">
        <div class="form-row-header">
          <label>各模型原生工具调用规范与教学参考</label>
        </div>
        <div class="hint">汇总各大模型官方训练模板、原生标签/JSON 结构与网页端调用教学规范。</div>
        <div class="native-spec-box">
          <details class="native-spec-card">
            <summary>智谱清言 (GLM) & Z.ai <span class="native-spec-tag">XML 标签 / JSON 代码块</span></summary>
            <div class="native-spec-desc">
              <b>官方 Chat Template：</b><code>&lt;tool_call&gt;{name}&lt;arg_key&gt;{k}&lt;/arg_key&gt;&lt;arg_value&gt;{v}&lt;/arg_value&gt;&lt;/tool_call&gt;</code><br>
              <b>网页避拦截推荐：</b>使用 <code>\`\`\`json {"mcp_action":"call","name":"...","arguments":{...}} \`\`\`</code> 代码块（避免被网页内置沙箱抢夺）。<br>
              <b>首轮教学提示词：</b>
              <pre class="preset">[本地工具传输协议]
必须使用 \`\`\`json 代码块发起工具调用：
先写一行 \`\`\`json，下一行是单个 JSON 对象 {"mcp_action":"call","name":"实际工具名","purpose":"原因","arguments":{…}}，再以一行 \`\`\` 结束。
警告：不要使用 &lt;tool_call&gt;…&lt;/tool_call&gt; 或任何 XML 标签包裹调用——本网页会把这类标签当成它自己的内置工具抢走执行并报 unknown tool call；只有 \`\`\`json 代码块能到达本地工具网关。
工具名和参数必须严格匹配 schema。一旦判定需要真实数据，立即发起调用并停止输出，等待真实工具结果；拿到结果后直接给出最终答复。</pre>
              <b>增量轮再教学：</b>
              <pre class="preset">[系统提示] 请保持工具调用格式：先写一行 \`\`\`json，其内为单个 JSON 对象 {"mcp_action":"call","name":"工具名","purpose":"原因","arguments":{…}}，再以一行 \`\`\` 结束；不要用 &lt;tool_call&gt; 等标签包裹。</pre>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>豆包 (Doubao) <span class="native-spec-tag">Doubao-Seed 2.0 / &lt;seed:tool_call&gt;</span></summary>
            <div class="native-spec-desc">
              <b>官方训练规范：</b><code>&lt;seed:tool_call&gt;{"name":"...","arguments":{...}}&lt;/seed:tool_call&gt;</code> 或标准 <code>&lt;tool_call&gt;</code><br>
              <b>首轮教学提示词：</b>
              <pre class="preset">[本地工具传输协议]
必须使用 &lt;seed:tool_call&gt;{"name":"实际工具名","arguments":{…}}&lt;/seed:tool_call&gt; 或 &lt;tool_call&gt;{"mcp_action":"call","name":"实际工具名","arguments":{…}}&lt;/tool_call&gt; 发起工具调用。
工具名和参数必须严格匹配 schema。一旦判定需要真实数据，立即发起调用并停止输出，等待真实工具结果；拿到全部所需结果后，直接给出简洁答复。</pre>
              <b>增量轮再教学：</b>
              <pre class="preset">[系统提示] 请保持工具调用格式：以 &lt;tool_call&gt; 或 &lt;seed:tool_call&gt; 开始、闭合标签结束，其内为单个 JSON 对象。</pre>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>月之暗面 (Kimi) <span class="native-spec-tag">Kimi-K2 / Connect-RPC 流式</span></summary>
            <div class="native-spec-desc">
              <b>官方规范：</b><code>&lt;tool_call&gt;\n{"name":"...","arguments":{...}}\n&lt;/tool_call&gt;</code><br>
              <b>网页传输特征：</b>Connect-RPC 二进制流（<code>[flags(1)][len(4BE)][json]</code>），正文与思考分流。<br>
              <b>首轮教学提示词：</b>
              <pre class="preset">[本地工具传输协议]
必须使用 &lt;tool_call&gt;{"name":"实际工具名","arguments":{…}}&lt;/tool_call&gt; 发起工具调用。
工具名和参数必须严格匹配声明的 schema。调用输出后立即停止生成，等待返回结果后继续。</pre>
              <b>增量轮再教学：</b>
              <pre class="preset">[系统提示] 请保持工具调用格式：以 &lt;tool_call&gt; 开始、&lt;/tool_call&gt; 结束，内含 JSON 工具调用声明。</pre>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>通义千问 (Qwen) <span class="native-spec-tag">ChatML # Tools / &lt;tool_call&gt;</span></summary>
            <div class="native-spec-desc">
              <b>官方 ChatML 规范：</b><code>&lt;|im_start|&gt;assistant&lt;tool_call&gt;...&lt;/tool_call&gt;&lt;|im_end|&gt;</code><br>
              <b>首轮教学提示词：</b>
              <pre class="preset">[本地工具传输协议]
# Tools
必须使用 &lt;tool_call&gt;{"name":"实际工具名","arguments":{…}}&lt;/tool_call&gt; 格式发起工具调用。
请严格根据提供的工具函数定义进行调用，参数名称与类型必须匹配。输出调用后立即结束当前回复，等待工具执行结果注入。</pre>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>DeepSeek <span class="native-spec-tag">官方训练模板（唯一端到端基线）</span></summary>
            <div class="native-spec-desc">
              <b>官方训练格式：</b>
              <pre class="preset">&lt;｜tool calls begin｜&gt;&lt;｜tool call begin｜&gt;function&lt;｜tool sep｜&gt;{name}
\`\`\`json
{arguments}
\`\`\`&lt;｜tool call end｜&gt;&lt;｜tool calls end｜&gt;</pre>
              <b>教学规范：</b>完全遵循 DeepSeek 官方 token 序列，保持 official 模式不变。
            </div>
          </details>
        </div>
      </div>
      <div class="form-row">
        <label>首轮提示词模板（只读）</label>
        <div class="hint">各网站实际使用的传输协议与本地存储文件（可点击直接打开）。</div>
        <div id="sitePrompts">加载中…</div>
        <div id="variantTools" class="hint"></div>
      </div>
      <div class="form-row">
        <label>提示词投递形态</label>
        <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-top:4px;">
          <label style="display:flex; gap:6px; align-items:center; font-weight:400; font-size:13px; cursor:pointer;">
            <input type="radio" name="promptTransport" value="attach" style="width:auto;"> 附件投递（默认推荐）
          </label>
          <label style="display:flex; gap:6px; align-items:center; font-weight:400; font-size:13px; cursor:pointer;">
            <input type="radio" name="promptTransport" value="inline" style="width:auto;"> 纯文本输入
          </label>
          <button type="button" id="attachProbeBtn" class="mini">附件探针</button>
        </div>
        <div class="hint">长文本改走附件上传，避免超大正文灌入输入框引起页面卡死或截断。探针可在不消耗会话的情况下核验上传能力。</div>
        <div id="transportLine" class="hint">投递状态加载中…</div>
        <div id="transportLastLine" class="hint"></div>
        <div id="transportProbeLine" class="hint"></div>
      </div>
    </div>

    <!-- 分组 3: 速度与排队 -->
    <div class="section-title">速度与排队保护</div>
    <div class="section-group">
      <div class="form-row">
        <label for="sendGapPreset">发送间隔（防频控限制）</label>
        <div style="display:flex; gap:8px;">
          <select id="sendGapPreset" style="flex:0 0 140px;">
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
        <div class="hint">设置两次向同一站点发送消息的最小主动等待间隔，降低触发网页端风控的风险。</div>
      </div>
      <div class="form-row">
        <label for="sendGapBasis">间隔基准</label>
        <select id="sendGapBasis">
          <option value="send-to-send">距上次发出（send-to-send，推荐）</option>
          <option value="end-to-start">距上次回复完成（end-to-start）</option>
        </select>
        <div class="hint">「距上次发出」针对滑窗频控；「距上次回复完成」控制对话节奏避免过密回复。</div>
      </div>
      <div class="form-row">
        <label for="previewRefreshRate">预览刷新率 (毫秒)</label>
        <input type="number" id="previewRefreshRate" min="1000" max="30000" step="500" value="5000">
        <div class="hint">控制右侧栏镜像页面自动刷新状态的周期（默认 5000ms）。</div>
      </div>
    </div>

    <!-- 分组 4: 子代理与会话 -->
    <div class="section-title">子代理与多会话</div>
    <div class="section-group">
      <div class="form-row">
        <label for="subAgentMode">子代理网页会话分配</label>
        <select id="subAgentMode">
          <option value="own">独立（推荐）：每个子代理开启独立网页对话</option>
          <option value="share">共用：所有子代理与主会话共用同一网页对话</option>
        </select>
        <div class="hint">控制 DSH 并行子代理在网页端的隔离方式。</div>
      </div>
      <div class="form-row">
        <label for="subAgentSite">子代理站点分流</label>
        <select id="subAgentSite"></select>
        <div class="hint">为子代理指定专用站点以分流主线请求，避免单站点并发过密导致限流。</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
          <button type="button" id="syncMainToSub" class="mini">主线站点 → 子代理</button>
          <button type="button" id="syncSubToMain" class="mini">子代理站点 → 主线</button>
        </div>
        <div id="subAccountFollow" class="hint" style="display:none; margin-top:6px;">当前跟随主线站点，无需单独登录。</div>
        <div id="subAccountBlock" style="display:none; margin-top:10px; padding:10px 12px; border:0.5px solid rgba(0,0,0,0.08); border-radius:10px; background:#fafafa;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <b id="subSiteName" style="font-size:13px;"></b>
            <span id="subSiteState" class="state idle">待检查</span>
            <button type="button" id="subLogin" class="mini">登录</button>
            <button type="button" id="subVerify" class="mini">检测</button>
            <button type="button" id="subWindow" class="mini">独立窗口</button>
            <button type="button" id="subOpenSite" class="mini">打开网站</button>
          </div>
          <div id="subAccountStatus" class="hint"></div>
        </div>
      </div>
    </div>

    <button type="submit" class="primary">保存设置</button>
  </form>
  <div id="status"></div>
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
      // 间隔基准（0.16.31）：与投递形态同一条纪律——**后端给默认值**（未保存过时
      // 是 'send-to-send'），前端只按值选中，不自己造默认。前端各造一份默认，
      // 「面板选中项」与「真实行为」分叉时用户没有任何办法发现。
      document.getElementById('sendGapBasis').value =
        data.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
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

  // ---- 首轮提示词（按网站逐行，只读，默认显示） ------------------------------ 
  // 模板由 GET /__webcode/prompt-variants 现算（与真正发出去的那一份同源）。
  // 服务端的 sites 数组已把「每个网站 → 它实际会用的协议 + 该协议的模板全文」
  // 算好；本页只渲染与切换预览，不提供编辑——可编辑的只有上面的「全局指令」。
  //
  // 为什么按网站列而不是按协议列：用户要看的是「这个网站到底会收到什么」，
  // 而协议只有三支、网站有十个——按协议列时，用户得自己去推断「我这个站算哪支」。
  let variantData = null;
  const sitePick = {};   // siteId → 预览选中的协议 id（缺省 = 该网站真实在用的）
  function variantById(id) {
    if (!variantData) return null;
    return variantData.variants.find((x) => x.id === id) || variantData.variants[0];
  }
  function renderSiteText(siteId) {
    if (!variantData) return;
    const row = (variantData.sites || []).find((s) => s.siteId === siteId);
    if (!row) return;
    const picked = sitePick[siteId] || row.variantId;
    const v = variantById(picked);
    const realLabel = (variantById(row.variantId) || {}).label || row.variantId;
    const previewing = picked !== row.variantId;
    const textEl = document.getElementById('siteText-' + siteId);
    const noteEl = document.getElementById('siteNote-' + siteId);
    const stateEl = document.getElementById('siteState-' + siteId);
    if (textEl) textEl.textContent = v ? v.text : '';
    if (noteEl) noteEl.textContent = (v ? v.note + ' ' : '') + (v ? '再教学提示：' + v.trainNote : '');
    if (stateEl) {
      stateEl.textContent = '实际使用：' + realLabel + (previewing ? '（下方为预览，未生效）' : '');
    }
  }
  // 0.16.38：每行不再给「协议预览下拉」，改为「协议名 + 本地提示词文件 + 打开按钮」。
  // 协议下拉只让用户**以为**能切换真实选路（它从来只能预览），而用户真正需要的是
  // 「这个站点的提示词存在哪个文件、怎么打开它」。文件路径由服务端给（同一次
  // /prompt-variants 的 sites[].file），本页只显示与触发打开。
  function renderSiteRows(d) {
    const byId = new Map((d.variants || []).map((v) => [v.id, v]));
    document.getElementById('sitePrompts').innerHTML = (d.sites || []).map((row) => {
      const realLabel = (byId.get(row.variantId) || {}).label || row.variantId;
      return '<div class="site-prompt">'
        + '<div class="site-prompt-head">'
        + '<span class="site-prompt-name">' + row.siteName + '</span>'
        + '<span class="hint" id="siteState-' + row.siteId + '">实际使用：' + realLabel + '</span>'
        + '<button type="button" class="mini" data-open-site="' + row.siteId + '">用默认程序打开</button>'
        + '</div>'
        + '<div class="hint" id="siteFile-' + row.siteId + '"></div>'
        + '<details><summary>查看该协议的完整模板</summary>'
        + '<div class="hint" id="siteNote-' + row.siteId + '"></div>'
        + '<pre id="siteText-' + row.siteId + '" class="preset"></pre>'
        + '</details>'
        + '</div>';
    }).join('');
    // 事件绑定放在 innerHTML 之后（重建过节点，旧引用会失效）。
    document.querySelectorAll('[data-open-site]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.getAttribute('data-open-site');
        btn.disabled = true;
        try {
          const r = await fetch(API_BASE + '/prompt-file', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ siteId: sid }),
          });
          const j = await r.json();
          const el = document.getElementById('siteFile-' + sid);
          if (el) el.textContent = j.ok ? '已用系统默认程序打开：' + j.file
            : (j.code === 'PROMPT_FILE_MISSING' ? '提示词文件还没生成——发送第一条消息后自动落盘：' + j.file
              : (j.code === 'PROMPT_STORE_OFF' ? '提示词落盘已被显式关闭（WEBCODE_PROMPT_STORE_DIR=off）。'
                : '打开失败：' + (j.code || j.error || '未知') + (j.file ? ' 文件：' + j.file : '')));
        } catch (e) {
          const el = document.getElementById('siteFile-' + sid);
          if (el) el.textContent = '打开失败：' + e.message;
        } finally { btn.disabled = false; }
      });
    });
    (d.sites || []).forEach((row) => {
      const el = document.getElementById('siteFile-' + row.siteId);
      if (el) el.textContent = row.file || '';
      renderSiteText(row.siteId);
    });
  }
  async function loadVariants() {
    try {
      const r = await fetch(API_BASE + '/prompt-variants');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'HTTP ' + r.status);
      variantData = d;
      renderSiteRows(d);
      document.getElementById('variantTools').textContent = d.toolsSource === 'placeholder'
        ? '当前工具清单是占位示例——发送第一条消息后会自动换成该会话的真实清单。'
        : (d.active && d.active.tools && d.active.tools.length
          ? '本会话工具：' + d.active.tools.join(', ') : '');
    } catch (e) {
      document.getElementById('sitePrompts').textContent = '首轮提示词加载失败：' + e.message;
    }
  }
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

  const SITE_NAMES_MAP = {
    deepseek: 'DeepSeek', glm: '智谱清言', chatgpt: 'ChatGPT', kimi: 'Kimi',
    qwen: '通义千问', doubao: '豆包', grok: 'Grok', claude: 'Claude',
    gemini: 'Gemini', zai: 'Z.ai'
  };
  const SITE_ORIGINS_MAP = {
    deepseek: 'https://chat.deepseek.com',
    glm: 'https://chatglm.cn',
    chatgpt: 'https://chatgpt.com',
    kimi: 'https://kimi.com',
    qwen: 'https://chat.qwen.ai',
    doubao: 'https://www.doubao.com',
    grok: 'https://grok.com',
    claude: 'https://claude.ai',
    gemini: 'https://gemini.google.com',
    zai: 'https://chat.z.ai'
  };

  document.getElementById('subLogin').addEventListener('click', () => subAction('login'));
  document.getElementById('subVerify').addEventListener('click', () => subAction('verify'));
  document.getElementById('subWindow').addEventListener('click', () => subAction('window'));
  document.getElementById('subOpenSite').addEventListener('click', () => {
    const site = document.getElementById('subAgentSite').value;
    if (!site || site === 'follow') return;
    const url = SITE_ORIGINS_MAP[site] || ('https://' + site);
    window.open(url, '_blank');
    subAccountStatus.textContent = '已打开 ' + (SITE_NAMES_MAP[site] || site) + '（在 Harness 内可直接通过右侧栏 Web Bridge 或内置浏览器打开与登录）。';
    subAccountStatus.className = 'hint';
  });
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
      // 间隔基准（0.16.31）：只有逐字 'end-to-start' 才是「答完再等」；服务端在
      // 写入侧还会再归一化一次（见 web-control 的 POST settings），两处判据同源。
      sendGapBasis: document.getElementById('sendGapBasis').value === 'end-to-start' ? 'end-to-start' : 'send-to-send',
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
