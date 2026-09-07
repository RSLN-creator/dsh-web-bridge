---
type: gene
tags: [gene/deepseek, gene/tool-loop, gene/browser]
created: 2026-09-07
---
# 真机测试 DeepSeek 网页工具闭环

## 输入
- 已登录 chat.deepseek.com 的 Edge profile（如 .edge-real-profile），本地想验证工具调用闭环。

## 执行
1. 首轮：`driver.sendTurn(key, serializeFirstTurn({messages:[user案例], tools:[schema], model:{id:'deepseek'}}), {fresh:true, model:'deepseek'})`。
2. `parseAgentReply(reply)` 取 calls；对每个 call 用真实只读执行器跑；结果包成 `{"mcp_action":"result",...}` 代码块围栏。
3. 续轮：`driver.sendTurn(key, resultFence + '\n拿到结果后如还需数据就继续调用；若足够直接简洁总结收束', {fresh:false, model:'deepseek'})`，循环直到无 calls。

## 环境依赖
- playwright-core、系统 Edge、已登录 profile；结果回填用同一 conversation key 保持会话。

## 常见陷阱
- 网页常用**相对路径**参数（"package.json"）——执行器 cwd 基准必须固定为实际工程目录，否则定位失败、网页会反复重试同一调用。
- 网页产出的 grep pattern 常带 **PCRE 内联修饰符 `(?i)(?s)`**，JS `new RegExp` 不识别，需剥离为构造 flag。
- 语义归一后网页会干净总结收束（不再无谓调用）——这证明 agent-preset 的"拿到结果即收束"引导在专家模式真实生效。