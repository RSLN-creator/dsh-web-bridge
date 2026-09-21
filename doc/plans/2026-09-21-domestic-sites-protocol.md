# 国内五站协议转换（GLM/千问/豆包/Kimi/Z.ai）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 追踪。
>
> **本文档对应设计**：`doc/research/2026-09-21-domestic-sites-protocol-design.md`（已获用户批准）。
> **铁律**：DeepSeek 站点实现**不可动**；所有「先复现钉死」任务在改码前必须先产出证据；全程中文；每任务完成即留痕 GEP Event。

**Goal:** 建立一个带状态机的统一工具调用转换层，把 GLM/千问/豆包/Kimi/Z.ai 五站适配到 DeepSeek 同水准（登录两向准确、工具闭环连续、正文无残留、上下文口径与预算闸一致）。

**Architecture:** 抽象「传输形状 transport」`{teachShape, parse, serialize}` 于新模块 `lib/tool-transport.js`，站点只在 `providers.js` 声明自己用哪支形状（GLM=代码块，其余=标签）；解析端用带状态机的统一解析器吸收现散落在 `browser-driver.js` 的标签/正则；回注端统一序列化 `{"mcp_action":"result",...}` JSON 围栏（对齐 `agent-preset.js` 信封与 opencode2dsh convert 语义）。

**Tech Stack:** Node.js 22+ 原生测试（`node --test`）、Playwright/CDP 真机探针、现有 `lib/` 模块体系。

---

## 前置：必读文件（任何任务动手前先读全，严禁猜测）
- `lib/providers.js`（站点注册表 + loginProbe + modelPicker + context）
- `lib/decoder.js`（GlmDecoder:578-637、KimiDecoder:640-679、DoubaoDecoder:680-689）
- `lib/agent-preset.js`（serializeFirstTurn / trainNoteFor / 结果信封）
- `lib/prompt-variants.js`（VARIANT_SPECS=glm 代码块支 / default 标签支 / official 官方支）
- `lib/browser-driver.js`（parseAgentReply、窗口启停、profile 归属、fillComposer、verify-login）
- `lib/accounts.js`、`lib/idle-window.js`（profile 目录与窗口关联）
- `lib/mirror.js`（staticOrigins/rootPathForSpa 同源改写）
- `lib/index.js`（流外发、context 投影、预算闸 B-2、lastPresetInfo）
- `lib/model-picker.js`（DOM 模型/模式切换库，segmented/selected 契约）
- 测试基线：`test/*.test.mjs`（现有 836 项）、`test-mock/real-verify.mjs`（`pnpm doctor`）

---

## Task 0：复现并钉死四处根因（改码之前，不猜）

### Task 0.1 登录探针真机矩阵（产证据，五站两向判定表）
**Files:**
- Read: `lib/providers.js`（各站 loginProbe）、`lib/browser-driver.js`（verify-login 调用点）
- Probe: `test-mock/real-verify.mjs`（`pnpm doctor` 加宽到五站）

- [ ] 扩展 `pnpm doctor`/探针，对 glm/qwen/doubao/kimi/zai 分别在「已登录 profile」与「空 profile」两种态下回读 loginProbe 判定，逐站记录真值。
- [ ] 产出一张表（每站：当前判定 / 真实态 / 误判方向），存 `doc/research/2026-09-21-login-probe-matrix.md`。
- 验收: 表里有每站两向证据；凡误判的站，规约出「正确的 bad/好特征」。

### Task 0.2 GLM 正文残留复现（钉死残留字节 + 触发 content type）
**Files:**
- Read: `lib/decoder.js:578-637`（GlmDecoder.obj）、`test/glm-session-replay.test.mjs`
- Probe: `node test/glm-session-replay.test.mjs` + 真机会话抓包

- [ ] 用真机（或回放夹具）跑一轮 GLM 工具调用，把原始 SSE 帧全量落盘 `.tmp/glm-replay/raw-frames.jsonl`。
- [ ] 统计每帧 `content[].type` 分布；确认 `quote_result / code / execution_output` 是否带正文文本、当前解码器是否跳过。
- 验收: 报告写明「残留的具体字节来自哪个 type、哪几帧」，作为 Task 2.1 的输入证据。

