# Harness Web Bridge 路线

## 当前版本 0.9.5

0.9.5（真机故障取证后的五修 + z.ai）：本机 13 份真实会话转录逐事件统计后定位
（取证全文见 [故障取证](doc/incident-2026-09-11.md)）：

1. **「跑到一半突然停止」= 部分流被整段丢弃。** 12 次 `turn/end` 的 error 全是
   `web capture ended incomplete`：网页没发 `FINISHED`/`close` 就断流，而解码器
   旧判据要求两帧齐全，于是已经解出的正文与完整工具调用被一起扔掉。现在解码器
   把已解出内容带出来并标 `partial`，驱动层接受这一轮（记 `recoveredTurns`），
   只有真的什么都没有或结构坏掉才失败。
2. **工具调用失败全是参数形状漂移**（64 次报错无一例外）：`"offset" must be a
   number`、`"questions" must be an array`、缺 `description`/`command`。另加了
   `TOOL_UNKNOWN`：网页调了本会话不存在的工具（真机调用过未登记的 `write`）时，
   旧实现静默过滤 → 空回复被当收束 → 任务从此不动；现在报错并把可用工具名带回
   会话，下一轮可自纠。
3. **「退出一次后哪儿都登不上」= 写死 deepseek 的入口 + fire-and-forget 登录 +
   持久 profile 残留单实例锁。** 登录现在返回真实结果、控制面默认等待、
   启动前清 `SingletonLock`/`SingletonCookie` 等残留锁（仅在确认无活着的 ctx 时），
   有头启动失败自动清锁重试一次；设置页新增「登录网站」站点选择器。
4. **「上下文不会动」= 游标指纹认了工具描述的措辞。** 指纹改为只锁工具**名集合**，
   描述/schema 变化不再顶掉游标、不再每轮重建首轮；`contextWindow` 从一律 1e6
   收敛为按站点保守值（DeepSeek 128k、其余 64k，可覆盖），让 DSH 的压缩能触发。
5. **「预览除 deepseek 外都能开」= 镜像被 CloudFront 判成机器人。** 实测
   `chat.deepseek.com` 经反代返回 403 `Request blocked…`（glm/kimi/qwen/grok/zai
   全 200）。镜像补常规浏览器指纹头、不再剥 `sec-fetch-*`，识别 CDN/WAF 错误页并
   换成「为什么 + 改用独立窗口」的说明页；站内 302（豆包 `/` → `/chat/`）改写为
   带镜像前缀，不再落在命名空间外变空壳。

新增站点 **z.ai**（`https://chat.z.ai`，OpenAI 兼容 SSE，静态域
`z-cdn.chatglm.cn`，别名 `zai`/`z-ai`/`chat.z.ai`），实测镜像 200。

回归：本地 8 个测试文件全绿（`node test/<f>.test.mjs` 逐个跑；`pnpm test` 在本
沙箱会因 pnpm 依赖自检无 TTY 而中止，与代码无关）。

## 0.9.4

0.9.4（协议文本不再进助手文本：截在正确的层）：真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON），既占屏幕又打断阅读。真因不在渲染，而在**流式边界探测与解析器
各认一套形态**：

- `parseAgentReply` 有 DSML 归一化，所以工具照常执行；
- 流式那句行内 `marker()` 只认半角标签 / 围栏 / Calling / 裸 `{`，
  对全角 DSML 恒返回 -1，于是协议原文被当正文一路 text-delta
  发出去、写进会话。

显示层折叠救不了它：那段是正文段落，不是 `<pre>`。修正落在桥接层：

- 新增 `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套
  形态知识，探测协议起点与工具名；流式循环改用它，
  协议文本从此不再进 text-delta；
- 新增 `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文；
- `parseAgentReply` 改用共享的 `normalizeDsml()`，两处不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文（`parseAgentReply(finalText)`），只是
“发往界面”的那一侧被截断。真机夹具 `test/fixtures/leaked-dsml-reply.txt`
（从会话转录原样抽出）与 `test/protocol-leak.test.mjs`（9 项）锁住三件事：
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。

注：0.9.1–0.9.3 的“显示层折叠”已整体回退（`git stash`，可恢复）
——它对不上真机形态（只扫 `<pre>`，而泄漏的是正文段落）。

## 0.9.0
0.9.0（官方右侧栏 + 多站点真实可开）：三处收敛。

1. **右侧栏改用 DSH 官方实现**：`@deepseek-ai/dsh-client-ui-sidebar-right` 的
   `sidebarRightTabs.register()` + `sidebar.right.pane.tab` seat，与会话头角落按钮配对。
   此前依赖第三方 `dsh-better-sidebar`，且降级分支是 `position:fixed` 浮层——
   浮层会盖住右侧内容，正是「点击展开就遮挡」的来源。迁移后侧栏是布局内的一格，
   **结构上不可能遮挡**，并彻底删除 `dsh-better-sidebar` 依赖与浮层代码。
2. **模型三合一**：网页版早已没有「快速/专家/识图」三 pill，模式差异只剩「深度思考」。
   模型目录收敛为一个 `DeepSeek`；`flash`/`vision`/`deepseek-web`/`deepseek-reasoner`
   保留为别名，旧设置值不炸。带图能力对该模型自动生效。
3. **跨域静态资源同源化**：修复「打开异常」的真因——站点脚本跨域 + 非法 ACAO 被浏览器拒绝。
   站点声明 `staticOrigins`，镜像改写 HTML/CSS 绝对 URL、剥离 integrity/crossorigin，
   并把运行时 fetch/XHR 一并改写。GLM 埋点 CORS 52→0。

