# 思维轨迹周对比（2026-09-01 → 2026-09-08）

## 数据来源
DSH 会话存档 `~/.dsh/sessions/--D-9_Code_Workspace-dsh-webcode-bridge--/`（zstd 压缩 JSONL），
统计 assistant/message 中 reasoning 块与 tool-call 块。

## 关键发现

### 一周前（09-06 ~ 09-07 早期）：思维链完全缺失
- 全部会话 reasoning 块 = 0（44 个会话无一例外）；
- 模型回答直接给 text，没有思考过程可观察；
- 根因：当时桥的解码器丢弃 THINK 片段（上游 webcode 协议如此），onThink 通道尚未打通。

### 09-07 21:05 转折点（session-8c4e54b2，deepseek 专家模型）
- reasoning 块 266 个 / 136,090 字，352 次工具调用，258 轮；
- 思考质量样本（英文结构化推理）：
  1. "Let me understand the user's request..."（2268 字符，任务拆解）
  2. "Let me look at the structure, PLAN.md, README.md first."（55 字符，计划）
  3. "The function call schema requires all params..."（219 字符，工具参数校验反思）
- 工具错误率 9.1%（32 错 / 352 调用）且错误后成功恢复——错误回填链路当时已可用。

### 09-08（本轮修复前）：
- flash 会话重新出现 reasoning=0——flash 模型本无 THINK 流，属预期；
- deepseek:deepseek（专家）会话 09-08 09:54 reasoning=0 ——异常！38 次工具调用却零思考。
  根因：0.6.3 前后 think pill 同步缺陷，深度思考开关未真正打开（48f65ce 修复）。
- 20:06 会话 f3fa97fd：reasoning 2 块 879 字，pill 修复生效；但第二轮裸 fence 调用被
  parseAgentReply 丢弃（takeObj 对无 mcp_action 的 code fence 直接 return），任务第二轮裸奔。

## 与本周修复的对照
| 能力 | 一周前 | 本轮（0.6.9） |
|---|---|---|
| THINK → reasoning 块 | 全部丢弃 | 专家模型全程输出 |
| 深度思考 pill 同步 | 无此机制 | 手动三态 + 按模型自动 |
| 工具错误回填 | 已可用 | 不变 |
| 错误后裸 fence 调用 | 会被丢弃 | 解析为真实调用 |
| 自驱动轮数 | 常见 1-2 轮后裸奔 | probe-16: 4-8 轮收束 |

## 长时自驱动真机验证（real-probe-16，2026-09-08 修复后终跑）

任务：真实代码安全审查（读 README/package.json + grep 凭据关键词 + git log + 可疑点核实），
无任何外部提示，错误真实产生并回填。终跑结果 **PASS**：

- 4 轮自驱动：`read×3, grep×1, shell×4`，全部真实执行；
- 错误恢复：read 对 `package.json`（根目录无此文件）报 1 次错误后，模型改用正确路径重试成功
  （`toolErrThenOk={"read":{"err":1,"ok":2}}`）——上一轮的「裸 fence 丢弃」缺陷不复存在；
- 思维链 2577 字贯穿全程；收束结论基于真实 grep 结果（无凭据、依赖仅 playwright-core/ws）。

## 缺陷复盘补充

probe-16 开发中自身两次踩坑（留作方法论记录）：
1. `read` 工具把整个 arguments 对象当路径字符串拼接（`String({path:'README.md'})` → `[object Object]`），
   错误信息精确暴露了它——这正是「错误必须真实产生并回显」的价值：错误文本直接定位了执行器 bug；
2. Windows 路径判界用 `startsWith` 会被同级目录（`D:\repo-2` vs `D:\repo`）绕过，已改 `path.relative`。
