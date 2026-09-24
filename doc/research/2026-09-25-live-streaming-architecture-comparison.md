# 画面流架构对比研究（2026-09-25，WebRTC 决策依据）

> 背景：0.20.5（CDP screencast + 二进制帧 + 最新帧制胜 + 自适应画质）之后，
> 用户问「有没有简易 WebRTC / 更轻量的架构」。本文是拉源码本地对比后的结论。

## 一、参考项目（已下载到 reference/ 或公开源码核对）

| 项目 | live view 形态 | 关键实现（本地源码核对） | 对本桥的结论 |
| --- | --- | --- | --- |
| **steel-browser**（`reference/steel-browser`，浏览器自动化头部产品） | CDP screencast over WS | `casting.handler.ts:394`：`Page.startScreencast` JPEG **q75**、max=会话尺寸、`Page.setDeviceMetricsOverride` dpr1、帧 base64-JSON、即时 ack | **与本桥同路线**；本桥 0.20.5 在每个维度都更强（q90 自适应 / ×2 超采样 / 二进制帧 / 最新帧制胜 / rAF 合并 / DPR 感知画布） |
| **browserless**（文档核对） | 无头会话用 CDP（LiveURL）；**有头**会话才有 WebRTC live | 官方文档：无头场景走 CDP；getDisplayMedia 需要可见浏览器+授权 | 同上；WebRTC 只在有头模式被采用 |
| **puppeteer-stream**（`reference/puppeteer-stream`） | **Chrome 扩展**（`extension/` 目录）做 tabCapture → WebRTC | 扩展 + tabCapture 路线，非裸 getDisplayMedia | 两条 WebRTC 采页面之路（有头 getDisplayMedia / 扩展 tabCapture）均确认；扩展路线在无头下支持面不明，包体积与复杂度更高 |
| **BrowserBox / neko / kasmvnc** | 服务端 X + GStreamer/编码服务 → WebRTC/VNC | Linux 容器方案 | 与 Windows 宿主 + 零外部依赖冲突，排除 |

## 二、更轻量/更优架构的头脑风暴（全部评估过）

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| CDP screencast 自适应（**现状 0.20.5**） | ✅ 已落地 | 无头可跑、零依赖；滚动 q55/静止 q90 已把「编码耗时」这个真瓶颈打了 |
| 有头 + getDisplayMedia + WebRTC | ⏳ 唯一量级更高的选项（P2 已设计） | 30–60fps 硬件编码、滚动零模糊；代价=有头窗口 + ~300 行 |
| 扩展 tabCapture + WebRTC | ❌ 暂不 | 与 puppeteer-stream 同路但需要打包扩展 + 新无头（headless=new）支持面不确定 |
| WebCodecs（远端 VideoEncoder 硬编） | ❌ | 像素源仍是 CDP JPEG → 双重有损编码，画质不升反降；信令/传输复杂度等同 WebRTC |
| WebTransport | ❌ | 本机回环下传输不是瓶颈（编码才是）；换传输层零收益 |
| 截图轮询（captureScreenshot loop） | ❌ | 严格劣于损伤帧 screencast |
| noVNC/Xvfb/kasmvnc | ❌ | Linux 专用，Windows 宿主不适用 |

## 三、结论

1. **本桥现状（0.20.5）已经等同或超过无头场景的行业参考实现**（steel 用 q75 无超采样、base64 传输；我们全维度更强）。「不如 iframe」的残余差距是位图路线的物理上限，不再是无头 screencast 的调参空间。
2. **要 30–60fps 的视频级顺滑，唯一被验证的形态是有头 + getDisplayMedia + WebRTC**（browserless TV 模式，P2 设计已写入 `PLAN-2026-09-25-live-workspace.md`）。决策点只有一条：**接受画面流连接期间驱动切有头窗口（离屏定位）**。
3. 无第三条路：所有「更轻」候选要么双重大损（WebCodecs）、要么平台不符（Linux 方案）、要么收益为零（换传输层）。