附带修复：Kimi 域名迁移（`kimi.moonshot.cn` → `www.kimi.com`，旧域名只剩 302）；
面板顶栏加 **刷新** 按钮（官方右侧栏无此入口）；不可达站点给出带站点名的说明页而非裸 JSON；
`test/mirror.test.mjs` 新增护栏锁住「先改写再注入」的顺序契约。

## 0.7.3

0.7.3（新 UI 适配）：2026-09-10 chat.deepseek.com 改版——模型三 pill 消失，

0.7.3（新版 UI 适配）：2026-09-10 chat.deepseek.com 改版——模型三 pill 消失，
输入框只剩「深度思考 / 智能搜索」开关，首条与续聊消息的 model_type 恒为 default，
模式差异只剩 thinking_enabled（带图发送 = default + ref_file_ids）。驱动新增 UI 代际
侦测（classic/unified），unified 下按模型语义同步深度思考开关；发送后核验升级为
「契约期望元数据全量比对」（unified 必查 thinking_enabled，model_type 缺失/null 视为
网页沿用会话模型）。长跑真机还暴露三种「解析器漏形状 → 工具循环静默中断」的调用漂移
（混合壳 / 新版 DSML 带类型属性 / tool_call 包装壳）与重复匹配，均已修复并加回归测试；
probe-17 增加「收束文本仍含调用记号即 FAIL」护栏。真机 doctor 8/8、10 轮零干预马拉松通过。详见
[长跑审查](doc/deepseek-longrun.md) 第六节。

## 0.7.2

0.7.2（长跑可靠性）：网页会话丢失改「重放整段首轮」而不是静默发增量；网页输入框
截断超长提示词改为报错；页面崩溃/浏览器被关立刻失败并自愈重开；中止会等停止
按钮点完；工具描述不再截到 300 字符（DSH 的硬约束就写在描述里）。详见
[长跑审查](doc/deepseek-longrun.md)。

## 0.6.0

多站点内容服务打通：模型选择器与 /v1/models 暴露全部 9 个内容服务的模型（'site:model' 限定 id），executor 按站点路由到独立 driver（独立 profile，避免登录态串号），未初始化站点在状态接口给占位、不启动浏览器；思考链（onThink → DSH reasoning 块）与网页图片（onImage → markdown/OpenAI image parts）贯穿 DeepSeek/GLM/ChatGPT/Kimi/Qwen/豆包/Grok/Claude/Gemini。

0.6.0 新增（本轮）：
- 模型目录收口 `listAllModels()`（providers.js），DSH 选择器与 OpenAI /v1/models 同源；
- 多 driver 容器 `driverFor(siteId)`：deepseek 沿用默认驱动（兼容测试注入），其余站点懒创建 `profileDir/sites/<siteId>`；
- executor/OpenAI 前端共用 `qualifyModelId()` 归一化限定 id，杜绝跨站点重名串模型；
- /bridge/login 与 /__webcode/login 支持 `siteId` 参数按站点登录；status 聚合 `sites[]` 列表；
- 设置页「默认模型」下拉列全站点模型；
- 解码器按逆向证据对齐：GLM（parts[].content[] 嵌套）、Kimi（event:'cmpl'）、ChatGPT（JSON-patch + 结构帧双形态）、Qwen（OpenAI 兼容 SSE + qwen-free-api 兜底），见 reference/glm-free-api、Kimi-Free-API、LLMs2API 等仓库。

已复用：MIT 的 webcode SSE 协议实现、Playwright Core、Harness 原生 LLM 与权限契约、已安装 better-sidebar 注册接口。没有复制侧栏插件本体，也没有引入另一套本地工具执行器。

## 后续顺序

1. DeepSeek 契约维护：将 DOM、模型目录、请求类型、SSE 样本集中为供应商契约；升级前运行三模型探测、真实只读工具闭环和脱敏样本回归。未知页面或请求类型拒绝继续，不静默降级模型。（探针脚本 test-mock/real-probe-05*.mjs 已就位；统一契约自检见 test-mock/real-verify.mjs，真机 7 项全绿：三模式 model_type=default/expert/vision + 工具闭环自主 read→真实执行→总结收束）
2. ~~支持图片附件~~（0.5.0 完成：消息图片块 → 网页文件上传，真机验证）
3. ~~恢复网页列表与导入~~（0.5.1 完成：真机验证 `chat_session/fetch_page` 与 `chat/history_messages` 当前结构；设置页「网页历史」可导入为主线 DSH 会话）
4. ~~设置持久化~~（0.5.0 完成 consent 持久化）；剩余：接入宿主 settingsScope 保存默认模式、预览刷新率等界面偏好。
5. ~~多站点~~（0.6.0 完成：9 站点模型目录 + 独立 driver 路由 + 按站点登录；各站点解码器已按 reference 逆向证据对齐，真实登录后的 DOM 契约仍需逐站真机校准——completionPaths 子串匹配、模型选择器标签、图片回传形态以真机为准）
6. 强化可靠性：同一 Harness 会话并发提交隔离（0.5.0 已按 agentId 隔离网页会话）、网页上下文超限、删除网页会话后的完整重建、IME 和复制选区体验。
7. ~~自定义全局指令~~（0.5.1 完成：设置页「全局指令」保存到 webcode-settings.json，追加到每个新网页会话首轮提示词）
