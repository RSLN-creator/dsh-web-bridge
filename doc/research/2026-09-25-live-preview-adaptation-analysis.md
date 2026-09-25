# 右栏画面流「不适配窗口比例」根因与优化空间（2026-09-25）

> 本文回答用户三问：①参考项目还有哪些优化空间 ②有无数学上可优化的算法 ③为什么右栏
> 预览不能适配所有比例/大小的浏览器窗口，是否启动时写死。
>
> **实施状态（0.21.1，2026-09-25）**：§四 表格里的 **P0 两项已落地并通过验证**——
> `viewportForPanel` 改为保比例（§2.1 草稿，含 k 下限兜底）；`adaptTimer` 与 `resize`
> 分支各加 `rtcActive` 守卫（§3.2）。护栏见 `test/live-view.test.mjs`（23/23），
> 变异测试确认守卫真实承载。**P1–P3 未做**，仍按下表排序。
>
> **取证口径**：所有结论来自本仓库源码逐行核对（行号见文末锚点清单），不推测。
> 数字来自本机 `node -e` 实算，不手抄。

---

## 零、结论先行

| 问题 | 结论 |
| --- | --- |
| ③ 是否写死 | **是，且写死了三层**：启动视口、面板换算、回落默认值。三层各自独立钳制宽高，**没有一层保比例** |
| ③ 能否适配所有比例 | 现状**不能**。极端面板下画面与面板比例误差最大 **−68%**，必然出现黑边或裁切 |
| ② 有无数学算法 | 有，且是**一行标量**的解：把两次独立 `clamp` 换成一次按比例缩放。实算 10 组比例误差全部 **0.0%** |
| ① 参考项目空间 | steel-browser 的 screencast 参数我们已全面超过；**但发现 2 处 RTC 状态机漏判**（更该优先修） |

---

## 一、问题③：为什么不能适配所有比例（根因）

### 1.1 三层硬编码，逐层破坏比例

**第一层 — 浏览器启动视口写死**（`package/dsh-webcode-bridge/lib/browser-driver.js:1687`）：

```js
viewport: cfg.liveHeaded === true ? { width: 1280, height: 1440 } : { width: 640, height: 900 },
```

固定 `1280×1440`（比例 0.889）或 `640×900`（比例 0.711）。这是「一开始启动时写死」的
**字面出处**。且 `lib/index.js:194` 的默认值是 `liveHeaded: true` —— 0.21.0 起驱动
**默认常驻有头**，拿的就是 `1280×1440` 这个写死视口。

**第二层 — 面板换算独立钳制宽高**（`lib/live.js:118-123`）：

```js
export function viewportForPanel(w, h) {
  const pw = Number(w), ph = Number(h);
  const width = Number.isFinite(pw) && pw > 0 ? Math.round(pw * 2) : 1024;
  const height = Number.isFinite(ph) && ph > 0 ? Math.round(ph * 2) : 1440;
  return { width: Math.max(720, Math.min(1280, width)),
           height: Math.max(900, Math.min(2000, height)) };
}
```

**病根在这一行**：`width` 与 `height` **各自独立**做 `max(下限, min(上限))`。只要任一个
触到边界，比例立刻失真——而两个边界（720/1280 与 900/2000）之间的可用区间并不覆盖
面板的自然比例范围。

**第三层 — 缺省回落也是写死的**：`1024×1440`（比例 0.711）。连接刚建立、`resize` 还没
到达时用的就是这个值。

### 1.2 实算：比例误差分布

对 `viewportForPanel` 逐组实算（面板比例 vs 换算后视口比例）：

| 面板 CSS | 面板比例 | 换算视口 | 视口比例 | 比例误差 |
| --- | --- | --- | --- | --- |
| 460×860（典型侧栏） | 0.535 | 920×1720 | 0.535 | **0.0%** |
| 500×1000 | 0.500 | 1000×2000 | 0.500 | **0.0%** |
| 400×400（正方） | 1.000 | 800×900 | 0.889 | −11.1% |
| 300×900（窄高） | 0.333 | 720×1800 | 0.400 | +20.0% |
| 600×300（扁宽） | 2.000 | 1200×900 | 1.333 | −33.3% |
| 1200×700 | 1.714 | 1280×1400 | 0.914 | −46.7% |
| 900×300（极扁） | 3.000 | 1280×900 | 1.422 | −52.6% |
| 1400×900 | 1.556 | 1280×1800 | 0.711 | −54.3% |
| 2400×1200（全屏宽） | 2.000 | 1280×2000 | 0.640 | **−68.0%** |

