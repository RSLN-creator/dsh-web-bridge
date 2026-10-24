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
//
// ## 0.22.2：页面双语（GitHub Issue #2「No english translation」）
//
// 结构选型（为什么是「成对 span + data-en 覆盖」而不是第二份字典）：
//
//   · **静态文本**：中英两个 `<span class="i18n-zh">/<span class="i18n-en">` **就地相邻**
//     写在同一个模板行里。翻译与原文永不分离，就不存在「两份清单各自漂移」——
//     这正是本项目反复记过的「第二套判据」一族。
//   · **三个例外**（`<option>` 内容按规范只许文本、span 会被解析器剥掉；placeholder /
//     title 是属性）：用 `data-en` 属性承载英文全文，脚本在检测出英文时把属性值
//     写回 textContent / placeholder / title。
//   · **脚本动态文案**（状态行、报错、登录三态等）：集中在**一个** `MSG` 字典里，
//     `M(key, …args)` 取当前语言；组合句用函数值。
//
// 方向性纪律：**zh 是服务端渲染的正本，en 是一层覆盖**。检测出英文时给 `body` 挂
// `lang-en`（CSS 藏 zh 显 en）并写 `data-en`；切回中文 = 重载整页——服务端 HTML
// 本来就是 zh 正本，因此**不需要任何「恢复」逻辑**，也不会出现半个翻译态。
// 无 JS 时默认中文（与 0.22.1 之前行为一致）。选择存
// `localStorage('webcode-settings-lang')`；没存过按 `navigator.language` 判。
//
// **边界（如实声明）**：服务端现算的读数（`transportLine`、browser line、变体
// note/label、文件路径）与**教学文本**（协议真源，红线 3）按返回原样展示，不在本页
// 翻译——教学文本翻译了就不再是「与桥真正发给网页的逐字相同」。原生面板
// client.cjs 的 i18n 未做（见 doc/long-term-issues.md）。

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
.header-links { display: flex; align-items: baseline; gap: 8px; flex: none; }
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

/* 0.22.2 双语（Issue #2）：zh 是正本、en 是覆盖层。默认（无 JS）只显示中文；
   body.lang-en 时反过来。成对 span 就地相邻，翻译与原文在同一行模板里，
   不存在第二份字典可漂移。 */