### Task 0.3 上下文口径核对（展示 vs 预算闸）
**Files:**
- Read: `lib/providers.js`（context 值）、`lib/index.js`（context 投影 + B-2 预算闸 CONTEXT_WINDOW_EXCEEDED）
- Check: `/status` 投影里的 context 与 settings 展示是否同源

- [ ] 定位「B-2 预算闸」的触发与阈值来源，与 providers `context` 字段比对，找出「展示值」与「实际预算」是否同一来源。
- 验收: 一份三行小结（glm/qwen+doubao/kimi）：展示口径、预算口径、是否一致。

### Task 0.4 profile 账户关联复现
**Files:**
- Read: `lib/browser-driver.js`（窗口启停）、`lib/accounts.js`（slot→profile 目录）、`lib/idle-window.js`
- Probe: 用独立登录窗口登录某站后，右侧窗当前登录态

- [ ] 追踪「独立登录窗口」与「右侧栏窗」各自的 profile 目录 / cookie 罐来源。
- 验收: 写清两窗是否同 profile；若不同则给出正确的关联点（含多账户 slot 语义）。

---

## Task 1：统一工具调用转换层（共享地基）

### Task 1.1 新建 `lib/tool-transport.js`——transport 契约
**Files:**
- Create: `lib/tool-transport.js`
- Test: `test/tool-transport.test.mjs`

- [ ] 定义契约并导出注册表（glm=codeblock、默认=tag 两支，deepseek=official 保留不迁移）：
```js
// lib/tool-transport.js
export const TRANSPORTS = Object.freeze({
  codeblock: {
    teachShape: 'codeblock',   // GLM：教 ```json 代码块
    open: (s) => s,
    close: (s) => s,
  },
  tag: {                       // 默认：教 <tool_call>{…}</tool_call>
    teachShape: 'tag',
    open: (s) => s,
    close: (s) => s,
  },
});
export function transportForSite(siteId) {
  if (siteId === 'glm') return TRANSPORTS.codeblock;
  if (siteId === 'deepseek') return null;   // DSH 不动，不迁移
  return TRANSPORTS.tag;
}
```
- [ ] 写单测覆盖 `transportForSite('glm')==='codeblock'`、`transportForSite('qwen')==='tag'`、`transportForSite('deepseek')===null`。
- [ ] `node --test test/tool-transport.test.mjs` → PASS。

### Task 1.2 统一工具调用解析器（带状态机，吸收 browser-driver 正则）
**Files:**
- Create: `lib/tool-parser.js`
- Test: `test/tool-parser.test.mjs`
- Read（现状要吸收的）: `lib/browser-driver.js` 的 parseAgentReply / 协议锚点（grep `parseAgentReply`、`partialProtocolAt`）

- [ ] 实现独立解析器，输出 DSH 形状的工具块，状态机 `pending→executing→result/error`：
```js
// lib/tool-parser.js —— 纯函数/可注入流，不依赖 DOM。
export function createToolParser({ shape = 'tag' } = {}) {
  const state = { calls: [] };   // 简化：按形状切分并产出{name,args}或{name,error}
  return {
    push(text) { /* 吸收文本，产出 tool 事件 */ },
    finish() { return state; },
  };
}
export function parseToolFence(text, shape) { /* 从一段正文里提取工具调用 */ }
```
- [ ] 写护栏单测：tag 形状（`<tool_call>{"name":...,"arguments":{...}}</tool_call>`）、codeblock 形状（```json 块）、块尾截断（未闭合时不误拆）。
- [ ] 将 `browser-driver.js` 现有正则解析对照移植，删除重复实现（保持行为不漂移，靠现有工具测试钉住）。
- [ ] `node --test test/tool-parser.test.mjs` → PASS。

### Task 1.3 回注序列化统一
**Files:**
- Modify: `lib/agent-preset.js`（若信封已有则复用，不重复造）
- Test: `test/tool-parser.test.mjs`

- [ ] 断言现有结果信封即 `{"mcp_action":"result","name":"…","status":"success/error","output":"…",...}`；若多处各自拼写则收敛到 `agent-preset.js` 一函数导出。
- [ ] 单测：success 与 error 两种回注入网形状一致。
- [ ] `node --test test/tool-parser.test.mjs` → PASS。

### Task 1.4 接线
**Files:**
- Modify: `lib/browser-driver.js`（把发送前的教学 prompts 与解析改走 transportForSite）、`lib/index.js`（流外发引用新解析器）
- Read: agent-preset 的 serializeFirstTurn 教学文本拼接点