**读法**：只有「面板比例恰好落在钳制区间内」时才是 0%。比例越极端，误差越大，最大 −68%。
侧栏被拖窄、面板切全屏、浏览器窗口拉扁，都会落进失配区。

### 1.3 失配为什么表现为「不适配」而不是「裁切」

客户端绘制是 `contain` 语义 —— `lib/client.cjs:3873-3876`：

```js
const s = Math.min(bw / img.width, bh / img.height);
const dw = img.width * s, dh = img.height * s;
const dx = (bw - dw) / 2, dy = (bh - dh) / 2;
ctx2d.fillStyle = '#111';
ctx2d.fillRect(0, 0, canvas.width, canvas.height);   // 先铺黑底
ctx2d.drawImage(img, dx, dy, dw, dh);                // 再居中放画面
```

`contain` + 居中 + 黑底 ⇒ **两侧黑边**。RTC 路线的 `<video>` 同样是
`object-fit:contain`（`lib/client.cjs:4700`），所以两条路线**表现一致地留黑边**。

**关键推论**：RTC 路线（0.21.0 的新主路）**没有绕开这个 bug**。`rtc-offer` 只停
`screencast`，**不停 `Emulation.setDeviceMetricsOverride`**（`lib/live.js:336-338` 只
`Page.stopScreencast`）。页面仍按 `viewportForPanel(...)` 的尺寸渲染，`getDisplayMedia`
采到的就是这个失配比例 ⇒ RTC 视频照样黑边。

### 1.4 右侧 tab 为什么也救不了

右侧栏本身是**官方组件**（`@deepseek-ai/dsh-client-ui-sidebar-right`），面板宽度由框架的
`width` prop 给（`node_modules/.../lib/client.js:459`：
`style: { width: fullscreen ? "100%" : width }`），窗口宽 < 768px 时框架自动转全屏
（同文件 `:518` `autoFullscreen = viewportWidth < 768`）。

桥只能**读取**面板尺寸（`lib/client.cjs:3845` `box.clientWidth/clientHeight`），
**不能**改面板宽度。所以「tab 层面」无法补偿——唯一能改的就是把 `viewportForPanel`
的换算修正成保比例。

> 注：`lib/client.cjs:3677` 目前 `LIVE_SITES = new Set(['deepseek'])`，只有 DeepSeek 走
> 画面流；其余站点仍是镜像 iframe。iframe 路线 `width:100%;height:100%` 天然适配，
> 所以「不适配」只出现在画面流站点。

### 1.5 现有测试把错误行为钉住了

`test/live-view.test.mjs:192-198`：

```js
test('viewportForPanel：面板 CSS 尺寸 ×2 超采样，宽高双钳制（720–1280 / 900–2000）', () => {
  assert.deepEqual(viewportForPanel(460, 860), { width: 920, height: 1720 });
  assert.deepEqual(viewportForPanel(300, 300), { width: 720, height: 900 });
  assert.deepEqual(viewportForPanel(900, 1600), { width: 1280, height: 2000 });
  ...
});
```

测试**显式断言了「宽高双钳制」**——即把失配当成规格。修比例必须同步改这条护栏的期望值。

---

## 二、问题②：数学上可优化的算法

### 2.1 【直接解】保比例视口换算 —— 一行标量替代两次钳制

把「先各自 ×2 再各自钳制」改成「先求唯一缩放标量 k，再同时缩放」：

```
k = clamp( min(W_max / w, H_max / h), k_min, 2 )
viewport = ( round(w * k), round(h * k) )
```

其中 `W_max = 1280`、`H_max = 2000`、`k_min = 0.25`（防病态小面板）。

