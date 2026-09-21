# 国内主流模型网页端原生工具调用协议与规范参考

本文档整理自各模型官方文档、开源 Chat Template（HuggingFace、vLLM、SGLang）以及真实网页端抓包证据。
供 `dsh-webcode-bridge` 在各站点的提示词构造（`agent-preset.js`）、流式解码（`decoder.js`）与调用解析（`tool-parser.js`）中参考。

---

## 1. 智谱清言 (GLM / chatglm.cn) & Z.ai (chat.z.ai)

### 1.1 开源与官方 Chat Template (GLM-4.5 / GLM-4.6 / GLM-5)
官方在 Hugging Face 与 SGLang/vLLM 上的工具调用模板采用基于 XML 的结构：
```xml
<tool_call>{function_name}<arg_key>{arg_key_1}</arg_key><arg_value>{arg_value_1}</arg_value>...</tool_call>
```
观测结果（Observation）回注格式：
```xml
<|observation|>
<tool_response>{output}</tool_response>
```

### 1.2 网页端实际行为 (chatglm.cn & chat.z.ai)
- **真机抓包特征**（见 `session-2411bccd`）：
  GLM-4/5 在网页端原生吐出的 XML 结构存在 `<arg_value>` 变体：
  ```xml
  <tool_call>tool_name
  arg1
  val1</arg_value>
  arg2
  val2</arg_value>
  </tool_call>
  ```
- **代码块调用格式**（避开网页内置沙箱拦截）：
  ````markdown
  ```json
  {"mcp_action": "call", "name": "tool_name", "arguments": {"arg1": "val1"}}
  ```
  ````
- **原生格式教学提示词（首轮注入与再教学）**：
  ```text
  [本地工具传输协议]
  必须使用 ```json 代码块发起工具调用：
  先写一行 ```json，下一行是单个 JSON 对象 {"mcp_action":"call","name":"实际工具名","purpose":"原因","arguments":{…}}，再以一行 ``` 结束。
  警告：不要使用 <tool_call>…</tool_call> 或任何 XML 标签包裹调用——本网页会把这类标签当成它自己的内置工具抢走执行并报 unknown tool call，调用会静默丢失；只有 ```json 代码块能到达本地工具网关。
  工具名和参数必须严格匹配 schema。一旦判定需要真实数据，立即发起调用并停止输出，等待真实工具结果；拿到全部所需结果后，直接给出简洁的最终答复收束本回合，不要虚构文件内容或无谓思考。
  ```
  再教学提示（增量轮）：
  ```text
  [系统提示] 请保持工具调用格式：先写一行 ```json，其内为单个 JSON 对象 {"mcp_action":"call","name":"工具名","purpose":"原因","arguments":{…}}，再以一行 ``` 结束；不要用 <tool_call> 等标签包裹（会被本网页拦截丢失）。
  ```
- **桥接策略**：
  - 教学端：优先引导使用代码块或标准 `<tool_call>` 标签。
  - 解析端：全面兼容 `<arg_value>` 键值对提取与 JSON 提取。
  - 回注端：回注 `{"mcp_action":"result","name":"...","status":"success","output":"..."}`。

---

## 2. 豆包 (Doubao / doubao.com)

### 2.1 训练与 API 规范 (Volcengine Doubao-Seed 2.0)
火山引擎 Doubao-Seed 2.0 原生函数调用格式：
```xml
<seed:tool_call>
{"name": "function_name", "parameters": {"arg1": "val1"}}
</seed:tool_call>
```
或者标准格式：
```xml
<tool_call>
{"name": "function_name", "arguments": {"arg1": "val1"}}
</tool_call>
```

