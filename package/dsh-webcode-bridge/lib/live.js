// live.js — 右栏「自带内核工作区」画面流（0.20.0 路线 B）。
//
// ## 为什么有这个模块
//
// 用户拍板（2026-09-25）：右栏放弃镜像 iframe，改为把**自带 Chromium 的真实页面**
// 投到右栏——登录只有自带内核 profile 一份，图片查看/文件预览/下载/弹窗回归真实
// 浏览器行为，站点改版不再把右栏弄坏。官方 `ui-sidebar-browser`（Web=iframe、
// 桌面=webview）证明 Web 平台没有「原生嵌第二个内核」的原语，投屏是
// 「登录收敛 + 查看器全真」两条要求下的唯一解。方案全文见
// doc/plans/PLAN-2026-09-25-live-workspace.md。
//
// ## 结构
//
//   · 输入映射纯函数（mapMouseInput / mapKeyInput）：客户端消息 → CDP Input 参数，
//     无 IO、可离线单测——面板坐标 → 页面坐标的换算在**客户端**做（它知道画布
//     显示矩形与帧元数据），这里只做形状与枚举的收敛，非法值一律返回 null 丢弃。
//   · createLiveHub：WebSocketServer(noServer) 挂在中继的 httpServer 'upgrade' 上。
//     每条连接绑定一个账户槽（account=<siteId>[#<slot>]），经 driver.live 取页面
//     列表、开 CDP 会话、Page.startScreencast 下发损伤帧、Input.* 回传输入。
//     driver.live 由 browser-driver 提供（listPages/openPage/closePage/activatePage/
//     attach/onPagesChanged）；hub 不直接 import playwright——CDP 会话是
//     {send,on,off,detach} 形状的最小接口，护栏可用假会话全行为驱动。
//
// ## 安全面
//
//   · upgrade 只认 /webcode/live；Origin 必须是回环（127.0.0.1/localhost/[::1]），
//     其余来源直接销毁 socket——与中继「loopback-only」的既有安全立场一致。
//   · 客户端消息 JSON ≤ 4KB 且必须过 parseClientMessage 形状检查；非法即丢弃。
//   · 每条连接一个 CDP 会话、独立 ack；断开必 detach（try/catch 包裹，避免
//     浏览器已退出时把清理错误抛成未处理拒绝）。

import { WebSocketServer } from 'ws';

/** 客户端鼠标消息允许的动作 → CDP type（见 mapMouseInput）。 */
const MOUSE_ACTIONS = { pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved', wheel: 'mouseWheel' };
/** CDP 的 button 枚举就是这三个词 + none，客户端只发这四个。 */
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right']);
/** buttons 位掩码（CDP/MDN 同义）：left=1、right=2、middle=4。 */
const MOUSE_BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 };
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * 鼠标/滚轮消息 → Input.dispatchMouseEvent 参数。
 * x/y 是**页面 CSS 像素**坐标（客户端已按帧元数据换算），这里只收敛形状。
 *
 * @returns {object|null} 非法消息（缺坐标/未知动作）返回 null，调用方丢弃。
 */
