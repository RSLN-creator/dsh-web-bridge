# Harness Web Bridge

已登录的网页版内容服务（DeepSeek / GLM / Z.ai / Kimi / 豆包 / Grok …）作为 Harness 的模型提供方，复用原生本地工具、会话持久化及权限系统。当前版本 0.13.1。

安装：`pnpm pack` 后执行 `dsh plugin --profile web add ./dsh-webcode-bridge-0.13.1.tgz`，重启 `dsh web`。需要 Node.js 20+、系统 Edge；无需浏览器扩展。

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。
模型分组 Harness Web Bridge 暴露全部内容服务站点（`site:model` 限定 id）；DeepSeek
站点只提供唯一模型 `DeepSeek`（深度思考），旧 id（`flash`/`vision`/`deepseek-web`/
`deepseek-reasoner`）保留为别名。

## 0.13.1

**交付物必须以 `present` 呈现，写进预设提示词。** 此前预设从未教过这件事，于是
模型写完文件只在**正文**里列一串路径——用户看到的是一堆点不动的纯文本，而不是
可点开的文件面板。现在预设新增「# 交付物呈现（present）」章节，讲清三件事：
只在正文写路径**不算**交付；`present` 让文件变成可点开的面板；要在最终答复
**之前**调用。首轮的 `[本地工具传输协议]` 尾部也带一句提醒（收尾那一刻最容易忘），
glm 的代码块分支与其它站点的标签分支都覆盖。
**仅在本会话真的注册了 `present` 时才教**——否则模型会去调一个不存在的工具，
白费一轮并撞 TOOL_UNKNOWN。

> 为什么必须升版本号：0.13.0 已发布过一份**不含**该提示词的包，同名同版本却换了
> 内容会让 pnpm 按版本号去重而静默不更新（实测安装副本仍是旧文件），也让构建指纹
> 失去意义。任何内容变更都必须伴随版本号变更。

## 0.13.0

**模型选择从「空承诺」变成真实切换。** 0.12.9 的驱动遇到 `auto` 直接返回、
**页面上一个动作都不做**，而每站目录里又只有这一条 auto——UI 有下拉，网页什么都不会变。
现在按站点声明**模型选择契约**（触发 / 选项 / 名字节点 / 回读），由 `lib/model-picker.js`
执行**精确名匹配 + 点击后回读确认**；契约缺失就如实报「未切换网页模型」，绝不假装成功。
真机实测目录（`test-mock/probe-model-dropdown.mjs` 全量 dump）：

- **z.ai**：`GLM-5.3-Flash` / `GLM-5.3` / `GLM-5.2`
- **GLM**：`GLM-5.3` / `GLM-5.3-Flash`
- **Kimi**：`快速` / `K3` / `K3 集群`
- **豆包**：`对话` / `工作`（分段控件形态，**本地默认 = 对话**）
- chatgpt / claude / gemini / qwen：未校准（诚实显示，不假装可选）

注意 `GLM-5.3` 是 `GLM-5.3-Flash` 的**前缀**，因此匹配必须是精确的
（`test/model-picker.test.mjs` 把这个陷阱钉死）。真机验证
`node test-mock/verify-model-switch.mjs` **11/11 PASS**。

**harness 截图能真的传到网页端了。** 旧实现只认 wire 形状的图片块，而 DSH 原生
（截图走的）是 `{type:'image', attachment}`——两者零交集，于是每次截图传图都被
**静默丢弃**。现在原生块经 `ctx.attachments.readImageRequest` 取像素（预算与
dsh-llm-deepseek 同档），并声明 `inputModalities` 防止宿主把图片提前换成文字；
上传后**必须看到页面上出现附件证据**才发送（拿不到就报错，绝不发一条没有图的消息）。
真机端到端 `node test-mock/real-vision-upload.mjs` PASS：上传已知色带图，
模型答「3条，红色、绿色、蓝色」。

**「检测」按钮不再报 JSON 解析错误。** 根因是 `verify-login` / `site-probe` /
`session-import` 三个 action 进了 action 表却**没进挂载清单**（手写数组漏了），
请求落到宿主兜底回 **405 + 空 body**，客户端在判断状态码之前就 `.json()`，
于是把真实原因吞成一句 `unexpected end of JSON data`。现在挂载清单从 action 表
**派生**（结构上不可能再漏），未知方法回 405 JSON、未知路径回 404 JSON，
客户端先读文本再按 content-type 解析。

**设置界面改为 harness 风格**：三段内联硬编码色合并为一张 token 化样式表
（`--dsw-alias-*` + fallback，16px 圆角卡片 / .5px 边框 / pill 按钮，与 DSH 自家
设置区同款）；站点行改为「状态点 + 名字 + 行内动作」，并**露出登录判定依据**
（`loginBasis` 一直有，此前 UI 把它丢了，于是「未登录」看起来像凭空断言）；
「检测」结果分三态，`待检查` 不再画成红色错误。

## 0.9.7