**为什么对**：`min(W_max/w, H_max/h)` 是「两个上限里更紧的那个」允许的最大放大倍数，
它天然满足 `w*k ≤ W_max` **且** `h*k ≤ H_max`，且 `k` 是**单一标量** ⇒ 比例严格保持。
原来的写法等于对 x、y 各用一个不同的标量，比例必然被改写。

**实算验证**（同一批面板）：

| 面板 | 现状误差 | 保比例式误差 | 换算视口 |
| --- | --- | --- | --- |
| 300×900 | +20.0% | **0.0%** | 600×1800 |
| 400×400 | −11.1% | **0.0%** | 800×800 |
| 900×300 | −52.6% | **0.0%** | 1280×427 |
| 1200×700 | −46.7% | **0.0%** | 1280×747 |
| 1400×900 | −54.3% | **0.0%** | 1280×823 |
| 600×300 | −33.3% | **0.0%** | 1200×600 |
| 2400×1200 | −68.0% | **0.0%** | 1280×640 |
| 460×860 | 0.0% | **0.0%** | 920×1720（不变） |
| 500×1000 | 0.0% | **0.0%** | 1000×2000（不变） |

**10/10 组误差 0.0%**，且原来就对的两组数值**逐字不变**（回归面小）。

**边界语义**：
- 病态小面板（如 100×100）→ `k` 触 `k_min`，得小视口，由 `Emulation` 接受；应同时保留
  一个绝对下限，否则页面会因视口过窄而 CSS 塌陷。
- 缺省回落应改为**由面板尺寸推导**而非固定 `1024×1440`；面板尺寸未知时保持现状
  （此时无从保比例，固定值可接受）。

**为什么不干脆把视口设成面板 1:1**：×2 超采样是 0.20.2 引入的画质手段（位图路线下
`canvas` 缩回面板时保住文字锐度）。保比例式**保留了 k≈2 的超采样**（面板不触上限时
k 恰为 2），只是把「两个独立标量」收敛成「一个标量」。

### 2.2 【控制器】运动自适应画质应从「帧计数」改成「帧间隔」

现状（`lib/live.js:162-169, 207-219`）：

```js
const ADAPTIVE = { motionFrames: 3, motionWindowMs: 500, idleMs: 450,
                   dwellMs: 700, hiQuality: 90, loQuality: 55 };
...
const motion = frameTimes.length >= ADAPTIVE.motionFrames;   // 500ms 内 ≥3 帧
```

判据是「**单位时间内到达几帧**」。但 `Page.screencastFrame` 是**损伤帧**——页面不变就
一帧不发。于是这个判据把两件不同的事混成一个信号：

- 页面真的在滚动（该降质提帧率）→ 帧多 ✓
- 页面静止但编码慢，导致 ack 稀疏 → 帧少 ✗（判成静止，回 q90，编码更慢，**正反馈**）

**更优判据**：用**帧间隔的 EWMA** 作为被控量，配一个比例控制器：

```
i_n     = EWMA(now - lastFrameAt, α=0.3)          // 实测帧间隔
i_target = 1/30 s
q_{n+1} = clamp( q_n + K_p * (i_n - i_target) / i_target , q_lo, q_hi )
```

间隔大于目标说明跟不上，应降 q（号已取正）。关键是**用连续量替代三帧阈值**，消掉
「静止/运动」的硬分类与 `dwellMs` 防抖这套经验参数，把 4 个魔数（3 / 500 / 450 / 700）
收敛成 2 个（α / K_p）。

**依据**：JPEG 编码耗时随质量**超线性**增长（本仓库 `lib/live.js:159` 自己的注释：
「920×1720@q90 一帧几十毫秒」）。超线性系统用比例控制器比 bang-bang 更稳。

### 2.3 【背压】ack 时序：现在没有端到端背压

现状（`lib/live.js:272-275`）：

```js
try { if (ws.readyState === ws.OPEN) ws.send(packet); } catch { }
sess.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
```

`ack` 在**转发之后立刻**发出，与客户端**是否真的画完**无关。Chromium 收到 ack 就继续
产出下一帧 ⇒ 服务端**满速生产**，客户端靠「最新帧制胜」（`lib/client.cjs:3756-3775`）
丢弃中间帧。**丢弃发生在最下游**，服务端的 JPEG 编码开销一帧没省。