export function mapMouseInput(msg = {}) {
  const type = MOUSE_ACTIONS[String(msg.action || '')];
  if (!type) return null;
  const x = Number(msg.x);
  const y = Number(msg.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const button = MOUSE_BUTTONS.has(msg.button) ? msg.button : 'none';
  const buttons = Number.isFinite(Number(msg.buttons))
    ? Math.max(0, Math.min(7, Number(msg.buttons) | 0))
    : MOUSE_BUTTON_BITS[button];
  const base = { type, x: Math.round(x), y: Math.round(y), button, buttons };
  if (type === 'mouseWheel') {
    return { ...base,
      deltaX: Number.isFinite(Number(msg.deltaX)) ? Number(msg.deltaX) : 0,
      deltaY: Number.isFinite(Number(msg.deltaY)) ? Number(msg.deltaY) : 0 };
  }
  if (type === 'mouseMoved') return base;
  // 按下/抬起必须带 clickCount（CDP 硬要求，缺了点击无效）；双击由客户端按
  // 系统节奏合成 clickCount:2，这里只收 1–3。
  return { ...base, clickCount: Math.max(1, Math.min(3, Number(msg.clickCount) || 1)) };
}

/**
 * 键盘消息 → Input.dispatchKeyEvent 参数。
 * 客户端对每次 keydown 发 `action:'key'`（可打印键带 text），keyup 发 `action:'keyup'`。
 * IME 组合输入不走这条路（P2 用 Input.insertText 文本直输兜底，见计划文档）。
 *
 * @returns {object} 键盘消息没有「无效」形态：缺 key/code 就发裸 type，不丢事件。
 */
export function mapKeyInput(msg = {}) {
  const type = msg.action === 'keyup' ? 'keyUp' : 'keyDown';
  const params = { type, modifiers: 0 };
  for (const m of ['alt', 'ctrl', 'meta', 'shift']) {
    if (msg[m] === true) params.modifiers |= MODIFIER_BITS[m];
  }
  if (msg.key != null) params.key = String(msg.key);
  if (msg.code != null) params.code = String(msg.code);
  const vk = Number(msg.keyCode);
  if (Number.isFinite(vk) && vk > 0) params.windowsVirtualKeyCode = vk | 0;
  if (msg.text) { params.text = String(msg.text); params.unmodifiedText = String(msg.unmodifiedText ?? msg.text); }
  return params;
}

/**
 * 客户端消息解析：JSON、≤ 4KB、必须是对象。非法返回 null（调用方静默丢弃）。
 * 上限的依据：输入消息最大不过几十字节（键值 + 坐标）；4KB 已宽裕两个数量级，
 * 再大只能是恶意或异常，直接丢。
 */
export function parseClientMessage(raw) {
  const s = String(raw ?? '');
  if (!s || s.length > 4096) return null;
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch { return null; }
}

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// ---- 视口自适应：0.20.2 引入 ×2 超采样 → 0.21.1 改保比例 → 0.21.2 改**对齐画布**
//
// 三个版本各修掉一层，别把它们混为一谈：
//
//   0.20.0  投的是驱动窗口默认视口（640×900 竖条），被面板拉伸 ⇒ 糊 + 黑边。
//   0.20.2  改成「面板 CSS ×2 超采样」，但宽、高**各自独立**钳制（720–1280 /
//           900–2000）。任一维触边就改写比例，客户端 contain 绘制 ⇒ 黑边。
//   0.21.1  把两次独立钳制换成**一次按比例缩放**（唯一标量 k），比例严格等于
//           面板。**但 1280×2000 的硬上限没动**——比例对了，分辨率仍然不够。
//   0.21.2  修的就是这个上限：视口 = **面板 CSS × dpr**（= 客户端画布 backing），
//           两端 1:1，不做任何上采样。
//
// 为什么 0.21.1 修完还糊（真机读数，见
// doc/research/2026-09-25-live-sharpness-framerate-research.md §1）：
// 客户端画布 backing = `面板CSS × min(dpr,2)`（client.cjs 的 panelDpr），而服务端
// 把页面渲染成 `面板CSS × k` 且 `k ≤ min(2, 1280/面板宽, 2000/面板高)`。
// 只要 `面板CSS宽 × dpr > 1280`，源图就小于画布 ⇒ drawImage 上采样 ⇒ 糊。
// 临界点正是 **面板宽 640 CSS px**（1280 ÷ 2）——「典型侧栏」宽度附近，
// 所以小侧栏时看着还行，全屏工作区（面板最宽）最糊，实算最坏 2.19× 上采样。
//
// 0.21.2 的两条不变量：
//   ① `viewportForPanel(w,h,dpr) === { w×dpr, h×dpr }`（未触上限时）⇒ 源图 = 画布，
//      drawImage 只做 1:1 落笔，文字不再经过任何重采样；
//   ② dpr 的钳制**两端必须用同一个值**（这里是 VP_MAX_DPR，client.cjs 用 panelDpr），
//      任一端改口径就会把①破坏掉——这是本条最容易回归的地方。
//
// 上限 VP_MAX_W/H 仍在，但已抬高到覆盖 `1280×1600 面板 @dpr2`：那是官方右侧栏
// 全屏时的常见尺寸。真正的 CPU 控制交给**三档画质**（见下 STREAM_MODES）——
// 静止用无损 PNG 全分辨率（帧稀疏，几乎不增开销），运动用半分辨率 JPEG（省编码）。
//
// 仿真挂在**投屏连接自己的 CDP 会话**上：会话 detach（面板关闭/切换）时该会话的
// 仿真随之失效，自动化页面恢复原状——不留下持久副作用。拆分会话期间面板切换
// 页面/重连也各用新会话，互不残留。
const VP_MAX_W = 2560;        // 上限防面板撑爆编码；覆盖 1280 宽面板 @dpr2
const VP_MAX_H = 3200;
const VP_MAX_DPR = 2;         // ⚠️ 必须与 client.cjs 的 panelDpr() 逐字一致
const VP_MIN_K = 0.25;        // 病态巨大面板的兜底（面板 >10240px 宽时才会触及）
export function viewportForPanel(w, h, dpr = VP_MAX_DPR) {
  const pw = Number(w), ph = Number(h);
  // 面板尺寸未知（建连后 resize 尚未到达）：此时无从对齐，回落固定值。
  if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) {
    return { width: 1024, height: 1440 };
  }
  // 目标：视口 = 面板 CSS × dpr = 客户端画布 backing ⇒ 源图与画布 1:1。
  const want = Math.max(1, Math.min(
    Number.isFinite(Number(dpr)) && Number(dpr) > 0 ? Number(dpr) : VP_MAX_DPR,
    VP_MAX_DPR));
  const k = Math.max(VP_MIN_K, Math.min(want, VP_MAX_W / pw, VP_MAX_H / ph));
  return { width: Math.round(pw * k), height: Math.round(ph * k) };
}
const sameViewport = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height;

