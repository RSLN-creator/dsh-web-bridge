# 右栏画面流「糊 / 帧率低」根因与方法清单（2026-09-25）

> 用户问题：**有没有办法做到更高帧率 / 更高锐度？比起直接在原网页看，细节少了很多、有点糊。**
>
> 取证口径：本仓库源码逐行核对 + 本机 `node -e` 实算 + 本地 sciverse 学术检索 +
> `reference/` 新拉的两个项目（`steel-browser`、`puppeteer-stream`，均 2026-09-25 落盘）。
> **不推测**：每条数字都能用文末锚点复现。
>
> **实施状态（0.21.2，2026-09-25）**：§四 的 **P0-A / P0-B / P0-C 三条已落地并通过验证**——
> 视口改为「面板 CSS × dpr」对齐画布（上限抬到 2560×3200）、RTC 补 `contentHint`
> + `degradationPreference` + **显式 `maxBitrate`**、三档画质（idle 走**无损 PNG**）。
> 另按用户要求处理了右栏 UI（删自建状态行）、新页跟随、右栏全关回收浏览器、昼夜同步。
> 护栏 `test/live-view.test.mjs` 30/30。**P1-D（帧间隔 EWMA）也已落地**（判据即 `pickStreamMode`）；
> **P2-E（ack 端到端背压）仍未做**，见 §四 与文末「未做」。
> 「动起来」的额外发现见 §4.5（BWE 慢爬是运动初期糊的真凶之一）。

---

## 零、结论先行

「糊」不是单一原因，是**三个独立的分辨率/编码损失源叠加**，且第一个最致命：

| # | 损失源 | 量级 | 现状 |
| --- | --- | --- | --- |
| **A** | `viewportForPanel` 的 **1280×2000 硬上限** | 最坏 **2.5× 上采样**（丢 ~60% 线性细节） | 完全没修，**这是主因** |
| **B** | RTC 轨缺 `contentHint` / `degradationPreference` | 编码器为保帧率**主动降分辨率** | 一个都没设 |
| **C** | JPEG 对文字本就不合适（8×8 DCT） | 文字笔画周围**必然**出现伪影 | hi 档也只是 q90 |

**核心矛盾一句话**：0.20.2 的「×2 超采样」是按**460px 宽侧栏**设计的；
只要面板宽过 **640 CSS px**，1280 上限就吃掉超采样，面板越宽越糊。
而**全屏工作区**（官方侧栏在 <768px 视口或手动全屏时占 100% 宽）正是最宽的情形。

---

## 一、根因 A：1280 硬上限（主因，可量化）

### 1.1 两端各自算尺寸，中间没有对齐

**服务端**（[`lib/live.js:141-150`](../../package/dsh-webcode-bridge/lib/live.js)）：

```js
const k = Math.max(VP_MIN_K, Math.min(VP_SUPERSAMPLE, VP_MAX_W / pw, VP_MAX_H / ph));
return { width: Math.round(pw * k), height: Math.round(ph * k) };
```

`VP_MAX_W = 1280`、`VP_MAX_H = 2000`。→ **页面被渲染成的像素尺寸上限 1280×2000**。

**客户端**（[`lib/client.cjs:3864-3866`](../../package/dsh-webcode-bridge/lib/client.cjs)）：

```js
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const bw = Math.max(1, Math.round(box.clientWidth * dpr));
const bh = Math.max(1, Math.round(box.clientHeight * dpr));
```

→ **画布 backing store = 面板 CSS 尺寸 × dpr**（dpr 上限 2）。

两者**没有任何一处互相校验**。`drawImage` 用 `contain` 语义（[`client.cjs:3873-3876`](../../package/dsh-webcode-bridge/lib/client.cjs)）：
源图比画布小，就**拉伸放大**——那就是糊。

### 1.2 实算：模糊从哪一行开始

判据：`面板CSS宽 × dpr > 1280`（或高 × dpr > 2000）⇒ 源图被上采样。

