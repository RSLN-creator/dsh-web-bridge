# 审查入口：只看这 15 个文件

本仓库工作区里 1 万多个受版本控制的文件里，**真正需要读的源码只有 15 个**，其余全是
测试时浏览器生成的 profile 缓存（`test-mock/.edge-profile*`、`.driver-profile*` 等，
8456 个）和历史 tgz。任何一次代码审查都不该被它们干扰。

## 源码地图（唯一的审查面）

| 文件 | 职责 | 改动风险 |
| --- | --- | --- |
| `lib/providers.js` | 站点/模型目录、`resolveWebModel` 严格解析 | 低（纯数据） |
| `lib/contract.js` | 各站点网页契约收口（选择器/路径/解码器/严格模型校验） | 低 |
| `lib/decoder.js` | 各站点 SSE/JSON 流解码器（浏览器侧注册表） | 中 |
| `lib/browser-driver.js` | Playwright 驱动系统 Edge：登录、选模型、发车、抓流、会话槽 | **高** |
| `lib/agent-preset.js` | 首轮预设 + 增量序列化 + 回复解析（工具协议的唯一定义处） | **高** |
| `lib/index.js` | LLM provider 适配器、流式块协议、会话游标、设置、路由挂载 | **高** |
| `lib/relay.js` | 单槽执行器 + FIFO 队列 + 超时/中止 + consent | **高** |
| `lib/openai.js` | OpenAI 兼容 HTTP 前端（/v1/*、/bridge/*）+ CSRF | 中 |
| `lib/web-control.js` | 同源控制面路由 + 网页历史导入 | 中 |
| `lib/mirror.js` | 站点反代（右栏 iframe 真站点）+ 单栏化注入 | 中 |
| `lib/metrics.js` | 速率推导、token 估算（纯函数） | 低 |
| `lib/flatten.js` | OpenAI 路径的消息扁平化 | 低 |
| `bin/bridge-standalone.js` | 无 DSH 时的独立启动 | 低 |
| `lib/client.cjs` | 前端注入（设置页/侧栏入口） | 中 |
| `cordis.patch.yml` | 插件在 DSH 里的挂载点 | 低 |

`extension/`（旧浏览器扩展）、`reference/`（逆向参考仓库）、`package/backup-installed-*`、
`doc/` 都不是运行链路，**审查时可以直接跳过**。

## 一条命令替代通读

```bash
cd package/dsh-webcode-bridge
npm test      # 20 项回归 + 解析 + M1 契约（秒级，无浏览器）
node test-mock/real-verify.mjs   # 真机 8 项契约自检（需已登录的 Edge profile）
```

`npm test` 覆盖的是解析、块协议、会话游标、设置、多站点解码器——**凡是改
`lib/index.js` / `lib/agent-preset.js` 的逻辑，先跑它**。

## 真机探针（需要真实站点，按需跑单个）

| 探针 | 覆盖 |
| --- | --- |
| `test-mock/real-verify.mjs` | 三模型 model_type、工具闭环（发版前必跑） |
| `real-probe-17-autonomous-marathon.mjs` | 无外部输入的自主长跑 + 轨迹落盘 |
| `real-probe-18-executor-double-fire.mjs` | 工具调用块唯一性（同 id 双发射回归） |
| `real-probe-16-long-review.mjs` | 长上下文代码审查 |

## 已知的假失败（别浪费时间去查）

- `test-mock/run-m2.js`：走的是已废弃的浏览器扩展链路（`extension/`），
  当前架构不再使用，M2 恒 FAIL。
- `run-m2b-driver.js` / `run-m2c-webapi.js`：mock 站点的响应形状已与驱动
  期望脱节，`completion via driver` 一项恒 FAIL。其余断言仍有效。

这三项在改动前的干净树上同样失败，属既有欠账，不是回归。

## 审查时的三个不可越界约束

1. **绝不静默降级模型**：`strictModelType` 站点（DeepSeek）实际请求的
   `model_type` 与所选模型不符时必须报错，不得退回默认模型。
2. **绝不静默丢上下文**：网页会话丢失时只能「重放整段」或「抛错」，
   不允许把增量发进一个没有前文的新会话。
3. **工具协议只有一处定义**：`lib/agent-preset.js`。任何别的模块再定义一遍
   调用格式都会造成两套协议漂移。