// ---- WebRTC 页面自采（0.21.0，browserless TV / puppeteer-stream 同款手法）------
//
// 目标页面自己 getDisplayMedia（preferCurrentTab 自采本页）→ RTCPeerConnection
// 硬件编码 30–60fps 发往面板 <video>；信令非 trickle（offer/answer 各带候选，
// 免第二条通道），经既有 live WS + CDP Runtime.evaluate 注入完成。启动旗标
// --use-fake-ui-for-media-stream 免授权弹窗（browser-driver 有头分支已带）。
// 无头/失败一律回 {ok:false} → 面板自动回落自适应投屏画布。
const RTC_INJECT = `(async () => {
  try {
    if (window.__wcRTC) { try { window.__wcRTC.pc.close(); window.__wcRTC.stream.getTracks().forEach(t => t.stop()); } catch {} window.__wcRTC = null; }
    const offer = __WC_OFFER__;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: __WC_FPS__ }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    const pc = new RTCPeerConnection();
    const candidates = [];
    pc.addEventListener('icecandidate', (e) => { if (e.candidate) candidates.push(e.candidate.toJSON()); });
    const senders = [];
    for (const t of stream.getTracks()) {
      // 0.21.2 锐度三件套之一：contentHint='detail' ⇒ 编码器
      // 映射到 maintain-resolution（宁可掉帧也保分辨率）。缺省时按「摄像头视频」
      // 假设工作，会**为保帧率主动降分辨率**——那正是「帧率上去但更糊」的机制。
      // W3C MediaStreamTrack Content Hints 明确该值用于文字/细节内容。
      try { t.contentHint = 'detail'; } catch {}
      senders.push(pc.addTrack(t, stream));
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    for (const c of (offer.candidates || [])) { try { await pc.addIceCandidate(c); } catch {} }
    // 0.21.2 锐度三件套之二 + 之三：degradationPreference 与**显式码率**。
    //
    // degradationPreference='maintain-resolution' 与 contentHint 同向，但作用在
    // sender 参数层，对**已建立**的连接更可靠；两者都设，双保险。
    //
    // maxBitrate 是**「动起来」糊的真凶之一**：不给上限时 Chrome 走 BWE
    //（带宽估计）——初始估计很低，再按丢包/延迟慢慢往上爬。实测 VP9 在
    // 3 Mbps 上要 **12 秒**才收敛（见研究笔记的 webrtc-developers 实测表）；
    // 收敛前编码器为凑低码率**主动降分辨率**，用户看到的就是「刚滚起来是糊的，
    // 过十几秒才清楚」。本机是**回环**，带宽无穷，没有任何理由让它慢慢猜。
    // 直接给足 20 Mbps，把这段爬升整段省掉。
    for (const s of senders) {
      try {
        const p = s.getParameters();
        p.degradationPreference = 'maintain-resolution';
        if (p.encodings && p.encodings.length) {
          for (const enc of p.encodings) {
            enc.maxBitrate = __WC_MAXBITRATE__;
            enc.networkPriority = 'high';
          }
        }
        await s.setParameters(p);
      } catch {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 2500);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
    window.__wcRTC = { pc, stream };
    return JSON.stringify({ ok: true, sdp: pc.localDescription.sdp, candidates });
  } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }); }
})()`;

