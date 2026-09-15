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
| `lib/metrics.js` | 速率推导、token 估算、model_type 期望值（按 UI 代际，纯函数） | 低 |
| `lib/flatten.js` | OpenAI 路径的消息扁平化 | 低 |
| `bin/bridge-standalone.js` | 无 DSH 时的独立启动 | 低 |
| `lib/client.cjs` | 前端注入（设置页/侧栏入口） | 中 |
| `cordis.patch.yml` | 插件在 DSH 里的挂载点 | 低 |

`extension/`（旧浏览器扩展）、`reference/`（逆向参考仓库）、`package/backup-installed-*`、
`doc/` 都不是运行链路，**审查时可以直接跳过**。

## 一条命令替代通读

```bash
cd package/dsh-webcode-bridge
npm test      # 50 项全部单测（回归/契约/指标/解码器/图片流）+ 解析 + M1 契约（秒级，无浏览器）
node test-mock/real-verify.mjs   # 真机 8 项契约自检（需已登录的 Edge profile）
```

`npm test` 覆盖的是解析、块协议、会话游标、设置、多站点解码器——**凡是改
`lib/index.js` / `lib/agent-preset.js` 的逻辑，先跑它**（glob 收全 `test/*.test.mjs`，别再把新测试文件漏在脚本外）。

## 真机探针（需要真实站点，按需跑单个）

| 探针 | 覆盖 |
| --- | --- |
| `test-mock/real-verify.mjs` | 三模型 model_type、工具闭环（发版前必跑） |
| `real-probe-17-autonomous-marathon.mjs` | 无外部输入的自主长跑 + 轨迹落盘 |
| `real-probe-18-executor-double-fire.mjs` | 工具调用块唯一性（同 id 双发射回归） |
| `real-probe-16-long-review.mjs` | 长上下文代码审查 |
| `real-probe-19-newui.mjs` | 新版 UI 只读侦察（DOM/请求体/SSE 形状） |
| `real-probe-20-newui-facts.mjs` | 新版 UI 事实取证（带图路由/按钮 DOM/开关语义/会话 URL） |

## 已知的假失败（别浪费时间去查）

- `test-mock/run-m2.js`：走的是已废弃的浏览器扩展链路（`extension/`），
  当前架构不再使用，M2 恒 FAIL。
- `run-m2b-driver.js` / `run-m2c-webapi.js`：mock 站点的响应形状已与驱动
  期望脱节，`completion via driver` 一项恒 FAIL。其余断言仍有效。

这三项在改动前的干净树上同样失败，属既有欠账，不是回归。

## 审查时的三个不可越界约束

1. **绝不静默降级模型**：`strictModelType` 站点（DeepSeek）实际请求的元数据与所选模式
   不符时必须报错，不得退回默认模型。模式期望按 UI 代际取值（`lib/metrics.js`
   `MODEL_TYPES_BY_UI`）：旧三 pill UI 看 `model_type`，2026-09-10 新版统一 UI 看
   `thinking_enabled`；`model_type` 缺失/null 只表示网页「沿用会话模型」，其余取值不符即报错。
2. **绝不静默丢上下文**：网页会话丢失时只能「重放整段」或「抛错」，
   不允许把增量发进一个没有前文的新会话。
3. **工具协议只有一处定义**：`lib/agent-preset.js`。任何别的模块再定义一遍
   调用格式都会造成两套协议漂移。

## 卡死类缺陷的审查要点（0.15.2 新增）

本仓库最贵的一类线上故障不是「报错」，而是**不报错**：界面停在「思考中」，日志干净，
没有下一步。用户的原话是「长时间后只有思维链卡住，harness 端，没有任何报错，没有下一步」。
这类故障已经被修过两轮（0.14.0 的 WIP 稳态收束、0.15.2 的只出思维链硬上限），
所以把它固化成一条**审查规则**：

> **任何新增或修改的「等待 / 超时 / 收束」逻辑，必须同时提供两样东西：
> ① 一个**绝对上限**（墙钟，不依赖任何「看起来还在动」的启发式）；
> ② 一个**反向单测**，证明它在健康的长任务上不会开火。**

### 为什么两条缺一不可

**只有上限、没有反向单测** → 会把正常的长回复腰斩。思考阶段几十秒不吐正文是常态，
任何「多久没动静就判死」的规则只要判据写松一点，就会在真机上切掉正常回答；而它切掉的
时候**不会报错**，只会让用户觉得「模型答到一半停了」。反向单测是唯一的防线。

**只有启发式、没有绝对上限** → 就是本仓库真实发生的事故。0.14.0 的判据是
「流停 **且** 页面 DOM 助手消息停止增长」，听起来很稳，但它有一个结构性盲区：
思考阶段网页把「思考中 / Thought for 5s」这类**计时文案**持续写进同一个助手节点，
节点文本一直变长，「DOM 停长」**永远不成立**，于是收束器永不动作、唯一兜底是 240s 总超时。
教训是：**任何依赖「还在动」的判据，都必须问一句「这个『动』会不会是假的』」**——
计时器在动不是模型在产出内容。

### 具体到代码，审这几处

| 位置 | 审什么 |
| --- | --- |
| `lib/metrics.js` `shouldSettleWip` | 双条件启发式。任何放宽（比如把 DOM 条件去掉）都必须先补反向单测 |
| `lib/metrics.js` `shouldSettleStalledThinking` | 绝对上限。审 `lastAnswerAt` 是否**只**由正文/图片刷新——思考增量若也刷新它，这条判据就退化成上面的启发式，等于没修 |
| `lib/metrics.js` `answerDomLength` | DOM 采样的剥离逻辑。审它只剥「整行是计时形态」的行——剥多了会把正文算少，进而误判卡死 |
| `lib/browser-driver.js` `startWipWatch` | 判据的**接线**。审 `cfg.answerTimeoutMs` 是否真的传进了判据，以及 `settled_by` 是否如实区分了各条收束原因 |
| `lib/index.js` 收尾分支 | 「没有可交付正文」**不等于**「整轮失败」。审它是否把「只出思维链」报成了 `empty response`——那会把归因线索抹掉，让下一次没人能查 |

### 一个容易漏的接线细节

`settled_by` / `lastEndReason` 里的**收束原因必须如实区分**，不能笼统写成一个词。
`thinking-only-settled`（思考完没回答）、`partial-wip-settled`（正文写完没送 FINISHED）、
`stream_ended_before_finished`（网页断流）三者的修法完全不同；合成一个词之后，
事后排查拿到的现场等于没有。这条与 `doc/comment-style.md` §9.1「必须披露 harness」
是同一立场：**报错要能指向下一步，不能只说明「失败了」。**
