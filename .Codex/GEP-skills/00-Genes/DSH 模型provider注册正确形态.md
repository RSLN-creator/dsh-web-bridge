---
type: gene
tags: [gene/dsh, gene/llm-adapter, gene/model-provider]
created: 2026-09-06
---

# DSH 模型 provider 注册正确形态

## 输入
- 想让自定义 LLM provider 出现在 DSH 主模型选择器里，并且有多个可选的模型
- 症状：provider 已注册、日志显示可对话，但模型选择器里"没有可选的模型"

## 执行
- 只调用 `ctx.llm.registerAdapter([providerId], adapter)`，**不要**同时调用
  `registerConfigurableProviders`。后者把同一 provider 放进"可配置目录"，
  会让 GUI 把它当成需要配置端点的第三方 provider，主选择器的模型列表反而不显示。
- adapter 必须提供三件事：
  1. `listModels(provider)` → 返回真实可选的模型数组 `[{ provider, id, name }]`
     （GUI 在打开选择器时实时读取它，模型会即时出现）
  2. `resolveModel(provider, model)` → 返回 `{ provider, id, name, context:{ contextWindow } }`；
     对未知模型应抛出，DPATH 会以 `INVALID_MODEL_INFO` 拒绝
  3. `stream(options)` → 逐条 yield DSH 流式 chunk
     （`block-start` / `text-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）
- 多模型时给每个 modelId 一个行为模式（mode），在序列化的首轮/增量 prompt 顶部注入模式头，
  保证选了不同模型有真实的差异。
- 官方参照：`reference/opencode2dsh/packages/plugin/src/index.ts` 的 `applyAdapter()`。

## 环境依赖
- `@deepseek-ai/dsh-llm`（`LlmRuntime`），`provider` id 需非空字符串
- GUI 端消费方 `dsh-client-ui-model-selection`

## 常见陷阱
- 双注册（configurable + adapter 同名）→ 主选择器无模型；只留 adapter。
- listModels 返回的 `provider` 必须等于注册的 provider id，否则 `INVALID_CATALOG`。
- resolveModel 未知模型不抛错会被 DSH 接受为"任意模型"，掩盖拼写错误。
- 不要设 `inputModalities:['image']`，除非 adapter 真的把图传给模型；否则 DSH 会把图
  以真实图片块发进来，而 adapter 的纯文本序列化会直接丢弃图片。