// ---- 三档画质控制器（0.21.2）------------------------------------------------
//
// 用户的两条要求——**高精度**（静止读文字要像素级清晰）与**低占用**（滚动要顺、
// CPU 要低）——靠「按内容状态换编码」同时满足，而不是一个折中参数打天下：
//
//   idle    （无帧 ≥450ms）   PNG  全分辨率    —— 损伤帧在静止时本就稀疏，
//                                                无损几乎不增开销，文字零伪影
//   stream  （帧间隔中等）     JPEG q88 全分辨率 —— 模型流式吐字，够清晰
//   motion  （帧间隔 <90ms）   JPEG q55 0.55×   —— 滚动/拖拽降分辨率换帧率，
//                                                运动中本来就看不出细节
//
// **为什么 PNG 是这里最关键的一张牌**：`Page.screencastFrame` 是**损伤帧**——
// 页面不变就一帧不发。所以静止时用无损编码几乎不付代价，却把 JPEG 的 8×8 DCT
// 伪影**彻底消掉**（文字周围的 ringing/blocking 是 JPEG 的固有性质，不是质量参数
// 没调够：8×8 块假设「块内无锐变」，而文字笔画恰好处处是锐变。见
// doc/research/2026-09-25-live-sharpness-framerate-research.md §3 的文献佐证）。
// 0.20.5 的 hi 档是 q90 JPEG——用户说「有点糊」，那一档就是残余来源。
//
// **判据从「帧计数」换成「帧间隔 EWMA」**（0.20.5 是「500ms 内 ≥3 帧」）：
// 损伤帧在页面不动时一帧不发，用计数会把「静止但编码慢」误判成静止并回满质量，
// 形成正反馈（越慢越判静止、越静止越慢）。间隔是连续量，没有这个硬分类，
// 也就把 0.20.5 的 4 个魔数（3 / 500 / 450 / 700）收敛成 3 个。
//
// 注意：**只切编码参数，不切 Emulation 视口**。切视口会触发页面重排（肉眼可见的
// 跳动，且本身昂贵）；`maxWidth/maxHeight` 只是让 Chromium 在下采样后出帧，
// 便宜得多。所以视口恒为「画布对齐」的全分辨率，档位只影响出帧尺寸与编码。
const ADAPTIVE = {
  idleMs: 450,        // 距上一帧超过这么久 ⇒ idle（无损）
  motionGapMs: 90,    // 帧间隔 EWMA 低于这么多毫秒 ⇒ motion（半分辨率）
  ewmaAlpha: 0.35,    // 帧间隔 EWMA 权重（越大越跟手、越小越稳）
  dwellMs: 400,       // 两次切换的最小间隔（防编码耗时抖动引发振荡）
};

/** 三档模式的编码参数。PNG 会忽略 quality。`scale` 是出帧尺寸相对视口的比例。 */
export const STREAM_MODES = Object.freeze({
  idle:   Object.freeze({ format: 'png',  quality: 100, scale: 1 }),
  stream: Object.freeze({ format: 'jpeg', quality: 88,  scale: 1 }),
  motion: Object.freeze({ format: 'jpeg', quality: 55,  scale: 0.55 }),
});

