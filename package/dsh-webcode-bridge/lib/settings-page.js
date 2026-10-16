// settings-page.js — 独立设置页（/__webcode/settings-page）的静态 HTML。
// 从 index.js 抽出（第一轮可维护性优化）：纯展示模板，不依赖运行时状态；
// 模型目录在挂载时注入，保持与 DSH 原生设置面板（client.cjs）互不干扰。
// 注意：新增设置项时两处都要改（原生面板 client.cjs / 本页），字段名以
// configManager 的 defaultConfig 为准。
//
// ## 0.19.80：本页**不再手写协议文本**（红线 3 的一次真实违反，已修）
//
// 本页原先在 `native-spec-card` 里**手写**了各模型的「首轮教学提示词」，而它与
// `lib/agent-preset.js`（**唯一协议真源**）实际发送的文本**不一致** —— 真机复核读数：
//
//   | 站点 | 本页原先教的 | 真源实际教的 | 后果 |
//   | --- | --- | --- | --- |
//   | GLM | ````json` 代码块 | 同（正确） | — |
//   | Doubao | `<seed:tool_call>{"name":…}</seed:tool_call>` **或** `<tool_call>…` | `<tool_call>{"mcp_action":"call",…}</tool_call>` | **教了真源从不教的 `seed:tool_call`**，且缺 `mcp_action` |
//   | Kimi | `<tool_call>{"name":…,"arguments":…}</tool_call>` | 同上（带 `mcp_action`） | 缺 `mcp_action` |
//   | Qwen | `# Tools` + `<tool_call>{"name":…}` | 同上（带 `mcp_action`） | 缺 `mcp_action`、多教 `# Tools` |
//
// 而 `agent-preset.js:2553` 的**唯一解析判据**是 `tagged || obj.mcp_action === 'call'`
// ⇒ 本页教的裸 JSON 形状（无 `mcp_action`）**解析不了**。用户照抄会得到「调用了但没执行」。
//
// `seed:tool_call` 的三处分布（决定性）：解析器认它（`agent-preset.js:2712` 的宽容外壳）、
// 本页教它、而**教学侧（`transportNoteFor`）零出现** —— 即「桥自己不教、却在设置页教用户写」。
//
// **修法**：把真源的教学文本**从外面传进来**（`teaching` 参数），本页只做展示。
// 这与 `lib/tool-transport.js`、`lib/prompt-variants.js` 是同一条纪律：
// **只读立面只许调用真源，不许自己拼协议文本**。

/**
 * @param {Array<{id:string,name:string,siteName:string,experimental?:boolean}>} models 模型目录
 * @param {object} [teaching] 真源教学文本（由调用方从 `lib/agent-preset.js` 取）。
 *   `{ default: string, glm: string, trainDefault: string, trainGlm: string }`
 *   缺省时该区块**如实显示「未提供」**，而不是回落到本页手写的旧文本
 *   （回落就等于把刚修掉的第二份协议又请回来）。
 */
