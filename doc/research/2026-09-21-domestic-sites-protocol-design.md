# 国内站点协议转换设计（GLM / 千问 / 豆包 / Kimi / Z.ai）

> 状态：**待评审**。本文件是调研收敛 + 实施设计的草案，任何代码改动以用户评审通过后为准。
> 背景：把 DSH 网页桥内除 DeepSeek 外的国内站点适配到 DeepSeek 同水准。参照物＝DSH 官方架构 + 开源协议转换项目 + 自建反代仓库；DeepSeek 站点为唯一端到端基线，**不可改动**。

---

## 1. 参照系（已核实的结论，来源带坐标）

| 参照 | 结论 | 证据坐标 |
|---|---|---|
| DSH 官方工具层 | Cordis 插件；模型侧内容= `Message`/`ContentBlock[]`，工具= `ToolCallBlock(id,name,arguments)`、结果= `ToolResultBlock(toolCallId,content,isError)`；经 `ctx.tools.register` 注册、`tools/result` 事件分发 | `reference/deepseek-harness/docs/subsystems/llm-streaming.md`、`docs/subsystems/tools.md`、`docs/cookbook/adding-a-tool.md` |
| DSH 官方 ACP | **官方已自带 `acp` profile**（`dsh-acp-app` = automation-only ACP server） | `reference/deepseek-harness/docs/architecture.md`、`packages/acp/*` |
| opencode2dsh | 「外部模型协议 ↔ DSH 工具语义」的权威转换实现；流事件拆 `start/text/reasoning/tool_start/tool_delta/finish/error/usage/done` | `reference/opencode2dsh/docs/design.md`、`legacy/internal/convert/{convert.go,stream.go}` |
| free-api 三站 | glm/qwen/Kimi 的网页端**私有协议→OpenAI 兼容，且都不做 function-calling 转换** | `reference/glm-free-api/src/api/controllers/chat.ts`、`qwen-free-api/.../chat.ts`、`Kimi-Free-API/.../chat.ts` |
| Zed ACP | 编辑器↔agent 合法协议；`tool_call`/`tool_call_update` + 状态机 `pending→in_progress→completed/failed` + `request_permission(allow_once/reject_once)`。**借鉴状态机思想，不整套搬** | agentclientprotocol.com |

**核心定性**：国内各网页站的协议层都不暴露原生 function calling。桥必须沿用统一链路：
`教学提示词让网页模型吐工具调用 → 桥解析 → DSH 原生权限执行本地工具 → 结果以 JSON 围栏回注同一网页会话`。
参照系的正确用法是**把这条链路做成带状态机的统一转换层**，而不是给每站手写脆弱正则。

---

## 2. 各站协议事实速查（供统一层设计）