- [ ] 教学提示按 `teachShape` 选支（glm→codeblock 对应现有 glm 变体；其余→tag 对应默认变体），要求与 `prompt-variants.js` 的 VARIANT_SPECS 逐字一致（不要另写一份协议）。
- [ ] 全量 `pnpm test` 绿；`test/prompt-variants.test.mjs` 不破。
- [ ] 提交 + 留痕 Event。

---

## Task 2：GLM 打样验收（先修掉问题最全的站）

### Task 2.1 消除正文残留（按 Task 0.2 证据）
**Files:**
- Modify: `lib/decoder.js:578-637`（GlmDecoder.obj）——把 `quote_result/code/execution_output` 接入统一回注/正文处理
- Test: `test/glm-session-replay.test.mjs`

- [ ] 依据 0.2 证据，对带正文的 type 按「真实字节」决定是 emitText（正则正文）还是吸收为工具块；空档一律不产生残渣。
- [ ] 用 0.2 的原始帧夹具写断言：残留字节为 0 / 预期正文完整。
- [ ] `node test/glm-session-replay.test.mjs` → PASS。

### Task 2.2 登录探针校准（按 Task 0.1 证据）
**Files:**
- Modify: `lib/providers.js`（GLM.loginProbe 的 bad/好特征）
- Test: `test-mock/real-verify.mjs`

- [ ] 按 0.1 的矩阵修正 GLM loginProbe，使两向都正确。
- [ ] `pnpm doctor` GLM 项 PASS。

### Task 2.3 上下文展示口径与预算闸分开、如实投影
**Files:**
- Modify: `lib/index.js`（context 投影）、`lib/providers.js`（区分 `context`=展示口径 与 预算口径字段）
- Test: `test/model-labels.test.mjs` / 现有 context 断言

- [ ] providers 增加显式「展示上下文」与「发送预算」两字段（值按 0.3 证据定），`/status` 与设置页投影二者。
- [ ] 回归：`test/model-labels.test.mjs` 不传参数输出与 0.14.6 **逐字不变**。
- [ ] `pnpm test` 相关项 PASS。

### Task 2.4 GLM 真机验收
**Files:**
- Probe: `test-mock/real-mirror-matrix.mjs --port 8931`、`test-mock/run-real-longrun.mjs`

- [ ] GLM 真机：登录两向准确、工具多轮闭环连续、正文无残留、上下文口径一致。
- [ ] 出真机矩阵截图证据入 src 留痕。

---

## Task 3：其余四站复用统一层铺开

### Task 3.1 千问（qwen）
- 登录探针校准（按 0.1 矩阵）；思考/搜索开关下发在驱动里接入（当前只 `openai-sse`，不盲改，先复现开关是否影响请求）；上下文口径按 0.3 修正。
- 验收: `pnpm doctor` + 工具闭环。

### Task 3.2 豆包（doubao）
- 复现 `chat/work` 模式在 `/samantha/chat/completion` 请求体的字段映射（Task 0 补充证据，暂不盲写）；登录探针校准；上下文口径按 0.3。

### Task 3.3 Kimi（kimi）
- 登录探针校准；模型请求标识 `kimiplus_id` 与 providers `quick/k3/...` id 的映射复核；上下文口径按 0.3。

### Task 3.4 Z.ai
- 登录探针校准；镜像根（`rootPathForSpa`）与慢加载复核；上下文口径随 GLM 同源。

（3.x 每站均：先复现→真机校准→复用 Task 1 层→`pnpm doctor`+工具闭环→留痕。）

---

## Task 4：全量回归 + 打包 + 留痕

- [ ] `pnpm test` 全量绿（既有 836 项不破）。
- [ ] 五站真机矩阵 `10/10`（real-mirror-matrix）。
- [ ] GEP 留痕：Task 每步写 Event；提炼「统一工具调用转换层」Gene、「GLM 正文残留」Capsule。
- [ ] `pnpm pack` 产 tgz，`scripts/verify-pack.mjs` 核对。

---

## 执行顺序
`Task 0（全部）→ Task 1.1→1.2→1.3→1.4 → Task 2.1→2.2→2.3→2.4 → Task 3.* → Task 4`。
Task 0 是改码前提（复现钉死），与后续无并行依赖；1.x 内部严格顺序；2.x 在 1.4 之后。