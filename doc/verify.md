# 0.4.1 验收记录

日期：2026-09-06。环境：Windows、Edge、DSH 0.1.1-rc.2、本机已有登录 profile。未使用 API 密钥，也未切换供应商配置。

最终 0.4.1 tgz 已生成并同步安装，profile 依赖已指向 0.4.1，运行源码哈希匹配；重启后 Flash 算术返回 9，并再次通过原审查会话续聊及 reload 检查。实际用时超过最初半小时限制，保留这一限制未达成的事实。

## 真实任务

输入：实际调用本地只读工具，读取 `D:/9_Code_Workspace/dsh-webcode-bridge/package/dsh-webcode-bridge/lib/providers.js`，列出三模型并审查，不修改文件。

首次成功会话 `session-0f3bb674-e208-4db4-b506-f61c4f7bd4bf`：

- `tool/call` seq 19：`str_replace_editor`，`command=view`，路径为目标绝对路径。
- `tool/result` seq 20：`isError=false`，内容含实际文件 19 行以及三模型配置。
- 后续 assistant 回答列出 flash、vision、deepseek，结束标记 `HARNESS_REVIEW_OK`。
- 浏览器关闭重开后仍显示输入、工具行及结果。续问获得三个 id 和 `PERSISTENCE_OK`，再次 reload 仍在。
- 日志位于 `~/.dsh/sessions/--D-9_Code_Workspace-dsh-webcode-bridge--/<sessionId>/session.jsonl.zstd`，采用多个 zstd frame，需逐帧读取。

流式修复后会话 `session-e21502a4-4700-42a2-a92b-dffdaf89d1d9` 再次运行同一绝对路径任务：1 轮 2 步完成，原生约 68 tok/s，替代旧缓冲实现的 43250 tok/s；控制面报告 outputTokens=215（估算）、durationMs=4815、firstTokenMs=1217、tps=44.7（含等待时间）。不同采样会变化。

模型实际请求：Flash `default`、DeepSeek `expert`、Vision `vision`；三者 `search_enabled=false`。Vision 文本算术返回 15。专家模式的一次英文标记请求被模型拒答，模型切换已成功，但不把该次拒答计为内容验收通过。

## 自动化

`pnpm test`：7 项回归、8 项解析、M1 契约全通过。`node test-mock/run-m2b-driver.js` 和 `node test-mock/run-m2c-webapi.js` 通过。

Playwright 脚本 `package/dsh-webcode-bridge/test-mock/inspect-harness.mjs` 支持 `task`、`resume`、`settings`、`panel`、`mobile`。截图在包内 `output/playwright/`：原生设置含网页桥接，右侧复用现有侧栏，390x844 下预览图片正常加载。`PREVIEW_IMAGE_PASS`、`RIGHT_PANEL_COLLAPSE_PASS`、`PERSISTENCE_RELOAD_PASS` 均实际出现。

## 失败尝试及限制

此前模型只输出 `Calling:` 文本，未执行工具；增加严格实际输出格式解析后恢复。相对路径任务曾因极简预设缺少工作目录而读取失败，模型收到真实错误后纠正；正式验收使用绝对路径。

模拟站点曾因缺少模型选择器失败，补充原生 select 后通过。测试结果不代表其他网站、图片上传或旧网页导入 API 已完成。模型自行提出的别名风险属于模型审查输出，不作为本项目代码缺陷的独立证据。