.i18n-en { display: none; }
body.lang-en .i18n-zh { display: none; }
body.lang-en .i18n-en { display: inline; }

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
      <h1>⚙️ Webcode Bridge <span class="i18n-zh">设置</span><span class="i18n-en">Settings</span></h1>
      <span class="header-links">
        <a class="repo-link" href="https://github.com/RSLN-creator/dsh-web-bridge" target="_blank" rel="noreferrer noopener" title="在 GitHub 打开项目主页（新标签）" data-en-title="Open the project homepage on GitHub (new tab)">GitHub</a>
        <button type="button" id="langToggle" class="mini" aria-label="切换语言 / Switch language">English</button>
      </span>
    </div>
    <p><span class="i18n-zh">管理模型、提示词、会话节奏与子代理分配策略</span><span class="i18n-en">Manage models, prompts, session pacing and sub-agent routing</span></p>
  </div>

  <form id="settingsForm">
    <!-- 分组 1: 模型与模式 -->
    <div class="section-title"><span class="i18n-zh">模型与模式</span><span class="i18n-en">Models &amp; modes</span></div>
    <div class="section-group">
      <div class="form-row">
        <label for="defaultModel"><span class="i18n-zh">默认模型</span><span class="i18n-en">Default model</span></label>
        <select id="defaultModel">
          ${models.map((m) => `<option value="${m.id}"${m.experimental ? ` data-en="${m.name} (experimental)"` : ''}>${m.name}${m.experimental ? '（实验）' : ''}</option>`).join('\n          ')}
        </select>
        <div class="hint"><span class="i18n-zh">新建会话时默认启用的模型。支持 DeepSeek、GLM、Z.ai、Doubao、Kimi、Qwen 等。</span><span class="i18n-en">Model enabled by default for new sessions. Supports DeepSeek, GLM, Z.ai, Doubao, Kimi, Qwen and more.</span></div>
      </div>
      <div class="form-row">
        <label for="thinkMode"><span class="i18n-zh">深度思考</span><span class="i18n-en">Deep thinking</span></label>
        <select id="thinkMode">
          <option value="auto" data-en="Auto (follow the model's default thinking behavior)">自动（按所选模型的默认思考行为）</option>
          <option value="on" data-en="Always on (force the page's Deep Thinking switch)">始终开启（强制打开网页「深度思考」开关）</option>
          <option value="off" data-en="Always off (favor fast replies)">始终关闭（追求快速回复）</option>
        </select>
        <div class="hint"><span class="i18n-zh">控制网页端的深度思考模式；自动模式将遵循模型的原生属性（如 DeepSeek 默认开启）。</span><span class="i18n-en">Controls the site's deep-thinking mode; Auto follows each model's native default (e.g. DeepSeek is on by default).</span></div>
      </div>
    </div>

    <!-- 分组 2: 指令与提示词 -->
    <div class="section-title"><span class="i18n-zh">指令与提示词</span><span class="i18n-en">Instructions &amp; prompts</span></div>
    <div class="section-group">
      <div class="form-row">
        <label for="extraPrompt"><span class="i18n-zh">全局指令（首轮注入）</span><span class="i18n-en">Global instruction (first-turn injection)</span></label>
        <textarea id="extraPrompt" placeholder="例如：请始终使用中文回答..." data-en="e.g. Always answer in English..."></textarea>
        <div class="hint"><span class="i18n-zh">追加一段 [全局指令] 注入每个新网页会话的首条消息。各网站专属指令请在原生面板的站点页配置。</span><span class="i18n-en">Appended as a [Global instruction] to the first message of every new web session. Per-site instructions live in the native panel's site pages.</span></div>
      </div>
      <div class="form-row">
        <div class="form-row-header">
          <label><span class="i18n-zh">各模型原生工具调用规范与教学参考</span><span class="i18n-en">Native tool-call specs &amp; teaching reference per model</span></label>
        </div>
        <div class="hint"><span class="i18n-zh">网页端<b>实际发送</b>的教学文本（运行时取自协议真源 <code>lib/agent-preset.js</code>，本页只展示、不撰写）；下方另有各站原生训练模板供对照。</span><span class="i18n-en">The teaching text <b>actually sent</b> to the page (taken at runtime from the protocol source of truth <code>lib/agent-preset.js</code>; this page only displays it, never writes it). Native training templates for each site below, for comparison.</span></div>
        <div class="native-spec-box">
          <details class="native-spec-card" open>
            <summary><span class="i18n-zh">本桥实际教学文本</span><span class="i18n-en">What this bridge actually teaches</span> <span class="native-spec-tag"><span class="i18n-zh">取自 agent-preset.js（唯一真源）</span><span class="i18n-en">from agent-preset.js (single source of truth)</span></span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">默认形状（<code>&lt;tool_call&gt;</code> 标签）—— 除 GLM / DeepSeek 外的站点：</span><span class="i18n-en">Default shape (<code>&lt;tool_call&gt;</code> tags) — every site except GLM / DeepSeek:</span></b>
              ${pre(t.default)}
              <b><span class="i18n-zh">该形状的增量轮再教学：</span><span class="i18n-en">Re-teaching for this shape on delta turns:</span></b>
              ${pre(t.trainDefault)}
              <b><span class="i18n-zh">GLM 形状（代码块，起始行是三个反引号加 json）—— GLM 网页有内置执行器会抢走标签：</span><span class="i18n-en">GLM shape (a code block starting with three backticks plus json) — the GLM page has a built-in executor that hijacks tags:</span></b>
              ${pre(t.glm)}
              <b><span class="i18n-zh">GLM 的增量轮再教学：</span><span class="i18n-en">GLM re-teaching for delta turns:</span></b>
              ${pre(t.trainGlm)}
              <div class="hint"><span class="i18n-zh">⚠ 本区块文本运行时取自真源，与桥真正发给网页的逐字相同。不要再在本页手写协议文本（红线 3：工具协议只有一处定义）。</span><span class="i18n-en">⚠ Texts here come from the source of truth at runtime, byte-identical to what the bridge sends. Never hand-write protocol text in this page (red line 3: the tool protocol has exactly one definition).</span></div>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>GLM &amp; Z.ai <span class="native-spec-tag"><span class="i18n-zh">原生 XML / JSON 代码块</span><span class="i18n-en">native XML / JSON code block</span></span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">官方 Chat Template：</span><span class="i18n-en">Official chat template:</span></b><code>&lt;tool_call&gt;{name}&lt;arg_key&gt;{k}&lt;/arg_key&gt;&lt;arg_value&gt;{v}&lt;/arg_value&gt;&lt;/tool_call&gt;</code><br>
              <b><span class="i18n-zh">本桥为何改用代码块：</span><span class="i18n-en">Why the bridge uses code blocks instead:</span></b><span class="i18n-zh">GLM 网页对正文里的调用标签有<b>原生执行器</b>（只认它内置的 search/open/click/find）⇒ 标签形状会被它抢走执行并回灌 unknown tool call，故该站点只教代码块（见上方 GLM 段）。</span><span class="i18n-en">the GLM page has a <b>native executor</b> for call tags in prose (it only knows its built-in search/open/click/find) ⇒ tag-shaped calls get hijacked and an unknown tool call comes back, so this site is only taught code blocks (see the GLM section above).</span>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Doubao <span class="native-spec-tag">Doubao-Seed / seed:tool_call</span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">网页原生标签：</span><span class="i18n-en">Page-native tag:</span></b><code>&lt;seed:tool_call&gt;{"name":"...","arguments":{...}}&lt;/seed:tool_call&gt;</code><br>
              <b><span class="i18n-zh">解析器是否认它：</span><span class="i18n-en">Does the parser accept it?</span></b><span class="i18n-zh">认 —— 标签正则把它列在宽容外壳里（与 tool_call/function/stories 同族）。</span><span class="i18n-en">Yes — the tag regex lists it in the lenient shell (same family as tool_call/function/stories).</span><br>
              <b><span class="i18n-zh">桥是否教它：</span><span class="i18n-en">Does the bridge teach it?</span></b><span class="i18n-zh"><b>不教</b> —— 教学侧对 doubao 发的是默认 <code>&lt;tool_call&gt;</code> 形状。</span><span class="i18n-en"><b>No</b> — the teaching side sends doubao the default <code>&lt;tool_call&gt;</code> shape.</span>
              <div class="hint"><span class="i18n-zh">⚠ 如实标注：doubao 网页是否接受默认形状、或是否会像 GLM 那样抢标签，<b>本轮无真机读数</b>（long-term-issues #66）⇒ 未做站点化变体。</span><span class="i18n-en">⚠ Honest label: whether the doubao page accepts the default shape, or hijacks tags like GLM does, has <b>no real-machine reading yet</b> (long-term-issues #66) ⇒ no site-specific variant.</span></div>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Kimi <span class="native-spec-tag">Kimi-K2 / <span class="i18n-zh">Connect-RPC 流式</span><span class="i18n-en">Connect-RPC streaming</span></span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">官方规范：</span><span class="i18n-en">Official spec:</span></b><code>&lt;tool_call&gt;{"name":"...","arguments":{...}}&lt;/tool_call&gt;</code><br>
              <b><span class="i18n-zh">网页传输特征：</span><span class="i18n-en">Page transport:</span></b><span class="i18n-zh">Connect-RPC 二进制流（<code>[flags(1)][len(4BE)][json]</code>），正文与思考分流。</span><span class="i18n-en">Connect-RPC binary stream (<code>[flags(1)][len(4BE)][json]</code>); prose and thinking travel on separate channels.</span>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>Qwen <span class="native-spec-tag">ChatML # Tools</span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">官方 ChatML 规范：</span><span class="i18n-en">Official ChatML spec:</span></b><code>&lt;|im_start|&gt;assistant&lt;tool_call&gt;...&lt;/tool_call&gt;&lt;|im_end|&gt;</code>
            </div>
          </details>

          <details class="native-spec-card">
            <summary>DeepSeek <span class="native-spec-tag"><span class="i18n-zh">官方训练模板（唯一端到端基线）</span><span class="i18n-en">official training template (only end-to-end baseline)</span></span></summary>
            <div class="native-spec-desc">
              <b><span class="i18n-zh">官方训练格式：</span><span class="i18n-en">Official training format:</span></b>
              <pre class="preset">&lt;｜tool calls begin｜&gt;&lt;｜tool call begin｜&gt;function&lt;｜tool sep｜&gt;{name}