### 2.2 网页端实际行为 (doubao.com)
- 网页端分为「对话」与「工作」两种模式，传输采用分块数据流。
- 网页端无原生对外暴露的 Function Calling 按钮，但在系统提示词明确要求时，模型会严格吐出 XML `<tool_call>` 或 `<seed:tool_call>` 包装的 JSON 对象。
- **原生格式教学提示词**：
  ```text
  [本地工具传输协议]
  必须使用 <seed:tool_call>{"name":"实际工具名","arguments":{…}}</seed:tool_call> 或 <tool_call>{"mcp_action":"call","name":"实际工具名","arguments":{…}}</tool_call> 发起工具调用。
  工具名和参数必须严格匹配 schema。一旦判定需要真实数据，立即发起调用并停止输出，等待真实工具结果；拿到全部所需结果后，直接给出简洁答复。
  ```
  再教学提示（增量轮）：
  ```text
  [系统提示] 请保持工具调用格式：以 <tool_call> 或 <seed:tool_call> 开始、闭合标签结束，其内为单个 JSON 对象。
  ```
- **风控要点**：ByteDance SecSDK 会检测自动化注入，需保持真实 User-Agent，抹除 `navigator.webdriver` 标记，发送间隔维持在 3500ms 以上。

---

## 3. 月之暗面 Kimi (kimi.com)

### 3.1 官方规范 (Kimi-K2)
Kimi-K2 指南 (`tool_call_guidance.md`) 规范：
```xml
<tool_call>
{"name": "function_name", "arguments": {"arg1": "val1"}}
</tool_call>
```
工具结果回注：
```xml
<|tool_response|>
{"result": "..."}
<|/tool_response|>
```

### 3.2 网页端实际行为 (kimi.com)
- 网页端传输协议：全面迁移至 **Connect-RPC** (`POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`)，响应类型为 `application/connect+json`。
- 数据流结构：二进制帧 `[flags(1)][len(4BE)][json_payload]`。
- 正文路径：`block.text.content`；思考路径：`block.think.content`。
- **原生格式教学提示词**：
  ```text
  [本地工具传输协议]
  必须使用 <tool_call>{"name":"实际工具名","arguments":{…}}</tool_call> 发起工具调用。
  工具名和参数必须严格匹配声明的 schema。调用输出后立即停止生成，等待返回结果后继续。
  ```
  再教学提示（增量轮）：
  ```text
  [系统提示] 请保持工具调用格式：以 <tool_call> 开始、</tool_call> 结束，内含 JSON 工具调用声明。
  ```
- **桥接策略**：底层由 `browser-driver.js` 的 `makeConnectSplitter` 提取每帧 JSON，解码器由 `KimiConnectDecoder` 处理。

---

## 4. 通义千问 (Qwen / chat.qwen.ai)

### 4.1 官方 Chat Template (Qwen2.5 / Qwen3)
Hugging Face 官方 Jinja 模板与 ChatML 规范：
```xml
<|im_start|>system
# Tools
You may call functions...
<|im_end|>
<|im_start|>assistant
<tool_call>
{"name": "function_name", "arguments": {"arg1": "val1"}}
</tool_call><|im_end|>
<|im_start|>tool
{"output": "..."}
<|im_end|>
```

### 4.2 网页端实际行为 (chat.qwen.ai)
- 网页端支持 OpenAI 兼容 SSE 或 JSON-patch 增量流（`/message/content/parts/0`）。
- **原生格式教学提示词**：
  ```text
  [本地工具传输协议]
  # Tools
  必须使用 <tool_call>{"name":"实际工具名","arguments":{…}}</tool_call> 格式发起工具调用。
  请严格根据提供的工具函数定义进行调用，参数名称与类型必须匹配。输出调用后立即结束当前回复，等待工具执行结果注入。
  ```
- **风控要点**：千问登录入口有滑块验证码，未登录时为游客体验（输入框可用，但上下文受限）。

---

## 5. DeepSeek (chat.deepseek.com)

### 5.1 官方训练模板 (DeepSeek-V3 / R1)
```text
<｜tool calls begin｜><｜tool call begin｜>function<｜tool sep｜>{name}
```json
{arguments}
```<｜tool call end｜><｜tool calls end｜>
```
- **原生格式教学提示词**：
  ```text
  必须严格使用 DeepSeek 官方训练模板发起工具调用：
  <｜tool calls begin｜><｜tool call begin｜>function<｜tool sep｜>{工具名}
  ```json
  {"参数名": "值"}
  ```<｜tool call end｜><｜tool calls end｜>
  ```
- 本项目唯一端到端基准，保持 `official` 解析模式不变。
