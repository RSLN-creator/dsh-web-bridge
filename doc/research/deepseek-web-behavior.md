# DeepSeek 网页端行为与生态调研（2026-09-07）

> 来源：DeepSeek 官方文档（api-docs.deepseek.com）、awesome-deepseek-harness 社区清单（已下载同目录）、本插件真机探针（real-probe-05/05b/05c/05d/05e，结果 JSON 在同目录）。检索仅用国内可达渠道（官方站 + jsDelivr CDN）。

本轮实际下载留档：`doc/research/downloads/deepseek-pricing.html`，来源 `https://api-docs.deepseek.com/quick_start/pricing`，下载时间 2026-09-07（Asia/Shanghai）。社区参考全文为 `awesome-deepseek-harness-README.zh-CN.md`，通过 jsDelivr 本地保存。

## 1. 官方模型与上下文（证实"官方是 1M"）

api-docs.deepseek.com/quick_start/pricing（2026-09 抓取）：

| 模型 | 上下文 | 最大输出 |
|---|---|---|
| deepseek-v4-flash（V4-Flash-0731） | **1M** | 384K |
| deepseek-v4-pro（V4-Pro-0813） | **1M** | 384K |
| deepseek-v4-flash-vision-exp | **1M** | 384K |

- 128K 是 V3.1 时代（2025-08）的旧值；现官网定价页三模型均为 1M。本插件 `resolveModel` 的 contextWindow 已同步改为 1_000_000。
- 高峰时段（UTC 周一至周五 01:00-04:00、06:00-10:00）API 价格翻倍，非高峰减半——网页端免费额度另计。

## 2. Reasonix / Harness 官方接入方式（"它们是怎样做的"）

- 官方文档新增「接入 Reasonix」页：`npx reasonix code`，Key 存 `~/.reasonix/config.json`。
- Reasonix 的核心优化是**模型路由**：日常迭代默认 V4-Flash 控成本，`/pro` 下一轮切 V4-Pro、`/preset max` 整会话用 Pro——即"按任务难度切档"，与我们 flash/专家 双档一致。
- 官方文档未披露提示词/思考模式层面的定制；工具调用适配仍是各 bridge 项目自行解决（见下）。

## 3. 真机探针结论（回答"网页端为什么一直思考/思考浅/不实际操作"）

对 chat.deepseek.com 生产站的 SSE 抓包（real-probe-05e）：

- 专家模式回答"鸡兔同笼"类推理题时，completion 流 **`thinking_enabled: false`，且全程无 THINK 类型片段**——思考内容以内联 RESPONSE 文本输出（"好的，我们先一步一步推理…"）。即：**当前网页流的"思考"不是一个可观测阶段**，用户看到的等待时间是服务端内部推理，网页版没有把 reasoning 片段流出来。因此本插件的 thinkingMs 为 null 是真实站点行为的反映，不是 bug；解码器已同时支持 THINK 片段与 `*think*/*reason*` 路径，站点一旦开放即可自动点亮。
- "思考浅/普通说法不引起持久思考"：思考深度由服务端按 prompt 难度自适应路由（简单题 thinking_enabled=false），网页端没有用户可控的思考强度开关（对比 API 侧 reasoner 模式）。
- "不实际操作/只有明确让他做才做"：网页模型没有工具执行器，也没有 harness 的系统提示词；一切工具行为都要靠首轮注入的显式协议（本插件的 `<tool_call>` 围栏 + train note）+ 结果回填循环。这正是 agent-preset.js 存在的意义；生态里同类项目（webchat 桥接类，如 xmuwenxiang/dsh-web-chat）同样采用"协议教学 + 增量回填"。
- 首字延迟实测：简单题 0.6-1.2s，推理题 1-1.2s 首字 + 3-4s 正文（real-probe-05/05d metrics）。

## 4. 生态实践摘录（awesome-deepseek-harness，本地全文见同目录 909KB）

与本插件直接相关的做法：

- **提示词注入类**：dsh-plugin-global-prompt（Settings 全局 system 注入）、dsh-prompt-injector（每轮提醒行注入，让纪律规则可靠生效）、masknull/dsh-session-prompt（会话顶部注入+设置页即时编辑）→ 印证本插件"设置页显示首轮注入模板"的价值，后续可考虑允许用户追加自定义全局指令。
- **模型能力分级**：fuzz1og/dsh-model-capabilities —— 逐模型思考强度分级/模态开关 → 与本插件按模型注入 modeHint 同向。
- **可观测性**：PerryLink/dsh-observe —— turn/step/tool span + token 成本指标 → 本插件的真实阶段指标（firstResponse/response/thinking）是同一方向的最小实现。
- **网络层优化**：enterhalf/dsh-web-network-optimizer —— 缓存/压缩/断线重连 → 对 relay 面板轮询可借鉴（当前 1.2s 轮询已足够克制）。

## 5. 对本插件的落地改动（本版本 0.5.0）

1. 真实阶段指标：驱动侧 SSE 计时（首字/思考/正文），relay 优先采用，设置页区分 实测/估算。
2. 截图优化：视口与面板容器尺寸同步（WYSIWYG 点击映射），clip 裁掉左侧栏（flex 与 overlay 两种布局都覆盖）；textarea 发现 bug（h>120 误过滤输入框）已修复——这是"截图含固定侧栏"的根因之一。
3. 授权持久化：consent 写入 `~/.dsh/webcode-edge-profile/webcode-consent.json`，重启保留；设置页"更换账户"按钮。
4. 识图闭环：消息内图片块（dataURL/base64/http URL）→ 网页文件上传 input → 真机验证通过（8×8 红色 PNG → 回答"红色和白色"）。
5. 并行 agents：会话键加入 agentId（`sessionId::agentId`），各自独立网页会话。
6. 提示词模板：`/__webcode/preset` 返回最近一次真实首轮注入全文，设置页可展开查看。