| 面板 CSS | dpr=1 | dpr=1.25 | dpr=1.5 | dpr=2 |
| --- | --- | --- | --- | --- |
| 460×860 | 0.50 ✓ | 0.63 ✓ | 0.75 ✓ | **1.00 ✓** |
| 640×900 | 0.50 ✓ | 0.63 ✓ | 0.75 ✓ | **1.00 ✓** |
| 800×1000 | 0.63 ✓ | 0.78 ✓ | 0.94 ✓ | **1.25 ✗** |
| 1000×1200 | 0.78 ✓ | 0.98 ✓ | **1.17 ✗** | **1.56 ✗** |
| 1400×900 | **1.09 ✗** | **1.37 ✗** | **1.64 ✗** | **2.19 ✗** |

（数字 = 源图→画布的线性放大倍数；>1 即上采样，越大越糊）

**读法**：

- `640×900` 是**临界点**——1280 ÷ 2 = 640。这正是「典型侧栏」宽度附近，所以**小侧栏时看着还行**，
  这解释了为什么问题被长期低估。
- `1000×1200 @ dpr=2`：画布 2000×2400 = 4.8MP，源图只有 1280×1536 = 1.97MP
  ⇒ 线性放大 **1.56×**，等于**只显示原页面 64% 的线性分辨率**（面积上只剩 41%）。
- `1400×900 @ dpr=2`：**2.19×** 上采样。全屏宽工作区就在这一档。

### 1.3 为什么「比起原网页看」特别明显

真实浏览器看同一个页面：1000 CSS px 宽 @ dpr=2 → 浏览器按 **2000 设备像素**渲染，文字是原生矢量化抗锯齿。
本桥：页面被 `Emulation.setDeviceMetricsOverride` 压到 **1280 设备像素**，再被画布拉到 2000。
**同一屏内容，真实浏览器拿到 2000 像素的信息量，桥只有 1280** —— 差的 36% 就是用户看到的「少了很多细节」。

---

## 二、根因 B：RTC 轨缺三个关键旋钮

grep 全库（`lib/*.js`、`lib/*.cjs`）：

```
contentHint | degradationPreference | maxBitrate | codecPreferences | sendEncodings | setParameters
→ （无任何匹配）
```

**一个都没设。** 具体缺什么、代价是什么：

### 2.1 `contentHint` —— 最重要的一条

现状（[`lib/live.js:164`](../../package/dsh-webcode-bridge/lib/live.js)）：

```js
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include'
});
```

**没有 `contentHint`。** 按 W3C [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)：

- `contentHint = 'detail'` → 映射到 `maintain-resolution`：**宁可掉帧也要保分辨率**
- `'text'` → 面向文字内容，编码器倾向保笔画

