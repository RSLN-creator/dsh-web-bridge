---
type: event
date_occurred: 2026-09-08 21:50
capsule_used: ""
---
# 事件：错误恢复闭环 + Web Bridge 品牌统一 + 长时自驱动真机验证

## 背景
- 用户三项诉求：1) 工具调用错误时无返回值、对话循环跑不通；2) 设置页布局优化、深度思考开关移位；3) 右栏不叫 DeepSeek 改叫 Web Bridge；测试太小，加长时间无外部驱动的真实场景（真实代码审查 + 思维轨迹对比一周前）。

## 执行过程

[2026-09-08] 错误闭环诊断（推翻第一印象）
- 技术: 解码 DSH 会话存档（zstd JSONL）还原 20:06 会话 f3fa97fd 全过程。事实：错误结果**确已回填**（serializeDelta 的 tool-result → mcp_action result fence 正常）；真正断点在第二轮——模型回读错误后省略 mcp_action 直接输出裸 `{"name","arguments"}` code fence，`parseAgentReply.takeObj` 对非 mcp_action fence 直接 return，调用被静默丢弃，任务第二轮裸奔、无收束。
- 操作: ~/.dsh/sessions（只读）。

[2026-09-08] 裸 fence 修复 + 协议强化
- 技术: takeObj 三形状归一：tag fence 全收 / code fence 收 mcp_action=call 或纯 `{name,arguments}`（isCall 严格把关防误执行）；preset 新增「错误后修正参数重试」训令。回归测试改例：散文中的参数示例仍不触发（防注入不变），prose+裸 fence 必须触发。
- 操作: lib/agent-preset.js、test/regression.test.mjs。
- 功能: 33 项离线测试 + M1 全绿；real-verify.mjs 新增离线契约断言 parse.裸fence调用形状。

[2026-09-08] UI 三处
- 技术: 右侧栏/降级抽屉/浮窗全部 DeepSeek → Web Bridge；设置页改卡片化布局（hwb-card 分组 + 行标签列对齐）；「深度思考」三态开关从独立行移到「模型」卡内、随默认模型站点显示（仅 deepseek: 前缀），其他站点不显示（pill 契约未真机校准，不硬造开关）。
- 操作: lib/client.cjs。
- 功能: 设置页布局收敛；深度思考只在有意义时出现。

[2026-09-08] 长时自驱动真机验证（real-probe-16，新增）
- 技术: 真实代码安全审查任务（read/grep/shell 三工具、参数校验严格复刻 DSH pwsh），错误真实产生并回填，8 轮上限内全自主。开发中借 tool-err 日志抓出探针自身两 bug（read 把 arguments 对象拼成 `[object Object]`；Windows 路径 startsWith 判界被同级目录绕过→改 path.relative）。
- 操作: test-mock/real-probe-16-long-review.mjs。
- 功能: 终跑 PASS——4 轮自驱动、read 错 1 次后修正重试成功、grep/shell 全成、思维链 2577 字、收束结论基于真实 grep 结果。

[2026-09-08] 思维轨迹周对比（研究产出）
- 技术: 全量统计 44+ 会话存档 reasoning 块：09-06~09-07 早期全部为 0（THINK 丢弃期）；09-07 21:05 转折（266 块/13.6 万字/258 轮/352 调用/错误率 9.1% 且恢复）；09-08 深度思考 pill 修复后又出现专家模型 reasoning=0 的回归期。
- 操作: doc/research/thinking-trace-weekly-comparison-2026-09-08.md（新增）。

## 结论
- ✅ 四项诉求全落地：错误真正回填且恢复闭环（裸 fence 修复）；设置页布局优化 + 深度思考移位；右栏改名 Web Bridge；长时自驱动真机场景 PASS。
- ⚠️ 版本 0.6.9（tgz 已打包）；设置页 UI 改动未经真机目视核对（React 结构已过 node --check + 逻辑断言）。
- ⏭️ 下一步：0.6.9 安装到 DSH 后真机核对设置页视觉与深度思考开关位置；GLM/ChatGPT 等站点真机校准仍在排队。
