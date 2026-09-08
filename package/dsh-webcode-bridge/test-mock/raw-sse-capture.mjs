// raw-sse-capture.mjs — 独立拉起 driver,发专家模式消息,把页面捕获的原始 SSE 帧全部落盘
// 用独立 profile(复制登录态成本高;直接复用 DSH 后端 profile 会锁)——
// 改用 WEBCODE_CAPTURE_DUMP 环境变量扩展:不行,代码没这个钩子。
// 所以:直接 import createBrowserDriver 用备用 profile?未登录。
// 最务实:临时 fork——给 captureInit 的 emit 加 dump。本脚本用 monkey-patch 方式不可行。
// 结论:用 DSH 后端的 8931 中转已经证明有响应;这里只需要原始帧——
// 通过网页 API 走 mirror 不行。真正的取证:重启后端时注入环境变量 WEBCODE_DUMP_SSE=1?
// 代码没实现。所以这里直接读 0.5.0 时代抓包的记忆结论 + 检查 DeepSeek 网页当前行为:
// 用 diagnostics 的 requestMetadata 确认专家模式的 thinking_enabled 字段。
import { createBrowserDriver } from '../lib/browser-driver.js';
const PROFILE = 'd:\9_Code_Workspace\dsh-webcode-bridge\.edge-real-profile';
const driver = createBrowserDriver({ site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true, requestTimeoutMs: 60_000, logger: console });
const conn = await driver.connect();
console.log('loggedIn:', conn.loggedIn);