| 站点 | 传输形状 | 思考/模式开关 | 会话 id | 上下文口径 |
|---|---|---|---|---|
| GLM (chatglm.cn) | ```` ```json ```` 代码块（绕开原生工具层拦截）；请求体 `assistant_id` ≠ `model` | think-label「极致/深度思考档位」 | `conversation_id`（SSE 首帧）＝ URL `?cid=` | `1_000_000`＝输入框容量实测**下界**，非注意力窗口 |
| Z.ai | 默认 `<tool_call>` 标签 | 模型选择器弹层 | URL 无形状（`unsupported`→整段重建） | 对 GLM 站同源，同 `1_000_000` |
| 千问 (chat.qwen.ai) | 默认标签；走 `openai-sse` | 思考/搜索独立开关（Pensée/Recherche） | `sessionId`（free-api 拆 `-` 得到） | `1_000_000`＝**声明口径，无实测** |
| 豆包 | 默认标签；`decoder:doubao` | 分段控件：对话/工作（`modelPicker.segmented`） | 无明确字段 | `256_000`＝**声明口径，无实测** |
| Kimi | 默认标签 | 思考强度快速/进阶（真模型名在菜单内）；请求模型标识=`kimiplus_id` | 动态会话 id（`/api/chat/{id}/...`） | `1_000_000`＝声明口径 |

（细节与 gap 见下方第 3、4 节，来源坐标在各子调研报告。）

---

## 3. 已知四类问题的根因研判（★=实现期必须先真机复现钉死，不猜）

1. **登录识别不准** —— `providers.js` 各站 `loginProbe.bad` 是「命中登录字样⇒未登录」的单向判定，依赖游客页/已登录页 DOM 特征；三类海外站（chatgpt/grok/claude）本质是网络 403 兜底。★真机镜像逐站校准。
2. **GLM 正文残留 + 工具调用不佳** —— `GlmDecoder` 只吃 `think/text/image`，漏掉站点真实会吐的 `quote_result/code/execution_output`（free-api 已各自转文本），漏的块成残渣 ⇒ 正文残留；```` ```json ```` 教学若有原生层抢执行或解码截断块尾，调用静默丢失。★真机复现「残留的具体字节」。
3. **上下文长度没写对** —— GLM `1_000_000` 是输入框容量下界，不是模型窗口；千问/豆包是纯声明值。**「展示口径」与「发送前预算闸(B-2)」是两件事**，需分开改。
4. **右侧打不开/慢 + 登录窗口不关联账户** —— 右侧是 `lib/mirror.js` 同源改写（`staticOrigins`/`rootPathForSpa`）覆盖不全；且站点子域镜像（`http://<siteId>.localhost:8931/`）加载慢。★账户不关联疑为 **profile 目录隔离**：独立登录窗口与右侧窗若走不同 profile/cookie 罐则登录态不互通，须其在 `lib/{browser-driver,accounts,idle-window}.js` 的窗口启停与 profile 归属处复现。

---

## 4. 方案：统一工具调用转换层 + 逐站收口（方案 A）

### 4.1 统一转换层（新增，供五站共用）
- 抽象「传输传输形状（transport）」：站点只声明 `{ teachShape: 'codeblock'|'tag', parse: 提取规则, serialize: 回注规则 }`。
- 解析端统一为**带状态机的工具调用解析器**：对照 DSH `ToolCallBlock/ToolResultBlock` 与 ACP 状态机，输出 `pending→executing→result/error`，全量测试护栏（吸收现在散落在各站的标签/正则解析）。
- 回注端统一把 DSH 工具结果序列化为 `{"mcp_action":"result","name":"…","status":"success/error","output":"…"}` JSON 围栏回注同一网页会话（对齐 opencode2dsh convert 语义与现有 agent-preset.js 信封）。

### 4.2 逐站收口
- **GLM（打样 / priorities）**：① GlmDecoder 补 `quote_result/code/execution_output` 正确处理，消灭正文残留；② 工具教学与解析在当前代码块形态上加固（块尾截断防护）；③ 登录探针真机校准；④ 上下文「展示口径」与预算闸分开、如实透出。
- **千问 / 豆包 / Kimi / Z.ai**：复用统一层，各自补登录探针、模型/模式下发、镜像根；豆包补请求体 `chat/work` 字段证据，千问补思考/搜索开关下发的协议层表达。

### 4.3 明确不做（本轮 out of scope）
- 方案 B（逐个强推网页原生 function calling）——free-api 三站都没做、证据零、网页改版即碎。
- 方案 C（整体照搬 Zed ACP / MCP 做工具层）——协议映射不到网页聊天会话。
- 不触碰 DeepSeek 站点任何实现。

---

## 5. 验收口径（定义「达标」）
- 五站 `pnpm test` 全量测试绿（现有 836 项不破）；
- 每站真机镜像：登录判定两向准确、工具闭环连续、正文无残留、上下文口径与预算闸一致；
- GLM 作为首个验收站，其余四站复用统一层后逐个铺开。

## 6. 下一步
本设计评审通过后 → 走 brainstorming 的 writing-plans skill 拆实现计划（TASKS），再进 execute。**在此之前不写任何 crate/JS 实现代码。**