缺省时编码器按「摄像头视频」假设工作——**为保帧率主动降分辨率**。
这正是「帧率上去了但更糊」的机制。LiveKit 社区对同款问题的结论很直白：
「**maintain-resolution is the right call for text**」（[LiveKit 讨论](https://community.livekit.io/t/screen-share-blurry-soft-on-subscribers-sharpens-after-several-seconds-looking-for-the-right-knobs-livekit-client-2-16-0-simulcast-adaptivestream/2063)）。

### 2.2 `degradationPreference`

`RTCRtpSender.setParameters({ degradationPreference: 'maintain-resolution' })`
——与 `contentHint` 同向，但作用在 sender 参数层，对**已建立的**连接更可靠。
两者应同时设。

### 2.3 `codecPreferences`

Chrome 135/136 的实测对比（[webrtc-developers](https://www.webrtc-developers.com/comparison-of-webrtc-codecs-for-video-and-screen-sharing/)）：
VP8 / VP9 / H.264 / H.265 / AV1 在屏幕共享场景差别显著。
配合 AV1 的 **Screen Content Coding (SCC)** 工具（[Visionular](https://visionular.ai/av1-screen-content-coding/)），
对「平坦区域 + 锐利笔画」这类合成内容有专门优化。
**但对本桥要谨慎**：AV1 软编在 x86 上编码耗时 ~15ms/帧且 CPU 225%（同上实测），
VP9 是 18ms / 180%。本机是**回环**、没有带宽压力，**编码耗时才是唯一瓶颈**——
所以这条的收益取决于 CPU 余量，需要真机测，不能盲上。

### 2.4 一个被忽略的事实：RTC 也被 1280 上限卡着

0.21.1 我在 `resize` 分支加的注释写「画面由 getDisplayMedia 自采整页，尺寸随页面走，
不需要 CDP 投屏上限」——**那句只对 `Page.startScreencast` 的 `maxWidth` 成立，对 RTC 不成立**。

页面仍被 `Emulation.setDeviceMetricsOverride({ width: viewport.width, ..., deviceScaleFactor: 1 })`
（[`lib/live.js:275-277`](../../package/dsh-webcode-bridge/lib/live.js)）压在 1280 宽、**且 dsf=1**。
`rtc-offer` 只 `Page.stopScreencast`（[`live.js:373`](../../package/dsh-webcode-bridge/lib/live.js)），**不撤 Emulation**。
所以 `getDisplayMedia` 采到的**就是 1280 设备像素宽的页面**。

**⇒ 根因 A 对 RTC 路线同样成立。** 这是我上一轮报告里漏掉的一条，本轮补正。

---

## 三、根因 C：JPEG 天生不适合文字（文献佐证）

sciverse 检索（本地 CLI，`~/.sciverse/credentials.json` 已登录）命中三段直接相关的原文：

1. **《PatchSVD: A Non-Uniform SVD-based Image Compression Algorithm》(2024)**
   > "JPEG image compression is based on the assumption that within an **8×8 pixel block**, there are
   > no sharp changes in intensity. However, in some use cases, such as **compressing images of text**
   > or electronic circuit diagrams, **this assumption does not hold**, and JPEG creates visible
   > compression artifacts around the drawn lines."

2. **《Deep Image Compression Using Scene Text Quality Assessment》(2023)**
   > "traditional image compression methods such as JPEG may generate block noise when the compression
   > ratio is high, resulting in **unreadable text** … JPEG images at high compression lost the
   > readability of the text significantly."

3. **《Analysis of Coding Tools and Improvement of Text Readability for Screen Content》(IEEE PCS 2012)**
   —— 标题即结论：屏幕内容（含文字）需要**专门的编码工具**，通用视频编码标准
   「perform well for video sequences captured by a real camera」但对人工合成内容效率不佳。

**对本桥的含义**：`hiQuality: 90` 的 JPEG 仍是**有损 DCT**。
文字笔画在 8×8 块边界上必然产生 ringing / blocking。
所以**即使解决了根因 A 的尺寸问题，JPEG 路线仍会残留伪影**。

---

## 四、方法清单（按 收益/成本 排序）

### 【P0-A】把上限从「固定 1280」改成「**按 dpr 对齐画布**」

问题的本质是**两端尺寸没人对齐**。最直接的修法：让服务端知道客户端的 `dpr`，
令目标像素 = `面板CSS × dpr`（即画布 backing），而不是「面板 ×2 后钳到 1280」。

客户端已有 `dpr`（[`client.cjs:3864`](../../package/dsh-webcode-bridge/lib/client.cjs)），
`resize` 消息里多带一个字段即可。服务端：

```
k = clamp( min(VP_MAX_W / w, VP_MAX_H / h), 1, dpr )   // dpr 由面板上报
```

上限 `VP_MAX_W/H` 仍保留（防 JPEG 撑爆），但**至少要提到 2560×3200**（dpr=2 的 1280×1600 面板）
才够覆盖全屏情形。**这是收益最大的一改**：

| 面板 | 现状 | P0-A 后 |
| --- | --- | --- |
| 1000×1200 @dpr2 | 1280×1536（1.56× 糊） | 2000×2400（**1.00×**） |
| 1400×900 @dpr2 | 1280×823（2.19× 糊） | 2560×1646（1.09×） |

**代价**：JPEG 帧面积翻倍 ⇒ 编码耗时上升（这正是当初钳 1280 的原因）。
必须与【P0-C】的「静止用 PNG、运动才 JPEG」配对，否则滚动会变卡。

### 【P0-B】RTC 补三个旋钮 + 撤掉对 RTC 的尺寸压制

1. `track.contentHint = 'detail'`（文字场景；W3C 明确映射到 maintain-resolution）
2. `sender.setParameters({ degradationPreference: 'maintain-resolution' })`
3. RTC 活跃时，`Emulation.setDeviceMetricsOverride` 的 **`deviceScaleFactor` 设为 `dpr`**、
   宽高设为**面板 CSS 尺寸**（而非 ×2 钳制）——这样页面布局与真实浏览器一致，
   且采集分辨率 = 面板×dpr = 画布 backing，**天然 1:1**。

⚠️ **连带正确性**：若 dsf≠1，视频内在尺寸 = 面板CSS × dsf，
`toPagePointLive`（[`client.cjs:3791-3803`](../../package/dsh-webcode-bridge/lib/client.cjs)）
现在直接把视频像素当页面 CSS 像素用，**会整体偏移 dsf 倍**。
必须同步除以 dsf——这是与 0.20.3「点击没反应」同类的坑，**不能只改一半**。

### 【P0-C】静止帧用 PNG（无损），运动才 JPEG

现有自适应已经有 hi/lo 两档（[`live.js:189-196`](../../package/dsh-webcode-bridge/lib/live.js)），
但两档都是 JPEG。CDP `Page.startScreencast` 的 `format` 支持 **`"png"`**
（[playwright protocol.d.ts:16213](../../package/dsh-webcode-bridge/node_modules/playwright-core/types/protocol.d.ts)：`format?: "jpeg"|"png"`）。

而 screencast 是**损伤帧**：页面静止时 Chromium 一帧都不发。
⇒ **静止时用 PNG 几乎不增开销，却能拿到像素级完美的文字**。

```
静止(idle) → format:'png'          // 无损，帧稀疏，成本可忽略
运动(motion) → format:'jpeg', q55  // 有损，但运动中看不出
```

这条**直接消灭根因 C**，且与【P0-A】天然互补
（PNG 面积大但帧极少；JPEG 面积小但帧多）。
**这是四条里性价比最高的一条。**

### 【P1-D】帧间隔 EWMA 替代「3 帧阈值」画质控制器

上一轮报告 §2.2 已论证：现在用「500ms 内 ≥3 帧」判运动，会把「静止但编码慢」误判成静止。
换 `i_n = EWMA(帧间隔)` + 比例控制器，把 4 个魔数收敛成 2 个，
并让【P0-A】面积翻倍后的**帧率下降能被自动吸收**（降 q 换帧率）。
**P0-A 落地后这条从「可选」变成「必要」**——否则大面积 JPEG 会把滚动拖卡。

### 【P2-E】ack 端到端背压

`Page.screencastFrameAck` 现在**在转发后立刻发**（[`live.js:307`](../../package/dsh-webcode-bridge/lib/live.js)），
与客户端是否画完无关 ⇒ 服务端满速编码，客户端靠「最新帧制胜」丢中间帧。
**丢弃在最下游，编码开销一帧没省**。改成客户端回 `frame-rendered` 再 ack，
才是真背压。P0-A 之后这条的收益会明显上升。

---

## 四·五、「动起来」为什么另外糊（本轮新增，用户明确追问）

用户原话：「**关键除了静止还有动起来也需要啊画面内**」。
静止靠 P0-C（PNG）解决了，**运动是另一回事**，有三个独立机制：

### 4.5.1 JPEG 投屏是**帧内编码**——滚动时每一帧都是完整关键帧

这是最根本的一条。`Page.startScreencast` 出的是**独立 JPEG**，
每帧只做空间压缩（8×8 DCT），**没有运动补偿**。
而视频编码（H.264/VP9/AV1）的核心正是「只编码帧间差异」——
sciverse 命中文献把这条讲得很直白：

- 《Link Adaptation for Wireless Video Communication Systems》(2017)：
  > "Motion estimation and compensation are compression techniques which exploit video
  > **temporal redundancy**. In a video sequence, adjacent frames are very similar.
  > Consequently, significant compression can be achieved by **only encoding the
  > differences between video frames**."
- 《Deep Learned Frame Prediction for Video Compression》(2018)：
  > "Predictive coding is a common practice to exploit temporal redundancy... motion
  > vectors computed at the encoder between variable sized blocks of the current frame
  > and a reconstructed reference frame"
- 《Efficient In-situ Image and Video Compression》(2019)：
  > "a video can be compressed frame by frame by some existing 2D image compression
  > methods (e.g., JPEG, JPEG2000 and BPG), **the critical temporal redundancy is
  > undesirably ignored**"

**含义**：滚动时每一帧都要重新编码整屏（因为「上一帧」对 JPEG 编码器不存在）。
所以运动态**必须**降分辨率/降质量，否则帧率直接被编码耗时卡死——
这正是 `STREAM_MODES.motion` 用 0.55× 的原因，也是这条路线**物理上的天花板**。

**结论**：滚动清晰度要再上一个量级，只能走 RTC（帧间编码）。JPEG 路线调参已经到顶。

### 4.5.2 RTC 的「慢爬」：BWE 收敛前编码器主动降分辨率（本轮已修）

RTC 有帧间编码，但**默认不给 `maxBitrate` 时**，Chrome 走 **BWE（带宽估计）**：
初始估计很低，再按丢包/延迟慢慢往上探。公开实测（见文末来源）：

| 编解码 | 到达 3 Mbps 的 ramp-up |
| --- | --- |
| VP9 | **12 秒** |
| AV1 | **17 秒** |

收敛之前，编码器为凑低码率会**主动降分辨率**。
用户看到的就是「**刚滚起来是糊的，过十几秒才清楚**」——
这个「等一等会变好」的观感正是 BWE 慢爬的指纹。

**修法（已落地）**：显式 `enc.maxBitrate = 20_000_000`。
本机是**回环**，带宽无穷，让估算器慢慢猜没有任何收益，直接给足即可整段省掉爬升。
同时设 `networkPriority = 'high'`。

### 4.5.3 `contentHint` 缺省 = 编码器按「摄像头」优化（本轮已修）

与静止那条同一个根因：不设 `contentHint` 时编码器假设输入是**摄像机视频**
（有光学模糊、高频少），于是把码率优先给帧率而非细节。
滚动时这个偏差被放大：内容变化快 ⇒ 编码器更容易选「降分辨率保帧率」。
设 `contentHint='detail'` 后它改为 `maintain-resolution`（宁可掉帧也保分辨率）。

### 4.5.4 还剩什么没做

运动态现在的最佳形态是 **RTC + 四件套 + 60fps**；
**JPEG 投屏路线的运动态仍是 0.55× 半分辨率**（物理上限，见 4.5.1）。
若用户仍觉得滚动不够清晰，下一步只有两条：

1. **把 `motion.scale` 从 0.55 提到 0.7–0.8**，代价是编码耗时上升、帧率下降——
   需要真机量一下滚动帧率再定（这是纯粹的取舍，不是 bug）。
2. **P2-E 背压**：现在服务端在满速编码**没人看的帧**（客户端「最新帧制胜」丢掉），
   省下这部分 CPU 正好可以换来更高的 `motion.scale`。**这两条应当一起做。**

---

## 五、参考项目核对（别人找的那批）

`reference/` 里**最新的两个就是画面流相关的**（均 2026-09-25 落盘，非本轮新增）：

| 项目 | 关键实现 | 对本问题的结论 |
| --- | --- | --- |
| **steel-browser**<br>`api/src/plugins/browser-socket/casting.handler.ts:382-399` | `Page.setDeviceMetricsOverride` 带 **`screenWidth`/`screenHeight`/`screenOrientation`/`deviceScaleFactor`**（移动端 dsf=3）；`startScreencast` 固定 **q75**、无超采样 | **它设了 `deviceScaleFactor` 而本桥恒为 1** —— 这正是根因 B/2.4 缺的那一半。且它 `Page.startScreencast` 用 `Page.` 前缀（非 `Emulation.`），是同一套 CDP 的两种写法 |
| **puppeteer-stream**<br>`extension/options.ts` | 走**扩展 `chrome.tabCapture`** + `MediaRecorder`，可传 **`videoBitsPerSecond` / `videoConstraints` / `frameSize`** | 比特率是**显式可调**的（本桥 RTC 完全没设）。但扩展路线与「零依赖」立场冲突，**只取「比特率该显式设定」这一条**，不引入扩展 |

**`reference/` 里没有更优的第三方画面流实现**——两个项目分别在「dsf」和「比特率」上各有一点本桥缺失，
其余维度（自适应画质、二进制帧、最新帧制胜、rAF 合并）本桥都更强。

**社区整理清单**（`doc/research/awesome-deepseek-harness-README.zh-CN.md`）里与本问题同域的项目：

| 项目 | 是什么 | 取用判断 |
| --- | --- | --- |
| `zptalk0221-cpu/dsh-remote-desktop` | 远程桌面移动化插件：手机横屏外壳 + 中文输入法 | 同域（远程桌面），但解决的是**移动端外壳**，不是编码质量 |
| `PerryLink/dsh-click` | 跨平台原生桌面控制：**截图**、读屏、点击/输入/滚动 | 截图路线；本桥已有 CDP 投屏，**不采用** |
| `yth1120/deepseek-harness`（含 `dsh-web-workbench`） | 右侧工作台套件：终端、时间轴、review、**文件与浏览器预览** | 最接近「右栏浏览器预览」的同类。其浏览器预览走 **iframe**，与「登录收敛」目标冲突（本桥 0.20.0 已因此放弃 iframe） |

**结论**：没有「应该拉但没拉」的项目。**真正的差距在参数（dsf / contentHint / 比特率 / format），不在架构**。

---

## 六、建议落地顺序

| 优先 | 改动 | 位置 | 风险 |
| --- | --- | --- | --- |
| **P0-C** | 静止帧切 PNG | `live.js` `startStream` + 自适应状态机 | 低（协议已有 `format` 字段） |
| **P0-B** | RTC 补 `contentHint`/`degradationPreference` + dsf | `live.js` `RTC_INJECT`、`client.cjs` `startRTC` | 中（**输入映射要同步除 dsf**） |
| **P0-A** | 上限改按 dpr 对齐（客户端上报 dpr） | `live.js` + `client.cjs` `resize` | 中（与 P1-D 强耦合） |
| **P1-D** | 帧间隔 EWMA 控制器 | `live.js` `ADAPTIVE`/`adaptTimer` | 中（需真机调参） |
| P2-E | ack 端到端背压 | `live.js` + `client.cjs` | 中（加一条协议消息） |

**关键依赖**：**P0-A 与 P1-D 必须同批上**。
只放大面积不改控制器 ⇒ 滚动变卡；只改控制器不放大面积 ⇒ 白改。
**P0-C 可独立先上**（收益最高、风险最低），能立刻改善「静止读文字糊」。

---

## 附：本文引用的锚点与来源

**源码锚点**（行号相对插件包根）

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `lib/live.js` | 137-150 | `VP_MAX_W=1280` / `VP_MAX_H=2000` / `viewportForPanel`（**根因 A**） |
| `lib/live.js` | 164 | `getDisplayMedia({video:{frameRate:30}})` —— 无 `contentHint`（**根因 B**） |
| `lib/live.js` | 189-196 | `ADAPTIVE` hi/lo 两档**都是 JPEG** |
| `lib/live.js` | 275-282 | `Emulation.setDeviceMetricsOverride` **dsf 恒为 1** + `startScreencast` |
| `lib/live.js` | 307 | ack 在转发后立刻发（无端到端背压） |
| `lib/live.js` | 373 | `rtc-offer` 只停 screencast、**不撤 Emulation** |
| `lib/client.cjs` | 3864-3866 | 画布 backing = `面板CSS × min(dpr,2)` |
| `lib/client.cjs` | 3873-3876 | `contain` 绘制 ⇒ 源小则上采样（**糊的直接来源**） |
| `lib/client.cjs` | 3791-3803 | `toPagePointLive` 把视频像素当 CSS 像素（dsf 改动时**必须同步**） |
| `node_modules/playwright-core/types/protocol.d.ts` | 16209-16229 | `startScreencast` 支持 `format: "jpeg"|"png"` |
| `reference/steel-browser/.../casting.handler.ts` | 382-399 | steel 的 `deviceScaleFactor` 与 q75 |
| `reference/puppeteer-stream/extension/options.ts` | 3-16, 77-82 | 显式 `videoBitsPerSecond` + `MediaRecorder` |

**sciverse 命中**（本地 CLI，`semantic-search`）

| 文献 | 年份 | 用到的结论 |
| --- | --- | --- |
| *PatchSVD: A Non-Uniform SVD-based Image Compression Algorithm* | 2024 | JPEG 的 8×8 块假设对文字**不成立**，笔画周围必然出伪影 |
| *Deep Image Compression Using Scene Text Quality Assessment* | 2023 | 高压缩比下 JPEG 显著**丧失文字可读性** |
| *Analysis of Coding Tools and Improvement of Text Readability for Screen Content* (IEEE PCS) | 2012 | 屏幕内容需**专门编码工具**，通用视频编码对合成内容效率低 |

**外部资料**

- [MediaStreamTrack Content Hints — W3C](https://www.w3.org/TR/mst-content-hint/)：`detail` → `maintain-resolution`
- [LiveKit 社区：screen share blurry/soft](https://community.livekit.io/t/screen-share-blurry-soft-on-subscribers-sharpens-after-several-seconds-looking-for-the-right-knobs-livekit-client-2-16-0-simulcast-adaptivestream/2063)：文字场景应选 `maintain-resolution`
- [Comparison of WebRTC Codecs for Video and Screen Sharing](https://www.webrtc-developers.com/comparison-of-webrtc-codecs-for-video-and-screen-sharing/)：VP9 编码 18ms/CPU 180%，AV1 15ms/CPU 225%
- [Screen Content Coding in AV1 — Visionular](https://visionular.ai/av1-screen-content-coding/)

**复现命令**

```powershell
# 根因 A 的模糊阈值表（面板 CSS × dpr vs 1280/2000 上限）
node -e "for(const dpr of [1,1.25,1.5,2]){for(const [w,h] of [[460,860],[640,900],[800,1000],[1000,1200],[1400,900]]){const k=Math.max(0.25,Math.min(2,1280/w,2000/h));const vw=Math.round(w*k),vh=Math.round(h*k);const bw=Math.round(w*dpr),bh=Math.round(h*dpr);console.log(dpr,w+'x'+h,'src',vw+'x'+vh,'canvas',bw+'x'+bh,'blur x'+(bw/vw).toFixed(2));}}"

# 根因 B：三个旋钮全缺（空输出 = 全缺）
Select-String -Path lib/*.js,lib/*.cjs -Pattern 'contentHint|degradationPreference|maxBitrate|codecPreferences|setParameters'

# sciverse 检索
sciverse.exe semantic-search "screen content coding text quality video streaming remote desktop" --top-k 6 --mode fast
```