**改法**：新增客户端 `{t:'frame-rendered', seq}` 消息，服务端**收到它才 ack**。这才是真正的
端到端背压——「最新帧制胜」从「客户端不排队」升级为「服务端不做无用编码」。
本机回环下收益小于公网，但对**全屏 + 高 DPI**（编码是唯一瓶颈，见
`doc/research/2026-09-25-live-streaming-architecture-comparison.md` §2）是直接的 CPU 削减。

### 2.4 【算法】损伤区域的精确传输（研究项，非当前瓶颈）

`Page.screencastFrame` 的 `metadata` 含 `timestamp / deviceWidth / deviceHeight /
pageScaleFactor / offsetTop / scrollOffsetX / scrollOffsetY`，**不含损伤矩形**。
因此「只传变化区域」在纯 CDP screencast 路线上无法直接拿到脏区。可行但更复杂的替代：
`Page.captureScreenshot` + `clip` 配合客户端像素差分算脏区。**不建议现在做**——
2.1 修完后主要矛盾（黑边/模糊）已解，而 RTC 路线（30–60fps 硬编）已经在架子上。

### 2.5 【已做对、不必再动】token 密度估计

`lib/metrics.js:387`：

```js
export const TOKEN_DENSITY = Object.freeze({ cjk: 0.75, word: 0.3, other: 0.7, margin: 0.1 });
```

三类单价 + 10% 余量，且注释给出了与旧 `0.25` 平铺口径的实测定标表
（`lib/metrics.js:376-381`：CJK 0.75 / 散文 0.30 / 其余 0.70；旧口径对源码低估 33%、
对数字符号低估 63%）。**这是已经做过标定的估计器**，不是拍脑袋系数。进一步优化只能上
真正的 BPE 分词器（引入依赖、收益边际），当前不值得。

---

## 三、问题①：参考项目的优化空间

### 3.1 已核对：我们已超过 steel-browser

`reference/steel-browser/api/src/plugins/browser-socket/casting.handler.ts:382-397`：

```
await targetClient.send("Page.setDeviceMetricsOverride", {...});   // :382
await targetClient.send("Page.startScreencast", {
  quality: 75, maxWidth: width, ...                                // :394-397
});
```

| 维度 | steel-browser | 本桥 0.20.5+ |
| --- | --- | --- |
| JPEG 质量 | 固定 q75 | 自适应 q55/q90 |
| 超采样 | 无（dpr1，1:1） | 面板 ×2 超采样 |
| 帧传输 | base64 + JSON | 二进制 `[metaLen][metaJSON][jpeg]` |
| 背压 | 即时 ack（同我们） | 即时 ack（同 steel） |
| 视口适配 | `dimensions` 固定 | `viewportForPanel`（**但有 1.2 的失配 bug**） |

**结论**：参数维度我们全面更强；**唯一被 steel 证明可行而我们没做的是 2.3 的 ack 背压**
（steel 也是即时 ack，所以严格说这条是「双方都还没做」，不是「我们落后」）。

**真正值得抄的一点**：`casting.handler.ts` 把视口尺寸作为**会话级参数**在
`setDeviceMetricsOverride` 里一次性确定，而本桥是在 `resize` 分支里反复重设。
0.20.3 的注释（`lib/live.js:239-240`）已记录「同会话上直接重发 startScreencast 不保证
新上限生效」→ 所以走了「先 stop 后 start」。2.1 修完后仍会走这条路，但**重设次数**可以
靠 2.1 的「比例不变时视口数值也不变」显著减少。

### 3.2 【新发现，优先修】两处 RTC 状态机漏判

`lib/live.js` 中，`rtcActive` 只被**写**（`:337`、`:347`、`:366`）和用于 `close` 清理，
**没有被任何产帧路径读取**。于是：

**漏判 A —— `adaptTimer` 会重启投屏**（`lib/live.js:207-219`）：