\`\`\`json
{arguments}
\`\`\`&lt;｜tool call end｜&gt;&lt;｜tool calls end｜&gt;</pre>
              <b><span class="i18n-zh">教学规范：</span><span class="i18n-en">Teaching rule:</span></b><span class="i18n-zh">完全遵循 DeepSeek 官方 token 序列，保持 official 模式不变。</span><span class="i18n-en">follow DeepSeek's official token sequence exactly; keep the official mode untouched.</span>
            </div>
          </details>
        </div>
      </div>
      <div class="form-row">
        <label><span class="i18n-zh">浏览器（内置，无需外部依赖）</span><span class="i18n-en">Browser (bundled, no external dependency)</span></label>
        <div class="hint"><span class="i18n-zh">本插件自带浏览器能力：优先用随插件安装的 Chromium，与你的日常浏览器完全隔离。登录一次后持久保存。</span><span class="i18n-en">The plugin ships its own browser: it prefers the Chromium installed with the plugin, fully isolated from your daily browser. Log in once and the session persists.</span></div>
        <div id="browserLine" class="hint"><span class="i18n-zh">浏览器状态读取中…</span><span class="i18n-en">Reading browser status…</span></div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap;">
          <button type="button" id="browserRefresh" class="mini" data-en="Refresh"><span class="i18n-zh">刷新状态</span><span class="i18n-en">Refresh</span></button>
          <button type="button" id="browserInstall" class="mini" style="display:none;" data-en="Download browser"><span class="i18n-zh">下载浏览器</span><span class="i18n-en">Download browser</span></button>
          <span id="browserHint" class="hint" style="margin:0;"></span>
        </div>
      </div>
      <div class="form-row">
        <label><span class="i18n-zh">首轮提示词模板（只读）</span><span class="i18n-en">First-turn prompt templates (read-only)</span></label>
        <div class="hint"><span class="i18n-zh">各网站实际使用的传输协议与本地存储文件（可点击直接打开）。</span><span class="i18n-en">Each site's actual transport protocol and its local prompt file (click to open).</span></div>
        <div id="sitePrompts"><span class="i18n-zh">加载中…</span><span class="i18n-en">Loading…</span></div>
        <div id="variantTools" class="hint"></div>
      </div>
      <div class="form-row">
        <label><span class="i18n-zh">提示词投递形态</span><span class="i18n-en">Prompt delivery mode</span></label>
        <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-top:4px;">
          <label style="display:flex; gap:6px; align-items:center; font-weight:400; font-size:13px; cursor:pointer;">
            <input type="radio" name="promptTransport" value="attach" style="width:auto;"> <span class="i18n-zh">附件投递（默认推荐）</span><span class="i18n-en">File attachment (default, recommended)</span>
          </label>
          <label style="display:flex; gap:6px; align-items:center; font-weight:400; font-size:13px; cursor:pointer;">
            <input type="radio" name="promptTransport" value="inline" style="width:auto;"> <span class="i18n-zh">纯文本输入</span><span class="i18n-en">Plain text input</span>
          </label>
        </div>
        <div class="hint"><span class="i18n-zh">长文本改走附件上传，避免超大正文灌入输入框引起页面卡死或截断。</span><span class="i18n-en">Long bodies go out as file attachments, avoiding page freezes or truncation from over-large composer input.</span></div>
        <div id="transportLine" class="hint"><span class="i18n-zh">投递状态加载中…</span><span class="i18n-en">Loading delivery status…</span></div>
      </div>
      <!-- 站点级投递形态（0.19.32）。
           用户要求：「提示词投递：给每个模型站点都做到和「发送间隔（全局）」一样的逻辑：
           全局设置一个，但是针对每个单独网站设置能够单独设置」。
           回落链与 sendGapMsBySlot 逐字同构：站点档 → 全局档 → 插件 config → 'attach'。
           默认「跟随全局」= 设置文件里**没有这个键**（不是写一个第三值），于是
           「没配」与「配成跟随全局」在同一份设置里始终可区分。 -->
      <div class="form-row">
        <label><span class="i18n-zh">各站点投递形态</span><span class="i18n-en">Per-site delivery mode</span></label>
        <div class="hint"><span class="i18n-zh">默认跟随上面的全局投递形态；需要时可为单个站点单独指定。</span><span class="i18n-en">Follows the global delivery mode above by default; can be overridden per site when needed.</span></div>
        <div id="siteTransports"><span class="i18n-zh">加载中…</span><span class="i18n-en">Loading…</span></div>
      </div>
    </div>

    <!-- 分组 3: 速度与排队 -->
    <div class="section-title"><span class="i18n-zh">速度与排队保护</span><span class="i18n-en">Speed &amp; queueing guards</span></div>
    <div class="section-group">
      <div class="form-row">
        <label for="sendGapPreset"><span class="i18n-zh">发送间隔（防频控限制）</span><span class="i18n-en">Send gap (rate-limit guard)</span></label>
        <div style="display:flex; gap:8px;">
          <select id="sendGapPreset" style="flex:0 0 140px;">
            <option value="0" data-en="0 s (off)">0 秒（关闭）</option>
            <option value="2000" data-en="2 s">2 秒</option>
            <option value="5000" data-en="5 s">5 秒</option>
            <option value="10000" data-en="10 s">10 秒</option>
            <option value="30000" data-en="30 s">30 秒</option>
            <option value="60000" data-en="60 s">60 秒</option>
            <option value="custom" data-en="Custom…">自定义…</option>
          </select>
          <input type="number" id="sendGapMs" min="0" max="600000" step="500" style="flex:1;" placeholder="毫秒（0–600000）" data-en="milliseconds (0–600000)">
        </div>
        <div class="hint"><span class="i18n-zh">设置两次向同一站点发送消息的最小主动等待间隔，降低触发网页端风控的风险。</span><span class="i18n-en">Minimum deliberate wait between two sends to the same site, lowering the risk of tripping the site's rate control.</span></div>
      </div>
      <div class="form-row">
        <label for="sendGapBasis"><span class="i18n-zh">间隔基准</span><span class="i18n-en">Gap basis</span></label>
        <select id="sendGapBasis">
          <option value="send-to-send" data-en="Since last send (send-to-send, recommended)">距上次发出（send-to-send，推荐）</option>
          <option value="end-to-start" data-en="Since last reply finished (end-to-start)">距上次回复完成（end-to-start）</option>
        </select>
        <div class="hint"><span class="i18n-zh">「距上次发出」针对滑窗频控；「距上次回复完成」控制对话节奏避免过密回复。</span><span class="i18n-en">"Since last send" targets sliding-window rate limits; "since last reply finished" paces the conversation to avoid dense replies.</span></div>
      </div>
      <!-- 并发上限（0.19.52，多 profile 真并发）。
           车道模型：同一账号串行（一个网页会话只有一个输入框），不同账号真并发
           （每条车道是独立浏览器实例）。此值限制同时在跑的车道数，调大前先在
           「网站账号」分组把各站点配好多个账号——单账号下 2 与 8 无差别。 -->
      <div class="form-row">
        <label for="maxConcurrentLanes"><span class="i18n-zh">并发车道上限（多账号真并发）</span><span class="i18n-en">Concurrent lane cap (true multi-account concurrency)</span></label>
        <select id="maxConcurrentLanes">
          <option value="1" data-en="1 (fully serial)">1（完全串行）</option>
          <option value="2" data-en="2 (default)">2（默认）</option>
          <option value="3">3</option>
          <option value="4">4</option>
          <option value="5">5</option>
          <option value="6">6</option>
          <option value="7">7</option>
          <option value="8" data-en="8 (one browser instance per lane, mind memory)">8（每车道一个浏览器实例，注意内存）</option>
        </select>
        <div class="hint"><span class="i18n-zh">同一账号永远串行；不同账号（「网站账号」里配置的槽）可真并发，此值限制同时在跑的数量。保存即生效，无需重启。</span><span class="i18n-en">One account is always serial; different accounts (slots configured under "Site accounts") can truly run concurrently — this caps how many run at once. Takes effect on save, no restart needed.</span></div>
      </div>
      <div class="form-row">
        <label for="previewRefreshRate"><span class="i18n-zh">预览刷新率 (毫秒)</span><span class="i18n-en">Preview refresh rate (ms)</span></label>
        <input type="number" id="previewRefreshRate" min="1000" max="30000" step="500" value="5000">
        <div class="hint"><span class="i18n-zh">控制右侧栏镜像页面自动刷新状态的周期（默认 5000ms）。</span><span class="i18n-en">How often the sidebar mirror page refreshes its status (default 5000 ms).</span></div>
      </div>
    </div>

    <!-- 分组 4: 子代理与会话 -->
    <div class="section-title"><span class="i18n-zh">子代理与多会话</span><span class="i18n-en">Sub-agents &amp; sessions</span></div>
    <div class="section-group">
      <div class="form-row">
        <label for="subAgentMode"><span class="i18n-zh">子代理网页会话分配</span><span class="i18n-en">Sub-agent web session assignment</span></label>
        <select id="subAgentMode">
          <option value="own" data-en="Separate (recommended): each sub-agent gets its own web conversation">独立（推荐）：每个子代理开启独立网页对话</option>
          <option value="share" data-en="Shared: all sub-agents reuse the main session's web conversation">共用：所有子代理与主会话共用同一网页对话</option>
        </select>
        <div class="hint"><span class="i18n-zh">控制 DSH 并行子代理在网页端的隔离方式。</span><span class="i18n-en">How DSH's parallel sub-agents are isolated on the web side.</span></div>
      </div>
      <div class="form-row">
        <label for="subAgentSite"><span class="i18n-zh">子代理站点分流</span><span class="i18n-en">Sub-agent site routing</span></label>
        <select id="subAgentSite"></select>
        <div class="hint"><span class="i18n-zh">为子代理指定专用站点以分流主线请求，避免单站点并发过密导致限流。</span><span class="i18n-en">Give sub-agents their own site to offload main-line requests, avoiding dense per-site concurrency that trips rate limits.</span></div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
          <button type="button" id="syncMainToSub" class="mini" data-en="Main line → sub-agent">主线站点 → 子代理</button>
          <button type="button" id="syncSubToMain" class="mini" data-en="Sub-agent → main line">子代理站点 → 主线</button>
        </div>
        <div id="subAccountFollow" class="hint" style="display:none; margin-top:6px;"><span class="i18n-zh">当前跟随主线站点，无需单独登录。</span><span class="i18n-en">Following the main-line site; no separate login needed.</span></div>
        <div id="subAccountBlock" style="display:none; margin-top:10px; padding:10px 12px; border:0.5px solid rgba(0,0,0,0.08); border-radius:10px; background:#fafafa;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <b id="subSiteName" style="font-size:13px;"></b>
            <span id="subSiteState" class="state idle"><span class="i18n-zh">待检查</span><span class="i18n-en">Not checked</span></span>
            <button type="button" id="subLogin" class="mini" data-en="Log in"><span class="i18n-zh">登录</span><span class="i18n-en">Log in</span></button>
            <button type="button" id="subVerify" class="mini" data-en="Check"><span class="i18n-zh">检测</span><span class="i18n-en">Check</span></button>
            <button type="button" id="subWindow" class="mini" data-en="Login window"><span class="i18n-zh">登录窗口</span><span class="i18n-en">Login window</span></button>
          </div>
          <div id="subAccountStatus" class="hint"></div>
        </div>
      </div>
    </div>

    <button type="submit" class="primary"><span class="i18n-zh">保存设置</span><span class="i18n-en">Save settings</span></button>
  </form>
  <div id="status"></div>
<script>
  const API_BASE = '/__webcode';
  // 裸模型 id（历史设置值，如 'deepseek-web'）→ 站点限定 id（'deepseek:deepseek'）
  const MODEL_IDS = ${JSON.stringify(Object.fromEntries(models.map((m) => [m.id.split(':').pop(), m.id])))};
  const SITE_IDS = ${JSON.stringify([...new Set(models.map((m) => m.id.split(':')[0]))])};
  const form = document.getElementById('settingsForm');
  const statusEl = document.getElementById('status');

  // ---- 0.22.2 双语（GitHub Issue #2）------------------------------------------
  // zh 是服务端渲染的正本；en 是一层覆盖：检测出英文时给 body 挂 lang-en（CSS 藏
  // .i18n-zh、显 .i18n-en），并把 data-en 写进对应元素（option → textContent，
  // input/textarea → placeholder，data-en-title → title）。切回中文 = 重载整页：
  // 服务端 HTML 本来就是 zh 正本，不需要恢复逻辑。选择存
  // localStorage('webcode-settings-lang')，没存过按 navigator.language 判。
  // 注意：本文件整体是一个模板字符串，这里与下方所有代码**不得出现反引号**（会截断它）。
  function detectLang() {
    try {
      const saved = localStorage.getItem('webcode-settings-lang');
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) { /* 隐私模式等拿不到 localStorage：退回按浏览器语言判 */ }
    return String(navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }
  const LANG = detectLang();
  // 动态文案的唯一字典（静态文本在上方模板里成对相邻，不走这里）。
  // 值可以是字符串，也可以是组装函数（M 的多余实参按位传入）。
  const MSG = {
    docTitle: { zh: 'Webcode Bridge 设置', en: 'Webcode Bridge Settings' },
    loadFail: { zh: '加载失败', en: 'Load failed' },
    loadSettingsFail: { zh: '加载设置失败: ', en: 'Failed to load settings: ' },
    followMain: { zh: '跟随主线站点（默认）', en: 'Follow main-line site (default)' },
    noSites: { zh: '没有可用站点。', en: 'No sites available.' },
    followGlobal: { zh: '跟随全局', en: 'Follow global' },
    attachMode: { zh: '附件投递', en: 'attachment' },
    inlineMode: { zh: '纯文本', en: 'plain text' },
    attachModeCap: { zh: '附件投递', en: 'Attachment' },
    inlineModeCap: { zh: '纯文本', en: 'Plain text' },
    readingNA: { zh: '读数不可用', en: 'Reading unavailable' },
    siteOverride: { zh: (w) => '当前：' + w + '（本站点单独设置）', en: (w) => 'Now: ' + w + ' (set for this site)' },
    globalOverride: { zh: (w) => '当前：跟随全局（' + w + '）', en: (w) => 'Now: following global (' + w + ')' },
    readingFail: { zh: '读数读取失败：', en: 'Failed to read: ' },
    trainNote: { zh: '再教学提示：', en: 'Re-teach note: ' },
    actuallyUsing: { zh: '实际使用：', en: 'In use: ' },
    previewNote: { zh: '（下方为预览，未生效）', en: ' (below is a preview, not in effect)' },
    openWithDefault: { zh: '用默认程序打开', en: 'Open with default app' },
    viewFullTemplate: { zh: '查看该协议的完整模板', en: 'View the full template of this protocol' },
    openedWith: { zh: (f) => '已用系统默认程序打开：' + f, en: (f) => 'Opened with the system default app: ' + f },
    promptNotWritten: { zh: (f) => '提示词文件还没生成——发送第一条消息后自动落盘：' + f, en: (f) => 'Prompt file not created yet — it is written automatically after the first message is sent: ' + f },
    promptStoreOff: { zh: '提示词落盘已被显式关闭（WEBCODE_PROMPT_STORE_DIR=off）。', en: 'Prompt persistence is explicitly disabled (WEBCODE_PROMPT_STORE_DIR=off).' },
    openFail: { zh: (c, f) => '打开失败：' + c + (f ? ' 文件：' + f : ''), en: (c, f) => 'Open failed: ' + c + (f ? ' file: ' + f : '') },
    openFailMsg: { zh: (m) => '打开失败：' + m, en: (m) => 'Open failed: ' + m },
    unknown: { zh: '未知', en: 'unknown' },
    toolsPlaceholder: { zh: '当前工具清单是占位示例——发送第一条消息后会自动换成该会话的真实清单。', en: "The tool list is a placeholder — it is replaced by this session's real list after the first message is sent." },
    sessionTools: { zh: (list) => '本会话工具：' + list, en: (list) => "This session's tools: " + list },
    variantsFail: { zh: '首轮提示词加载失败：', en: 'Failed to load first-turn prompts: ' },
    subSiteSet: { zh: (site) => '已把子代理站点设为 ' + site + '（尚未保存，请点「保存设置」）', en: (site) => 'Sub-agent site set to ' + site + ' (not saved yet — click "Save settings")' },
    followNoSync: { zh: '子代理站点为「跟随主线」，无需同步', en: 'Sub-agent site is "follow main line"; nothing to sync' },
    mainModelSet: { zh: (m) => '已把主线默认模型设为 ' + m + '（尚未保存，请点「保存设置」）', en: (m) => 'Main-line default model set to ' + m + ' (not saved yet — click "Save settings")' },
    nowEffective: { zh: '当前生效：', en: 'Now in effect: ' },
    transportFail: { zh: '投递状态读取失败：', en: 'Failed to read delivery status: ' },
    pathJoin: { zh: (p) => '：' + p, en: (p) => ': ' + p },
    browserFail: { zh: '浏览器状态读取失败：', en: 'Failed to read browser status: ' },
    confirmDownload: { zh: '将从 playwright 官方 CDN 下载 Chromium（约 150 MB，仅此一次）。继续？', en: 'Chromium (~150 MB, one-time) will be downloaded from the official playwright CDN. Continue?' },
    downloading: { zh: '正在下载浏览器…（可能需要几分钟，请不要关闭此页面）', en: 'Downloading the browser… (may take a few minutes; please keep this page open)' },
    browserReady: { zh: (p) => '浏览器已就绪：' + p, en: (p) => 'Browser ready: ' + p },
    downloadFail: { zh: (c, out) => '下载失败（' + c + '）：' + out, en: (c, out) => 'Download failed (' + c + '): ' + out },
    downloadReqFail: { zh: '下载请求失败：', en: 'Download request failed: ' },
    httpErr: { zh: (s, d) => 'HTTP ' + s + '：' + d, en: (s, d) => 'HTTP ' + s + ': ' + d },
    noResponseBody: { zh: '无响应内容', en: 'no response body' },
    loggedInCached: { zh: '已登录(缓存)', en: 'Logged in (cached)' },
    loggedIn: { zh: '已登录', en: 'Logged in' },
    notLoggedIn: { zh: '未登录', en: 'Not logged in' },
    unchecked: { zh: '待检查', en: 'Not checked' },
    changeAccount: { zh: '更换账户', en: 'Switch account' },
    login: { zh: '登录', en: 'Log in' },
    basisProbeBad: { zh: '命中站点未登录特征', en: "matched the site's logged-out markers" },
    basisProbeOk: { zh: '命中站点登录特征', en: "matched the site's logged-in markers" },
    basisProbeFallback: { zh: '站点登录特征未命中，回退输入框判定', en: 'no site markers matched; fell back to the input-box check' },
    basisInputFallback: { zh: '按输入框存在与否推断（该站点未声明登录特征）', en: 'inferred from the input box (this site declares no login markers)' },
    basisStale: { zh: '旧版本结论，已被忽略', en: 'conclusion from an older version; ignored' },
    basisNone: { zh: '尚未核验', en: 'not verified yet' },
    basisPrefix: { zh: '判定依据：', en: 'Basis: ' },
    basisWhen: { zh: (w) => ' · ' + w + ' 核验', en: (w) => ' · verified at ' + w },
    waitLogin: { zh: '等待登录完成…（最长 5 分钟，请在弹出的浏览器窗口内完成登录）', en: 'Waiting for login to finish… (up to 5 minutes; complete it in the opened browser window)' },
    stillValid: { zh: '登录态仍有效，无需重复登录', en: 'Login state still valid; no need to log in again' },
    loginDone: { zh: '登录完成', en: 'Login finished' },
    msSuffix: { zh: (s) => '（' + s + 's）', en: (s) => ' (' + s + 's)' },
    verifyFail: { zh: '✗ 检测失败：', en: '✗ Check failed: ' },
    verifyOk: { zh: '✓ 已检测到登录态', en: '✓ Logged-in state detected' },
    verifyNotYet: { zh: '✓ 检测完成：仍未登录（请在独立窗口完成登录后再检测）', en: '✓ Checked: still logged out (finish logging in via the standalone window, then check again)' },
    verifyUnknown: { zh: '✓ 检测完成：待检查（该站点尚未打开过，点「独立窗口」打开一次后再检测）', en: '✓ Checked: not checkable yet (this site has never been opened — open it once via "Login window", then check again)' },
    windowExists: { zh: '窗口已存在——已聚焦弹到最前', en: 'Window already exists — brought to the front' },
    windowClosed: { zh: '独立窗口已收起，回到无头运行', en: 'Standalone window collapsed; back to headless running' },
    windowOpened: { zh: '独立窗口已打开（与桥共用登录态）', en: "Standalone window opened (shares the bridge's login state)" },
    collapseWindow: { zh: '收起窗口', en: 'Collapse window' },
    standaloneWindow: { zh: '独立窗口', en: 'Standalone window' },
    saveFail: { zh: '保存失败', en: 'Save failed' },
    saved: { zh: '✅ 设置已保存', en: '✅ Settings saved' }
  };
  function M(key) {
    const entry = MSG[key];
    if (!entry) return key;
    const v = entry[LANG] != null ? entry[LANG] : entry.zh;
    return typeof v === 'function' ? v.apply(null, Array.prototype.slice.call(arguments, 1)) : v;
  }
  function updateLangToggle() {
    const btn = document.getElementById('langToggle');
    if (btn) btn.textContent = LANG === 'zh' ? 'English' : '中文';
  }
  function applyLang() {
    updateLangToggle();
    if (LANG !== 'en') return;
    document.body.classList.add('lang-en');
    document.documentElement.lang = 'en';
    document.title = M('docTitle');
    document.querySelectorAll('[data-en]').forEach((el) => {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') el.placeholder = el.getAttribute('data-en');
      else el.textContent = el.getAttribute('data-en');
    });
    document.querySelectorAll('[data-en-title]').forEach((el) => {
      el.setAttribute('title', el.getAttribute('data-en-title'));
    });
  }
  document.getElementById('langToggle').addEventListener('click', () => {
    try { localStorage.setItem('webcode-settings-lang', LANG === 'zh' ? 'en' : 'zh'); } catch (e) { /* 存不进也照样切换（本页生命周期内） */ }
    location.reload();
  });
  applyLang();

  async function loadSettings() {
    try {
      const res = await fetch(API_BASE + '/settings');
      if (!res.ok) throw new Error(M('loadFail'));
      const data = await res.json();
      document.getElementById('extraPrompt').value = data.extraPrompt || '';
      document.getElementById('defaultModel').value = MODEL_IDS[data.defaultModel] || data.defaultModel || 'deepseek:deepseek';
      document.getElementById('previewRefreshRate').value = data.previewRefreshRate || 5000;
      document.getElementById('thinkMode').value = ['on', 'off', 'auto'].includes(data.thinkMode) ? data.thinkMode : 'auto';
      document.getElementById('subAgentMode').value = data.subAgentMode === 'share' ? 'share' : 'own';
      const subSiteEl = document.getElementById('subAgentSite');
      if (!subSiteEl.options.length) {
        subSiteEl.innerHTML = '<option value="follow">' + M('followMain') + '</option>'
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
      statusEl.textContent = M('loadSettingsFail') + e.message;
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
    if (!SITE_IDS.length) { host.textContent = M('noSites'); return; }
    host.innerHTML = SITE_IDS.map((sid) => {
      const cur = bySite[sid] === 'inline' || bySite[sid] === 'attach' ? bySite[sid] : '';
      siteTransportDraft[sid] = cur;
      return '<div class="site-prompt-head" style="margin-top:6px;">'
        + '<span class="site-prompt-name" style="flex:0 0 140px;">' + sid + '</span>'
        + '<select data-site-transport="' + sid + '" style="flex:0 0 200px;">'
        + '<option value=""' + (cur === '' ? ' selected' : '') + '>' + M('followGlobal') + '</option>'
        + '<option value="attach"' + (cur === 'attach' ? ' selected' : '') + '>' + M('attachModeCap') + '</option>'
        + '<option value="inline"' + (cur === 'inline' ? ' selected' : '') + '>' + M('inlineModeCap') + '</option>'
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
        if (!d || !d.ok) { el.textContent = M('readingNA'); return; }
        // 只显示「本站点这一档」的结论，不重复全局那一行的长文案。
        el.textContent = d.sitePick
          ? M('siteOverride', d.sitePick === 'inline' ? M('inlineModeCap') : M('attachModeCap'))
          : M('globalOverride', d.effective === 'inline' ? M('inlineModeCap') : M('attachModeCap'));
      } catch (e) {
        el.textContent = M('readingFail') + (e && e.message ? e.message : e);
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
    if (noteEl) noteEl.textContent = (v ? v.note + ' ' : '') + (v ? M('trainNote') + v.trainNote : '');
    if (stateEl) {
      stateEl.textContent = M('actuallyUsing') + realLabel + (previewing ? M('previewNote') : '');
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
        + '<span class="hint" id="siteState-' + row.siteId + '">' + M('actuallyUsing') + realLabel + '</span>'
        + '<button type="button" class="mini" data-open-site="' + row.siteId + '">' + M('openWithDefault') + '</button>'
        + '</div>'
        + '<div class="hint" id="siteFile-' + row.siteId + '"></div>'
        + '<details><summary>' + M('viewFullTemplate') + '</summary>'
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
          if (el) el.textContent = j.ok ? M('openedWith', j.file)
            : (j.code === 'PROMPT_FILE_MISSING' ? M('promptNotWritten', j.file)
              : (j.code === 'PROMPT_STORE_OFF' ? M('promptStoreOff')
                : M('openFail', j.code || j.error || M('unknown'), j.file)));
        } catch (e) {
          const el = document.getElementById('siteFile-' + sid);
          if (el) el.textContent = M('openFailMsg', e.message);
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
        ? M('toolsPlaceholder')
        : (d.active && d.active.tools && d.active.tools.length
          ? M('sessionTools', d.active.tools.join(', ')) : '');
    } catch (e) {
      document.getElementById('sitePrompts').textContent = M('variantsFail') + e.message;
    }
  }
  loadVariants();

  document.getElementById('syncMainToSub').addEventListener('click', () => {
    const site = (document.getElementById('defaultModel').value || '').split(':')[0];
    if (!site) return;
    document.getElementById('subAgentSite').value = SITE_IDS.includes(site) ? site : 'follow';
    statusEl.textContent = M('subSiteSet', site);
    statusEl.className = '';
  });
  document.getElementById('syncSubToMain').addEventListener('click', () => {
    const site = document.getElementById('subAgentSite').value;
    if (!site || site === 'follow') { statusEl.textContent = M('followNoSync'); statusEl.className = ''; return; }
    const modelSel = document.getElementById('defaultModel');
    const preferred = site + ':auto';
    const hit = Array.from(modelSel.options).find(o => o.value === preferred) ? preferred
      : (Array.from(modelSel.options).find(o => o.value.startsWith(site + ':')) || {}).value;
    if (hit) {
      modelSel.value = hit;
      statusEl.textContent = M('mainModelSet', hit);
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
      line.textContent = M('nowEffective') + d.transportLine;
    } catch (e) {
      line.textContent = M('transportFail') + (e && e.message ? e.message : e);
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
      line.textContent = d.line + (d.executablePath ? M('pathJoin', d.executablePath) : '');
      installBtn.style.display = d.ready ? 'none' : '';
      hint.textContent = d.ready ? '' : (d.hint || '');
    } catch (e) {
      line.textContent = M('browserFail') + (e && e.message ? e.message : e);
    }
  }

  document.getElementById('browserRefresh').addEventListener('click', loadBrowserRuntime);

  document.getElementById('browserInstall').addEventListener('click', async () => {
    // 下载约 150 MB，是明确的外部动作 —— 先征得同意再跑（与附件探针同一条纪律）。
    if (!window.confirm(M('confirmDownload'))) return;
    const btn = document.getElementById('browserInstall');
    const line = document.getElementById('browserLine');
    btn.disabled = true;
    line.textContent = M('downloading');
    try {
      const d = await fetch(API_BASE + '/browser-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (d && d.ok) {
        line.textContent = M('browserReady', d.executablePath || '');
      } else {
        // 失败时**把真实原因显示出来**（含命令输出尾部），不编一句「安装失败」。
        line.textContent = M('downloadFail', (d && d.code) || M('unknown'), String((d && d.output) || '').slice(0, 400));
      }
    } catch (e) {
      line.textContent = M('downloadReqFail') + (e && e.message ? e.message : e);
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
      throw new Error(M('httpErr', res.status,
        (data && (data.error || data.message)) || text.slice(0, 160) || M('noResponseBody')));
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
    subSiteState.textContent = s.loggedIn === true ? (s.loggedInCached ? M('loggedInCached') : M('loggedIn')) : s.loggedIn === false ? M('notLoggedIn') : M('unchecked');
    subSiteState.title = basisText(s);
    document.getElementById('subLogin').textContent = s.loggedIn === true ? M('changeAccount') : M('login');
  }

  // 判定依据（loginBasis）是后端已经给出的真相，0.12.9 之前 UI 完全没露出——
  // 于是「未登录」看起来像凭空断言。这里把它翻译成一句人话做 hover 说明。
  function basisText(s) {
    const when = s.loginCheckedAt ? new Date(s.loginCheckedAt).toLocaleTimeString() : '';
    const basis = s.loginBasis === 'probe-bad' ? M('basisProbeBad')
      : s.loginBasis === 'probe-ok' ? M('basisProbeOk')
        : s.loginBasis === 'probe-fallback' ? M('basisProbeFallback')
          : s.loginBasis === 'input-fallback' ? M('basisInputFallback')
            : s.loginBasis === 'stale' ? M('basisStale')
              : M('basisNone');
    return M('basisPrefix') + basis + (when ? M('basisWhen', when) : '');
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
      document.getElementById('subWindow').textContent = subWinOpen ? M('collapseWindow') : M('standaloneWindow');
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
        subAccountStatus.textContent = M('waitLogin');
        const r = await apiSoftPost('login', { siteId: site, wait: true, timeoutMs: 300000 });
        if (!r.ok) {
          subAccountStatus.textContent = '✗ ' + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          subAccountStatus.textContent = (d.alreadyLoggedIn ? M('stillValid') : (d.message || M('loginDone')))
            + (d.ms ? M('msSuffix', Math.round(d.ms / 1000)) : '');
          subAccountStatus.className = d.loggedIn === true ? 'success' : 'error';
        }
      } else if (kind === 'verify') {
        const r = await apiSoftPost('verify-login', { siteId: site });
        if (!r.ok) {
          subAccountStatus.textContent = M('verifyFail') + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          // 三态：true / false / null（null = 该站点尚未打开过，不是错误）。
          subAccountStatus.textContent = d.loggedIn === true ? M('verifyOk')
            : d.loggedIn === false ? M('verifyNotYet')
              : M('verifyUnknown');
          subAccountStatus.className = d.loggedIn === false ? 'error' : 'success';
        }
      } else if (kind === 'window') {
        const r = await apiSoftPost('window', { siteId: site, action: subWinOpen ? 'close' : 'open' });
        if (!r.ok) {
          subAccountStatus.textContent = '✗ ' + r.error;
          subAccountStatus.className = 'error';
        } else {
          const d = r.data;
          subAccountStatus.textContent = (d && d.alreadyOpen) ? M('windowExists')
            : (subWinOpen ? M('windowClosed') : M('windowOpened'));
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
      if (!res.ok) throw new Error(M('saveFail'));
      const result = await res.json();
      statusEl.textContent = M('saved');
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
</html>`;
}