**工具调用「能执行」。** 真机 64 次工具报错全部是参数形状漂移（数字写成字符串
`"10"`、数组写成单对象、布尔写成字符串）。新增 `coerceArguments`：按工具 schema
**显式声明的类型**做定向纠偏，只做无歧义的方向，解析失败一律原样保留交给 DSH 报错。
网页调了本会话不存在的工具时，不再整轮作废，而是把「TOOL_UNKNOWN + 本会话可用工具
清单 + 请重试」作为这一轮的回复交回会话，下一轮模型自纠。

**关于「某些工具在 DeepSeek 下执行不了」。** 桥只负责把网页发来的调用正确解析、
纠偏、交付；**一个会话能用哪些工具由 DSH 的会话预设决定**——极简模式实测只注册
`pwsh`，此时 `subagent`/`write`/`edit` 本来就不可用。要跑多工具任务请把预设切到
标准模式。新增 `test/tool-loop.test.mjs` 把网页五种真实调用形状（`<tool_call>` /
全角 DSML / 裸 `<invoke>` / ```json 围栏 / `**Calling:**`）固定成回归。

## 0.9.6

**一轮连发多个工具调用不再出错。** 复现真机形状（模型一轮里连发 3 个 `read`）后，
把流式协议边界的三处缺陷一次改掉：同一个调用被开成 32 个块并整轮作废；游标推进后
又命中更早的收尾标签，`</tool_call>{"mcp_action":…` 整段漏回正文；把非调用的裸 `{`
当截断点导致正文下标卡死、流式循环挂住。现在边界**单调不减**、按边界下标去重、
用 `partialProtocolAt()` 扣住 `<t`/`<tool_cal`/`**Calling:` 这类半成品标记。
顺带修掉调用块关闭时把下标当块内容发出去（`block.text` 变成数字）。

## 0.9.5

**登录任意站点。** 设置页「连接 → 登录网站」下拉选择站点后点「登录所选网站」：打开
真实 Edge 窗口等你完成一次性登录，检测到已登录自动切回无头，并把结果（成功/已登录/
失败原因/耗时）回报到界面。旁边的「独立窗口打开」把该站点开成可交互的真实浏览器窗口，
与桥共用登录态。每站点独立 profile，互不串号；上次被强杀留下的 Chromium 单实例锁会在
启动前自动清理并重试一次（「退出过一次之后哪儿都登不上」的直接原因）。

**跑到一半突然停止已修。** 真机 13 份会话转录逐事件统计：12 次异常收尾全是
`web capture ended incomplete`——网页没发 `FINISHED`/`close` 就断流，旧解码器要求
两帧齐全，于是已经解出的正文和完整工具调用被一起丢掉。现在解码器把已解出内容带出来
并标 `partial`，驱动层接受这一轮；真的什么都没有、或结构坏掉，才失败。

**工具调用失败有据可查。** 真机 64 次工具报错全部是参数形状漂移（`"offset" must be a
number`、`"questions" must be an array`、缺 `description`），并新增 `TOOL_UNKNOWN`：
网页调了本会话不存在的工具时不再静默过滤成"收束"，而是报错并把可用工具名回传，下一轮
可自纠。游标指纹改为只锁工具名集合，工具描述升级不会再顶掉上下文游标。

**预览打不开会说明原因。** 实测 `chat.deepseek.com` 经镜像反代被 CloudFront 判成机器人
返回 403（glm/kimi/qwen/grok/zai 均 200）。镜像现在补常规浏览器指纹、识别 CDN/WAF
错误页并换成「为什么 + 改用独立窗口打开」的说明页；站内 302（豆包 `/` → `/chat/`）
改写为带镜像前缀，不再落在命名空间外变空壳。

**新增站点 z.ai**（`https://chat.z.ai`，OpenAI 兼容 SSE，静态域 `z-cdn.chatglm.cn`，
别名 `zai`/`z-ai`/`chat.z.ai`），实测镜像 200。

取证全文见仓库 `doc/incident-2026-09-11.md`（本机 13 份真实会话转录的逐事件统计）。

## 0.9.4

协议文本不再进助手文本：截在正确的层。

真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON）。真因不在渲染，而在流式边界探测与解析器各认一套形态：
`parseAgentReply` 有 DSML 归一化，所以工具照常执行；而流式那句行内 `marker()`
只认半角标签 / 围栏 / Calling / 裸 `{`，对全角 DSML 恒返回 -1，于是协议原文被当
正文一路发出去。显示层折叠救不了它（那段是正文段落，不是 `<pre>`）。

- `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套形态
  知识，探测协议起点与工具名；流式循环改用它。
- `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文。
- `normalizeDsml()`：归一化收为一处，探测与解析不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文，只是“发往界面”的那一侧被截断。
回归：`test/protocol-leak.test.mjs`（9 项，真机夹具 `test/fixtures/leaked-dsml-reply.txt`）锁住
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。
MIT。SSE 解码协议参考 MIT 项目 three-water666/webcode。产品展示名更新，安装包名及 provider ID 保持兼容。