```js
const adaptTimer = setInterval(() => {
  if (!current) return;                                      // ← 只判 current
  ...
  if (want !== streamMode && now - modeAt > ADAPTIVE.dwellMs) {
    streamMode = want; modeAt = now;
    void startStream(current.cdp, current.viewport, want)     // ← 无 rtcActive 守卫
  }
}, 250);
```

`rtc-offer` 成功后 `Page.stopScreencast` 停掉投屏、视频接管。但 **250ms 后**自适应定时器
一旦判定要切模式，就调 `startStream` → 里面先 `stop`（空操作）再
`Page.startScreencast` ⇒ **JPEG 投屏在 RTC 模式下被重新拉起**。后果：RTC 视频与
JPEG 编码**同时跑**，CPU 翻倍，而客户端 `visibility:hidden` 的 canvas 仍在
`drawImage`（`lib/client.cjs:3859` 无 visibility 判断）——纯浪费。

**漏判 B —— `resize` 会重启投屏**（`lib/live.js:314-323`）：

```js
case 'resize': {
  panel = { w: ..., h: ... };
  const viewport = viewportForPanel(panel.w, panel.h);
  if (current && !sameViewport(current.viewport, viewport)) {
    current.viewport = viewport;
    await startStream(current.cdp, viewport);                // ← 无 rtcActive 守卫
  }
}
```

RTC 模式下拖动分栏 → 每 120ms（客户端防抖，`lib/client.cjs:3850`）来一次 `resize`
→ 只要视口数值变了就重新起 JPEG 投屏。结合 1.2 的失配，**拖分栏时几乎每次都变** ⇒
拖拽全程在 RTC + JPEG 双路上烧 CPU。

**修法**：两处各加一行守卫，把视口数值更新与投屏重启解耦：

```js
// resize 分支
if (current && !sameViewport(current.viewport, viewport)) {
  current.viewport = viewport;
  if (!current.rtcActive) await startStream(current.cdp, viewport);
}

// adaptTimer 开头
if (!current || current.rtcActive) return;
```

**注意**：这两处是**行为改变**，且 `test/live-view.test.mjs` 里
「resize 变尺寸同会话重设（不重建会话）」这条用例（`:200`）可能覆盖到，需同步核对。

### 3.3 参考目录里「未采用但相关」的项目

`doc/research/reference-projects.md` 已登记 35 项，其中与画面流直接相关的：

| 项目 | 状态 | 与画面流的关系 |
| --- | --- | --- |
| `steel-browser` | 已核对（本轮） | 同路线，参数弱于我们；ack 时序同我们 |
| `puppeteer-stream` | 已核对 | 扩展 `tabCapture` 路线，无头支持面不明 ⇒ 暂不 |
| `browserless` | 文档核对 | 有头才有 WebRTC；与 0.21.0 的 `liveHeaded` 判断一致 |
| `WebBridge` | 「同类路线佐证」 | 未直接采用 |
| `wabac.js` | 「未直接采用（镜像改写为自研）」 | 与 iframe 退役路线相关，非画面流 |

**没有新发现的「应该拉但没拉」的项目**。`reference/` 是只读素材、不在运行链路
（`doc/review-guide.md` 口径），扩充它不改变行为。

---

## 四、建议的落地顺序

| 优先 | 改动 | 位置 | 风险 |
| --- | --- | --- | --- |
| **P0** | 保比例视口换算（2.1） | `lib/live.js:118-123` | 低；需同步改 `test/live-view.test.mjs:192-198` 期望值 |
| **P0** | RTC 状态机两处守卫（3.2） | `lib/live.js:207-219`、`:314-323` | 低；需核对 `:200` 用例 |
| P1 | 缺省视口由面板推导，而非固定 1024×1440 | `lib/live.js:120-121` | 低 |
| P2 | ack 端到端背压（2.3） | `lib/live.js:275` + `lib/client.cjs` 帧回调 | 中；协议加一条消息，需双端同步 |
| P2 | 画质控制器换帧间隔 EWMA（2.2） | `lib/live.js:162-169, 207-219` | 中；4 个魔数换 2 个，需真机调参 |
| P3 | 有头启动视口不再写死 1280×1440 | `lib/browser-driver.js:1687` | 中；有头窗口尺寸影响离屏定位与「三件套」隐藏 |

