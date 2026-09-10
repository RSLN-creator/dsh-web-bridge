# DeepSeek 新版 UI 取证（2026-09-10）

## 背景

用户在该日实测发现 chat.deepseek.com 改版：输入框附近只剩「深度思考 / 智能搜索」
两个开关，没有任何模型 pill。旧驱动第一步 `getByText('快速模式'/'专家模式'/'识图模式')`
全部落空，直接抛 `MODEL_UI_CHANGED: 未找到模型选择器`——网页桥在新版 UI 上不可用。

## 证据一：浏览器 Console（用户提供，chat.deepseek.com 首页）

```
const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
let box = ta; for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
[...box.querySelectorAll('button, [role="button"], [aria-pressed], [aria-label]')]
  .filter(el => el.getBoundingClientRect().width > 0)
  .map(el => ({ text: el.textContent.trim(), aria: el.getAttribute('aria-label'), pressed: el.getAttribute('aria-pressed') }))

→ (4) [
  { text: '深度思考', aria: null, pressed: 'true' },
  { text: '智能搜索', aria: null, pressed: 'true' },
  { text: '', aria: null, pressed: null },
  { text: '', aria: null, pressed: null },
]
```

同页 Console 另有 `hif-dliq.deepseek.com/query` 的 `ERR_NAME_NOT_RESOLVED`（广告/遥测域名，
与桥无关，不影响会话）。

## 证据二：real-probe-19（只读 DOM + 一次纯文本发送）

- `modelCandidates`：整页只有「深度思考」一项；`bodyHasExpert/HasFlash/HasVision` 全 false。
- POST `/api/v0/chat/completion`：`model_type:"default"`、`thinking_enabled:true`、
  `search_enabled:true`、`parent_message_id:null`。
- SSE 片段类型仍是 `THINK`（顶层键 request_message_id/response_message_id/model_type/v/p/o/…），
  解码器无需改动。

## 证据三：real-probe-20（带图发送 / 按钮 DOM / 深度思考开关）

| 观测项 | 结果 |
| --- | --- |
| 文件入口 | `input[type=file]` 存在且 multiple，accept 含图片后缀 → `uploadImages` 可用 |
| 带图发送 POST | `model_type:"default"` + `ref_file_ids:[file-…]`；回复正确读出测试图文字 HELLO |
| 续聊发送 POST | `parent_message_id:2`、`model_type:null`（网页「沿用会话模型」）、`thinking_enabled` 仍逐条发送 |
| 发送按钮 svg path | `M8.3125 0.981587…` 与旧契约一致（空闲/生成中都在） |
| 会话 URL | 发送后变为 `/a/chat/s/<uuid>`（游标解析不变） |
| 深度思考开关 | 是 `aria-pressed` 的 DIV（无 role=button）；点击后 aria-pressed 翻转，且下一条 POST 的 `thinking_enabled` 随之变化 |
| 开关初始状态 | 三次连续运行分别初始为 true / false / false（跨会话保留），必须每轮同步 |

## 结论

新版 UI 的「模式」= 深度思考开关状态：

- `flash` → `model_type:default` + `thinking_enabled:false`
- `deepseek` → `model_type:default` + `thinking_enabled:true`
- `vision` → 无独立入口；带图发送（`model_type:default` + `ref_file_ids`）由网页自行路由

契约与驱动的对应改动见 `doc/deepseek-longrun.md` 第六节与
`lib/metrics.js`（`MODEL_TYPES_BY_UI` / `expectedRequestMetadata`）。
