# Harness Web Bridge

已登录的 DeepSeek 网页作为 Harness 的模型提供方，复用原生本地工具、会话持久化及权限系统。当前版本 0.9.5。

安装：`pnpm pack` 后执行 `dsh plugin --profile web add ./dsh-webcode-bridge-0.9.5.tgz`，重启 `dsh web`。需要 Node.js 20+、系统 Edge；无需浏览器扩展。

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。
模型分组 Harness Web Bridge 暴露全部内容服务站点（`site:model` 限定 id）；DeepSeek
站点只提供唯一模型 `DeepSeek`（深度思考），旧 id（`flash`/`vision`/`deepseek-web`/
`deepseek-reasoner`）保留为别名。0.9.5 新增 `zai`（Z.ai）。

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