**P0 两项合计改动约 15 行**，能消掉「最大 −68% 比例失配」与「RTC 模式双路烧 CPU」
两个可复现缺陷。

---

## 五、可直接采用的补丁草稿（未实施）

```js
// lib/live.js —— 替换 viewportForPanel（保比例 + 单标量）
const VP_MAX_W = 1280, VP_MAX_H = 2000, VP_MIN_K = 0.25, VP_SUPERSAMPLE = 2;

export function viewportForPanel(w, h) {
  const pw = Number(w), ph = Number(h);
  if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) {
    return { width: 1024, height: 1440 };          // 面板尺寸未知：无从保比例
  }
  // 唯一缩放标量：两个上限里更紧的那个，且不超过超采样倍数。
  const k = Math.max(VP_MIN_K,
    Math.min(VP_SUPERSAMPLE, VP_MAX_W / pw, VP_MAX_H / ph));
  // 绝对下限兜底：极窄面板下防止视口过小导致页面 CSS 塌陷。
  const width = Math.max(320, Math.round(pw * k));
  const height = Math.max(480, Math.round(ph * k));
  return { width, height };
}
```

> **注意**：上面 `width/height` 的两个 `Math.max` 兜底会在**极窄面板**下重新引入
> 微小比例误差（这是刻意的——宁可牺牲 ~1% 比例也不让视口塌到不可用）。若要严格 0% 误差，
> 应改为「若 `pw*k < 320` 则按 `k' = 320/pw` 重算并**同时**收缩 height」，即再走一轮
> 单标量。当前草稿选择了简单性。

```js
// lib/live.js:207 —— adaptTimer 加守卫
const adaptTimer = setInterval(() => {
  if (!current || current.rtcActive) return;    // ← 新增 rtcActive 守卫
  ...
}, 250);

// lib/live.js:319 —— resize 分支加守卫
if (current && !sameViewport(current.viewport, viewport)) {
  current.viewport = viewport;
  if (!current.rtcActive) await startStream(current.cdp, viewport);   // ← 新增守卫
}
```

---

## 附：本文引用的锚点清单

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `lib/live.js` | 118-123 | `viewportForPanel` 宽高独立钳制（**病根**） |
| `lib/live.js` | 124 | `sameViewport` |
| `lib/live.js` | 162-169 | `ADAPTIVE` 魔数 |
| `lib/live.js` | 207-219 | `adaptTimer`（**无 rtcActive 守卫**） |
| `lib/live.js` | 238-251 | `startStream`（stop→Emulation→start） |
| `lib/live.js` | 272-275 | 帧转发 + 即时 ack（**无端到端背压**） |
| `lib/live.js` | 314-323 | `resize` 分支（**无 rtcActive 守卫**） |
| `lib/live.js` | 336-338 | `rtc-offer` 只停 screencast，不停 Emulation |
| `lib/client.cjs` | 3677 | `LIVE_SITES = {deepseek}` |
| `lib/client.cjs` | 3845-3853 | 面板尺寸上报（120ms 防抖） |
| `lib/client.cjs` | 3873-3876 | `contain` 绘制 + 黑底居中（→ 黑边） |
| `lib/client.cjs` | 4700 | `<video>` `object-fit:contain` |
| `lib/browser-driver.js` | 1687 | 启动视口写死 1280×1440 / 640×900 |
| `lib/browser-driver.js` | 4014-4022 | `syncViewport` 另一套钳制 360-1600 × 480-2000 |
| `lib/index.js` | 194 | `liveHeaded: true`（默认有头） |
| `lib/metrics.js` | 376-387 | token 密度标定表 |
| `node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` | 459 / 518 | 面板宽度由框架 prop 给；<768px 自动全屏 |
| `reference/steel-browser/api/src/plugins/browser-socket/casting.handler.ts` | 382-397 | steel 的 `setDeviceMetricsOverride` + `startScreencast q75` |
| `test/live-view.test.mjs` | 192-198 | 把「宽高双钳制」钉成规格的护栏 |
