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

// ---- 视口自适应（0.20.2：真机反馈「不适配界面大小 + 画质很低」）----------------
//
// 病根：0.20.0 投的是驱动窗口的默认视口（640×900 竖条），被面板拉伸放大 ⇒ 模糊
// 且四周黑边。修法：**按面板 CSS 尺寸 ×2 超采样**——CDP Emulation 把页面视口设成
// 面板的两倍大（宽 720–1280、高 900–2000 钳制），投屏上限同步，canvas 缩回面板
// = 文字锐利、铺满无黑边。宽度下限 720 的依据：驱动自动化在 640 宽下本来就工作
// 正常（composer 选择器实测可用），720 只会更宽松；上限防全屏工作区把 JPEG 撑爆。
//
// 仿真挂在**投屏连接自己的 CDP 会话**上：会话 detach（面板关闭/切换）时该会话的
// 仿真随之失效，自动化页面恢复原状——不留下持久副作用。拆分会话期间面板切换
// 页面/重连也各用新会话，互不残留。
export function viewportForPanel(w, h) {
  const pw = Number(w), ph = Number(h);
  const width = Number.isFinite(pw) && pw > 0 ? Math.round(pw * 2) : 1024;
  const height = Number.isFinite(ph) && ph > 0 ? Math.round(ph * 2) : 1440;
  return { width: Math.max(720, Math.min(1280, width)), height: Math.max(900, Math.min(2000, height)) };
}
const sameViewport = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height;

// ---- 运动自适应画质（0.20.5：滚动仍不够顺的最后一张无头牌）--------------------
//
// 远程浏览器的另一个标准做法（noVNC/商业方案的「静帧高质、动帧提速」同型）：
// JPEG 编码耗时随质量陡增——920×1720@q90 一帧几十毫秒，滚动时帧率被编码卡死；
// 降到 q55 帧率立刻上来，而运动中的模糊根本注意不到。静止后回满质量，
// 文字锐度不受影响。无头 CDP 路线里这是 WebRTC 之前唯一的顺滑化手段。
const ADAPTIVE = {
  motionFrames: 3,     // 500ms 内 ≥3 帧 ⇒ 运动态（降质提速）
  motionWindowMs: 500,
  idleMs: 450,         // 450ms 无帧 ⇒ 静止态（回满质量）
  dwellMs: 700,        // 两次切换的最小间隔（防止编码耗时抖动引发振荡）
  hiQuality: 90,
  loQuality: 55,
};

/**
 * 画面流 hub。`getDriver(accountKey)` 返回带 `live` API 的驱动实例（index.js
 * 接 driverFor）；驱动尚未启动/槽不存在时可以抛错，hub 会向面板回 bye 并关闭。
 *
 * @param {{getDriver: (accountKey: string) => object|null, log?: Function, warn?: Function}} opts
 * @returns {{handleUpgrade: Function, connectionCount: () => number, close: () => Promise}}
 */
export function createLiveHub({ getDriver, log = () => {}, warn = () => {} } = {}) {
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

    let current = null;   // { pageId, cdp, viewport }
    let panel = null;     // 面板报来的 CSS 尺寸 { w, h }（resize 前为 null，用默认视口）
    // 运动自适应状态：帧到达节奏 → hi/lo 模式（判据见 ADAPTIVE）。
    const frameTimes = [];
    let streamMode = 'hi';
    let modeAt = Date.now();
    const noteFrame = () => { frameTimes.push(Date.now()); if (frameTimes.length > 32) frameTimes.shift(); };
    const adaptTimer = setInterval(() => {
      if (!current) return;
      const now = Date.now();
      while (frameTimes.length && now - frameTimes[0] > ADAPTIVE.motionWindowMs) frameTimes.shift();
      const motion = frameTimes.length >= ADAPTIVE.motionFrames;
      const idle = frameTimes.length === 0 || (now - frameTimes[frameTimes.length - 1] > ADAPTIVE.idleMs);
      const want = motion ? 'lo' : (idle ? 'hi' : streamMode);
      if (want !== streamMode && now - modeAt > ADAPTIVE.dwellMs) {
        streamMode = want;
        modeAt = now;
        void startStream(current.cdp, current.viewport, want).catch(() => {});
      }
    }, 250);
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

    const startStream = async (sess, viewport, mode = 'hi') => {
      // 先停后起：同会话上直接重发 startScreencast 不保证新上限生效（0.20.2 真机
      // resize 疑似因此不跟随）；stop 的报错吞掉（首次 attach 时本就没有投屏）。
      try { await sess.send('Page.stopScreencast'); } catch {}
      // 视口仿真（超采样分辨率）先行，投屏上限随后——帧尺寸与面板精确同比例。
      await sess.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
      });
      await sess.send('Page.startScreencast', {
        format: 'jpeg',
        quality: mode === 'lo' ? ADAPTIVE.loQuality : ADAPTIVE.hiQuality,
        maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1,
      });
    };

    const attach = async (pageId) => {
      await detach();
      const sess = await live.attach(pageId ?? null);
      const viewport = viewportForPanel(panel?.w, panel?.h);
      current = { pageId: sess.pageId, cdp: sess, viewport };
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
          case 'open':
            await live.openPage(msg.url);
            void pushPages();
            break;
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
            panel = { w: Number(msg.w) || 0, h: Number(msg.h) || 0 };
            const viewport = viewportForPanel(panel.w, panel.h);
            if (current && !sameViewport(current.viewport, viewport)) {
              current.viewport = viewport;
              await startStream(current.cdp, viewport);
            }
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
      try { unPages?.(); } catch {}
      void detach();
      conns.delete(ws);
      log('live: connection closed (' + accountKey + ')');
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