/**
 * 帧节奏 → 画质档位。**纯函数**：无 IO、无时钟，离线可全边界驱动。
 *
 * @param {{sinceLastMs?: number, gapEwma?: number}} s
 *   sinceLastMs 距上一帧的毫秒数（从未收过帧传 Infinity）；gapEwma 帧间隔的指数均值。
 * @returns {'idle'|'stream'|'motion'}
 */
export function pickStreamMode({ sinceLastMs, gapEwma } = {}) {
  // 没有帧（首帧前）或久无帧 ⇒ 静止：此时最该清晰，成本又最低。
  if (!Number.isFinite(sinceLastMs) || sinceLastMs >= ADAPTIVE.idleMs) return 'idle';
  if (Number.isFinite(gapEwma) && gapEwma > 0 && gapEwma < ADAPTIVE.motionGapMs) return 'motion';
  return 'stream';
}

/**
 * 画面流 hub。`getDriver(accountKey)` 返回带 `live` API 的驱动实例（index.js
 * 接 driverFor）；驱动尚未启动/槽不存在时可以抛错，hub 会向面板回 bye 并关闭。
 *
 * @param {{getDriver: (accountKey: string) => object|null, log?: Function, warn?: Function}} opts
 * @returns {{handleUpgrade: Function, connectionCount: () => number, close: () => Promise}}
 */