export function renderSettingsPage(models, teaching = null) {
  // 转义：教学文本要进 <pre>，必须处理 & < >
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const t = teaching || {};
  const pre = (s) => `<pre class="preset">${esc(s || '（未提供：请从 lib/agent-preset.js 取真源文本）')}</pre>`;
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
/* 0.19.7：项目主页链接（用户要求「设置界面加上 github 连接在顶部合适位置」）。
   与原生面板的标题行同形：贴在标题这一行的右端，不另起一行挤掉状态区。 */
.header-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.repo-link {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: #6e6e73;
  text-decoration: none;
  padding: 2px 10px;
  border: 0.5px solid rgba(0,0,0,0.16);
  border-radius: 12px;
  transition: background 0.15s, color 0.15s;
}
.repo-link:hover { color: #1d1d1f; background: rgba(0,0,0,0.05); }

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
.hint {
  font-size: 12px;
  line-height: 1.45;
  color: #86868b;
  margin-top: 2px;
  /* 0.19.36：报错文案的承载者（含完整 Windows 路径与文件名），必须能换行。
     与 client.cjs 的 .hwb-hint 同一个修复：没有它，一句带路径的报错会整行撑出
     .section-group 的右缘（该容器是 overflow:hidden，于是被裁掉一半）。 */
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

textarea, select, input {
  width: 100%;
  /* 0.19.7：box-sizing 必须显式写。缺这一句时 width:100% 是**内容盒**宽度，
     再加上左右 padding 与边框就要撑出容器 —— 而 .section-group 是 overflow:hidden，
     用户看到的就是「输入框超出卡片框」（真机反馈 2026-09-24）。 */
  box-sizing: border-box;
  max-width: 100%;
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
    <div class="header-row">
      <h1>⚙️ Webcode Bridge 设置</h1>
      <a class="repo-link" href="https://github.com/RSLN-creator/dsh-web-bridge" target="_blank" rel="noreferrer noopener" title="在 GitHub 打开项目主页（新标签）">GitHub</a>
    </div>
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
        <div class="hint">新建会话时默认启用的模型。支持 DeepSeek、GLM、Z.ai、Doubao、Kimi、Qwen 等。</div>
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
        <div class="hint">网页端<b>实际发送</b>的教学文本（运行时取自协议真源 <code>lib/agent-preset.js</code>，本页只展示、不撰写）；下方另有各站原生训练模板供对照。</div>
        <div class="native-spec-box">
          <details class="native-spec-card" open>
            <summary>本桥实际教学文本 <span class="native-spec-tag">取自 agent-preset.js（唯一真源）</span></summary>
            <div class="native-spec-desc">
              <b>默认形状（<code>&lt;tool_call&gt;</code> 标签）—— 除 GLM / DeepSeek 外的站点：</b>
              ${pre(t.default)}
              <b>该形状的增量轮再教学：</b>
              ${pre(t.trainDefault)}
              <b>GLM 形状（代码块，起始行是三个反引号加 json）—— GLM 网页有内置执行器会抢走标签：</b>
              ${pre(t.glm)}
              <b>GLM 的增量轮再教学：</b>
              ${pre(t.trainGlm)}
              <div class="hint">⚠ 本区块文本运行时取自真源，与桥真正发给网页的逐字相同。
                不要再在本页手写协议文本（红线 3：工具协议只有一处定义）。</div>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>GLM & Z.ai <span class="native-spec-tag">原生 XML / JSON 代码块</span></summary>
            <div class="native-spec-desc">
              <b>官方 Chat Template：</b><code>&lt;tool_call&gt;{name}&lt;arg_key&gt;{k}&lt;/arg_key&gt;&lt;arg_value&gt;{v}&lt;/arg_value&gt;&lt;/tool_call&gt;</code><br>
              <b>本桥为何改用代码块：</b>GLM 网页对正文里的调用标签有<b>原生执行器</b>（只认它内置的 search/open/click/find）
              ⇒ 标签形状会被它抢走执行并回灌 unknown tool call，故该站点只教代码块（见上方 GLM 段）。
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Doubao <span class="native-spec-tag">Doubao-Seed / seed:tool_call</span></summary>
            <div class="native-spec-desc">
              <b>网页原生标签：</b><code>&lt;seed:tool_call&gt;{"name":"...","arguments":{...}}&lt;/seed:tool_call&gt;</code><br>
              <b>解析器是否认它：</b>认 —— 标签正则把它列在宽容外壳里（与 tool_call/function/stories 同族）。<br>
              <b>桥是否教它：</b><b>不教</b> —— 教学侧对 doubao 发的是默认 <code>&lt;tool_call&gt;</code> 形状。
              <div class="hint">⚠ 如实标注：doubao 网页是否接受默认形状、或是否会像 GLM 那样抢标签，
                <b>本轮无真机读数</b>（long-term-issues #66）⇒ 未做站点化变体。</div>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Kimi <span class="native-spec-tag">Kimi-K2 / Connect-RPC 流式</span></summary>
            <div class="native-spec-desc">
              <b>官方规范：</b><code>&lt;tool_call&gt;{"name":"...","arguments":{...}}&lt;/tool_call&gt;</code><br>
              <b>网页传输特征：</b>Connect-RPC 二进制流（<code>[flags(1)][len(4BE)][json]</code>），正文与思考分流。
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Qwen <span class="native-spec-tag">ChatML # Tools</span></summary>
            <div class="native-spec-desc">
              <b>官方 ChatML 规范：</b><code>&lt;|im_start|&gt;assistant&lt;tool_call&gt;...&lt;/tool_call&gt;&lt;|im_end|&gt;</code>
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
        <label>浏览器（内置，无需外部依赖）</label>
        <div class="hint">本插件自带浏览器能力：优先用随插件安装的 Chromium，与你的日常浏览器完全隔离。登录一次后持久保存。</div>
        <div id="browserLine" class="hint">浏览器状态读取中…</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap;">
          <button type="button" id="browserRefresh" class="mini">刷新状态</button>
          <button type="button" id="browserInstall" class="mini" style="display:none;">下载浏览器</button>
          <span id="browserHint" class="hint" style="margin:0;"></span>
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
        </div>
        <div class="hint">长文本改走附件上传，避免超大正文灌入输入框引起页面卡死或截断。</div>
        <div id="transportLine" class="hint">投递状态加载中…</div>
      </div>
      <!-- 站点级投递形态（0.19.32）。
           用户要求：「提示词投递：给每个模型站点都做到和「发送间隔（全局）」一样的逻辑：
           全局设置一个，但是针对每个单独网站设置能够单独设置」。
           回落链与 sendGapMsBySlot 逐字同构：站点档 → 全局档 → 插件 config → 'attach'。
           默认「跟随全局」= 设置文件里**没有这个键**（不是写一个第三值），于是
           「没配」与「配成跟随全局」在同一份设置里始终可区分。 -->
      <div class="form-row">
        <label>各站点投递形态</label>
        <div class="hint">默认跟随上面的全局投递形态；需要时可为单个站点单独指定。</div>
        <div id="siteTransports">加载中…</div>
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
      <!-- 并发上限（0.19.52，多 profile 真并发）。
           车道模型：同一账号串行（一个网页会话只有一个输入框），不同账号真并发
           （每条车道是独立浏览器实例）。此值限制同时在跑的车道数，调大前先在
           「网站账号」分组把各站点配好多个账号——单账号下 2 与 8 无差别。 -->
      <div class="form-row">
        <label for="maxConcurrentLanes">并发车道上限（多账号真并发）</label>
        <select id="maxConcurrentLanes">
          <option value="1">1（完全串行）</option>
          <option value="2">2（默认）</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
          <option value="7">7</option>
          <option value="8">8（每车道一个浏览器实例，注意内存）</option>
        </select>
        <div class="hint">同一账号永远串行；不同账号（「网站账号」里配置的槽）可真并发，此值限制同时在跑的数量。保存即生效，无需重启。</div>
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
            <button type="button" id="subWindow" class="mini">登录窗口</button>
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
      // 并发上限（0.19.52）：后端 GET /settings 已夹取后带回（未保存过时是默认 2），
      // 前端只按值选中，不自己造默认（与 sendGapBasis 同一条纪律）。
      const laneEl = document.getElementById('maxConcurrentLanes');
      if (laneEl) laneEl.value = String(Number(data.maxConcurrentLanes) || 2);
      // 投递形态：后端（GET /settings）已经带默认值回来（未保存过时是 'attach'），
      // 因此这里只需按值选中；前端不自己造默认值——否则「面板选中项」与「驱动真实
      // 行为」会各有一份默认，而这两者分叉时用户没有任何办法发现。
      const transport = data.promptTransport === 'inline' ? 'inline' : 'attach';
      const radio = document.querySelector('input[name="promptTransport"][value="' + transport + '"]');
      if (radio) radio.checked = true;
      renderSiteTransports(data.promptTransportBySite || {});
      // 每个站点的**生效读数**逐站现读（0.19.33）：下拉只说明「存了什么」，
      // 读数才说明「这一档会让该站点走哪条路」。两者都由服务端算，前端不合并。
      refreshSiteTransportLines();
    } catch (e) {
      statusEl.textContent = '加载设置失败: ' + e.message;
      statusEl.className = 'error';
    }
  }

  /**
   * 各站点投递形态的**选择状态**（0.19.32）。
   *
   * 与 sitePick（协议预览）同样的「本页只持草稿、保存时统一提交」纪律：本页的
   * 保存是**一个表单一个按钮**，逐个站点即时落盘会造出两种交互。
   *
   * 值域：空串 = 跟随全局（提交时**删键**）；'attach' / 'inline' = 本站点覆盖。
   * 为什么空串而不是 undefined 做「跟随全局」：它要能当 select 的 value。
   * 注意：本文件整体是一个模板字符串，注释里**不得出现反引号**（会截断它，见下方
   * 同一条纪律的既有注释）。
   */
  let siteTransportDraft = {};
  /** 站点清单（服务端 models 里出现过的站点），按 SITE_IDS 顺序。 */
  function renderSiteTransports(bySite) {
    const host = document.getElementById('siteTransports');
    if (!host) return;
    siteTransportDraft = {};
    if (!SITE_IDS.length) { host.textContent = '没有可用站点。'; return; }
    host.innerHTML = SITE_IDS.map((sid) => {
      const cur = bySite[sid] === 'inline' || bySite[sid] === 'attach' ? bySite[sid] : '';
      siteTransportDraft[sid] = cur;
      return '<div class="site-prompt-head" style="margin-top:6px;">'
        + '<span class="site-prompt-name" style="flex:0 0 140px;">' + sid + '</span>'
        + '<select data-site-transport="' + sid + '" style="flex:0 0 200px;">'
        + '<option value=""' + (cur === '' ? ' selected' : '') + '>跟随全局</option>'
        + '<option value="attach"' + (cur === 'attach' ? ' selected' : '') + '>附件投递</option>'
        + '<option value="inline"' + (cur === 'inline' ? ' selected' : '') + '>纯文本</option>'
        + '</select>'
        + '<span class="hint" id="siteTransportLine-' + sid + '" style="margin-left:8px;"></span>'
        + '</div>';
    }).join('');
    // 事件绑定放在 innerHTML 之后（重建过节点，旧引用会失效）——与 renderSiteRows 同一条纪律。
    host.querySelectorAll('[data-site-transport]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const sid = sel.getAttribute('data-site-transport');
        const v = sel.value === 'inline' || sel.value === 'attach' ? sel.value : '';
        siteTransportDraft[sid] = v;
      });
    });
  }

  /**
   * 每个站点的**生效读数**（0.19.33）。
   *
   * 为什么要逐站点问服务端、而不是在前端自己合并：回落链只有一处真相
   *（站点档 → 全局档 → 插件 config → 'attach'），而它在服务端（GET attach-status 的
   * 文档字符串里已写明「两处的一致性由 test/site-prompt-transport.test.mjs 钉住」）。
   * 前端再写一遍合并，就是本项目反复记过的「第二套判据」——迟早与驱动分叉。
   *
   * 只读、无副作用：不写设置、不上传、不发送。读数拿不到就如实留空，
   * 不编一句看起来正常的默认值。
   */
  async function refreshSiteTransportLines() {
    const ids = SITE_IDS || [];
    await Promise.all(ids.map(async (sid) => {
      const el = document.getElementById('siteTransportLine-' + sid);
      if (!el) return;
      try {
        // 用 POST 而不是 GET + query：与原生面板同一条路由形态（客户端带 body
        // 就是 POST，服务端两个方法都注册了），避免各写一种调用形状。
        const r = await fetch(API_BASE + '/attach-status', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ siteId: sid }),
        });
        const d = await r.json();
        if (!d || !d.ok) { el.textContent = '读数不可用'; return; }
        // 只显示「本站点这一档」的结论，不重复全局那一行的长文案。
        el.textContent = d.sitePick
          ? '当前：' + (d.sitePick === 'inline' ? '纯文本' : '附件投递') + '（本站点单独设置）'
          : '当前：跟随全局（' + (d.effective === 'inline' ? '纯文本' : '附件投递') + '）';
      } catch (e) {
        el.textContent = '读数读取失败：' + (e && e.message ? e.message : e);
      }
    }));
  }

  // ---- 首轮提示词（按网站逐行，只读，默认显示） ------------------------------   // 模板由 GET /__webcode/prompt-variants 现算（与真正发出去的那一份同源）。
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

  // ---- 投递形态的「当前生效值」（0.16.3；0.19.6 精简） -----------------------
  // 文案由服务端算好（GET /attach-status）：这条读数的口径与驱动内的判据同源，
  // 浏览器侧再写一份格式化就会出现「面板说成功了、驱动其实回落了」。
  // 记录成因（用户原话）：「没有做到能够把提示词放入文本（设置界面也改为打开文本）
  // 导致输出对话一开头就很长 token 窗口」——真机读数是 attachTransport
  // {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}，而当时面板上
  // 一个字都没有，用户只能看到「对话一开头很长」。
  //
  // 0.19.6：这里原先还渲染「最近一次实际投递」与一枚**附件探针**按钮。两者都按
  // 用户要求从用户界面撤掉——探针是开发者自用的能力（一次真实上传），不该出现在
  // 设置页；能力本身仍在服务端（POST /__webcode/attach-probe），需要时直接调 HTTP。
  // 只留一行当前生效值；lastLine / probeLine 服务端照旧返回，本页不再消费。
  async function loadTransportStatus() {
    const line = document.getElementById('transportLine');
    try {
      const d = await fetch(API_BASE + '/attach-status').then((r) => r.json());
      if (!d || !d.ok) throw new Error((d && d.error) || 'HTTP');
      line.textContent = '当前生效：' + d.transportLine;
    } catch (e) {
      line.textContent = '投递状态读取失败：' + (e && e.message ? e.message : e);
    }
  }

  // ---- 浏览器（内置，零外部依赖）------------------------------------------------
  //
  // 兑现用户要求「尽量对应本插件外的少干扰少依赖，确保人人下载安装可用本插件所有功能」。
  // 这里只做两件事：**显示实际用的是哪个浏览器**、缺了就**给一个下载按钮**。
  // 判定与安装都在服务端（lib/browser-runtime.js 是唯一真相），前端不重算。
  async function loadBrowserRuntime() {
    const line = document.getElementById('browserLine');
    const hint = document.getElementById('browserHint');
    const installBtn = document.getElementById('browserInstall');
    try {
      const d = await fetch(API_BASE + '/browser-runtime').then((r) => r.json());
      if (!d || !d.ok) throw new Error((d && d.error) || 'HTTP');
      // 路径也显示出来：用户要能核对「到底跑的是哪个文件」，这是可以用一次请求
      // 验证的性质，不该只活在代码里。
      line.textContent = d.line + (d.executablePath ? '：' + d.executablePath : '');
      installBtn.style.display = d.ready ? 'none' : '';
      hint.textContent = d.ready ? '' : (d.hint || '');
    } catch (e) {
      line.textContent = '浏览器状态读取失败：' + (e && e.message ? e.message : e);
    }
  }

  document.getElementById('browserRefresh').addEventListener('click', loadBrowserRuntime);

  document.getElementById('browserInstall').addEventListener('click', async () => {
    // 下载约 150 MB，是明确的外部动作 —— 先征得同意再跑（与附件探针同一条纪律）。
    if (!window.confirm('将从 playwright 官方 CDN 下载 Chromium（约 150 MB，仅此一次）。继续？')) return;
    const btn = document.getElementById('browserInstall');
    const line = document.getElementById('browserLine');
    btn.disabled = true;
    line.textContent = '正在下载浏览器…（可能需要几分钟，请不要关闭此页面）';
    try {
      const d = await fetch(API_BASE + '/browser-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (d && d.ok) {
        line.textContent = '浏览器已就绪：' + (d.executablePath || '');
      } else {
        // 失败时**把真实原因显示出来**（含命令输出尾部），不编一句「安装失败」。
        line.textContent = '下载失败（' + ((d && d.code) || '未知') + '）：' + String((d && d.output) || '').slice(0, 400);
      }
    } catch (e) {
      line.textContent = '下载请求失败：' + (e && e.message ? e.message : e);
    } finally {
      btn.disabled = false;
      loadBrowserRuntime();
    }
  });

  loadBrowserRuntime();

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
        subAccountStatus.textContent = '等待登录完成…（最长 5 分钟，请在弹出的浏览器窗口内完成登录）';
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

  // 0.18.0：原先这里有两个常量表 SITE_NAMES_MAP / SITE_ORIGINS_MAP，只为上面那个
  // 已删除的「打开网站」按钮服务。删按钮后它们成了死代码，一并移除 —— 站点名与
  // 源地址的权威来源是服务端 providers.js（面板从 /status 与 /models 读），前端
  // 另存一份迟早与后端漂移。

  document.getElementById('subLogin').addEventListener('click', () => subAction('login'));
  document.getElementById('subVerify').addEventListener('click', () => subAction('verify'));
  document.getElementById('subWindow').addEventListener('click', () => subAction('window'));
  // 0.18.0：原先这里还有一个「打开网站」按钮，它调 window.open(url) —— 打开的
  // 是**用户日常浏览器**，而桥跑在它自己独占的 Chromium profile 里。用户在那边
  // 登录，桥**永远不会知道**（探针报「未登录」而用户坚称「我登了」，两边都是真的，
  // 说的却不是同一份 profile）。这正是用户指出的「登录入口有两套」里最误导的一套，
  // 已删除。要登录就用上面这个「登录窗口」——它开的是桥自己的浏览器，登录态
  // 持久保存在桥的 profile 里（真机实测：关闭驱动再重开，loggedIn 仍为 true）。
  // 注意：本文件整体是一个模板字符串，注释里**不得出现反引号**（会截断它）。
  document.getElementById('subAgentSite').addEventListener('change', refreshSubAccount);
  setInterval(refreshSubAccount, 20000);
  // 投递读数轮询（15s）：真机出问题时用户往往就停在这一页上，读数必须自己更新，
  // 不能要求他手动刷新（旧版本这一页对附件投递完全沉默）。
  // 逐站点那一组读数同频（0.19.33）：它们是同一件事的两种粒度，一个更新一个不更新
  // 会让用户以为站点档没生效——而「谁对」在这页上无从判断。
  setInterval(() => { loadTransportStatus(); refreshSiteTransportLines(); }, 15000);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // 并发上限（0.19.52）：先算后用——本文件整体是模板字符串，对象字面量里塞
    // 复杂表达式一旦写错，node --check 只查外壳、查不到内层脚本；保持每个成员
    // 一行可读。提交前夹取（数值夹 1..8，非数值归 2），服务端写入侧还会再
    // 归一化一次，两处判据同源（与 sendGapBasis 同一条纪律）。
    const laneN = Math.round(parseInt(document.getElementById('maxConcurrentLanes').value, 10));
    const laneCap = Number.isFinite(laneN) ? Math.min(8, Math.max(1, laneN)) : 2;
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
      // 站点级投递形态（0.19.32）：整个字典**一次提交**。
      // 「跟随全局」用**删键**表达——写一个第三值会让「没配」与「配成跟随全局」
      // 在设置文件里变成同一件事，而它们语义不同（同 extraPromptBySite 的空串删键）。
      promptTransportBySite: Object.fromEntries(Object.entries(siteTransportDraft).filter(([, v]) => v)),
      maxConcurrentLanes: laneCap,
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
      // 投递形态 / 各站点形态也可能刚被改过（它们都在同一个表单里提交），而
      // 「当前生效：」那一行是用户核对「我设的站点档到底生效没有」的唯一入口——
      // 只重拉模板会让那一行停在旧值（真机症状：保存成功、读数不变）。
      // 服务端在同一次 POST 的响应里回 settingsRevision，但这页只需要重读一次读数。
      loadTransportStatus();
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
