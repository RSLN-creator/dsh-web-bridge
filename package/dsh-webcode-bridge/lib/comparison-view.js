// comparison-view.js — 多列对比视图（/__webcode/comparison）的静态 HTML。
// 2026-09-18：支持 2-4 列动态布局，动态选择站点+账号，支持一次性/单独发送。

/**
 * @param {Object} opts
 * @param {Map<string, Array<{slot:string, label:string}>>} opts.allSlots - 已登录账号，按站点分组
 */
export function renderComparisonView({ allSlots = new Map() }) {
  // 构建站点选项
  const siteOptions = [];
  for (const [siteId, slots] of allSlots.entries()) {
    for (const { slot, label } of slots) {
      const accountKey = slot === '1' ? siteId : `${siteId}#${slot}`;
      siteOptions.push({ key: accountKey, label: `${label}` });
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>对比视图 - Webcode Bridge</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  background: #0f172a;
  color: #f8fafc;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶部工具栏 */
.toolbar {
  background: #1e293b;
  border-bottom: 1px solid #334155;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.toolbar h1 {
  font-size: 16px;
  font-weight: 600;
  margin-right: auto;
}
.toolbar select {
  background: #0f172a;
  color: #f8fafc;
  border: 1px solid #475569;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}
.toolbar select:focus {
  outline: none;
  border-color: #38bdf8;
}
.toolbar button {
  background: #38bdf8;
  color: #0f172a;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.toolbar button:hover {
  background: #22d3ee;
}
.toolbar button.secondary {
  background: #475569;
  color: #f8fafc;
}
.toolbar button.secondary:hover {
  background: #64748b;
}

/* 对比列容器 */
.columns {
  display: flex;
  flex: 1;
  overflow: hidden;
  gap: 1px;
  background: #0f172a;
}
.column {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  overflow: hidden;
}

/* 列头 */
.column-header {
  background: #334155;
  border-bottom: 1px solid #475569;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.column-header select {
  flex: 1;
  background: #1e293b;
  color: #f8fafc;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 12px;
}
.column-header button {
  background: #f97316;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.column-header button:hover {
  background: #ea580c;
}

/* 输出区域 */
.output {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  font-size: 14px;
  line-height: 1.6;
}
.output::-webkit-scrollbar {
  width: 8px;
}
.output::-webkit-scrollbar-track {
  background: #1e293b;
}
.output::-webkit-scrollbar-thumb {
  background: #475569;
  border-radius: 4px;
}
.output::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}

.message {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #0f172a;
}
.message.user {
  background: #1e3a5f;
}
.message.assistant {
  background: #0f172a;
  border: 1px solid #334155;
}
.message .role {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 6px;
}
.message .content {
  color: #f8fafc;
  white-space: pre-wrap;
  word-break: break-word;
}

.status {
  padding: 8px 12px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 12px;
  color: #94a3b8;
}
.status.loading {
  border-color: #38bdf8;
  color: #38bdf8;
}
.status.error {
  border-color: #ef4444;
  color: #ef4444;
}

/* 输入区域 */
.input-area {
  background: #1e293b;
  border-top: 1px solid #334155;
  padding: 12px 16px;
  flex-shrink: 0;
}
.input-area textarea {
  width: 100%;
  background: #0f172a;
  color: #f8fafc;
  border: 1px solid #475569;
  border-radius: 6px;
  padding: 10px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  min-height: 80px;
}
.input-area textarea:focus {
  outline: none;
  border-color: #38bdf8;
}
.input-buttons {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.input-buttons button {
  flex: 1;
  background: #38bdf8;
  color: #0f172a;
  border: none;
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.input-buttons button:hover {
  background: #22d3ee;
}
.input-buttons button.secondary {
  background: #475569;
  color: #f8fafc;
}
.input-buttons button.secondary:hover {
  background: #64748b;
}
</style>
</head>
<body>
<div class="toolbar">
  <h1>🔍 对比视图</h1>
  <label style="font-size:13px; color:#94a3b8;">列数：</label>
  <select id="columnCount">
    <option value="2">2 列</option>
    <option value="3" selected>3 列</option>
    <option value="4">4 列</option>
  </select>
  <button id="clearAll" class="secondary">清空所有</button>
  <button id="backToMain">返回主界面</button>
</div>

<div class="columns" id="columnsContainer"></div>

<div class="input-area">
  <textarea id="promptInput" placeholder="输入提示词，将发送到选中的账号…"></textarea>
  <div class="input-buttons">
    <button id="sendAll">一次性发送到所有列</button>
    <button id="sendIndividual" class="secondary">单独发送到每列（按列头按钮）</button>
  </div>
</div>

<script>
const allAccounts = ${JSON.stringify(siteOptions)};
const API_BASE = '/__webcode';

// 状态管理
let currentColumns = 3;
let columnStates = [];

// 初始化
function init() {
  updateColumns();
  document.getElementById('columnCount').addEventListener('change', (e) => {
    currentColumns = parseInt(e.target.value);
    updateColumns();
  });
  document.getElementById('sendAll').addEventListener('click', sendToAll);
  document.getElementById('clearAll').addEventListener('click', clearAll);
  document.getElementById('backToMain').addEventListener('click', () => {
    window.location.href = '/';
  });
}

// 更新列数
function updateColumns() {
  const container = document.getElementById('columnsContainer');
  container.innerHTML = '';
  columnStates = [];

  for (let i = 0; i < currentColumns; i++) {
    const col = createColumn(i);
    container.appendChild(col);
    columnStates.push({
      index: i,
      accountKey: allAccounts[i % allAccounts.length]?.key || '',
      messages: [],
      loading: false,
    });
  }
}

// 创建单列
function createColumn(index) {
  const col = document.createElement('div');
  col.className = 'column';
  col.dataset.index = index;

  col.innerHTML = \`
    <div class="column-header">
      <select class="account-select" data-index="\${index}">
        \${allAccounts.map(a => \`<option value="\${a.key}">\${a.label}</option>\`).join('')}
      </select>
      <button class="send-single" data-index="\${index}">发送</button>
    </div>
    <div class="output" id="output-\${index}">
      <div class="status">等待输入…</div>
    </div>
  \`;

  col.querySelector('.account-select').value = allAccounts[index % allAccounts.length]?.key || '';
  col.querySelector('.account-select').addEventListener('change', (e) => {
    columnStates[index].accountKey = e.target.value;
  });
  col.querySelector('.send-single').addEventListener('click', () => {
    sendToColumn(index);
  });

  return col;
}

// 发送到所有列（真并发）
async function sendToAll() {
  const prompt = document.getElementById('promptInput').value.trim();
  if (!prompt) {
    alert('请输入提示词');
    return;
  }

  // 真并发：同时发送到所有列
  const promises = [];
  for (let i = 0; i < currentColumns; i++) {
    promises.push(sendToColumn(i));
  }
  await Promise.all(promises);
}

// 发送到单列（流式响应）
async function sendToColumn(index) {
  const prompt = document.getElementById('promptInput').value.trim();
  if (!prompt) {
    alert('请输入提示词');
    return;
  }

  const state = columnStates[index];
  if (state.loading) return;

  state.loading = true;
  const output = document.getElementById(\`output-\${index}\`);

  // 显示用户消息
  output.innerHTML += \`
    <div class="message user">
      <div class="role">用户</div>
      <div class="content">\${escapeHtml(prompt)}</div>
    </div>
  \`;

  // 创建助手消息容器
  const assistantId = \`assistant-\${index}-\${Date.now()}\`;
  const thinkingId = \`thinking-\${index}-\${Date.now()}\`;
  output.innerHTML += \`
    <div class="message assistant" id="\${assistantId}">
      <div class="role">助手 (\${state.accountKey})</div>
      <div class="thinking" id="\${thinkingId}" style="display:none; color:#94a3b8; font-style:italic; margin-bottom:8px;"></div>
      <div class="content"></div>
    </div>
  \`;
  output.scrollTop = output.scrollHeight;

  let assistantText = '';
  let thinkingText = '';

  try {
    // 构建消息历史
    const messages = [
      ...state.messages,
      { role: 'user', content: prompt }
    ];

    // 解析 accountKey 为 siteId 和 model
    const [siteId, slot] = state.accountKey.includes('#')
      ? state.accountKey.split('#')
      : [state.accountKey, null];

    // 调用 OpenAI 兼容接口（流式）
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: siteId + ':default-model',
        messages: messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(\`HTTP \${response.status}: \${errorText}\`);
    }

    // 处理 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;

          if (delta?.content) {
            assistantText += delta.content;
            const contentEl = document.querySelector(\`#\${assistantId} .content\`);
            if (contentEl) {
              contentEl.textContent = assistantText;
              output.scrollTop = output.scrollHeight;
            }
          }

          if (delta?.reasoning_content) {
            thinkingText += delta.reasoning_content;
            const thinkingEl = document.getElementById(thinkingId);
            if (thinkingEl) {
              thinkingEl.style.display = 'block';
              thinkingEl.textContent = '🤔 思考中... ' + thinkingText.slice(0, 100) + (thinkingText.length > 100 ? '...' : '');
            }
          }
        } catch (err) {
          console.warn('解析 SSE 行失败:', line, err);
        }
      }
    }

    // 隐藏思考内容（或显示完整版）
    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl && thinkingText) {
      thinkingEl.textContent = '💭 已思考';
      thinkingEl.style.cursor = 'pointer';
      thinkingEl.onclick = () => {
        if (thinkingEl.textContent === '💭 已思考') {
          thinkingEl.textContent = thinkingText;
        } else {
          thinkingEl.textContent = '💭 已思考';
        }
      };
    }

    state.messages.push(
      { role: 'user', content: prompt },
      { role: 'assistant', content: assistantText }
    );

  } catch (err) {
    const contentEl = document.querySelector(\`#\${assistantId} .content\`);
    if (contentEl) {
      contentEl.innerHTML = \`<span style="color:#ef4444;">❌ 错误: \${escapeHtml(err.message)}</span>\`;
    }
    console.error('发送失败:', err);
  } finally {
    state.loading = false;
    output.scrollTop = output.scrollHeight;
  }
}

// 清空所有列
function clearAll() {
  if (!confirm('确定清空所有对话记录？')) return;
  for (let i = 0; i < currentColumns; i++) {
    const output = document.getElementById(\`output-\${i}\`);
    output.innerHTML = '<div class="status">已清空</div>';
    columnStates[i].messages = [];
  }
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

init();
</script>
</body>
</html>
`;
}