export function createLiveHub({ getDriver, onAllClosed = null, log = () => {}, warn = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set();

  const send = (ws, obj) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* 连接竞态：无害 */ } };

  /** 单条连接的完整生命周期。cdp 会话接口：{ send, on, off, detach, pageId }。 */
  async function run(ws, url) {
    conns.add(ws);
    const accountKey = url.searchParams.get('account') || 'deepseek';
    let live = null;
    try {
      const driver = getDriver(accountKey);
      live = driver?.live ?? null;
      if (!live) throw new Error('driver live api unavailable');
    } catch (err) {
      send(ws, { t: 'bye', reason: String(err?.message || err).slice(0, 200) });
      ws.close();
      return;
    }
    send(ws, { t: 'hello', account: accountKey });

    let current = null;   // { pageId, cdp, viewport, rtcActive }
    let panel = null;     // 面板报来的 CSS 尺寸 { w, h, dpr }（resize 前为 null，用默认视口）
    // 主题（0.21.2）：null = 面板还没报过，保持站点默认。面板报的是 **DSH 的昼夜**，
    // 经 prefers-color-scheme 仿真推给页面——站点自己的深浅色逻辑因此跟着宿主走。
    let themeDark = null;
    /** 把昼夜偏好推给页面。prefers-color-scheme 是站点认的标准信号，不用注入 CSS。 */
    const applyTheme = async (sess, dark) => {
      try {
        await sess.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
        });
      } catch { /* 会话已换/已关：无害 */ }
    };
    // 画质档位状态（0.21.2）：帧到达节奏 → idle/stream/motion（判据见 pickStreamMode）。
    // 只维护「距上一帧多久」与「帧间隔 EWMA」两个读数，判据本身是纯函数。
    let lastFrameAt = 0;          // 0 = 本连接还没收到过帧
    let gapEwma = 0;              // 帧间隔指数均值；0 = 还没建立
    let streamMode = 'idle';      // 首帧前最该清晰，且 PNG 成本最低
    let modeAt = Date.now();
    const noteFrame = () => {
      const now = Date.now();
      if (lastFrameAt) {
        const gap = now - lastFrameAt;
        // 只把「同一轮运动」的间隔计入 EWMA：跨过 idle 的长间隔会把均值拉高，
        // 让刚恢复滚动时判不出 motion（要等好几帧才收敛）。超过 idleMs 视为断层。
        if (gap < ADAPTIVE.idleMs) {
          gapEwma = gapEwma ? (ADAPTIVE.ewmaAlpha * gap + (1 - ADAPTIVE.ewmaAlpha) * gapEwma) : gap;
        } else {
          gapEwma = 0;
        }
      }
      lastFrameAt = now;
    };
    const adaptTimer = setInterval(() => {
      // RTC 接管后**不得**再碰投屏（0.21.1）：rtc-offer 成功时已 Page.stopScreencast、
      // 画面由页面自采的视频接管。少了这道守卫，本定时器一次轮询里只要判定
      // 要切模式就会 startStream，把 JPEG 投屏在 RTC 模式下**重新拉起**——RTC 视频与
      // JPEG 编码同时跑，CPU 翻倍，而客户端 canvas 此时 visibility:hidden，编码出来
      // 的帧根本没人看。
      if (!current || current.rtcActive) return;
      const now = Date.now();
      const sinceLastMs = lastFrameAt ? now - lastFrameAt : Infinity;
      const want = pickStreamMode({ sinceLastMs, gapEwma });
      if (want !== streamMode && now - modeAt > ADAPTIVE.dwellMs) {
        streamMode = want;
        modeAt = now;
        void startStream(current.cdp, current.viewport, want).catch(() => {});
      }
    }, 200);
    /** 摘掉当前 CDP 会话（停投屏 + detach）。清理一律吞错：对端可能已随浏览器
     *  退出而失效，把清理错误抛成 unhandled rejection 只会污染日志。 */
    const detach = async () => {
      const cur = current;
      current = null;
      if (!cur) return;
      try { await cur.cdp.send('Page.stopScreencast'); } catch {}
      try { await cur.cdp.detach(); } catch {}
    };

    const pushPages = async () => {
      try {
        const pages = await live.listPages();
        send(ws, { t: 'pages', pages, current: current?.pageId ?? null });
      } catch { /* 浏览器退出中：连接稍后随错误自然收场 */ }
    };
    const unPages = live.onPagesChanged?.(() => { void pushPages(); });

    const startStream = async (sess, viewport, mode = 'idle') => {
      const spec = STREAM_MODES[mode] || STREAM_MODES.idle;
      // 先停后起：同会话上直接重发 startScreencast 不保证新参数生效（0.20.2 真机
      // resize 疑似因此不跟随）；stop 的报错吞掉（首次 attach 时本就没有投屏）。
      try { await sess.send('Page.stopScreencast'); } catch {}
      // 视口仿真（与画布对齐的全分辨率）先行，投屏参数随后。
      // **视口不随档位变**：切视口会触发页面重排（跳动且昂贵），降分辨率交给
      // maxWidth/maxHeight 让 Chromium 下采样出帧——便宜得多。
      await sess.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
      });
      await sess.send('Page.startScreencast', {
        format: spec.format,
        ...(spec.format === 'jpeg' ? { quality: spec.quality } : {}),
        maxWidth: Math.max(1, Math.round(viewport.width * spec.scale)),
        maxHeight: Math.max(1, Math.round(viewport.height * spec.scale)),
        everyNthFrame: 1,
      });
    };

    const attach = async (pageId) => {
      await detach();
      const sess = await live.attach(pageId ?? null);
      const viewport = viewportForPanel(panel?.w, panel?.h, panel?.dpr);
      current = { pageId: sess.pageId, cdp: sess, viewport };
      // 换页/重连＝新的帧节奏：旧读数会把新页的第一帧误判成 motion（半分辨率）。
      lastFrameAt = 0;
      gapEwma = 0;
      streamMode = 'idle';
      modeAt = Date.now();
      // 主题（0.21.2）：新页一挂上就把当前昼夜偏好推过去，别等下一次切换。
      if (themeDark != null) void applyTheme(sess, themeDark);
      sess.on('Page.screencastFrame', (ev) => {
        noteFrame();   // 损伤帧：页面静止时 Chromium 一帧都不发，自适应据此判动静
        // 0.20.4：二进制帧协议（browserless/steel live view 同款做法）——
        // raw JPEG + 小头元数据，替代 base64+JSON（省 33% 体积与两次编解码）。
        // 包格式：[metaLen u16be][metaJSON utf8][jpeg 字节]；控制消息仍是文本 JSON，
        // 客户端按 typeof ev.data 区分。
        const jpeg = Buffer.from(ev.data || '', 'base64');
        if (jpeg.length > 0) {
          const metaBuf = Buffer.from(JSON.stringify(ev.metadata ?? {}), 'utf8');
          if (metaBuf.length <= 65535) {
            const packet = Buffer.allocUnsafe(2 + metaBuf.length + jpeg.length);
            packet.writeUInt16BE(metaBuf.length, 0);
            metaBuf.copy(packet, 2);
            jpeg.copy(packet, 2 + metaBuf.length);
            try { if (ws.readyState === ws.OPEN) ws.send(packet); } catch { /* 连接竞态：无害 */ }
          }
        }
        sess.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      });
      await startStream(sess, viewport);
    };

    ws.on('message', async (data) => {
      const msg = parseClientMessage(data);
      if (!msg) return;
      try {
        switch (msg.t) {
          case 'start':
          case 'activate':
            await attach(msg.pageId ?? null);
            void pushPages();
            break;
          case 'mouse': {
            if (!current) break;
            const params = mapMouseInput(msg);
            if (params) await current.cdp.send('Input.dispatchMouseEvent', params);
            break;
          }
          case 'key': {
            if (!current) break;
            await current.cdp.send('Input.dispatchKeyEvent', mapKeyInput(msg));
            break;
          }
          case 'open': {
            // 「+」开的页必须**立刻成为画面**（0.21.2）。旧实现只 openPage 再推列表，
            // 画面仍停在原来那一页——用户原话「你直接新开了页面干嘛不用」。
            const res = await live.openPage(msg.url);
            if (res?.pageId) await attach(res.pageId);
            void pushPages();
            break;
          }
          case 'close': {
            const res = await live.closePage(msg.pageId);
            if (current && (msg.pageId == null || msg.pageId === current.pageId) && res?.ok) await attach(null);
            void pushPages();
            break;
          }
          case 'pages':
            void pushPages();
            break;
          case 'resize': {
            // 面板尺寸变化（首次连接也会发一次）：同一 CDP 会话上重设仿真+投屏
            // 参数，**不**重建会话——拖拽分栏会连发 resize，重建会话是自找事故。
            // dpr 由面板上报（0.21.2）：视口 = 面板 CSS × dpr = 画布 backing，
            // 两端 1:1 才没有上采样。面板不报时回落 VP_MAX_DPR。
            panel = { w: Number(msg.w) || 0, h: Number(msg.h) || 0, dpr: Number(msg.dpr) || undefined };
            const viewport = viewportForPanel(panel.w, panel.h, panel.dpr);
            if (current && !sameViewport(current.viewport, viewport)) {
              current.viewport = viewport;
              // RTC 模式下只记数值、**不**重启投屏（0.21.1）。画面由 getDisplayMedia
              // 自采整页，尺寸随页面走，不需要 CDP 投屏上限；而拖拽分栏会连发 resize，
              // 在这里 startStream 等于每 120ms 把 JPEG 编码重新挂到 RTC 之上。
              if (!current.rtcActive) await startStream(current.cdp, viewport, streamMode);
            }
            break;
          }
          case 'theme': {
            // 宿主昼夜切换（0.21.2）：把 prefers-color-scheme 仿真推给页面。
            // 站点自己的深/浅色逻辑（CSS 媒体查询、JS matchMedia）因此跟着 DSH 走——
            // 不用注入任何 CSS，也不猜站点的主题实现方式。
            const dark = msg.dark === true;
            if (dark !== themeDark) {
              themeDark = dark;
              if (current) await applyTheme(current.cdp, dark);
            }
            break;
          }
          case 'rtc-offer': {
            // 面板发起 WebRTC：注入目标页自采脚本，answer 原样回传；成功即停投屏
            //（视频接管），失败回 rtc-failed（面板留在自适应投屏画布）。
            if (!current) break;
            // 帧率跟画质档位走：运动态给 60（跟手），其余 30（省 CPU）。
            // 与投屏三档同源——用户要的「高精度 + 低占用」在 RTC 上也是靠分档拿到。
            const fps = streamMode === 'motion' ? 60 : 30;
            const expr = RTC_INJECT
              .replace('__WC_FPS__', String(fps))
              .replace('__WC_MAXBITRATE__', String(20_000_000))
              .replace('__WC_OFFER__', JSON.stringify({
                sdp: String(msg.sdp || '').slice(0, 100_000),
                candidates: Array.isArray(msg.candidates) ? msg.candidates.slice(0, 32) : [],
              }));
            const res = await current.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            let out = {};
            try { out = JSON.parse(res?.result?.value || '{}'); } catch { out = { ok: false, error: 'bad inject result' }; }
            if (out.ok) {
              current.rtcActive = true;
              try { await current.cdp.send('Page.stopScreencast'); } catch {}
              send(ws, { t: 'rtc-answer', sdp: out.sdp, candidates: out.candidates || [] });
            } else {
              send(ws, { t: 'rtc-failed', error: String(out.error || 'rtc unavailable') });
            }
            break;
          }
          case 'rtc-failed': {
            // 面板侧 WebRTC 断了 → 回落自适应投屏
            if (current && current.rtcActive) { current.rtcActive = false; await startStream(current.cdp, current.viewport, streamMode); }
            break;
          }
          case 'ping':
            send(ws, { t: 'pong' });
            break;
          default:
            break;
        }
      } catch (err) {
        send(ws, { t: 'error', message: String(err?.message || err).slice(0, 200) });
      }
    });

    ws.on('close', () => {
      clearInterval(adaptTimer);
      // 连接关闭：若 RTC 还活着，关掉页面里的采集流（摄像头/屏幕指示灯消失）
      const cur = current;
      if (cur?.rtcActive) {
        cur.rtcActive = false;
        void cur.cdp.send('Runtime.evaluate', {
          expression: 'try { window.__wcRTC && (window.__wcRTC.pc.close(), window.__wcRTC.stream.getTracks().forEach(t => t.stop())); window.__wcRTC = null; } catch {}',
        }).catch(() => {});
      }
      try { unPages?.(); } catch {}
      void detach();
      conns.delete(ws);
      log('live: connection closed (' + accountKey + ')');
      // 最后一个面板也走了（0.21.2）⇒ 通知宿主回收这个账户的浏览器。
      // 判据给宿主：**它在跑一轮时不能关**（关了等于掐掉正在生成的回复）。
      // 这里只报事实，不做决定——回收策略留在 index.js（那里知道 busy）。
      if (conns.size === 0 && typeof onAllClosed === 'function') {
        try { onAllClosed(accountKey); } catch (err) { warn('live: onAllClosed failed: ' + String(err?.message || err)); }
      }
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
    log('live: connection open (' + accountKey + ')');
    // 建连即推页面列表并默认附到驱动当前页，面板拿到第一帧前不用自己发 start。
    void pushPages().then(() => attach(null).catch((err) => send(ws, { t: 'error', message: String(err?.message || err).slice(0, 200) })));
  }

  wss.on('connection', (ws, req) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { ws.close(); return; }
    void run(ws, url);
  });

  return {
    /** 挂在中继 httpServer 的 'upgrade' 上；非本 hub 路径不处理（保持默认断开语义）。 */
    handleUpgrade(req, socket, head) {
      let url;
      try { url = new URL(req.url || '/', 'http://localhost'); } catch { socket.destroy(); return; }
      if (url.pathname !== '/webcode/live') return;
      // 安全面双重：远端地址必须回环（连接级）；Origin 出现时必须回环（浏览器
      // 客户端必带，恶意网页的 Origin 必然不是回环 ⇒ 拒绝）。Origin 缺席 =
      // 非浏览器本机客户端（CLI/探针），放行。
      const addr = String(req.socket?.remoteAddress || '');
      if (!/^(127.|::1$|::ffff:127.)/.test(addr)) {
        warn('live: rejected non-loopback remote address: ' + addr.slice(0, 60));
        socket.destroy();
        return;
      }
      const origin = String(req.headers.origin || '');
      if (origin && !LOOPBACK_ORIGIN.test(origin)) {
        warn('live: rejected non-loopback origin: ' + origin.slice(0, 100));
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    connectionCount: () => conns.size,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}
